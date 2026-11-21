// The import review being worked on (docs/import-format.md, "Review and approve"): one per machine,
// saved in ~/.lifecycle/import-review.json so edits survive leaving the screen, a reload and a
// LifeCycle restart (analyses themselves are kept only in memory).
//
// Approve publishes what is ready through the feature publisher, the same path as the New feature
// form: one commit per feature under the person's GitHub identity, the conflict check, and the local
// outbox when the shared repo can't be reached. Items that fail stay in the review with their error.
import fs from 'node:fs';
import { paths, writeJson } from '../config.js';
import { listFeatureOutbox, featureOutboxOutcome } from '../features/publish.js';
import { createReview, applyEdits, checkReview, contentKey, publishOrder, errorTarget, waitingDefs } from './approve.js';

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

// app: createApp(). importer: createImportService(). review: async (built, featureDefs) → AI review.
export function createReviewStore({ app, importer, review }) {
  let busy = null; // 'check' | 'approve' while one runs

  // Items queued in the outbox follow what happened to their entry since: published (as the publisher
  // recorded it) marks them published; a conflict or failure, a discard (on the feature page), or an
  // unknown end puts the item back in the review with the reason (a conflict's entry is dropped: the
  // review keeps the edit, so Approve can publish it again; a Check shows one that is already in the
  // shared repo as already defined). Not while a check or approve runs: it saves the copy it loaded.
  // A project merged into an existing one is done once each of its included features is in the shared
  // repo (not just waiting in the outbox). With none included there is nothing to add, but only Approve
  // (final) says so: settled on a load, it would lock the project's choice before anything was approved.
  // Undone if one of them comes back to the review. Returns whether anything changed.
  function settleMerged(r, { final = false } = {}) {
    let changed = false;
    for (const it of r.items.filter((x) => x.level === 'project' && x.included && x.duplicate_choice === 'merge' && x.possible_duplicate?.kind === 'project')) {
      const kids = r.items.filter((x) => x.parent === it.ref && x.included && !(x.possible_duplicate && x.duplicate_choice === 'skip'));
      const done = (kids.length || final) && kids.every((x) => x.published && !x.published.queued);
      if (done && !it.published) {
        it.published = { kind: 'project', op: 'merge', id: it.possible_duplicate.id, queued: false, at: new Date().toISOString() };
        it.result = { outcome: 'published', message: kids.length ? `Its features are in the existing project ${it.possible_duplicate.name}.` : `Nothing to add to the existing project ${it.possible_duplicate.name}: none of its features is included.` };
        changed = true;
      } else if (!done && kids.length && it.published?.op === 'merge') {
        it.published = null;
        it.result = null;
        changed = true;
      }
    }
    return changed;
  }

  // force: Approve's own re-sync after its refresh (that refresh may have published or refused them).
  function sync(r, { force = false } = {}) {
    if ((busy && !force) || !r) return r;
    const queued = r.items.filter((it) => it.published?.queued && it.published.key);
    if (!queued.length) { if (settleMerged(r)) save(r); return r; }
    const entries = new Map(listFeatureOutbox().map((e) => [e.key, e]));
    const drop = new Set();
    const back = (it, outcome, message) => { it.published = null; it.result = { outcome, message, errors: [] }; };
    for (const it of queued) {
      const e = entries.get(it.published.key);
      if (e?.state === 'pending') continue;
      if (e) {
        drop.add(e.key);
        back(it, e.state, `Not published: ${e.message || 'the shared repo refused it.'} Fix it if needed, then Approve again.`);
        continue;
      }
      const done = featureOutboxOutcome(it.published.key);
      if (done?.outcome === 'published') {
        it.published = { ...it.published, queued: false };
        it.result = { outcome: 'published', message: 'Published once the shared repo was reachable.' };
      } else if (done?.outcome === 'discarded') {
        back(it, 'not_published', 'Not published: the copy waiting on this machine was discarded. Approve again to publish it.');
      } else {
        back(it, 'not_published', 'LifeCycle can\'t tell whether this was published. Check again: if it is in the shared repo, it shows as already defined.');
      }
    }
    const moved = queued.some((it) => !it.published?.queued);
    for (const key of drop) app.featurePublisher.discard(key);
    if (moved) r.checked_key = null; // check again before approving
    if (settleMerged(r) || moved) save(r);
    return r;
  }
  const load = () => sync(readJson(paths.importReview()));
  const save = (r) => { writeJson(paths.importReview(), r, 0o600); return r; };
  // While a check or approve runs, the review can't change: it would save over the edits.
  const busyNow = () => ({ outcome: 'busy', message: `A ${busy} is running. Wait for it to finish, then edit again.` });
  const pendingItems = (r) => r.items.filter((it) => !it.published && it.included);

  // What the screen gets: the review, whether its checks are still current, and what Approve would do.
  // outbox: entries from an import that this review doesn't follow (from a review since discarded or
  // replaced). A new project's entry has no page of its own, so the import screen lists them.
  function view(r) {
    const followed = new Set((r?.items || []).map((it) => it.published?.queued && it.published.key).filter(Boolean));
    const outbox = listFeatureOutbox().filter((e) => e.via === 'import' && !followed.has(e.key))
      .map(({ key, op, kind, name, state, message, created_at }) => ({ key, op, kind: kind || 'feature', name, state, message, created_at }));
    if (!r) return { review: null, outbox };
    const fresh = Boolean(r.checked_key) && r.checked_key === contentKey(r);
    return { review: r, fresh, busy, outbox, ready: fresh ? (r.plan || []).filter((p) => p.ready).length : 0 };
  }

  // A new review from a finished analysis. Replacing a review with unpublished edits needs replace: true.
  function start(analysisId, { replace = false } = {}) {
    if (busy) return busyNow();
    const job = importer.progress(analysisId);
    if (!job) return { outcome: 'not_found', message: 'This analysis is no longer available. Press Analyze again.' };
    if (job.state !== 'done' || !job.proposal?.items?.length) return { outcome: 'invalid', message: 'This analysis has nothing to review yet.' };
    const current = load();
    if (current && current.analysis_id === analysisId) return { outcome: 'started', ...view(current) };
    // Worth keeping: edits, or an approval (failed items to fix), or items still waiting for the repo.
    const worked = current && (current.revision > 1 || current.last_approval);
    const waiting = current ? current.items.filter((it) => it.published?.queued).length : 0;
    if (current && !replace && ((worked && pendingItems(current).length) || waiting)) {
      const parts = [pendingItems(current).length && `${pendingItems(current).length} items not published yet`, waiting && `${waiting} waiting for the shared repo`].filter(Boolean).join(', ');
      return { outcome: 'has_review', message: `You have a review in progress (${parts}, last changed ${current.updated_at}). Starting a new one replaces it and its edits.`, ...view(current) };
    }
    return { outcome: 'started', ...view(save(createReview(job.proposal, { analysisId }))) };
  }

  function update(body) {
    if (busy) return { ...busyNow(), ...view(load()) };
    const r = load();
    if (!r) return { outcome: 'not_found', message: 'There is no review in progress.' };
    if (Number.isInteger(body?.revision) && body.revision !== r.revision) {
      return { outcome: 'conflict', message: 'This review was changed in another window. Reload to see the latest edits.', ...view(r) };
    }
    applyEdits(r, body?.edits);
    return { outcome: 'saved', ...view(save(r)) };
  }

  function discard() {
    if (busy) return busyNow();
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

  // Marks the items of one published file with the outcome, and the tasks under its steps whose
  // evidence went into that file (included and valid: c is the check the file was built from).
  function record(r, refs, outcome, c) {
    const all = new Set(refs);
    for (const it of r.items) if (it.level === 'task' && all.has(it.parent) && it.included && !c.status.has(it.ref) && !c.problems.has(it.ref)) all.add(it.ref);
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
      // That refresh retried the outbox: what it refused is back in the review, not counted as defined.
      sync(r, { force: true });
      const defs = await app.definitionsNow();
      const c = await check(r, defs);
      // What this review already sent to the outbox counts as defined (its features go after it there).
      const waiting = waitingDefs(r);
      const local = { ...defs, featureDefs: [...defs.featureDefs, ...waiting.features.filter((w) => !defs.featureDefs.some((f) => f.id === w.id))],
        projectDefs: [...(defs.projectDefs || []), ...waiting.projects.filter((w) => !(defs.projectDefs || []).some((p) => p.id === w.id))], files: defs.files };
      const results = [];
      const at = new Date().toISOString();
      // Saved after each file, so what was committed is on disk even if a later step throws.
      r.last_approval = { at, results };
      const newProjects = new Map(c.projects.map((p) => [p.draft.id, p.draft.name]));
      const createdProjects = new Set();
      const newFeatures = new Map(c.features.filter((u) => u.op === 'create').map((u) => [u.id, u.draft.name]));
      const createdFeatures = new Set();
      const handed = (res) => res.outcome === 'published' || res.outcome === 'queued';
      const fail = (res) => { if (res.key) fp.discard(res.key); }; // the review keeps the edit; no second copy in the outbox

      // link: only once it is in the shared repo; a page for one still waiting would say "Not defined".
      for (const p of c.projects.filter((x) => x.ready)) {
        const res = await fp.submit({ op: 'create-project', draft: p.draft, via: 'import' }, { defs: local, files: local.files, review: null });
        const ok = handed(res);
        if (ok) { createdProjects.add(p.draft.id); local.projectDefs.push(res.project || { id: p.draft.id, name: p.draft.name }); }
        else fail(res);
        results.push({ kind: 'project', op: 'create', id: p.draft.id, name: p.draft.name, refs: [p.ref], outcome: res.outcome, message: res.message, link: res.outcome === 'published' ? `#/project/${p.draft.id}` : null });
        record(r, [p.ref], () => (ok
          ? { published: { kind: 'project', op: 'create', id: p.draft.id, queued: res.outcome === 'queued', key: res.key || null, at }, result: { outcome: res.outcome, message: res.message } }
          : { result: { outcome: res.outcome, message: res.message, errors: (res.errors || []).map((e) => ({ field: e.field, message: e.message })) } }), c);
        save(r);
      }

      for (const u of publishOrder(c.features.filter((x) => x.ready))) {
        const name = u.op === 'update' ? u.name : u.draft.name;
        let res;
        // What it needs from this proposal must have been created first (a project, or a feature it depends on).
        const project = u.op === 'create' && newProjects.has(u.draft.project) && !createdProjects.has(u.draft.project) ? newProjects.get(u.draft.project) : null;
        const dep = u.op === 'create' ? u.draft.depends_on.find((d) => newFeatures.has(d) && !createdFeatures.has(d)) : null;
        if (project) {
          res = { outcome: 'not_published', message: `Not published: its new project "${project}" wasn't created. Fix the project, then Approve again.`,
            errors: [{ field: 'project', message: `its new project "${project}" wasn't created; fix the project first` }] };
        } else if (dep) {
          res = { outcome: 'not_published', message: `Not published: it depends on "${newFeatures.get(dep)}", which wasn't published. Fix that feature, then Approve again.`,
            errors: [{ field: 'depends_on', message: `depends on "${newFeatures.get(dep)}", which wasn't published` }] };
        } else {
          res = await fp.submit({ op: u.op, id: u.op === 'update' ? u.id : null, draft: u.draft, base_hash: u.base_hash || null, via: 'import' },
            { defs: local, files: local.files, review: (built) => review(built, local.featureDefs) });
        }
        const ok = handed(res);
        if (ok) {
          const f = res.feature || u.built?.feature;
          if (f) local.featureDefs = [...local.featureDefs.filter((x) => x.id !== f.id), f];
          createdFeatures.add(u.id);
        } else fail(res);
        results.push({ kind: 'feature', op: u.op, id: u.id, name, refs: u.refs, outcome: res.outcome, message: res.message, link: res.outcome === 'published' ? `#/feature/${u.id}` : null });
        const errors = (res.errors || []).map((e) => { const [ref, field] = errorTarget(u, e.field); return { ref, field, message: e.message }; });
        record(r, u.refs, (it) => (ok
          ? { published: { kind: 'feature', op: u.op, id: u.id, queued: res.outcome === 'queued', key: res.key || null, at }, result: { outcome: res.outcome, message: res.message } }
          : { result: { outcome: res.outcome, message: res.message, errors: errors.filter((e) => e.ref === it.ref).map(({ field, message }) => ({ field, message })) } }), c);
        save(r);
      }
      settleMerged(r, { final: true });
      save(r);

      // What is now in LifeCycle-Data: re-read it so the Roadmap shows the new features. If that fails,
      // what was published is already saved; the review just needs a new Check.
      try {
        if (results.some((x) => x.outcome === 'published')) await app.refresh();
        await check(r, await app.definitionsNow());
      } catch (err) {
        r.checked_key = null;
        r.last_approval.note = `Published as listed, but LifeCycle couldn't read the shared repo again (${err.message}). Press Check.`;
      }
      save(r);
      return { outcome: 'approved', results, ...view(r) };
    } finally { busy = null; }
  }

  return { get: () => view(load()), start, update, discard, check: runCheck, approve };
}
