# Defense Grading

A web app for grading team defenses. Panelists sign in on their phone or laptop and grade the teams with the rubric of their section. The admin manages teams, panelists and rubrics, and sees the results.

**Live site:** https://issachar04.github.io/defense-grading/

## How grading works

| Section | Rubrics | Scored by |
| --- | --- | --- |
| 1 · Flowchart and Flow of the System | 1A Flowchart, 1B Flow of the System | Section 1 panelists |
| 2 · Design and User-Friendliness | 2A UI, 2B UX | Section 2 panelists |
| 3 · System Validation and Security | 3 Validation and Security | Section 3 panelists |

- Each criterion is scored **1 to 5** (1 Poor, 2 Fair, 3 Good, 4 Very good, 5 Excellent).
- Every panelist also gives a **group grade** for the team and an **individual grade** for each member, from 0 to 100, with no rubric.
- **Section %** = the average of the panelist's criterion scores ÷ 5 × 100, averaged over all panelists of that section.
- **Rubric average** = the average of the 3 section percentages.
- **Group grade** and **individual grades** = the average over all panelists who gave one.

## Using it

**Admin** (nate060489@gmail.com)
1. Open the site and click **New panelist? Create an account** with the admin email. You're signed in at once, and that email becomes admin automatically.
2. **Teams:** add each team, its project title and its members.
3. **Panelists:** after the panelists create their accounts, choose the section each one grades. Choose **All sections (every rubric)** for a panelist who grades the remaining teams on all 5 rubrics; their scores count in each section like any other panelist of that section.
4. **Results:** watch the grades come in, then click **Download CSV**.
5. **Rubrics:** edit, add or delete criteria if needed.

**Panelists**
1. Open the site and create an account (no email confirmation needed).
2. Once the admin assigns a section, sign in and open **Grade teams**.
3. Pick a team, score every criterion, give the group and individual grades, write any **comments for the team** (optional), and click **Save grades**. Grades and comments can be changed later.

## Public pages (no sign-in)

| Page | Address | What it does |
| --- | --- | --- |
| Team registration | `…/defense-grading/#/register` | A team enters its name, project title and members (up to 10). Works only while the admin keeps **Team registration open** on. |
| Public results | `…/defense-grading/#/results` | Shows every team's section %, rubric average, group grade, members' grades and the panel comments (with the section, not the panelist's name), but only after the admin turns on **Show results on the public page**. Until then it says the results aren't released yet. |

Both switches are at the top of the admin **Results** page. Visitors can't touch the tables: the pages call two database functions (`register_team`, `public_results`) that check everything first.

## Security

- Accounts and passwords are handled by Supabase Auth; passwords are never stored by the app.
- Every table has **Row Level Security**:
  - People who aren't signed in can't read anything.
  - A panelist can only read and write **their own** grades, and only for **their own section's** criteria.
  - Only the admin can change teams, members, rubrics and panelists, and only the admin can see everyone's grades.
- The database also checks the values: scores must be 1 to 5, and grades must be 0 to 100.
- Email confirmation is turned off in Supabase (Authentication > Sign In / Providers) so panelists can join quickly on defense day. A new account can't grade or see any grades until the admin assigns it a section.

## Files

| File | What it is |
| --- | --- |
| `index.html`, `style.css`, `app.js` | The app (plain HTML, CSS and JavaScript) |
| `config.js` | The Supabase project URL and publishable key (safe to be public) |
| `supabase/schema.sql` | Tables, security rules and the rubrics; run once in the Supabase SQL Editor |
| `supabase/002_public_pages.sql` | Settings, team registration and public results; run once after `schema.sql` |
| `supabase/003_comments.sql` | Panel comments on the public results page (max 2,000 characters); run once after `002_public_pages.sql` |
| `supabase/004_all_sections.sql` | "All sections" panelists who grade every rubric; run once after `003_comments.sql` |
