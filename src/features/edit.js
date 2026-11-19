// Editing a feature definition from LifeCycle: the form's draft → `features/<id>.yaml`.
//
// The edited file goes through exactly the validation a hand-written file does (validateDefinition),
// plus the dependency checks (unknown id, cycle) for anything the edit introduces. Only the fields
// that actually changed are touched in the YAML (yaml's Document API), so a step's evidence, the
// project and any comments are kept, and the commit shows exactly the edit.
//
// A draft is { id, name, owner, description, target_date, depends_on: [ids], services: [ids],
// flags: [keys], steps: [{ id, name, owner, team, done_when, add_evidence? }] }, plus
// optionally project and ramp_conditions (same shape as steps). A key the draft leaves out (project,
// ramp_conditions) is not touched, so a form that doesn't edit it keeps the file's value. A step's
// add_evidence ([{ source, type, repo, number }] or [{ source: jira, type: ticket, key }]) attaches PRs, issues or Jira tickets to it; evidence is never removed
// through a draft. Error `field`s use the file's own field names (name, steps[0].owner, depends_on…), which the form uses for its inputs too.
import { parseDocument, Document, isMap, isSeq, isScalar } from 'yaml';
import { validateDefinition } from '../definitions.js';
import { dependencyIssues } from '../graph.js';
import { looksLikeToken } from '../log.js';
import { evidenceId, evidenceShort } from '../evidence.js';

