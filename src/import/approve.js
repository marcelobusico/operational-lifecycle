// Reviewing an import proposal (docs/import-format.md) before it is added to LifeCycle-Data: the
// person edits every item, changes levels and parents, excludes items and decides what to do with
// possible duplicates. The review is then compiled into the same drafts the New feature form sends
// (src/features/edit.js), checked with the same validation and AI product review, and published one
// feature per commit through the feature publisher (src/features/publish.js).
//
// A review item is a proposal item plus what the person can change:
//   { ref, level, name, id, description, parent, owner, team, target_date, depends_on, done_when,
//     evidence, included, duplicate_choice, … read-only: source_links, level_reason, possible_duplicate,
//     … set here: check, result, published }
// parent: a proposal ref, or `existing:<id>` (a defined feature for a step, a defined project for a
// feature). depends_on: defined feature ids, or `ref:<ref>` for another proposed feature.
// A task is a PR, issue or ticket linked to a step (docs/terminology.md): its evidence goes on the step.
import crypto from 'node:crypto';
import { toDraft, slug, buildFeatureFile } from '../features/edit.js';
import { buildProjectFile } from '../projects/create.js';
import { JIRA_KEY } from '../definitions.js';
import { textHash } from '../features/publish.js';

export const REVIEW_SCHEMA = 'lifecycle.import-review/v1';
export const LEVELS = ['project', 'feature', 'step', 'task'];
// Which level each level may sit under (null: top of the tree).
export const PARENT_LEVEL = { project: [], feature: ['project'], step: ['feature'], task: ['step'] };
export const DUPLICATE_CHOICES = ['skip', 'create', 'merge'];
const EXISTING = 'existing:';
const REF = 'ref:';

const clean = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const evKey = (e) => (e.source === 'jira' ? `jira:${e.key}` : `${e.type}:${String(e.repo).toLowerCase()}#${e.number}`);

// One evidence item as the definitions accept it, or null.
function cleanEvidence(e) {
  if (!e || typeof e !== 'object') return null;
  if (e.source === 'jira') {
    const key = clean(e.key).toUpperCase();
    return JIRA_KEY.test(key) ? { source: 'jira', type: 'ticket', key } : null;
  }
  const repo = clean(e.repo);
  const number = Number(e.number);
  if (!['pr', 'issue'].includes(e.type) || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(number) || number < 1) return null;
  return { source: 'github', type: e.type, repo, number };
}
const cleanEvidenceList = (list) => [...new Map((Array.isArray(list) ? list : []).map(cleanEvidence).filter(Boolean).map((e) => [evKey(e), e])).values()];

// The proposal → a new review: every item included, duplicates waiting for the person's choice.
export function createReview(proposal, { analysisId = null } = {}) {
  const items = (proposal?.items || []).map((it) => ({
    ref: it.ref, level: it.level, original_level: it.level,
    name: it.name || '', id: it.level === 'feature' || it.level === 'project' ? slug(it.name) : '',
    description: it.description || '', parent: it.parent || null,
    owner: it.owner || '', team: '', target_date: '', depends_on: [], done_when: it.done_when || '',
    evidence: cleanEvidenceList(it.evidence),
    source_links: it.source_links || [], level_reason: it.level_reason || '', possible_duplicate: it.possible_duplicate || null,
    included: true, duplicate_choice: null, check: null, result: null, published: null,
  }));
  return {
    schema: REVIEW_SCHEMA, id: crypto.randomBytes(8).toString('hex'), analysis_id: analysisId,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), revision: 1,
    proposal: { analyzed_at: proposal?.analyzed_at || null, provider: proposal?.provider || null, sources: proposal?.sources || [], duplicates_note: proposal?.duplicates_note || null },
    items, checked_key: null, checked_at: null, last_approval: null,
  };
}

// What the person can change on an item; everything else comes from the proposal or LifeCycle.
const EDITABLE = ['level', 'name', 'id', 'description', 'parent', 'owner', 'team', 'target_date', 'depends_on', 'done_when', 'evidence', 'included', 'duplicate_choice'];
export const contentKey = (review) => textHash(JSON.stringify(review.items.map((it) => [it.ref, ...EDITABLE.map((k) => it[k])])));

