-- =====================================================================
--  Panel comments for each team
--  Run once in Supabase after 002_public_pages.sql
-- =====================================================================

-- Comments are stored in group_grades.remarks; keep them a sensible length
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'group_grades_remarks_length') then
    alter table public.group_grades
      add constraint group_grades_remarks_length check (length(remarks) <= 2000);
  end if;
end $$;

-- Published results now include the panel comments, with the section but without panelist names
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

  with per_panelist as (
    select rs.team_id, r.section_id, rs.panelist_id, avg(rs.score) / 5 * 100 as pct
    from public.rubric_scores rs
    join public.criteria c on c.id = rs.criterion_id
    join public.rubrics  r on r.id = c.rubric_id
    group by rs.team_id, r.section_id, rs.panelist_id
  ), per_section as (
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
                  from public.members m left join member_avg ma on ma.member_id = m.id where m.team_id = t.id),
      'comments', (select coalesce(jsonb_agg(jsonb_build_object('section', p.section_id, 'text', btrim(gg.remarks)) order by p.section_id, gg.updated_at), '[]'::jsonb)
                   from public.group_grades gg join public.profiles p on p.id = gg.panelist_id
                   where gg.team_id = t.id and btrim(gg.remarks) <> '')
    ) order by t.name), '[]'::jsonb)
  )
  into res
  from public.teams t;
  return res;
end;
$$;

revoke all on function public.public_results() from public;
grant execute on function public.public_results() to anon, authenticated;
