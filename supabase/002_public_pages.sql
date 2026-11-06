-- =====================================================================
--  Public pages (no sign-in): team registration and published results
--  Run once in Supabase after schema.sql: SQL Editor > New query > Run
-- =====================================================================

-- ---------- Settings the admin controls ----------
create table if not exists public.app_settings (
  id                int primary key default 1 check (id = 1),   -- only one row
  registration_open boolean not null default true,
  results_public    boolean not null default false
);
insert into public.app_settings (id) values (1) on conflict do nothing;

alter table public.app_settings enable row level security;
drop policy if exists "read settings" on public.app_settings;
create policy "read settings" on public.app_settings for select to authenticated using (true);
drop policy if exists "admin changes settings" on public.app_settings;
create policy "admin changes settings" on public.app_settings
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
grant select, update on public.app_settings to authenticated;
revoke all on public.app_settings from anon;

-- Two teams can't have the same name
create unique index if not exists teams_name_unique on public.teams (lower(name));

-- ---------- Team registration ----------
-- Visitors can't write to the tables directly. They can only call this function,
-- which checks everything first and refuses when registration is closed.
create or replace function public.register_team(p_name text, p_title text, p_members text[])
returns int
language plpgsql
security definer set search_path = public
as $$
declare
  tid int;
  m   text;
  added int := 0;
begin
  if not coalesce((select registration_open from public.app_settings where id = 1), false) then
    raise exception 'Team registration is closed.';
  end if;
  if (select count(*) from public.teams) >= 200 then
    raise exception 'The team list is full. Please ask the admin.';
  end if;

  p_name  := btrim(coalesce(p_name, ''));
  p_title := btrim(coalesce(p_title, ''));
  if length(p_name) < 2 or length(p_name) > 100 then
    raise exception 'The team name must be 2 to 100 characters.';
  end if;
  if length(p_title) > 200 then
    raise exception 'The project title can be at most 200 characters.';
  end if;
  if exists (select 1 from public.teams where lower(name) = lower(p_name)) then
    raise exception 'A team called "%" already exists.', p_name;
  end if;
  if p_members is null or coalesce(array_length(p_members, 1), 0) = 0 then
    raise exception 'Add at least one member.';
  end if;
  if array_length(p_members, 1) > 10 then
    raise exception 'A team can have at most 10 members.';
  end if;

  insert into public.teams (name, project_title) values (p_name, p_title) returning id into tid;
  foreach m in array p_members loop
    m := btrim(coalesce(m, ''));
    if length(m) between 2 and 100 then
      insert into public.members (team_id, full_name) values (tid, m);
      added := added + 1;
    end if;
  end loop;
  if added = 0 then
    -- raising here also undoes the team insert above
    raise exception 'Add at least one member name (2 to 100 characters).';
  end if;
  return tid;
end;
$$;

-- ---------- Published results ----------
-- Returns the results only after the admin publishes them; otherwise just {"published": false}.
create or replace function public.public_results()
returns jsonb
language plpgsql stable
security definer set search_path = public
as $$
declare
  res jsonb;
begin
  if not coalesce((select results_public from public.app_settings where id = 1), false) then
    return jsonb_build_object('published', false);
  end if;

  with per_panelist as (       -- each panelist's % for a team's section
    select rs.team_id, r.section_id, rs.panelist_id, avg(rs.score) / 5 * 100 as pct
    from public.rubric_scores rs
    join public.criteria c on c.id = rs.criterion_id
    join public.rubrics  r on r.id = c.rubric_id
    group by rs.team_id, r.section_id, rs.panelist_id
  ), per_section as (          -- averaged over the panelists of that section
    select team_id, section_id, round(avg(pct), 2) as pct
    from per_panelist group by team_id, section_id
  ), group_avg as (
    select team_id, round(avg(grade), 2) as grade from public.group_grades group by team_id
  ), member_avg as (
    select member_id, round(avg(grade), 2) as grade from public.individual_grades group by member_id
  )
  select jsonb_build_object(
    'published', true,
    'sections', (select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) order by s.sort_order) from public.sections s),
    'teams', coalesce(jsonb_agg(jsonb_build_object(
      'name', t.name,
      'project_title', t.project_title,
      'sections', (select coalesce(jsonb_object_agg(ps.section_id::text, ps.pct), '{}'::jsonb) from per_section ps where ps.team_id = t.id),
      'rubric_average', (select case when count(*) = (select count(*) from public.sections) then round(avg(ps.pct), 2) end
                         from per_section ps where ps.team_id = t.id),
      'group_grade', (select g.grade from group_avg g where g.team_id = t.id),
      'members', (select coalesce(jsonb_agg(jsonb_build_object('name', m.full_name, 'grade', ma.grade) order by m.id), '[]'::jsonb)
                  from public.members m left join member_avg ma on ma.member_id = m.id where m.team_id = t.id)
    ) order by t.name), '[]'::jsonb)
  )
  into res
  from public.teams t;
  return res;
end;
$$;

-- Visitors may call only these two functions
revoke all on function public.register_team(text, text, text[]) from public;
revoke all on function public.public_results() from public;
grant execute on function public.register_team(text, text, text[]) to anon, authenticated;
grant execute on function public.public_results() to anon, authenticated;
