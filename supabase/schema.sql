-- =====================================================================
--  Defense Grading System: database, security rules and rubrics
--  Run once in Supabase: SQL Editor > New query > paste > Run
-- =====================================================================

-- ---------- Who is admin ----------
-- Whoever signs up with an email in this list becomes admin.
create table if not exists public.admin_emails (
  email text primary key
);
insert into public.admin_emails (email) values ('nate060489@gmail.com')
on conflict do nothing;

-- ---------- Sections, rubrics and criteria ----------
create table if not exists public.sections (
  id         int primary key,
  name       text not null,
  sort_order int  not null default 0
);

create table if not exists public.rubrics (
  id         serial primary key,
  section_id int  not null references public.sections (id) on delete cascade,
  code       text not null,
  name       text not null,
  sort_order int  not null default 0
);

create table if not exists public.criteria (
  id          serial primary key,
  rubric_id   int  not null references public.rubrics (id) on delete cascade,
  name        text not null,
  description text,
  sort_order  int  not null default 0
);

-- ---------- People ----------
-- One row per signed-up user (made automatically by the trigger below)
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text not null,
  full_name  text not null default '',
  role       text not null default 'panelist' check (role in ('admin', 'panelist')),
  section_id int references public.sections (id),   -- the section this panelist grades
  created_at timestamptz not null default now()
);

-- ---------- Teams and members ----------
create table if not exists public.teams (
  id            serial primary key,
  name          text not null,
  project_title text not null default '',
  created_at    timestamptz not null default now()
);

create table if not exists public.members (
  id        serial primary key,
  team_id   int  not null references public.teams (id) on delete cascade,
  full_name text not null
);

-- ---------- Grades ----------
-- One 1-5 score per panelist, team and criterion
create table if not exists public.rubric_scores (
  team_id      int  not null references public.teams (id) on delete cascade,
  panelist_id  uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  criterion_id int  not null references public.criteria (id) on delete cascade,
  score        int  not null check (score between 1 and 5),
  updated_at   timestamptz not null default now(),
  primary key (team_id, panelist_id, criterion_id)
);

-- Group grade (no rubric): one per panelist and team
create table if not exists public.group_grades (
  team_id     int  not null references public.teams (id) on delete cascade,
  panelist_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  grade       numeric(5,2) not null check (grade between 0 and 100),
  remarks     text not null default '',
  updated_at  timestamptz not null default now(),
  primary key (team_id, panelist_id)
);

-- Individual grade (no rubric): one per panelist and member
create table if not exists public.individual_grades (
  member_id   int  not null references public.members (id) on delete cascade,
  panelist_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  grade       numeric(5,2) not null check (grade between 0 and 100),
  updated_at  timestamptz not null default now(),
  primary key (member_id, panelist_id)
);

-- ---------- Make a profile for every new sign-up ----------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    case when exists (select 1 from public.admin_emails a where lower(a.email) = lower(new.email))
         then 'admin' else 'panelist' end
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Helper functions for the security rules ----------
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

create or replace function public.my_section()
returns int
language sql stable security definer set search_path = public
as $$
  select section_id from public.profiles where id = auth.uid();
$$;

-- Is this criterion in the section the current panelist grades?
create or replace function public.criterion_in_my_section(cid int)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.criteria c
    join public.rubrics r on r.id = c.rubric_id
    where c.id = cid and r.section_id = public.my_section()
  );
$$;

-- ---------- Row Level Security ----------
alter table public.admin_emails      enable row level security;
alter table public.sections          enable row level security;
alter table public.rubrics           enable row level security;
alter table public.criteria          enable row level security;
alter table public.profiles          enable row level security;
alter table public.teams             enable row level security;
alter table public.members           enable row level security;
alter table public.rubric_scores     enable row level security;
alter table public.group_grades      enable row level security;
alter table public.individual_grades enable row level security;

-- admin_emails: no policies, so nobody can read or change it from the app

