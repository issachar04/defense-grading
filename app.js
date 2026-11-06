// Defense Grading: panelists grade teams with section rubrics (1 to 5 per criterion),
// plus a group grade and individual grades (0 to 100). The admin manages teams,
// panelists and rubrics, and sees the results. Every rule is also enforced by the
// database (Row Level Security), so the app can't be used to cheat.

const db = supabase.createClient(APP_CONFIG.supabaseUrl, APP_CONFIG.supabaseKey);

const state = {
  user: null,
  profile: null,
  view: null,
  data: null,          // sections, rubrics, criteria, teams, members
  selectedTeam: null,
};

// ---------- Small helpers ----------
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}
const $app = document.getElementById('app');
function show(...nodes) { $app.replaceChildren(...nodes.flat().filter((n) => n !== null && n !== undefined && n !== false)); }

let toastTimer;
function toast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

// Throws the Supabase error so callers can show it
function check({ data, error }) {
  if (error) throw error;
  return data;
}
async function guard(fn) {
  try { return await fn(); }
  catch (e) { console.error(e); toast(e.message || String(e), true); }
}

const pct = (n) => (n === null || n === undefined || Number.isNaN(n) ? '–' : n.toFixed(2));
const avg = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);

// ---------- Loading shared data ----------
async function loadBaseData() {
  const [sections, rubrics, criteria, teams, members] = await Promise.all([
    db.from('sections').select('*').order('sort_order'),
    db.from('rubrics').select('*').order('sort_order'),
    db.from('criteria').select('*').order('sort_order'),
    db.from('teams').select('*').order('name'),
    db.from('members').select('*').order('id'),
  ]);
  state.data = {
    sections: check(sections), rubrics: check(rubrics), criteria: check(criteria),
    teams: check(teams), members: check(members),
  };
}
function rubricsOf(sectionId) { return state.data.rubrics.filter((r) => r.section_id === sectionId); }
function criteriaOf(rubricId) { return state.data.criteria.filter((c) => c.rubric_id === rubricId); }
function criteriaOfSection(sectionId) { return rubricsOf(sectionId).flatMap((r) => criteriaOf(r.id)); }
function membersOf(teamId) { return state.data.members.filter((m) => m.team_id === teamId); }
function sectionName(id) { return state.data.sections.find((s) => s.id === id)?.name || 'No section'; }

// ---------- Header ----------
function renderHeader() {
  const nav = document.getElementById('nav');
  const who = document.getElementById('who');
  nav.replaceChildren();
  who.replaceChildren();
  // Pages anyone can open, without signing in
  const route = location.hash;
  const publicLinks = [['#/results', 'Public results'], ['#/register', 'Register a team']];
  if (!state.profile || route.startsWith('#/')) {
    for (const [hash, label] of publicLinks) {
      nav.append(el('button', { class: route === hash ? 'active' : '', onclick: () => { location.hash = hash; } }, label));
    }
    if (route.startsWith('#/')) {
      nav.append(el('button', { onclick: () => { location.hash = ''; } }, state.profile ? 'Back to the app' : 'Sign in'));
    }
    if (!state.profile) return;
    if (route.startsWith('#/')) return;
  }

  const tabs = [];
  if (state.profile.section_id) tabs.push(['grade', 'Grade teams']);
  if (state.profile.role === 'admin') {
    tabs.push(['results', 'Results'], ['teams', 'Teams'], ['panelists', 'Panelists'], ['rubrics', 'Rubrics']);
  }
  for (const [key, label] of tabs) {
    nav.append(el('button', { class: state.view === key ? 'active' : '', onclick: () => go(key) }, label));
  }
  who.append(
    el('span', {}, `${state.profile.full_name || state.profile.email} · ${state.profile.role}`),
    el('button', { class: 'secondary small', onclick: signOut }, 'Sign out'),
  );
}

async function go(view) {
  state.view = view;
  renderHeader();
  show(el('p', { class: 'muted' }, 'Loading…'));
  await guard(async () => {
    await loadBaseData();
    if (view === 'grade') await renderGrade();
    else if (view === 'results') await renderResults();
    else if (view === 'teams') renderTeams();
    else if (view === 'panelists') await renderPanelists();
    else if (view === 'rubrics') renderRubrics();
    else renderWaiting();
  });
}

