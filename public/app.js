// LifeCycle browser UI. Renders what /api/roadmap returns; never computes status itself.
const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Links from shared data or other services: http(s), mailto and in-app links only (never javascript:).
const escUrl = (v) => esc(safeUrl(v));
const safeUrl = (v) => { const s = String(v ?? '').trim(); return /^(https?:\/\/|mailto:|#|\/(?!\/))/i.test(s) ? s : '#'; };

const LABEL = {
  done: 'Done', flowing: 'Flowing', blocked: 'Blocked', unavailable: 'Status unavailable', not_started: 'Not started',
  in_progress: 'In progress', no_access: 'No access', not_done: 'Not done', unknown: 'Unknown',
};
const ORDER = ['blocked', 'unavailable', 'flowing', 'not_started', 'done'];
// Words for what LifeCycle tracks (docs/terminology.md): a project groups features; a feature is
// something users can notice or use, delivered in weeks; a step is a stage of a feature; a task is
// one PR or issue linked to a step. Counts and lists only ever count features.
const featuresLabel = (list) => plural(list.length, 'feature');
const badge = (state) => `<span class="badge st-${esc(state)}"><span class="dot" aria-hidden="true"></span>${esc(LABEL[state] || state)}</span>`;
const time = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'never');
const ago = (iso) => {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });
};
const href = (id) => `#/feature/${encodeURIComponent(id)}`;

// Initials + a stable color per owner, so the same person reads the same everywhere.
const AV_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--primary)'];
function avatar(owner, size = '') {
  const clean = String(owner || '?').replace(/^@/, '');
  const words = clean.split(/[\s._-]+/).filter(Boolean);
  const initials = (words.length > 1 ? words[0][0] + words[1][0] : clean.slice(0, 2)).toUpperCase();
  let h = 0;
  for (const ch of clean) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `<span class="av ${size}" style="--c:${AV_COLORS[h % AV_COLORS.length]}" aria-hidden="true">${esc(initials)}</span>`;
}
const who = (owner) => `<span class="who">${avatar(owner)}<span class="n">${esc(owner)}</span></span>`;

let snapshot = null;
let filter = null;
// Teams defined in LifeCycle-Data (/api/team-definitions), the open team form and delete flow, and
// the chat's proposed actions (Confirm / Cancel) by action id.
let teamDefs = null;
let teamForm = null;   // { mode, id, draft, base_hash, preview, errors, result, busy }
let teamDelete = null; // { id, step: 'ask'|'decide'|'confirm_unowned'|'done', affected, handover, result, busy }
const chatActions = new Map(); // action id -> { busy, result }