// Edits from the screen ({ ref, ...fields } per item) applied to the review. Published items can't change.
export function applyEdits(review, edits) {
  const byRef = new Map(review.items.map((it) => [it.ref, it]));
  for (const e of Array.isArray(edits) ? edits : []) {
    const it = byRef.get(e?.ref);
    if (!it || it.published) continue;
    if (LEVELS.includes(e.level)) it.level = e.level;
    for (const k of ['name', 'description', 'owner', 'team', 'done_when']) if (k in e) it[k] = clean(e[k]).slice(0, k === 'description' ? 2000 : 500);
    if ('id' in e) it.id = clean(e.id).toLowerCase().slice(0, 60);
    if ('target_date' in e) it.target_date = /^\d{4}-\d{2}-\d{2}$/.test(clean(e.target_date)) ? clean(e.target_date) : '';
    if ('parent' in e) it.parent = clean(e.parent) || null;
    if ('depends_on' in e) it.depends_on = [...new Set((Array.isArray(e.depends_on) ? e.depends_on : []).map(clean).filter(Boolean))];
    if ('evidence' in e) it.evidence = cleanEvidenceList(e.evidence);
    if ('included' in e) it.included = e.included !== false;
    if ('duplicate_choice' in e) it.duplicate_choice = DUPLICATE_CHOICES.includes(e.duplicate_choice) ? e.duplicate_choice : null;
  }
  review.updated_at = new Date().toISOString();
  review.revision = (review.revision || 0) + 1;
  return review;
}