// ---------- Sign in / sign up ----------
function renderAuth(mode = 'signin', message = '') {
  state.profile = null;
  renderHeader();
  const isUp = mode === 'signup';
  const msg = el('p', { class: 'error' }, message);
  const form = el('form', { onsubmit: async (e) => {
      e.preventDefault();
      msg.className = 'error';
      msg.textContent = '';
      const email = form.email.value.trim();
      const password = form.password.value;
      const button = form.querySelector('button[type=submit]');
      button.disabled = true;
      try {
        if (isUp) {
          const fullName = form.full_name.value.trim();
          if (fullName.length < 2) throw new Error('Please enter your full name.');
          if (password.length < 8) throw new Error('The password must be at least 8 characters.');
          const res = await db.auth.signUp({
            email, password,
            options: { data: { full_name: fullName }, emailRedirectTo: location.origin + location.pathname },
          });
          if (res.error) throw res.error;
          if (!res.data.session) {
            msg.className = 'ok';
            msg.textContent = 'Account created. Check your email and click the confirmation link, then sign in.';
          }
        } else {
          const res = await db.auth.signInWithPassword({ email, password });
          if (res.error) throw res.error;
        }
      } catch (err) {
        msg.textContent = err.message;
      } finally {
        button.disabled = false;
      }
    } },
    el('h2', {}, isUp ? 'Create a panelist account' : 'Sign in'),
    isUp ? el('label', {}, 'Full name', el('input', { name: 'full_name', required: true, maxlength: 100, autocomplete: 'name' })) : null,
    el('label', {}, 'Email', el('input', { name: 'email', type: 'email', required: true, autocomplete: 'email' })),
    el('label', {}, 'Password', el('input', { name: 'password', type: 'password', required: true, minlength: isUp ? 8 : null, autocomplete: isUp ? 'new-password' : 'current-password' })),
    el('div', { class: 'row' },
      el('button', { type: 'submit' }, isUp ? 'Create account' : 'Sign in'),
      el('span', { class: 'spacer' }),
      el('button', { type: 'button', class: 'linklike', onclick: () => renderAuth(isUp ? 'signin' : 'signup') },
        isUp ? 'I already have an account' : 'New panelist? Create an account'),
    ),
    msg,
  );
  show(el('div', { class: 'card narrow' }, form));
}

async function signOut() {
  await db.auth.signOut();
}

function renderWaiting() {
  show(el('div', { class: 'card narrow' },
    el('h2', {}, 'Welcome, ' + (state.profile.full_name || state.profile.email)),
    el('p', {}, 'Your account is ready. The admin still needs to assign you to a section (1, 2 or 3) before you can grade.'),
    el('p', { class: 'muted' }, 'Ask the admin, then click Refresh.'),
    el('button', { onclick: start }, 'Refresh'),
  ));
}

// ---------- Panelist: grade teams ----------
async function loadMyGrades() {
  const uid = state.user.id;
  const [scores, groups, individuals] = await Promise.all([
    db.from('rubric_scores').select('*').eq('panelist_id', uid),
    db.from('group_grades').select('*').eq('panelist_id', uid),
    db.from('individual_grades').select('*').eq('panelist_id', uid),
  ]);
  return { scores: check(scores), groups: check(groups), individuals: check(individuals) };
}

async function renderGrade() {
  const sectionId = state.profile.section_id;
  const mine = await loadMyGrades();
  const sectionCriteria = criteriaOfSection(sectionId);
  const teams = state.data.teams;
  if (!state.selectedTeam || !teams.some((t) => t.id === state.selectedTeam)) state.selectedTeam = teams[0]?.id || null;

  const doneFor = (teamId) => {
    const scored = mine.scores.filter((s) => s.team_id === teamId).length;
    const group = mine.groups.some((g) => g.team_id === teamId);
    return scored === sectionCriteria.length && group;
  };

  const list = el('ul', { class: 'team-list' },
    teams.map((t) => el('li', {},
      el('button', { class: t.id === state.selectedTeam ? 'active' : '', onclick: () => { state.selectedTeam = t.id; renderGrade(); } },
        el('span', {}, t.name),
        el('span', { class: 'badge' + (doneFor(t.id) ? ' done' : '') }, doneFor(t.id) ? 'Done' : 'To do'),
      ))),
  );

  const side = el('div', { class: 'card' },
    el('h3', {}, 'Teams'),
    teams.length ? list : el('p', { class: 'muted' }, 'No teams yet. The admin adds them.'),
  );

  const team = teams.find((t) => t.id === state.selectedTeam);
  const body = team ? gradeForm(team, sectionId, mine) : el('div', { class: 'card' }, el('p', { class: 'muted' }, 'Pick a team.'));

  show(
    el('div', { class: 'card' },
      el('h2', {}, 'Section ' + sectionId + ': ' + sectionName(sectionId)),
      el('p', { class: 'muted' }, 'Score each criterion from 1 to 5, give a group grade and an individual grade for each member, then click Save.'),
    ),
    el('div', { class: 'grade-layout' }, side, body),
  );
}