async function load() {
  const btn = $('#refresh');
  const pill = $('#sync-status');
  btn.disabled = true;
  pill.className = 'sync-pill busy';
  const started = performance.now();
  pill.innerHTML = `<span class="f-lattice" aria-hidden="true">${'<i></i>'.repeat(9)}</span><span class="lbl">Reading live status <span class="f-secs">0.0s</span></span>`;
  const secs = setInterval(() => { const el = pill.querySelector('.f-secs'); if (el) el.textContent = `${((performance.now() - started) / 1000).toFixed(1)}s`; }, 100);
  try {
    const res = await fetch('/api/roadmap', { cache: 'no-store' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    snapshot = await res.json();
  } catch (err) {
    clearInterval(secs);
    pill.className = 'sync-pill stale';
    pill.innerHTML = `<span class="dot"></span><span class="lbl">Can't reach LifeCycle: ${esc(err.message)}</span>`;
    btn.disabled = false;
    return render();
  }
  clearInterval(secs);
  btn.disabled = false;
  render();
  tickSync();
  loadAlerts();
  loadEditAccess();
  loadTeamDefs();
}

// Which version of LifeCycle-Data is on screen: the commit (linked to GitHub when it is on GitHub)
// and when it was read. Never says "Live" for a saved copy or a clone that couldn't be pulled.
function commitHtml(d) {
  if (!d.commit) return '';
  const label = `<code>${esc(d.commit_short)}</code>`;
  return d.commit_url ? `<a href="${escUrl(d.commit_url)}" target="_blank" rel="noopener" title="LifeCycle-Data commit ${esc(d.commit)}">${label}</a>` : `<span title="commit ${esc(d.commit)}">${label}</span>`;
}

function tickSync() {
  if (!snapshot) return;
  const pill = $('#sync-status');
  const d = snapshot.definitions;
  const where = d.kind === 'local_clone' ? 'Local clone' : d.kind === 'local_folder' ? 'Local folder' : 'LifeCycle-Data';
  const what = d.stale ? (d.fallback === 'saved_copy' ? 'Saved copy' : 'Not pulled') : 'Live';
  const commit = commitHtml(d);
  const head = `${what} · ${where}${d.branch ? ` ${d.branch}` : ''}`;
  const read = `read ${ago(d.read_at || d.synced_at)}`;
  pill.className = `sync-pill${d.stale ? ' stale' : ''}`;
  pill.title = `${head}${d.commit ? ` @ ${d.commit_short}` : ''} · ${read}`;
  pill.innerHTML = `<span class="dot"></span><span class="lbl">${esc(head)}${commit ? ` @ ${commit}` : ''} · ${esc(read)}</span>`;
}
setInterval(tickSync, 30000);

// ---------- routing & chrome ----------

const pid = (id) => id ?? 'none';
const projHref = (id, tab) => `#/project/${encodeURIComponent(pid(id))}${tab ? `/${tab}` : ''}`;
const projectById = (id) => snapshot?.projects.find((p) => pid(p.project.id) === id);
const projectOfFeature = (fid) => snapshot?.projects.find((p) => p.features.includes(fid));
const projectName = (id) => snapshot?.projects.find((p) => p.project.id === id)?.project.name || 'No project';

function parseRoute() {
  const h = location.hash;
  let m;
  if ((m = h.match(/^#\/feature\/(.+)\/edit$/))) return { route: 'feature-edit', mode: 'update', id: decodeURIComponent(m[1]) };
  // #/features/new?project=<id>: the form starts with that project chosen (from a project's page).
  if ((m = h.match(/^#\/features\/new(?:\?project=([^&]+))?$/))) return { route: 'feature-edit', mode: 'create', id: null, project: m[1] ? decodeURIComponent(m[1]) : '' };
  if ((m = h.match(/^#\/feature\/(.+)$/))) return { route: 'feature', id: decodeURIComponent(m[1]) };
  if ((m = h.match(/^#\/project\/([^/]+)(?:\/(map))?$/))) return { route: 'project', id: decodeURIComponent(m[1]), tab: m[2] || 'features' };
  if (h === '#/projects/new') return { route: 'project-new' };
  if ((m = h.match(/^#\/project\/([^/]+)\/edit$/))) return { route: 'project-new', editId: decodeURIComponent(m[1]) };
  if (h === '#/roadmap') return { route: 'roadmap' };
  if (h === '#/map' || h.startsWith('#/map?')) return { route: 'map' };
  // The chat is a side panel now: an old Ask link opens it over Home.
  if (h === '#/ask') {
    setChatOpen(true, { render: false });
    history.replaceState(null, '', '#/');
    return { route: 'home' };
  }
  if (h === '#/alerts') return { route: 'alerts' };
  if (h === '#/teams') return { route: 'teams' };
  if (h === '#/apps') return { route: 'apps' };
  if (h === '#/apps/new') return { route: 'app-edit', id: null };
  if ((m = h.match(/^#\/app\/([^/]+)\/edit$/))) return { route: 'app-edit', id: decodeURIComponent(m[1]) };
  if (h === '#/teams/new') return { route: 'team-edit', mode: 'create', id: null };
  if ((m = h.match(/^#\/team\/(.+)\/edit$/))) return { route: 'team-edit', mode: 'update', id: decodeURIComponent(m[1]) };
  if ((m = h.match(/^#\/team\/(.+)$/))) return { route: 'team', id: decodeURIComponent(m[1]) };
  if (h === '#/alerts/new') return { route: 'change', mode: 'new' };
  if ((m = h.match(/^#\/alerts\/edit\/(.+)$/))) return { route: 'change', mode: 'edit', id: decodeURIComponent(m[1]) };
  return { route: 'home' };
}

// Which projects' feature lists are open in the sidebar, as the person left them (per browser).
const SIDE_TOGGLES = 'lifecycle-side-open';
function sideToggles() { try { return JSON.parse(localStorage.getItem(SIDE_TOGGLES) || '{}'); } catch { return {}; } }
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-side-toggle]');
  if (!btn) return;
  e.preventDefault();
  const li = btn.closest('.side-p');
  const open = !li.classList.contains('open');
  li.classList.toggle('open', open);
  btn.setAttribute('aria-expanded', String(open));
  const t = sideToggles(); t[btn.dataset.sideToggle] = open;
  try { localStorage.setItem(SIDE_TOGGLES, JSON.stringify(t)); } catch { /* private mode */ }
});

function renderChrome(r) {
  rememberProject(r);
  const navRoute = r.route === 'project' || r.route === 'feature' || (r.route === 'project-new' && r.editId) ? 'roadmap' : r.route === 'feature-edit' ? 'roadmap' : r.route === 'change' ? 'alerts' : r.route === 'team' || r.route === 'team-edit' ? 'teams' : r.route === 'app-edit' ? 'apps' : r.route;
  if (r.route === 'alerts') alertsAcknowledged = true;
  const unseenCount = alertView ? alertView.alerts.filter((a) => !isSeen(a)).length : 0;
  const nb = $('#alert-count');
  if (nb) { nb.textContent = unseenCount || ''; nb.hidden = !unseenCount; nb.setAttribute('aria-label', `${unseenCount} not seen`); }
  document.querySelectorAll('.nav a, .top-alerts').forEach((a) => (a.dataset.route === navRoute ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  const active = r.route === 'project' ? r.id : r.route === 'feature' ? pid(projectOfFeature(r.id)?.project.id) : null;
  const byId = new Map((snapshot?.features || []).map((f) => [f.feature.id, f]));
  const toggles = sideToggles();
  const sideItem = (p) => {
    const id = pid(p.project.id);
    const current = id === active;
    // Open: what the person chose with the arrow, else open only for the project being looked at.
    const open = toggles[id] ?? current;
    const feats = p.features.map((fid) => byId.get(fid)).filter(Boolean).sort((a, b) => a.feature.name.localeCompare(b.feature.name))
      .map((f) => `<li><a href="${href(f.feature.id)}" class="st-${f.state}" ${r.route === 'feature' && r.id === f.feature.id ? 'aria-current="page"' : ''}
        title="${esc(f.feature.name)}: ${esc(LABEL[f.state])}"><span class="dot"></span><span class="t">${esc(f.feature.name)}</span></a></li>`).join('');
    return `<li class="side-p${open ? ' open' : ''}" data-side-proj="${esc(id)}"><div class="side-prow">
      ${feats ? `<button type="button" class="side-tog" data-side-toggle="${esc(id)}" aria-expanded="${open}" aria-label="${open ? 'Hide' : 'Show'} the features of ${esc(p.project.name)}"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8 5l5 5-5 5"/></svg></button>` : '<span class="side-tog-sp"></span>'}
      <a href="${projHref(p.project.id)}" class="proj st-${p.state}" ${current && r.route === 'project' ? 'aria-current="page"' : ''} ${current ? 'data-open' : ''}
      title="${esc(p.project.name)}: ${esc(LABEL[p.state])} · ${esc(featuresLabel(p.features.map((fid) => byId.get(fid)).filter(Boolean)))}"><span class="dot"></span><span class="t">${esc(p.project.name)}</span><span class="cnt">${p.features.length}</span></a></div>
      ${feats ? `<ul class="sub">${feats}</ul>` : ''}</li>`;
  };
  const sideAll = snapshot?.projects || [];
  const sideArch = sideAll.filter((p) => isArchived(p.project.id));
  $('#side-features').innerHTML = sideAll.filter((p) => !isArchived(p.project.id)).map(sideItem).join('')
    + (sideArch.length ? `<li class="side-arch"><details${sideArch.some((p) => pid(p.project.id) === active) ? ' open' : ''}><summary>Archived <span class="cnt">${sideArch.length}</span></summary><ul>${sideArch.map(sideItem).join('')}</ul></details></li>` : '')
    + '<li class="side-new"><a href="#/projects/new" data-route="project-new"' + (r.route === 'project-new' && !r.editId ? ' aria-current="page"' : '') + '><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4.5v11M4.5 10h11"/></svg><span class="t">New project</span></a></li>';

  const sep = '<span aria-hidden="true">/</span>';
  const crumbProject = (id) => `<a href="${projHref(id)}">${esc(projectById(pid(id))?.project.name || 'No project')}</a>`;
  let crumbs;
  if (r.route === 'feature') {
    const f = snapshot?.features.find((x) => x.feature.id === r.id);
    const p = projectOfFeature(r.id);
    crumbs = `<a href="#/roadmap">Roadmap</a>${sep}${p ? `${crumbProject(p.project.id)}${sep}` : ''}<span class="cur">${esc(f?.feature.name || r.id)}</span>`;
  } else if (r.route === 'feature-edit') {
    const f = snapshot?.features.find((x) => x.feature.id === r.id);
    crumbs = r.mode === 'create' ? `<a href="#/roadmap">Roadmap</a>${sep}${r.project ? `${crumbProject(r.project)}${sep}` : ''}<span class="cur">New feature</span>`
      : `<a href="#/roadmap">Roadmap</a>${sep}<a href="${href(r.id)}">${esc(f?.feature.name || r.id)}</a>${sep}<span class="cur">Edit</span>`;
  } else if (r.route === 'project-new' && r.editId) {
    crumbs = `<a href="#/roadmap">Roadmap</a>${sep}${crumbProject(r.editId)}${sep}<span class="cur">Edit</span>`;
  } else if (r.route === 'app-edit') {
    crumbs = `<a href="#/apps">Apps</a>${sep}<span class="cur">${r.id ? `${esc(appById(r.id)?.name || r.id)} · Edit` : 'New app'}</span>`;
  } else if (r.route === 'project') {
    crumbs = `<a href="#/roadmap">Roadmap</a>${sep}<span class="cur">${esc(projectById(r.id)?.project.name || r.id)}</span>`;
  } else {
    crumbs = r.route === 'change'
      ? `<a href="#/alerts">Alerts</a>${sep}<span class="cur">${r.mode === 'edit' ? 'Update a change' : 'Register a change'}</span>`
      : r.route === 'team-edit'
        ? `<a href="#/teams">Teams</a>${sep}${r.mode === 'create' ? '<span class="cur">New team</span>' : `<a href="#/team/${encodeURIComponent(r.id)}">${esc(teamName(r.id))}</a>${sep}<span class="cur">Edit</span>`}`
      : r.route === 'team'
        ? `<a href="#/teams">Teams</a>${sep}<span class="cur">${esc(teamName(r.id))}</span>`
        : `<span class="cur">${{ home: 'Home', roadmap: 'Roadmap', map: 'Dependency map', ask: 'Ask', alerts: 'Alerts', teams: 'Teams', 'project-new': 'New project', apps: 'Apps' }[r.route]}</span>`;
  }
  // No breadcrumb bar: the trail only names the browser tab.
  const trail = document.createElement('div');
  trail.innerHTML = crumbs;
  const cur = trail.querySelector('.cur')?.textContent.trim();
  document.title = cur ? `${cur} · LifeCycle` : 'LifeCycle';
}

function renderBanners(r) {
  if (!snapshot) return '';
  const out = [];
  const d = snapshot.definitions;
  // What version of LifeCycle-Data this is, whenever it isn't simply the latest from GitHub.
  if (d.notice) {
    const warn = d.notice.level === 'warning';
    const commit = commitHtml(d);
    const which = commit ? `Commit ${commit}, ${d.fallback === 'saved_copy' ? 'read' : d.kind === 'local_clone' ? 'pulled' : 'read'} ${esc(time(d.read_at))}.` : d.read_at ? `Read ${esc(time(d.read_at))}.` : '';
    out.push(`<div class="banner ${warn ? 'st-unavailable' : 'st-flowing'}" role="${warn ? 'alert' : 'status'}"><span class="ico">${warn ? '!' : 'i'}</span><div><b>${esc(d.notice.title)}.</b>
      ${which} ${esc(d.notice.reason)}.</div></div>`);
  }
  if (snapshot.invalid_definitions.length) {
    out.push(`<div class="banner st-blocked"><span class="ico">×</span><div><b>${snapshot.invalid_definitions.length} problem${snapshot.invalid_definitions.length > 1 ? 's' : ''} in the shared feature definitions.</b>
      Those features are hidden; everything else is unaffected.
      <ul>${snapshot.invalid_definitions.map((e) => `<li><code>${esc(e.file)}</code> · <code>${esc(e.field)}</code> ${esc(e.message)}</li>`).join('')}</ul></div></div>`);
  }
  // One-time notices (e.g. flags now read from the team's platform): shown until "Got it".
  for (const n of snapshot.notices || []) {
    out.push(`<div class="banner st-flowing" role="status"><span class="ico">i</span><div><b>${esc(n.title)}.</b> ${esc(n.message)}
      <div><button type="button" class="btn" data-notice="${esc(n.id)}">Got it</button></div></div></div>`);
  }
  const access = new Map();
  // Access problems only for what is on screen: one feature, one project, or everything.
  const inView = r.route === 'feature' ? [r.id] : r.route === 'project' ? projectById(r.id)?.features || [] : null;
  const fsrc = snapshot.flag_source;
  const shown = snapshot.features.filter((f) => !inView || inView.includes(f.feature.id));
  const flagged = shown.filter((f) => f.last_mile?.flags?.length).map((f) => f.feature.name);
  // The flag source's own problem gets one banner of its own, naming the configured platform; its
  // lines then aren't repeated under "Missing access". Without that banner (e.g. a feature with
  // Statsig experiments but no flags) they stay in "Missing access".
  const flagBanner = fsrc?.state === 'problem' && flagged.length > 0;
  for (const f of shown) {
    for (const p of f.access_problems) access.set(p.message, f.feature.name);
    // Same platform and same fix (e.g. "no Statsig key" for flags and for experiments): one banner is enough.
    for (const p of f.last_mile?.access_problems || []) if (!(flagBanner && p.source === fsrc.platform && fixOf(p.message) === fixOf(fsrc.message))) access.set(p.message, f.feature.name);
  }
  if (flagBanner) out.push(flagSourceBanner(fsrc, flagged));
  if (fsrc?.state === 'snapshot' && flagged.length > 0) out.push(flagSnapshotBanner(fsrc));
  if (access.size) {
    out.push(`<div class="banner st-no_access"><span class="ico">!</span><div><b>Missing access.</b> Your credentials can't read some sources, so what depends on them shows as status unavailable.
      <ul>${[...access].map(([m, name]) => `<li>${esc(m)} <span class="muted">· ${esc(name)}</span></li>`).join('')}</ul></div></div>`);
  }
  if (featureFlash && featureFlash.hash !== location.hash) featureFlash = null;
  return (featureFlash?.html || '') + out.join('') + alertBanners();
}

// The flag platform can't be read live here, but every flag has a team snapshot: an information
// banner (not a problem), with how old the snapshot is and how to get live flag status.
function flagSnapshotBanner(src) {
  const why = (FLAG_PROBLEM[src.reason] || ((n) => `${n} can't be read`))(src.name);
  return `<div class="banner st-flowing" role="status" data-flag-snapshot="${esc(src.platform)}"><span class="ico">i</span><div>
    <b>Flags from the team snapshot.</b> ${esc(why)}, so flags show what a teammate's LifeCycle last read from ${esc(src.name)} and shared in the data repo
    (oldest read <b>${esc(ago(src.snapshot_read_at))}</b>).
    <div class="muted">${esc(src.message || '')}</div></div></div>`;
}

// The configured flag platform (Statsig or Flagsmith) can't be read: what's wrong and the exact fix.
// Only the configured platform is ever named. Nothing is shown when it reads fine.
const FLAG_PROBLEM = {
  no_credential: (n) => `No ${n} key is set up on this machine`,
  wrong_key_type: (n) => `Wrong kind of ${n} key`,
  rejected: (n) => `${n} refused your key`,
  no_access: (n) => `Your ${n} key can't read the flags`,
  missing_project: (n) => `No ${n} project is chosen`,
  missing_environment: (n) => `${n} environment not found`,
  unreachable: (n) => `${n} can't be reached`,
  disabled: (n) => `${n} is turned off in your config`,
};
const fixOf = (m) => String(m || '').split('Fix:')[1]?.trim() || String(m || '');
function flagSourceBanner(src, features) {
  const title = (FLAG_PROBLEM[src.reason] || ((n) => `${n} can't be read`))(src.name);
  const down = src.reason === 'unreachable';
  const last = `Last successful read from ${esc(src.name)}: <b>${src.last_successful_read_at ? esc(time(src.last_successful_read_at)) : 'never on this machine'}</b>.`;
  return `<div class="banner ${down ? 'st-unavailable' : 'st-no_access'}" role="alert" data-flag-source="${esc(src.platform)}"><span class="ico">!</span><div>
    <b>${down ? '' : 'Missing access · '}${esc(title)}.</b> ${esc(src.message || '')} ${last}
    <div class="muted">Flag status shows as unavailable for ${esc(features.slice(0, 4).join(', '))}${features.length > 4 ? ` and ${features.length - 4} more` : ''}.</div></div></div>`;
}

function render() {
  const r = parseRoute();
  const focusKey = document.activeElement?.dataset?.fk;
  renderChrome(r);
  $('#banners').innerHTML = renderBanners(r);
  $('#banners').querySelectorAll('[data-notice]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    await fetch(`/api/notices/${encodeURIComponent(b.dataset.notice)}/seen`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => null);
    snapshot.notices = (snapshot.notices || []).filter((x) => x.id !== b.dataset.notice);
    render();
  }));
  const main = $('#main');
  if (!snapshot) {
    main.innerHTML = '<div class="card empty"><strong>No data yet</strong>Check that LifeCycle is running, then press Refresh.</div>';
    renderChatDock();
    return;
  }
  main.innerHTML = {
    feature: () => renderFeatureFlow(r.id),
    roadmap: () => renderRoadmap(),
    project: () => renderProject(r.id, r.tab),
    map: () => renderMap(),
    alerts: () => renderAlertsFlow(),
    teams: () => renderTeamsFlow(),
    apps: () => renderApps(),
    'app-edit': () => renderAppEdit(r.id),
    team: () => renderTeam(r.id),
    'team-edit': () => renderTeamEdit(r.mode, r.id),
    'project-new': () => renderProjectNew(r.editId || null),
    change: () => renderChangeForm(r.mode, r.id || null),
    'feature-edit': () => renderFeatureEdit(r.mode, r.id, r.project),
    home: () => renderHome(),
  }[r.route]();
  if (r.route !== 'change') changeForm = null;
  if (r.route !== 'feature-edit') featureEdit = null;
  if (r.route === 'feature-edit') wireFeatureEdit(main);
  if (r.route === 'feature') wireFeatureOutbox(main);
  wireAlerts(main);
  fitNodeText(main);
  wireAsk(main);
  if (r.route === 'feature') wireFeatureFlow(r);
  if (r.route === 'teams') wireTeamsFlow(main);
  if (r.route === 'app-edit') wireAppEdit(main);
  if (r.route !== 'app-edit') appForm = null;
  if (r.route === 'project-new') wireProjectNew(main);
  if (r.route !== 'project-new') projectForm = null;
  if (r.route !== 'team-edit') teamForm = null;
  if (r.route !== 'team' || teamDelete?.id !== r.id) teamDelete = null;
  wireTeams(main);
  if (r.route === 'alerts') wireAlertsFlow(main);
  countUp(main, `${r.route}:${r.id || ''}`);
  restoreView(main, focusKey);
  for (const c of main.querySelectorAll('.canvas')) { applyMapHighlight(c); applyZoom(c); }
  if (r.route === 'map') syncMapHash();
  main.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
    filter = filter === b.dataset.filter ? null : b.dataset.filter;
    render();
    $(`[data-filter="${b.dataset.filter}"]`)?.focus();
  }));
  renderChatDock();
}

// ---------- projects ----------

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function renderProject(id, tab) {
  const p = projectById(id);
  if (!p) return `<p class="kicker">Project</p><h1 class="mono">${esc(id)}</h1><div class="card empty section"><strong>Not defined</strong>No project with this id exists in the shared repo.</div>`;
  const fs = snapshot.features.filter((f) => p.features.includes(f.feature.id));
  const byId = new Map(snapshot.features.map((f) => [f.feature.id, f]));
  const outsideList = (list, title) => (list.length ? `<div class="card deps"><div class="h">${title}</div><ul>${list.map((d) => {
    const f = byId.get(d.id);
    return `<li><a href="${href(d.id)}"><span>${esc(f?.feature.name || d.id)} <span class="muted">· ${esc(projectName(d.project))}</span></span>${badge(f?.state || 'unknown')}</a></li>`;
  }).join('')}</ul></div>` : '');
  const outside = outsideList(p.depends_on_outside.filter((d) => d.project !== undefined), 'Depends on, in other projects')
    + outsideList(p.depended_on_from_outside, 'Depended on by, in other projects');
  const body = !fs.length
    ? `<div class="card empty"><strong>No features in this project yet</strong>${editAccess?.can_edit && p.project.id ? 'Add one with <b>New feature</b>, or choose this project when you edit a feature.' : `Add <code>project: ${esc(pid(p.project.id))}</code> to a feature in the shared repo.`}</div>`
    : tab === 'map'
      ? `${mapSvg(p.features, null, { external: true })}${legend(true)}`
      : `${featureList(fs)}${outside ? `<div class="section"><h2>Outside this project</h2><div class="cols2">${outside}</div></div>` : ''}`;
  return `<p class="kicker">Project</p>
    <div class="fhead"><h1>${esc(p.project.name)}</h1>${badge(p.state)}${archiveButton(p, { suggest: allDone(p) })}${editAccess?.can_edit && p.project.id ? `<a class="btn small" href="#/project/${encodeURIComponent(p.project.id)}/edit">Edit project</a><button type="button" class="btn small danger" data-project-delete="${esc(p.project.id)}">Delete project</button>${newFeatureButton(p.project.id)}` : ''}</div>
    ${isArchived(p.project.id) ? '<p class="arch-note">Archived for you: it no longer shows in your Roadmap or Home. Everything here is still live, and you can ask about it in Ask.</p>' : ''}
    ${p.project.description ? `<p class="lede">${esc(p.project.description)}</p>` : ''}
    <div class="facts">
      ${p.project.owner ? `<div class="fact"><span class="k">Owner</span>${who(p.project.owner)}</div>` : ''}
      ${projectDue(p, fs.map((f) => f.feature.target_date).filter(Boolean).sort()) ? `<div class="fact"><span class="k">Due</span><span>${esc(fmtDay(projectDue(p, fs.map((f) => f.feature.target_date).filter(Boolean).sort())))}</span></div>` : ''}
      <div class="fact"><span class="k">Contains</span><span>${esc(featuresLabel(fs))}</span></div>
      ${p.project.file ? `<div class="fact"><span class="k">Defined in</span><span class="mono">${esc(p.project.file)}</span></div>` : ''}
    </div>
    <nav class="tabs" aria-label="Project views">
      <a href="${projHref(p.project.id)}" ${tab !== 'map' ? 'aria-current="page"' : ''}>Features</a>
      <a href="${projHref(p.project.id, 'map')}" ${tab === 'map' ? 'aria-current="page"' : ''}>Map</a>
    </nav>
    ${body}`;
}

// ---------- feature lists ----------

function pathCell(f) {
  if (!f.steps.length) return '<div class="path"><div class="segs"><span class="seg st-not_started"></span></div><span class="label">No steps defined yet</span></div>';
  const done = f.steps.filter((s) => s.state === 'done').length;
  const cur = f.steps.find((s) => s.id === f.current_step);
  const segs = f.steps.map((s) => `<span class="seg st-${s.state}${s.id === f.current_step ? ' cur' : ''}" title="${esc(s.name)}: ${esc(LABEL[s.state])}"></span>`).join('');
  const label = cur
    ? `<b>${esc(cur.name)}</b> · ${done}/${f.steps.length} done${cur.linked_work ? '' : ' · no tasks linked'}`
    : f.steps.length === 1 ? 'Step done' : `All ${f.steps.length} steps done`;
  return `<div class="path" aria-label="${done} of ${f.steps.length} steps done"><div class="segs">${segs}</div><span class="label">${label}</span></div>`;
}

function pushCell(f) {
  if (f.state === 'unavailable') return `<div class="clear">${badge('unavailable')}<span>Can't confirm, a source can't be read</span></div>`;
  const b = f.blockers[0];
  if (!b) return f.state === 'done' ? '<div class="clear">Shipped. Nothing pending.</div>' : '<div class="clear">Nothing blocking</div>';
  const more = f.blockers.length > 1 ? ` +${f.blockers.length - 1} more` : '';
  const what = b.kind === 'dependency'
    ? `${b.feature_name}${b.step_name ? ` → ${b.step_name}` : ''}`
    : { circular_dependency: 'Circular dependency', unknown_dependency: `Unknown dependency "${b.feature}"`, invalid_dependency: `Invalid dependency "${b.feature}"` }[b.kind];
  return `<div class="push">${avatar(b.owner)}<div class="txt"><span class="k">Push</span><span class="v">${esc(b.owner)}</span>
    <span class="why">${esc(what)}${esc(more)}</span></div></div>`;
}

function featureList(fs, { showProject = false } = {}) {
  const counts = Object.fromEntries(ORDER.map((s) => [s, fs.filter((f) => f.state === s).length]));
  const chips = ORDER.filter((s) => counts[s]).map((s) => `<button type="button" class="chip st-${s}" data-filter="${s}" aria-pressed="${filter === s}">
    <span class="dot"></span>${esc(LABEL[s])}<span class="count">${counts[s]}</span></button>`).join('');
  const shown = fs.filter((f) => !filter || f.state === filter)
    .sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || a.feature.name.localeCompare(b.feature.name));
  const rows = shown.map((f) => `<a class="card frow st-${f.state}" href="${href(f.feature.id)}">
      <div class="title"><span class="name">${esc(f.feature.name)}</span>
        <span class="meta">${badge(f.state)}${who(f.feature.owner)}${f.feature.target_date ? `<span>Due ${esc(f.feature.target_date)}</span>` : ''}
        ${showProject ? `<span class="ptag">${esc(projectName(projectOfFeature(f.feature.id)?.project.id ?? null))}</span>` : ''}
        ${f.warnings.length ? `<span class="warn">⚠ ${f.warnings.length} warning${f.warnings.length > 1 ? 's' : ''}</span>` : ''}</span></div>
      ${pathCell(f)}
      ${pushCell(f)}
    </a>`).join('');
  return `<div class="filters" role="group" aria-label="Filter by state">${chips}</div>
    <div class="features">${rows || '<div class="card empty">No features in this state.</div>'}</div>`;
}

// ---------- new project: commits projects/<id>.yaml under the person's GitHub user ----------

let projectForm = null; // { editId, draft: { name, id, owner, description }, base, idTouched, errors, result, busy }

// editId: edit that project (name, owner, description; the id stays) instead of creating one.
function renderProjectNew(editId = null) {
  if (projectForm && projectForm.editId !== editId) projectForm = null;
  if (!projectForm) {
    const p = editId ? projectById(editId) : null;
    if (editId && !p) return `<p class="kicker">Project</p><h1 class="mono">${esc(editId)}</h1><div class="card empty section"><strong>Not defined</strong>No project with this id exists in the shared repo.</div>`;
    const draft = p ? { name: p.project.name || '', id: p.project.id, owner: p.project.owner || '', description: p.project.description || '' } : { name: '', id: '', owner: '', description: '' };
    projectForm = { editId, draft, base: p ? { ...draft } : null, idTouched: Boolean(p), errors: [], result: null, busy: false };
  }
  const f = projectForm, d = f.draft;
  if (editId) return renderProjectEdit(f, d);
  const target = snapshot.definitions.source.startsWith('local:') ? 'the local data folder' : `the shared repo (${esc(snapshot.definitions.source.replace(/^github:/, '').replace(/@.*$/, ''))})`;
  const err = (field) => (f.errors || []).filter((e) => e.field === field).map((e) => `<p class="ferr" role="alert">${esc(e.message)}</p>`).join('');
  const bad = (field) => ((f.errors || []).some((e) => e.field === field) ? ' aria-invalid="true"' : '');
  if (editAccess && !editAccess.can_edit) {
    return `<p class="kicker">Projects</p><h1>New project</h1>
      <div class="banner st-unavailable section" role="status"><span class="ico">!</span><div><b>You can't create projects.</b> ${esc(editAccess.reason || '')}</div></div>`;
  }
  return `<p class="kicker">Projects</p><h1>New project</h1>
    <p class="lede">Creating it ${snapshot.definitions.source.startsWith('local:') ? 'saves' : 'commits'} <code>projects/${esc(d.id || '<id>')}.yaml</code> to ${target}${snapshot.definitions.source.startsWith('local:') ? '' : ' as your GitHub user'}. Add features to it with <b>New feature</b> on its page.</p>
    ${f.result ? `<div class="banner st-blocked section" role="alert"><span class="ico">!</span><div>${esc(f.result.message || '')}</div></div>` : ''}
    <form id="projectform" class="cform section" novalidate><div class="card fbox">
      <label>Name <span class="req">required</span><input name="name" value="${esc(d.name)}" placeholder="Redeem rewards" autocomplete="off"${bad('name')}></label>${err('name')}
      <label>Id <span class="muted small">names the file and can't be changed later: lowercase letters, digits and dashes</span><input name="id" class="mono" value="${esc(d.id)}" placeholder="redeem-rewards"${bad('id')}></label>${err('id')}
      <label>Owner <span class="muted small">optional</span><input name="owner" value="${esc(d.owner)}" placeholder="Catalog team or @handle"${bad('owner')}></label>${err('owner')}
      <label>Description <span class="muted small">optional</span><textarea name="description" rows="2"${bad('description')}>${esc(d.description)}</textarea></label>${err('description')}
      <div class="factions"><button class="btn primary" type="submit"${f.busy ? ' disabled' : ''}>${f.busy ? 'Creating…' : 'Create project'}</button><a class="btn" href="#/roadmap">Cancel</a></div>
    </div></form>`;
}

function renderProjectEdit(f, d) {
  const err = (field) => (f.errors || []).filter((e) => e.field === field).map((e) => `<p class="ferr" role="alert">${esc(e.message)}</p>`).join('');
  const bad = (field) => ((f.errors || []).some((e) => e.field === field) ? ' aria-invalid="true"' : '');
  const local = snapshot.definitions.source.startsWith('local:');
  const back = projHref(f.editId);
  if (editAccess && !editAccess.can_edit) {
    return `<p class="kicker">Edit project</p><h1>${esc(f.base.name)}</h1>
      <div class="banner st-unavailable section" role="status"><span class="ico">!</span><div><b>You can't edit projects.</b> ${esc(editAccess.reason || '')}</div></div>`;
  }
  return `<p class="kicker">Edit project</p><h1>${esc(f.base.name)}</h1>
    <p class="lede">Saving ${local ? 'saves' : 'commits'} <code>${esc(projectById(f.editId)?.project.file || `projects/${f.editId}.yaml`)}</code>${local ? '' : ' as your GitHub user'}. The id (<code>${esc(f.editId)}</code>) stays the same, so its features stay in it.</p>
    ${f.result ? `<div class="banner st-blocked section" role="alert"><span class="ico">!</span><div>${esc(f.result.message || '')}</div></div>` : ''}
    <form id="projectform" class="cform section" novalidate><div class="card fbox">
      <label>Name <span class="req">required</span><input name="name" value="${esc(d.name)}" autocomplete="off"${bad('name')}></label>${err('name')}
      <label>Owner <span class="muted small">optional</span><input name="owner" value="${esc(d.owner)}" placeholder="Catalog team or @handle"${bad('owner')}></label>${err('owner')}
      <label>Description <span class="muted small">optional</span><textarea name="description" rows="2"${bad('description')}>${esc(d.description)}</textarea></label>${err('description')}
      <div class="factions"><button class="btn primary" type="submit"${f.busy ? ' disabled' : ''}>${f.busy ? 'Saving…' : 'Save'}</button><a class="btn" href="${back}">Cancel</a></div>
    </div></form>`;
}

function wireProjectNew(root) {
  const form = root.querySelector('#projectform');
  if (!form) return;
  const f = projectForm;
  if (f.editId) return wireProjectEdit(form, f);
  const sync = () => {
    const v = (n) => form.querySelector(`[name="${n}"]`).value;
    f.draft = { name: v('name'), id: v('id'), owner: v('owner'), description: v('description') };
  };
  form.querySelector('[name="name"]').addEventListener('input', () => {
    if (f.idTouched) return;
    form.querySelector('[name="id"]').value = slugify(form.querySelector('[name="name"]').value);
  });
  form.querySelector('[name="id"]').addEventListener('input', () => { f.idTouched = true; });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    sync();
    f.busy = true; f.errors = []; f.result = null;
    render();
    const r = await sendFeature('/api/projects', 'POST', { draft: f.draft });
    f.busy = false;
    if (r.outcome === 'published') {
      projectForm = null;
      await load();
      toast(r.message);
      location.hash = projHref(r.id);
      return;
    }
    f.errors = r.errors || [];
    f.result = r;
    render();
    $('#main [aria-invalid="true"]')?.focus();
  });
}

function wireProjectEdit(form, f) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = (n) => form.querySelector(`[name="${n}"]`).value;
    f.draft = { ...f.draft, name: v('name'), owner: v('owner'), description: v('description') };
    f.busy = true; f.errors = []; f.result = null;
    render();
    const r = await sendFeature(`/api/projects/${encodeURIComponent(f.editId)}`, 'PUT', { draft: f.draft, base: f.base });
    f.busy = false;
    if (r.outcome === 'published' || r.outcome === 'unchanged') {
      const id = f.editId;
      projectForm = null;
      if (r.outcome === 'published') await load();
      toast(r.message);
      location.hash = projHref(id);
      return;
    }
    f.errors = r.errors || [];
    f.result = r;
    render();
    $('#main [aria-invalid="true"]')?.focus();
  });
}

// ---------- mobile apps: apps/<id>.yaml (stores and Slack release channel) ----------

const appById = (id) => snapshot?.apps?.find((a) => a.id === id) || null;
let appForm = null; // { id (null = new), draft, base, idTouched, errors, result, busy }
const APP_FIELDS = ['name', 'owner', 'repo', 'release_tag', 'ios_store_id', 'android_store_id', 'slack', 'hint'];
const appDraftOf = (a) => ({ id: a.id, name: a.name || '', owner: a.owner || '', repo: a.repo || '', release_tag: a.release_tag || '',
  ios_store_id: a.platforms?.ios?.store_id || '', android_store_id: a.platforms?.android?.store_id || '',
  slack: a.release_channel?.slack || '', hint: a.release_channel?.hint || '' });

function renderApps() {
  const apps = [...(snapshot.apps || [])].sort((a, b) => a.name.localeCompare(b.name));
  const action = editAccess?.can_edit ? '<a class="btn primary" href="#/apps/new">New app</a>'
    : editAccess ? `<p class="muted small f-ro" role="note"><b>Read-only.</b> ${esc(editAccess.reason || '')}</p>` : '';
  const featName = (id) => snapshot.features.find((f) => f.feature.id === id)?.feature.name || id;
  const card = (a) => `<li class="card team-def"><div class="f-cardh"><h3>${esc(a.name)}</h3><span class="f-src mono">${esc(a.id)}</span>
      ${editAccess?.can_edit ? `<a class="btn small" href="#/app/${encodeURIComponent(a.id)}/edit">Edit</a>` : ''}</div>
    <p class="small">${[a.platforms?.ios ? `iOS <span class="mono">${esc(a.platforms.ios.store_id)}</span>` : '', a.platforms?.android ? `Android <span class="mono">${esc(a.platforms.android.store_id)}</span>` : ''].filter(Boolean).join(' · ')}</p>
    <p class="muted small">${a.release_channel?.slack ? `Releases announced in <span class="mono">${esc(a.release_channel.slack)}</span>` : 'No Slack release channel'}${a.owner ? ` · ${esc(a.owner)}` : ''} · <span class="mono">${esc(a.repo)}</span></p>
    <p class="muted small">${a.features.length ? `Shipped by ${a.features.map((id) => `<a href="${href(id)}">${esc(featName(id))}</a>`).join(', ')}` : 'No feature lists it yet (apps: in a feature definition).'}</p></li>`;
  return `<div class="fhead"><div><p class="kicker">Mobile apps</p><h1>Apps</h1></div>${action}</div>
    <p class="lede">Where each app is published and the Slack channel where its releases are announced. LifeCycle reads the release status from the store, or from that channel on the machine that reads Slack. Each app is a file in the shared repo (<code>apps/&lt;id&gt;.yaml</code>).</p>
    ${apps.length ? `<ul class="team-grid section">${apps.map(card).join('')}</ul>` : '<div class="card empty section"><strong>No apps yet</strong>Add one with <b>New app</b> to follow its releases.</div>'}`;
}

function renderAppEdit(id) {
  if (appForm && appForm.id !== id) appForm = null;
  if (!appForm) {
    const a = id ? appById(id) : null;
    if (id && !a) return `<p class="kicker">App</p><h1 class="mono">${esc(id)}</h1><div class="card empty section"><strong>Not defined</strong>No app with this id exists in the shared repo. <a href="#/apps">All apps</a></div>`;
    const draft = a ? appDraftOf(a) : { id: '', name: '', owner: '', repo: '', release_tag: '', ios_store_id: '', android_store_id: '', slack: '', hint: '' };
    appForm = { id, draft, base: a ? { ...draft } : null, idTouched: Boolean(a), errors: [], result: null, busy: false };
  }
  const f = appForm, d = f.draft;
  const title = id ? esc(f.base.name || id) : 'New app';
  if (editAccess && !editAccess.can_edit) {
    return `<p class="kicker">Apps</p><h1>${title}</h1><div class="banner st-unavailable section" role="status"><span class="ico">!</span><div><b>You can't edit apps.</b> ${esc(editAccess.reason || '')}</div></div>`;
  }
  const err = (field) => (f.errors || []).filter((e) => e.field === field).map((e) => `<p class="ferr" role="alert">${esc(e.message)}</p>`).join('');
  const bad = (field) => ((f.errors || []).some((e) => e.field === field) ? ' aria-invalid="true"' : '');
  const input = (name, label, note, extra = '') => `<label>${label} ${note}<input name="${name}" value="${esc(d[name])}"${extra}${bad(name)}></label>${err(name)}`;
  const opt = '<span class="muted small">optional</span>';
  const local = snapshot.definitions.source.startsWith('local:');
  return `<p class="kicker">${id ? 'Edit app' : 'Apps'}</p><h1>${title}</h1>
    <p class="lede">${id ? 'Saving' : 'Creating it'} ${local ? 'saves' : 'commits'} <code>apps/${esc(id || d.id || '<id>')}.yaml</code>${local ? '' : ' as your GitHub user'}. Store ids are public identifiers, never keys: LifeCycle's store access is set up per machine (<code>lifecycle setup --extras</code>).</p>
    ${f.result ? `<div class="banner st-blocked section" role="alert"><span class="ico">!</span><div>${esc(f.result.message || '')}</div></div>` : ''}
    <form id="appform" class="cform section" novalidate><div class="card fbox">
      ${input('name', 'Name', '<span class="req">required</span>', ' placeholder="Reader" autocomplete="off"')}
      ${id ? '' : input('id', 'Id', '<span class="muted small">suggested from the name; names the file and can\'t be changed later</span>', ' class="mono" placeholder="reader-app"')}
      <div class="row3">${input('owner', 'Owner', opt, ' placeholder="Mobile team"')}${input('repo', 'Repo', '<span class="req">required</span>', ' class="mono" placeholder="your-org/reader-mobile"')}</div>
      <fieldset class="fld"><legend>Stores <span class="muted small">at least one</span></legend>
        <div class="row3">${input('ios_store_id', 'iOS: App Store id', '<span class="muted small">the Apple ID number in App Store Connect</span>', ' class="mono" placeholder="1234567890"')}
        ${input('android_store_id', 'Android: Google Play package', '', ' class="mono" placeholder="com.yourorg.reader"')}</div>
      </fieldset>
      ${input('release_tag', 'Release tags', '<span class="muted small">optional; how the repo names them, with {version}</span>', ' class="mono" placeholder="v{version}"')}
      <fieldset class="fld"><legend>Slack release channel <span class="muted small">optional; where a bot or people announce versions, reviews and rollouts</span></legend>
        ${input('slack', 'Channel', '<span class="muted small">#name or channel id</span>', ' class="mono" placeholder="#mobile-releases"')}
        <label>Hint for reading it ${opt}<textarea name="hint" rows="2" placeholder="iOS messages mention the App Store"${bad('hint')}>${esc(d.hint)}</textarea></label>${err('hint')}
        <p class="muted small">Read on the machine that reads Slack (<code>lifecycle setup --extras</code> → Slack); check it with <code>lifecycle slack-check --app ${esc(id || d.id || '<id>')}</code>.</p>
      </fieldset>
      <div class="factions"><button class="btn primary" type="submit"${f.busy ? ' disabled' : ''}>${f.busy ? 'Saving…' : id ? 'Save' : 'Create app'}</button><a class="btn" href="#/apps">Cancel</a>
        ${id ? `<button type="button" class="btn danger" data-app-delete${f.busy ? ' disabled' : ''}>Delete app</button>` : ''}</div>
    </div></form>`;
}

function wireAppEdit(root) {
  const form = root.querySelector('#appform');
  if (!form) return;
  const f = appForm;
  const read = () => {
    const v = (n) => form.querySelector(`[name="${n}"]`)?.value ?? '';
    f.draft = { ...Object.fromEntries(APP_FIELDS.map((k) => [k, v(k)])), id: f.id || v('id') };
  };
  if (!f.id) {
    const idField = form.querySelector('[name="id"]');
    form.querySelector('[name="name"]').addEventListener('input', (e) => { if (!f.idTouched) idField.value = slugify(e.target.value); });
    idField.addEventListener('input', () => { f.idTouched = idField.value.trim() !== ''; });
  }
  form.addEventListener('input', read);
  const done = async (r) => {
    f.busy = false;
    if (['published', 'unchanged'].includes(r.outcome)) {
      appForm = null;
      if (r.outcome === 'published') await load();
      toast(r.message);
      location.hash = '#/apps';
      return;
    }
    f.errors = r.errors || [];
    f.result = r;
    render();
    $('#main [aria-invalid="true"]')?.focus();
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    read();
    f.busy = true; f.errors = []; f.result = null;
    render();
    await done(f.id ? await sendFeature(`/api/apps/${encodeURIComponent(f.id)}`, 'PUT', { draft: f.draft, base: f.base })
      : await sendFeature('/api/apps', 'POST', { draft: f.draft }));
  });
  form.querySelector('[data-app-delete]')?.addEventListener('click', async () => {
    const a = appById(f.id);
    const names = (a?.features || []).map((id) => snapshot.features.find((x) => x.feature.id === id)?.feature.name || id);
    if (names.length) {
      alert(`${a.name} is listed by ${names.length === 1 ? '1 feature' : `${names.length} features`}:\n\n${names.map((n) => `• ${n}`).join('\n')}\n\nRemove the app from ${names.length === 1 ? 'it' : 'them'} first (apps: in the feature definition), then delete the app.`);
      return;
    }
    if (!confirm(`Delete ${a?.name || f.id}? ${a?.file || 'Its file'} is removed from the shared repo for everyone.`)) return;
    f.busy = true;
    render();
    await done(await sendFeature(`/api/apps/${encodeURIComponent(f.id)}/delete`, 'POST', {}));
  });
}

// ---------- dependency map (SVG) ----------

const legend = (external) => `<div class="legend"><span><i class="blocking"></i>Blocking now</span><span><i class="done"></i>Dependency done</span>
  <span><i></i>Waiting / in progress</span><span><i class="cycle"></i>Circular dependency</span><span><i class="unknown"></i>Unknown id</span>
  ${external ? '<span><i class="ext"></i>Feature in another project</span>' : ''}</div>`;

// The map shows what the person picks: some projects, or part of the tree around some features
// (what they depend on, what depends on them, or both, to a chosen depth), at the level of detail
// they choose. The choice lives in the link (#/map?…), so sharing the link shares the view.
const MAP_KEYS = ['projects', 'focus', 'dir', 'depth', 'level'];
let mapHashApplied = null;
function mapHash(pr) {
  const q = new URLSearchParams();
  if (pr.projects.length) q.set('projects', pr.projects.join(','));
  if (pr.teams?.length) q.set('teams', pr.teams.join(','));
  if (pr.focus.length) q.set('focus', pr.focus.join(','));
  if (pr.focus.length && pr.dir !== 'both') q.set('dir', pr.dir);
  if (pr.focus.length && pr.depth !== 1) q.set('depth', String(pr.depth));
  if (pr.level !== 'features') q.set('level', pr.level);
  const str = q.toString().replace(/%2C/g, ',');
  return `#/map${str ? `?${str}` : ''}`;
}
// A link with a selection replaces this person's saved map choices (that's what opening it means).
function applyMapLink() {
  const h = location.hash;
  if (!h.startsWith('#/map?') || h === mapHashApplied) return;
  const q = new URLSearchParams(h.slice(h.indexOf('?') + 1));
  const list = (k) => (q.get(k) ? q.get(k).split(',').filter(Boolean) : []);
  const patch = { ...structuredClone(VIEW_DEFAULTS.map), projects: list('projects'), teams: list('teams'), focus: list('focus') };
  if (['up', 'down', 'both'].includes(q.get('dir'))) patch.dir = q.get('dir');
  if (/^\d+$/.test(q.get('depth') || '')) patch.depth = Number(q.get('depth'));
  if (['projects', 'features', 'steps'].includes(q.get('level'))) patch.level = q.get('level');
  setPrefs('map', patch, { rerender: false });
  mapHashApplied = h;
}
function syncMapHash() {
  const want = mapHash(prefs('map'));
  if (parseRoute().route === 'map' && location.hash !== want) { history.replaceState(null, '', want); mapHashApplied = want; }
}

function mapSelection(pr) {
  const byId = byFeature();
  const projOf = (id) => pid(projectOfFeature(id)?.project.id);
  let ids = new Set(snapshot.features.map((f) => f.feature.id));
  const focus = pr.focus.filter((id) => byId.has(id));
  let depthCut = false;
  if (focus.length) {
    const max = pr.depth || Infinity;
    const seen = new Set(focus);
    let frontier = focus, d = 0;
    while (frontier.length && d < max) {
      const next = [];
      for (const id of frontier) {
        const f = byId.get(id);
        const ns = [...(pr.dir !== 'down' ? f.depends_on : []), ...(pr.dir !== 'up' ? f.depended_on_by : [])].map((x) => x.id).filter((x) => byId.has(x));
        for (const n of ns) if (!seen.has(n)) { seen.add(n); next.push(n); }
      }
      frontier = next;
      d++;
    }
    depthCut = frontier.some((id) => [...(pr.dir !== 'down' ? byId.get(id).depends_on : []), ...(pr.dir !== 'up' ? byId.get(id).depended_on_by : [])].some((x) => byId.has(x.id) && !seen.has(x.id)));
    ids = seen;
  }
  if (pr.projects.length) ids = new Set([...ids].filter((id) => pr.projects.includes(projOf(id))));
  // Teams: the same team list as the Roadmap's (the teams named in steps).
  if (pr.teams?.length) {
    const inTeam = new Set(roadmapTeams().teams.filter((t) => pr.teams.includes(t.id)).flatMap((t) => t.features));
    ids = new Set([...ids].filter((id) => inTeam.has(id)));
  }
  // Dependencies leaving the selection, in the directions being looked at.
  const out = new Map();
  for (const id of ids) {
    const f = byId.get(id);
    const ns = focus.length ? [...(pr.dir !== 'down' ? f.depends_on : []), ...(pr.dir !== 'up' ? f.depended_on_by : [])] : [...f.depends_on, ...f.depended_on_by];
    for (const n of ns) if (byId.has(n.id) && !ids.has(n.id)) out.set(n.id, byId.get(n.id));
  }
  return { ids, out: [...out.values()], depthCut, projOf };
}

function projectMapSvg(projectIds) {
  const ps = snapshot.projects.filter((p) => !projectIds.length || projectIds.includes(pid(p.project.id)));
  const ids = new Set(ps.map((p) => pid(p.project.id)));
  const edges = new Map(); // "from>to" -> feature links
  for (const p of ps) {
    for (const d of p.depends_on_outside) {
      const from = pid(d.project ?? null);
      if (!ids.has(from) || from === pid(p.project.id)) continue;
      const k = `${from}>${pid(p.project.id)}`;
      edges.set(k, (edges.get(k) || 0) + 1);
    }
  }
  const depth = new Map();
  const depthOf = (id, seen = new Set()) => {
    if (depth.has(id)) return depth.get(id);
    if (seen.has(id)) return 0;
    seen.add(id);
    const v = Math.max(0, ...[...edges.keys()].filter((k) => k.endsWith(`>${id}`)).map((k) => depthOf(k.split('>')[0], seen) + 1));
    depth.set(id, v);
    return v;
  };
  for (const id of ids) depthOf(id);
  const cols = [];
  for (const [id, d] of depth) (cols[d] ||= []).push(id);
  const W = 250, H = 86, GX = 110, GY = 26, PAD = 24;
  const height = PAD * 2 + Math.max(...cols.map((c) => c.length * (H + GY) - GY));
  const pos = new Map();
  cols.forEach((c, x) => c.forEach((id, i) => pos.set(id, { x: PAD + x * (W + GX), y: PAD + (height - PAD * 2 - (c.length * (H + GY) - GY)) / 2 + i * (H + GY) })));
  const width = PAD * 2 + cols.length * W + (cols.length - 1) * GX;
  const edgeSvg = [...edges].map(([k, n]) => {
    const [from, to] = k.split('>');
    const a = pos.get(from), b = pos.get(to);
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x - 7, y2 = b.y + H / 2;
    const blocking = snapshot.features.some((f) => projectOfFeature(f.feature.id) && pid(projectOfFeature(f.feature.id).project.id) === to
      && f.blockers.some((bl) => bl.kind === 'dependency' && pid(projectOfFeature(bl.feature)?.project.id) === from));
    const label = `${projectById(to)?.project.name} depends on ${projectById(from)?.project.name} (${plural(n, 'feature link')})`;
    const d = a.x === b.x ? `M${x1},${y1} C${x1 + 60},${y1} ${x1 + 60},${b.y + H / 2} ${b.x + W + 6},${b.y + H / 2}` : `M${x1},${y1} C${x1 + GX / 2},${y1} ${x2 - GX / 2},${y2} ${x2},${y2}`;
    return `<path class="edge${blocking ? ' blocking' : ''}" d="${d}" marker-end="url(#${blocking ? 'arrow-red' : 'arrow'})"><title>${esc(label)}</title></path>
      <text class="nsub" x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 6}" text-anchor="middle">${n}</text>`;
  }).join('');
  const nodeSvg = ps.map((p) => {
    const at = pos.get(pid(p.project.id));
    const fs = p.features.map((id) => snapshot.features.find((f) => f.feature.id === id)).filter(Boolean);
    const nb = fs.filter((f) => f.state === 'blocked').length, nd = fs.filter((f) => f.state === 'done').length;
    const name = p.project.name.length > 30 ? `${p.project.name.slice(0, 29)}…` : p.project.name;
    return `<a class="node st-${p.state}" href="${projHref(p.project.id, 'map')}" aria-label="${esc(p.project.name)}: ${esc(LABEL[p.state])}, ${esc(featuresLabel(fs))}, ${nb} blocked">
      <rect class="nbox" x="${at.x}" y="${at.y}" width="${W}" height="${H}" rx="12"/><rect class="nbar" x="${at.x}" y="${at.y + 12}" width="3" height="${H - 24}" rx="1.5"/>
      <text class="ntitle" x="${at.x + 16}" y="${at.y + 26}">${esc(name)}</text>
      <text class="nsub" x="${at.x + 16}" y="${at.y + 46}"><tspan style="fill:var(--s)">● ${esc(LABEL[p.state])}</tspan> · ${esc(featuresLabel(fs))}</text>
      <text class="nsub" x="${at.x + 16}" y="${at.y + 66}">${nd} done${nb ? ` · ${nb} blocked` : ''}</text><title>${esc(p.project.name)}</title></a>`;
  }).join('');
  const marker = (id, color) => `<marker id="${id}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${color}"/></marker>`;
  return `<div class="canvas"><svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="group" aria-label="Dependency map by project, ${plural(ps.length, 'project')}">
    <defs>${marker('arrow', 'var(--muted-foreground)')}${marker('arrow-red', 'var(--destructive)')}</defs>${edgeSvg}${nodeSvg}</svg></div>`;
}

function renderMap() {
  applyMapLink();
  const pr = prefs('map');
  const byId = byFeature();
  const projOpts = snapshot.projects.map((p) => ({ value: pid(p.project.id), label: p.project.name, hint: featuresLabel(p.features.map((id) => byId.get(id)).filter(Boolean)) }));
  const featOpts = featureOptions(snapshot.features);
  const mapTeams = roadmapTeams().teams;
  const teamOpts = mapTeams.map((t) => ({ value: t.id, label: t.name, hint: featuresLabel(t.features.map((id) => byId.get(id)).filter(Boolean)) }));
  const isProjects = pr.level === 'projects';
  const controls = `<div class="vctl" role="group" aria-label="What to show">
      ${pickMenu({ id: 'map-projects', label: 'Projects', options: projOpts, selected: pr.projects, view: 'map', key: 'projects' })}
      ${isProjects ? '' : pickMenu({ id: 'map-teams', label: 'Teams', options: teamOpts, selected: pr.teams || [], view: 'map', key: 'teams' })}
      ${isProjects ? '' : pickMenu({ id: 'map-focus', label: 'Start from a feature', options: featOpts, selected: pr.focus, view: 'map', key: 'focus', search: true })}
      ${!isProjects && pr.focus.length ? `<span class="k">Show</span>${segmented('Which part of the tree', 'map', 'dir', [['up', 'What it depends on'], ['down', 'What depends on it'], ['both', 'Both']], pr.dir)}
        <span class="k">Depth</span>${segmented('How many steps away', 'map', 'depth', [[1, '1'], [2, '2'], [3, '3'], [0, 'All']], pr.depth)}` : ''}
    </div>
    <div class="vctl" role="group" aria-label="Level of detail"><span class="k">Detail</span>${segmented('Level of detail', 'map', 'level', [['projects', 'Projects'], ['features', 'Features'], ['steps', 'Features with steps']], pr.level)}
      <button type="button" class="btn small" data-copy-map data-fk="map-copy">Copy link to this view</button><span class="muted small" id="map-copied" role="status"></span></div>`;
  const dirLabel = { up: 'what it depends on', down: 'what depends on it', both: 'both directions' }[pr.dir];
  const items = [
    ...pr.projects.map((id) => ({ label: `Project: ${projectById(id)?.project.name || id}`, clear: { projects: pr.projects.filter((x) => x !== id) } })),
    ...(isProjects ? [] : (pr.teams || []).map((id) => ({ label: `Team: ${mapTeams.find((t) => t.id === id)?.name || id}`, clear: { teams: pr.teams.filter((x) => x !== id) } }))),
    ...(isProjects ? [] : pr.focus.map((id) => ({ label: `Around: ${byId.get(id)?.feature.name || id} (${dirLabel}, ${pr.depth ? `depth ${pr.depth}` : 'any depth'})`, clear: { focus: pr.focus.filter((x) => x !== id) } }))),
  ];
  const filters = activeFilters('map', items, { projects: [], teams: [], focus: [] });
  const head = `<p class="kicker">Dependencies</p><h1>Dependency map</h1>
    `;
  if (isProjects) {
    return `${head}${controls}${filters}<div class="section">${projectMapSvg(pr.projects)}</div>
      <div class="legend"><span><i></i>Depends on (number = feature links)</span><span><i class="blocking"></i>Blocking now</span></div>`;
  }
  const { ids, out, depthCut } = mapSelection(pr);
  if (!ids.size) return `${head}${controls}${filters}${filteredEmpty('map', 'No feature matches the projects, teams and starting features you picked.')}`;
  const external = pr.projects.length && !pr.focus.length;
  const outProjects = [...new Set(out.map((f) => pid(projectOfFeature(f.feature.id)?.project.id)))].filter((p) => !pr.projects.includes(p));
  const includePatch = pr.projects.length && outProjects.length ? { projects: [...pr.projects, ...outProjects] } : depthCut && pr.depth ? { depth: pr.depth + 1 } : null;
  const outNote = out.length ? `<div class="banner st-not_started map-out" role="note"><span class="ico">↗</span><div><b>${plural(out.length, 'dependency')} ${out.length === 1 ? 'leads' : 'lead'} outside this view</b>${external ? ' (shown faded)' : ''}:
      ${out.slice(0, 8).map((f) => `<a href="${href(f.feature.id)}">${esc(f.feature.name)}</a> <span class="muted">in ${esc(projectName(projectOfFeature(f.feature.id)?.project.id ?? null))}</span>`).join(', ')}${out.length > 8 ? `, +${out.length - 8} more` : ''}
      ${includePatch ? `<button type="button" class="btn small" data-map-include='${esc(JSON.stringify(includePatch))}'>${includePatch.projects ? `Include ${outProjects.length === 1 ? 'its project' : 'their projects'}` : 'Include them (one step deeper)'}</button>` : ''}</div></div>` : '';
  return `${head}${controls}${goalPicker()}${filters}${outNote}
    <div class="section">${mapSvg([...ids], pr.focus.length === 1 ? pr.focus[0] : null, { external, steps: pr.level === 'steps', focusSet: new Set(pr.focus) })}</div>${legend(external)}`;
}
document.addEventListener('click', async (e) => {
  const inc = e.target.closest('[data-map-include]');
  if (inc) return setPrefs('map', JSON.parse(inc.dataset.mapInclude));
  const cp = e.target.closest('[data-copy-map]');
  if (!cp) return;
  const link = `${location.origin}/${mapHash(prefs('map'))}`;
  const note = document.getElementById('map-copied');
  try { await navigator.clipboard.writeText(link); note.textContent = 'Link copied. Anyone opening it in their LifeCycle sees this same selection.'; }
  catch { note.textContent = `Copy this link: ${link}`; }
});

function mapSvg(ids, focusId, { external = false, steps: withSteps = false, focusSet = null } = {}) {
  const byId = new Map(snapshot.features.map((f) => [f.feature.id, f]));
  const include = new Set(ids);
  // With `external`, also show the direct neighbours that live in other projects.
  const extra = new Set();
  if (external) {
    for (const id of include) {
      const f = byId.get(id);
      for (const d of [...f.depends_on, ...f.depended_on_by]) if (byId.has(d.id) && !include.has(d.id)) extra.add(d.id);
    }
  }
  const visible = new Set([...include, ...extra]);
  const nodes = new Map();
  const edges = [];
  for (const id of visible) nodes.set(id, { id, f: byId.get(id), ext: extra.has(id) });
  for (const id of visible) {
    const f = byId.get(id);
    const cyc = new Set(f.warnings.filter((w) => w.kind === 'circular_dependency').flatMap((w) => w.ids));
    for (const d of f.depends_on) {
      const known = byId.has(d.id);
      if (!known && include.has(id)) nodes.set(d.id, { id: d.id, ghost: true });
      else if (!visible.has(d.id) || !(include.has(id) || include.has(d.id))) continue;
      const blocking = f.blockers.some((b) => b.kind === 'dependency' && (b.feature === d.id || b.via?.[0] === d.id));
      const kind = !known ? 'unknown' : cyc.has(d.id) ? 'cycle' : byId.get(d.id).state === 'done' ? 'done' : blocking ? 'blocking' : '';
      edges.push({ from: d.id, to: id, kind });
    }
  }
  if (focusId && nodes.size <= 1) {
    return '<div class="card empty"><strong>No dependencies</strong>This feature doesn\'t depend on anything, and nothing depends on it.</div>';
  }

  // Columns by dependency depth; cycle edges are ignored so depth stays finite.
  const depth = new Map();
  const visiting = new Set();
  const depthOf = (id) => {
    if (depth.has(id)) return depth.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const v = Math.max(0, ...edges.filter((e) => e.to === id && e.kind !== 'cycle').map((e) => depthOf(e.from) + 1));
    visiting.delete(id);
    depth.set(id, v);
    return v;
  };
  for (const id of nodes.keys()) depthOf(id);
  const cols = [];
  for (const [id, d] of depth) (cols[d] ||= []).push(id);
  // Edges that skip columns get a lane (virtual node) in every column they cross, so they are
  // routed between nodes instead of behind them.
  const chains = edges.map((e, i) => {
    const span = depth.get(e.to) - depth.get(e.from);
    if (e.kind === 'cycle' || span <= 1) return [e.from, e.to];
    const lanes = [];
    for (let c = depth.get(e.from) + 1; c < depth.get(e.to); c++) {
      const v = `~${i}~${c}`;
      cols[c].push(v);
      lanes.push(v);
    }
    return [e.from, ...lanes, e.to];
  });
  const isLane = (id) => id.startsWith('~');
  const hops = chains.flatMap((ch, i) => (edges[i].kind === 'cycle' ? [] : ch.slice(1).map((to, j) => ({ from: ch[j], to }))));
  const stateRank = (id) => (isLane(id) ? 2 : ORDER.indexOf(byId.get(id)?.state ?? 'blocked'));
  cols.forEach((c) => c.sort((a, b) => stateRank(a) - stateRank(b) || a.localeCompare(b)));
  // Barycenter passes: place each node near the average row of its neighbours to cut crossings.
  const rowOf = () => new Map(cols.flatMap((c) => c.map((id, i) => [id, i / Math.max(1, c.length - 1)])));
  const reorder = (c, neighbours) => {
    const r = rowOf();
    const bary = (id) => {
      const ns = neighbours(id).filter((n) => r.has(n));
      return ns.length ? ns.reduce((sum, n) => sum + r.get(n), 0) / ns.length : r.get(id);
    };
    const keyed = new Map(c.map((id) => [id, bary(id)]));
    c.sort((a, b) => keyed.get(a) - keyed.get(b) || stateRank(a) - stateRank(b));
  };
  const preds = (id) => hops.filter((h) => h.to === id).map((h) => h.from);
  const succs = (id) => hops.filter((h) => h.from === id).map((h) => h.to);
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 1; i < cols.length; i++) reorder(cols[i], preds);
    for (let i = cols.length - 2; i >= 0; i--) reorder(cols[i], succs);
  }

  const maxSteps = withSteps ? Math.max(1, ...[...nodes.values()].map((n) => n.f?.steps.length || 0)) : 0;
  const W = withSteps ? 300 : 230, H = withSteps ? 62 + maxSteps * 17 : 74, GX = 96, GY = 22, PAD = 24, LANE = 30;
  const slot = (id) => (isLane(id) ? LANE : H);
  const colHeight = (c) => c.reduce((sum, id) => sum + slot(id) + GY, -GY);
  const height = PAD * 2 + Math.max(...cols.map(colHeight));
  const pos = new Map();
  cols.forEach((c, x) => {
    let y = PAD + (height - PAD * 2 - colHeight(c)) / 2; // center short columns
    for (const id of c) {
      pos.set(id, { x: PAD + x * (W + GX), y, cy: y + slot(id) / 2 });
      y += slot(id) + GY;
    }
  });
  const width = PAD * 2 + cols.length * W + (cols.length - 1) * GX + 60;

  // Spread the ends of edges that share a node, so arrows don't land on the same point.
  const port = (id, idxs, neighbourOf) => {
    const sorted = idxs.sort((p, q) => pos.get(neighbourOf(p)).cy - pos.get(neighbourOf(q)).cy);
    return (i) => pos.get(id).y + (H * (sorted.indexOf(i) + 1)) / (sorted.length + 1);
  };
  const inY = new Map(), outY = new Map();
  const edgeIdx = edges.map((_, i) => i);
  for (const id of nodes.keys()) {
    inY.set(id, port(id, edgeIdx.filter((i) => edges[i].to === id), (i) => chains[i].at(-2)));
    outY.set(id, port(id, edgeIdx.filter((i) => edges[i].from === id), (i) => chains[i][1]));
  }
  // Edges are smooth curves, each turning around its own lane within the gap between columns, so many
  // links between two columns don't pile into one bundle.
  const segs = []; // one per gap crossing: { i, k, x1, y1, x2, y2 }
  edges.forEach((e, i) => {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (a.x === b.x) return;
    let x = a.x + W, y = outY.get(e.from)(i), k = 0;
    for (const lane of chains[i].slice(1, -1)) { const l = pos.get(lane); segs.push({ i, k: k++, x1: x, y1: y, x2: l.x, y2: l.cy }); x = l.x + W; y = l.cy; }
    segs.push({ i, k: k++, x1: x, y1: y, x2: b.x - 7, y2: inY.get(e.to)(i) });
  });
  const laneX = new Map();
  const byGap = new Map();
  for (const sg of segs) { const g = Math.round(sg.x1); if (!byGap.has(g)) byGap.set(g, []); byGap.get(g).push(sg); }
  for (const list of byGap.values()) {
    const moving = list.filter((sg) => Math.abs(sg.y2 - sg.y1) > 1).sort((p, q) => (p.y2 - p.y1) - (q.y2 - q.y1) || p.y1 - q.y1);
    moving.forEach((sg, n) => laneX.set(`${sg.i}:${sg.k}`, sg.x1 + GX * (0.18 + (0.64 * (n + 0.5)) / moving.length)));
  }
  const elbow = (sg) => {
    const { x1, y1, x2, y2 } = sg;
    if (Math.abs(y2 - y1) <= 1) return `L${x2},${y2}`;
    const xm = laneX.get(`${sg.i}:${sg.k}`) ?? (x1 + x2) / 2;
    // A smooth S-curve that turns around its own lane, so parallel links stay apart and keep their flow.
    return `C${xm},${y1} ${xm},${y2} ${x2},${y2}`;
  };
  const edgeSvg = edges.map((e, i) => {
    const a = pos.get(e.from), b = pos.get(e.to);
    const ay = outY.get(e.from)(i), by = inY.get(e.to)(i);
    let d;
    if (a.x === b.x) {
      const x = a.x + W;
      d = `M${x},${ay} C${x + 60},${ay} ${x + 60},${by} ${x + 6},${by}`;
    } else {
      const mine = segs.filter((sg) => sg.i === i);
      d = `M${a.x + W},${ay}`;
      mine.forEach((sg, n) => { d += ` ${elbow(sg)}`; if (n < mine.length - 1) d += ` L${sg.x2 + W},${sg.y2}`; });
    }
    const marker = e.kind === 'blocking' || e.kind === 'cycle' ? 'arrow-red' : e.kind === 'done' ? 'arrow-green' : e.kind === 'unknown' ? 'arrow-amber' : 'arrow';
    return `<path class="edge ${e.kind}" data-from="${esc(e.from)}" data-to="${esc(e.to)}" d="${d}" marker-end="url(#${marker})"><title>${esc(e.to)} depends on ${esc(e.from)}</title></path>`;
  }).join('');

  const nodeSvg = [...nodes.values()].map((n) => {
    const p = pos.get(n.id);
    if (n.ghost) {
      return `<g><rect class="ghostbox" x="${p.x}" y="${p.y}" width="${W}" height="${H}" rx="12"/>
        <text class="ntitle" x="${p.x + 16}" y="${p.y + 30}">${esc(n.id)}</text>
        <text class="nsub" x="${p.x + 16}" y="${p.y + 50}">Unknown dependency, not defined</text></g>`;
    }
    const f = n.f;
    const name = f.feature.name.length > 28 ? `${f.feature.name.slice(0, 27)}…` : f.feature.name;
    const steps = f.steps.length ? f.steps : [{ state: 'not_started' }];
    const segW = (W - 32 - (steps.length - 1) * 4) / steps.length;
    const segs = withSteps
      ? f.steps.map((st, i) => `<text class="nstep" x="${p.x + 16}" y="${p.y + 66 + i * 17}"><tspan class="st-${st.state}" style="fill:var(--s)">●</tspan> ${esc(st.name.length > 28 ? `${st.name.slice(0, 27)}…` : st.name)} <tspan class="nsub">· ${esc(LABEL[st.state] || st.state)}</tspan></text>`).join('') || `<text class="nsub" x="${p.x + 16}" y="${p.y + 66}">No steps defined</text>`
      : steps.map((s, i) => `<rect class="nseg st-${s.state}" x="${p.x + 16 + i * (segW + 4)}" y="${p.y + H - 16}" width="${segW}" height="4" rx="2"/>`).join('');
    // The subtitle is cut to the node's width after render (fitNodeText), from its full text.
    const fullSub = `${n.ext ? `In ${projectName(f.project?.id ?? null)}` : f.feature.owner}`;
    return `<a data-node="${esc(n.id)}" class="node st-${f.state}${n.id === focusId || focusSet?.has(n.id) ? ' focus' : ''}${n.ext ? ' ext' : ''}" href="${href(n.id)}" aria-label="${esc(f.feature.name)}: ${esc(LABEL[f.state])}${n.ext ? `, in ${esc(projectName(f.project?.id ?? null))}` : ''}">
      <rect class="nbox" x="${p.x}" y="${p.y}" width="${W}" height="${H}" rx="12"/>
      <rect class="nbar" x="${p.x}" y="${p.y + 12}" width="3" height="${H - 24}" rx="1.5"/>
      <text class="ntitle" x="${p.x + 16}" y="${p.y + 25}">${esc(name)}</text>
      <text class="nsub" x="${p.x + 16}" y="${p.y + 43}"><tspan style="fill:var(--s)">● ${esc(LABEL[f.state])}</tspan> · <tspan class="fit" data-full="${esc(fullSub)}" data-max="${W - 32}">${esc(fullSub)}</tspan></text>
      ${segs}<title>${esc(f.feature.name)}${n.ext ? ` (${esc(fullSub)})` : ''}: ${esc(f.summary)}</title></a>`;
  }).join('');

  const marker = (id, color) => `<marker id="${id}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${color}"/></marker>`;
  return `<div class="canvas-wrap fs-host" data-fs-host><div class="canvas-tools">${zoomControls()}${fsButton()}</div><div class="map-hl" role="status" aria-live="polite" hidden></div><div class="canvas"><svg data-w="${width}" data-h="${height}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="group" aria-label="Dependency map. Click a box to see everything that depends on it.">
    <defs>${marker('arrow', 'var(--muted-foreground)')}${marker('arrow-red', 'var(--destructive)')}${marker('arrow-green', 'var(--success)')}${marker('arrow-amber', 'var(--warning)')}</defs>
    ${edgeSvg}${nodeSvg}</svg></div></div>`;
}

// ---------- feature detail ----------

// ---------- last mile: done vs. turned on (feature page) ----------

const ENVS = [['qa', 'QA'], ['production', 'Production']];
const ACTIONS = { success: 'passed', failure: 'failed', pending: 'running', none: 'no runs', not_merged: 'not merged', unavailable: 'unavailable', no_access: 'no access' };
const lmBadge = (lm) => `<span class="badge lm lm-${esc(lm.state)}"><span class="dot" aria-hidden="true"></span>${esc(lm.label)}</span>`;
const extLink = (link, inner, title = '') => (link ? `<a href="${escUrl(link)}" target="_blank" rel="noopener"${title ? ` title="${esc(title)}"` : ''}>${inner}</a>` : inner);

function deployCell(c) {
  if (c.state === 'unavailable' || c.state === 'no_access') {
    return `${extLink(c.link, `<span class="cellv unk">${c.state === 'no_access' ? 'No access' : 'Unavailable'}</span>`, 'Last known deploy record')}<span class="cells">${c.unavailable_since ? `source unavailable since ${esc(time(c.unavailable_since))} · ` : ''}last read ${esc(ago(c.last_successful_read_at))}</span>`;
  }
  if (!c.deployed) return `${extLink(c.link, '<span class="cellv off">Not deployed</span>', 'Deploy records')}`;
  const has = c.contains_feature === true ? '<span class="inc yes" title="This version includes the feature">✓ includes it</span>'
    : c.contains_feature === false ? '<span class="inc no" title="This version does not include the feature">✗ without it</span>' : '';
  return `${extLink(c.link, `<span class="cellv mono">${esc(c.version)}</span>`, c.link_kind === 'pipeline_run' ? 'Pipeline run that deployed it' : 'Deploy record')}${has}
    <span class="cells">${esc(ago(c.deployed_at))}${c.deployed_by ? ` · ${esc(c.deployed_by)}` : ''}</span>`;
}

function flagCell(fl, c, platform) {
  if (fl.unknown) return '<span class="cellv unk">Unknown flag</span>';
  if (['unavailable', 'no_access', 'missing_environment'].includes(c.state)) {
    return `${extLink(c.link, `<span class="cellv unk">${c.state === 'no_access' ? 'No access' : 'Unavailable'}</span>`, `Last known flag in ${platform === 'statsig' ? 'Statsig' : 'Flagsmith'}`)}<span class="cells">${c.unavailable_since ? `source unavailable since ${esc(time(c.unavailable_since))} · ` : ''}last read ${esc(ago(c.last_successful_read_at))}</span>`;
  }
  const text = c.state === 'on' ? 'On' : c.state === 'off' ? (c.was_on_before ? 'Switched off' : 'Off')
    : c.rollout_percentage !== null ? `${c.rollout_percentage}%` : `Some segments`;
  const cls = c.state === 'on' ? 'on' : c.state === 'off' ? 'off' : 'part';
  const meta = c.changed_at ? `changed ${esc(time(c.changed_at))}${c.changed_by ? ` · ${esc(c.changed_by)}` : ''}` : '';
  // Not read live: the team's snapshot, with when it was read and (on hover) why it isn't live.
  const snap = c.from_snapshot ? `<span class="cells" title="${esc(c.message || '')}">from team snapshot · read ${esc(ago(c.snapshot_read_at))}</span>` : '';
  return `${extLink(c.link, `<span class="cellv ${cls}">${esc(text)}</span>`, `Flag setting in ${platform === 'statsig' ? 'Statsig' : 'Flagsmith'}`)}${meta ? `<span class="cells">${meta}</span>` : ''}${snap}`;
}

// One experiment in one environment: running or not, with the last read time when it can't be read.
const EXP_STATE = { running: 'Running', not_running: 'Not running here', not_started: 'Not started', ended: 'Ended', unknown: 'Unknown experiment' };
function experimentCell(x, c) {
  if (['unavailable', 'no_access'].includes(c.state)) {
    return `${extLink(c.link, `<span class="cellv unk">${c.state === 'no_access' ? 'No access' : 'Status unavailable'}</span>`, 'Last known experiment in Statsig')}<span class="cells">${c.unavailable_since ? `source unavailable since ${esc(time(c.unavailable_since))} · ` : ''}last read ${esc(ago(c.last_successful_read_at))}</span>`;
  }
  const cls = c.state === 'running' ? 'part' : c.state === 'unknown' ? 'unk' : 'off';
  const meta = c.state === 'ended' ? `${c.ended_at ? `ended ${esc(time(c.ended_at))}` : 'ended'}${c.launched_group ? ` · shipped ${esc(c.launched_group)}` : ''}`
    : c.state === 'running' && c.started_at ? `since ${esc(time(c.started_at))}` : c.reason ? esc(c.reason) : '';
  return `${extLink(c.link, `<span class="cellv ${cls}">${esc(EXP_STATE[c.state] || c.state)}</span>`, 'Experiment in Statsig')}<span class="cells">${meta ? `${meta} · ` : ''}read ${esc(ago(c.last_successful_read_at))}</span>`;
}
// Groups (control and variants), each one's share and what the feature does in it, plus how users are assigned.
function experimentGroups(c) {
  if (!c.groups?.length) return '';
  const a = c.assignment || {};
  const how = [a.id_type ? `assigned by ${esc(a.id_type)}` : '', a.allocation !== null && a.allocation !== undefined ? `${esc(a.allocation)}% of eligible users enter` : '',
    a.targeting_gate ? `eligible: gate <code>${esc(a.targeting_gate)}</code>${a.segments?.length ? ` (${a.segments.map(esc).join(', ')})` : ''}` : ''].filter(Boolean).join(' · ');
  return `<ul class="lmgroups">${c.groups.map((g) => `<li><span class="gname">${esc(g.name)}${g.control ? ' <span class="tag">control</span>' : ''}</span><span class="gshare mono" title="${g.share_of_users !== null && g.share_of_users !== undefined ? `${esc(g.share_of_users)}% of all eligible users` : ''}">${esc(g.share ?? '?')}%${g.share_of_users !== null && g.share_of_users !== undefined && g.share_of_users !== g.share ? `<span class="cells">${esc(g.share_of_users)}% of users</span>` : ''}</span>
      <span class="ggets">${g.gets ? `${esc(g.gets)}${g.gets_from === 'statsig' ? ' <span class="cells inline">from Statsig</span>' : ''}` : '<span class="muted">not described in the definition</span>'}</span></li>`).join('')}</ul>
    ${how ? `<p class="cells">${how}</p>` : ''}`;
}
function experimentsTable(lm) {
  if (!lm.experiments?.length) return '';
  return `<table class="lmt lmexp"><caption>Experiments (Statsig)</caption><thead><tr><th scope="col">Experiment</th>${ENVS.map(([, l]) => `<th scope="col">${l}</th>`).join('')}</tr></thead><tbody>
    ${lm.experiments.map((x) => {
      const prod = x.environments.production;
      return `<tr><th scope="row"><span class="mono">${esc(x.name || x.id)}</span></th>${ENVS.map(([e]) => `<td>${experimentCell(x, x.environments[e])}</td>`).join('')}</tr>
        ${prod.groups?.length && prod.state !== 'unknown' ? `<tr><td colspan="3">${experimentGroups(prod)}</td></tr>` : ''}`;
    }).join('')}</tbody></table>`;
}

// One app on one platform: what its store says about the version that first includes the feature,
// linked to the store console, with when it was read. The text comes from the API (label).
function storeCell(c) {
  if (c.state === 'not_connected') return `<span class="cellv unk">Store not connected</span><span class="cells">${esc(c.store_name)} isn't connected to LifeCycle yet</span>`;
  if (['unavailable', 'no_access'].includes(c.state)) {
    return `${extLink(c.link, `<span class="cellv unk">${c.state === 'no_access' ? 'No access' : 'Status unavailable'}</span>`, `Last known version in ${c.store_name}`)}<span class="cells">${c.unavailable_since ? `${esc(c.store_name)} unavailable since ${esc(time(c.unavailable_since))} · ` : ''}last read ${esc(ago(c.last_successful_read_at))}${c.snapshot_read_at ? ` (snapshot ${esc(time(c.snapshot_read_at))})` : ''}</span>`;
  }
  const cls = c.state === 'released' ? (c.rollout_state === 'complete' ? 'on' : c.rollout_state === 'halted' ? 'off' : 'part') : c.state === 'unknown_app' ? 'unk' : c.state === 'rejected' ? 'off' : 'part';
  const tag = c.tag_check?.state === 'ok' ? extLink(c.tag_check.link, `<span class="inc yes" title="Release tag confirms the written first version">✓ ${esc(c.tag_check.tag)}</span>`)
    : c.tag_check && ['no_tag', 'contradicts'].includes(c.tag_check.state) ? `<span class="inc no" title="${esc(c.tag_check.message)}">✗ tag</span>` : '';
  // Where it was read: the store, or the app's Slack release channel; and whether it is the team snapshot.
  const where = c.via === 'slack' ? `Slack ${esc(c.release_channel || '')}` : esc(c.store_name);
  const read = c.from_snapshot ? `<span title="${esc(c.message || '')}">from team snapshot · read ${esc(ago(c.snapshot_read_at))}</span>` : `read ${esc(ago(c.last_successful_read_at))}`;
  return `${extLink(c.link, `<span class="cellv ${cls}">${esc(c.label.charAt(0).toUpperCase() + c.label.slice(1))}</span>`, c.via === 'slack' ? 'Slack message it was read from' : `Version in ${c.store_name}`)}${tag}
    <span class="cells">${where}${c.first_version ? ` · first in ${esc(c.first_version)}` : ' · no first version written'} · ${read}</span>`;
}
function appsTable(lm) {
  if (!lm.apps?.length) return '';
  return `<table class="lmt lmapps"><caption>App releases (stores)</caption><thead><tr><th scope="col">App</th><th scope="col">iOS</th><th scope="col">Android</th></tr></thead><tbody>
    ${lm.apps.map((a) => `<tr><th scope="row"><span class="mono">${esc(a.name || a.id)}</span>${a.unknown ? '<span class="cells">unknown app</span>' : a.repo ? `<span class="cells">${esc(a.repo)}</span>` : ''}</th>
      ${['ios', 'android'].map((p) => `<td>${a.platforms?.[p] ? storeCell(a.platforms[p]) : '<span class="muted">not on this platform</span>'}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function lastMileCard(f, { inFeature = false } = {}) {
  const lm = f.last_mile;
  const head = inFeature ? `<div class="lmhead">${lmBadge(lm)}</div>`
    : `<div class="lmhead"><a class="lmname" href="${href(f.feature.id)}">${esc(f.feature.name)}</a>${lmBadge(lm)}</div>`;
  const dnto = lm.done_but_not_turned_on
    ? `<div class="dnto"><b>Done but not turned on</b> · ${lm.reasons.filter((r) => r.kind === 'service' || r.kind === 'flag')
      .map((r) => r.kind === 'flag' ? `flag <code>${esc(r.flag)}</code>` : `service <code>${esc(r.service)}</code> in ${esc(r.environment)}`).join(', ')}</div>` : '';
  const sw = lm.switched_off
    ? `<p class="lmline"><b>Switched off</b> ${lm.switched_off.changed_at ? esc(time(lm.switched_off.changed_at)) : '(time not recorded)'} · ${lm.switched_off.changed_by ? `by ${esc(lm.switched_off.changed_by)}` : 'who changed it isn\'t recorded by the flag console'}</p>` : '';
  const unavailable = lm.state === 'unavailable'
    ? `<p class="lmline unk">Not shown as on or off. Last successful read: <b>${esc(time(lm.last_successful_read_at))}</b></p>
       <ul class="lmreasons">${lm.reasons.map((r) => `<li>${esc(r.message)}</li>`).join('')}</ul>` : '';
  const svc = lm.services.length
    ? `<table class="lmt"><caption>Deployed version</caption><thead><tr><th scope="col">Service</th>${ENVS.map(([, l]) => `<th scope="col">${l}</th>`).join('')}</tr></thead><tbody>
        ${lm.services.map((s) => `<tr><th scope="row"><span class="mono">${esc(s.id)}</span>${s.repo ? `<span class="cells">${esc(s.repo)}</span>` : '<span class="cells">unknown service</span>'}</th>
          ${ENVS.map(([e]) => `<td>${deployCell(s.environments[e])}</td>`).join('')}</tr>`).join('')}</tbody></table>`
    : '<p class="muted lmnone">No services listed.</p>';
  const flags = lm.flags.length
    ? `<table class="lmt"><caption>Flags</caption><thead><tr><th scope="col">Flag</th>${ENVS.map(([, l]) => `<th scope="col">${l}</th>`).join('')}</tr></thead><tbody>
        ${lm.flags.map((fl) => `<tr><th scope="row"><span class="mono">${esc(fl.key)}</span></th>${ENVS.map(([e]) => `<td>${flagCell(fl, fl.environments[e], lm.flag_platform)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
    : `<div class="noflags"><span class="tag">No flags</span><span class="muted">State comes from ${lm.apps?.length ? (lm.services.length ? 'deploys and the app stores' : 'the app stores') : 'deploys'} alone.</span></div>`;
  const warn = lm.warnings.length
    ? `<ul class="lmwarn">${lm.warnings.map((w) => `<li class="w-${esc(w.kind)}"><b>${esc({ version_mismatch: 'Version mismatch', unknown_flag: 'Unknown flag', unknown_service: 'Unknown service', unknown_experiment: 'Unknown experiment',
      unknown_app: 'Unknown app', platform_mismatch: 'Platforms differ', app_version_tag: 'App version vs. release tags', app_platform: 'Missing platform' }[w.kind] || w.kind)}</b> ${esc(w.message)}</li>`).join('')}</ul>` : '';
  const access = lm.access_problems.length
    ? `<ul class="lmaccess">${lm.access_problems.map((a) => `<li><b>Missing access · ${esc(a.source === 'flagsmith' ? 'Flagsmith (flag console)' : a.source === 'statsig' ? 'Statsig' : a.source === 'app_store' ? 'App Store Connect' : a.source === 'google_play' ? 'Google Play' : 'GitHub')}</b> ${esc(a.message)}</li>`).join('')}</ul>` : '';
  const dev = lm.development.pull_requests.length
    ? `<div class="lmdev"><span class="k">Development</span>${lm.development.pull_requests.map((p) => `${extLink(p.link, `PR #${esc(p.number)}`)}
        ${p.actions_link ? extLink(p.actions_link, `<span class="act act-${esc(p.actions || p.state)}">GitHub Actions ${esc(ACTIONS[p.actions || p.state] || p.actions || p.state)}</span>`, p.detail || '') : ''}`).join(' ')}</div>`
    : `<div class="lmdev"><span class="k">Development</span><span class="muted">${esc(lm.development.message)}</span></div>`;
  return `<article class="card lmcard lm-${esc(lm.state)}">
    ${head}${dnto}
    <p class="lmwhy">${esc(lm.summary)}</p>${sw}${unavailable}
    ${warn}${access}
    ${appsTable(lm)}
    <div class="lmgrid">${lm.apps?.length && !lm.services.length ? '' : svc}${flags}</div>
    ${experimentsTable(lm)}
    ${dev}
  </article>`;
}

// Shortens map subtitles with "…" until their line fits inside the node, using real text widths.
function fitNodeText(root) {
  for (const span of root.querySelectorAll('svg tspan.fit')) {
    const line = span.parentNode;
    const max = Number(span.dataset.max);
    const full = span.dataset.full;
    let n = full.length;
    while (n > 1 && line.getComputedTextLength() > max) span.textContent = `${full.slice(0, --n).trimEnd()}…`;
  }
}

// ---------- ask & digest ----------
// Answers and digests are produced by this machine's LifeCycle (POST /api/ask, /api/digest) from the
// live status, registered changes and alerts; the page only renders them.

let digest = null;
let digestError = null;
let digestBusy = false; // re-producing the digest after a follow
let follows = { follows: [], me: { owners: [] } };
let providerInfo = null;
const thread = []; // { question, answer | error | pending }
// This page's conversation: follow-up answers and "yes" in the chat reach the change it belongs to.
let chatSession = `c-${Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('')}`;

const post = async (url, body, method = 'POST') => {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
};

// The digest is produced once each time LifeCycle is opened.
async function loadAsk() {
  try {
    [follows, providerInfo] = await Promise.all([
      fetch('/api/follows').then((r) => r.json()),
      fetch('/api/ask/provider').then((r) => r.json()),
    ]);
  } catch { /* shown as empty */ }
  try {
    digest = await post('/api/digest');
  } catch (err) {
    digestError = err.message;
  }
  render();
}

const outLink = (link) => (String(link || '').startsWith('/#/') ? '' : ' target="_blank" rel="noopener"');
const evLinks = (list) => (list || []).map((e) => `<a class="evl" href="${escUrl(e.link)}"${outLink(e.link)}>${esc(e.label)}</a>`).join('');

function followButton(id) {
  const on = follows.follows.includes(id);
  return `<button type="button" class="btn follow${on ? ' on' : ''}" data-follow="${esc(id)}" aria-pressed="${on}" title="${on ? 'Following · click to stop' : 'Follow'}" aria-label="${on ? 'Following' : 'Follow'}"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 1.8l2.5 5.2 5.7.8-4.1 4 1 5.6L10 14.7l-5.1 2.7 1-5.6-4.1-4 5.7-.8z"/></svg></button>`;
}

// The digest's "new since your last look": one folded row per feature (name, state, the one line that
// matters), opened to see each update with its sources. What is open is kept across refreshes.
const dgOpen = new Set();
// Server texts repeat themselves ("blocked. Blocked by X.", "Not done yet. Not done yet: …"): tidy them.
function dgText(t) {
  let s = String(t || '').trim().replace(/^Available to users:\s*/i, '');
  s = s.replace(/^([^.:]{3,40})\.\s+\1:\s*/i, '$1: ');
  s = s.replace(/^(blocked|not started|flowing|done|status unavailable)\.\s+/i, '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}
const DG_LABEL = (i) => (i.kind === 'now' && /^Available to users/i.test(i.text) ? 'Users' : i.kind === 'now' ? 'Status' : i.label);
function digestFold(f, { key = f.id, link = href(f.id) } = {}) {
  const head = f.items.find((i) => i.kind === 'now' && !/^Available to users/i.test(i.text)) || f.items[0];
  const n = f.items.length;
  return `<details class="dg-feat" data-dg-open="${esc(key)}"${dgOpen.has(key) ? ' open' : ''}>
    <summary><span class="dg-fname">${esc(f.name)}</span>${badge(f.state)}<span class="dg-fsum">${esc(dgText(head?.text))}</span><span class="dg-fn">${plural(n, 'update')}<span class="dg-hint"> · open to see them</span></span></summary>
    <div class="dg-fbody">${digestItems(f)}<a class="dg-open" href="${escUrl(link)}">Open ${esc(f.name)} →</a></div></details>`;
}
document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (!d.matches?.('details[data-dg-open]')) return;
  if (d.open) dgOpen.add(d.dataset.dgOpen); else dgOpen.delete(d.dataset.dgOpen);
}, true);

function digestItems(f) {
  return `<ul class="ditems">${f.items.map((i) => `<li class="di di-${esc(i.kind)}"><span class="dk">${esc(DG_LABEL(i))}</span>
    <div class="dtw"><span class="dt">${esc(dgText(i.text))}</span>${i.evidence?.length ? `<span class="evs">${evLinks(i.evidence)}</span>` : ''}</div></li>`).join('')}</ul>`;
}

// A short confirmation that something happened (read out by screen readers too).
function toast(text, bad = false) {
  let t = document.getElementById('f-toast');
  if (!t) { t = Object.assign(document.createElement('div'), { id: 'f-toast' }); t.setAttribute('role', 'status'); t.setAttribute('aria-live', 'polite'); document.body.append(t); }
  t.textContent = text;
  t.className = `f-toast on${bad ? ' bad' : ''}`;
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.className = 'f-toast'; }, 4000);
}

// Cited answer: the lead carries numbered citations; picking one shows that statement with its
// evidence as a source card. Every statement stays one fold away.
const citeSel = new Map(); // asked_at -> statement id
function answerHtml(a) {
  const askBtn = (f) => `<button type="button" class="chip" data-ask="${esc(f.ask || f.name)}">${f.kind ? `<span class="muted small">${esc(f.kind)}</span> ` : ''}${esc(f.name)}</button>`;
  const push = (id) => a.blockers.find((b) => b.statement === id);
  const statements = (a.sections || []).flatMap((s) => s.statements.map((st) => ({ ...st, section: s.title })));
  const cites = (a.lead.cites || []).filter((c) => statements.some((st) => st.id === c));
  const chosen = statements.find((st) => st.id === (citeSel.get(a.asked_at) || cites[0]));
  const sections = (a.sections || []).map((s) => `<div class="asec"><div class="ah">${esc(s.title)}</div><ul>${s.statements.map((f) => `<li><span class="fid">${esc(f.id)}</span><div><span>${esc(f.text)}</span><span class="evs">${evLinks(f.evidence)}${!f.evidence.length && f.no_source_item ? `<span class="src-none">no source item: ${esc(f.no_source_item)}</span>` : ''}${f.unavailable_since ? `<span class="src-unav">source unavailable since ${esc(time(f.unavailable_since))}</span>` : f.read_at ? `<span class="src-read">read ${esc(ago(f.read_at))}</span>` : ''}</span></div></li>`).join('')}</ul></div>`).join('');
  const stale = (a.freshness || []).filter((x) => !x.info && !isTechnical(x.text));
  const p = a.provider;
  const card = chosen ? (() => {
    const pm = push(chosen.id);
    return `<div class="f-quote"><div class="qh"><span>${esc(chosen.section)}</span><span class="f-cite on">${esc(chosen.id)}</span></div>
      <blockquote>${esc(chosen.text)}</blockquote>
      ${chosen.evidence?.length ? `<div class="qa">${chosen.evidence.map((e) => `<a class="f-mini" href="${escUrl(e.link)}"${outLink(e.link)}>${esc(e.label)}${outLink(e.link) ? ' ↗' : ''}</a>`).join('')}</div>` : ''}
      ${pm ? `<div class="pushmsg"><span class="k">Suggested message to ${esc(pm.owner)}</span><p>${esc(pm.message)}</p><button type="button" class="ghost copy" data-copy="${esc(pm.message)}">Copy</button></div>` : ''}</div>`;
  })() : '';
  return `<div class="answer out-${esc(a.outcome)}">
    ${a.project ? `<div class="afeat"><a href="${projHref(a.project.id)}">${esc(a.project.name)}</a> <span class="f-src">project · ${plural(statements.length, 'statement')} · ${plural(new Set(statements.flatMap((x) => (x.evidence || []).map((e) => e.link))).size, 'source')}</span></div>` : ''}
    ${a.feature ? `<div class="afeat"><a href="${href(a.feature.id)}">${esc(a.feature.name)}</a> <span class="f-src">${plural(statements.length, 'statement')} · ${plural(new Set(statements.flatMap((x) => (x.evidence || []).map((e) => e.link))).size, 'source')}</span></div>` : ''}
    <p class="lead">${esc(a.lead.text)}${cites.map((c) => ` <button type="button" class="f-cite${chosen?.id === c ? ' on' : ''}" data-acite="${esc(a.asked_at)}|${esc(c)}" aria-label="Source ${esc(c)}">${esc(c)}</button>`).join('')}</p>
    ${a.action ? chatActionHtml(a.action) : ''}
    ${a.outcome === 'clarify' && a.candidates ? `<div class="chips">${a.candidates.map(askBtn).join('')}</div>` : ''}
    ${a.outcome === 'unknown_feature' ? `<div class="ah">Defined features</div><div class="chips">${a.defined_features.map(askBtn).join('')}</div>` : ''}
    ${a.outcome === 'unknown_project' && a.defined_projects?.length ? `<div class="ah">Projects (initiatives)</div><div class="chips">${(a.closest?.length ? a.closest : a.defined_projects).map((p) => askBtn({ ...p, ask: `How is the project "${p.name}" going?` })).join('')}</div>` : ''}
    ${cites.length > 1 ? `<div class="f-stabs">${cites.map((c) => { const st = statements.find((x) => x.id === c); return `<button type="button" data-acite="${esc(a.asked_at)}|${esc(c)}" aria-pressed="${chosen?.id === c}">${esc(st.section)} <b>${esc(c)}</b></button>`; }).join('')}</div>` : ''}
    ${card}
    ${sections ? `<details class="f-fold"><summary>All ${plural(statements.length, 'statement')}</summary>${sections}</details>` : ''}
    ${stale.length ? `<ul class="stale">${stale.map((x) => `<li>⚠ ${esc(x.text)}</li>`).join('')}</ul>` : ''}
    <p class="prov">${p.used ? 'Summarised by AI' : "Answered by LifeCycle's own rules"} · built only from live status, registered changes and alerts</p>
    ${p.note || p.model ? `<details class="techfold"><summary>Technical details</summary><p class="prov">${esc(p.name)}${p.model ? ` · ${esc(p.model)}` : ''}${p.note ? ` · ${esc(p.note)}` : ''}</p></details>` : ''}
  </div>`;
}

// A reply about creating, editing or deleting a definition (src/ask/change.js): the message, the
// proposal (the full definition for a new feature, a before/after of only what changes for an edit),
// problems by field, the AI review, and Save / Don't save. The buttons send "yes" / "no" as chat
// messages, exactly what typing them does; nothing is saved without that yes.
const CHANGE_BADGE = { saved: ['st-done', '✓', 'Saved'], not_saved_yet: ['st-unavailable', '!', 'Not saved yet'], conflict: ['st-blocked', '!', 'Not saved: conflict'],
  invalid: ['st-blocked', '×', "Can't save yet"], read_only: ['st-unavailable', '!', 'Read-only access'], declined: ['st-unavailable', '·', 'Nothing saved'],
  status_is_live: ['st-unavailable', 'i', 'Status is live'] };
function changeHtml(c, latest) {
  const p = c.proposal;
  const badge = CHANGE_BADGE[c.outcome];
  const head = badge ? `<div class="banner tight ${badge[0]}" role="status"><span class="ico">${badge[1]}</span><div><b>${esc(badge[2])}</b> ${esc(c.text)}</div></div>` : `<p class="lead">${esc(c.text)}</p>`;
  const showProposal = p && ['preview', 'invalid', 'confirm_again', 'has_dependents', 'no_change'].includes(c.outcome);
  const def = showProposal && p.op === 'create' && p.text ? `<div class="ah">Proposed definition · <code>${esc(p.path)}</code></div><pre class="chg-yaml">${esc(p.text.trim())}</pre>` : '';
  const diff = showProposal && p.op !== 'create' && p.op !== 'delete' && p.diff?.length ? `<div class="ah">Before → after · <code>${esc(p.path)}</code></div>${diffHtml(p.diff)}` : '';
  const deps = showProposal && p.dependents?.length ? `<div class="ah">Depends on it</div><ul>${p.dependents.map((d) => `<li>${esc(d.name)} <span class="muted small">${esc(d.owner || '')}</span></li>`).join('')}</ul>` : '';
  const errs = p?.errors?.length ? `<ul class="chg-errs">${p.errors.map((e) => `<li><code>${esc(e.field)}</code> ${esc(e.message)}</li>`).join('')}</ul>` : '';
  const r = showProposal && p.review?.ran ? p.review : null; // a review that didn't run is already said in the message
  const review = r ? `<div class="banner tight ${r.blocking ? 'st-blocked' : r.ran ? 'st-done' : 'st-unavailable'}"><span class="ico">${r.blocking ? '×' : r.ran ? '✓' : '!'}</span><div>AI product review: ${esc(r.note)}
    ${r.findings.length ? `<ul>${r.findings.map((x) => `<li><b>${esc(x.kind)}</b> · <code>${esc(x.field)}</code> ${esc(x.message)}${x.suggestion ? ` <span class="muted">${esc(x.suggestion)}</span>` : ''}</li>`).join('')}</ul>` : ''}</div></div>` : '';
  const sugg = showProposal && c.outcome === 'preview' && p.suggestions?.length && latest ? `<div class="chips"><button type="button" class="chip" data-chat-say="use the suggestions">Use the suggestions</button></div>` : '';
  const askSugg = c.ask?.suggestion && latest ? `<div class="chips"><button type="button" class="chip" data-chat-say="yes">Use ${esc(c.ask.suggestion)}</button></div>` : '';
  const picks = c.candidates?.length && latest && ['clarify', 'name_close', 'name_taken', 'unknown_feature'].includes(c.outcome)
    ? `<div class="chips">${c.candidates.map((f) => `<button type="button" class="chip" data-chat-say="${esc(f.name)}">${esc(f.name)}</button>`).join('')}</div>` : '';
  const offers = c.offers?.length ? `<div class="ah">What I can do</div><div class="chips">${c.offers.map((o) => `<button type="button" class="chip" data-chat-fill="${esc(o)}">${esc(o)}</button>`).join('')}</div>` : '';
  const actions = c.can_confirm && latest ? `<div class="chg-actions"><button type="button" class="btn primary" data-chat-say="${c.outcome === 'confirm_again' || c.outcome === 'has_dependents' ? 'yes, delete it' : 'yes'}">${p?.op === 'delete' ? (c.outcome === 'preview' ? 'Delete…' : 'Yes, delete it') : 'Save'}</button>
    <button type="button" class="btn" data-chat-say="no">Don't save</button></div>` : '';
  const link = c.outcome === 'saved' && c.feature?.id && p?.op !== 'delete' && c.result?.op !== 'delete' ? `<p><a href="${href(c.feature.id)}">Open ${esc(c.feature.name)} →</a></p>` : '';
  return `<div class="answer chg out-${esc(c.outcome)}">${head}${def}${diff}${deps}${errs}${review}${picks}${sugg}${askSugg}${offers}${actions}${link}</div>`;
}

// Text meant for whoever installs LifeCycle (paths, commands, keys) stays out of the main view.
const isTechnical = (t) => /npm run|~\/\.lifecycle|config\.json|ANTHROPIC|API key|`/.test(String(t || ''));

function askExamples() {
  const byId = byFeature();
  const mine = [...(digest?.following || []).map((f) => f.id), ...follows.follows].filter((id, i, a) => byId.has(id) && a.indexOf(id) === i);
  const pool = mine.length ? mine : snapshot.features.filter((f) => f.state === 'blocked').concat(snapshot.features).map((f) => f.feature.id).filter((id, i, a) => a.indexOf(id) === i);
  const names = pool.slice(0, 3).map((id) => byId.get(id).feature.name);
  if (!names.length) return { mine: false, list: [] };
  const forms = [(n) => `How is ${n} going?`, (n) => `What's blocking ${n}?`, (n) => `Is ${n} available to users?`];
  return { mine: mine.length > 0, list: forms.map((q, i) => q(names[i % names.length])) };
}

// ---------- the chat: a side panel opened from the "Ask LifeCycle" button (bottom right) ----------
// Same engine as before (POST /api/ask, one conversation per page); it stays open while you move
// around LifeCycle, and remembers whether it was open.
const CHAT_KEY = 'lifecycle-chat';
let chatOpen = (() => { try { return localStorage.getItem(CHAT_KEY) === 'open'; } catch { return false; } })();
let chatWide = false;
function setChatOpen(on, { render: rerender = true } = {}) {
  chatOpen = on;
  try { localStorage.setItem(CHAT_KEY, on ? 'open' : 'closed'); } catch { /* private mode */ }
  if (rerender) renderChatDock();
  if (on) requestAnimationFrame(() => $('#q')?.focus());
  else $('#chat-launch')?.focus();
}
const SPARK = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8 2.5l1.3 3.7L13 7.5l-3.7 1.3L8 12.5 6.7 8.8 3 7.5l3.7-1.3zM14.5 11l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/></svg>';
const CHAT_ICON = {
  status: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 15.5h14M5.5 12V8.5M10 12V5M14.5 12V9.5"/></svg>',
  blocked: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="6.5"/><path d="M5.5 14.5l9-9"/></svg>',
  users: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="7" r="3"/><path d="M4 16.5c.8-3 3.1-4.5 6-4.5s5.2 1.5 6 4.5"/></svg>',
  create: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 3.5h7l3 3v10H5zM12 3.5v3h3M10 9v5M7.5 11.5h5"/></svg>',
};
function chatPanelHtml() {
  const ex = snapshot ? askExamples() : { mine: false, list: [] };
  const msgs = thread.map((m) => `<div class="msg q"><span>${esc(m.question)}</span></div>
    <div class="msg a">${m.pending ? '<span class="muted">Reading live status…</span>' : m.error ? `<p class="alert">${esc(m.error)}</p>` : m.answer.kind === 'change' ? changeHtml(m.answer, m === thread.at(-1)) : answerHtml(m.answer)}</div>`).join('');
  const cards = [
    ...ex.list.map((q, i) => ({ q, icon: ['status', 'blocked', 'users'][i % 3], sub: ['Where it stands, read live', 'And who to push', 'Deployed and turned on?'][i % 3] })),
    { q: 'create a feature called ', icon: 'create', sub: 'Asks for what it needs, shows it before saving', fill: true, label: 'Create a feature' },
  ];
  const empty = `<div class="cd-empty"><div class="cd-spark">${SPARK}</div><h2>LifeCycle is on your features</h2>
      <p>Ask how a feature is going, what's blocking it or who to push. It can also create, change and delete features.</p>
      <div class="cd-cards">${cards.map((c) => `<button type="button" class="cd-card" ${c.fill ? `data-chat-fill="${esc(c.q)}"` : `data-ask="${esc(c.q)}"`}>${CHAT_ICON[c.icon]}<span><b>${esc(c.label || c.q)}</b><span>${esc(c.sub)}</span></span></button>`).join('')}</div></div>`;
  const model = providerInfo?.model || providerInfo?.name || '';
  return `<div class="cd-head"><span class="cd-title">${thread.length ? esc(thread[0].question.length > 38 ? `${thread[0].question.slice(0, 37)}…` : thread[0].question) : 'New chat'}</span>
      <div class="cd-acts">
        ${thread.length ? '<button type="button" class="cd-icon" data-chat-new title="New chat" aria-label="New chat"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4.5v11M4.5 10h11"/></svg></button>' : ''}
        <button type="button" class="cd-icon" data-chat-wide title="${chatWide ? 'Make narrower' : 'Make wider'}" aria-label="${chatWide ? 'Make narrower' : 'Make wider'}" aria-pressed="${chatWide}"><svg viewBox="0 0 20 20" aria-hidden="true">${chatWide ? '<path d="M8.5 11.5L3.5 16.5M3.5 12v4.5H8M11.5 8.5l5-5M16.5 8V3.5H12"/>' : '<path d="M3.5 16.5l5-5M3.5 12v4.5H8M16.5 3.5l-5 5M16.5 8V3.5H12"/>'}</svg></button>
        <button type="button" class="cd-icon" data-chat-close title="Close" aria-label="Close the chat"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15"/></svg></button>
      </div></div>
    <div class="cd-body"><div class="thread" aria-live="polite">${msgs || empty}</div></div>
    <form id="askform" class="cd-form askform"><label class="sr" for="q">Your question</label>
      <div class="cd-box"><textarea id="q" name="q" rows="2" autocomplete="off" placeholder="Ask about your features…" maxlength="500"></textarea>
        <div class="cd-row">${model ? `<span class="cd-model">${esc(model)}</span>` : '<span></span>'}<button class="cd-send" type="submit" aria-label="Send"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 15.5v-11M5.5 9L10 4.5 14.5 9"/></svg></button></div></div>
    </form>`;
}
function renderChatDock() {
  const dock = $('#chatdock');
  const launch = $('#chat-launch');
  if (!dock || !launch) return;
  document.body.classList.toggle('chat-open', chatOpen);
  document.body.classList.toggle('chat-wide', chatOpen && chatWide);
  launch.hidden = chatOpen;
  launch.setAttribute('aria-expanded', String(chatOpen));
  dock.hidden = !chatOpen;
  if (!chatOpen) { dock.innerHTML = ''; return; }
  // Keep what the person is typing across re-renders (a refresh may land mid-sentence).
  const q = $('#q');
  const typed = q ? q.value : '';
  const hadFocus = document.activeElement === q;
  dock.innerHTML = chatPanelHtml();
  wireAsk(dock);
  wireTeams(dock);
  const nq = $('#q');
  if (nq) {
    nq.value = typed;
    if (hadFocus) nq.focus();
    nq.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#askform').requestSubmit(); }
    });
  }
  const body = dock.querySelector('.cd-body');
  if (body && thread.length) body.scrollTop = body.scrollHeight;
}
document.addEventListener('click', (e) => {
  if (e.target.closest('#chat-launch')) return setChatOpen(true);
  if (e.target.closest('[data-chat-close]')) return setChatOpen(false);
  if (e.target.closest('[data-chat-wide]')) { chatWide = !chatWide; return renderChatDock(); }
  if (e.target.closest('[data-chat-new]')) {
    thread.length = 0;
    chatSession = `c-${Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('')}`;
    renderChatDock();
    $('#q')?.focus();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && chatOpen && e.target.closest?.('#chatdock')) setChatOpen(false);
});

// Your digest, in one card: what's new (highlighted), what you follow, and "Add" to search and
// follow several features at once.
let dgAdd = null; // { q, sel: Set } while the Add panel is open
function askDigestCard() {
  if (digestError) return `<section class="card digest"><div class="dhead"><b>Your digest</b></div><p class="alert">Couldn't produce your digest: ${esc(digestError)}</p></section>`;
  const byId = byFeature();
  const followed = (digest?.following || []).filter((f) => f.relation === 'owner' || follows.follows.includes(f.id));
  const news = (digest?.features || []).map((f) => ({ ...f, items: f.items.filter((i) => i.kind !== 'new_in_digest') })).filter((f) => f.items.length);
  const newIds = new Set(news.map((f) => f.id));
  const head = `<div class="dhead"><b>Your digest</b>${digest?.since ? `<span class="muted small">since ${when(digest.since)}</span>` : ''}
    <button type="button" class="btn small dg-addbtn" data-dg-add aria-expanded="${!!dgAdd}" data-fk="dg-add">${dgAdd ? 'Close' : '+ Add'}</button></div>`;
  const newsHtml = !digest ? '<p class="f-none">Producing your digest…</p>' : digestBusy ? '<p class="f-none">Updating your digest…</p>'
    : news.length ? `<div class="dg-new" role="status"><span class="k"><span class="dg-dot" aria-hidden="true"></span>New since your last look</span>
      <div class="dg-feats">${news.map(digestFold).join('')}</div></div>` : '';
  const list = followed.length ? `<ul class="dg-suggest dg-list">${followed.map((f) => { const x = byId.get(f.id); return `<li><span><a href="${href(f.id)}" title="${esc(f.name)}">${esc(f.name)}</a>${newIds.has(f.id) ? '<span class="tag dg-newtag">New</span>' : ''}${x ? badge(x.state) : ''}</span>${f.relation === 'owner' ? '<span class="tag">You own it</span>' : followButton(f.id)}</li>`; }).join('')}</ul>` : '';
  const projHtml = digest && !digestBusy && digest.projects?.length ? `<div class="dg-new dg-proj"><span class="k">Initiatives · ${esc(digest.projects_headline || '')}</span>
      <div class="dg-feats">${digest.projects.map((p) => digestFold(p, { key: `project:${p.id}`, link: projHref(p.id) })).join('')}</div></div>` : '';
  return `<section class="card digest dg-one" aria-label="Your digest">${head}${dgAdd ? digestAddPanel() : ''}${newsHtml}${projHtml}${list}</section>`;
}
function digestAddPanel() {
  const q = dgAdd.q.trim().toLowerCase();
  const opts = featureOptions(snapshot.features.filter((f) => !follows.follows.includes(f.feature.id)));
  let last = null;
  const rows = opts.map((o) => {
    const show = !q || `${o.code} ${o.label} ${o.group}`.toLowerCase().includes(q);
    const head = o.group !== last ? `<li class="pick-g" role="presentation" data-g="${esc(o.group)}">${esc(o.group)}</li>` : '';
    last = o.group;
    return `${head}<li data-text="${esc(`${o.code} ${o.label} ${o.group}`.toLowerCase())}" data-in="${esc(o.group)}"${show ? '' : ' hidden'}><label><input type="checkbox" data-dg-pick value="${esc(o.value)}"${dgAdd.sel.has(o.value) ? ' checked' : ''}>
      <span class="pick-t">${o.code ? `<span class="pick-code">${esc(o.code)}</span>` : ''}${esc(o.label)}</span></label></li>`;
  }).join('');
  const n = dgAdd.sel.size;
  return `<div class="dg-addpanel"><label class="sr" for="dg-q">Search features</label>
    <input id="dg-q" class="pick-q" type="search" placeholder="Search features…" value="${esc(dgAdd.q)}" autocomplete="off" data-fk="dg-q">
    <ul class="dg-addlist" role="group" aria-label="Features to add">${rows || '<li class="f-none">You already follow everything.</li>'}</ul>
    <div class="dg-addfoot"><button type="button" class="btn small primary" data-dg-confirm${n ? '' : ' disabled'}>${n ? `Add ${n}` : 'Add'}</button>
      <button type="button" class="linkbtn" data-dg-add>Cancel</button></div></div>`;
}
document.addEventListener('click', async (e) => {
  if (e.target.closest('[data-dg-add]')) { dgAdd = dgAdd ? null : { q: '', sel: new Set() }; render(); if (dgAdd) document.getElementById('dg-q')?.focus(); return; }
  if (!e.target.closest('[data-dg-confirm]') || !dgAdd?.sel.size) return;
  const ids = [...dgAdd.sel];
  dgAdd = null;
  follows.follows = [...new Set([...follows.follows, ...ids])];
  digestBusy = true;
  render();
  toast(`Added ${ids.length === 1 ? (snapshot.features.find((f) => f.feature.id === ids[0])?.feature.name || ids[0]) : `${ids.length} items`} to your digest.`);
  try {
    for (const id of ids) follows.follows = (await post(`/api/follows/${encodeURIComponent(id)}`, { follow: true }, 'PUT')).follows;
    digest = await post('/api/digest');
  } catch (err) { toast(`Couldn't add everything: ${err.message}`, true); }
  digestBusy = false;
  render();
});
document.addEventListener('change', (e) => {
  if (!e.target.matches?.('[data-dg-pick]') || !dgAdd) return;
  e.target.checked ? dgAdd.sel.add(e.target.value) : dgAdd.sel.delete(e.target.value);
  const btn = document.querySelector('[data-dg-confirm]');
  if (btn) { btn.disabled = !dgAdd.sel.size; btn.textContent = dgAdd.sel.size ? `Add ${dgAdd.sel.size}` : 'Add'; }
});
document.addEventListener('input', (e) => {
  if (e.target.id !== 'dg-q' || !dgAdd) return;
  dgAdd.q = e.target.value;
  const q = dgAdd.q.trim().toLowerCase(), pop = e.target.closest('.dg-addpanel');
  for (const li of pop.querySelectorAll('li[data-text]')) li.hidden = !!q && !li.dataset.text.includes(q);
  for (const g of pop.querySelectorAll('li.pick-g')) g.hidden = ![...pop.querySelectorAll(`li[data-in="${CSS.escape(g.dataset.g)}"]`)].some((li) => !li.hidden);
});

// Relative time for the last hour ("12 min ago"), then the date alone; the exact time on hover.
function when(iso) {
  if (!iso) return '';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  const text = s < 45 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: new Date(iso).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  return `<time datetime="${esc(iso)}" title="${esc(time(iso))}">${esc(text)}</time>`;
}

async function ask(question) {
  const entry = { question, pending: true };
  thread.push(entry);
  render();
  try {
    entry.answer = await post('/api/ask', { question, session: chatSession });
    // A definition saved from the chat: read the roadmap again so it shows here at once.
    if (entry.answer.kind === 'change' && entry.answer.outcome === 'saved') load();
  } catch (err) {
    entry.error = `Couldn't answer: ${err.message}`;
  }
  entry.pending = false;
  render();
  $('#q')?.focus();
  const cdBody = document.querySelector('#chatdock .cd-body');
  if (cdBody) cdBody.scrollTop = cdBody.scrollHeight;
}

function wireAsk(root) {
  root.querySelector('#askform')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = e.target.q.value.trim();
    e.target.q.value = '';
    if (q) ask(q);
  });
  // Chat proposals: Save / Don't save / use a suggestion are said in the chat, like typing them.
  root.querySelectorAll('[data-chat-say]').forEach((b) => b.addEventListener('click', () => ask(b.dataset.chatSay)));
  root.querySelectorAll('[data-chat-fill]').forEach((b) => b.addEventListener('click', () => { const q = $('#q'); if (q) { q.value = b.dataset.chatFill; q.focus(); } }));
  root.querySelectorAll('[data-ask]').forEach((b) => b.addEventListener('click', () => {
    setChatOpen(true, { render: false });
    ask(b.dataset.ask.includes('?') ? b.dataset.ask : `How is ${b.dataset.ask} going?`);
  }));
  root.querySelectorAll('[data-follow]').forEach((b) => b.addEventListener('click', async () => {
    // Show the result at once; the server call and the digest refresh happen behind it.
    const id = b.dataset.follow;
    const on = !follows.follows.includes(id);
    const name = snapshot.features.find((f) => f.feature.id === id)?.feature.name || id;
    const before = follows.follows;
    follows.follows = on ? [...before, id] : before.filter((x) => x !== id);
    if (digest?.following) digest.following = on ? [...digest.following.filter((f) => f.id !== id), { id, name, relation: 'following' }] : digest.following.filter((f) => f.id !== id || f.relation === 'owner');
    render();
    toast(on ? `You're following ${name}. What changes in it will show up in your digest.` : `You stopped following ${name}.`);
    try {
      const r = await post(`/api/follows/${encodeURIComponent(id)}`, { follow: on }, 'PUT');
      follows.follows = r.follows;
    } catch (err) {
      follows.follows = before;
      render();
      return toast(`Couldn't ${on ? 'follow' : 'unfollow'} ${name}: ${err.message}`, true);
    }
    digestBusy = true;
    render();
    try { digest = await post('/api/digest'); } catch { /* keep the last digest */ }
    digestBusy = false;
    render();
  }));
  root.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; } catch { b.textContent = 'Select and copy'; }
  }));
  root.querySelectorAll('[data-acite]').forEach((b) => b.addEventListener('click', () => {
    const [at, id] = b.dataset.acite.split('|');
    citeSel.set(at, id);
    render();
  }));
}

// ---------- alerts & registered changes ----------
// The alert list comes from /api/alerts (registered changes and delay warnings). Which ones are "new" is decided by this machine's LifeCycle; once shown here they
// are marked seen, so the same change is one alert per person.

let alertView = null;       // personal view from /api/alerts
let alertError = null;
const sessionNew = new Set(); // alerts shown as new during this page load
let alertFilter = 'all';
let alertsAcknowledged = false; // the person opened the alerts page: no more "new" banner this session
let changeForm = null;      // { mode: 'new'|'edit', id, base_revision, draft, errors, result, notify, busy }

const SRC_LABEL = { registered: 'Announced by the team', lifecycle: 'Possible delays' };
const SRC_EXPLAIN = {
  all: 'Every alert, whatever its source.',
  registered: 'Changes someone announced in LifeCycle with “Register a change”, for example “we switch this flag off on Friday”.',
  lifecycle: 'Warnings LifeCycle raises itself when a feature may miss its due date.',
};
const WHAT_TYPES = [['flag', 'Flag'], ['service', 'Service'], ['contract', 'Contract'], ['decision', 'Decision']];

async function loadAlerts({ cached = true } = {}) {
  try {
    const res = await fetch(`/api/alerts${cached ? '?cached=1' : ''}`, { cache: 'no-store' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    alertView = await res.json();
    alertError = null;
    const fresh = alertView.alerts.filter((a) => a.new).map((a) => a.id);
    if (fresh.some((id) => !sessionNew.has(id))) alertsAcknowledged = false;
    fresh.forEach((id) => sessionNew.add(id));
    seedSeen(alertView.alerts);
    if (fresh.length) post('/api/alerts/seen', { ids: fresh }).catch(() => { /* shown again next time */ });
  } catch (err) {
    alertError = err.message;
  }
  render();
}
// Teammates register changes without anyone asking: the list is re-read every two minutes.
setInterval(() => loadAlerts({ cached: false }), 120000);

const isNew = (a) => sessionNew.has(a.id);

// Seen / not seen: the person's own, kept only in this browser (never sent to LifeCycle or the shared
// repo). The first time, everything LifeCycle didn't flag as new counts as already seen.
const SEEN_KEY = 'lifecycle-alerts-seen';
let seenIds = null;
function loadSeen() {
  if (seenIds) return seenIds;
  try { const v = JSON.parse(localStorage.getItem(SEEN_KEY) || 'null'); if (Array.isArray(v)) seenIds = new Set(v); } catch { /* private mode */ }
  return seenIds;
}
function saveSeen() {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seenIds].slice(-3000))); } catch { /* private mode */ }
}
function seedSeen(alerts) {
  if (loadSeen()) return;
  seenIds = new Set(alerts.filter((a) => !a.new).map((a) => a.id));
  saveSeen();
}
const isSeen = (a) => !!loadSeen()?.has(a.id);
function setSeen(ids, seen) {
  loadSeen() || (seenIds = new Set());
  for (const id of ids) (seen ? seenIds.add(id) : seenIds.delete(id));
  saveSeen();
}
const seenTag = (a) => (isSeen(a) ? '' : '<span class="tag unseen-tag">Not seen</span>');
const seenButton = (a) => `<button type="button" class="f-mini seen-btn" data-seen="${esc(a.id)}" data-fk="seen-${esc(a.id)}" aria-pressed="${isSeen(a)}"
  aria-label="${isSeen(a) ? 'Mark as not seen' : 'Mark as seen'}: ${esc(a.change)}">${isSeen(a) ? 'Mark as not seen' : 'Mark as seen'}</button>`;
const featureLinks = (ids, names) => ids.map((id) => `<a href="${href(id)}">${esc(names?.[id] || id)}</a>`).join(', ');


function alertBanners() {
  if (!alertView) return '';
  const out = [];
  const fresh = alertView.alerts.filter((a) => isNew(a) && !isSeen(a));
  if (fresh.length && !alertsAcknowledged && parseRoute().route !== 'alerts') {
    out.push(`<div class="banner st-new" role="status"><span class="ico">${fresh.length}</span><div><b>${fresh.length} new alert${fresh.length === 1 ? '' : 's'} for your features</b> since you last looked.
      <ul>${fresh.slice(0, 3).map((a) => `<li>${esc(a.change)} <span class="muted">· ${esc(a.source_label)} · ${featureLinks(a.features, a.feature_names)}</span></li>`).join('')}</ul>
      <a href="#/alerts">Open alerts →</a></div></div>`);
  }
  const waiting = (alertView.outbox || []).filter((e) => e.state !== 'published');
  if (waiting.length && parseRoute().route !== 'alerts') {
    out.push(`<div class="banner st-unavailable"><span class="ico">!</span><div><b>${waiting.length} registered change${waiting.length === 1 ? '' : 's'} not published yet</b>, kept on this machine. <a href="#/alerts">Review →</a></div></div>`);
  }
  return out.join('');
}

function alertRow(a) {
  const actions = a.source === 'registered' && a.state === 'planned'
    ? `<div class="aact"><a class="btn small" href="#/alerts/edit/${encodeURIComponent(a.change_id)}">Edit</a>
        <button type="button" class="btn small" data-cancel-change="${esc(a.change_id)}" data-rev="${esc(a.revision)}">Cancel change</button></div>` : '';
  const steps = a.open_steps?.length ? `<ul class="asteps">${a.open_steps.map((s) => `<li>${who(s.owner)}<span>${esc(s.name)}</span>${badge(s.state)}</li>`).join('')}</ul>` : '';
  return `<li class="card arow src-${esc(a.source)}${isSeen(a) ? ' seen' : ' unseen'}${a.state === 'cancelled' ? ' cancelled' : ''}" data-alert="${esc(a.id)}">
    <div class="atime"><time datetime="${esc(a.at)}">${esc(time(a.at))}</time>${seenTag(a)}${a.mine ? '<span class="tag">Yours</span>' : ''}${seenButton(a)}</div>
    <div class="abody">
      <div class="achange">${esc(a.change)}</div>
      <div class="ameta"><span class="k">Feature</span>${featureLinks(a.features, a.feature_names)}
        ${a.dependents.length ? `<span class="k">Depending on it</span>${featureLinks(a.dependents, a.feature_names)}` : ''}</div>
      ${a.reason ? `<p class="areason"><span class="k">Why</span>${esc(a.reason)}</p>` : ''}
      ${steps}
      ${a.evidence?.length ? `<div class="aev">${evLinks(a.evidence)}</div>` : ''}
      ${actions}
    </div>
    <div class="asrc"><span class="srcpill src-${esc(a.source)}">${esc(a.source_label)}</span></div>
  </li>`;
}

function outboxCard(list) {
  if (!list?.length) return '';
  const label = { pending: 'Not published yet · waiting for the shared repo', conflict: 'Not published · conflict', failed: 'Not published yet' };
  return `<div class="card outbox section"><div class="h">Kept on this machine</div><ul>${list.map((e) => `<li class="ob-${esc(e.state)}">
      <div><b>${esc(label[e.state] || e.state)}</b> · ${esc(e.op === 'create' ? 'new change' : e.op === 'cancel' ? 'cancellation' : 'update')}:
        ${esc(e.draft?.change || e.prev?.summary || e.id)}<div class="muted small">${esc(e.message || '')}</div></div>
      <div class="aact">${e.op === 'create' || e.op === 'update' ? '' : ''}<button type="button" class="btn small" data-retry>Retry now</button>
        <button type="button" class="btn small" data-discard="${esc(e.id)}">Discard</button></div></li>`).join('')}</ul></div>`;
}

// ----- register / edit form -----

function openForm(mode, id) {
  if (changeForm && changeForm.mode === mode && changeForm.id === id) return;
  let draft = { what_type: 'flag', what_name: '', change: '', features: [], state: 'planned', planned_for: '', reason: '', link: '' };
  let base = null;
  if (mode === 'edit') {
    const c = snapshot.changes.find((x) => x.id === id);
    if (!c) { changeForm = { mode, id, missing: true }; return; }
    draft = { what_type: c.what?.type || 'decision', what_name: c.what?.name || '', change: c.summary || '', features: c.features || [c.feature],
      state: c.state === 'planned' ? 'planned' : 'done', planned_for: c.planned_for || '', reason: c.reason || '', link: c.link || '' };
    base = c.revision || 1;
  }
  changeForm = { mode, id, base_revision: base, draft, errors: [], result: null, notify: null, busy: false };
  refreshNotify();
}

async function refreshNotify() {
  const f = changeForm;
  if (!f || f.missing) return;
  if (!f.draft.features.length) { f.notify = null; return render(); }
  try { f.notify = await post('/api/changes/preview', { features: f.draft.features }); } catch { f.notify = null; }
  if (changeForm === f) render();
}

function fieldError(field) {
  const list = (changeForm.errors || []).filter((e) => e.field === field || (field === 'what' && /^what|^change$/.test(e.field)));
  return list.length ? `<p class="ferr" id="err-${field}" role="alert">${list.map((e) => esc(e.message)).join(' ')}</p>` : '';
}

function notifyPanel() {
  const n = changeForm.notify;
  if (!changeForm.draft.features.length) return '<p class="muted">Choose the affected features to see who will be notified.</p>';
  if (!n) return '<p class="muted">Working out who will be notified…</p>';
  return `<ul class="notify">${n.owners.map((o) => `<li>${who(o.owner)}<span class="muted small">${o.features.map((f) => `${esc(f.as)} of ${esc(f.name)}${f.relation === 'depends on it' ? ' (depends on it)' : ''}`).join('; ')}</span></li>`).join('')}</ul>
    ${n.dependents.length ? `<p class="muted small">Also affected because they depend on it: ${esc(n.dependents.map((id) => snapshot.features.find((f) => f.feature.id === id)?.feature.name || id).join(', '))}.</p>` : ''}
    <p class="muted small">They see it as a new alert the next time they open or refresh LifeCycle.</p>`;
}

function renderChangeForm(mode, id) {
  openForm(mode, id);
  const f = changeForm;
  if (f.missing) return `<div class="card empty"><strong>No registered change "${esc(id)}"</strong><a href="#/alerts">Back to alerts</a></div>`;
  const d = f.draft;
  const inv = (field) => ((f.errors || []).some((e) => e.field === field || (field === 'what' && /^what|^change$/.test(e.field))) ? ` aria-invalid="true" aria-describedby="err-${field}"` : '');
  const res = f.result;
  const resultBox = !res ? '' : `<div class="banner ${res.outcome === 'published' ? 'st-done' : res.outcome === 'queued' || res.outcome === 'not_published' ? 'st-unavailable' : 'st-blocked'}" role="alert">
      <span class="ico">${res.outcome === 'published' ? '✓' : '!'}</span><div><b>${esc({ published: 'Published', queued: 'Not published yet', not_published: 'Not published yet', conflict: 'Not published: conflict', invalid: "Can't publish yet" }[res.outcome] || res.outcome)}</b> ${esc(res.message || '')}</div></div>`;
  const feats = [...snapshot.features].sort((a, b) => a.feature.name.localeCompare(b.feature.name));
  return `<p class="kicker">${mode === 'edit' ? 'Update a planned change' : 'Register a change'}</p>
    <h1>${mode === 'edit' ? esc(d.change || id) : 'Warn everyone a change affects'}</h1>
    <p class="lede">Publishing commits this change straight to ${snapshot.definitions.source.startsWith('local:') ? 'the local data folder' : `the shared repo (${esc(snapshot.definitions.source.replace(/^github:/, ''))})`}; every teammate's LifeCycle picks it up. It never changes any feature's status.</p>
    ${resultBox}
    <form id="changeform" class="cform section" novalidate>
      <div class="two">
        <div class="card fbox">
          <fieldset class="fld"><legend>What will change <span class="req">required</span></legend>
            <div class="row3">
              <label>Type<select name="what_type"${inv('what')}>${WHAT_TYPES.map(([v, l]) => `<option value="${v}"${d.what_type === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
              <label>Name<input name="what_name" value="${esc(d.what_name)}" placeholder="rewards_enabled"${inv('what')}></label>
            </div>
            <label>The change<input name="change" value="${esc(d.change)}" placeholder="Switch off the rewards flag in production"${inv('what')}></label>
            ${fieldError('what')}
          </fieldset>
          <fieldset class="fld"><legend>Which features it affects <span class="req">required</span></legend>
            <ul class="fpick"${inv('features')}>${feats.map((x) => `<li><label><input type="checkbox" name="features" value="${esc(x.feature.id)}"${d.features.includes(x.feature.id) ? ' checked' : ''}>
              <span>${esc(x.feature.name)}</span><span class="muted small mono">${esc(x.feature.id)}</span></label></li>`).join('')}</ul>
            ${fieldError('features')}
          </fieldset>
          <fieldset class="fld"><legend>When</legend>
            <div class="row3">
              <label class="radio"><input type="radio" name="state" value="planned"${d.state === 'planned' ? ' checked' : ''}> Planned</label>
              <label class="radio"><input type="radio" name="state" value="done"${d.state === 'done' ? ' checked' : ''}> Already done</label>
              <label>Date<input type="date" name="planned_for" value="${esc(d.planned_for)}"${d.state === 'planned' ? '' : ' disabled'}${inv('planned_for')}></label>
            </div>
            ${fieldError('planned_for')}${fieldError('state')}
          </fieldset>
          <fieldset class="fld"><legend>Why <span class="req">required</span></legend>
            <textarea name="reason" rows="3" placeholder="Incident follow-up while catalog fixes the points bug"${inv('reason')}>${esc(d.reason)}</textarea>
            ${fieldError('reason')}
            <label>Evidence link <span class="muted small">optional</span><input name="link" value="${esc(d.link)}" placeholder="https://github.com/…/pull/9"${inv('link')}></label>
            ${fieldError('link')}
          </fieldset>
          <div class="factions"><button class="btn primary" type="submit"${f.busy ? ' disabled' : ''}>${mode === 'edit' ? 'Publish update' : 'Publish change'}</button>
            <a class="btn" href="#/alerts">Back to alerts</a></div>
        </div>
        <div class="side"><div class="card deps"><div class="h">Who will be notified</div><div class="npanel">${notifyPanel()}</div></div>
          <p class="muted small">Registered by your GitHub user. Only the change, the features, the reason and your GitHub user are written to the shared repo.</p></div>
      </div>
    </form>`;
}

function readForm(form) {
  const fd = new FormData(form);
  return {
    what_type: fd.get('what_type'), what_name: fd.get('what_name') || '', change: fd.get('change') || '',
    features: fd.getAll('features'), state: fd.get('state') || 'planned', planned_for: fd.get('planned_for') || '',
    reason: fd.get('reason') || '', link: fd.get('link') || '',
  };
}

function wireAlerts(root) {
  root.querySelectorAll('[data-afilter]').forEach((b) => b.addEventListener('click', () => { alertFilter = b.dataset.afilter; render(); }));
  root.querySelectorAll('[data-retry]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await post('/api/outbox/retry'); } catch { /* shown in the list */ }
    await load();
  }));
  root.querySelectorAll('[data-discard]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Discard this change? It has not been published and will be lost.')) return;
    await post(`/api/outbox/${encodeURIComponent(b.dataset.discard)}/discard`).catch(() => {});
    await loadAlerts({ cached: false });
  }));
  root.querySelectorAll('[data-cancel-change]').forEach((b) => b.addEventListener('click', async () => {
    const reason = prompt('Cancel this planned change? Everyone it reaches will see the cancellation. Reason (optional):', '');
    if (reason === null) return;
    b.disabled = true;
    let r;
    try {
      const res = await fetch(`/api/changes/${encodeURIComponent(b.dataset.cancelChange)}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason, base_revision: Number(b.dataset.rev) }) });
      r = await res.json();
    } catch (err) { r = { message: err.message }; }
    alert(r.message || r.error || 'Done');
    await load();
  }));
  const form = root.querySelector('#changeform');
  if (!form) return;
  form.addEventListener('change', (e) => {
    changeForm.draft = readForm(form);
    if (e.target.name === 'features') refreshNotify();
    if (e.target.name === 'state') render();
  });
  form.addEventListener('input', () => { changeForm.draft = readForm(form); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = changeForm;
    f.draft = readForm(form);
    f.busy = true;
    render();
    try {
      const url = f.mode === 'edit' ? `/api/changes/${encodeURIComponent(f.id)}` : '/api/changes';
      const res = await fetch(url, { method: f.mode === 'edit' ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ draft: f.draft, base_revision: f.base_revision }) });
      f.result = await res.json();
    } catch (err) {
      f.result = { outcome: 'not_published', message: `LifeCycle couldn't be reached: ${err.message}` };
    }
    f.errors = f.result.errors || [];
    f.busy = false;
    if (f.result.outcome === 'published' || f.result.outcome === 'queued' || f.result.outcome === 'not_published') {
      const msg = f.result;
      changeForm = null;
      location.hash = '#/alerts';
      await load();
      $('#banners').insertAdjacentHTML('afterbegin', `<div class="banner ${msg.outcome === 'published' ? 'st-done' : 'st-unavailable'}" role="status"><span class="ico">${msg.outcome === 'published' ? '✓' : '!'}</span><div><b>${msg.outcome === 'published' ? 'Published' : 'Not published yet'}</b> ${esc(msg.message)}</div></div>`);
      return;
    }
    render();
    root.querySelector('[aria-invalid="true"]')?.focus();
  });
}

