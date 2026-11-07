-- =====================================================================
--  "All sections" panelists: grade every rubric (1A, 1B, 2A, 2B, 3)
--  Run once in Supabase after 003_comments.sql
-- =====================================================================

alter table public.profiles add column if not exists all_sections boolean not null default false;

-- Does the current panelist grade every section?
create or replace function public.grades_all_sections()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((select all_sections from public.profiles where id = auth.uid()), false);
$$;

-- A criterion is gradable if it is in the panelist's section, or the panelist grades all sections
create or replace function public.criterion_in_my_section(cid int)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.criteria c
    join public.rubrics r on r.id = c.rubric_id
    where c.id = cid and (r.section_id = public.my_section() or public.grades_all_sections())
  );
$$;

-- Group and individual grades: allowed for panelists with a section or with all sections
do $$
declare t text;
begin
  foreach t in array array['group_grades', 'individual_grades'] loop
    execute format('drop policy if exists "own grades insert" on public.%I', t);
    execute format('create policy "own grades insert" on public.%I for insert to authenticated with check (panelist_id = auth.uid() and (public.my_section() is not null or public.grades_all_sections()))', t);
  end loop;
end $$;

revoke all on function public.grades_all_sections() from public, anon;
grant execute on function public.grades_all_sections() to authenticated;