function gradeForm(team, sectionId, mine) {
  const picked = new Map(mine.scores.filter((s) => s.team_id === team.id).map((s) => [s.criterion_id, s.score]));
  const sectionCriteria = criteriaOfSection(sectionId);
  const scoreOut = el('span', { class: 'score-pill' });
  const updateScore = () => {
    const values = sectionCriteria.map((c) => picked.get(c.id)).filter(Boolean);
    const p = values.length ? (avg(values) / 5) * 100 : null;
    scoreOut.textContent = (p === null ? '–' : p.toFixed(2) + '%') + `  (${values.length}/${sectionCriteria.length} scored)`;
  };

  const rubricBlocks = rubricsOf(sectionId).map((r) => el('div', { class: 'card' },
    el('h3', {}, r.code + ' · ' + r.name),
    el('p', { class: 'legend' }, '1 Poor · 2 Fair · 3 Good · 4 Very good · 5 Excellent'),
    criteriaOf(r.id).map((c) => {
      const buttons = [1, 2, 3, 4, 5].map((n) => el('button', {
        type: 'button',
        class: picked.get(c.id) === n ? 'picked' : '',
        'aria-label': `${c.name}: ${n}`,
        onclick: (e) => {
          picked.set(c.id, n);
          [...e.currentTarget.parentNode.children].forEach((b, i) => b.classList.toggle('picked', i + 1 === n));
          updateScore();
        },
      }, String(n)));
      return el('div', { class: 'criterion' },
        el('div', {}, el('strong', {}, c.name), el('div', { class: 'desc' }, c.description || '')),
        el('div', { class: 'scale' }, buttons),
      );
    }),
  ));
  updateScore();

  const myGroup = mine.groups.find((g) => g.team_id === team.id);
  const groupInput = el('input', { type: 'number', min: 0, max: 100, step: '0.01', required: true, value: myGroup ? myGroup.grade : '', placeholder: '0 – 100' });
  const remarksInput = el('textarea', { rows: 5, maxlength: 2000, placeholder: 'Strengths, things to improve, suggestions for the team…' });
  remarksInput.value = myGroup?.remarks || '';

  const memberInputs = membersOf(team.id).map((m) => {
    const mineInd = mine.individuals.find((i) => i.member_id === m.id);
    return { member: m, input: el('input', { type: 'number', min: 0, max: 100, step: '0.01', value: mineInd ? mineInd.grade : '', placeholder: '0 – 100' }) };
  });

  const save = el('button', { type: 'button', onclick: () => guard(async () => {
    // Check everything before saving anything
    const missing = sectionCriteria.filter((c) => !picked.get(c.id));
    if (missing.length) throw new Error(`Please score all criteria first (${missing.length} missing).`);
    const g = Number(groupInput.value);
    if (groupInput.value === '' || !(g >= 0 && g <= 100)) throw new Error('The group grade must be a number from 0 to 100.');
    for (const { member, input } of memberInputs) {
      const v = Number(input.value);
      if (input.value === '' || !(v >= 0 && v <= 100)) throw new Error(`The individual grade for ${member.full_name} must be from 0 to 100.`);
    }

    save.disabled = true;
    const uid = state.user.id;
    const now = new Date().toISOString();
    try {
      check(await db.from('rubric_scores').upsert(
        sectionCriteria.map((c) => ({ team_id: team.id, panelist_id: uid, criterion_id: c.id, score: picked.get(c.id), updated_at: now })),
        { onConflict: 'team_id,panelist_id,criterion_id' }));
      check(await db.from('group_grades').upsert(
        { team_id: team.id, panelist_id: uid, grade: g, remarks: remarksInput.value.trim(), updated_at: now },
        { onConflict: 'team_id,panelist_id' }));
      if (memberInputs.length) {
        check(await db.from('individual_grades').upsert(
          memberInputs.map(({ member, input }) => ({ member_id: member.id, panelist_id: uid, grade: Number(input.value), updated_at: now })),
          { onConflict: 'member_id,panelist_id' }));
      }
      toast(`Saved the grades for ${team.name}.`);
      await renderGrade();
    } finally {
      save.disabled = false;
    }
  }) }, 'Save grades');

  return el('div', {},
    el('div', { class: 'card' },
      el('div', { class: 'row' },
        el('div', {}, el('h2', {}, team.name), el('div', { class: 'muted' }, team.project_title || '')),
        el('span', { class: 'spacer' }),
        el('div', {}, el('div', { class: 'muted' }, 'Section score'), scoreOut),
      ),
    ),
    rubricBlocks,
    el('div', { class: 'card' },
      el('h3', {}, 'Comments for this team'),
      el('label', {}, 'Your feedback in words (optional). The team can read it when the results are published, without your name.', remarksInput),
    ),
    el('div', { class: 'card' },
      el('h3', {}, 'Group grade (no rubric)'),
      el('label', {}, 'Grade for the whole team, 0 to 100', groupInput),
      el('h3', {}, 'Individual grades (no rubric)'),
      memberInputs.length
        ? memberInputs.map(({ member, input }) => el('label', {}, member.full_name, input))
        : el('p', { class: 'muted' }, 'This team has no members yet.'),
      el('div', { class: 'row' }, save),
    ),
  );
}