// ---------- editing feature data ----------
// A person with write access to the shared repo edits a feature's definition here. "Review changes"
// shows what will change, the validation errors next to their fields and the AI product review;
// "Publish" commits the file to the shared repo as this person (POST/PUT /api/features). Status is
// never edited: it keeps coming from the live reads.

let editAccess = null; // { can_edit, reason } for this person and the shared data
let featureFlash = null; // { hash, html }: the outcome banner of the last publish
let featureEdit = null; // the open form: { mode, id, def, draft, base, errors, preview, result, busy }

async function loadEditAccess() {
  try { editAccess = await (await fetch('/api/features-edit-access', { cache: 'no-store' })).json(); } catch { editAccess = null; }
  const r = parseRoute();
  if (['feature', 'roadmap', 'project', 'project-new', 'apps', 'app-edit'].includes(r.route)) render();
}

const emptyDraft = (project = '') => ({ id: '', name: '', owner: '', description: '', project, target_date: '', depends_on: [], services: [], flags: [], steps: [] });
const slugify = (t) => String(t || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);

function openFeatureEdit(mode, id, project = '') {
  if (featureEdit && featureEdit.mode === mode && featureEdit.id === id && (mode !== 'create' || featureEdit.project === project)) return;
  featureEdit = { mode, id, project, def: null, draft: mode === 'create' ? emptyDraft(project) : null, base: null, errors: [], preview: null, result: null, busy: false, loading: true };
  const f = featureEdit;
  const url = mode === 'create' ? '/api/features-edit-access' : `/api/features/${encodeURIComponent(id)}/definition`;
  fetch(url, { cache: 'no-store' }).then(async (res) => {
    const body = await res.json();
    if (featureEdit !== f) return;
    f.loading = false;
    if (!res.ok) { f.missing = body.error || `HTTP ${res.status}`; return render(); }
    if (mode === 'create') f.def = { access: body };
    else { f.def = body; f.draft = structuredClone(body.draft); f.base = structuredClone(body.draft); }
    render();
  }).catch((err) => { if (featureEdit === f) { f.loading = false; f.missing = err.message; render(); } });
}

