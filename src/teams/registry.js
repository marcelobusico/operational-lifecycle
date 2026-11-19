// The teams defined in LifeCycle-Data (teams/<id>.yaml) and what each owns, put next to the features,
// services and projects that point to them. LifeCycle-Data is the official list of teams; free-text
// team names elsewhere are matched to it exactly (id, name or alias), and anything that matches no
// team is reported as an "unknown team", never an error. Pure logic: no I/O. See docs/teams-format.md.
import { definitionLink } from '../changes.js';

export const TEAMS_SCHEMA = 'lifecycle.teams/v1';

// An owner that reads like a team rather than a person ("Catalog team", "Growth squad").
export const TEAMISH = /\b(team|squad|crew|guild|chapter|tribe)s?\b/i;
export const KIND_LABEL = { repo: 'repo', tickets: 'tickets', service: 'service', app: 'app', flag: 'flag' };
const KIND_PLURAL = { repo: 'repos', tickets: 'tickets', service: 'services', app: 'apps', flag: 'flags' };

export const teamSlug = (text) => String(text || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '');
export const teamHref = (id) => `/#/team/${encodeURIComponent(id)}`;
const ticketKey = (t) => (t.label ? `label:${t.label}${t.repo ? `@${t.repo}` : ''}` : `repo:${t.repo}`);
export const ticketText = (t) => (t.label ? `issues labelled "${t.label}"${t.repo ? ` in ${t.repo}` : ''}` : `issues in ${t.repo}`);