// ---------- Admin: results ----------
async function renderResults() {
  const [scores, groups, individuals, profiles, settings] = await Promise.all([
    db.from('rubric_scores').select('*'),
    db.from('group_grades').select('*'),
    db.from('individual_grades').select('*'),
    db.from('profiles').select('*'),
    db.from('app_settings').select('*').eq('id', 1).single(),
  ]);
  const S = check(scores), G = check(groups), I = check(individuals), P = check(profiles), cfg = check(settings);
  const results = computeResults(S, G, I, P);

  const sections = state.data.sections;
  const head = el('tr', {},
    el('th', {}, 'Team'),
    sections.map((s) => el('th', { class: 'num' }, 'Sec ' + s.id + ' %')),
    el('th', { class: 'num' }, 'Rubric average %'),
    el('th', { class: 'num' }, 'Group grade'),
    el('th', {}, 'Members (individual grade)'),
  );
  const rows = results.map((r) => el('tr', {},
    el('td', {}, el('strong', {}, r.team.name), el('div', { class: 'member-line' }, r.team.project_title || '')),
    sections.map((s) => {
      const sec = r.sections[s.id];
      return el('td', { class: 'num', title: sec.detail }, pct(sec.percent), el('div', { class: 'member-line' }, sec.panelists + ' panelist(s)'));
    }),
    el('td', { class: 'num' }, el('strong', {}, pct(r.rubricAverage))),
    el('td', { class: 'num' }, pct(r.groupAverage), el('div', { class: 'member-line' }, r.groupCount + ' panelist(s)')),
    el('td', {}, r.members.map((m) => el('div', { class: 'member-line' }, `${m.member.full_name}: ${pct(m.average)} (${m.count})`))),
  ));

  // Panel comments, team by team
  const commentCards = results.filter((r) => r.comments.length).map((r) => el('div', { class: 'card' },
    el('h3', {}, 'Comments for ' + r.team.name),
    r.comments.map((c) => el('div', { class: 'comment' },
      el('div', { class: 'member-line' }, c.who + (c.section ? ` · Section ${c.section}` : '')),
      el('p', {}, c.text),
    )),
  ));

  const panelistsBySection = sections.map((s) => {
    const names = P.filter((p) => p.section_id === s.id).map((p) => p.full_name || p.email);
    return el('div', { class: 'member-line' }, `Section ${s.id}: ${names.length ? names.join(', ') : 'no panelists yet'}`);
  });

  // Switches for the two public pages
  const toggle = (field, label, onText, offText) => {
    const box = el('input', { type: 'checkbox', checked: cfg[field] });
    const note = el('span', { class: 'muted' }, cfg[field] ? onText : offText);
    box.addEventListener('change', () => guard(async () => {
      check(await db.from('app_settings').update({ [field]: box.checked }).eq('id', 1));
      note.textContent = box.checked ? onText : offText;
      toast('Saved.');
    }));
    return el('label', { class: 'row', style: 'flex-direction:row' }, box, el('strong', {}, label), note);
  };
  const pageUrl = location.origin + location.pathname;

  show(
    el('div', { class: 'card' },
      el('h2', {}, 'Public pages'),
      toggle('registration_open', 'Team registration open', '(teams can add themselves)', '(closed)'),
      el('p', { class: 'member-line' }, 'Registration page: ' + pageUrl + '#/register'),
      toggle('results_public', 'Show results on the public page', '(everyone can see the grades)', '(hidden: grades stay private)'),
      el('p', { class: 'member-line' }, 'Public results page: ' + pageUrl + '#/results'),
    ),
    el('div', { class: 'card' },
      el('div', { class: 'row' },
        el('h2', {}, 'Results'),
        el('span', { class: 'spacer' }),
        el('button', { class: 'secondary', onclick: () => go('results') }, 'Refresh'),
        el('button', { onclick: () => downloadCsv(results) }, 'Download CSV'),
      ),
      el('p', { class: 'muted' }, 'Section % = the average of every criterion score (1 to 5) in that section, as a percentage, averaged over the panelists of that section. Rubric average = the average of the 3 sections. Group and individual grades are averaged over all panelists who gave one.'),
      panelistsBySection,
    ),
    el('div', { class: 'card table-wrap' },
      results.length ? el('table', {}, el('thead', {}, head), el('tbody', {}, rows)) : el('p', { class: 'muted' }, 'No teams yet.'),
    ),
    commentCards.length ? el('h2', {}, 'Panel comments') : null,
    commentCards,
  );
}