// Messages for one field: validation errors and AI review findings that name it.
function editMessages(field) {
  const f = featureEdit;
  const errs = (f.errors || []).filter((e) => e.field === field);
  const ai = (f.preview?.review?.findings || []).filter((x) => x.field === field);
  if (!errs.length && !ai.length) return '';
  return `<div class="ferrs" id="err-${esc(field)}" role="alert">${errs.map((e) => `<p class="ferr">${esc(e.message)}</p>`).join('')}
    ${ai.map((x) => `<p class="${x.kind === 'contradiction' ? 'ferr' : 'fsug'}"><b>${x.kind === 'contradiction' ? 'Contradiction' : 'Suggestion'}:</b> ${esc(x.message)}${x.suggestion ? ` <span class="muted">${esc(x.suggestion)}</span>` : ''}</p>`).join('')}</div>`;
}
const editInvalid = (field) => ((featureEdit.errors || []).some((e) => e.field === field) || (featureEdit.preview?.review?.findings || []).some((x) => x.field === field && x.kind === 'contradiction')
  ? ` aria-invalid="true" aria-describedby="err-${esc(field)}"` : '');

function diffHtml(diff) {
  if (!diff?.length) return '<p class="muted">No field changed yet.</p>';
  const val = (v) => (v ? `<span class="dv">${esc(v)}</span>` : '<span class="muted">empty</span>');
  const KEY = { name: 'name', owner: 'owner', team: 'team', done_when: '“done when”' };
  return `<ul class="fdiff">${diff.map((d) => {
    if (d.added || d.removed) return `<li><b>${esc(d.label)}</b>${d.added.map((x) => ` <span class="dadd">+ ${esc(x)}</span>`).join('')}${d.removed.map((x) => ` <span class="ddel">− ${esc(x)}</span>`).join('')}</li>`;
    if (d.added_step) return `<li><b>${esc(d.label)}</b> <span class="dadd">new step</span> · owner ${val(d.to.owner)}${d.to.team ? ` · team ${val(d.to.team)}` : ''}</li>`;
    if (d.removed_step) return `<li><b>${esc(d.label)}</b> <span class="ddel">removed</span>${d.evidence ? ` <span class="muted small">(its ${d.evidence} linked PR, issue or ticket${d.evidence === 1 ? '' : 's'} go with it)</span>` : ''}</li>`;
    if (d.changes) return `<li><b>${esc(d.label)}</b><ul>${d.changes.map((c) => `<li>${esc(KEY[c.key] || c.key)}: ${val(c.from)} → ${val(c.to)}</li>`).join('')}${(d.attached || []).map((x) => `<li><span class="dadd">+ attach ${esc(x)}</span></li>`).join('')}</ul></li>`;
    if (Array.isArray(d.from) && / order$/.test(d.label)) return `<li><b>${esc(d.label)}</b> ${esc(d.from.join(' → '))} <span class="muted">becomes</span> ${esc(d.to.join(' → '))}</li>`;
    return `<li><b>${esc(d.label)}</b> ${val(d.from)} → ${val(d.to)}</li>`;
  }).join('')}</ul>`;
}

function reviewHtml(p) {
  if (!p) return '<p class="muted">Press <b>Review changes</b> to see what will change, check it against the definition rules and run the AI product review.</p>';
  const unplaced = (p.errors || []).filter((e) => !EDIT_FIELDS.some((rx) => rx.test(e.field)));
  const r = p.review;
  return `<div class="h">What will change</div>${p.errors?.length && !p.diff?.length ? '<p class="muted">Shown once the fields below are fixed.</p>' : diffHtml(p.diff)}
    ${p.stale ? `<div class="banner st-blocked tight" role="alert"><span class="ico">!</span><div>${esc(p.stale_message)}</div></div>` : ''}
    ${p.errors?.length ? `<div class="banner st-blocked tight" role="alert"><span class="ico">×</span><div><b>Can't publish yet.</b> ${p.errors.length === 1 ? 'One field needs' : `${p.errors.length} fields need`} fixing; each problem is shown next to its field.
      ${unplaced.length ? `<ul>${unplaced.map((e) => `<li><code>${esc(e.field)}</code> ${esc(e.message)}</li>`).join('')}</ul>` : ''}</div></div>` : ''}
    ${r ? `<div class="h">AI product review</div><div class="banner tight ${r.blocking ? 'st-blocked' : r.ran ? 'st-done' : 'st-unavailable'}"><span class="ico">${r.blocking ? '×' : r.ran ? '✓' : '!'}</span><div>${esc(r.note)}
      ${r.findings.length ? `<ul>${r.findings.map((x) => `<li><b>${esc(x.kind)}</b> · <code>${esc(x.field)}</code> ${esc(x.message)}</li>`).join('')}</ul>` : ''}</div></div>` : ''}`;
}
const EDIT_FIELDS = [/^id$/, /^name$/, /^owner$/, /^description$/, /^target_date$/, /^depends_on$/, /^services$/, /^flags$/, /^steps\[\d+\]\.(id|name|owner|team|done_when)$/, /^steps\[\d+\]\.evidence/];

// Jira keys typed into a step: the list, and the ones that aren't keys (checked here as you type,
// and again by the server).
const JIRA_KEY = /^[A-Z][A-Z0-9_]{0,29}-[1-9]\d{0,9}$/;
const jiraKeys = (text) => [...new Set(String(text || '').split(/[\s,]+/).map((x) => x.trim().toUpperCase()).filter(Boolean))];
const badJira = (text) => jiraKeys(text).filter((k) => !JIRA_KEY.test(k));
const editInvalidPrefix = (prefix) => (featureEdit.errors || []).some((e) => e.field.startsWith(prefix));
function jiraMessages(at, text) {
  const bad = badJira(text);
  const errs = (featureEdit.errors || []).filter((e) => e.field.startsWith(`${at}.evidence`));
  if (!bad.length && !errs.length) return '';
  return `<div class="ferrs" id="err-${esc(at)}-jira" role="alert">${bad.length ? `<p class="ferr">Not a Jira ticket key: ${esc(bad.join(', '))} (expected something like ABC-123).</p>` : ''}${errs.map((e) => `<p class="ferr">${esc(e.message)}</p>`).join('')}</div>`;
}

function stepRow(s, i, n) {
  const at = `steps[${i}]`;
  return `<li class="estep" data-step="${i}"><input type="hidden" name="step_id" value="${esc(s.id || '')}">
    <div class="estep-h"><span class="num">${i + 1}</span><label class="grow">Step name<input name="step_name" value="${esc(s.name)}"${editInvalid(`${at}.name`)}></label>
      <div class="estep-a"><button type="button" class="btn small" data-step-move="${i}:-1" ${i === 0 ? 'disabled' : ''} aria-label="Move step ${i + 1} up">↑</button>
        <button type="button" class="btn small" data-step-move="${i}:1" ${i === n - 1 ? 'disabled' : ''} aria-label="Move step ${i + 1} down">↓</button>
        <button type="button" class="btn small" data-step-remove="${i}" aria-label="Remove step ${i + 1}">Remove</button></div></div>
    ${editMessages(`${at}.name`)}${editMessages(`${at}.id`)}
    <div class="row3"><label>Owner <span class="req">required</span><input name="step_owner" value="${esc(s.owner)}" placeholder="@handle or team"${editInvalid(`${at}.owner`)}></label>
      <label>Team <span class="muted small">optional</span><input name="step_team" value="${esc(s.team)}" placeholder="Catalog team"${editInvalid(`${at}.team`)}></label></div>
    ${editMessages(`${at}.owner`)}${editMessages(`${at}.team`)}
    <label>Done when <span class="req">required</span><textarea name="step_done_when" rows="2" placeholder="The endpoint is merged to main with tests."${editInvalid(`${at}.done_when`)}>${esc(s.done_when)}</textarea></label>
    ${editMessages(`${at}.done_when`)}
    ${s.linked?.length ? `<p class="muted small">Linked: ${s.linked.map((x) => `<span class="mono">${esc(x)}</span>`).join(', ')} <span class="muted">(kept as they are)</span></p>`
      : s.evidence ? `<p class="muted small">${s.evidence} linked PR, issue or ticket${s.evidence === 1 ? '' : 's'} kept as they are.</p>` : ''}
    <label>Link Jira tickets <span class="muted small">optional, comma separated</span><input name="step_jira" value="${esc(s.add_jira || '')}" placeholder="ABC-123, ABC-124" class="mono" autocapitalize="characters" spellcheck="false"${badJira(s.add_jira).length || editInvalidPrefix(`${at}.evidence`) ? ` aria-invalid="true" aria-describedby="err-${esc(at)}-jira"` : ''}>
      <span class="muted small">The step counts as done when every linked ticket is Done or Closed (and every linked PR or issue is done).</span></label>
    ${jiraMessages(at, s.add_jira)}</li>`;
}

function renderFeatureEdit(mode, id, project = '') {
  openFeatureEdit(mode, id, project);
  const f = featureEdit;
  const back = mode === 'create' ? (project ? projHref(project) : '#/roadmap') : href(id);
  if (f.loading) return '<div class="card empty"><strong>Loading the definition…</strong></div>';
  if (f.missing) return `<div class="card empty"><strong>This feature can't be edited here</strong>${esc(f.missing)} <a href="${back}">Back</a></div>`;
  const access = f.def.access;
  const kind = 'feature';
  const title = mode === 'create' ? `New ${kind}` : esc(snapshot.features.find((x) => x.feature.id === id)?.feature.name || id);
  if (!access.can_edit) {
    return `<p class="kicker">${mode === 'create' ? `Add a ${kind}` : `Edit ${kind}`}</p><h1>${title}</h1>
      <div class="banner st-unavailable section" role="status"><span class="ico">!</span><div><b>You can view this feature but not change it.</b> ${esc(access.reason)}</div></div>
      <p class="section"><a class="btn" href="${back}">Back</a></p>`;
  }
  const d = f.draft;
  const target = snapshot.definitions.source.startsWith('local:') ? 'the local data folder' : `the shared repo (${esc(snapshot.definitions.source.replace(/^github:/, '').replace(/@.*$/, ''))})`;
  const res = f.result;
  const resultBox = !res ? '' : `<div class="banner ${res.outcome === 'conflict' || res.outcome === 'invalid' || res.outcome === 'read_only' ? 'st-blocked' : 'st-unavailable'}" role="alert">
      <span class="ico">!</span><div><b>${esc({ conflict: 'Not published: someone else changed this feature', invalid: "Can't publish yet", read_only: 'Read-only' }[res.outcome] || 'Not published')}</b> ${esc(res.message || '')}
      ${res.outcome === 'conflict' && mode === 'update' ? '<div class="factions tight"><button type="button" class="btn small primary" data-edit-rebase>Apply my edit to the latest version</button></div>' : ''}</div></div>`;
  const others = [...snapshot.features].filter((x) => x.feature.id !== id).sort((a, b) => a.feature.name.localeCompare(b.feature.name));
  const pending = mode === 'update' ? (f.def.pending || []) : [];
  const services = snapshot.services || [];
  const fresh = f.preview && f.previewKey === JSON.stringify(f.draft);
  const canPublish = fresh && f.preview.valid && !f.preview.stale && !f.preview.review?.blocking && (mode === 'create' || f.preview.diff.length);
  return `<p class="kicker">${mode === 'create' ? `Add a ${kind}` : `Edit ${kind}`}</p><h1>${title}</h1>
    <p class="lede">${`Publishing commits this definition straight to ${target} as your GitHub user. Every teammate's LifeCycle shows it on their next refresh. Status isn't edited here: it always comes from the live reads.`}</p>
    ${mode === 'create' ? termsHelp({ open: true }) : ''}
    ${pending.length ? `<div class="banner st-unavailable" role="status"><span class="ico">!</span><div><b>${pending[0].state === 'conflict' ? 'An earlier edit was refused because of a conflict' : 'An earlier edit is not published yet'}.</b> It is kept on this machine: ${esc(pending[0].message || 'waiting for the shared repo')}</div></div>` : ''}
    ${resultBox}
    <form id="featureform" class="cform section" novalidate>
      <div class="two">
        <div class="card fbox">
          <label>Name <span class="req">required</span><input name="name" value="${esc(d.name)}"${mode === 'create' ? ' placeholder="Redeem rewards" autocomplete="off"' : ''}${editInvalid('name')}></label>${editMessages('name')}
          ${mode === 'create' ? `<label>Feature id <span class="muted small">suggested from the name</span><input name="id" value="${esc(d.id)}" placeholder="redeem-rewards" class="mono"${editInvalid('id')}>
            <span class="muted small">Lowercase letters, digits and dashes. It names the file (features/&lt;id&gt;.yaml) and can't be changed later.</span></label>${editMessages('id')}` : ''}
          <div class="row3"><label>Owner <span class="req">required</span><input name="owner" value="${esc(d.owner)}" placeholder="Mobile team or @handle"${editInvalid('owner')}></label>
            <label>Target date <span class="muted small">optional</span><input type="date" name="target_date" value="${esc(d.target_date)}"${editInvalid('target_date')}></label></div>
          ${editMessages('owner')}${editMessages('target_date')}
          <label>Project <span class="muted small">optional</span><select name="project"${editInvalid('project')}>
            <option value=""${d.project ? '' : ' selected'}>No project</option>
            ${[...snapshot.projects].filter((p) => p.project.id).sort((a, b) => a.project.name.localeCompare(b.project.name))
              .map((p) => `<option value="${esc(p.project.id)}"${d.project === p.project.id ? ' selected' : ''}>${esc(p.project.name)}</option>`).join('')}
            ${d.project && !snapshot.projects.some((p) => p.project.id === d.project) ? `<option value="${esc(d.project)}" selected>${esc(d.project)} (not a defined project)</option>` : ''}
          </select></label>${editMessages('project')}
          <label>Description <span class="muted small">optional</span><textarea name="description" rows="2"${editInvalid('description')}>${esc(d.description)}</textarea></label>${editMessages('description')}
          <fieldset class="fld"><legend>Depends on <span class="muted small">features that must be done first</span></legend>
            <ul class="fpick"${editInvalid('depends_on')}>${others.map((x) => `<li><label><input type="checkbox" name="depends_on" value="${esc(x.feature.id)}"${d.depends_on.includes(x.feature.id) ? ' checked' : ''}>
              <span>${esc(x.feature.name)}</span><span class="muted small mono">${esc(x.feature.id)}</span></label></li>`).join('')}
              ${d.depends_on.filter((x) => !others.some((o) => o.feature.id === x)).map((x) => `<li><label><input type="checkbox" name="depends_on" value="${esc(x)}" checked><span class="mono">${esc(x)}</span><span class="muted small">not a defined feature</span></label></li>`).join('')}</ul>
            ${editMessages('depends_on')}
          </fieldset>
          <div class="row3"><label>Services <span class="muted small">comma separated</span><input name="services" value="${esc(d.services.join(', '))}" list="svc-ids" placeholder="catalog-api"${editInvalid('services')}></label>
            <label>Flags <span class="muted small">comma separated</span><input name="flags" value="${esc(d.flags.join(', '))}" placeholder="redeem_rewards"${editInvalid('flags')}></label></div>
          <datalist id="svc-ids">${services.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</datalist>
          ${editMessages('services')}${editMessages('flags')}
          <fieldset class="fld"><legend>Steps <span class="muted small">in the order the work happens</span></legend>
            <ol class="esteps">${d.steps.map((s, i) => stepRow(s, i, d.steps.length)).join('')}</ol>${editMessages('steps')}
            <div><button type="button" class="btn small" data-step-add>Add step</button></div>
          </fieldset>
          <div class="factions"><button class="btn" type="submit" data-edit-review${f.busy ? ' disabled' : ''}>Review changes</button>
            <button class="btn primary" type="button" data-edit-publish${canPublish && !f.busy ? '' : ' disabled'}>Publish</button>
            <a class="btn" href="${back}">Cancel</a>
            ${mode === 'update' ? `<button type="button" class="btn danger" data-edit-delete${f.busy ? ' disabled' : ''}>Delete ${kind}</button>` : ''}</div>
          ${!canPublish ? '<p class="muted small" id="publish-hint">Review your changes first; Publish turns on when the definition is valid and nothing blocks it.</p>' : ''}
        </div>
        <div class="side"><div class="card deps freview" aria-live="polite">${fresh || !f.preview ? reviewHtml(fresh ? f.preview : null) : '<p class="muted">You changed the form since the last review. Press <b>Review changes</b> again.</p>'}</div>
          ${mode === 'update' && f.def.dependents?.length ? `<p class="muted small">Depended on by ${esc(f.def.dependents.map((x) => x.name).join(', '))}.</p>` : ''}</div>
      </div>
    </form>`;
}

function readFeatureForm(form) {
  const fd = new FormData(form);
  const list = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
  const steps = [...form.querySelectorAll('[data-step]')].map((li, i) => {
    const v = (n) => li.querySelector(`[name="${n}"]`)?.value || '';
    const old = featureEdit.draft.steps[i] || {};
    const jira = v('step_jira');
    return { id: v('step_id') || slugify(v('step_name')), name: v('step_name'), owner: v('step_owner'), team: v('step_team'), done_when: v('step_done_when'),
      evidence: old.evidence || 0, linked: old.linked || [], add_jira: jira,
      add_evidence: jiraKeys(jira).map((key) => ({ source: 'jira', type: 'ticket', key })) };
  });
  return {
    id: featureEdit.mode === 'create' ? String(fd.get('id') || '').trim() : featureEdit.id,
    name: fd.get('name') || '', owner: fd.get('owner') || '', description: fd.get('description') || '', project: fd.get('project') || '', target_date: fd.get('target_date') || '',
    depends_on: fd.getAll('depends_on'), services: list(fd.get('services')), flags: list(fd.get('flags')), steps,
  };
}

// After a conflict: the fields this person changed, applied to the latest version of the feature.
function rebaseDraft(mine, original, latest) {
  const out = structuredClone(latest);
  for (const k of ['name', 'owner', 'description', 'project', 'target_date', 'depends_on', 'services', 'flags', 'steps']) {
    if (JSON.stringify(mine[k]) !== JSON.stringify(original[k])) out[k] = structuredClone(mine[k]);
  }
  return out;
}

async function previewFeature() {
  const f = featureEdit;
  f.busy = true;
  render();
  try {
    f.preview = await post('/api/features/preview', { mode: f.mode, id: f.id, draft: f.draft, base_hash: f.def.base_hash });
    f.errors = f.preview.errors || [];
    f.previewKey = JSON.stringify(f.draft);
  } catch (err) {
    f.preview = null;
    f.result = { outcome: 'invalid', message: `LifeCycle couldn't check the definition: ${err.message}` };
  }
  f.busy = false;
  if (featureEdit === f) render();
}