// teams: validated team definitions. features: active features. services, projects, apps: the
// other definitions. config: for definition links (optional).
export function buildTeamRegistry({ teams = [], features = [], services = [], projects = [], apps = [], config = null }) {
  const byKey = new Map();
  for (const t of teams) for (const k of [t.id, t.name, ...t.aliases]) if (!byKey.has(k)) byKey.set(k, t);
  const byId = new Map(teams.map((t) => [t.id, t]));
  const resolve = (text) => (typeof text === 'string' ? byKey.get(text.trim()) || null : null);
  const brief = (t) => ({ id: t.id, name: t.name, link: teamHref(t.id) });
  const defLink = (file) => (config && file ? definitionLink(config, file) : null);

  // Claims: what each team says it owns, plus a service's own `owner:` when it points to a team.
  const claims = new Map(); // `${kind}|${key}` → { kind, key, teams: Map(id → [via]) }
  const claim = (kind, key, team, via) => {
    const k = `${kind}|${key}`;
    if (!claims.has(k)) claims.set(k, { kind, key, teams: new Map() });
    const c = claims.get(k);
    if (!c.teams.has(team.id)) c.teams.set(team.id, []);
    c.teams.get(team.id).push(via);
  };
  for (const t of teams) {
    const via = { file: t.file, link: defLink(t.file) };
    for (const r of t.owns.repos) claim('repo', r, t, via);
    for (const s of t.owns.services) claim('service', s, t, via);
    for (const a of t.owns.apps) claim('app', a, t, via);
    for (const f of t.owns.flags) claim('flag', f, t, via);
    for (const x of t.owns.tickets) claim('tickets', ticketKey(x), t, via);
  }
  for (const s of services) {
    const t = resolve(s.owner);
    if (t) claim('service', s.id, t, { file: s.file, link: defLink(s.file), field: 'owner' });
  }
  // A mobile app (apps/<id>.yaml) whose `owner:` names a team: that team owns the app.
  for (const a of apps) {
    const t = resolve(a.owner);
    if (t) claim('app', a.id, t, { file: a.file, link: defLink(a.file), field: 'owner' });
  }
  const ticketSource = new Map(teams.flatMap((t) => t.owns.tickets.map((x) => [ticketKey(x), x])));

  // Who owns a thing: every team that claims it (two or more = an ownership conflict).
  const ownersOf = (kind, key) => [...(claims.get(`${kind}|${key}`)?.teams.keys() || [])].map((id) => byId.get(id));
  // Teams owning the issues of a repo (repo-form ticket sources). Label sources need issue labels,
  // which LifeCycle doesn't read, so they never match an issue on their own.
  const ticketOwnersOf = (repo) => ownersOf('tickets', `repo:${repo}`);

  const conflicts = [...claims.values()].filter((c) => c.teams.size > 1).map((c) => {
    const ts = [...c.teams.keys()].map((id) => byId.get(id));
    const what = c.kind === 'tickets' ? ticketText(ticketSource.get(c.key)) : `${KIND_LABEL[c.kind]} ${c.key}`;
    return { kind: c.kind, key: c.key, what, teams: ts.map(brief), evidence: [...c.teams.values()].flat().filter((v) => v.link).map((v) => ({ label: `definition ${v.file}`, link: v.link })),
      message: `Ownership conflict: ${what} is claimed by ${ts.map((t) => t.name).join(' and ')}.` };
  }).sort((a, b) => a.what.localeCompare(b.what));

  // What features use: services, the repos they deploy from and their evidence repos, flags, apps.
  const serviceById = new Map(services.map((s) => [s.id, s]));
  const usesOf = (f) => {
    const out = [];
    const add = (kind, key, why) => { if (key && !out.some((u) => u.kind === kind && u.key === key)) out.push({ kind, key, why }); };
    for (const s of f.services || []) add('service', s, `lists service ${s}`);
    for (const s of f.services || []) if (serviceById.get(s)?.repo) add('repo', serviceById.get(s).repo, `service ${s} deploys from it`);
    for (const st of [...(f.steps || []), ...(f.rampConditions || [])]) for (const e of st.evidence || []) add('repo', e.repo, `step "${st.name}" links ${e.type === 'issue' ? 'issue' : 'PR'} #${e.number}`);
    for (const x of f.flags || []) add('flag', x, `uses flag ${x}`);
    for (const a of f.apps || []) { const id = typeof a === 'string' ? a : a.id; add('app', id, `ships in app ${id}`); }
    return out;
  };
  const used = new Map();
  for (const f of features) for (const u of usesOf(f)) {
    const k = `${u.kind}|${u.key}`;
    if (!used.has(k)) used.set(k, { kind: u.kind, key: u.key, features: [] });
    used.get(k).features.push({ id: f.id, name: f.name, link: `/#/feature/${encodeURIComponent(f.id)}` });
  }
  const noOwner = [...used.values()].filter((u) => !ownersOf(u.kind, u.key).length && !(u.kind === 'repo' && ticketOwnersOf(u.key).length))
    .map((u) => ({ ...u, message: `No owner: ${KIND_LABEL[u.kind]} ${u.key} is used by ${u.features.map((f) => f.name).join(', ')} but no team owns it.` }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));

  // References to teams in features, steps, services and projects: resolved, or unknown.
  const refs = []; // { team (id|null), name, where: { type, id, name, field, step?, file } }
  const ref = (value, where, { always }) => {
    if (typeof value !== 'string' || !value.trim()) return;
    const t = resolve(value);
    if (t || always || TEAMISH.test(value)) refs.push({ team: t ? t.id : null, name: value.trim(), where });
  };
  for (const f of features) {
    const link = `/#/feature/${encodeURIComponent(f.id)}`;
    ref(f.owner, { type: 'feature', id: f.id, name: f.name, field: 'owner', file: f.file, link }, { always: false });
    f.steps.forEach((s, i) => {
      ref(s.team, { type: 'step', id: f.id, name: f.name, step: s.id, step_name: s.name, field: `steps[${i}].team`, file: f.file, link }, { always: true });
      // A step owner is usually a person; it counts as a team reference only when it names a team.
      ref(s.owner, { type: 'step', id: f.id, name: f.name, step: s.id, step_name: s.name, field: `steps[${i}].owner`, file: f.file, link }, { always: false });
    });
  }
  for (const s of services) ref(s.owner, { type: 'service', id: s.id, name: s.name, field: 'owner', file: s.file, link: defLink(s.file) }, { always: false });
  for (const a of apps) ref(a.owner, { type: 'app', id: a.id, name: a.name, field: 'owner', file: a.file, link: defLink(a.file) }, { always: false });
  for (const p of projects) ref(p.owner, { type: 'project', id: p.id, name: p.name, field: 'owner', file: p.file, link: `/#/project/${encodeURIComponent(p.id)}` }, { always: false });

  const unknownRefs = refs.filter((r) => !r.team);
  const unknownMessage = (name) => `Unknown team "${name}": no team in LifeCycle-Data (teams/) has this id, name or alias.`;
  const unknown = [...new Set(unknownRefs.map((r) => r.name))].map((name) => ({ name, message: unknownMessage(name), where: unknownRefs.filter((r) => r.name === name).map((r) => r.where) }));
  // Per feature id: its unknown team warnings (the feature still displays as usual).
  const warningsFor = (featureId) => unknownRefs.filter((r) => (r.where.type === 'feature' || r.where.type === 'step') && r.where.id === featureId)
    .map((r) => ({ kind: 'unknown_team', name: r.name, field: r.where.field, step: r.where.step || null, step_name: r.where.step_name || null,
      message: `${unknownMessage(r.name)}${r.where.step ? ` (step "${r.where.step_name}")` : ' (feature owner)'}` }));
  const referencesTo = (teamId) => refs.filter((r) => r.team === teamId).map((r) => ({ ...r.where, value: r.name }));

  // Suggested teams: the free-text team names already in LifeCycle-Data, ready to become teams.
  const suggestions = unknown.map((u) => {
    const base = u.name.replace(/\s+(team|squad)$/i, '').trim() || u.name;
    const id = teamSlug(base) || teamSlug(u.name);
    const existing = byId.get(id);
    const ownedServices = services.filter((s) => s.owner === u.name).map((s) => s.id);
    const ownedApps = apps.filter((a) => a.owner === u.name).map((a) => a.id);
    return {
      name: u.name,
      used_in: u.where,
      ...(existing ? { add_alias_to: brief(existing), message: `"${u.name}" looks like ${existing.name}: add it as an alias of team ${existing.id}.` }
        : { draft: { id, name: base === u.name ? u.name : base[0].toUpperCase() + base.slice(1), description: '', aliases: base === u.name ? [] : [u.name],
          owns: { repos: [], tickets: [], services: ownedServices, apps: ownedApps, flags: [] } } }),
    };
  }).filter((s) => s.add_alias_to || (s.draft.id && /^[a-z0-9]/.test(s.draft.id)));

  // A team's full picture for its page and the API.
  const view = (t) => ({
    ...brief(t), description: t.description, aliases: t.aliases, owns: t.owns, file: t.file, definition_link: defLink(t.file),
    conflicts: conflicts.filter((c) => c.teams.some((x) => x.id === t.id)),
    references: referencesTo(t.id),
  });

  const appById = new Map(apps.map((a) => [a.id, a]));
  return { teams, byId, resolve, appById, ownersOf, ticketOwnersOf, usesOf, conflicts, noOwner, unknown, warningsFor, referencesTo, suggestions, view, brief, serviceById };
}

// The summary served at /api/team-definitions and kept in the snapshot.
export function teamsSummary(reg) {
  return {
    schema: TEAMS_SCHEMA,
    teams: reg.teams.map(reg.view).sort((a, b) => a.name.localeCompare(b.name)),
    conflicts: reg.conflicts,
    no_owner: reg.noOwner,
    unknown_teams: reg.unknown,
    suggestions: reg.suggestions,
  };
}

export const ownsCount = (owns) => Object.entries(owns).filter(([, v]) => v.length).map(([k, v]) => `${v.length} ${v.length === 1 ? k.replace(/s$/, '') : k}`).join(', ');
export { KIND_PLURAL };