function computeResults(S, G, I, P = []) {
  return state.data.teams.map((team) => {
    const sections = {};
    for (const s of state.data.sections) {
      const ids = new Set(criteriaOfSection(s.id).map((c) => c.id));
      const teamScores = S.filter((x) => x.team_id === team.id && ids.has(x.criterion_id));
      const byPanelist = new Map();
      for (const x of teamScores) {
        if (!byPanelist.has(x.panelist_id)) byPanelist.set(x.panelist_id, []);
        byPanelist.get(x.panelist_id).push(x.score);
      }
      const perPanelist = [...byPanelist.values()].map((list) => (avg(list) / 5) * 100);
      const perRubric = rubricsOf(s.id).map((r) => {
        const rIds = new Set(criteriaOf(r.id).map((c) => c.id));
        const v = teamScores.filter((x) => rIds.has(x.criterion_id)).map((x) => x.score);
        return `${r.code}: ${v.length ? ((avg(v) / 5) * 100).toFixed(2) + '%' : '–'}`;
      }).join(' · ');
      sections[s.id] = { percent: avg(perPanelist), panelists: perPanelist.length, detail: perRubric };
    }
    const sectionValues = Object.values(sections).map((x) => x.percent).filter((x) => x !== null);
    const groupGrades = G.filter((g) => g.team_id === team.id).map((g) => Number(g.grade));
    const members = membersOf(team.id).map((member) => {
      const v = I.filter((i) => i.member_id === member.id).map((i) => Number(i.grade));
      return { member, average: avg(v), count: v.length };
    });
    const comments = G.filter((g) => g.team_id === team.id && (g.remarks || '').trim()).map((g) => {
      const p = P.find((x) => x.id === g.panelist_id);
      return { who: p ? (p.full_name || p.email) : 'Panelist', section: p?.section_id || null, text: g.remarks.trim() };
    });
    return {
      team, sections,
      rubricAverage: sectionValues.length === state.data.sections.length ? avg(sectionValues) : null,
      groupAverage: avg(groupGrades), groupCount: groupGrades.length, members, comments,
    };
  });
}