async function sendFeature(url, method, body) {
  try {
    const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return await res.json();
  } catch (err) {
    return { outcome: 'not_published', message: `LifeCycle couldn't be reached: ${err.message}` };
  }
}

async function finishFeatureEdit(r, goTo) {
  const f = featureEdit;
  if (['published', 'queued', 'not_published'].includes(r.outcome)) {
    // A refused (conflict) copy of this edit, kept on this machine, is now superseded.
    for (const e of f.def?.pending || []) if (e.state === 'conflict') await post(`/api/features-outbox/${encodeURIComponent(e.key)}/discard`).catch(() => {});
    featureEdit = null;
    location.hash = goTo;
    await load();
    const ok = r.outcome === 'published';
    // Kept across re-renders of this page (alerts and access load after it), cleared on navigation.
    featureFlash = { hash: location.hash, html: `<div class="banner ${ok ? 'st-done' : 'st-unavailable'}" role="status"><span class="ico">${ok ? '✓' : '!'}</span><div><b>${ok ? (r.op === 'delete' ? 'Deleted' : 'Published') : 'Not published yet'}</b> ${esc(r.message)}</div></div>` };
    render();
    return;
  }
  f.result = r;
  f.errors = r.errors || f.errors;
  if (r.review) f.preview = { ...(f.preview || {}), review: r.review };
  if (r.outcome === 'conflict') {
    // Keep the form as it is: nothing the person typed is lost.
    try { f.def.pending = (await (await fetch(`/api/features/${encodeURIComponent(f.id)}/definition`, { cache: 'no-store' })).json()).pending || f.def.pending; } catch { /* keep */ }
  }
  f.busy = false;
  render();
  $('#main [aria-invalid="true"]')?.focus();
}

function wireFeatureEdit(root) {
  const form = root.querySelector('#featureform');
  if (!form) return;
  const f = featureEdit;
  const sync = () => {
    f.draft = readFeatureForm(form);
    const stale = !f.preview || f.previewKey !== JSON.stringify(f.draft);
    const pub = form.querySelector('[data-edit-publish]');
    if (stale && pub) pub.disabled = true;
    if (stale && f.preview) form.querySelector('.freview').innerHTML = '<p class="muted">You changed the form since the last review. Press <b>Review changes</b> again.</p>';
  };
  // New feature: the id follows the name until the person edits the id themselves (as for projects).
  if (f.mode === 'create') {
    const idField = form.querySelector('[name="id"]');
    form.querySelector('[name="name"]').addEventListener('input', (e) => {
      if (!f.idTouched) idField.value = slugify(e.target.value);
    });
    idField.addEventListener('input', () => { f.idTouched = idField.value.trim() !== ''; });
  }
  form.addEventListener('input', sync);
  form.addEventListener('change', sync);
  form.addEventListener('submit', (e) => { e.preventDefault(); sync(); previewFeature(); });
  form.querySelector('[data-step-add]')?.addEventListener('click', () => {
    sync();
    f.draft.steps.push({ id: '', name: '', owner: '', team: '', done_when: '', evidence: 0, linked: [], add_jira: '', add_evidence: [] });
    render();
    $('#main [data-step]:last-of-type [name="step_name"]')?.focus();
  });
  form.querySelectorAll('[data-step-remove]').forEach((b) => b.addEventListener('click', () => {
    sync();
    const i = Number(b.dataset.stepRemove);
    const s = f.draft.steps[i];
    if (s.evidence && !confirm(`Remove step "${s.name}"? Its ${s.evidence} linked PR, issue or ticket${s.evidence === 1 ? '' : 's'} will be removed from the definition too.`)) return;
    f.draft.steps.splice(i, 1);
    render();
  }));
  form.querySelectorAll('[data-step-move]').forEach((b) => b.addEventListener('click', () => {
    sync();
    const [i, by] = b.dataset.stepMove.split(':').map(Number);
    const s = f.draft.steps;
    [s[i], s[i + by]] = [s[i + by], s[i]];
    render();
  }));
  form.querySelector('[data-edit-publish]')?.addEventListener('click', async () => {
    sync();
    f.busy = true;
    render();
    const r = f.mode === 'create'
      ? await sendFeature('/api/features', 'POST', { draft: f.draft })
      : await sendFeature(`/api/features/${encodeURIComponent(f.id)}`, 'PUT', { draft: f.draft, base_hash: f.def.base_hash });
    const id = f.mode === 'create' ? f.draft.id : f.id;
    await finishFeatureEdit(r, href(id));
  });
  form.querySelector('[data-edit-delete]')?.addEventListener('click', async () => {
    const name = f.base?.name || f.id;
    const ask = (dependents) => (dependents.length
      ? confirm(`These features depend on ${name}:\n\n${dependents.map((x) => `• ${x.name} (${x.id}), owner ${x.owner}`).join('\n')}\n\nDeleting it leaves them with an unknown dependency. Delete ${name} anyway?`)
      : confirm(`Delete ${name}? Its definition file is removed from the shared repo for everyone.`));
    // The dependents are listed before anything is sent; the server checks again when it deletes.
    if (!ask(f.def.dependents || [])) return;
    f.busy = true;
    render();
    let r = await sendFeature(`/api/features/${encodeURIComponent(f.id)}/delete`, 'POST', { base_hash: f.def.base_hash, confirm_dependents: Boolean(f.def.dependents?.length) });
    if (r.outcome === 'has_dependents') {
      if (!ask(r.dependents)) { f.busy = false; return render(); }
      r = await sendFeature(`/api/features/${encodeURIComponent(f.id)}/delete`, 'POST', { base_hash: f.def.base_hash, confirm_dependents: true });
    }
    await finishFeatureEdit(r, '#/roadmap');
  });
  root.querySelector('[data-edit-rebase]')?.addEventListener('click', async () => {
    const res = await fetch(`/api/features/${encodeURIComponent(f.id)}/definition`, { cache: 'no-store' });
    const latest = await res.json();
    if (!res.ok) { f.result = { outcome: 'conflict', message: latest.error }; return render(); }
    f.draft = rebaseDraft(f.draft, f.base, latest.draft);
    f.def = latest;
    f.base = structuredClone(latest.draft);
    f.result = null;
    f.preview = null;
    render();
    previewFeature();
  });
}

// On the feature page: the edit entry point, or why this person can't edit; and edits kept locally.
function featureEditBar(f) {
  const pending = (snapshot.feature_outbox || []).filter((e) => e.feature_id === f.feature.id);
  const label = { pending: 'Your edit is not published yet', conflict: 'Your edit was not published: conflict', failed: 'Your edit is not published yet' };
  const bar = pending.map((e) => `<div class="banner st-unavailable" role="status"><span class="ico">!</span><div><b>${esc(label[e.state] || e.state)}.</b> ${esc(e.message || 'Waiting for the shared repo.')}
      It is kept on this machine${e.state === 'pending' ? ' and will be published once the shared repo is reachable' : ''}.
      <div class="factions tight">${e.state === 'conflict' ? `<a class="btn small primary" href="${href(f.feature.id)}/edit">Open the latest version</a>` : '<button type="button" class="btn small" data-fretry>Retry now</button>'}
      <button type="button" class="btn small" data-fdiscard="${esc(e.key)}">Discard</button></div></div></div>`).join('');
  const ro = editAccess && !editAccess.can_edit ? `<p class="f-ro muted small" role="note"><b>Read-only.</b> ${esc(editAccess.reason)}</p>` : '';
  return bar + ro;
}
// projectId: open the form with that project chosen (on a project's page).
const newFeatureButton = (projectId = null) => (editAccess?.can_edit ? `<a class="btn primary" href="#/features/new${projectId ? `?project=${encodeURIComponent(projectId)}` : ''}">New feature</a>`
  : editAccess ? `<p class="muted small f-ro" role="note"><b>Read-only.</b> ${esc(editAccess.reason)}</p>` : '');
const editButton = (f) => (editAccess?.can_edit ? `<a class="btn small" href="${href(f.feature.id)}/edit">Edit feature</a>` : '');

function wireFeatureOutbox(root) {
  root.querySelectorAll('[data-fretry]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    await post('/api/features-outbox/retry').catch(() => {});
    await load();
  }));
  root.querySelectorAll('[data-fdiscard]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Discard this edit? It has not been published and will be lost.')) return;
    await post(`/api/features-outbox/${encodeURIComponent(b.dataset.fdiscard)}/discard`).catch(() => {});
    await load();
  }));
}

function renderTeam(id) {
  if (teamDefs?.teams.some((t) => t.id === id)) return renderDefinedTeam(id);
  return `<p class="kicker">Team</p><h1>${esc(id)}</h1><div class="card empty section"><strong>No team "${esc(id)}"</strong>No team with this id is defined in the shared repo (teams/). <a href="#/teams">All teams</a></div>`;
}

// =====================================================================================
// Flow views: Home (recap), Roadmap (lanes per team), Feature (graph + path), Teams (graph /
// matrix), Alerts board and cited answers. Visual first; long text lives in the drawer, folds and
// tooltips. Like the rest of the page they only render what the API returns.
// =====================================================================================

const TONE = { blocked: 'var(--destructive)', done: 'var(--success)', flowing: 'var(--primary)', in_progress: 'var(--primary)', risk: 'var(--warning)',
  unavailable: 'var(--warning)', not_started: 'var(--muted-foreground)', unknown: 'var(--muted-foreground)', no_access: 'var(--warning)' };
const toneOf = (f) => (f.state !== 'blocked' && f.delay?.at_risk ? 'risk' : f.state);
const fpill = (state, label) => `<span class="f-pill" style="--s:${TONE[state] || TONE.unknown}">${esc(label || (state === 'risk' ? 'At risk' : LABEL[state] || state))}</span>`;
const byFeature = () => new Map(snapshot.features.map((f) => [f.feature.id, f]));
const dayMs = 864e5;
// A plain date ("2027-01-31", e.g. a target date) is that calendar day here, not midnight UTC
// (which shows as the day before west of Greenwich).
const fmtDay = (iso) => new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00` : iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
const stat = (n, label, tone) => `<span class="f-stat"${tone ? ` style="--s:${TONE[tone]}"` : ''}><b data-n="${esc(n)}">${n}</b>${esc(label)}</span>`;
const seenStats = new Map(); // "route|label" -> last number shown
function countUp(root, routeKey) {
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  for (const b of root.querySelectorAll('.f-stat b[data-n]')) {
    const to = Number(b.dataset.n);
    const key = `${routeKey}|${b.nextSibling?.textContent || ''}`;
    const seen = seenStats.get(key);
    const now = performance.now();
    // A change keeps rolling across the quick re-render that follows a refresh.
    const entry = !seen ? { value: to, from: to, at: -Infinity } : seen.value !== to ? { value: to, from: seen.value, at: now } : seen;
    seenStats.set(key, entry);
    if (!Number.isFinite(to) || entry.from === to || now - entry.at > 600 || still) continue;
    const from = entry.from, t0 = entry.at, dur = 600;
    b.classList.add('rolling');
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - (1 - k) ** 3;
      b.textContent = Math.round(from + (to - from) * e);
      if (k < 1) requestAnimationFrame(step); else b.classList.remove('rolling');
    };
    requestAnimationFrame(step);
  }
}
const pchip = (owner) => `<span class="f-pchip">${avatar(owner)}${esc(owner)}</span>`;
const fhead = (crumb, title, stats = '') => `<div class="f-head"><div>${crumb ? `<p class="kicker">${crumb}</p>` : ''}<h1>${title}</h1></div><div class="f-stats">${stats}</div></div>`;

// ---------- graph renderer (nodes + routed edges, pulses on blocking/held links) ----------
const GLYPH = {
  feature: 'M12 3l8 4.5v9L12 21l-8-4.5v-9z M12 12l8-4.5 M12 12v9 M12 12L4 7.5',
  team: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M3.5 19c.5-3 2.6-4.6 5.5-4.6s5 1.6 5.5 4.6 M16 10.5a2.5 2.5 0 1 0 0-5 M17 14.5c2 .3 3.3 1.8 3.6 4.5',
  source: 'M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z M12 8.5v7 M8.8 10.2l6.4 3.6 M15.2 10.2l-6.4 3.6',
};
const SVGNS = 'http://www.w3.org/2000/svg';
function sel(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}
function route(a, b) {
  const x1 = a.x + a.r, y1 = a.y, x2 = b.x - b.r, y2 = b.y;
  if (Math.abs(y1 - y2) < 1) return `M${x1},${y1} H${x2}`;
  const xm = (x1 + x2) / 2, r = Math.min(12, Math.abs(y2 - y1) / 2), dy = y2 > y1 ? 1 : -1;
  return `M${x1},${y1} H${xm - r} Q${xm},${y1} ${xm},${y1 + r * dy} V${y2 - r * dy} Q${xm},${y2} ${xm + r},${y2} H${x2}`;
}
// graph: { cols: [{ x, t }], nodes: [{ id, x, y, kind, label, sub, tone, size, halo, right }], edges: [{ from, to, kind }] }
function drawGraph(svg, graph, onSelect, selected) {
  svg.innerHTML = '';
  for (const c of graph.cols) sel('text', { x: c.x, y: 28, class: 'f-colhead', 'text-anchor': 'middle' }, svg).textContent = c.t;
  const nodes = Object.fromEntries(graph.nodes.map((n) => [n.id, { ...n, r: (n.size || 48) / 2 }]));
  const eg = sel('g', {}, svg);
  graph.edges.forEach((e, i) => {
    if (!nodes[e.from] || !nodes[e.to]) return;
    const d = route(nodes[e.from], nodes[e.to]);
    sel('path', { d, class: `f-edge ${e.kind || ''}` }, eg);
    if (e.kind === 'block' || e.kind === 'hold') {
      const p = sel('circle', { r: 3.4, class: 'f-pulse', style: `--c:${e.kind === 'block' ? TONE.blocked : TONE.risk}` }, eg);
      sel('animateMotion', { dur: e.kind === 'block' ? '1.8s' : '2.6s', repeatCount: 'indefinite', path: d, begin: `${(i % 4) * 0.5}s` }, p);
    }
  });
  const ng = sel('g', {}, svg);
  for (const n of Object.values(nodes)) {
    const s = n.size || 48, h = s / 2;
    const g = sel('g', { class: `f-node${n.id === selected ? ' sel' : ''}`, tabindex: 0, role: 'button', 'aria-label': `${n.label}: ${n.sub || ''}`,
      transform: `translate(${n.x},${n.y})`, style: `--c:${TONE[n.tone] || TONE.unknown}`, 'data-id': n.id }, ng);
    if (n.halo) sel('rect', { x: -h - 9, y: -h - 9, width: s + 18, height: s + 18, rx: 20, class: 'f-halo' }, g);
    sel('rect', { x: -h, y: -h, width: s, height: s, rx: n.kind === 'team' ? h : 13, class: 'f-tile' }, g);
    const k = (s * 0.42) / 24;
    sel('path', { d: GLYPH[n.kind] || GLYPH.feature, class: 'f-glyph', transform: `translate(${-12 * k},${-12 * k}) scale(${k})`, 'stroke-width': 1.6 / k }, g);
    if (n.tone) sel('circle', { cx: h - 3, cy: -h + 3, r: 5, class: 'f-ndot' }, g);
    const lab = (txt, y, cls, x) => {
      const t = sel('text', x !== undefined ? { x, y, class: cls, style: 'text-anchor:start' } : { y, class: cls }, g);
      t.textContent = txt.length > 26 ? `${txt.slice(0, 25)}…` : txt;
      if (txt.length > 26) sel('title', {}, t).textContent = txt;
    };
    if (n.right) { lab(n.label, -2, 'f-lbl', h + 10); lab(n.sub || '', 13, `f-sub${n.subTone ? ' c' : ''}`, h + 10); } else { lab(n.label, h + 17, 'f-lbl'); lab(n.sub || '', h + 31, `f-sub${n.subTone ? ' c' : ''}`); }
    const pick = () => { svg.querySelectorAll('.f-node').forEach((x) => x.classList.toggle('sel', x === g)); onSelect(n.id); };
    g.addEventListener('click', pick);
    g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); } });
  }
}
const column = (ids, x, top, gap) => ids.map((id, i) => ({ id, x, y: top + i * gap }));
const spread = (n, height, top = 64) => (n === 0 ? [] : n === 1 ? [top + (height - top - 40) / 2] : Array.from({ length: n }, (_, i) => top + 16 + (i * (height - top - 80)) / (n - 1)));

// ---------- HOME ----------
function rootBlockers() {
  const byKey = new Map();
  for (const f of snapshot.features) {
    for (const b of f.blockers) {
      const key = b.kind === 'dependency' ? `${b.feature}:${b.step}` : `${b.kind}:${f.feature.id}`;
      if (!byKey.has(key)) byKey.set(key, { ...b, blocks: [] });
      byKey.get(key).blocks.push(f.feature);
    }
  }
  return [...byKey.values()].filter((b) => b.kind !== 'dependency' || !b.via?.length);
}

// A last-mile label for a card. "Status unavailable" never stands alone: it says which source
// couldn't be read (or which definition is missing) and when it was last read successfully.
const LM_SOURCE = { github: 'GitHub', statsig: 'Statsig', flagsmith: 'Flagsmith', definitions: 'the shared repo' };
function lmMeta(lm, fallback = 'done') {
  if (!lm) return `<span class="muted">${esc(fallback)}</span>`;
  if (lm.state !== 'unavailable') return lm.state === 'fully_on' ? esc(lm.label) : `<span class="muted">${esc(lm.label)}</span>`;
  const def = lm.reasons.find((r) => r.source === 'definitions');
  const read = [...new Set(lm.reasons.filter((r) => r.source !== 'definitions').map((r) => LM_SOURCE[r.source] || r.source))];
  const why = def ? def.message.replace(/^[^:]*: /, '') : `${read.join(' and ')} couldn't be read · last read ${ago(lm.last_successful_read_at)}`;
  return `<span class="muted" title="${esc(lm.reasons.map((r) => r.message).join('\n'))}">Status unavailable · ${esc(why)}</span>`;
}

function homeItem({ icon, tone, title, meta, right, actions = '', href: link }) {
  return `<div class="f-item"><div class="t"><span class="ic" style="--s:${TONE[tone]}">${icon}</span>${link ? `<a href="${escUrl(link)}">${esc(title)}</a>` : esc(title)}</div>
    <div class="m"><span class="why" style="--s:${TONE[tone]}">${meta}</span><span>${right || ''}</span></div>${actions ? `<div class="a">${actions}</div>` : ''}</div>`;
}

function renderHome() {
  const fs = snapshot.features;
  if (!fs.length && !snapshot.projects.length) {
    return `${fhead('LifeCycle', 'Home')}<div class="card empty section"><strong>No projects or features defined yet</strong>Add files under <code>projects/</code> and <code>features/</code> in <code>${esc(snapshot.definitions.source)}</code> and refresh.</div>`;
  }
  const needs = [];
  for (const b of rootBlockers().filter((x) => !featureArchived(x.blocks?.[0]?.id ?? x.feature))) {
    // Listed by the feature that is blocked, then what it waits on and who can unblock it.
    needs.push(homeItem(b.kind === 'dependency'
      ? { icon: '!', tone: 'blocked', title: b.blocks.map((x) => x.name).join(', '), href: href(b.blocks[0].id),
        meta: `waits on ${b.step_name ? `“${esc(b.step_name)}” in ` : ''}<a href="${href(b.feature)}">${esc(b.feature_name)}</a>`, right: b.evidence[0] ? esc(b.evidence[0].label.replace(/ in .*/, '')) : '', actions: pchip(b.owner) }
      : { icon: '×', tone: 'blocked', title: `Fix ${b.blocks[0].name}`, href: href(b.blocks[0].id), meta: esc(LABEL[b.kind] || b.kind.replace(/_/g, ' ')), actions: pchip(b.owner) }));
  }
  for (const f of fs.filter((x) => x.last_mile?.done_but_not_turned_on)) {
    needs.push(homeItem({ icon: '⏻', tone: 'risk', title: `Turn on ${f.feature.name}`, href: href(f.feature.id), meta: 'done but not turned on', right: esc(f.last_mile.label) }));
  }
  const risky = fs.filter((f) => !featureArchived(f.feature.id) && toneOf(f) === 'risk').map((f) => homeItem({ icon: '↘', tone: 'risk', title: f.feature.name, href: href(f.feature.id),
    meta: `${f.delay.days_left < 0 ? `${-f.delay.days_left} days late` : `${f.delay.days_left} days left`} · ${plural(f.delay.open_steps.length, 'open step')}`,
    right: f.feature.target_date ? `target ${esc(fmtDay(f.feature.target_date))}` : '' }));
  const recent = fs.filter((f) => !featureArchived(f.feature.id) && f.state === 'done' && f.timeline?.finished && Date.now() - Date.parse(f.timeline.finished) < 14 * dayMs)
    .sort((a, b) => b.timeline.finished.localeCompare(a.timeline.finished))
    .map((f) => homeItem({ icon: '✓', tone: 'done', title: f.feature.name, href: href(f.feature.id), meta: lmMeta(f.last_mile), right: esc(fmtDay(f.timeline.finished)) }));
  const lane = (title, items, empty) => `<div class="f-lane"><h3>${title}<b>${items.length}</b></h3>${items.join('') || `<p class="f-none">${empty}</p>`}</div>`;
  const blocked = fs.filter((f) => f.state === 'blocked').length;
  const byId = byFeature();
  const ring = (p) => {
    const segs = p.features.map((id) => byId.get(id)).filter(Boolean);
    const r = 17, c = 2 * Math.PI * r, gap = segs.length > 1 ? 2.2 : 0, len = segs.length ? c / segs.length - gap : c;
    const arcs = (segs.length ? segs : [{ state: 'not_started' }]).map((f, i) => `<circle r="${r}" cx="22" cy="22" fill="none" stroke="${TONE[f.feature ? toneOf(f) : f.state]}" stroke-width="4"
      stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-(i * (len + gap))}" transform="rotate(-90 22 22)"><title>${esc(f.feature?.name || 'No features')}</title></circle>`).join('');
    return `<svg width="44" height="44" viewBox="0 0 44 44" aria-hidden="true">${arcs}<text x="22" y="22" class="f-ringn">${segs.length}</text></svg>`;
  };
  const teamsOf = (p) => [...new Set(p.features.flatMap((id) => byId.get(id)?.steps.map((st) => st.team).filter(Boolean) || []))];
  const targets = (p) => p.features.map((id) => byId.get(id)?.feature.target_date).filter(Boolean).sort();
  const homeArchived = snapshot.projects.filter((p) => isArchived(p.project.id)).length;
  const projects = [...snapshot.projects].filter((p) => !isArchived(p.project.id)).sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state)).map((p) => `<a class="f-proj" href="${projHref(p.project.id)}">
      ${ring(p)}<div><div class="nm">${esc(p.project.name)}</div><div class="sub">${fpill(p.state)}${projectDue(p, targets(p)) ? `<span>due ${esc(fmtDay(projectDue(p, targets(p))))}</span>` : ''}
      ${p.blockers.length ? `<span>push ${esc([...new Set(p.blockers.map((b) => b.owner))].slice(0, 2).join(', '))}</span>` : ''}</div></div>
      <div class="f-tdots" title="Teams named on its steps">${teamsOf(p).slice(0, 4).map((t) => `<span>${esc(t.slice(0, 1))}</span>`).join('')}</div>${allDone(p) ? archiveButton(p, { suggest: true }) : ''}</a>`).join('')
    + (homeArchived ? `<p class="f-none arch-more">${plural(homeArchived, 'archived project')} hidden · find ${homeArchived === 1 ? 'it' : 'them'} under “Archived” in the sidebar.</p>` : '');
  return `${fhead('LifeCycle', 'Since your last look', stat(blocked, 'blocked', 'blocked') + stat(risky.length, 'at risk', 'risk') + stat(fs.filter((f) => f.last_mile?.state === 'fully_on').length, 'fully on', 'done'))}
    <section class="card f-recap" aria-label="Recap">
      <div class="f-board">${lane('Blocked', needs, 'Nothing is blocked.')}${lane('At risk', risky, 'No feature is at risk.')}${lane('Done in the last 2 weeks', recent, 'Nothing finished in the last two weeks.')}</div>
    </section>
    <div class="f-homegrid">
      <section class="card"><div class="f-cardh"><h2>Projects</h2><span class="f-src">one ring segment per feature</span></div><div class="f-projs">${projects || '<p class="f-none">No projects.</p>'}</div></section>
      ${askDigestCard()}
    </div>`;
}

// A project's due date: its own target_date when set, else its latest feature's target date.
const projectDue = (p, featureTargets) => p.project.target_date || featureTargets.at(-1) || null;

