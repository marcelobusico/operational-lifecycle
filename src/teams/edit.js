// Editing a team definition from LifeCycle (the Teams page or the chat): a draft → `teams/<id>.yaml`.
//
// The written file goes through the same validation as a hand-written one (validateTeamDefinition),
// plus the cross-team checks parseDefinitions does (an id, name or alias used by two teams). On an
// update only the fields that changed are touched, so comments stay. The id never changes: a rename
// is a change of `name`, so everything that points to the team by id keeps pointing to it.
//
// A draft is { id, name, description, aliases: [text], owns: { repos, tickets: [{ repo, label }],
// services, apps, flags } }.
import { parseDocument, Document, isMap } from 'yaml';
import { parseDefinitions, TEAM_OWNS } from '../definitions.js';
import { ticketText } from './registry.js';

const ID = /^[a-z0-9][a-z0-9-]*$/;
const clean = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const cleanList = (v) => [...new Set((Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map(clean).filter(Boolean))];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const OWNS_LABEL = { repos: 'Repos', tickets: 'Tickets', services: 'Services', apps: 'Apps', flags: 'Flags' };

export const emptyOwns = () => ({ repos: [], tickets: [], services: [], apps: [], flags: [] });

// A parsed team back into a draft.
export function toTeamDraft(t) {
  return { id: t.id, name: t.name, description: t.description || '', aliases: [...t.aliases],
    owns: { repos: [...t.owns.repos], tickets: t.owns.tickets.map((x) => ({ ...x })), services: [...t.owns.services], apps: [...t.owns.apps], flags: [...t.owns.flags] } };
}

function normalizeTickets(v) {
  const out = [];
  for (const x of Array.isArray(v) ? v : []) {
    const t = typeof x === 'string' ? (x.includes('/') ? { repo: x } : { label: x }) : x || {};
    const repo = clean(t.repo) || null;
    const label = clean(t.label) || null;
    if ((repo || label) && !out.some((y) => y.repo === repo && y.label === label)) out.push({ repo, label });
  }
  return out;
}

export function normalizeTeamDraft(draft) {
  const d = draft || {};
  const o = d.owns || {};
  return { id: clean(d.id), name: clean(d.name), description: clean(d.description), aliases: cleanList(d.aliases),
    owns: { repos: cleanList(o.repos), tickets: normalizeTickets(o.tickets), services: cleanList(o.services), apps: cleanList(o.apps), flags: cleanList(o.flags) } };
}

// The YAML form of the owns block (only what is set), tickets written as { repo } or { label }.
const ownsYaml = (owns) => Object.fromEntries(TEAM_OWNS.filter((k) => owns[k].length).map((k) => [k,
  k === 'tickets' ? owns.tickets.map((t) => ({ ...(t.repo ? { repo: t.repo } : {}), ...(t.label ? { label: t.label } : {}) })) : owns[k]]));

function writeDoc(d, base) {
  const doc = base ? parseDocument(base) : new Document({ id: d.id, name: d.name });
  if (!isMap(doc.contents)) return { error: 'the current file is not a YAML mapping; fix it in the shared repo first' };
  const before = doc.toJS() || {};
  const scalar = (key, value) => {
    if (!value) { if (doc.has(key)) doc.delete(key); return; }
    if (clean(before[key]) !== value) doc.set(key, value);
  };
  scalar('name', d.name);
  scalar('description', d.description);
  if (!d.aliases.length) { if (doc.has('aliases')) doc.delete('aliases'); } else if (!same(before.aliases, d.aliases)) {
    const node = doc.createNode(d.aliases);
    node.flow = true;
    doc.set('aliases', node);
  }
  const owns = ownsYaml(d.owns);
  if (!Object.keys(owns).length) { if (doc.has('owns')) doc.delete('owns'); } else if (!same(normalizeTeamDraft({ owns: before.owns }).owns, d.owns)) {
    const node = doc.createNode(owns);
    for (const pair of node.items) if (pair.key.value !== 'tickets') pair.value.flow = true;
    doc.set('owns', node);
  }
  return { text: doc.toString({ lineWidth: 0, flowCollectionPadding: false }) };
}

// Field by field: what will change compared with the current team (base null = new team).
export function diffTeams(base, next) {
  const out = [];
  const b = base ? toTeamDraft(base) : { name: '', description: '', aliases: [], owns: emptyOwns() };
  const n = toTeamDraft(next);
  if (base && b.name !== n.name) out.push({ field: 'name', label: 'Name', from: b.name, to: n.name, rename: true });
  else if (!base) out.push({ field: 'name', label: 'Name', from: null, to: n.name });
  if (b.description !== n.description) out.push({ field: 'description', label: 'Description', from: b.description || null, to: n.description || null });
  const listDiff = (field, label, from, to, show = (x) => x) => {
    const key = (x) => JSON.stringify(x);
    const added = to.filter((x) => !from.some((y) => key(y) === key(x))).map(show);
    const removed = from.filter((x) => !to.some((y) => key(y) === key(x))).map(show);
    if (added.length || removed.length) out.push({ field, label, added, removed });
  };
  listDiff('aliases', 'Aliases', b.aliases, n.aliases);
  for (const k of TEAM_OWNS) listDiff(`owns.${k}`, `Owns: ${OWNS_LABEL[k].toLowerCase()}`, b.owns[k], n.owns[k], k === 'tickets' ? ticketText : (x) => x);
  return out;
}

// mode: create | update. base: { text, team } (update). teams: every valid team now, with files:
// Map(path → text) of the team files, so the cross-team checks see the edited file in place.
// Returns { errors, path, text, team, diff }.
export function buildTeamFile({ draft, mode, base = null, teams, files = new Map() }) {
  const d = normalizeTeamDraft(draft);
  if (mode === 'update') d.id = base.team.id;
  const errors = [];
  if (mode === 'create') {
    if (!d.id) errors.push({ field: 'id', message: 'is required' });
    else if (!ID.test(d.id)) errors.push({ field: 'id', message: 'must use lowercase letters, digits and dashes' });
    else if (teams.some((t) => t.id === d.id)) errors.push({ field: 'id', message: `"${d.id}" is already a team; edit it instead` });
  }
  if (!d.name) errors.push({ field: 'name', message: 'is required' });
  if (errors.length) return { errors };
  const path = mode === 'update' ? base.team.file : `teams/${d.id}.yaml`;
  const written = writeDoc(d, mode === 'update' ? base.text : null);
  if (written.error) return { errors: [{ field: '(file)', message: written.error }] };
  // Validate this file together with every other team file, so clashes with other teams show up.
  const teamFiles = [...files].filter(([p]) => p.startsWith('teams/') && p !== path).map(([p, text]) => ({ path: p, text }));
  const parsed = parseDefinitions([...teamFiles, { path, text: written.text }]);
  const own = parsed.invalid.filter((e) => e.file === path).map((e) => ({ field: e.field, message: e.message }));
  if (own.length) return { errors: own, text: written.text, path };
  const team = parsed.teams.find((t) => t.file === path);
  return { errors: [], path, text: written.text, team, diff: diffTeams(base?.team || null, team) };
}