function downloadCsv(results) {
  const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lines = [['Team', 'Project', 'Member', ...state.data.sections.map((s) => 'Section ' + s.id + ' %'), 'Rubric average %', 'Group grade', 'Individual grade', 'Panel comments'].map(q).join(',')];
  for (const r of results) {
    const base = state.data.sections.map((s) => pct(r.sections[s.id].percent));
    const comments = r.comments.map((c) => `${c.who}${c.section ? ' (Sec ' + c.section + ')' : ''}: ${c.text}`).join(' | ');
    const rows = r.members.length ? r.members : [{ member: { full_name: '' }, average: null }];
    rows.forEach((m, i) => {
      lines.push([r.team.name, r.team.project_title, m.member.full_name, ...base, pct(r.rubricAverage), pct(r.groupAverage), pct(m.average), i === 0 ? comments : ''].map(q).join(','));
    });
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = el('a', { href: URL.createObjectURL(blob), download: 'defense-results.csv' });
  document.body.append(a);
  a.click();
  a.remove();
}

// ---------- Admin: teams and members ----------
function renderTeams() {
  const name = el('input', { required: true, maxlength: 100, placeholder: 'Team 1' });
  const title = el('input', { maxlength: 200, placeholder: 'Project title' });
  const members = el('textarea', { rows: 4, placeholder: 'One member per line' });
  const addForm = el('form', { onsubmit: (e) => { e.preventDefault(); guard(async () => {
      const team = check(await db.from('teams').insert({ name: name.value.trim(), project_title: title.value.trim() }).select().single());
      const names = members.value.split('\n').map((s) => s.trim()).filter(Boolean);
      if (names.length) check(await db.from('members').insert(names.map((full_name) => ({ team_id: team.id, full_name }))));
      toast(`Added ${team.name}.`);
      await go('teams');
    }); } },
    el('h2', {}, 'Add a team'),
    el('label', {}, 'Team name', name),
    el('label', {}, 'Project title', title),
    el('label', {}, 'Members', members),
    el('button', { type: 'submit' }, 'Add team'),
  );

  const list = state.data.teams.map((t) => {
    const memberRows = membersOf(t.id).map((m) => el('div', { class: 'row' },
      el('span', {}, m.full_name),
      el('button', { class: 'danger small', onclick: () => guard(async () => {
        if (!confirm(`Remove ${m.full_name}? Their individual grades are deleted too.`)) return;
        check(await db.from('members').delete().eq('id', m.id));
        await go('teams');
      }) }, 'Remove'),
    ));
    const newMember = el('input', { maxlength: 100, placeholder: 'Add a member' });
    return el('div', { class: 'card' },
      el('div', { class: 'row' },
        el('div', {}, el('h3', {}, t.name), el('div', { class: 'muted' }, t.project_title || '')),
        el('span', { class: 'spacer' }),
        el('button', { class: 'secondary small', onclick: () => guard(async () => {
          const n = prompt('Team name', t.name);
          if (n === null) return;
          const p = prompt('Project title', t.project_title || '');
          if (p === null) return;
          check(await db.from('teams').update({ name: n.trim() || t.name, project_title: p.trim() }).eq('id', t.id));
          await go('teams');
        }) }, 'Edit'),
        el('button', { class: 'danger small', onclick: () => guard(async () => {
          if (!confirm(`Delete ${t.name}? All of its grades are deleted too.`)) return;
          check(await db.from('teams').delete().eq('id', t.id));
          await go('teams');
        }) }, 'Delete'),
      ),
      memberRows.length ? memberRows : el('p', { class: 'muted' }, 'No members yet.'),
      el('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); guard(async () => {
          if (!newMember.value.trim()) return;
          check(await db.from('members').insert({ team_id: t.id, full_name: newMember.value.trim() }));
          await go('teams');
        }); } }, newMember, el('button', { type: 'submit', class: 'small' }, 'Add member')),
    );
  });

  show(el('div', { class: 'card' }, addForm), list.length ? list : el('p', { class: 'muted' }, 'No teams yet.'));
}