// ---------- ROADMAP: the person picks what to see, the time zoom and the level of detail ----------
// Grouped by project (for PMs) or by team (the teams named on the steps), with
// one summary bar per group that opens into its features, or feature by feature. Features with no
// linked PR or no target date are labelled as such instead of drawn as a short bar at "now".
const ZOOMS = {
  week: { label: 'Week', before: 1, after: 8 },
  month: { label: 'Month', before: 7, after: 35 },
  quarter: { label: 'Quarter', before: 14, after: 92 },
};
const LAST_PROJECT = 'lifecycle-last-project';
const dayStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
function rememberProject(r) {
  const id = r.route === 'project' ? r.id : r.route === 'feature' ? pid(projectOfFeature(r.id)?.project.id) : null;
  if (id && id !== 'undefined' && projectById(id)) try { localStorage.setItem(LAST_PROJECT, id); } catch { /* private mode */ }
}
// Default projects: the last one this person looked at, else one with a feature they follow or own.
function defaultRoadmapProjects() {
  let last = null;
  try { last = localStorage.getItem(LAST_PROJECT); } catch { /* private mode */ }
  if (last && projectById(last)) return { ids: [last], why: 'last project you looked at' };
  const mine = [...(digest?.features || []).map((f) => f.id), ...follows.follows];
  const p = mine.map(projectOfFeature).find(Boolean);
  return p ? { ids: [pid(p.project.id)], why: 'a project you follow' } : { ids: [], why: '' };
}
function roadmapTeams() {
  const by = new Map();
  for (const f of snapshot.features) {
    const names = [...new Set(f.steps.map((st) => st.team).filter(Boolean))];
    for (const n of names.length ? names : [f.feature.owner || 'No team']) {
      if (!by.has(n)) by.set(n, { id: n, name: n, features: [] });
      by.get(n).features.push(f.feature.id);
    }
  }
  return { source: 'steps', teams: [...by.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

function renderRoadmap() {
  const fs = snapshot.features;
  const pr = prefs('roadmap');
  const byId = byFeature();
  const def = pr.projects === null ? defaultRoadmapProjects() : null;
  const projSel = def ? def.ids : pr.projects;
  const { teams } = roadmapTeams();
  const teamOf = new Map();
  for (const t of teams) for (const id of t.features) teamOf.set(id, [...(teamOf.get(id) || []), t.id]);
  const projOf = (f) => pid(projectOfFeature(f.feature.id)?.project.id);
  const isRisk = (f) => toneOf(f) === 'risk';
  const keep = (f) => (projSel.length ? projSel.includes(projOf(f)) : !featureArchived(f.feature.id))
    && (!pr.teams.length || (teamOf.get(f.feature.id) || []).some((t) => pr.teams.includes(t)))
    && (!pr.features.length || pr.features.includes(f.feature.id))
    && (pr.only === 'all' || (pr.only === 'blocked' ? f.state === 'blocked' : pr.only === 'risk' ? isRisk(f) : f.state === 'blocked' || isRisk(f)));
  const shown = fs.filter(keep);

  // Filters, zoom and level of detail.
  const projOpts = snapshot.projects.map((p) => ({ value: pid(p.project.id), label: p.project.name, hint: `${featuresLabel(p.features.map((id) => byId.get(id)).filter(Boolean))}${isArchived(p.project.id) ? ' · archived' : ''}` }));
  const teamOpts = teams.map((t) => ({ value: t.id, label: t.name, hint: featuresLabel(t.features.map((id) => byId.get(id)).filter(Boolean)) }));
  // Features, grouped by team (searchable by team name) and narrowed to the teams picked, if any.
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const featOpts = fs.filter((f) => !pr.teams.length || (teamOf.get(f.feature.id) || []).some((t) => pr.teams.includes(t)))
    .map((f) => { const ts = (teamOf.get(f.feature.id) || []).map((t) => teamName.get(t) || t); return { value: f.feature.id, label: f.feature.name, group: ts[0] || 'No team', hint: ts.length > 1 ? `also ${ts.slice(1).join(', ')}` : '' }; })
    .sort((a, b) => (a.group === 'No team') - (b.group === 'No team') || a.group.localeCompare(b.group) || a.label.localeCompare(b.label));
  const controls = `<div class="vctl" role="group" aria-label="What to show">
      ${pickMenu({ id: 'rm-projects', label: 'Projects', options: projOpts, selected: projSel, view: 'roadmap', key: 'projects' })}
      ${pickMenu({ id: 'rm-teams', label: 'Teams', options: teamOpts, selected: pr.teams, view: 'roadmap', key: 'teams' })}
      ${pickMenu({ id: 'rm-features', label: 'Features', options: featOpts, selected: pr.features, view: 'roadmap', key: 'features', search: true })}
      ${segmented('Show only', 'roadmap', 'only', [['all', 'All'], ['blocked', 'Blocked'], ['risk', 'At risk'], ['either', 'Blocked or at risk']], pr.only)}
    </div>
    <div class="vctl" role="group" aria-label="How to show it">
      <span class="k" id="rm-zoom-k">Zoom</span>${segmented('Time zoom', 'roadmap', 'zoom', Object.entries(ZOOMS).map(([k, z]) => [k, z.label]), pr.zoom)}
      <span class="k">Group by</span>${segmented('Group by', 'roadmap', 'group', [['project', 'Project'], ['team', 'Team']], pr.group)}
    </div>`;
  const items = [
    ...projSel.map((id) => ({ label: `Project: ${projectById(id)?.project.name || id}${def ? ` (${def.why})` : ''}`, clear: { projects: projSel.filter((x) => x !== id) } })),
    ...pr.teams.map((id) => ({ label: `Team: ${teams.find((t) => t.id === id)?.name || id}`, clear: { teams: pr.teams.filter((x) => x !== id) } })),
    ...pr.features.map((id) => ({ label: `Feature: ${byId.get(id)?.feature.name || id}`, clear: { features: pr.features.filter((x) => x !== id) } })),
    ...(pr.only !== 'all' ? [{ label: { blocked: 'Blocked only', risk: 'At risk only', either: 'Blocked or at risk only' }[pr.only], clear: { only: 'all' } }] : []),
  ];
  const filters = activeFilters('roadmap', items, { projects: [], teams: [], features: [], only: 'all' });
  const blockedN = shown.filter((f) => f.state === 'blocked').length, riskN = shown.filter(isRisk).length;
  const head = fhead('Roadmap', 'Roadmap', stat(shown.length, shown.length === 1 ? 'feature' : 'features') + stat(blockedN, 'blocked', 'blocked') + stat(riskN, 'at risk', 'risk') + newFeatureButton());
  if (!fs.length) return `${head}<div class="card empty section"><strong>Nothing to place on the roadmap yet</strong>Features appear here once they're defined.</div>`;
  if (!shown.length) {
    return `${head}${controls}${filters}${filteredEmpty('roadmap', `Nothing among the ${featuresLabel(fs)} is in ${items.map((i) => i.label.toLowerCase()).join(' and ')}. Remove a filter above, or clear them all.`)}`;
  }

  // Time window for the zoom, around today.
  const now = Date.now();
  const z = ZOOMS[pr.zoom] || ZOOMS.month;
  const w0 = dayStart(now) - z.before * dayMs, w1 = dayStart(now) + z.after * dayMs;
  const pct = (t) => ((Math.min(w1, Math.max(w0, t)) - w0) / (w1 - w0)) * 100;
  const ticks = [];
  if (pr.zoom === 'week') for (let t = w0; t <= w1; t += dayMs) ticks.push({ t, label: new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric' }) });
  else if (pr.zoom === 'quarter') {
    for (let d = new Date(w0); d.getTime() <= w1; d.setMonth(d.getMonth() + 1, 1)) {
      const t = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
      if (t >= w0) ticks.push({ t, label: new Date(t).toLocaleDateString([], { month: 'short', year: t > w0 && new Date(t).getMonth() === 0 ? 'numeric' : undefined }) });
    }
  } else {
    const monday = dayStart(w0) + (((8 - new Date(w0).getDay()) % 7) * dayMs);
    for (let t = monday; t <= w1; t += 7 * dayMs) ticks.push({ t, label: fmtDay(new Date(t).toISOString()) });
  }
  const gridLines = ticks.map((x) => `<span class="vl" style="left:${pct(x.t)}%"></span>`).join('');
  const grid = `${gridLines}<span class="vl now" style="left:${pct(now)}%"></span>`;
  const outside = (t) => (t < w0 ? 'before' : t > w1 ? 'after' : '');

  // One feature: real dates where there are some, labels where there aren't.
  const span = (f) => {
    const target = f.feature.target_date ? Date.parse(`${f.feature.target_date}T00:00:00`) : null;
    const start = f.timeline?.start ? Date.parse(f.timeline.start) : null;
    const finished = f.timeline?.finished ? Date.parse(f.timeline.finished) : null;
    return { target, start, finished, end: finished ?? (start ? now : null) };
  };
  const stateLabel = (f) => (isRisk(f) ? 'At risk' : LABEL[f.state] || f.state);
  // One clean bar per feature, its text inside: from the first linked work (or today, when nothing
  // is linked yet: an outlined "planned" bar) to the target date (or today). Done = a ✓ at the day it finished.
  // How far a done feature is turned on for users, from its flags in production.
  const rolloutWord = (f) => {
    const prod = (f.last_mile?.flags || []).map((x) => x.environments?.production).filter(Boolean);
    if (!prod.length) return '';
    if (prod.every((c) => c.state === 'on')) return 'on for everyone';
    const part = prod.find((c) => c.state === 'partial');
    if (part) return part.rollout_percentage != null ? `${part.rollout_percentage}% on` : 'partly on';
    if (prod.every((c) => c.state === 'off')) return 'flag off';
    return '';
  };
  const featureTrack = (f) => {
    const sp = span(f), t = toneOf(f), name = f.feature.name;
    const tip = `${name} · ${stateLabel(f)} · ${sp.start ? `work since ${fmtDay(f.timeline.start)}` : 'no tasks (PRs or issues) linked yet'}${sp.finished ? ` · finished ${fmtDay(f.timeline.finished)}` : ''} · ${f.feature.target_date ? `due ${fmtDay(f.feature.target_date)}` : 'no target date'}`;
    const link = (cls, style, inner) => `<a class="${cls}" data-f="${esc(f.feature.id)}" href="${href(f.feature.id)}" style="${style}" title="${esc(tip)}" aria-label="${esc(tip)}">${inner}</a>`;
    if (f.state === 'done') {
      const at = sp.finished ?? sp.start;
      if (!at) return `<div class="f-ltrack"><span class="rm-text">Done</span></div>`;
      const doneText = `Done ${fmtDay(new Date(at).toISOString())}${rolloutWord(f) ? ` · ${rolloutWord(f)}` : ''}`;
      if (outside(at)) return `<div class="f-ltrack">${link('rm-text', '', esc(doneText))}</div>`;
      // Done with a start: a green bar for the time it was in progress, from the first linked work to
      // the day it was finished, then how far it is turned on for users.
      if (sp.start && sp.finished && sp.finished > sp.start) {
        const l = pct(Math.max(sp.start, w0)), r = pct(sp.finished), w = Math.max(1.5, r - l);
        return `<div class="f-ltrack">${link('rm-bar done rm-donebar', `left:${l}%;width:${w}%`, '<span class="rm-fill" style="width:100%" aria-hidden="true"></span>')}
          <span class="rm-after rm-doneafter" style="left:${r}%"><span class="rm-dot" aria-hidden="true">✓</span>${esc(doneText)}</span></div>`;
      }
      return `<div class="f-ltrack">${link('rm-ms done', `left:${pct(at)}%`, `<span class="rm-dot" aria-hidden="true">✓</span><span>${esc(doneText)}</span>`)}</div>`;
    }
    const from = sp.start ?? firstSeen(f.feature.id);
    const to = sp.target ?? now;
    const labelParts = [!sp.start ? 'No tasks linked yet' : '', sp.target ? `due ${fmtDay(f.feature.target_date)}` : 'no target date'].filter(Boolean);
    const label = labelParts.join(' · ').replace(/^due/, 'Due').replace(/^no target/, 'No target');
    const since = sp.start ? '' : ` · on your roadmap since ${fmtDay(new Date(from).toISOString())}`;
    const tip2 = `${tip}${since}`;
    const l = pct(Math.min(from, to)), r = pct(Math.max(from, to, now)), w = Math.max(1, r - l);
    const late = sp.target && sp.target < now;
    // How much of the time from start to due has already gone by: the filled part of the bar.
    const span2 = Math.max(to, now) - from;
    const gone = span2 > 0 ? Math.min(100, Math.max(0, ((now - from) / span2) * 100)) : 100;
    const cls = `rm-bar ${t}${sp.start ? '' : ' planned'}${outside(Math.max(to, now)) === 'after' ? ' cut-r' : ''}${late ? ' late' : ''}`;
    const text = `${esc(late ? `Overdue since ${fmtDay(f.feature.target_date)}` : label)}${outside(to) === 'after' ? ' →' : ''}`;
    const setDue = !sp.target ? dueButton(f) : '';
    const fits = w > Math.max(14, text.length * 0.75);
    const inner = `<span class="rm-fill" style="width:${gone}%" aria-hidden="true"></span>${fits ? `<span class="rm-label">${text}</span>` : ''}`;
    const bar = `<a class="${cls}" data-f="${esc(f.feature.id)}" href="${href(f.feature.id)}" style="left:${l}%;width:${w}%" title="${esc(tip2)}" aria-label="${esc(`${tip2} · ${Math.round(gone)}% of the time to the due date has passed`)}">${inner}</a>`;
    return `<div class="f-ltrack">${bar}${setDue ? `<span class="rm-setdue" style="left:${Math.min(r, 80)}%">${setDue}</span>` : ''}${fits ? '' : r > 75 ? `<span class="rm-after before" style="right:${100 - l}%">${text}</span>` : `<span class="rm-after" style="left:${r}%">${text}</span>`}</div>`;
  };
  const featureRow = (f) => `<div class="f-lrow rm-frow"><div class="f-lname"><a class="rm-fname" href="${href(f.feature.id)}" title="${esc(f.feature.name)}">${esc(f.feature.name)}</a>${fpill(toneOf(f))}</div>${featureTrack(f)}</div>` + dueRow(f);

  // Groups: projects or teams, each with its summary even when collapsed.
  const groups = pr.group === 'team'
    ? teams.map((t) => ({ id: `t:${t.id}`, name: t.name, ids: t.features }))
    : snapshot.projects.map((p) => ({ id: `p:${pid(p.project.id)}`, name: p.project.name, ids: p.features }));
  const shownIds = new Set(shown.map((f) => f.feature.id));
  const live = groups.map((g) => ({ ...g, fs: g.ids.filter((id) => shownIds.has(id)).map((id) => byId.get(id)).sort((a, b) => (span(a).start ?? Infinity) - (span(b).start ?? Infinity) || a.feature.name.localeCompare(b.feature.name)) })).filter((g) => g.fs.length);
  // Features with nothing to place in time (no linked work and no target date, or done with no
  // dates recorded) go in a compact list under the timeline rows instead of empty rows.
  const onTimeline = (f) => { const sp = span(f); return sp.start || (sp.target && f.state !== 'done'); };
  const undatedList = (g, list) => {
    if (!list.length) return '';
    const done = list.filter((f) => f.state === 'done'), open = list.filter((f) => f.state !== 'done');
    const label = [open.length ? `${open.length} with no tasks linked or target date yet` : '', done.length ? `${done.length} done, no dates recorded` : ''].filter(Boolean).join(' · ');
    const item = (f) => `<li><a href="${href(f.feature.id)}">${esc(f.feature.name)}</a><span class="rm-nd-r">${dueButton(f)}${fpill(toneOf(f))}</span>${dueEdit === f.feature.id ? `<div class="rm-nd-form">${dueForm(f)}</div>` : ''}</li>`;
    return `<details class="rm-nodates" data-keep="rm-nd-${esc(g.id)}"${open.length ? ' open' : ''}><summary><span class="chev" aria-hidden="true"></span>Not on the timeline: ${esc(label)}</summary>
      ${open.length ? `<p class="rm-ndh">No tasks linked or target date yet</p><ul>${open.map(item).join('')}</ul>` : ''}
      ${done.length ? `<p class="rm-ndh">Done, no dates recorded</p><ul>${done.map(item).join('')}</ul>` : ''}</details>`;
  };
  const groupBody = (g) => g.fs.filter(onTimeline).map((f) => featureRow(f)).join('') + undatedList(g, g.fs.filter((f) => !onTimeline(f)));
  const groupRow = (g) => {
    const open = pr.expanded.includes(g.id);
    const nb = g.fs.filter((f) => f.state === 'blocked').length, nr = g.fs.filter(isRisk).length, nd = g.fs.filter((f) => f.state === 'done').length;
    const dated = g.fs.map(span).filter((x) => x.start);
    const tone = nb ? 'blocked' : nr ? 'risk' : nd === g.fs.length ? 'done' : 'flowing';
    const lastDueAll = Math.max(0, ...g.fs.filter((f) => f.state !== 'done').map((f) => span(f).target || 0));
    const summary = `${featuresLabel(g.fs)}${nb ? ` · ${nb} blocked` : ''}${nr ? ` · ${nr} at risk` : ''}${nd ? ` · ${nd} done` : ''}${lastDueAll ? ` · last due ${fmtDay(new Date(lastDueAll).toISOString())}` : ''}`;
    const live2 = g.fs.filter((f) => f.state !== 'done');
    const starts = live2.map((f) => span(f).start ?? firstSeen(f.feature.id)), ends = live2.map((f) => span(f).target ?? now);
    const lastTarget = Math.max(0, ...live2.map((f) => span(f).target || 0)) || null;
    let agg = '';
    if (live2.length && (lastTarget || live2.some((f) => span(f).start))) {
      const l = pct(Math.min(...starts)), r = pct(Math.max(...ends)), w = Math.max(1, r - l);
      const text = lastTarget ? `Last due ${fmtDay(new Date(lastTarget).toISOString())}${outside(lastTarget) === 'after' ? ' →' : ''}` : '';
      const g0 = Math.min(...starts), g1 = Math.max(...ends, now);
      const gone = g1 > g0 ? Math.min(100, ((now - g0) / (g1 - g0)) * 100) : 100;
      agg = `<span class="rm-bar agg ${tone}${outside(Math.max(...ends)) === 'after' ? ' cut-r' : ''}" style="left:${l}%;width:${w}%" aria-hidden="true" title="${esc(text)}"><span class="rm-fill" style="width:${gone}%"></span></span>`;
    } else if (!live2.length && nd) {
      const at = Math.max(...g.fs.map((f) => span(f).finished || span(f).start || 0));
      agg = at && !outside(at) ? `<span class="rm-ms done" style="left:${pct(at)}%"><span class="rm-dot" aria-hidden="true">✓</span><span>All done ${esc(fmtDay(new Date(at).toISOString()))}</span></span>` : '<span class="rm-text">All done</span>';
    } else agg = '<span class="rm-text">No dates yet</span>';
    const toggle = `<button type="button" class="rm-gtoggle" data-rm-group="${esc(g.id)}" aria-expanded="${open}" data-fk="rm-g-${esc(g.id)}"><span class="chev" aria-hidden="true"></span><span class="rm-gname">${esc(g.name)}</span></button>`;
    const gp = g.id.startsWith('p:') ? projectById(g.id.slice(2)) : null;
    const archBtn = gp && allDone(gp) && !isArchived(gp.project.id) ? archiveButton(gp, { suggest: true }) : '';
    return `<div class="rm-group${open ? ' open' : ''}"><div class="f-lrow rm-grow"><div class="f-lname">${toggle}<span class="rm-gsum">${summary}</span>${archBtn ? `<span class="rm-garch">${archBtn}</span>` : ''}</div>
      <div class="f-ltrack">${gridLines}${agg}</div></div>${open ? groupBody(g) : ''}</div>`;
  };
  const allOpen = live.every((g) => pr.expanded.includes(g.id));
  const groupTools = `<button type="button" class="linkbtn" data-rm-all="${allOpen ? 'collapse' : 'expand'}">${allOpen ? 'Collapse all' : 'Expand all'}</button>`;
  const archHidden = projSel.length ? 0 : snapshot.projects.filter((p) => isArchived(p.project.id)).length;
  const teamNote = pr.group === 'team' ? '<span class="f-src">teams as named on each feature\'s steps</span>' : '';

  return `${head}${controls}${filters}
    <details class="card explain" data-keep="rm-help"><summary><b>How to read the roadmap</b></summary>
      <ul><li>A bar runs from the <b>first task</b> (the first PR or issue linked to one of its steps) to the <b>target date</b> (“Due …”). The filled part is the time already gone by. ✓ marks the day it finished.</li>
        <li><b>No tasks linked yet</b>: no PR or issue is linked to its steps. <b>No target date</b>: none is set.</li>
        <li><b>Project</b> groups features. <b>Feature</b>: something users can notice or use. <b>Step</b>: a stage of a feature. <b>Task</b>: the smallest unit of technical work, such as a PR or issue.</li>
        <li>Colours and patterns: <span class="rm-key done">done ✓</span> <span class="rm-key flowing">in progress</span> <span class="rm-key blocked">blocked (striped, “Blocked”)</span> <span class="rm-key risk">at risk (dashed, “At risk”)</span>. An outlined bar means no task is linked yet. Dependencies are on the Dependency map.</li>
        <li>Each project or team shows one bar spanning its features and a summary; open it (or “Expand all”) to see its features.</li></ul></details>
    <section class="card section fs-host" data-fs-host><div class="f-cardh"><h2>By ${pr.group === 'team' ? 'team' : 'project'} <span class="muted small">${esc(ZOOMS[pr.zoom]?.label || 'Month')} view</span></h2><span class="rm-tools">${teamNote} ${groupTools}${fsButton()}</span></div>
      <div class="f-lanes-wrap"><div class="f-lanes rm-${esc(pr.zoom)}" id="f-lanes">
        <div class="f-lrow axis"><div></div><div class="f-axisline">${ticks.filter((x) => pct(x.t) < 95).map((x) => `<span style="left:${pct(x.t)}%">${esc(x.label)}</span>`).join('')}<span class="now" style="left:${pct(now)}%">now</span></div></div>
        ${live.map(groupRow).join('')}</div></div>
      ${archHidden ? `<p class="muted small arch-more">${plural(archHidden, 'archived project')} not shown. Pick ${archHidden === 1 ? 'it' : 'them'} in “Projects” to see ${archHidden === 1 ? 'it' : 'them'} here.</p>` : ''}
    </section>`;
}
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-rm-group]');
  if (g) return setPrefs('roadmap', { expanded: toggleIn(prefs('roadmap').expanded, g.dataset.rmGroup) });
  const all = e.target.closest('[data-rm-all]');
  if (all) setPrefs('roadmap', { expanded: all.dataset.rmAll === 'expand' ? [...document.querySelectorAll('[data-rm-group]')].map((b) => b.dataset.rmGroup) : [] });
});
// Dependency links on the roadmap: from the blocking feature's bar to every bar of the feature waiting on it.
function drawHandoffs() {
  const box = $('#f-lanes'), svg = $('#f-handoffs');
  if (!box || !svg) return;
  const o = box.getBoundingClientRect();
  svg.setAttribute('viewBox', `0 0 ${o.width} ${o.height}`);
  svg.innerHTML = '';
  for (const f of snapshot.features) {
    for (const b of f.blockers.filter((x) => x.kind === 'dependency' && !x.via?.length)) {
      const from = box.querySelector(`[data-f="${CSS.escape(b.feature)}"]`);
      if (!from) continue;
      const ra = from.getBoundingClientRect(), x = ra.right - o.left + 8, y0 = ra.top + ra.height / 2 - o.top;
      for (const to of box.querySelectorAll(`[data-f="${CSS.escape(f.feature.id)}"]`)) {
        const rb = to.getBoundingClientRect(), y = rb.top + rb.height / 2 - o.top, x2 = rb.right - o.left + 2;
        sel('path', { d: `M${ra.right - o.left},${y0} H${x} V${y} H${x2}`, class: 'f-hand' }, svg);
        sel('circle', { cx: x2, cy: y, r: 3, fill: TONE.blocked }, svg);
      }
    }
  }
}
window.addEventListener('resize', () => requestAnimationFrame(drawHandoffs));

// ---------- FEATURE ----------
let featureSel = null;
function featureGraph(f) {
  const byId = byFeature();
  const left = [...new Set(f.blockers.filter((b) => b.kind === 'dependency').map((b) => b.feature))];
  const deps = f.depends_on.filter((d) => !left.includes(d.id) && byId.has(d.id)).map((d) => d.id);
  const leftIds = [...left, ...deps];
  const rightIds = f.depended_on_by.map((d) => d.id);
  const height = Math.max(320, 130 + Math.max(leftIds.length, rightIds.length, 1) * 92);
  const nodeFor = (id, x, y, extra = {}) => {
    const g = byId.get(id);
    const t = g ? toneOf(g) : 'unknown';
    return { id, x, y, kind: 'feature', label: g?.feature.name || id, sub: t === 'risk' ? 'At risk' : LABEL[g?.state] || 'Unknown', tone: t, subTone: ['blocked', 'risk'].includes(t), ...extra };
  };
  const xs = [150, 500, 850];
  const nodes = [nodeFor(f.feature.id, xs[1], spread(1, height)[0], { size: 64, halo: f.state === 'blocked' })];
  spread(leftIds.length, height).forEach((y, i) => nodes.push(nodeFor(leftIds[i], xs[0], y)));
  const edges = leftIds.map((id) => ({ from: id, to: f.feature.id, kind: left.includes(id) ? 'block' : byId.get(id)?.state === 'done' ? 'done' : '' }));
  spread(rightIds.length, height).forEach((y, i) => nodes.push(nodeFor(rightIds[i], xs[2], y)));
  for (const id of rightIds) edges.push({ from: f.feature.id, to: id, kind: f.state === 'blocked' ? 'hold' : f.state === 'done' ? 'done' : '' });
  const cols = [{ x: xs[0], t: left.length ? 'Blocked by' : 'Depends on' }, { x: xs[1], t: 'Feature' }, { x: xs[2], t: 'Depended on by' }];
  return { graph: { cols, nodes, edges }, height };
}

// The drawer's Delay row in a few plain words; the full sentence stays in the tooltip.
function delayShort(d) {
  const open = d.open_steps?.length || 0;
  if (!open) return 'None · all steps done';
  return d.at_risk ? `At risk · ${plural(open, 'open step')}` : `On track · ${plural(d.days_left, 'day')} left`;
}

function featureDrawer(f, id) {
  const byId = byFeature();
  if (!id || id === f.feature.id) {
    const b = f.blockers[0];
    return `<div><span class="kick">Feature</span><h3>${esc(f.feature.name)} ${fpill(toneOf(f))}</h3></div>
      ${b ? `<div class="f-callout" style="--s:${TONE.blocked}"><b>${b.kind === 'dependency' ? `Waiting on ${esc(b.feature_name)}` : esc(LABEL[b.kind] || 'Definition problem')}</b>
        <span>${b.step_name ? `“${esc(b.step_name)}” isn't done` : esc(b.why)}${f.blockers.length > 1 ? ` · +${f.blockers.length - 1} more` : ''}</span>${srcLine(sourceOf(f, 'blocker:0'))}</div>` : f.state === 'unavailable'
        ? `<div class="f-callout" style="--s:${TONE.unavailable}"><b>Can't confirm</b><span>${esc(f.summary)}</span></div>` : ''}
      <dl class="f-kv">${b ? `<dt>Push</dt><dd>${pchip(b.owner)}</dd>` : ''}<dt>Owner</dt><dd>${esc(f.feature.owner)}</dd>
        <dt>Target</dt><dd>${f.feature.target_date ? `${esc(fmtDay(f.feature.target_date))}${f.state === 'done' ? '' : f.delay?.enabled ? ` <span class="muted">· ${f.delay.days_left < 0 ? `${-f.delay.days_left} days late` : `${f.delay.days_left} days left`}</span>` : ''}` : '<span class="muted">none</span>'}</dd>
        ${f.delay?.enabled ? `<dt>Delay</dt><dd title="${esc(f.delay.text)}">${esc(delayShort(f.delay))}${sourceOf(f, 'delay')?.links.length ? ` ${srcLine(sourceOf(f, 'delay'), { compact: true })}` : ''}</dd>` : ''}
</dl>
      ${f.blockers.length ? `<details class="f-fold"><summary>Full reason</summary><p>${esc(f.summary)}</p></details>` : ''}`;
  }
  const g = byId.get(id);
  if (!g) return '';
  const b = g.blockers[0];
  return `<div><span class="kick">${f.blockers.some((x) => x.feature === id) ? 'Blocking this feature' : 'Feature'}</span><h3>${esc(g.feature.name)} ${fpill(toneOf(g))}</h3></div>
    ${f.blockers.filter((x) => x.feature === id).map((x) => `<div class="f-callout" style="--s:${TONE.blocked}"><b>${esc(x.step_name ? `“${x.step_name}” isn't done` : 'Not done')}</b>
      <span>${x.evidence.map((e) => `<a href="${escUrl(e.link)}" target="_blank" rel="noopener">${esc(e.label)}</a>`).join(' · ') || esc(x.why)}</span>${srcLine(sourceOf(f, `blocker:${f.blockers.indexOf(x)}`))}</div><dl class="f-kv"><dt>Push</dt><dd>${pchip(x.owner)}</dd></dl>`).join('')}
    ${b && !f.blockers.some((x) => x.feature === id) ? `<p class="muted small">${esc(g.summary)}</p>` : ''}
    <a class="f-more" href="${href(id)}">Open ${esc(g.feature.name)} →</a>`;
}

// Where a status was read from (status.sources, src/trace.js): its exact link(s), or the reason
// there is none, and when it was last read, or since when its source is unavailable.
const SRC_KIND = { developed: 'Developed', deployed: 'Deployed', flag: 'Flag', experiment: 'Experiment', store: 'App store', blocked: 'Blocked', delay: 'Delay warning' };
const sourceOf = (f, key) => (f.sources || []).find((x) => x.key === key);
function readLine(t) {
  if (t.unavailable) {
    return `<span class="src-unav">source unavailable since ${esc(time(t.unavailable_since || t.read_at))}</span>${t.read_at ? `<span class="src-read">last read ${esc(time(t.read_at))}</span>` : '<span class="src-read">never read</span>'}`;
  }
  if (t.from_snapshot) return `<span class="src-read" title="${esc(t.message || '')}">from team snapshot, read ${esc(ago(t.read_at))}</span>`;
  return `<span class="src-read" title="${esc(t.read_at ? time(t.read_at) : 'never read')}">${t.read_at ? `read ${esc(ago(t.read_at))}` : 'never read'}</span>`;
}
function srcLine(t, { compact = false } = {}) {
  if (!t) return '';
  const links = t.links.length
    ? t.links.map((l) => `<a class="src-link" href="${escUrl(l.url)}" target="_blank" rel="noopener">${esc(compact ? 'source' : l.label)} ↗</a>`).join('')
    : `<span class="src-none">no source item: ${esc(t.no_source_item)}</span>`;
  return `<span class="srcline" data-source="${esc(t.key)}">${links}${readLine(t)}</span>`;
}
// Foldable cards on the feature page (flags, path to users, sources): each remembers whether it was
// left open, per browser.
const FOLDS = 'lifecycle-folds';
const FOLD_CHEV = '<svg class="ramp-chev" viewBox="0 0 20 20" aria-hidden="true"><path d="M8 5l5 5-5 5"/></svg>';
function foldOpen(key, dflt) { try { const v = JSON.parse(localStorage.getItem(FOLDS) || '{}')[key]; return v ?? dflt; } catch { return dflt; } }
document.addEventListener('toggle', (e) => {
  const key = e.target?.dataset?.fold;
  if (!key) return;
  try { const all = JSON.parse(localStorage.getItem(FOLDS) || '{}'); all[key] = e.target.open; localStorage.setItem(FOLDS, JSON.stringify(all)); } catch { /* private mode */ }
}, true);
function sourcesCard(f) {
  const list = f.sources || [];
  if (!list.length) return '';
  return `<details class="card section f-sources fold-card" data-fold="sources"${foldOpen('sources', false) ? ' open' : ''}><summary class="f-cardh"><h2>${FOLD_CHEV}Where each status comes from</h2></summary>
    <table class="lmt src-table"><thead><tr><th scope="col">Status</th><th scope="col">State</th><th scope="col">Source and last read</th></tr></thead><tbody>
    ${list.map((t) => `<tr data-kind="${esc(t.kind)}"><th scope="row"><span class="tag">${esc(SRC_KIND[t.kind] || t.kind)}</span> ${esc(t.label)}</th>
      <td>${esc(String(t.state).replace(/_/g, ' '))}</td><td>${srcLine(t)}</td></tr>`).join('')}</tbody></table></details>`;
}

const evRow = (fn, what, state, body, link) => `<details class="f-tc"><summary><span class="fn">${esc(fn)}</span><span class="what">${esc(what)}</span>
  <span class="ok" style="--s:${TONE[state] || TONE.unknown}">${state === 'done' ? '✓' : state === 'blocked' || state === 'not_done' ? '×' : state === 'unavailable' || state === 'no_access' ? '?' : '…'}</span></summary>
  <div class="body">${body.map((x) => `<span>${esc(x)}</span>`).join('')}${link ? `<a href="${escUrl(link)}" target="_blank" rel="noopener">Open ↗</a>` : ''}</div></details>`;

// Seen states per checkpoint ("feature/name"), kept in memory for this page load: a mark animates
// only when its state differs from the last render, so motion always means "this changed".
const seenMarks = new Map();
let markScope = '';
function statusMark(state, key) {
  // The page re-renders right after a refresh (alerts arrive); a change stays "fresh" for a moment
  // so that second render doesn't cut its animation.
  const prev = seenMarks.get(key);
  const now = performance.now();
  const at = prev && prev.state !== state ? now : prev?.at ?? -Infinity;
  seenMarks.set(key, { state, at });
  const changed = prev && now - at < 1200 ? ' changed' : '';
  const C = 2 * Math.PI * 7;
  const label = state === 'done' ? 'Done' : state === 'flowing' ? 'In progress' : state === 'not_done' ? 'Closed without finishing'
    : state === 'unavailable' || state === 'no_access' ? 'Unknown' : 'Not started';
  const ring = (cls) => `<circle class="${cls}" cx="9" cy="9" r="7"/>`;
  const body = state === 'done' ? `<circle class="fill" cx="9" cy="9" r="8"/><path class="check" d="M5.4 9.3l2.4 2.4 4.8-5"/>`
    : state === 'flowing' ? `${ring('track')}<circle class="arc" cx="9" cy="9" r="7" stroke-dasharray="${C * 0.6} ${C}" transform="rotate(-90 9 9)"/>`
    : state === 'not_done' ? `${ring('ring')}<path class="x" d="M6.5 6.5l5 5M11.5 6.5l-5 5"/>`
    : state === 'unavailable' || state === 'no_access' ? `${ring('ring dashed')}<text x="9" y="9">?</text>`
    : ring('ring');
  return `<svg class="f-mark${changed}" viewBox="0 0 18 18" width="18" height="18" style="--s:${TONE[state] || TONE.unknown}" role="img" aria-label="${label}"><title>${label}</title>${body}</svg>`;
}
function checkpoint(state, name, right, rows, open = false) {
  return `<li class="f-cp" style="--lc:${state === 'done' ? 'color-mix(in srgb, var(--success) 55%, transparent)' : 'var(--input)'}">
    ${statusMark(state, `${markScope}/${name}`)}
    <div class="h">${esc(name)}<span>${right}</span></div>${rows.join('')}</li>`;
}

function pathCheckpoints(f) {
  markScope = f.feature.id;
  const out = f.steps.map((s) => checkpoint(s.state === 'in_progress' ? 'flowing' : s.state, s.name,
    `${s.team ? esc(s.team) : ''}${s.team ? ' · ' : ''}${esc(s.owner)}`,
    [srcLine(sourceOf(f, `step:${s.id}`)), ...s.evidence.filter((e) => e.type === 'pr').map((e) => srcLine(sourceOf(f, `actions:${e.repo}#${e.number}`)))].concat(s.linked_work ? s.evidence.map((e) => (e.source === 'jira'
      ? evRow('jira.ticket', `${e.key} ${e.title || ''}`.trim(), e.state, ['Jira', e.detail || e.state, e.from_snapshot ? `from team snapshot, read ${ago(e.last_successful_read_at)}` : '', s.done_when ? `done when: ${s.done_when}` : ''].filter(Boolean), e.link)
      : evRow(`github.${e.type}`, `#${e.number} ${e.title || e.repo}`, e.state, [`${e.repo}`, e.detail || e.state, s.done_when ? `done when: ${s.done_when}` : ''].filter(Boolean), e.link)))
      : [`<p class="f-nolink">No tasks linked yet: add the PR or issue for this step in the definition.</p>`])));
  const lm = f.last_mile;
  if (lm && lm.state !== 'not_tracked') {
    for (const [env, label] of ENVS) {
      const cells = lm.services.map((s) => ({ s, c: s.environments[env] }));
      const st = !cells.length ? null : cells.some((x) => ['unavailable', 'no_access'].includes(x.c.state)) ? 'unavailable'
        : cells.every((x) => x.c.deployed && x.c.contains_feature !== false) ? 'done' : 'not_started';
      if (!st) continue;
      out.push(checkpoint(st, `Deployed to ${label}`, esc(cells.map((x) => x.c.version || '—').join(', ')),
        cells.flatMap((x) => [srcLine(sourceOf(f, `deploy:${x.s.id}:${env}`)), evRow('github.deployments', `${x.s.id} → ${x.c.state === 'unavailable' || x.c.state === 'no_access' ? 'status unavailable' : x.c.deployed ? x.c.version : 'not deployed'}`, x.c.state === 'unavailable' || x.c.state === 'no_access' ? x.c.state
          : x.c.deployed && x.c.contains_feature !== false ? 'done' : 'not_started',
          [`environment ${env}`, x.c.contains_feature === true ? 'includes this feature' : x.c.contains_feature === false ? 'does not include it' : '', x.c.deployed_at ? `deployed ${time(x.c.deployed_at)}` : ''].filter(Boolean), x.c.link)])));
    }
    if (lm.flags.length) {
      const prod = lm.flags.map((fl) => ({ fl, c: fl.environments.production }));
      const st = prod.some((x) => ['unavailable', 'no_access', 'missing_environment'].includes(x.c.state) || x.fl.unknown) ? 'unavailable'
        : prod.every((x) => x.c.state === 'on') ? 'done' : prod.some((x) => x.c.state === 'partial' || x.c.rollout_percentage) ? 'flowing' : 'not_started';
      out.push(checkpoint(st, 'Turned on for users', esc(lm.label), prod.flatMap((x) => [srcLine(sourceOf(f, `flag:${x.fl.key}:production`)), evRow(`${lm.flag_platform === 'statsig' ? 'statsig.gate' : 'flagsmith.flag'}`, `${x.fl.key} · ${x.fl.unknown ? 'unknown flag' : x.c.state === 'on' ? 'on' : x.c.state === 'off' ? (x.c.was_on_before ? 'switched off' : 'off') : x.c.rollout_percentage !== null && x.c.rollout_percentage !== undefined ? `${x.c.rollout_percentage}%` : x.c.state}`,
        x.c.state === 'on' ? 'done' : ['unavailable', 'no_access', 'missing_environment'].includes(x.c.state) || x.fl.unknown ? 'unavailable' : 'not_started',
        [x.c.message || '', x.c.changed_at ? `changed ${time(x.c.changed_at)}` : ''].filter(Boolean), x.c.link)])));
    }
    // Experiments in production: running ones mean users deliberately get different behavior per group.
    if (lm.experiments?.length) {
      const prod = lm.experiments.map((x) => ({ x, c: x.environments.production }));
      const st = prod.some((p) => ['unavailable', 'no_access', 'unknown'].includes(p.c.state)) ? 'unavailable' : prod.some((p) => p.c.state === 'running') ? 'flowing' : 'done';
      out.push(checkpoint(st, 'Experiments', esc(prod.map((p) => `${p.x.name || p.x.id}: ${(EXP_STATE[p.c.state] || p.c.state.replace(/_/g, ' ')).toLowerCase()}`).join(', ')),
        prod.flatMap((p) => [srcLine(sourceOf(f, `experiment:${p.x.id}:production`)), evRow('statsig.experiment',
          `${p.x.name || p.x.id} · ${p.c.state === 'running' ? p.c.groups.map((g) => `${g.name} ${g.share ?? '?'}%`).join(', ') : (EXP_STATE[p.c.state] || p.c.state).toLowerCase()}`,
          p.c.state === 'running' ? 'flowing' : ['unavailable', 'no_access', 'unknown'].includes(p.c.state) ? 'unavailable' : 'done',
          [p.c.message || '', ...(p.c.state === 'running' ? p.c.groups.map((g) => `${g.name}${g.control ? ' (control)' : ''} ${g.share ?? '?'}%: ${g.gets || 'not described in the definition'}`) : [])].filter(Boolean), p.c.link)])));
    }
  }
  return out;
}

// Ready to ramp? Renders the `ramp` block the backend computed; never decides anything itself.
const RAMP_TONE = { ready: 'done', not_ready: 'blocked', cant_tell: 'unavailable' };
const CHECK_TONE = { passed: 'done', failed: 'blocked', unavailable: 'unavailable', not_checked: 'unknown' };
const CHECK_LABEL = { passed: 'passed', failed: 'failed', unavailable: "can't tell", not_checked: 'not checked' };
// Whether the Ready to ramp card is unfolded, as the person left it last (per browser).
const RAMP_OPEN = 'lifecycle-ramp-open';
function rampOpen() { try { return localStorage.getItem(RAMP_OPEN) === '1'; } catch { return false; } }
document.addEventListener('toggle', (e) => {
  if (e.target?.id !== 'ramp') return;
  try { localStorage.setItem(RAMP_OPEN, e.target.open ? '1' : '0'); } catch { /* private mode */ }
}, true);
function rampCard(f) {
  const r = f.ramp;
  if (!r) return '';
  const evid = (list) => list.map((e) => `<a href="${escUrl(e.link)}" target="_blank" rel="noopener">${esc(e.label)}</a>`).join(' · ');
  return `<details class="card ramp-card" id="ramp" data-verdict="${esc(r.verdict)}"${rampOpen() ? ' open' : ''}><summary class="f-cardh ramp-head"><h2><svg class="ramp-chev" viewBox="0 0 20 20" aria-hidden="true"><path d="M8 5l5 5-5 5"/></svg>Ready to ramp? ${fpill(RAMP_TONE[r.verdict], r.label)}</h2>
      <span class="f-src">checked ${esc(time(r.read_at))}</span></summary>
    <div class="ramp-body"><p class="ramp-summary">${esc(r.summary)}</p>
      ${r.reasons.length ? `<h3>Why not</h3><ul class="ramp-list">${r.reasons.map((x) => `<li><span class="ramp-msg">${esc(x.message)}</span>
        <span class="ramp-meta">Owner: <b>${esc(x.owner)}</b>${x.evidence.length ? ` · ${evid(x.evidence)}` : ''}</span></li>`).join('')}</ul>` : ''}
      ${r.unavailable.length ? `<h3>Couldn't read</h3><ul class="ramp-list">${r.unavailable.map((u) => `<li><span class="ramp-msg">${esc(u.what)}: ${esc(u.source)} is unavailable${u.message ? ` (${esc(u.message)})` : ''}.</span>
        <span class="ramp-meta">Last read: ${esc(time(u.last_successful_read_at))}</span></li>`).join('')}</ul>` : ''}
      <details class="f-fold" ${r.verdict === 'ready' ? 'open' : ''}><summary>What was checked (${r.checks.length})</summary><ul class="ramp-checks">${r.checks.map((c) => `<li>${fpill(CHECK_TONE[c.state], CHECK_LABEL[c.state])}
        <span class="ramp-cname">${esc(c.name)}${c.custom ? ' <span class="muted">(this feature\'s condition)</span>' : ''}</span>${c.detail ? `<span class="ramp-meta">${esc(c.detail)}</span>` : ''}</li>`).join('')}</ul></details></div></details>`;
}

// Feature flags at a glance, next to Ready to ramp: each flag's rollout in production (and QA).
function flagRollout(c) {
  if (!c) return { tone: 'unknown', text: "Can't read" };
  if (c.state === 'on') return { tone: 'done', text: 'On · 100%', pct: 100 };
  if (c.state === 'off') return { tone: 'blocked', text: 'Off · 0%', pct: 0 };
  if (c.state === 'partial') return { tone: 'risk', text: c.rollout_percentage != null ? `On · ${c.rollout_percentage}%` : 'Partly on', pct: c.rollout_percentage ?? 50 };
  if (c.state === 'unknown') return { tone: 'unknown', text: 'Not created yet' };
  return { tone: 'unavailable', text: "Can't read now" };
}
function flagsCard(f) {
  const flags = f.last_mile?.flags || [];
  if (!flags.length) return '';
  const env = (label, c) => {
    const r = flagRollout(c);
    return `<span class="flag-env" title="${label}: ${esc(r.text)}"><span class="flag-envl">${label}</span><span class="flag-bar" aria-hidden="true"><i style="width:${r.pct ?? 0}%;--c:${TONE[r.tone]}"></i></span><span class="flag-pct" style="--s:${TONE[r.tone]}">${esc(r.text)}</span></span>`;
  };
  const rows = flags.map((fl) => {
    const prod = fl.environments?.production, qa = fl.environments?.qa;
    const link = prod?.link || qa?.link;
    const differ = flagRollout(prod).text !== flagRollout(qa).text;
    return `<li class="flag-row"><span class="flag-key">${link ? `<a href="${escUrl(link)}" target="_blank" rel="noopener">${esc(fl.key)}</a>` : esc(fl.key)}${differ ? '<span class="flag-diff" title="QA and production differ">≠</span>' : ''}</span>
      ${env('Prod', prod)}${env('QA', qa)}</li>`;
  }).join('');
  return `<details class="card flags-card fold-card" data-fold="flags"${foldOpen('flags', true) ? ' open' : ''}><summary class="f-cardh"><h2>${FOLD_CHEV}Feature flags</h2></summary><ul class="flag-list">${rows}</ul></details>`;
}

function renderFeatureFlow(id) {
  const f = snapshot.features.find((x) => x.feature.id === id);
  if (!f) {
    const bad = snapshot.invalid_definitions.filter((e) => e.file.replace(/^features\/|\.ya?ml$/g, '') === id);
    return `<p class="kicker">Feature</p><h1 class="mono">${esc(id)}</h1>${bad.length
      ? `<div class="banner st-blocked section"><span class="ico">×</span><div><b>This feature's definition is invalid</b>, so its status can't be shown.
          <ul>${bad.map((e) => `<li><code>${esc(e.file)}</code> · <code>${esc(e.field)}</code> ${esc(e.message)}</li>`).join('')}</ul></div></div>`
      : '<div class="card empty section"><strong>Not defined</strong>No feature with this id exists in the shared repo.</div>'}`;
  }
  if (featureSel?.feature !== id) featureSel = { feature: id, node: id };
  const { height } = featureGraph(f);
  const done = f.steps.filter((s) => s.state === 'done').length;
  const stats = [f.blockers.length ? stat(f.blockers.length, f.blockers.length === 1 ? 'blocker' : 'blockers', 'blocked') : '',
    stat(`${done}/${f.steps.length}`, 'steps done'),
    // Done: when it was due, no countdown. Late: how many days late. Otherwise: days left.
    f.state === 'done' && f.feature.target_date ? stat('Done', fmtDay(f.feature.target_date), 'done')
      : f.delay?.enabled ? (f.delay.days_left < 0 ? stat(-f.delay.days_left, `days late · due ${fmtDay(f.feature.target_date)}`, 'blocked')
        : stat(f.delay.days_left, `days to ${fmtDay(f.feature.target_date)}`, f.delay.at_risk ? 'blocked' : null)) : ''].join('');
  const p = projectOfFeature(f.feature.id);
  const warnings = [...f.warnings.map((w) => w.message), ...(f.team_warnings || []).map((w) => w.message)];
  // Timeline: registered changes, plus each experiment starting, ending or changing a group's share (read from Statsig).
  const expEvents = (f.last_mile?.experiments || []).flatMap((x) => (x.events || []).map((e) => ({ at: e.at, change: e.message, reason: e.message, source: 'statsig',
    source_label: 'Statsig experiment', link: x.environments.production.link })));
  // …and an app rollout halting or resuming, or a review rejection (read from the store).
  const storeEvents = (f.last_mile?.apps || []).flatMap((a) => Object.values(a.platforms || {}).flatMap((c) => (c.events || []).map((e) => ({ at: e.at, change: e.message, reason: e.message,
    source: 'store', source_label: c.store_name, link: e.link || c.link }))));
  const items = [...(snapshot.alert_list?.alerts || []).filter((a) => a.source !== 'lifecycle' && (a.features.includes(id) || a.dependents.includes(id))), ...expEvents, ...storeEvents]
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const SRC_TONE = { registered: 'flowing', statsig: 'in_progress', store: 'blocked' };
  return `<div class="f-head"><div><p class="kicker">${p ? `<a href="${projHref(p.project.id)}">${esc(p.project.name)}</a>` : 'Feature'}</p>
      <h1>${esc(f.feature.name)} ${fpill(toneOf(f))}</h1></div><div class="f-stats">${stats}${followButton(f.feature.id)}${f.share_link ? `<button type="button" class="btn small" data-copy="${esc(f.share_link)}" title="${esc(f.share_link)}">Copy link</button>` : ''}${editButton(f)}</div></div>
    ${featureEditBar(f)}
    ${warnings.length ? `<div class="f-warn"><span class="f-pill" style="--s:${TONE.risk}">${plural(warnings.length, 'definition warning')}</span><span>${warnings.map(esc).join(' · ')}</span></div>` : ''}
    ${rampCard(f)}
    ${flagsCard(f)}
    <div class="f-stage">
      <section class="card f-canvas"><div class="f-scroll"><svg class="f-graph" id="f-graph" viewBox="0 0 1000 ${height}" role="img" aria-label="${esc(f.summary)}"></svg></div>
        <div class="f-legend"><span><i class="dash" style="--c:${TONE.blocked}"></i>blocking</span><span><i style="--c:${TONE.done}"></i>fine</span></div></section>
      <aside class="card f-drawer" id="f-drawer" aria-live="polite">${featureDrawer(f, featureSel.node)}</aside>
    </div>
    <div class="f-two">
      <details class="card fold-card" data-fold="path"${foldOpen('path', true) ? ' open' : ''}><summary class="f-cardh"><h2>${FOLD_CHEV}Path to users</h2></summary><ol class="f-cps">${pathCheckpoints(f).join('') || '<p class="f-none">No steps yet.</p>'}</ol>
        ${f.last_mile ? `<details class="f-fold f-lmfold"><summary>All last-mile details</summary>${lastMileCard(f, { inFeature: true })}</details>` : ''}</details>
      <section class="card"><div class="f-cardh"><h2>Timeline</h2><a class="f-src" href="#/alerts/new">Register a change</a></div>
        ${items.length ? `<ul class="f-tl">${items.map((a) => `<li class="${a.state === 'cancelled' ? 'cancelled' : ''}"><time datetime="${esc(a.at)}">${esc(fmtDay(a.at))}</time><span class="d" style="--c:${TONE[SRC_TONE[a.source]] || TONE.unknown}"></span>
          <span class="w${a.source === 'statsig' ? ' wrap' : ''}" title="${esc(a.reason || a.change)}">${a.source === 'statsig' ? extLink(a.link, esc(a.change)) : esc(a.change)}</span><span class="k">${esc(a.source_label)}</span></li>`).join('')}</ul>` : '<div class="f-empty"><span class="f-empty-ico" aria-hidden="true">✓</span><b>No updates yet</b><span>Announced changes for this feature will show here.</span></div>'}</section>
    </div>
    ${teamDepsCard(f.team_dependencies)}
    ${sourcesCard(f)}`;
}

function wireFeatureFlow(r) {
  const svg = $('#f-graph');
  const f = snapshot.features.find((x) => x.feature.id === r.id);
  if (!svg || !f) return;
  drawGraph(svg, featureGraph(f).graph, (node) => { featureSel = { feature: f.feature.id, node }; $('#f-drawer').innerHTML = featureDrawer(f, node); }, featureSel?.node);
  for (const btn of document.querySelectorAll('[data-copy]')) {
    btn.addEventListener('click', async () => {
      const text = btn.dataset.copy;
      const label = btn.textContent;
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = 'Copied';
      } catch {
        window.prompt('Copy this link', text);
      }
      setTimeout(() => { btn.textContent = label; }, 1500);
    });
  }
}

// ---------- TEAMS ----------
function renderTeamsFlow() {
  return `${fhead('Teams', 'Teams and what they own')}${definedTeamsSection()}${fhead('Teams on steps', 'Who works on which feature')}${stepTeamsView()}`;
}
function wireTeamsFlow() { /* the Teams page has no interactive graph */ }

// ---------- ALERTS: board (not seen / seen) or the classic list ----------
let alertsMode = 'board';
function alertCard(a) {
  const tone = a.source === 'lifecycle' ? 'blocked' : 'flowing';
  const actions = a.source === 'registered' && a.state === 'planned'
    ? `<a class="f-mini" href="#/alerts/edit/${encodeURIComponent(a.change_id)}">Edit</a><button type="button" class="f-mini" data-cancel-change="${esc(a.change_id)}" data-rev="${esc(a.revision)}">Cancel</button>` : '';
  return `<article class="f-ai${isSeen(a) ? ' seen' : ' unseen'}${a.state === 'cancelled' ? ' cancelled' : ''}" data-alert="${esc(a.id)}"><div class="t"><span class="sd" style="--s:${TONE[tone]}"></span>${esc(a.change)}${seenTag(a)}${a.mine ? '<span class="f-tag">Yours</span>' : ''}</div>
    <p>${featureLinks(a.features, a.feature_names)}${a.dependents.length ? ` <span class="muted">→ ${featureLinks(a.dependents, a.feature_names)}</span>` : ''}${a.reason ? ` · ${esc(a.reason)}` : ''}</p>
    <div class="f">${a.evidence?.length ? `<span class="ev">${evLinks(a.evidence.slice(0, 2))}</span>` : '<span></span>'}<span>${esc(a.source_label)} · ${esc(fmtDay(a.at))}</span></div><div class="a">${seenButton(a)}${actions}</div></article>`;
}
function renderAlertsFlow() {
  if (!alertView) return `<div class="card empty"><strong>${alertError ? "Can't read alerts" : 'Loading alerts…'}</strong>${esc(alertError || '')}</div>`;
  const seenPref = prefs('alerts').seen;
  const bySource = alertView.alerts.filter((a) => alertFilter === 'all' || a.source === alertFilter);
  const all = bySource.filter((a) => seenPref === 'all' || (seenPref === 'seen' ? isSeen(a) : !isSeen(a)));
  const counts = { all: alertView.alerts.length, registered: 0, lifecycle: 0 };
  for (const a of alertView.alerts) counts[a.source]++;
  const unseenN = bySource.filter((a) => !isSeen(a)).length;
  const fresh = all.filter((a) => !isSeen(a)), rest = all.filter(isSeen);
  const seenChips = `<div class="f-segc" role="group" aria-label="Seen or not">${[['all', 'All', bySource.length], ['unseen', 'Not seen', unseenN], ['seen', 'Seen', bySource.length - unseenN]].map(([v, l, n]) =>
    `<button type="button" data-seg="alerts|seen" data-value="${v}" aria-pressed="${seenPref === v}" data-fk="alerts-seen-${v}">${l} <b>${n}</b></button>`).join('')}</div>`;
  const markAll = unseenN ? `<button type="button" class="btn small al-markall" data-seen-all data-fk="seen-all">Mark all as seen</button>` : '';
  const chips = ['all', 'registered', 'lifecycle'].map((s) => `<button type="button" data-afilter="${s}" aria-pressed="${alertFilter === s}" title="${esc(SRC_EXPLAIN[s])}">${s === 'all' ? 'All' : SRC_LABEL[s]} <b>${counts[s]}</b></button>`).join('');
  const col = (title, list, empty) => `<div class="f-col"><h3>${title}<b>${list.length}</b></h3>${list.join('') || `<p class="f-none">${empty}</p>`}</div>`;
  const board = `<div class="f-inbox">${col('Not seen', fresh.map(alertCard), seenPref === 'seen' ? 'Showing seen alerts only.' : 'Nothing left to review.')}${col('Seen', rest.map(alertCard), seenPref === 'unseen' ? 'Showing alerts not seen only.' : 'Nothing marked as seen yet.')}</div>`;
  const list = all.length ? `<ul class="alist">${all.map(alertRow).join('')}</ul>`
    : bySource.length ? filteredEmpty('alerts', seenPref === 'unseen' ? 'You have seen every alert here.' : 'No alert here is marked as seen.') : '<div class="card empty"><strong>No alerts</strong></div>';
  return `${fhead('Changes &amp; warnings', 'Alerts', `<div class="f-segc" role="group" aria-label="Layout"><button type="button" data-amode="board" aria-pressed="${alertsMode === 'board'}">Board</button><button type="button" data-amode="list" aria-pressed="${alertsMode === 'list'}">List</button></div><a class="btn primary" href="#/alerts/new">Register a change</a>`)}
    ${outboxCard(alertView.outbox)}
    <div class="al-bar">
      <div class="al-grp"><span class="al-k">Source</span><div class="f-segc" role="group" aria-label="Filter by source">${chips}</div></div>
      <div class="al-grp"><span class="al-k">Status</span>${seenChips}</div>
      ${markAll}
    </div>
    ${alertsMode === 'board' ? board : list}`;
}
function wireAlertsFlow(root) {
  root.querySelectorAll('[data-amode]').forEach((b) => b.addEventListener('click', () => { alertsMode = b.dataset.amode; render(); }));
}


// ---------- warm tooltip ----------
// One tooltip for the whole app, replacing the browser's slow native ones. The first waits a
// moment so passing over things shows nothing; while one is open (or just closed) its neighbours
// open instantly, so you can sweep a graph or the roadmap reading names. Native `title`s and SVG
// <title>s are adopted automatically, so every view gets it without special markup.
const tip = Object.assign(document.createElement('div'), { id: 'f-tip', hidden: true });
tip.setAttribute('role', 'tooltip');
document.body.append(tip);
let tipFor = null, tipTimer = 0, warmUntil = 0;
function adoptTitles(root) {
  if (!root.querySelectorAll) return;
  const els = root.matches?.('[title]') ? [root, ...root.querySelectorAll('[title]')] : root.querySelectorAll('[title]');
  for (const el of els) { el.dataset.tip = el.getAttribute('title'); el.removeAttribute('title'); }
  for (const t of root.querySelectorAll('svg title')) {
    let host = t.parentNode;
    if (host.tagName === 'text' || host.tagName === 'tspan') host = host.closest('g') || host;
    if (!host.dataset.tip) host.dataset.tip = t.textContent;
    t.remove();
  }
}
function placeTip(el) {
  const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
  let top = r.top - h - 8;
  if (top < 8) top = r.bottom + 8;
  const left = Math.min(innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2));
  tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}
function showTip(el) {
  clearTimeout(tipTimer);
  if (!el.isConnected || !el.dataset.tip) return;
  tipFor?.removeAttribute('aria-describedby');
  tipFor = el;
  tip.textContent = el.dataset.tip;
  tip.hidden = false;
  placeTip(el);
  tip.classList.add('on');
  el.setAttribute('aria-describedby', 'f-tip');
}
function hideTip() {
  clearTimeout(tipTimer);
  if (!tip.hidden) warmUntil = performance.now() + 350;
  tip.hidden = true;
  tip.classList.remove('on');
  tipFor?.removeAttribute('aria-describedby');
  tipFor = null;
}
document.addEventListener('pointerover', (e) => {
  if (e.pointerType === 'touch') return;
  const el = e.target.closest?.('[data-tip]');
  if (!el || el === tipFor) return;
  clearTimeout(tipTimer);
  if (!tip.hidden || performance.now() < warmUntil) showTip(el);
  else tipTimer = setTimeout(() => showTip(el), 400);
});
document.addEventListener('pointerout', (e) => {
  const el = e.target.closest?.('[data-tip]');
  if (el && !el.contains(e.relatedTarget)) hideTip();
});
document.addEventListener('focusin', (e) => { const el = e.target.closest?.('[data-tip]'); if (el && e.target.matches(':focus-visible')) showTip(el); });
document.addEventListener('focusout', hideTip);
document.addEventListener('pointerdown', hideTip);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); });
addEventListener('scroll', hideTip, true);
addEventListener('resize', hideTip);
adoptTitles(document.body);
new MutationObserver((list) => { for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) adoptTitles(n); })
  .observe(document.body, { childList: true, subtree: true });

// ---------- events ----------

// ---------- sidebar: collapsible to an icon rail, an overlay drawer below 900px ----------
// From 900px up the person's choice is saved on this machine (localStorage 'lifecycle-sidebar').
// Below 900px it always starts as the rail; expanding opens a drawer over the content that closes
// on Esc, a click outside or after navigating. The drawer is temporary and doesn't change the saved choice.
const SB_KEY = 'lifecycle-sidebar';
const wide = matchMedia('(min-width: 900px)');
const root = document.documentElement;
const sbToggle = $('#sb-toggle');
const sbBackdrop = $('#sb-backdrop');
function savedCollapsed() { try { return localStorage.getItem(SB_KEY) === 'collapsed'; } catch { return false; } }
function setSidebar({ drawer = false } = {}) {
  const rail = wide.matches ? savedCollapsed() : !drawer;
  root.classList.toggle('rail', rail);
  root.classList.toggle('sb-drawer', !wide.matches && drawer);
  sbBackdrop.hidden = !(!wide.matches && drawer);
  sbToggle.setAttribute('aria-expanded', String(!rail));
  sbToggle.setAttribute('aria-label', rail ? 'Expand sidebar' : 'Collapse sidebar');
  sbToggle.dataset.tip = rail ? 'Expand sidebar' : 'Collapse sidebar';
  if (tipFor === sbToggle) hideTip();
  // in the rail every icon names its screen in a tooltip; the visually hidden label keeps the accessible name
  document.querySelectorAll('.nav a[data-label], #theme, #update-btn').forEach((el) => {
    const name = el.id === 'update-btn' ? updateTip() : el.dataset.label || 'Theme';
    if (rail) el.dataset.tip = name; else delete el.dataset.tip;
  });
}
// The update button's name, with the marker spelled out (the rail tooltip and screen readers).
const updateTip = () => ($('#update-btn .upd-dot')?.hidden === false ? 'Check for updates · update available' : 'Check for updates');
const drawerOpen = () => root.classList.contains('sb-drawer');
function closeDrawer({ focus = false } = {}) {
  if (!drawerOpen()) return;
  setSidebar();
  if (focus) sbToggle.focus();
}
sbToggle.addEventListener('click', () => {
  if (wide.matches) {
    try { localStorage.setItem(SB_KEY, savedCollapsed() ? 'expanded' : 'collapsed'); } catch { /* private mode */ }
    setSidebar();
  } else setSidebar({ drawer: !drawerOpen() });
});
sbBackdrop.addEventListener('click', () => closeDrawer());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawerOpen()) closeDrawer({ focus: true }); });
wide.addEventListener('change', () => setSidebar());
setSidebar();

window.addEventListener('hashchange', () => { closeDrawer(); render(); $('#main').focus(); window.scrollTo(0, 0); });
$('#refresh').addEventListener('click', load);
$('#theme').addEventListener('click', () => {
  const dark = !document.documentElement.classList.contains('dark');
  document.documentElement.classList.toggle('dark', dark);
  try { localStorage.setItem('lifecycle-theme', dark ? 'dark' : 'light'); } catch { /* private mode */ }
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  try { if (localStorage.getItem('lifecycle-theme')) return; } catch { /* ignore */ }
  document.documentElement.classList.toggle('dark', e.matches);
});
load();
loadAsk();

// ---------- personal view preferences ----------
// Each person's filters, zoom, level of detail and collapsed groups, per view. Kept only in this
// browser (localStorage, like the sidebar and theme): never sent to LifeCycle or the shared repo.
const VIEW_DEFAULTS = {
  roadmap: { projects: null, teams: [], features: [], only: 'all', zoom: 'month', group: 'project', expanded: [] },
  map: { projects: [], teams: [], focus: [], dir: 'both', depth: 1, level: 'features' },
  ask: { q: '', project: '' },
  alerts: { seen: 'all' },
};
const viewKey = (view) => `lifecycle-view-${view}`;
const viewPrefs = {};
function prefs(view) {
  if (!viewPrefs[view]) {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(viewKey(view)) || '{}') || {}; } catch { /* private mode or bad JSON */ }
    viewPrefs[view] = { ...structuredClone(VIEW_DEFAULTS[view]), ...saved };
  }
  return viewPrefs[view];
}
function setPrefs(view, patch, { rerender = true } = {}) {
  Object.assign(prefs(view), patch);
  try { localStorage.setItem(viewKey(view), JSON.stringify(viewPrefs[view])); } catch { /* private mode */ }
  if (rerender) render();
}
function resetPrefs(view) {
  viewPrefs[view] = structuredClone(VIEW_DEFAULTS[view]);
  try { localStorage.removeItem(viewKey(view)); } catch { /* private mode */ }
  render();
}
const toggleIn = (list, v) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

// "Showing: …" with one removable chip per active filter, plus Clear filters and Reset view.
// items: [{ label, clear: { key: value } }]
function activeFilters(view, items, clearAll) {
  const chips = items.map((it, i) => `<button type="button" class="af-chip" data-af-clear="${view}|${i}" aria-label="Remove filter: ${esc(it.label)}">${esc(it.label)}<span aria-hidden="true">×</span></button>`).join('');
  activeFilterSpecs[view] = { items, clearAll };
  return `<div class="activef" role="group" aria-label="Active filters">
    <span class="af-k">${items.length ? 'Showing only' : 'Showing everything'}</span>${chips}
    ${items.length ? `<button type="button" class="linkbtn" data-af-clearall="${view}">Clear filters</button>` : ''}
    <button type="button" class="linkbtn" data-reset-view="${view}" title="Back to the default filters, zoom and level of detail">Reset view</button></div>`;
}
const activeFilterSpecs = {};

// A filter that leaves nothing: say why and how to get things back, never a blank page.
const filteredEmpty = (view, why) => `<div class="card empty section" role="status"><strong>Nothing matches these filters</strong>${why}
  <p><button type="button" class="btn" data-af-clearall="${view}">Clear filters</button></p></div>`;

// A <details> menu of checkboxes (keyboard and screen reader friendly), with an optional search box.
function pickMenu({ id, label, options, selected, view, key, search = false, single = false }) {
  const n = selected.length;
  let lastGroup = null;
  const list = options.map((o) => {
    const head = o.group !== undefined && o.group !== lastGroup ? `<li class="pick-g" role="presentation" data-g="${esc(o.group)}">${esc(o.group)}</li>` : '';
    lastGroup = o.group;
    return `${head}<li data-text="${esc(`${o.code || ''} ${o.label} ${o.group || ''} ${o.hint || ''}`.toLowerCase())}"${o.group !== undefined ? ` data-in="${esc(o.group)}"` : ''}><label><input type="${single ? 'radio' : 'checkbox'}" name="${id}" data-pick="${view}|${key}" data-fk="${id}-${esc(o.value)}" value="${esc(o.value)}"${selected.includes(o.value) ? ' checked' : ''}>
    <span class="pick-t">${o.code ? `<span class="pick-code">${esc(o.code)}</span>` : ''}${esc(o.label)}${o.hint ? `<span class="pick-h">${esc(o.hint)}</span>` : ''}</span></label></li>`;
  }).join('');
  return `<details class="pick" data-keep="${id}"><summary data-fk="${id}">${esc(label)}${n ? ` <b class="pick-n">${n}</b>` : ''}<span class="sr">${n ? `, ${n} selected` : ', none selected'}</span></summary>
    <div class="pick-pop">${search ? `<label class="sr" for="${id}-q">Search ${esc(label)}</label><input id="${id}-q" class="pick-q" type="search" placeholder="Search…" autocomplete="off" data-fk="${id}-q">` : ''}
      <ul role="group" aria-label="${esc(label)}">${list}</ul>
      ${n ? `<button type="button" class="linkbtn" data-pick-none="${view}|${key}">Select none</button>` : ''}</div></details>`;
}

// A segmented single choice (zoom, grouping, level of detail).
const segmented = (label, view, key, options, value) => `<div class="f-segc" role="group" aria-label="${esc(label)}">${options.map(([v, l]) =>
  `<button type="button" data-seg="${view}|${key}" data-value="${esc(v)}" aria-pressed="${String(value) === String(v)}" data-fk="${view}-${key}-${esc(v)}">${esc(l)}</button>`).join('')}</div>`;

// Re-rendering replaces the page: keep open menus open and focus where it was.
const keptOpen = new Set();
const keptClosed = new Set(); // folds that start open but the person closed
document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (!d.matches?.('details[data-keep]')) return;
  if (d.open) { keptOpen.add(d.dataset.keep); keptClosed.delete(d.dataset.keep); } else { keptOpen.delete(d.dataset.keep); keptClosed.add(d.dataset.keep); }
}, true);
function restoreView(main, focusKey) {
  for (const d of main.querySelectorAll('details[data-keep]')) {
    if (keptOpen.has(d.dataset.keep)) d.open = true;
    else if (keptClosed.has(d.dataset.keep)) d.open = false;
  }
  if (focusKey) main.querySelector(`[data-fk="${CSS.escape(focusKey)}"]`)?.focus();
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-af-clear],[data-af-clearall],[data-reset-view],[data-seg],[data-pick-none]');
  if (!t) return;
  if (t.dataset.afClear) {
    const [view, i] = t.dataset.afClear.split('|');
    setPrefs(view, activeFilterSpecs[view].items[Number(i)].clear);
  } else if (t.dataset.afClearall) {
    const view = t.dataset.afClearall;
    setPrefs(view, activeFilterSpecs[view]?.clearAll || structuredClone(VIEW_DEFAULTS[view]));
  } else if (t.dataset.resetView) {
    resetPrefs(t.dataset.resetView);
  } else if (t.dataset.seg) {
    const [view, key] = t.dataset.seg.split('|');
    const v = t.dataset.value;
    setPrefs(view, { [key]: /^\d+$/.test(v) ? Number(v) : v });
  } else if (t.dataset.pickNone) {
    const [view, key] = t.dataset.pickNone.split('|');
    setPrefs(view, { [key]: [] });
  }
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (!t.dataset?.pick) return;
  const [view, key] = t.dataset.pick.split('|');
  const cur = view === 'roadmap' && key === 'projects' && prefs(view)[key] === null ? defaultRoadmapProjects().ids : prefs(view)[key];
  setPrefs(view, { [key]: t.type === 'radio' ? t.value : toggleIn(Array.isArray(cur) ? cur : [], t.value) });
});
// Search inside a menu filters its options in place (no re-render, so typing isn't interrupted).
document.addEventListener('input', (e) => {
  const t = e.target;
  if (!t.matches?.('.pick-q') || !t.closest('.pick-pop')) return;
  const q = t.value.trim().toLowerCase();
  const pop = t.closest('.pick-pop');
  for (const li of pop.querySelectorAll('li[data-text]')) li.hidden = !!q && !li.dataset.text.includes(q);
  for (const g of pop.querySelectorAll('li.pick-g')) g.hidden = ![...pop.querySelectorAll(`li[data-in="${CSS.escape(g.dataset.g)}"]`)].some((li) => !li.hidden);
});
// Menus close on a click outside them, and on Escape (focus goes back to the menu button).
document.addEventListener('click', (e) => {
  for (const d of document.querySelectorAll('details.pick[open]')) if (!d.contains(e.target)) { d.open = false; keptOpen.delete(d.dataset.keep); }
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const d = e.target.closest?.('details.pick[open]');
  if (d) { d.open = false; keptOpen.delete(d.dataset.keep); d.querySelector('summary').focus(); }
});

// Seen / not seen on the alerts page: the button toggles it, opening (clicking) an alert marks it seen.
document.addEventListener('click', (e) => {
  if (!alertView) return;
  const b = e.target.closest('[data-seen]');
  if (b) {
    const a = alertView.alerts.find((x) => x.id === b.dataset.seen);
    if (a) setSeen([a.id], !isSeen(a));
    return render();
  }
  if (e.target.closest('[data-seen-all]')) {
    setSeen(alertView.alerts.map((a) => a.id), true);
    return render();
  }
  const card = e.target.closest('[data-alert]');
  if (card && !e.target.closest('[data-cancel-change]') && !loadSeen()?.has(card.dataset.alert)) {
    setSeen([card.dataset.alert], true);
    if (!e.target.closest('a')) render(); else renderChrome(parseRoute());
  }
});

// ---------- archived projects (personal) ----------
// A person can archive projects they no longer need to watch (LifeCycle suggests it once every
// feature is done). Kept only in this browser; archived projects leave the Roadmap and Home
// lists, move to "Archived" in the sidebar, and stay fully readable and askable.
const ARCHIVE_KEY = 'lifecycle-archived-projects';
let archivedIds = null;
function archived() {
  if (!archivedIds) {
    try { archivedIds = new Set(JSON.parse(localStorage.getItem(ARCHIVE_KEY) || '[]')); } catch { archivedIds = new Set(); }
  }
  return archivedIds;
}
const isArchived = (projectId) => archived().has(pid(projectId));
const featureArchived = (fid) => { const p = projectOfFeature(fid); return !!p && isArchived(p.project.id); };
function setArchived(projectId, on) {
  const set = archived();
  on ? set.add(pid(projectId)) : set.delete(pid(projectId));
  try { localStorage.setItem(ARCHIVE_KEY, JSON.stringify([...set])); } catch { /* private mode */ }
  const name = projectById(pid(projectId))?.project.name || projectId;
  render();
  toast(on ? `${name} archived. It's out of your Roadmap and Home; open it from “Archived” in the sidebar anytime.` : `${name} is back in your views.`);
}
const allDone = (p) => p.features.length > 0 && p.features.every((id) => snapshot.features.find((f) => f.feature.id === id)?.state === 'done');
const archiveButton = (p, { suggest = false } = {}) => (isArchived(p.project.id)
  ? `<button type="button" class="btn small" data-archive="${esc(pid(p.project.id))}" data-on="0">Unarchive</button>`
  : `<button type="button" class="btn small${suggest ? ' suggest' : ''}" data-archive="${esc(pid(p.project.id))}" data-on="1" title="Hide it from your Roadmap and Home. You can still open it and ask about it.">${suggest ? 'All done · Archive' : 'Archive'}</button>`);
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-archive]');
  if (!b) return;
  e.preventDefault();
  e.stopPropagation();
  setArchived(b.dataset.archive, b.dataset.on === '1');
}, true);

// Delete project: removes projects/<id>.yaml for everyone. A project with features can't be deleted
// (the server checks again); the person is told which ones to move first.
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-project-delete]');
  if (!b) return;
  e.preventDefault();
  const p = projectById(b.dataset.projectDelete);
  if (!p) return;
  const names = p.features.map((id) => snapshot.features.find((f) => f.feature.id === id)?.feature.name || id);
  if (names.length) {
    alert(`${p.project.name} still has ${names.length === 1 ? '1 feature' : `${names.length} features`}:\n\n${names.map((n) => `• ${n}`).join('\n')}\n\nMove ${names.length === 1 ? 'it' : 'them'} to another project or "No project" (Edit feature), or delete ${names.length === 1 ? 'it' : 'them'}, then delete the project.`);
    return;
  }
  if (!confirm(`Delete ${p.project.name}? ${p.project.file || 'Its file'} is removed from the shared repo for everyone.`)) return;
  b.disabled = true;
  const r = await sendFeature(`/api/projects/${encodeURIComponent(p.project.id)}/delete`, 'POST', {});
  if (r.outcome === 'published') {
    await load();
    toast(r.message);
    location.hash = '#/roadmap';
    return;
  }
  b.disabled = false;
  alert(r.message || 'The project was not deleted.');
});