// The review → what to publish. defs: { featureDefs, projectDefs, files }.
// Returns { projects: [unit], features: [unit], status: Map(ref → { state, reason }), problems: Map(ref → [{ field, message }]) }.
//   project unit: { key, ref, draft }
//   feature unit: { key, op: create | update, id, refs: [item refs], draft, fields: Map(draft field → [ref, item field]), base_hash? }
export function compileReview(review, defs) {
  const items = review.items;
  const byRef = new Map(items.map((it) => [it.ref, it]));
  const featureDefs = defs.featureDefs || [];
  const projectDefs = defs.projectDefs || [];
  const status = new Map();
  const problems = new Map();
  const problem = (ref, field, message) => { if (!problems.has(ref)) problems.set(ref, []); problems.get(ref).push({ field, message }); };
  const dupActive = (it) => it.possible_duplicate && (it.level === 'feature' || it.level === 'project') && it.possible_duplicate.kind === it.level;

  // Why an item is not published, or null. A child of an item that is not published isn't either.
  const memo = new Map();
  function inactive(it, seen = new Set()) {
    if (memo.has(it.ref)) return memo.get(it.ref);
    let why = null;
    if (it.published) why = { state: 'published' };
    else if (!it.included) why = { state: 'excluded', reason: 'Excluded from the import.' };
    else if (dupActive(it) && it.duplicate_choice === 'skip') why = { state: 'skipped', reason: `Skipped: ${it.possible_duplicate.name} already exists.` };
    else if (it.parent && !it.parent.startsWith(EXISTING) && byRef.has(it.parent) && !seen.has(it.ref)) {
      const p = byRef.get(it.parent);
      const pw = inactive(p, new Set([...seen, it.ref]));
      if (pw && pw.state !== 'published') why = { state: 'excluded', reason: `Not imported: its ${p.level} "${p.name}" is ${pw.state === 'skipped' ? 'skipped' : 'not imported'}. Move it to another ${p.level} to import it.` };
    }
    memo.set(it.ref, why);
    return why;
  }
  for (const it of items) { const w = inactive(it); if (w) status.set(it.ref, w); }
  const active = items.filter((it) => !status.has(it.ref));

  // The parent of an active item, resolved: { kind: 'ref', item } | { kind: 'existing', id } | null.
  function parentOf(it) {
    if (!it.parent) return null;
    if (it.parent.startsWith(EXISTING)) return { kind: 'existing', id: it.parent.slice(EXISTING.length) };
    const p = byRef.get(it.parent);
    if (!p) return { kind: 'missing' };
    if (p.published) return { kind: 'existing', id: p.published.id };
    return { kind: 'ref', item: p };
  }

  // Projects: new ones, unless merged into the existing one.
  const projectIdOf = new Map(); // project ref → id features use
  const projectUnits = [];
  for (const it of active.filter((x) => x.level === 'project')) {
    if (it.parent) problem(it.ref, 'parent', 'a project sits at the top; it has no parent');
    if (dupActive(it) && !it.duplicate_choice) problem(it.ref, 'duplicate_choice', `may be the existing project ${it.possible_duplicate.name}: choose skip, create anyway, or add to the existing one`);
    if (dupActive(it) && it.duplicate_choice === 'merge') { projectIdOf.set(it.ref, it.possible_duplicate.id); continue; }
    const id = it.id || slug(it.name);
    projectIdOf.set(it.ref, id);
    projectUnits.push({ key: `project:${it.ref}`, ref: it.ref, draft: { id, name: it.name, owner: it.owner, description: it.description } });
  }
  for (const it of items.filter((x) => x.level === 'project' && x.published)) projectIdOf.set(it.ref, it.published.id);

  // Features: a new file per proposed feature, or steps added to an existing one.
  const units = new Map(); // key → unit
  const featureIdOf = new Map(); // feature ref → id
  const updateUnit = (id) => {
    const key = `update:${id}`;
    if (units.has(key)) return units.get(key);
    const base = featureDefs.find((f) => f.id === id);
    if (!base) return null;
    const draft = toDraft(base);
    draft.steps = draft.steps.map((s) => ({ ...s, add_evidence: [] }));
    const u = { key, op: 'update', id, refs: [], draft, fields: new Map(), base_hash: textHash(defs.files?.get(base.file)), name: base.name };
    units.set(key, u);
    return u;
  };
  const featureItems = active.filter((x) => x.level === 'feature');
  for (const it of featureItems) {
    if (dupActive(it) && !it.duplicate_choice) { problem(it.ref, 'duplicate_choice', `may be the existing feature ${it.possible_duplicate.name}: choose skip, create anyway, or add its steps and evidence to the existing one`); continue; }
    if (dupActive(it) && it.duplicate_choice === 'merge') {
      const u = updateUnit(it.possible_duplicate.id);
      if (!u) { problem(it.ref, 'duplicate_choice', `the existing feature "${it.possible_duplicate.id}" is no longer defined; choose create anyway or skip`); continue; }
      u.refs.push(it.ref);
      featureIdOf.set(it.ref, u.id);
      continue;
    }
    const id = it.id || slug(it.name);
    featureIdOf.set(it.ref, id);
  }
  for (const it of items.filter((x) => x.level === 'feature' && x.published)) featureIdOf.set(it.ref, it.published.id);

  for (const it of featureItems) {
    if (problems.has(it.ref) || (dupActive(it) && it.duplicate_choice === 'merge')) continue;
    const p = parentOf(it);
    let project = '';
    if (p?.kind === 'ref') {
      if (p.item.level !== 'project') problem(it.ref, 'parent', `a feature sits in a project, not in a ${p.item.level}`);
      else project = projectIdOf.get(p.item.ref) || '';
    } else if (p?.kind === 'existing') project = p.id;
    else if (p?.kind === 'missing') problem(it.ref, 'parent', 'its project is no longer in the proposal; pick another');
    const depends = [];
    for (const d of it.depends_on) {
      if (!d.startsWith(REF)) { depends.push(d); continue; }
      const other = byRef.get(d.slice(REF.length));
      const oid = other && featureIdOf.get(other.ref);
      if (!other || !oid || (status.has(other.ref) && status.get(other.ref).state !== 'published')) problem(it.ref, 'depends_on', `depends on "${other?.name || d.slice(REF.length)}", which is not imported; remove the dependency or include it`);
      else depends.push(oid);
    }
    const id = featureIdOf.get(it.ref);
    const fields = new Map([['id', [it.ref, 'id']], ['name', [it.ref, 'name']], ['owner', [it.ref, 'owner']], ['description', [it.ref, 'description']],
      ['project', [it.ref, 'parent']], ['target_date', [it.ref, 'target_date']], ['depends_on', [it.ref, 'depends_on']], ['steps', [it.ref, 'steps']], ['(file)', [it.ref, 'name']]]);
    units.set(`create:${it.ref}`, { key: `create:${it.ref}`, op: 'create', id, refs: [it.ref], fields,
      draft: { id, name: it.name, owner: it.owner, description: it.description, project, target_date: it.target_date, depends_on: depends, services: [], flags: [], steps: [] } });
  }

  // Steps, in proposal order, each with its own evidence and its tasks'.
  const unitOfFeature = (p) => {
    if (!p) return null;
    if (p.kind === 'existing') return updateUnit(p.id);
    if (p.kind !== 'ref' || p.item.level !== 'feature') return null;
    const f = p.item;
    if (dupActive(f) && f.duplicate_choice === 'merge') return updateUnit(f.possible_duplicate.id);
    return units.get(`create:${f.ref}`) || null;
  };
  const tasksOf = (ref) => active.filter((t) => t.level === 'task' && t.parent === ref);
  for (const it of active.filter((x) => x.level === 'step')) {
    const p = parentOf(it);
    const u = unitOfFeature(p);
    if (!u) {
      if (!(p?.kind === 'ref' && problems.has(p.item.ref))) problem(it.ref, 'parent', p?.kind === 'existing' ? `"${p.id}" is not a defined feature; pick another` : 'a step belongs to a feature: pick one');
      continue;
    }
    if (u.op === 'create' && !u.refs.includes(it.ref)) u.refs.push(it.ref);
    if (u.op === 'update') u.refs.push(it.ref);
    const taken = new Set(u.draft.steps.map((s) => s.id));
    let sid = slug(it.name) || `step-${u.draft.steps.length + 1}`;
    for (let n = 2; taken.has(sid); n += 1) sid = `${slug(it.name) || 'step'}-${n}`;
    const evidence = cleanEvidenceList([...it.evidence, ...tasksOf(it.ref).flatMap((t) => t.evidence)]);
    const i = u.draft.steps.length;
    u.draft.steps.push({ id: sid, name: it.name, owner: it.owner, team: it.team, done_when: it.done_when, add_evidence: evidence });
    for (const [k, f] of [['id', 'name'], ['name', 'name'], ['owner', 'owner'], ['team', 'team'], ['done_when', 'done_when'], ['evidence', 'evidence']]) u.fields.set(`steps[${i}].${k}`, [it.ref, f]);
  }
  for (const it of active.filter((x) => x.level === 'task')) {
    const p = parentOf(it);
    if (p?.kind !== 'ref' || p.item.level !== 'step') problem(it.ref, 'parent', 'a task is a PR, issue or ticket linked to a step of this proposal: pick the step');
    else if (!it.evidence.length) problem(it.ref, 'evidence', 'a task is linked as a PR, issue or Jira ticket: add one, or exclude the task');
  }
  return { projects: projectUnits, features: [...units.values()].filter((u) => u.op === 'create' || u.refs.length), status, problems };
}