// ---------- Admin: panelists ----------
async function renderPanelists() {
  const profiles = check(await db.from('profiles').select('*').order('created_at'));
  const rows = profiles.map((p) => {
    const section = el('select', { onchange: () => guard(async () => {
        check(await db.from('profiles').update({ section_id: section.value ? Number(section.value) : null }).eq('id', p.id));
        toast(`${p.full_name || p.email} now grades ${section.value ? 'Section ' + section.value : 'no section'}.`);
      }) },
      el('option', { value: '' }, 'No section'),
      state.data.sections.map((s) => el('option', { value: s.id, selected: p.section_id === s.id }, `Section ${s.id}: ${s.name}`)),
    );
    const role = el('select', { disabled: p.id === state.user.id, onchange: () => guard(async () => {
        check(await db.from('profiles').update({ role: role.value }).eq('id', p.id));
        toast(`${p.full_name || p.email} is now ${role.value}.`);
      }) },
      ['panelist', 'admin'].map((r) => el('option', { value: r, selected: p.role === r }, r)),
    );
    return el('tr', {}, el('td', {}, p.full_name || '–'), el('td', {}, p.email), el('td', {}, section), el('td', {}, role));
  });
  show(el('div', { class: 'card' },
    el('h2', {}, 'Panelists'),
    el('p', { class: 'muted' }, 'Panelists create their own account on the sign-in page. Then pick the section each one grades. Changes save at once.'),
    el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Name'), el('th', {}, 'Email'), el('th', {}, 'Section'), el('th', {}, 'Role'))),
      el('tbody', {}, rows),
    )),
  ));
}

// ---------- Admin: rubrics ----------
function renderRubrics() {
  const blocks = state.data.sections.map((s) => el('div', { class: 'card' },
    el('h2', {}, `Section ${s.id}: ${s.name}`),
    rubricsOf(s.id).map((r) => {
      const newName = el('input', { maxlength: 100, placeholder: 'New criterion' });
      const newDesc = el('input', { maxlength: 300, placeholder: 'Description' });
      return el('div', {},
        el('h3', {}, `${r.code} · ${r.name}`),
        criteriaOf(r.id).map((c) => {
          const n = el('input', { value: c.name, maxlength: 100 });
          const d = el('input', { value: c.description || '', maxlength: 300 });
          return el('div', { class: 'row', style: 'margin-bottom:8px' },
            n, el('span', { style: 'flex:1;display:flex' }, d),
            el('button', { class: 'secondary small', onclick: () => guard(async () => {
              if (!n.value.trim()) throw new Error('The criterion needs a name.');
              check(await db.from('criteria').update({ name: n.value.trim(), description: d.value.trim() }).eq('id', c.id));
              toast('Criterion saved.');
            }) }, 'Save'),
            el('button', { class: 'danger small', onclick: () => guard(async () => {
              if (!confirm(`Delete "${c.name}"? Its scores are deleted too.`)) return;
              check(await db.from('criteria').delete().eq('id', c.id));
              await go('rubrics');
            }) }, 'Delete'),
          );
        }),
        el('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); guard(async () => {
            if (!newName.value.trim()) throw new Error('The criterion needs a name.');
            const order = Math.max(0, ...criteriaOf(r.id).map((c) => c.sort_order)) + 1;
            check(await db.from('criteria').insert({ rubric_id: r.id, name: newName.value.trim(), description: newDesc.value.trim(), sort_order: order }));
            await go('rubrics');
          }); } }, newName, newDesc, el('button', { type: 'submit', class: 'small' }, 'Add criterion')),
      );
    }),
  ));
  show(...blocks);
}

// ---------- Public page: team registration ----------
function renderRegister() {
  renderHeader();
  const name = el('input', { required: true, minlength: 2, maxlength: 100, placeholder: 'Team 1' });
  const title = el('input', { maxlength: 200, placeholder: 'Your project title' });
  const members = el('textarea', { rows: 6, required: true, placeholder: 'Juan Dela Cruz\nMaria Santos\nPedro Reyes' });
  const msg = el('p', { class: 'error', role: 'status' });
  const form = el('form', { onsubmit: async (e) => {
      e.preventDefault();
      msg.className = 'error';
      msg.textContent = '';
      const list = members.value.split('\n').map((s) => s.trim()).filter(Boolean);
      if (list.length === 0) { msg.textContent = 'Add at least one member.'; return; }
      if (list.length > 10) { msg.textContent = 'A team can have at most 10 members.'; return; }
      const short = list.find((n) => n.length < 2 || n.length > 100);
      if (short) { msg.textContent = `"${short}" isn't a valid name (2 to 100 characters).`; return; }
      const button = form.querySelector('button[type=submit]');
      button.disabled = true;
      try {
        const res = await db.rpc('register_team', { p_name: name.value.trim(), p_title: title.value.trim(), p_members: list });
        if (res.error) throw res.error;
        const teamName = name.value.trim();
        form.reset();
        msg.className = 'ok';
        msg.textContent = `${teamName} is registered with ${list.length} member(s). Good luck on your defense!`;
      } catch (err) {
        msg.textContent = err.message;
      } finally {
        button.disabled = false;
      }
    } },
    el('h2', {}, 'Register your team'),
    el('p', { class: 'muted' }, 'No account needed. One person per team fills this in once. To change it later, ask the admin.'),
    el('label', {}, 'Team name', name),
    el('label', {}, 'Project title', title),
    el('label', {}, 'Members (full names, one per line, up to 10)', members),
    el('button', { type: 'submit' }, 'Register team'),
    msg,
  );
  show(el('div', { class: 'card narrow' }, form));
}