// When a feature has no linked work, its bar starts on the day this LifeCycle first showed it
// (remembered in this browser), so the filled part grows as time passes toward the due date.
const SEEN_FEATURES_KEY = 'lifecycle-feature-first-seen';
let firstSeenMap = null;
function firstSeen(id) {
  if (!firstSeenMap) { try { firstSeenMap = JSON.parse(localStorage.getItem(SEEN_FEATURES_KEY) || '{}') || {}; } catch { firstSeenMap = {}; } }
  if (!firstSeenMap[id]) {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    firstSeenMap[id] = d.toISOString();
    try { localStorage.setItem(SEEN_FEATURES_KEY, JSON.stringify(firstSeenMap)); } catch { /* private mode */ }
  }
  return Date.parse(firstSeenMap[id]);
}

// The naming rule, shown where people create features (docs/terminology.md).
function termsHelp({ open = false } = {}) {
  return `<details class="card explain terms" data-keep="terms-help"${open ? ' open' : ''}><summary><b>Is it a feature?</b> <span class="muted small">project, feature, step or task</span></summary>
    <table class="terms-t"><thead><tr><th></th><th scope="col">Project</th><th scope="col">Feature</th><th scope="col">Step</th><th scope="col">Task</th></tr></thead><tbody>
      <tr><th scope="row">What it is</th><td>An initiative that groups features toward one business goal</td><td>Something a user can notice or use, complete on its own</td><td>A stage of a feature (design, development, release)</td><td>The smallest unit of technical work: a PR or issue, or one item of LifeCycle's own product scope</td></tr>
      <tr><th scope="row">Lasts</th><td>Months</td><td>Weeks (1–2 sprints)</td><td>Days to weeks</td><td>Hours to days</td></tr>
      <tr><th scope="row">Example</th><td>Redeem rewards</td><td>Redeem rewards in the reader</td><td>Development (catalog team)</td><td>“Create the <code>catalog</code> table”</td></tr>
    </tbody></table>
    <p><b>Before calling something a feature, check all three:</b></p>
    <ol><li>Would a user notice it, or be able to use it, once it's on?</li><li>Can it be released or turned on by itself?</li><li>Does it fit in a few weeks?</li></ol>
    <p class="muted small">If not, it's a <b>project</b> (bigger), a <b>step</b> of a feature, or a <b>task</b> (a PR or issue linked to a step). Engineering work such as CI or release pipelines is a task or step of the features it serves, not a feature. The items of LifeCycle's own <b>product scope</b> are tasks too.</p></details>`;
}

// Options for picking features: grouped by project, then by name.
function featureOptions(list) {
  const groupOf = (f) => { const p = projectOfFeature(f.feature.id); return p ? p.project.name : 'No project'; };
  return [...list]
    .map((f) => ({ f, group: groupOf(f) }))
    .sort((a, b) => a.group.localeCompare(b.group) || a.f.feature.name.localeCompare(b.f.feature.name))
    .map(({ f, group }) => ({ value: f.feature.id, label: f.feature.name, code: '', group }));
}

// Settings for whoever set LifeCycle up, folded so the main view stays in plain words.
const setupFold = (html) => `<details class="techfold setup"><summary>How to connect it</summary><p>${html}</p></details>`;

// Teams as named on the features' steps.
function stepTeamsView() {
  const byId = byFeature();
  const by = new Map();
  for (const f of snapshot.features.filter((x) => !featureArchived(x.feature.id))) {
    for (const st of f.steps) {
      const t = st.team || st.owner;
      if (!t || /^@/.test(t)) continue;
      if (!by.has(t)) by.set(t, new Map());
      const m = by.get(t);
      if (!m.has(f.feature.id)) m.set(f.feature.id, []);
      m.get(f.feature.id).push(st);
    }
  }
  if (!by.size) return '<div class="card empty section"><strong>No teams named yet</strong>Steps name a person, not a team. Add a team as the owner of a step to see it here.</div>';
  const cards = [...by].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0])).map(([team, m]) => {
    const fs = [...m.keys()].map((id) => byId.get(id));
    const open = fs.filter((f) => f.state !== 'done');
    const blocked = fs.filter((f) => f.state === 'blocked').length;
    const rows = fs.sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state)).map((f) => `<li><a href="${href(f.feature.id)}">${esc(f.feature.name)}</a>${badge(f.state)}
      <span class="muted small">${esc(m.get(f.feature.id).map((st) => st.name).join(', '))}</span></li>`).join('');
    return `<section class="card st-team"><div class="f-cardh"><h2>${avatar(team)} ${esc(team)}</h2><span class="f-src">${plural(open.length, 'open feature')}${blocked ? ` · ${blocked} blocked` : ''}</span></div>
      <ul>${rows}</ul></section>`;
  }).join('');
  return `<div class="st-teams section">${cards}</div>`;
}

// Setting a missing due date right from the Roadmap. It publishes the feature's definition with the
// new target date, like the Edit feature page does (same validation and review), as this person.
let dueEdit = null; // feature id whose due-date form is open
const canSetDue = (f) => f.state !== 'done' && !f.feature.target_date;
function dueButton(f) {
  if (!canSetDue(f)) return '';
  if (!editAccess?.can_edit) return `<span class="due-na" title="${esc(editAccess?.reason || "You can't edit the shared feature data")}">No target date</span>`;
  return `<button type="button" class="due-btn" data-due-open="${esc(f.feature.id)}" data-fk="due-${esc(f.feature.id)}" aria-expanded="${dueEdit === f.feature.id}">+ Set due date</button>`;
}
function dueForm(f) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const min = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  return `<form class="due-form" data-due-form="${esc(f.feature.id)}"><label for="due-${esc(f.feature.id)}-d">Due date for <b>${esc(f.feature.name)}</b></label>
    <input id="due-${esc(f.feature.id)}-d" type="date" name="d" required min="${min}" data-fk="due-${esc(f.feature.id)}-d">
    <button type="submit" class="btn small primary">Save</button><button type="button" class="linkbtn" data-due-cancel>Cancel</button>
    <span class="muted small">Saved to the shared feature data, so everyone sees it.</span></form>`;
}
const dueRow = (f) => (dueEdit === f.feature.id && canSetDue(f) ? `<div class="rm-duerow">${dueForm(f)}</div>` : '');
document.addEventListener('click', (e) => {
  const o = e.target.closest('[data-due-open]');
  if (o) { e.preventDefault(); dueEdit = dueEdit === o.dataset.dueOpen ? null : o.dataset.dueOpen; render(); document.querySelector(`[data-fk="due-${CSS.escape(o.dataset.dueOpen)}-d"]`)?.focus(); return; }
  if (e.target.closest('[data-due-cancel]')) { const id = dueEdit; dueEdit = null; render(); document.querySelector(`[data-fk="due-${CSS.escape(id)}"]`)?.focus(); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && e.target.closest?.('.due-form')) { const id = dueEdit; dueEdit = null; render(); document.querySelector(`[data-fk="due-${CSS.escape(id)}"]`)?.focus(); } });
document.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-due-form]');
  if (!form) return;
  e.preventDefault();
  const id = form.dataset.dueForm, date = form.d.value;
  const name = snapshot.features.find((x) => x.feature.id === id)?.feature.name || id;
  if (!date) return;
  form.querySelectorAll('button, input').forEach((x) => { x.disabled = true; });
  toast(`Saving the due date for ${name}…`);
  try {
    const res = await fetch(`/api/features/${encodeURIComponent(id)}/definition`, { cache: 'no-store' });
    const def = await res.json();
    if (!res.ok) throw new Error(def.error || `HTTP ${res.status}`);
    const r = await sendFeature(`/api/features/${encodeURIComponent(id)}`, 'PUT', { draft: { ...def.draft, target_date: date }, base_hash: def.base_hash });
    if (r.outcome === 'published' || r.outcome === 'queued' || r.outcome === 'not_published') {
      dueEdit = null;
      toast(r.outcome === 'published' ? `${name} is now due ${fmtDay(date)}.` : `The due date for ${name} isn't shared yet: ${r.message || 'it is kept on this computer and sent when the shared data can be reached.'}`, r.outcome !== 'published');
      await load();
    } else {
      toast(`Couldn't save the due date: ${r.message || r.errors?.map((x) => x.message).join(' ') || r.outcome}`, true);
      form.querySelectorAll('button, input').forEach((x) => { x.disabled = false; });
    }
  } catch (err) {
    toast(`Couldn't save the due date: ${err.message}`, true);
    form.querySelectorAll('button, input').forEach((x) => { x.disabled = false; });
  }
});

// A short notice the person can close for good (remembered in this browser).
const DISMISS_KEY = 'lifecycle-dismissed';
function isDismissed(key) { try { return (JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]') || []).includes(key); } catch { return false; } }
function dismissible(key, html) {
  if (isDismissed(key)) return '';
  return `<div class="banner st-not_started dismiss" role="status"><span class="ico">i</span><div>${html}</div>
    <button type="button" class="dismiss-x" data-dismiss="${esc(key)}" aria-label="Close this notice">×</button></div>`;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-dismiss]');
  if (!b) return;
  try { const list = JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]') || []; localStorage.setItem(DISMISS_KEY, JSON.stringify([...new Set([...list, b.dataset.dismiss])])); } catch { /* private mode */ }
  render();
});

// ---------- full screen (Roadmap and Dependency map) ----------
const fsButton = () => `<button type="button" class="btn small fs-btn" data-fs aria-label="Full screen" title="Full screen (Esc to exit)"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 7.5v-4h4M16.5 7.5v-4h-4M3.5 12.5v4h4M16.5 12.5v4h-4"/></svg><span class="fs-l">Full screen</span></button>`;
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-fs]');
  if (!b) return;
  const host = b.closest('[data-fs-host]');
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await host.requestFullscreen();
  } catch { host.classList.toggle('fs-fallback'); }
});
document.addEventListener('fullscreenchange', () => {
  for (const b of document.querySelectorAll('[data-fs]')) {
    const on = !!document.fullscreenElement && document.fullscreenElement.contains(b);
    b.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
    b.querySelector('.fs-l').textContent = on ? 'Exit full screen' : 'Full screen';
  }
  requestAnimationFrame(() => fitNodeText(document));
});

// ---------- dependency map: click a box to see everything that depends on it ----------
// The clicked box and everything downstream of it (what depends on it, then what depends on those…)
// keep their colours; the rest of the map is dimmed. Click it again, Esc or "Clear" to go back.
let mapHl = null;
let mapDir = 'down'; // 'down': what depends on it · 'up': what it needs
function applyMapHighlight(canvas) {
  const svg = canvas?.querySelector(':scope > svg');
  if (!svg) return;
  const bar = canvas.closest('.canvas-wrap')?.querySelector('.map-hl');
  const nodes = [...svg.querySelectorAll('[data-node]')];
  const plan = document.querySelector('.goal-plan');
  if (plan) plan.innerHTML = mapHl && mapDir === 'up' ? goalPlanHtml(mapHl) : '';
  if (!mapHl) {
    svg.classList.remove('hl-on');
    for (const el of svg.querySelectorAll('.hl')) el.classList.remove('hl');
    if (bar) bar.hidden = true;
    return;
  }
  const edges = [...svg.querySelectorAll('path.edge[data-from]')];
  const set = new Set([mapHl]);
  const [a, b] = mapDir === 'up' ? ['to', 'from'] : ['from', 'to'];
  for (let grew = true; grew;) {
    grew = false;
    for (const e of edges) if (set.has(e.dataset[a]) && !set.has(e.dataset[b])) { set.add(e.dataset[b]); grew = true; }
  }
  const inView = nodes.some((n) => n.dataset.node === mapHl);
  svg.classList.toggle('hl-on', inView);
  for (const n of nodes) n.classList.toggle('hl', set.has(n.dataset.node));
  for (const e of edges) e.classList.toggle('hl', set.has(e.dataset.from) && set.has(e.dataset.to));
  const f = snapshot.features.find((x) => x.feature.id === mapHl);
  const n = set.size - 1;
  if (bar) {
    bar.hidden = false;
    bar.innerHTML = `<b>${esc(f?.feature.name || mapHl)}</b>
      <div class="f-segc" role="group" aria-label="Direction"><button type="button" data-hl-dir="down" aria-pressed="${mapDir === 'down'}">What depends on it ↓</button><button type="button" data-hl-dir="up" aria-pressed="${mapDir === 'up'}">What it needs ↑</button></div>
      <span class="muted small">${inView ? (n ? plural(n, 'item') : 'nothing') : 'not in this view'}</span>
      <a class="btn small" href="${href(mapHl)}">Open</a><button type="button" class="linkbtn" data-hl-clear>Clear</button>`;
  }
}
// "Want to get something done?": everything a feature still needs, in the order to do it.
function goalPicker() {
  const opts = featureOptions(snapshot.features);
  let last = null;
  const options = opts.map((o) => {
    const head = o.group !== last ? `${last !== null ? '</optgroup>' : ''}<optgroup label="${esc(o.group)}">` : '';
    last = o.group;
    return `${head}<option value="${esc(o.value)}"${mapHl === o.value && mapDir === 'up' ? ' selected' : ''}>${esc(o.code ? `${o.code} · ${o.label}` : o.label)}</option>`;
  }).join('') + (last !== null ? '</optgroup>' : '');
  return `<div class="goal"><label for="goal-pick"><b>Want to get something done?</b></label>
    <select id="goal-pick" data-goal data-fk="goal-pick"><option value="">Pick a feature…</option>${options}</select>
    <div class="goal-plan" aria-live="polite"></div></div>`;
}
function goalPlanHtml(goal) {
  const byId = byFeature();
  const order = [], seen = new Set();
  const visit = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    const f = byId.get(id);
    if (!f) return;
    for (const d of f.depends_on) visit(d.id);
    order.push(f);
  };
  visit(goal);
  const g = byId.get(goal);
  const todo = order.filter((f) => f.feature.id !== goal && f.state !== 'done');
  const done = order.filter((f) => f.feature.id !== goal && f.state === 'done').length;
  const nextStep = (f) => f.steps.find((st) => st.state !== 'done');
  const ready = (f) => f.depends_on.every((d) => byId.get(d.id)?.state === 'done');
  if (!g) return '';
  if (!todo.length) {
    return `<div class="plan card"><p><b>Nothing left before ${esc(g.feature.name)}.</b> ${done ? `Its ${plural(done, 'dependency')} ${done === 1 ? 'is' : 'are'} done; ` : 'It depends on nothing; '}${g.state === 'done' ? 'and it is done.' : 'it can move on its own.'}</p></div>`;
  }
  return `<div class="plan card"><div class="plan-h"><b>To get ${esc(g.feature.name)} done</b><span class="muted small">${plural(todo.length, 'item')} to finish first${done ? ` · ${done} already done` : ''}</span></div>
    <ol>${todo.map((f) => { const st = nextStep(f); return `<li><span class="plan-n" aria-hidden="true"></span><a href="${href(f.feature.id)}">${esc(f.feature.name)}</a>${badge(f.state)}
      <span class="muted small">${st ? `next: ${esc(st.name)}${st.owner ? ` · ${esc(st.owner)}` : ''}` : esc(f.feature.owner || '')}</span>${ready(f) ? '<span class="tag plan-ready">Can start now</span>' : ''}</li>`; }).join('')}
      <li class="plan-goal"><span class="plan-n" aria-hidden="true"></span><b>${esc(g.feature.name)}</b>${badge(g.state)}</li></ol></div>`;
}
document.addEventListener('change', (e) => {
  if (!e.target.matches?.('[data-goal]')) return;
  mapHl = e.target.value || null;
  mapDir = 'up';
  for (const c of document.querySelectorAll('.canvas')) applyMapHighlight(c);
  if (!document.querySelector('.canvas')) { const plan = document.querySelector('.goal-plan'); if (plan) plan.innerHTML = mapHl ? goalPlanHtml(mapHl) : ''; }
});
document.addEventListener('click', (e) => {
  const dirBtn = e.target.closest('[data-hl-dir]');
  if (dirBtn) { mapDir = dirBtn.dataset.hlDir; const sel = document.querySelector('[data-goal]'); if (sel) sel.value = mapDir === 'up' ? mapHl : ''; applyMapHighlight(dirBtn.closest('.canvas-wrap')?.querySelector('.canvas')); return; }
  if (e.target.closest('[data-hl-clear]')) { mapHl = null; const sel = document.querySelector('[data-goal]'); if (sel) sel.value = ''; applyMapHighlight(e.target.closest('.canvas-wrap')?.querySelector('.canvas')); return; }
  const node = e.target.closest('.canvas svg [data-node]');
  if (!node) return;
  e.preventDefault();
  mapHl = mapHl === node.dataset.node ? null : node.dataset.node;
  const sel = document.querySelector('[data-goal]');
  if (sel) sel.value = mapHl && mapDir === 'up' ? mapHl : '';
  applyMapHighlight(node.closest('.canvas'));
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && mapHl && !document.fullscreenElement) { mapHl = null; for (const c of document.querySelectorAll('.canvas')) applyMapHighlight(c); }
});

// ---------- dependency map zoom: buttons, pinch, or Cmd/Ctrl + wheel ----------
const ZMIN = 0.3, ZMAX = 2.5;
let mapZoom = (() => { try { return Number(localStorage.getItem('lifecycle-map-zoom')) || 1; } catch { return 1; } })();
const zoomControls = () => `<div class="map-zoom f-segc" role="group" aria-label="Zoom"><button type="button" data-mz="out" aria-label="Zoom out" title="Zoom out">−</button>
  <button type="button" data-mz="fit" class="mz-pct" aria-label="Fit the whole map" title="Fit the whole map">${Math.round(mapZoom * 100)}%</button>
  <button type="button" data-mz="in" aria-label="Zoom in" title="Zoom in">+</button></div>`;
