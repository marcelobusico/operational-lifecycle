// The import review being worked on (docs/import-format.md, "Review and approve"): one per machine,
// saved in ~/.lifecycle/import-review.json so edits survive leaving the screen, a reload and a
// LifeCycle restart (analyses themselves are kept only in memory).
//
// Approve publishes what is ready through the feature publisher, the same path as the New feature
// form: one commit per feature under the person's GitHub identity, the conflict check, and the local
// outbox when the shared repo can't be reached. Items that fail stay in the review with their error.
import fs from 'node:fs';
import { paths, writeJson } from '../config.js';
import { createReview, applyEdits, checkReview, contentKey, publishOrder, errorTarget } from './approve.js';

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

// app: createApp(). importer: createImportService(). review: async (built, featureDefs) → AI review.
export function createReviewStore({ app, importer, review }) {
  let busy = null; // 'check' | 'approve' while one runs

  const load = () => readJson(paths.importReview());
  const save = (r) => { writeJson(paths.importReview(), r, 0o600); return r; };
  const pendingItems = (r) => r.items.filter((it) => !it.published && it.included);

  // What the screen gets: the review, whether its checks are still current, and what Approve would do.
  function view(r) {
    if (!r) return { review: null };
    const fresh = Boolean(r.checked_key) && r.checked_key === contentKey(r);
    return { review: r, fresh, busy, ready: fresh ? (r.plan || []).filter((p) => p.ready).length : 0 };
  }

  // A new review from a finished analysis. Replacing a review with unpublished edits needs replace: true.
  function start(analysisId, { replace = false } = {}) {
    const job = importer.progress(analysisId);
    if (!job) return { outcome: 'not_found', message: 'This analysis is no longer available. Press Analyze again.' };
    if (job.state !== 'done' || !job.proposal?.items?.length) return { outcome: 'invalid', message: 'This analysis has nothing to review yet.' };
    const current = load();
    if (current && current.analysis_id === analysisId) return { outcome: 'started', ...view(current) };
    if (current && !replace && current.revision > 1 && pendingItems(current).length) {
      return { outcome: 'has_review', message: `You have a review in progress (${pendingItems(current).length} items not published yet, last edited ${current.updated_at}). Starting a new one replaces it and its edits.`, ...view(current) };
    }
    return { outcome: 'started', ...view(save(createReview(job.proposal, { analysisId }))) };
  }

  function update(body) {
    const r = load();
    if (!r) return { outcome: 'not_found', message: 'There is no review in progress.' };
    if (Number.isInteger(body?.revision) && body.revision !== r.revision) {
      return { outcome: 'conflict', message: 'This review was changed in another window. Reload to see the latest edits.', ...view(r) };
    }
    applyEdits(r, body?.edits);
    return { outcome: 'saved', ...view(save(r)) };
  }

  function discard() {
    fs.rmSync(paths.importReview(), { force: true });
    return { outcome: 'discarded' };
  }

  // Re-checks every item against the definitions as they are now; records the plan (one entry per file).
  async function check(r, defs) {
    const c = await checkReview(r, defs, (built, features) => review(built, features));
    const name = (u) => (u.op === 'update' ? u.name : u.draft.name);
    const stepRefs = new Set(r.items.filter((it) => it.level === 'step').map((it) => it.ref));
    r.plan = [
      ...c.projects.map((p) => ({ kind: 'project', op: 'create', id: p.draft.id, name: p.draft.name, refs: [p.ref], ready: p.ready })),
      ...c.features.map((u) => ({ kind: 'feature', op: u.op, id: u.id, name: name(u), refs: u.refs, ready: u.ready,
        added_steps: u.op === 'update' ? u.draft.steps.slice(u.draft.steps.length - u.refs.filter((x) => stepRefs.has(x)).length).map((s) => s.name) : undefined,
        review_ran: u.review ? u.review.ran : null, review_note: u.review?.note || null })),
    ];
    return c;
  }

  async function runCheck() {
    if (busy) return { outcome: 'busy', message: `A ${busy} is already running.` };
    const r = load();
    if (!r) return { outcome: 'not_found', message: 'There is no review in progress.' };
    busy = 'check';
    try {
      const defs = await app.definitionsNow();
      await check(r, defs);
      return { outcome: 'checked', ...view(save(r)) };
    } finally { busy = null; }
  }

  // Marks the items of one published file with the outcome (and the tasks under its steps).
  function record(r, refs, outcome) {
    const all = new Set(refs);
    for (const it of r.items) if (it.level === 'task' && all.has(it.parent)) all.add(it.ref);
    for (const it of r.items) if (all.has(it.ref)) Object.assign(it, outcome(it));
  }

  async function approve() {
    if (busy) return { outcome: 'busy', message: `A ${busy} is already running.` };
    const r = load();
    if (!r) return { outcome: 'not_found', message: 'There is no review in progress.' };
    busy = 'approve';
    try {
      const fp = app.featurePublisher;
      await app.refresh(); // check and publish against the definitions as they are now
      const defs = await app.definitionsNow();
      const c = await check(r, defs);
      const local = { ...defs, featureDefs: [...defs.featureDefs], projectDefs: [...(defs.projectDefs || [])], files: defs.files };
      const results = [];
      const at = new Date().toISOString();
      const failedProjects = new Set();
      const handed = (res) => res.outcome === 'published' || res.outcome === 'queued';
      const fail = (res) => { if (res.key) fp.discard(res.key); }; // the review keeps the edit; no second copy in the outbox

      for (const p of c.projects.filter((x) => x.ready)) {
        const res = await fp.submit({ op: 'create-project', draft: p.draft, via: 'import' }, { defs: local, files: local.files, review: null });
        const ok = handed(res);
        if (ok) local.projectDefs.push(res.project || { id: p.draft.id, name: p.draft.name });
        else { failedProjects.add(p.draft.id); fail(res); }
        results.push({ kind: 'project', op: 'create', id: p.draft.id, name: p.draft.name, refs: [p.ref], outcome: res.outcome, message: res.message, link: ok ? `#/project/${p.draft.id}` : null });
        record(r, [p.ref], () => (ok
          ? { published: { kind: 'project', op: 'create', id: p.draft.id, queued: res.outcome === 'queued', at }, result: { outcome: res.outcome, message: res.message } }
          : { result: { outcome: res.outcome, message: res.message, errors: (res.errors || []).map((e) => ({ field: e.field, message: e.message })) } }));
      }

      for (const u of publishOrder(c.features.filter((x) => x.ready))) {
        const name = u.op === 'update' ? u.name : u.draft.name;
        let res;
        if (u.op === 'create' && failedProjects.has(u.draft.project)) {
          res = { outcome: 'not_published', message: `Not published: its project "${u.draft.project}" wasn't created. Fix the project, then Approve again.` };
        } else {
          res = await fp.submit({ op: u.op, id: u.op === 'update' ? u.id : null, draft: u.draft, base_hash: u.base_hash || null, via: 'import' },
            { defs: local, files: local.files, review: (built) => review(built, local.featureDefs) });
        }
        const ok = handed(res);
        if (ok) {
          const f = res.feature || u.built?.feature;
          if (f) local.featureDefs = [...local.featureDefs.filter((x) => x.id !== f.id), f];
        } else fail(res);
        results.push({ kind: 'feature', op: u.op, id: u.id, name, refs: u.refs, outcome: res.outcome, message: res.message, link: ok ? `#/feature/${u.id}` : null });
        const errors = (res.errors || []).map((e) => { const [ref, field] = errorTarget(u, e.field); return { ref, field, message: e.message }; });
        record(r, u.refs, (it) => (ok
          ? { published: { kind: 'feature', op: u.op, id: u.id, queued: res.outcome === 'queued', at }, result: { outcome: res.outcome, message: res.message } }
          : { result: { outcome: res.outcome, message: res.message, errors: errors.filter((e) => e.ref === it.ref).map(({ field, message }) => ({ field, message })) } }));
      }

      r.last_approval = { at, results };
      // What is now in LifeCycle-Data: re-read it so the Roadmap shows the new features.
      if (results.some((x) => x.outcome === 'published')) await app.refresh();
      const after = await app.definitionsNow();
      await check(r, after);
      save(r);
      return { outcome: 'approved', results, ...view(r) };
    } finally { busy = null; }
  }

  return { get: () => view(load()), start, update, discard, check: runCheck, approve };
}