// ---------- Public page: published results ----------
async function renderPublicResults() {
  renderHeader();
  show(el('p', { class: 'muted' }, 'Loading…'));
  const res = await db.rpc('public_results');
  if (res.error) return show(el('div', { class: 'card narrow' }, el('p', { class: 'error' }, res.error.message)));
  const data = res.data;
  if (!data.published) {
    return show(el('div', { class: 'card narrow' },
      el('h2', {}, 'Results'),
      el('p', {}, 'The results are not released yet. Please check again after the panel publishes them.'),
      el('button', { class: 'secondary', onclick: renderPublicResults }, 'Refresh'),
    ));
  }
  const sections = data.sections || [];
  const head = el('tr', {},
    el('th', {}, 'Team'),
    sections.map((s) => el('th', { class: 'num', title: s.name }, 'Sec ' + s.id + ' %')),
    el('th', { class: 'num' }, 'Rubric average %'),
    el('th', { class: 'num' }, 'Group grade'),
    el('th', {}, 'Members (individual grade)'),
  );
  const rows = data.teams.map((t) => el('tr', {},
    el('td', {}, el('strong', {}, t.name), el('div', { class: 'member-line' }, t.project_title || '')),
    sections.map((s) => el('td', { class: 'num' }, pct(t.sections[String(s.id)] ?? null))),
    el('td', { class: 'num' }, el('strong', {}, pct(t.rubric_average))),
    el('td', { class: 'num' }, pct(t.group_grade)),
    el('td', {}, t.members.map((m) => el('div', { class: 'member-line' }, `${m.name}: ${pct(m.grade)}`))),
  ));
  show(
    el('div', { class: 'card' },
      el('div', { class: 'row' }, el('h2', {}, 'Defense results'), el('span', { class: 'spacer' }),
        el('button', { class: 'secondary', onclick: renderPublicResults }, 'Refresh')),
      el('p', { class: 'muted' }, sections.map((s) => `Section ${s.id}: ${s.name}`).join(' · ')),
    ),
    el('div', { class: 'card table-wrap' },
      data.teams.length ? el('table', {}, el('thead', {}, head), el('tbody', {}, rows)) : el('p', { class: 'muted' }, 'No teams yet.'),
    ),
    data.teams.filter((t) => (t.comments || []).length).map((t) => el('div', { class: 'card' },
      el('h3', {}, 'Panel comments for ' + t.name),
      t.comments.map((c) => el('div', { class: 'comment' },
        el('div', { class: 'member-line' }, c.section ? 'Section ' + c.section + ' panelist' : 'Panelist'),
        el('p', {}, c.text),
      )),
    )),
  );
}

// ---------- Start ----------
async function start() {
  const { data } = await db.auth.getSession();
  state.user = data.session?.user || null;
  // Public pages work for everyone, signed in or not
  if (location.hash === '#/register' || location.hash === '#/results') {
    if (state.user && !state.profile) {
      state.profile = (await db.from('profiles').select('*').eq('id', state.user.id).single()).data || null;
    }
    return guard(() => (location.hash === '#/register' ? renderRegister() : renderPublicResults()));
  }
  if (!state.user) return renderAuth();
  await guard(async () => {
    state.profile = check(await db.from('profiles').select('*').eq('id', state.user.id).single());
    const view = state.profile.role === 'admin' ? 'results' : (state.profile.section_id ? 'grade' : 'waiting');
    await go(state.view && state.view !== 'waiting' ? state.view : view);
  });
}

db.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') {
    state.view = null;
    setTimeout(start, 0);
  }
});
window.addEventListener('hashchange', start);
start();