function applyZoom(canvas, anchor) {
  const svg = canvas?.querySelector(':scope > svg[data-w]');
  if (!svg) return;
  const w = Number(svg.dataset.w), h = Number(svg.dataset.h);
  const before = { w: svg.getBoundingClientRect().width || w };
  svg.setAttribute('width', Math.round(w * mapZoom));
  svg.setAttribute('height', Math.round(h * mapZoom));
  const pct = canvas.closest('.canvas-wrap')?.querySelector('.mz-pct');
  if (pct) pct.textContent = `${Math.round(mapZoom * 100)}%`;
  if (anchor) { // keep the point under the cursor in place
    const k = (w * mapZoom) / before.w;
    canvas.scrollLeft = (canvas.scrollLeft + anchor.x) * k - anchor.x;
    canvas.scrollTop = (canvas.scrollTop + anchor.y) * k - anchor.y;
  }
  try { localStorage.setItem('lifecycle-map-zoom', String(mapZoom)); } catch { /* private mode */ }
}
const clampZoom = (z) => Math.min(ZMAX, Math.max(ZMIN, Math.round(z * 100) / 100));
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-mz]');
  if (!b) return;
  const canvas = b.closest('.canvas-wrap')?.querySelector('.canvas');
  const svg = canvas?.querySelector(':scope > svg[data-w]');
  if (!svg) return;
  if (b.dataset.mz === 'fit') {
    const cs = getComputedStyle(canvas);
    const availW = canvas.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const availH = (document.fullscreenElement === canvas.closest('.canvas-wrap') ? canvas.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) : Infinity);
    mapZoom = clampZoom(Math.min(1, availW / Number(svg.dataset.w), availH / Number(svg.dataset.h)));
  } else mapZoom = clampZoom(mapZoom * (b.dataset.mz === 'in' ? 1.2 : 1 / 1.2));
  applyZoom(canvas);
});
document.addEventListener('wheel', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const canvas = e.target.closest?.('.canvas');
  if (!canvas?.querySelector(':scope > svg[data-w]')) return;
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  mapZoom = clampZoom(mapZoom * Math.exp(-Math.max(-60, Math.min(60, e.deltaY)) * 0.004));
  applyZoom(canvas, { x: e.clientX - r.left, y: e.clientY - r.top });
}, { passive: false });

// =====================================================================================
// Teams defined in LifeCycle-Data (teams/<id>.yaml): the official list of teams and what each owns.
// Create, rename, edit and delete them here or from the chat; every save is a commit under your own
// GitHub identity. Feature pages show the teams they depend on, each with its reasons.
// =====================================================================================

const OWN_KINDS = [['repos', 'Repos'], ['tickets', 'Tickets'], ['services', 'Services'], ['apps', 'Apps'], ['flags', 'Flags']];
const ticketLabel = (t) => (t.label ? `label “${t.label}”${t.repo ? ` in ${t.repo}` : ''}` : `issues in ${t.repo}`);
const ownLabel = (k, x) => (k === 'tickets' ? ticketLabel(x) : x);
const teamName = (id) => teamDefs?.teams.find((t) => t.id === id)?.name || id;
const teamLinkHtml = (t) => `<a href="#/team/${encodeURIComponent(t.id)}">${esc(t.name)}</a>`;
const canManageTeams = () => editAccess?.can_edit;
const teamsReadOnly = () => String(editAccess?.reason || '').replace(/feature data/g, 'teams').replace(/edit features/g, 'manage teams');

async function loadTeamDefs() {
  try {
    const res = await fetch('/api/team-definitions?cached=1', { cache: 'no-store' });
    teamDefs = res.ok ? await res.json() : null;
  } catch { teamDefs = null; }
  if (['teams', 'team', 'team-edit'].includes(parseRoute().route)) render();
}

function ownsList(owns, { compact = false } = {}) {
  const rows = OWN_KINDS.filter(([k]) => owns[k].length);
  if (!rows.length) return '<span class="muted">Owns nothing yet.</span>';
  if (compact) return rows.map(([k, l]) => `${owns[k].length} ${l.toLowerCase()}`).join(' · ');
  return `<dl class="prop-dl">${rows.map(([k, l]) => `<dt>${l}</dt><dd>${owns[k].map((x) => `<code>${esc(ownLabel(k, x))}</code>`).join(' ')}</dd>`).join('')}</dl>`;
}

function definedTeamsSection() {
  if (!teamDefs) return '<div class="card empty section"><strong>Loading teams…</strong></div>';
  const d = teamDefs;
  const actions = canManageTeams() ? '<a class="btn primary" href="#/teams/new">New team</a>'
    : editAccess ? `<p class="muted small f-ro" role="note"><b>Read-only.</b> ${esc(teamsReadOnly())}</p>` : '';
  const cards = d.teams.map((t) => `<li class="card team-def"><div class="f-cardh"><h3>${teamLinkHtml(t)}</h3><span class="f-src mono">${esc(t.id)}</span></div>
    ${t.description ? `<p class="small">${esc(t.description)}</p>` : ''}<p class="muted small">${ownsList(t.owns, { compact: true })}${t.conflicts.length ? ` · <span class="f-pill" style="--s:${TONE.blocked}">${plural(t.conflicts.length, 'conflict')}</span>` : ''}</p></li>`).join('');
  // One row per problem: what's wrong, about what, and each feature it touches once (no repeats).
  const featChips = (list) => {
    const seen = new Map();
    for (const f of list) if (f && !seen.has(f.id)) seen.set(f.id, f);
    return `<span class="own-feats">${[...seen.values()].map((f) => `<a class="own-feat${f.kind ? ' other' : ''}" href="${escUrl(f.link || href(f.id))}">${f.kind ? `<span class="own-kind">${esc(f.kind)}</span>` : ''}${esc(f.name)}</a>`).join('')}</span>`;
  };
  const ownRow = (tone, label, what, detail, feats) => `<li class="own-row"><span class="f-pill" style="--s:${TONE[tone]}">${label}</span>
    <span class="own-what">${what}${detail ? `<span class="own-detail">${detail}</span>` : ''}</span>${feats}</li>`;
  const KIND_WORD = { repo: 'Repo', service: 'Service', flag: 'Flag', app: 'App', ticket: 'Tickets' };
  const issues = [
    ...d.conflicts.map((c) => ownRow('blocked', 'Conflict', esc(c.what), `claimed by ${c.teams.map((t) => esc(t.name)).join(' and ')}`, '')),
    ...d.unknown_teams.map((u) => {
      const feats = u.where.filter((w) => w.type === 'feature' || w.type === 'step').map((w) => ({ id: w.id, name: w.name, link: w.link }));
      const others = u.where.filter((w) => w.type !== 'feature' && w.type !== 'step').map((w) => ({ id: `${w.type}:${w.id}`, name: w.name, link: w.link, kind: { project: 'Project', service: 'Service', app: 'App' }[w.type] || w.type }));
      const nf = new Set(feats.map((f) => f.id)).size;
      return ownRow('risk', 'Unknown team', `“${esc(u.name)}”`, `used ${plural(u.where.length, 'time')}${nf ? ` in ${plural(nf, 'feature')}` : ''}${others.length ? ` and ${plural(others.length, 'other place')}` : ''}`, featChips([...feats, ...others]));
    }),
    ...d.no_owner.map((n) => ownRow('unknown', 'No owner', `${esc(KIND_WORD[n.kind] || n.kind)} <code>${esc(n.key)}</code>`, '', featChips(n.features.map((f) => ({ id: f.id, name: f.name }))))),
  ];
  const sugg = d.suggestions.map((g, i) => `<li><b>“${esc(g.name)}”</b> <span class="muted small">used ${plural(g.used_in.length, 'time')}</span>
    ${g.draft ? `→ team <code>${esc(g.draft.id)}</code> “${esc(g.draft.name)}”${g.draft.aliases.length ? ` <span class="muted small">(keeps “${esc(g.draft.aliases[0])}” as an alias)</span>` : ''}${canManageTeams() ? ` <button type="button" class="f-mini" data-suggest="${i}">Create this team</button>` : ''}`
      : `<span class="muted small">${esc(g.message)}</span>${canManageTeams() ? ` <button type="button" class="f-mini" data-suggest="${i}">Add as alias</button>` : ''}`}</li>`).join('');
  return `<section class="section team-defs">
    <div class="factions">${actions}</div>
    ${d.teams.length ? `<ul class="team-grid">${cards}</ul>` : '<div class="card empty"><strong>No teams defined yet</strong>Create one, or start from the suggestions below: they come from the team names already written in LifeCycle-Data.</div>'}
    ${issues.length ? `<div class="card section"><div class="f-cardh"><h2>Ownership to fix</h2><span class="f-src">${issues.length}</span></div><ul class="own-list">${issues.join('')}</ul></div>` : ''}
    ${sugg ? `<div class="card section"><div class="f-cardh"><h2>Suggested teams</h2><span class="f-src">from free-text team names in LifeCycle-Data</span></div><ul class="team-issues">${sugg}</ul></div>` : ''}
  </section>`;
}

// The teams a feature depends on: one short block per team saying why, grouped instead of one line per reason.
function teamDepsCard(deps) {
  if (!deps) return '';
  const link = (url, text) => `<a href="${escUrl(url)}"${outLink(url)}>${esc(text)}</a>`;
  const blocks = deps.teams.map((t) => {
    const own = t.reasons.filter((r) => !r.via?.length);
    const lines = [];
    if (own.some((r) => r.kind === 'owner')) lines.push('Owns this feature');
    const steps = [...new Set(own.filter((r) => r.kind === 'step').map((r) => r.text.replace(/^(does|owns) step "(.*)"$/, '$2')))];
    if (steps.length) lines.push(`<span title="${esc(steps.join(' · '))}">Works on ${plural(steps.length, 'step')}${steps.length === 1 ? `: ${esc(steps[0])}` : ''}</span>`);
    const things = [...new Map(own.filter((r) => !['owner', 'step'].includes(r.kind)).map((r) => [r.label, r])).values()];
    for (const r of things) lines.push(`Owns ${link(r.link, r.label)}`);
    const via = [...new Map(t.reasons.filter((r) => r.via?.length).map((r) => [r.via.at(-1).id, r.via.at(-1)])).values()];
    if (via.length) lines.push(`Builds ${via.map((v) => link(v.link, v.name)).join(', ')}, which this feature needs`);
    return `<li class="tdep"><div class="tdep-name">${teamLinkHtml(t.team)}</div><ul>${lines.map((l) => `<li>${l}</li>`).join('')}</ul></li>`;
  }).join('');
  const issues = [...deps.unknown_teams.map((u) => u.message), ...deps.conflicts.map((c) => c.message), ...deps.no_owner.map((n) => n.message)];
  return `<section class="card section team-deps"><div class="f-cardh"><h2>Teams it depends on</h2><span class="f-src">${plural(deps.teams.length, 'team')}</span></div>
    ${blocks ? `<ul class="tdeps">${blocks}</ul>` : '<div class="f-empty"><b>No teams yet</b><span>No team is linked to this feature.</span></div>'}
    ${issues.length ? `<ul class="team-issues small">${issues.map((m) => `<li>⚠ ${esc(m)}</li>`).join('')}</ul>` : ''}</section>`;
}

function renderDefinedTeam(id) {
  const t = teamDefs.teams.find((x) => x.id === id);
  const deps = snapshot.features.filter((f) => f.team_dependencies?.teams.some((x) => x.team.id === id));
  const actions = canManageTeams() ? `<a class="btn" href="#/team/${encodeURIComponent(id)}/edit">Edit</a><button type="button" class="btn" data-team-delete="${esc(id)}">Delete</button>`
    : editAccess ? `<p class="muted small f-ro" role="note"><b>Read-only.</b> ${esc(teamsReadOnly())}</p>` : '';
  return `${fhead('<a href="#/teams">Team</a>', `${esc(t.name)} <span class="f-src mono">${esc(t.id)}</span>`)}
    ${t.description ? `<p class="lede">${esc(t.description)}</p>` : ''}
    <div class="factions">${actions}</div>
    ${teamDeleteHtml(t)}
    <div class="two section">
      <div>
        <section class="card"><div class="f-cardh"><h2>Owns</h2><a class="f-src" href="${escUrl(t.definition_link || '#')}"${outLink(t.definition_link)}>${esc(t.file)}</a></div>${ownsList(t.owns)}
          ${t.aliases.length ? `<p class="muted small">Also matched as: ${t.aliases.map((a) => `“${esc(a)}”`).join(', ')}</p>` : ''}
          ${t.conflicts.length ? `<ul class="team-issues">${t.conflicts.map((c) => `<li>⚠ ${esc(c.message)}</li>`).join('')}</ul>` : ''}</section>
        <section class="card section"><div class="f-cardh"><h2>Features that depend on ${esc(t.name)}</h2><span class="f-src">${deps.length}</span></div>
          ${deps.length ? `<ul class="team-reasons">${deps.map((f) => `<li><a href="${href(f.feature.id)}">${esc(f.feature.name)}</a> ${badge(f.state)}<ul class="small">${f.team_dependencies.teams.find((x) => x.team.id === id).reasons.map((r) => `<li>${esc(r.text)}</li>`).join('')}</ul></li>`).join('')}</ul>` : '<p class="f-none">No feature depends on this team yet.</p>'}</section>
      </div>
      <div class="side"><div class="card deps"><div class="h">Referenced in</div>
        ${t.references.length ? `<ul class="small">${t.references.map((r) => `<li><a href="${escUrl(r.link || '#')}">${esc(r.name)}</a> <span class="muted">${esc(r.field)}</span></li>`).join('')}</ul>` : '<p class="muted small">Nothing points to this team yet.</p>'}
      </div></div>
    </div>`;
}

// ---------- team form (create / edit) ----------
const listText = (v) => (v || []).join(', ');
const splitList = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
function openTeamForm(mode, id) {
  const t = mode === 'update' ? teamDefs?.teams.find((x) => x.id === id) : null;
  const pre = mode === 'create' && sessionDraft;
  teamForm = { mode, id, busy: false, errors: [], preview: null, result: null,
    draft: t ? { id: t.id, name: t.name, description: t.description || '', aliases: [...t.aliases], owns: JSON.parse(JSON.stringify(t.owns)) }
      : pre || { id: '', name: '', description: '', aliases: [], owns: { repos: [], tickets: [], services: [], apps: [], flags: [] } } };
  sessionDraft = null;
  if (t) fetch(`/api/team-definitions/${encodeURIComponent(id)}`).then((r) => r.json()).then((x) => { if (teamForm?.id === id) teamForm.base_hash = x.base_hash; }).catch(() => {});
}
let sessionDraft = null; // a suggestion picked on the Teams page, opened in the form

function renderTeamEdit(mode, id) {
  if (!teamDefs) return '<div class="card empty"><strong>Loading teams…</strong></div>';
  if (!canManageTeams()) return `<p class="kicker">Teams</p><h1>${mode === 'create' ? 'New team' : esc(teamName(id))}</h1><div class="card empty section"><strong>Read-only</strong>${esc(teamsReadOnly() || 'Checking your access…')}</div>`;
  if (mode === 'update' && !teamDefs.teams.some((t) => t.id === id)) return '<div class="card empty"><strong>No such team</strong><a href="#/teams">All teams</a></div>';
  if (!teamForm || teamForm.mode !== mode || teamForm.id !== id) openTeamForm(mode, id);
  const f = teamForm;
  const d = f.draft;
  const err = (field) => (f.errors || []).filter((e) => e.field === field || e.field.startsWith(`${field}[`) || e.field.startsWith(`${field}.`)).map((e) => `<p class="ferr">${esc(e.field)} ${esc(e.message)}</p>`).join('');
  const other = (f.errors || []).filter((e) => !/^(id|name|description|aliases|owns)/.test(e.field));
  const ticketsRepo = d.owns.tickets.filter((t) => t.repo && !t.label).map((t) => t.repo);
  const ticketsLabel = d.owns.tickets.filter((t) => t.label).map((t) => (t.repo ? `${t.label}@${t.repo}` : t.label));
  return `<p class="kicker">Teams</p><h1>${mode === 'create' ? 'New team' : `Edit ${esc(teamName(id))}`}</h1>
    <p class="lede">Publishing commits <code>teams/${esc(d.id || '<id>')}.yaml</code> to the shared repo under your GitHub user. Teams only: no people's names, emails or handles.</p>
    ${f.result ? `<div class="banner ${f.result.ok ? 'st-done' : 'st-blocked'} section"><span class="ico">${f.result.ok ? '✓' : '×'}</span><div>${esc(f.result.message)}</div></div>` : ''}
    <form id="teamform" class="cform section" novalidate><div class="two"><div class="card fbox">
      <fieldset class="fld"><legend>Team</legend>
        <label>Name <span class="req">required</span><input name="name" value="${esc(d.name)}" placeholder="Wishlist"></label>${err('name')}
        ${mode === 'create' ? `<label>Id <span class="muted small">fixed once created: lowercase letters, digits and dashes</span><input name="id" value="${esc(d.id)}" placeholder="${esc(slugify(d.name) || 'wishlist')} (from the name if left empty)"></label>${err('id')}`
          : `<p class="muted small">Id <code>${esc(d.id)}</code> stays the same when you rename, so nothing that points to it breaks.</p>`}
        <label>Description <span class="muted small">optional</span><input name="description" value="${esc(d.description)}"></label>${err('description')}
        <label>Aliases <span class="muted small">other spellings already used in features, comma separated</span><input name="aliases" value="${esc(listText(d.aliases))}" placeholder="Wishlist team"></label>${err('aliases')}
      </fieldset>
      <fieldset class="fld"><legend>Owns <span class="muted small">comma separated</span></legend>
        <label>Repos <span class="muted small">owner/name</span><input name="repos" value="${esc(listText(d.owns.repos))}" placeholder="acme-org/acme-wishlist"></label>
        <label>Tickets: whole repos <span class="muted small">every issue in these repos</span><input name="ticket_repos" value="${esc(listText(ticketsRepo))}"></label>
        <label>Tickets: labels <span class="muted small">label, or label@owner/repo</span><input name="ticket_labels" value="${esc(listText(ticketsLabel))}" placeholder="wishlist"></label>
        <label>Services <span class="muted small">service ids</span><input name="services" value="${esc(listText(d.owns.services))}" placeholder="catalog-api"></label>
        <label>Apps or components<input name="apps" value="${esc(listText(d.owns.apps))}"></label>
        <label>Feature flags<input name="flags" value="${esc(listText(d.owns.flags))}" placeholder="redeem_rewards"></label>
        ${err('owns')}
      </fieldset>
      ${other.length ? other.map((e) => `<p class="ferr">${esc(e.field)} ${esc(e.message)}</p>`).join('') : ''}
      <div class="factions"><button class="btn" type="button" data-team-preview${f.busy ? ' disabled' : ''}>Review changes</button>
        <button class="btn primary" type="submit"${f.busy || !f.preview?.valid ? ' disabled' : ''}>Publish</button>
        <a class="btn" href="${mode === 'create' ? '#/teams' : `#/team/${encodeURIComponent(id)}`}">Cancel</a></div>
    </div>
    <div class="side"><div class="card deps"><div class="h">What will change</div>${f.preview ? `${diffHtml(f.preview.diff)}${f.preview.text ? `<pre class="small mono">${esc(f.preview.text)}</pre>` : ''}` : '<p class="muted">Press <b>Review changes</b> to validate the team and see the file.</p>'}</div></div>
    </div></form>`;
}

function readTeamForm(form) {
  const v = (n) => form.elements[n]?.value ?? '';
  const labels = splitList(v('ticket_labels')).map((x) => { const [label, repo] = x.split('@'); return { label: label.trim(), repo: repo?.trim() || null }; });
  return { id: teamForm.mode === 'create' ? v('id').trim() || slugify(v('name')) : teamForm.draft.id, name: v('name'), description: v('description'), aliases: splitList(v('aliases')),
    owns: { repos: splitList(v('repos')), tickets: [...splitList(v('ticket_repos')).map((repo) => ({ repo, label: null })), ...labels],
      services: splitList(v('services')), apps: splitList(v('apps')), flags: splitList(v('flags')) } };
}

// ---------- delete (lists what it affects first; hand over, or leave without an owner) ----------
function teamDeleteHtml(t) {
  const del = teamDelete;
  if (!del || del.id !== t.id) return '';
  const a = del.affected;
  const others = teamDefs.teams.filter((x) => x.id !== t.id);
  const list = a ? `<ul class="small">${a.owns.map((o) => `<li>owns ${esc(o.text)}</li>`).join('')}${a.references.map((r) => `<li>named in ${esc(r.name)} <span class="muted">${esc(r.field)}</span></li>`).join('')}</ul>` : '';
  const body = del.step === 'done' ? `<p>${esc(del.result.message)}</p>`
    : del.step === 'confirm_unowned' ? `<p>${esc(del.result.message)}</p>${list}<div class="factions"><button type="button" class="btn danger" data-team-del="unowned-confirm"${del.busy ? ' disabled' : ''}>Yes, delete and leave them without an owner</button><button type="button" class="btn" data-team-del="cancel">Cancel</button></div>`
      : del.step === 'decide' ? `<p>${esc(del.result.message)}</p>${list}
        <div class="factions">${others.length ? `<label>Hand over to <select data-team-handover>${others.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}</select></label><button type="button" class="btn primary" data-team-del="handover"${del.busy ? ' disabled' : ''}>Hand over and delete</button>` : ''}
          <button type="button" class="btn" data-team-del="unowned"${del.busy ? ' disabled' : ''}>Leave without an owner…</button><button type="button" class="btn" data-team-del="cancel">Cancel</button></div>`
        : `<p>Delete team ${esc(t.name)}? This commits the removal of <code>${esc(t.file)}</code> under your GitHub user.</p><div class="factions"><button type="button" class="btn danger" data-team-del="go"${del.busy ? ' disabled' : ''}>Delete</button><button type="button" class="btn" data-team-del="cancel">Cancel</button></div>`;
  return `<div class="card section team-delete" role="alertdialog" aria-label="Delete team">${body}${del.error ? `<p class="ferr">${esc(del.error)}</p>` : ''}</div>`;
}

async function sendTeam(url, body, method = 'POST') {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return res.json().catch(() => ({ outcome: 'not_published', message: `HTTP ${res.status}` }));
}

async function afterTeamPublish() {
  await load();
}

// ---------- chat: a proposed change, with its preview and Confirm / Cancel ----------
function chatActionHtml(action) {
  const st = chatActions.get(action.id) || {};
  const p = action.preview || {};
  const a = p.affected;
  const preview = action.op === 'delete'
    ? (a ? `<ul class="small">${a.owns.map((o) => `<li>owns ${esc(o.text)}</li>`).join('')}${a.references.map((r) => `<li>named in ${esc(r.name)} <span class="muted">${esc(r.field)}</span></li>`).join('')}</ul>` : '')
    : `${diffHtml(p.diff)}${p.text ? `<pre class="small mono">${esc(p.text)}</pre>` : ''}`;
  const r = st.result;
  const done = r && !['needs_decision', 'confirm_unowned'].includes(r.outcome);
  const others = (teamDefs?.teams || []).filter((t) => t.id !== action.team_id);
  let buttons = '';
  if (!action.can_confirm) buttons = action.reason ? `<p class="muted small f-ro" role="note"><b>Read-only.</b> ${esc(action.reason)}</p>` : '';
  else if (done) buttons = '';
  else if (r?.outcome === 'confirm_unowned') buttons = `<button type="button" class="btn danger" data-act="${esc(action.id)}" data-act-opt="unowned-confirm">Yes, leave them without an owner</button><button type="button" class="btn" data-act-cancel="${esc(action.id)}">Cancel</button>`;
  else if (r?.outcome === 'needs_decision') buttons = `${others.length ? `<select data-act-handover="${esc(action.id)}">${others.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}</select><button type="button" class="btn primary" data-act="${esc(action.id)}" data-act-opt="handover">Hand over and delete</button>` : ''}
    <button type="button" class="btn" data-act="${esc(action.id)}" data-act-opt="unowned">Leave without an owner…</button><button type="button" class="btn" data-act-cancel="${esc(action.id)}">Cancel</button>`;
  else buttons = `<button type="button" class="btn primary" data-act="${esc(action.id)}"${st.busy ? ' disabled' : ''}>Confirm</button><button type="button" class="btn" data-act-cancel="${esc(action.id)}">Cancel</button>`;
  return `<div class="card chat-action"><div class="f-cardh"><h3>${esc(action.title || 'Proposed change')}</h3><span class="f-src">${done ? (r.outcome === 'published' ? 'saved' : r.outcome === 'cancelled' ? 'cancelled' : 'not saved') : 'waiting for your confirmation'}</span></div>
    ${preview}${r ? `<p class="${r.outcome === 'published' || r.outcome === 'cancelled' ? '' : 'ferr'}">${esc(r.message)}</p>` : ''}<div class="factions">${buttons}</div></div>`;
}

function wireTeams(root) {
  root.querySelectorAll('[data-suggest]').forEach((b) => b.addEventListener('click', () => {
    const g = teamDefs.suggestions[Number(b.dataset.suggest)];
    if (g.draft) { sessionDraft = JSON.parse(JSON.stringify(g.draft)); teamForm = null; location.hash = '#/teams/new'; return; }
    const t = teamDefs.teams.find((x) => x.id === g.add_alias_to.id);
    openTeamForm('update', t.id);
    teamForm.draft.aliases = [...teamForm.draft.aliases, g.name];
    location.hash = `#/team/${encodeURIComponent(t.id)}/edit`;
  }));
  const form = root.querySelector('#teamform');
  if (form) {
    form.addEventListener('input', () => { teamForm.draft = readTeamForm(form); teamForm.preview = null; root.querySelector('#teamform [type=submit]').disabled = true; });
    form.querySelector('[data-team-preview]').addEventListener('click', async () => {
      teamForm.draft = readTeamForm(form);
      teamForm.busy = true; render();
      const p = await sendTeam('/api/team-definitions/preview', { op: teamForm.mode, id: teamForm.id, draft: teamForm.draft });
      teamForm.busy = false; teamForm.preview = p; teamForm.errors = p.errors || []; teamForm.result = p.message && !p.valid ? { ok: false, message: p.message } : null;
      render();
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      teamForm.draft = readTeamForm(form);
      teamForm.busy = true; render();
      const r = teamForm.mode === 'create' ? await sendTeam('/api/team-definitions', { draft: teamForm.draft })
        : await sendTeam(`/api/team-definitions/${encodeURIComponent(teamForm.id)}`, { draft: teamForm.draft, base_hash: teamForm.base_hash }, 'PUT');
      teamForm.busy = false;
      if (r.outcome === 'published') {
        toast(r.message);
        const id = r.id;
        teamForm = null;
        location.hash = `#/team/${encodeURIComponent(id)}`;
        return afterTeamPublish();
      }
      teamForm.errors = r.errors || []; teamForm.result = { ok: false, message: r.message };
      render();
    });
  }
  root.querySelectorAll('[data-team-delete]').forEach((b) => b.addEventListener('click', () => { teamDelete = { id: b.dataset.teamDelete, step: 'ask' }; render(); }));
  root.querySelectorAll('[data-team-del]').forEach((b) => b.addEventListener('click', async () => {
    const del = teamDelete;
    const opt = b.dataset.teamDel;
    if (opt === 'cancel') { teamDelete = null; return render(); }
    const body = opt === 'handover' ? { handover_to: root.querySelector('[data-team-handover]').value }
      : opt === 'unowned' ? { leave_unowned: true } : opt === 'unowned-confirm' ? { leave_unowned: true, confirm_unowned: true } : {};
    del.busy = true; render();
    const r = await sendTeam(`/api/team-definitions/${encodeURIComponent(del.id)}/delete`, body);
    del.busy = false; del.error = null;
    if (r.outcome === 'needs_decision' || r.outcome === 'confirm_unowned') { Object.assign(del, { step: r.outcome === 'needs_decision' ? 'decide' : 'confirm_unowned', result: r, affected: r.affected }); return render(); }
    if (r.outcome === 'published') { toast(r.message); teamDelete = null; location.hash = '#/teams'; return afterTeamPublish(); }
    del.error = r.message; render();
  }));
  // Chat actions.
  root.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.act;
    const opt = b.dataset.actOpt;
    const body = opt === 'handover' ? { handover_to: root.querySelector(`[data-act-handover="${id}"]`).value }
      : opt === 'unowned' ? { leave_unowned: true } : opt === 'unowned-confirm' ? { leave_unowned: true, confirm_unowned: true } : {};
    const st = chatActions.get(id) || {};
    st.busy = true; chatActions.set(id, st); render();
    st.result = await sendTeam(`/api/ask/actions/${id}/confirm`, body);
    st.busy = false; render();
    if (st.result.outcome === 'published') { toast(st.result.message); afterTeamPublish(); }
  }));
  root.querySelectorAll('[data-act-cancel]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.actCancel;
    const st = chatActions.get(id) || {};
    st.result = await sendTeam(`/api/ask/actions/${id}/cancel`, {});
    st.result.outcome = 'cancelled';
    chatActions.set(id, st); render();
  }));
}

// ---------- check for updates (src/update/) ----------
// Bottom left of the sidebar, above the theme button. Checks once when the page opens (a dot marks an
// update), and on click shows the full result: up to date, N updates with their titles, or why it
// couldn't check. An installed copy can update from here; a git working copy gets the pull command.
const updBtn = $('#update-btn');
const updDlg = $('#update-dlg');
const updBody = $('#upd-body');
const UPD_STEP = { download: 'Download the new version', unpack: 'Unpack it', libraries: 'Install its libraries', restart: 'Restart LifeCycle' };
const sha7 = (c) => (c ? String(c).slice(0, 7) : '');
const day = (iso) => (iso ? new Date(iso).toLocaleDateString([], { dateStyle: 'medium' }) : 'an unknown date');
let updResult = null;
let updPoll = null;

function markUpdate(r) {
  const on = Boolean(r?.ok && (r.state === 'update_available' || r.state === 'unknown_version'));
  updBtn.querySelector('.upd-dot').hidden = !on;
  updBtn.querySelector('.upd-sr').hidden = !on;
  if (root.classList.contains('rail')) updBtn.dataset.tip = updateTip();
}

async function runCheck() {
  try {
    const res = await fetch('/api/update', { cache: 'no-store' });
    updResult = await res.json();
  } catch {
    updResult = { ok: false, state: 'error', error: { reason: 'app_unreachable', message: "LifeCycle on this Mac didn't answer, so it couldn't check for updates.", fix: 'Reload the page. If LifeCycle is stopped, open it again from Applications.' } };
  }
  markUpdate(updResult);
  return updResult;
}

function ciWarning(ci) {
  if (!ci || !['failed', 'running'].includes(ci.state)) return '';
  const what = ci.state === 'failed'
    ? `GitHub Actions checks <b>failed</b> on this commit${ci.workflow ? ` (${esc(ci.workflow)})` : ''}, so it may have problems.`
    : `GitHub Actions checks are <b>still running</b> on this commit, so it isn't confirmed to work yet.`;
  return `<p class="upd-warn" role="note"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.2 17.5 16H2.5zM10 8v3.6M10 13.6v.2"/></svg><span>${what} You can still update; it's safer to wait unless you need it now. <a href="${escUrl(ci.url)}" target="_blank" rel="noopener">See the checks</a></span></p>`;
}

const updHead = (title, sub = '') => `<header class="upd-h"><h2 id="upd-title">${title}</h2><button type="button" class="upd-x" data-upd-close aria-label="Close">×</button></header>${sub ? `<p class="upd-sub">${sub}</p>` : ''}`;
const commitLink = (r, c) => `<a class="mono" href="https://github.com/${esc(r.repo)}/commit/${esc(c)}" target="_blank" rel="noopener">${esc(sha7(c))}</a>`;

function upgradeAction(r) {
  if (r.can_upgrade) return '<button type="button" class="btn primary" data-upd-go>Update now…</button>';
  if (r.install?.kind === 'developer') return `<div class="upd-cmd"><p>This is a git working copy, so LifeCycle doesn't update it itself. Get the changes with:</p><code>${esc(r.pull_command)}</code></div>`;
  return '<div class="upd-cmd"><p>This copy wasn\'t installed with the Mac installer, so it can\'t update itself. Download the new ZIP and run its installer:</p><code>bash ~/Downloads/operational-lifecycle-main/install.sh</code></div>';
}

function renderResult(r, note = '') {
  let html;
  if (!r) html = `${updHead('Check for updates')}<p class="upd-busy" role="status"><span class="spin" aria-hidden="true"></span>Checking GitHub for a newer LifeCycle…</p>`;
  else if (!r.ok) {
    html = `${updHead("Couldn't check for updates")}<p class="upd-err" role="alert">${esc(r.error.message)}</p><p class="upd-fix"><b>What to do:</b> ${esc(r.error.fix)}</p>
      <div class="upd-actions"><button type="button" class="btn" data-upd-check>Check again</button></div>`;
  } else if (r.state === 'up_to_date') {
    html = `${updHead('Up to date', `You're running the newest LifeCycle: commit ${commitLink(r, r.install.commit)} of main, from ${esc(day(r.install.date || r.latest?.date))}.`)}
      <div class="upd-actions"><button type="button" class="btn" data-upd-check>Check again</button></div>`;
  } else if (r.state === 'unknown_version') {
    html = `${updHead('Installed version unknown', `This copy doesn't record which commit it is (it was installed before LifeCycle kept track). Updating installs the newest main, commit ${commitLink(r, r.latest.commit)} from ${esc(day(r.latest.date))}, and keeps track from then on.`)}
      ${ciWarning(r.ci)}<div class="upd-actions">${upgradeAction(r)}</div>`;
  } else {
    const n = r.behind ?? r.commits.length;
    const shown = r.commits.slice(0, 15);
    html = `${updHead(n ? `${plural(n, 'update')} available` : 'Update available', `You're on commit ${commitLink(r, r.install.commit)}. The newest, ${commitLink(r, r.latest.commit)}, is from ${esc(day(r.latest.date))}.`)}
      ${shown.length ? `<ul class="upd-list">${shown.map((c) => `<li><a href="${escUrl(c.url)}" target="_blank" rel="noopener">${esc(c.title)}</a><span>${esc(day(c.date))}</span></li>`).join('')}</ul>` : ''}
      ${r.commits.length > shown.length ? `<p class="upd-more">and ${plural(r.commits.length - shown.length, 'more change')}</p>` : ''}
      <p><a href="${escUrl(r.compare_url)}" target="_blank" rel="noopener">View the changes on GitHub</a></p>
      ${ciWarning(r.ci)}<div class="upd-actions">${upgradeAction(r)}</div>`;
  }
  // The title and close button stay at the top; a note (e.g. "Updated…") goes right below them.
  updBody.innerHTML = note ? html.replace('</header>', () => `</header><p class="upd-ok" role="status">${note}</p>`) : html;
}

function renderConfirm(r) {
  updBody.innerHTML = `${updHead('Update LifeCycle?', `This installs commit ${commitLink(r, r.latest.commit)} of main (${esc(day(r.latest.date))}).`)}
    ${ciWarning(r.ci)}
    <ul class="upd-bul"><li>LifeCycle restarts for a moment; this page reconnects on its own.</li>
    <li>Your settings, GitHub access, history and logs are kept. You won't need to run setup again.</li>
    <li>If something goes wrong, the version you have now stays in place.</li></ul>
    <div class="upd-actions"><button type="button" class="btn" data-upd-cancel>Cancel</button><button type="button" class="btn primary" data-upd-confirm>Update now</button></div>`;
}

function renderProgress(p, offline = false) {
  const order = Object.keys(UPD_STEP);
  const at = order.indexOf(p?.step || 'download');
  updBody.innerHTML = `${updHead('Updating LifeCycle…')}
    <ol class="upd-steps">${order.map((s, i) => `<li class="${i < at ? 'done' : i === at ? 'now' : ''}">${i < at ? '<span aria-hidden="true">✓</span>' : i === at ? '<span class="spin" aria-hidden="true"></span>' : '<span class="pend" aria-hidden="true"></span>'}<span>${esc(UPD_STEP[s])}${i < at ? '<span class="sr"> (done)</span>' : ''}</span></li>`).join('')}</ol>
    <p class="upd-busy" role="status">${offline ? 'LifeCycle is restarting. This page reconnects on its own…' : 'You can keep this open; it takes about a minute.'}</p>`;
}

function renderFailed(last) {
  updBody.innerHTML = `${updHead("The update didn't finish")}
    <p class="upd-err" role="alert">The step that failed: <b>${esc(UPD_STEP[last.step] || last.step)}</b>. ${esc(last.message)}</p>
    <p class="upd-fix"><b>What to do:</b> ${esc(last.fix)}</p>
    <div class="upd-actions"><button type="button" class="btn" data-upd-check>Check again</button></div>`;
}

// Follows the upgrade, through the restart (requests fail while LifeCycle restarts), until it ends.
function followUpgrade() {
  clearInterval(updPoll);
  let sawRunning = false;
  const tick = async () => {
    let p;
    try { p = await (await fetch('/api/update/progress', { cache: 'no-store' })).json(); } catch { if (updDlg.open) renderProgress({ step: 'restart' }, true); return; }
    if (p.running) { sawRunning = true; if (updDlg.open) renderProgress(p); return; }
    if (!sawRunning && !p.last) return;
    clearInterval(updPoll);
    if (p.last?.outcome === 'ok') {
      // The new code is served now: reload to get it, then show the result.
      try { sessionStorage.setItem('lifecycle-updated', JSON.stringify(p.last)); } catch { /* private mode */ }
      location.reload();
    } else if (p.last) { if (!updDlg.open) updDlg.showModal(); renderFailed(p.last); }
  };
  updPoll = setInterval(tick, 1500);
  tick();
}

async function startUpgrade() {
  renderProgress({ step: 'download' });
  let res, body;
  try {
    res = await fetch('/api/update/upgrade', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    body = await res.json();
  } catch {
    return renderResult({ ok: false, error: { message: "LifeCycle on this Mac didn't answer, so the update didn't start.", fix: 'Reload the page and try again.' } });
  }
  if (res.status === 202 || body.reason === 'already_updating') {
    if (body.reason === 'already_updating') toast('LifeCycle is already updating. Following that update.');
    return followUpgrade();
  }
  updBody.innerHTML = `${updHead("The update didn't start")}<p class="upd-err" role="alert">${esc(body.message || body.error)}</p>${body.command ? `<div class="upd-cmd"><code>${esc(body.command)}</code></div>` : ''}${body.fix ? `<p class="upd-fix"><b>What to do:</b> ${esc(body.fix)}</p>` : ''}`;
}

async function openUpdates(note = '') {
  if (!updDlg.open) updDlg.showModal();
  renderResult(null);
  renderResult(await runCheck(), note);
}
updBtn.addEventListener('click', () => { closeDrawer(); openUpdates(); });
updDlg.addEventListener('click', (e) => {
  if (e.target === updDlg || e.target.closest('[data-upd-close]')) return updDlg.close();
  if (e.target.closest('[data-upd-check]')) return openUpdates();
  if (e.target.closest('[data-upd-go]')) return renderConfirm(updResult);
  if (e.target.closest('[data-upd-cancel]')) return renderResult(updResult);
  if (e.target.closest('[data-upd-confirm]')) return startUpgrade();
});

// Once on open: the marker, a just-finished update's result, or an update already running.
(async () => {
  let done = null;
  try { done = JSON.parse(sessionStorage.getItem('lifecycle-updated') || 'null'); sessionStorage.removeItem('lifecycle-updated'); } catch { /* ignore */ }
  if (done) return openUpdates(`✓ LifeCycle was updated to commit <span class="mono">${esc(sha7(done.to))}</span>.`);
  try {
    const p = await (await fetch('/api/update/progress', { cache: 'no-store' })).json();
    if (p.running) { updDlg.showModal(); return followUpgrade(); }
  } catch { /* checked below anyway */ }
  runCheck();
})();