const ID = /^[a-z0-9][a-z0-9-]*$/;
const clean = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const cleanList = (v) => [...new Set((Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map(clean).filter(Boolean))];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const KEY_ORDER = ['id', 'name', 'owner', 'description', 'project', 'target_date', 'depends_on', 'services', 'flags', 'steps', 'ramp_conditions'];
export const STEP_FIELDS = [['name', 'name'], ['owner', 'owner'], ['team', 'team'], ['done_when', 'doneWhen']];

export const slug = (text) => clean(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '');

// linked: what the step already links, as labels ("PR team/app#12", "Jira ABC-123"), shown read-only in the editor.
const stepDraft = (s) => ({ id: s.id, name: s.name || '', owner: s.owner || '', team: s.team || '', done_when: s.doneWhen || '', evidence: s.evidence?.length || 0, linked: (s.evidence || []).map(evidenceShort) });

// A parsed feature (definitions.js shape) back into the form's draft.
export function toDraft(f) {
  return {
    id: f.id,
    name: f.name || '',
    owner: f.owner || '',
    description: f.description || '',
    project: f.project || '',
    target_date: f.targetDate || '',
    depends_on: [...(f.dependsOn || [])],
    services: [...(f.services || [])],
    flags: [...(f.flags || [])],
    steps: (f.steps || []).map(stepDraft),
    ramp_conditions: (f.rampConditions || []).map(stepDraft),
  };
}

function normalize(draft) {
  const d = draft || {};
  return {
    id: clean(d.id),
    name: clean(d.name),
    owner: clean(d.owner),
    description: clean(d.description),
    target_date: clean(d.target_date),
    depends_on: cleanList(d.depends_on),
    services: cleanList(d.services),
    flags: cleanList(d.flags),
    project: d.project === undefined ? undefined : clean(d.project),
    steps: normalizeSteps(d.steps, 'step'),
    ramp_conditions: d.ramp_conditions === undefined ? undefined : normalizeSteps(d.ramp_conditions, 'condition'),
  };
}

const evidenceKey = evidenceId;
function normalizeSteps(list, prefix) {
  return (Array.isArray(list) ? list : []).map((s, i) => ({
    id: clean(s?.id) || slug(s?.name) || `${prefix}-${i + 1}`,
    name: clean(s?.name), owner: clean(s?.owner), team: clean(s?.team), done_when: clean(s?.done_when),
    add_evidence: (Array.isArray(s?.add_evidence) ? s.add_evidence : []).map((e) => (clean(e?.source) === 'jira'
      ? { source: 'jira', type: 'ticket', key: clean(e?.key).toUpperCase() }
      : { source: clean(e?.source) || 'github', type: clean(e?.type), repo: clean(e?.repo), number: Number(e?.number) })),
  }));
}

// The draft written into the YAML document. `base` is the file text as the editor opened it (null
// for a new feature). Scalars and lists are only set when they differ from the base.
function writeDoc(d, base) {
  const doc = base ? parseDocument(base) : new Document({ id: d.id, name: d.name, owner: d.owner });
  if (!isMap(doc.contents)) return { error: 'the current file is not a YAML mapping; fix it in the shared repo first' };
  const before = doc.toJS() || {};
  // A key the file doesn't have yet goes where the README's format puts it, not at the end.
  const put = (key, value) => {
    if (doc.has(key)) return doc.set(key, value);
    const pairs = doc.contents.items;
    const rank = KEY_ORDER.indexOf(key);
    let at = 0;
    pairs.forEach((p, i) => { const k = KEY_ORDER.indexOf(isScalar(p.key) ? p.key.value : p.key); if (k >= 0 && k < rank) at = i + 1; });
    pairs.splice(at, 0, doc.createPair(key, value));
  };
  const scalar = (key, value) => {
    if (!value) { if (doc.has(key)) doc.delete(key); return; }
    if (clean(before[key] instanceof Date ? before[key].toISOString().slice(0, 10) : before[key]) !== value) put(key, value);
  };
  const list = (key, value) => {
    const old = Array.isArray(before[key]) ? before[key] : [];
    if (!value.length) { if (doc.has(key)) doc.delete(key); return; }
    if (!same(old, value) || !doc.has(key)) {
      const node = doc.createNode(value);
      const prev = doc.get(key, true);
      if (isSeq(prev)) node.flow = prev.flow; // keep the file's style ([a, b] or a block list)
      put(key, node);
    }
  };
  scalar('name', d.name);
  scalar('owner', d.owner);
  scalar('description', d.description);
  if (d.project !== undefined) scalar('project', d.project);
  scalar('target_date', d.target_date);
  list('depends_on', d.depends_on);
  list('services', d.services);
  list('flags', d.flags);

  writeSteps(doc, before, put, 'steps', d.steps, true);
  if (d.ramp_conditions !== undefined) writeSteps(doc, before, put, 'ramp_conditions', d.ramp_conditions, false);
  // New flow maps/lists follow the file's own spacing (`{ a: 1 }` or `{a: 1}`); old lines are kept as written below.
  const text = doc.toString({ lineWidth: 0, flowCollectionPadding: Boolean(base && /[{[] \S/.test(base)) });
  return { text: base ? keepSpacing(base, text) : text };
}

// Steps (or ramp conditions): an existing step keeps its node (evidence, comments, flow style) and only
// changed fields move. required: the key stays (as []) even when the list is empty.
function writeSteps(doc, before, put, key, steps, required) {
  const oldSeq = doc.get(key, true);
  if (!steps.length && !required) { if (doc.has(key)) doc.delete(key); return; }
  const oldNodes = new Map();
  if (isSeq(oldSeq)) for (const n of oldSeq.items) if (isMap(n)) oldNodes.set(clean(n.get('id')), n);
  const oldSteps = Array.isArray(before[key]) ? before[key] : [];
  const oldEvidence = (o) => (Array.isArray(o?.evidence) ? o.evidence : []).map(evidenceKey);
  // Not already linked, and each item once even if it was sent twice.
  const newEvidence = (s, o) => { const seen = new Set(oldEvidence(o)); return s.add_evidence.filter((e) => !seen.has(evidenceKey(e)) && seen.add(evidenceKey(e))); };
  const sameSteps = oldSteps.length === steps.length && steps.every((s, i) => {
    const o = oldSteps[i] || {};
    return clean(o.id) === s.id && STEP_FIELDS.every(([k]) => clean(o[k]) === s[k]) && !newEvidence(s, o).length;
  });
  if (sameSteps && doc.has(key)) return;
  const items = steps.map((s) => {
    const node = oldNodes.get(s.id);
    const o = oldSteps.find((x) => clean(x?.id) === s.id);
    const added = newEvidence(s, o);
    const evidenceNode = (e) => { const n = doc.createNode(e.source === 'jira' ? { source: e.source, type: e.type, key: e.key } : { source: e.source, type: e.type, repo: e.repo, number: e.number }); n.flow = true; return n; };
    if (!node) {
      const fresh = doc.createNode({ id: s.id, name: s.name, owner: s.owner, ...(s.team ? { team: s.team } : {}), done_when: s.done_when });
      if (added.length) { const q = doc.createNode([]); q.items = added.map(evidenceNode); fresh.set('evidence', q); }
      return fresh;
    }
    for (const [k] of STEP_FIELDS) {
      if (!s[k]) { if (node.has(k)) node.delete(k); } else if (clean(node.get(k)) !== s[k]) node.set(k, s[k]);
    }
    if (added.length) {
      const ev = node.get('evidence', true);
      if (isSeq(ev)) ev.items.push(...added.map(evidenceNode));
      else { const q = doc.createNode([]); q.items = added.map(evidenceNode); node.set('evidence', q); }
    }
    return node;
  });
  const seq = doc.createNode([]);
  seq.items = items;
  if (isSeq(oldSeq)) seq.flow = oldSeq.flow && items.length > 0 ? oldSeq.flow : false;
  put(key, seq);
}

// yaml re-prints flow lists and maps with one spacing for the whole file (`[a]` or `[ a ]`), so a
// line that differs from an original line only in that spacing is put back exactly as it was.
const unpad = (line) => line.replace(/([[{])\s+/g, '$1').replace(/\s+([\]}])/g, '$1').replace(/,\s+/g, ', ');
function keepSpacing(base, text) {
  const original = new Map(base.split('\n').map((l) => [unpad(l), l]));
  return text.split('\n').map((l) => original.get(unpad(l)) ?? l).join('\n');
}

// Draft checks the YAML validator can't see (it would report them under other names or not at all).
function draftErrors(d, { mode, features, projects, base }) {
  const errors = [];
  if (mode === 'create') {
    if (!d.id) errors.push({ field: 'id', message: 'is required' });
    else if (!ID.test(d.id)) errors.push({ field: 'id', message: 'must use lowercase letters, digits and dashes' });
    else if (features.some((f) => f.id === d.id)) errors.push({ field: 'id', message: `"${d.id}" is already a feature; open it and edit it instead` });
  }
  for (const [key, what] of [['steps', 'step'], ['ramp_conditions', 'condition']]) {
    const stepIds = new Set();
    (d[key] || []).forEach((s, i) => {
      if (!ID.test(s.id)) errors.push({ field: `${key}[${i}].id`, message: 'must use lowercase letters, digits and dashes' });
      if (stepIds.has(s.id)) errors.push({ field: `${key}[${i}].id`, message: `"${s.id}" is used by another ${what}` });
      stepIds.add(s.id);
    });
  }
  // A project the edit sets must be defined (an unchanged, already unknown one doesn't block the edit).
  if (projects && d.project && d.project !== (base?.project || '') && !projects.some((p) => p.id === d.project)) {
    errors.push({ field: 'project', message: `"${d.project}" is not a defined project (projects/${d.project}.yaml)${projects.length ? `; defined: ${projects.map((p) => p.id).join(', ')}` : ''}` });
  }
  for (const [k, v] of Object.entries({ name: d.name, owner: d.owner, description: d.description })) {
    if (looksLikeToken(v)) errors.push({ field: k, message: 'looks like a token or credential; never put credentials in the shared repo' });
  }
  return errors;
}

// Dependency problems this edit would introduce (pre-existing ones don't block an unrelated edit).
function dependencyErrors(feature, { features, invalidIds, baseFeature }) {
  const others = features.filter((f) => f.id !== feature.id);
  const issuesWith = (f) => (f ? dependencyIssues([...others, f], invalidIds).get(f.id) || [] : []);
  const before = new Set(issuesWith(baseFeature).map((i) => i.message));
  return issuesWith(feature).filter((i) => !before.has(i.message)).map((i) => ({ field: 'depends_on', message: i.message }));
}

// Field-by-field: what will change compared with the current version (base null = new feature).
export function diffFeatures(base, next) {
  const out = [];
  const b = base ? toDraft(base) : null;
  const n = toDraft(next);
  for (const [field, label] of [['name', 'Name'], ['owner', 'Owner'], ['description', 'Description'], ['project', 'Project'], ['target_date', 'Target date']]) {
    const from = b ? b[field] : '';
    if (from !== n[field]) out.push({ field, label, from: from || null, to: n[field] || null });
  }
  for (const [field, label] of [['depends_on', 'Depends on'], ['services', 'Services'], ['flags', 'Flags']]) {
    const from = b ? b[field] : [];
    const added = n[field].filter((x) => !from.includes(x));
    const removed = from.filter((x) => !n[field].includes(x));
    if (added.length || removed.length) out.push({ field, label, added, removed });
  }
  diffSteps(out, 'steps', 'Step', base?.steps || [], next.steps || []);
  diffSteps(out, 'ramp_conditions', 'Ramp condition', base?.rampConditions || [], next.rampConditions || []);
  return out;
}

// One list of steps (or ramp conditions), parsed shape: added, removed, changed fields, attached evidence, order.
function diffSteps(out, key, noun, oldList, newList) {
  const ev = evidenceShort;
  const oldSteps = oldList.map((s) => ({ ...stepDraft(s), ev: s.evidence || [] }));
  const newSteps = newList.map((s) => ({ ...stepDraft(s), ev: s.evidence || [] }));
  newSteps.forEach((s, i) => {
    const { ev: _e, ...to } = s;
    const o = oldSteps.find((x) => x.id === s.id);
    if (!o) return out.push({ field: `${key}[${i}]`, label: `${noun} "${s.name}"`, added_step: true, to, ...(s.ev.length ? { attached: s.ev.map(ev) } : {}) });
    const changes = STEP_FIELDS.map(([k]) => k).filter((k) => o[k] !== s[k]).map((k) => ({ key: k, from: o[k] || null, to: s[k] || null }));
    const attached = s.ev.filter((e) => !o.ev.some((x) => evidenceKey(x) === evidenceKey(e))).map(ev);
    if (changes.length || attached.length) out.push({ field: `${key}[${i}]`, label: `${noun} "${s.name || o.name}"`, changes, ...(attached.length ? { attached } : {}) });
  });
  for (const o of oldSteps) {
    const { ev: _e, ...from } = o;
    if (!newSteps.some((s) => s.id === o.id)) out.push({ field: key, label: `${noun} "${o.name}"`, removed_step: true, from, evidence: o.evidence });
  }
  const keptOld = oldSteps.filter((o) => newSteps.some((s) => s.id === o.id)).map((o) => o.id);
  const keptNew = newSteps.filter((s) => oldSteps.some((o) => o.id === s.id)).map((s) => s.id);
  if (!same(keptOld, keptNew)) out.push({ field: key, label: `${noun} order`, from: keptOld, to: keptNew });
}

// mode: create | update. base: { text, feature } of the current file (update only).
// Returns { errors, path, text, feature, diff }.
// projects (optional): the defined projects, so a project the edit sets must exist.
export function buildFeatureFile({ draft, mode, base = null, features, invalidIds = new Set(), projects = null }) {
  const d = normalize(draft);
  if (mode === 'update') d.id = base.feature.id;
  const errors = draftErrors(d, { mode, features, projects, base: base?.feature });
  const path = mode === 'update' ? base.feature.file : `features/${d.id}.yaml`;
  if (errors.length) return { errors };
  const written = writeDoc(d, mode === 'update' ? base.text : null);
  if (written.error) return { errors: [{ field: '(file)', message: written.error }] };
  const checked = validateDefinition(path, written.text);
  if (checked.errors.length) return { errors: checked.errors.map((e) => ({ field: e.field, message: e.message })), text: written.text, path };
  const depErrors = dependencyErrors(checked.feature, { features, invalidIds, baseFeature: base?.feature || null });
  const diff = diffFeatures(base?.feature || null, checked.feature);
  if (depErrors.length) return { errors: depErrors, text: written.text, path, diff };
  return { errors: [], path, text: written.text, feature: checked.feature, diff };
}

// Features that list `id` in depends_on (what a delete would leave pointing at nothing).
export const dependentsOf = (id, features) => features.filter((f) => f.id !== id && f.dependsOn.includes(id)).map((f) => ({ id: f.id, name: f.name, owner: f.owner }));