// Which item and field a draft error belongs to (steps[2].evidence[0].key → that step's evidence).
export function errorTarget(unit, field) {
  if (unit.fields.has(field)) return unit.fields.get(field);
  const m = field.match(/^(steps\[\d+\])\.(\w+)/);
  if (m && unit.fields.has(`${m[1]}.${m[2]}`)) return unit.fields.get(`${m[1]}.${m[2]}`);
  if (m && unit.fields.has(`${m[1]}.name`)) return [unit.fields.get(`${m[1]}.name`)[0], m[2] === 'evidence' ? 'evidence' : 'name'];
  return [unit.refs[0], 'name'];
}

// The draft feature as the other proposed features see it (dependency checks, AI review).
const stub = (u) => ({ id: u.id, name: u.draft.name, owner: u.draft.owner, project: u.draft.project || null, targetDate: u.draft.target_date || null,
  dependsOn: u.draft.depends_on, services: [], flags: [], steps: [], rampConditions: [], file: `features/${u.id}.yaml` });

// Validates and reviews every unit. review: async (built) → reviewDefinition result.
// Returns the compiled units, each with { built, errors, review, ready }, and writes each item's
// check ({ state, errors, findings, review_note }) on the review.
export async function checkReview(review, defs, reviewFn) {
  const c = compileReview(review, defs);
  const proposedProjects = c.projects.map((p) => ({ id: p.draft.id, name: p.draft.name }));
  const projectsAll = [...(defs.projectDefs || []), ...proposedProjects];
  const creates = c.features.filter((u) => u.op === 'create');
  const checks = new Map(); // ref → { errors, findings, notes }
  const at = (ref) => { if (!checks.has(ref)) checks.set(ref, { errors: [], findings: [], notes: [] }); return checks.get(ref); };
  for (const [ref, list] of c.problems) at(ref).errors.push(...list);

  for (const p of c.projects) {
    const others = [...(defs.projectDefs || []), ...proposedProjects.filter((x) => x.id !== p.draft.id)];
    const built = buildProjectFile(p.draft, others);
    p.built = built;
    p.errors = built.errors;
    for (const e of built.errors) at(p.ref).errors.push({ field: e.field === 'id' ? 'id' : e.field, message: e.message });
    p.ready = !at(p.ref).errors.length;
  }
  for (const u of c.features) {
    const featureStubs = creates.filter((x) => x !== u).map(stub);
    const base = u.op === 'update' ? (defs.featureDefs || []).find((f) => f.id === u.id) : null;
    const features = [...(defs.featureDefs || []), ...featureStubs];
    const built = buildFeatureFile({ draft: u.draft, mode: u.op, base: base ? { text: defs.files.get(base.file), feature: base } : null,
      features, invalidIds: defs.invalidIds || new Set(), projects: projectsAll });
    u.built = built;
    u.errors = built.errors;
    for (const e of built.errors) { const [ref, field] = errorTarget(u, e.field); at(ref).errors.push({ field, message: e.message }); }
    u.review = null;
    if (!built.errors.length) {
      u.review = await reviewFn(built, features);
      for (const x of u.review.findings || []) { const [ref, field] = errorTarget(u, x.field); at(ref).findings.push({ ...x, field }); }
    }
    u.ready = !built.errors.length && !u.review?.blocking && u.refs.every((r) => !c.problems.has(r));
  }

  // Each item's state: what it belongs to decides (a step is ready when its feature is).
  const unitOf = new Map();
  for (const p of c.projects) unitOf.set(p.ref, p);
  for (const u of c.features) for (const r of u.refs) if (!unitOf.has(r) || u.op === 'create') unitOf.set(r, u);
  // Tasks follow their step.
  for (const it of review.items.filter((x) => x.level === 'task' && !c.status.has(x.ref))) {
    const su = unitOf.get(it.parent);
    if (su) unitOf.set(it.ref, su);
  }
  for (const it of review.items) {
    if (c.status.has(it.ref)) {
      const s = c.status.get(it.ref);
      it.check = s.state === 'published' ? it.check : { state: s.state, errors: [], findings: [], reason: s.reason };
      continue;
    }
    const mine = checks.get(it.ref) || { errors: [], findings: [] };
    const u = unitOf.get(it.ref);
    const blocking = mine.findings.some((x) => x.kind === 'contradiction');
    const state = mine.errors.length ? 'invalid' : blocking ? 'blocked' : !u ? 'invalid' : u.ready ? 'ready' : u.review?.blocking ? 'blocked' : 'invalid';
    const featureName = u?.op === 'update' ? u.name : u?.draft?.name;
    it.check = {
      state, errors: mine.errors, findings: mine.findings,
      reason: state === 'ready' ? null : mine.errors.length || blocking ? null
        : u ? `Can't be approved until the ${u.draft?.steps ? `feature "${featureName}"` : 'project'} it belongs to is fixed.` : null,
      review_note: u?.review && u.refs?.[0] === it.ref ? u.review.note : null,
      review_ran: u?.review ? u.review.ran : null,
      target: u ? (u.op === 'update' ? { op: 'update', id: u.id, name: u.name } : u.draft?.steps ? { op: 'create', id: u.id } : { op: 'create-project', id: u.draft.id }) : null,
    };
  }
  review.checked_key = contentKey(review);
  review.checked_at = new Date().toISOString();
  return c;
}

// Feature creates ordered so a feature comes after the proposed features it depends on.
export function publishOrder(units) {
  const creates = units.filter((u) => u.op === 'create');
  const ids = new Set(creates.map((u) => u.id));
  const out = [];
  const seen = new Set();
  const visit = (u, stack = new Set()) => {
    if (seen.has(u.id) || stack.has(u.id)) return;
    stack.add(u.id);
    for (const d of u.draft.depends_on) if (ids.has(d)) visit(creates.find((x) => x.id === d), stack);
    seen.add(u.id);
    out.push(u);
  };
  for (const u of creates) visit(u);
  return [...out, ...units.filter((u) => u.op === 'update')];
}