-- Rubrics, teams and members: every signed-in user can read; only the admin can change
do $$
declare t text;
begin
  foreach t in array array['sections', 'rubrics', 'criteria', 'teams', 'members'] loop
    execute format('drop policy if exists "read when signed in" on public.%I', t);
    execute format('create policy "read when signed in" on public.%I for select to authenticated using (true)', t);
    execute format('drop policy if exists "admin writes" on public.%I', t);
    execute format('create policy "admin writes" on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;

-- Profiles: you see your own; the admin sees and edits everyone (roles, sections)
drop policy if exists "see own profile" on public.profiles;
create policy "see own profile" on public.profiles
  for select to authenticated using (id = auth.uid() or public.is_admin());
drop policy if exists "admin edits profiles" on public.profiles;
create policy "admin edits profiles" on public.profiles
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- Rubric scores: a panelist reads and writes only their own, and only for their section
drop policy if exists "own scores read" on public.rubric_scores;
create policy "own scores read" on public.rubric_scores
  for select to authenticated using (panelist_id = auth.uid() or public.is_admin());
drop policy if exists "own scores insert" on public.rubric_scores;
create policy "own scores insert" on public.rubric_scores
  for insert to authenticated
  with check (panelist_id = auth.uid() and public.criterion_in_my_section(criterion_id));
drop policy if exists "own scores update" on public.rubric_scores;
create policy "own scores update" on public.rubric_scores
  for update to authenticated
  using (panelist_id = auth.uid())
  with check (panelist_id = auth.uid() and public.criterion_in_my_section(criterion_id));
drop policy if exists "own scores delete" on public.rubric_scores;
create policy "own scores delete" on public.rubric_scores
  for delete to authenticated using (panelist_id = auth.uid() or public.is_admin());

-- Group and individual grades: a panelist with a section reads and writes only their own
do $$
declare t text;
begin
  foreach t in array array['group_grades', 'individual_grades'] loop
    execute format('drop policy if exists "own grades read" on public.%I', t);
    execute format('create policy "own grades read" on public.%I for select to authenticated using (panelist_id = auth.uid() or public.is_admin())', t);
    execute format('drop policy if exists "own grades insert" on public.%I', t);
    execute format('create policy "own grades insert" on public.%I for insert to authenticated with check (panelist_id = auth.uid() and public.my_section() is not null)', t);
    execute format('drop policy if exists "own grades update" on public.%I', t);
    execute format('create policy "own grades update" on public.%I for update to authenticated using (panelist_id = auth.uid()) with check (panelist_id = auth.uid())', t);
    execute format('drop policy if exists "own grades delete" on public.%I', t);
    execute format('create policy "own grades delete" on public.%I for delete to authenticated using (panelist_id = auth.uid() or public.is_admin())', t);
  end loop;
end $$;

-- The app talks to these tables through the Data API as a signed-in user only
grant usage on schema public to authenticated;
grant select, insert, update, delete on
  public.sections, public.rubrics, public.criteria, public.profiles, public.teams,
  public.members, public.rubric_scores, public.group_grades, public.individual_grades
  to authenticated;
grant usage, select on all sequences in schema public to authenticated;
revoke all on public.admin_emails from anon, authenticated;
revoke all on
  public.sections, public.rubrics, public.criteria, public.profiles, public.teams,
  public.members, public.rubric_scores, public.group_grades, public.individual_grades
  from anon;

-- ---------- The rubrics ----------
insert into public.sections (id, name, sort_order) values
  (1, 'Flowchart and Flow of the System', 1),
  (2, 'Design and User-Friendliness (UI and UX)', 2),
  (3, 'System Validation and Security', 3)
on conflict (id) do update set name = excluded.name, sort_order = excluded.sort_order;

do $$
declare r int;
begin
  if not exists (select 1 from public.rubrics) then
    insert into public.rubrics (section_id, code, name, sort_order) values (1, '1A', 'Flowchart', 1) returning id into r;
    insert into public.criteria (rubric_id, name, description, sort_order) values
      (r, 'Completeness', 'Shows every main process from start to end.', 1),
      (r, 'Correct symbols', 'Uses standard flowchart symbols properly (start/end, process, decision, input/output).', 2),
      (r, 'Correct logic', 'Decisions have clear Yes/No paths, with no dead ends or loose arrows.', 3),
      (r, 'Neatness', 'Easy to read and follow, with arrows that don''t cross confusingly.', 4);

    insert into public.rubrics (section_id, code, name, sort_order) values (1, '1B', 'Flow of the System', 2) returning id into r;
    insert into public.criteria (rubric_id, name, description, sort_order) values
      (r, 'Matches the flowchart', 'The running system follows the flowchart.', 1),
      (r, 'Logical order', 'The steps happen in a sensible order for the user''s task.', 2),
      (r, 'Complete process', 'Each main task can be finished from start to end without errors.', 3),
      (r, 'Explanation', 'The team explains the flow clearly and answers questions.', 4);

    insert into public.rubrics (section_id, code, name, sort_order) values (2, '2A', 'UI (User Interface)', 1) returning id into r;
    insert into public.criteria (rubric_id, name, description, sort_order) values
      (r, 'Layout', 'Clean, organized screens with consistent spacing and alignment.', 1),
      (r, 'Visual design', 'Consistent colors, fonts and icons that look professional.', 2),
      (r, 'Readability', 'Text, labels and buttons are clear and easy to read.', 3),
      (r, 'Responsiveness', 'Looks right on both laptop and phone screens.', 4);

    insert into public.rubrics (section_id, code, name, sort_order) values (2, '2B', 'UX (User Experience)', 2) returning id into r;
    insert into public.criteria (rubric_id, name, description, sort_order) values
      (r, 'Ease of use', 'A new user can do the main tasks without help.', 1),
      (r, 'Navigation', 'Menus are clear, and the user always knows where they are.', 2),
      (r, 'Feedback', 'The system shows clear messages after actions (saved, error, loading).', 3),
      (r, 'Efficiency', 'Tasks take few steps and clicks.', 4);

    insert into public.rubrics (section_id, code, name, sort_order) values (3, '3', 'System Validation and Security', 1) returning id into r;
    insert into public.criteria (rubric_id, name, description, sort_order) values
      (r, 'Input validation', 'Required fields, formats and limits are checked, with clear error messages.', 1),
      (r, 'Data accuracy', 'Saves, updates and computes data correctly (no wrong totals or lost records).', 2),
      (r, 'Login and access control', 'Users log in, and each role only sees and does what it should.', 3),
      (r, 'Data protection', 'Passwords are hashed and sensitive data is protected; safe from SQL injection.', 4),
      (r, 'Error handling', 'The system doesn''t crash; it handles mistakes and shows helpful messages.', 5);
  end if;
end $$;
