// The import review store (src/import/review-store.js) with a stand-in app and publisher: what
// happens while a check runs, and what Approve does when a new project isn't created.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateDefinition } from '../src/definitions.js';
import { createReviewStore } from '../src/import/review-store.js';

const CHECKOUT_YAML = 'id: checkout\nname: Checkout\nowner: ana\nsteps:\n  - id: build\n    name: Build\n    owner: ana\n    done_when: merged\n';
const defs = () => ({ featureDefs: [validateDefinition('features/checkout.yaml', CHECKOUT_YAML).feature], projectDefs: [], invalidIds: new Set(),
  files: new Map([['features/checkout.yaml', CHECKOUT_YAML]]) });
const importer = { progress: () => ({ state: 'done', proposal: { items: [
  { ref: 'p1', level: 'project', name: 'Wallet', owner: 'bo' },
  { ref: 'f1', level: 'feature', name: 'Top up', parent: 'p1', owner: 'bo' },
  { ref: 's1', level: 'step', name: 'API', parent: 'f1', owner: 'cy', done_when: 'deployed' },
] } }) };
const noAi = async () => ({ ran: false, findings: [], blocking: false, note: 'did not run' });

beforeEach(() => { process.env.LIFECYCLE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-review-store-')); });

test('while a check runs, edits, discard and a new review are refused, so the check does not save over them', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const app = { definitionsNow: async () => { await gate; return defs(); }, refresh: async () => {}, featurePublisher: {} };
  const store = createReviewStore({ app, importer, review: noAi });
  const { review } = store.start('a1');
  const running = store.check();
  const edit = store.update({ revision: review.revision, edits: [{ ref: 'f1', owner: 'Growth squad' }] });
  assert.equal(edit.outcome, 'busy');
  assert.match(edit.message, /check is running/);
  assert.equal(store.discard().outcome, 'busy');
  assert.equal(store.start('a2', { replace: true }).outcome, 'busy');
  release();
  assert.equal((await running).outcome, 'checked');
  const after = store.get();
  assert.equal(after.review.analysis_id, 'a1', 'the review is still there');
  const saved = store.update({ revision: after.review.revision, edits: [{ ref: 'f1', owner: 'Growth squad' }] });
  assert.equal(saved.outcome, 'saved', 'editing works again once the check is done');
  assert.equal(store.get().review.items.find((x) => x.ref === 'f1').owner, 'Growth squad');
});

test('when a new project is not created at Approve, its features are not submitted and say why on their project field', async () => {
  const submitted = [];
  const discarded = [];
  const featurePublisher = {
    submit: async (body) => { submitted.push(body.op); return body.op === 'create-project' ? { outcome: 'conflict', key: 'k-proj', message: 'Not published: wallet was created by someone else.' } : { outcome: 'published', key: 'k-f' }; },
    discard: (key) => discarded.push(key),
  };
  const store = createReviewStore({ app: { definitionsNow: async () => defs(), refresh: async () => {}, featurePublisher }, importer, review: noAi });
  store.start('a1');
  const r = await store.approve();
  assert.deepEqual(submitted, ['create-project'], 'the feature is not sent');
  assert.deepEqual(discarded, ['k-proj']);
  assert.deepEqual(r.results.map((x) => [x.kind, x.outcome]), [['project', 'conflict'], ['feature', 'not_published']]);
  const f1 = r.review.items.find((x) => x.ref === 'f1');
  assert.equal(f1.published, null);
  assert.deepEqual(f1.result.errors, [{ field: 'parent', message: 'its new project "Wallet" wasn\'t created; fix the project first' }]);
});

// Outbox files as the publisher writes them (src/features/publish.js).
const outboxDir = () => path.join(process.env.LIFECYCLE_HOME, 'outbox', 'features');
const writeEntry = (e) => { fs.mkdirSync(outboxDir(), { recursive: true }); fs.writeFileSync(path.join(outboxDir(), `${e.key}.json`), JSON.stringify(e)); };
const writeOutcome = (key, outcome) => { fs.mkdirSync(path.join(outboxDir(), 'done'), { recursive: true }); fs.writeFileSync(path.join(outboxDir(), 'done', `${key}.json`), JSON.stringify({ key, outcome, at: new Date().toISOString() })); };
const queuing = { submit: async (body) => ({ outcome: 'queued', key: body.op === 'create-project' ? 'k-proj' : 'k-feat', message: 'Not published yet.' }), discard: () => {} };

test('a queued item is published only when the outbox recorded it published; a discarded or unknown entry puts it back in the review', async () => {
  const store = createReviewStore({ app: { definitionsNow: async () => defs(), refresh: async () => {}, featurePublisher: queuing }, importer, review: noAi });
  store.start('a1');
  const r = await store.approve();
  assert.deepEqual(r.results.map((x) => x.outcome), ['queued', 'queued']);
  // Neither entry is in the outbox any more: the project was published, the feature discarded on its page.
  writeOutcome('k-proj', 'published');
  writeOutcome('k-feat', 'discarded');
  const after = store.get().review.items;
  const p1 = after.find((x) => x.ref === 'p1');
  const f1 = after.find((x) => x.ref === 'f1');
  assert.equal(p1.published.queued, false);
  assert.equal(p1.result.outcome, 'published');
  assert.equal(f1.published, null, 'a discarded edit is not shown as published');
  assert.match(f1.result.message, /discarded/);
  assert.equal(after.find((x) => x.ref === 's1').published, null, 'its step comes back with it');

  // An entry gone with no record (e.g. older than a month): not claimed as published either.
  const store2 = createReviewStore({ app: { definitionsNow: async () => defs(), refresh: async () => {}, featurePublisher: { ...queuing, submit: async (b) => ({ outcome: 'queued', key: `x-${b.op}` }) } }, importer, review: noAi });
  store2.discard();
  store2.start('a2');
  await store2.approve();
  const f = store2.get().review.items.find((x) => x.ref === 'f1');
  assert.equal(f.published, null);
  assert.match(f.result.message, /can't tell whether/);
});

test('an approved review with queued or failed items is not replaced without asking, even if it was never edited', async () => {
  const store = createReviewStore({ app: { definitionsNow: async () => defs(), refresh: async () => {}, featurePublisher: queuing }, importer, review: noAi });
  store.start('a1');
  await store.approve();
  writeEntry({ key: 'k-proj', op: 'create-project', kind: 'project', name: 'Wallet', via: 'import', state: 'pending', created_at: new Date().toISOString() });
  writeEntry({ key: 'k-feat', op: 'create', feature_id: 'top-up', name: 'Top up', via: 'import', state: 'pending', created_at: new Date().toISOString() });
  const again = store.start('a2');
  assert.equal(again.outcome, 'has_review');
  assert.match(again.message, /3 waiting for the shared repo/, 'the project, the feature and its step');
  assert.equal(store.start('a2', { replace: true }).outcome, 'started');

  // Failed items to fix: also asks.
  const failing = { submit: async () => ({ outcome: 'conflict', key: 'k-x', message: 'Not published.' }), discard: () => {} };
  const store2 = createReviewStore({ app: { definitionsNow: async () => defs(), refresh: async () => {}, featurePublisher: failing }, importer, review: noAi });
  store2.discard();
  store2.start('a1');
  await store2.approve();
  assert.equal(store2.start('a3').outcome, 'has_review');
});

test('outbox entries from an import that no review follows are listed with the review, so a waiting or refused project can be retried or discarded', async () => {
  const store = createReviewStore({ app: { definitionsNow: async () => defs(), refresh: async () => {}, featurePublisher: queuing }, importer, review: noAi });
  writeEntry({ key: 'old-proj', op: 'create-project', kind: 'project', feature_id: null, project_id: 'cards', name: 'Cards', via: 'import', state: 'conflict', message: 'cards was created by someone else.', created_at: new Date().toISOString() });
  writeEntry({ key: 'form-edit', op: 'update', feature_id: 'checkout', name: 'Checkout', via: 'form', state: 'pending', created_at: new Date().toISOString() });
  assert.deepEqual(store.get().outbox.map((e) => [e.key, e.kind, e.state]), [['old-proj', 'project', 'conflict']], 'without a review; edits from the form are not listed');
  store.start('a1');
  await store.approve();
  writeEntry({ key: 'k-proj', op: 'create-project', kind: 'project', name: 'Wallet', via: 'import', state: 'pending', created_at: new Date().toISOString() });
  assert.deepEqual(store.get().outbox.map((e) => e.key), ['old-proj'], 'entries the review follows are shown on its items instead');
});

const storeWith = (items, featurePublisher, more = {}) => createReviewStore({
  app: { definitionsNow: async () => ({ ...defs(), ...more }), refresh: async () => {}, featurePublisher, ...(more.app || {}) },
  importer: { progress: () => ({ state: 'done', proposal: { items } }) }, review: noAi });

test('what Approve published is saved even when a later step throws', async () => {
  let n = 0;
  const fp = { submit: async (body) => { if (body.op !== 'create-project') throw new Error('disk full'); return { outcome: 'published', key: 'k-p' }; }, discard: () => {} };
  const store = createReviewStore({ app: { definitionsNow: async () => defs(), refresh: async () => {}, featurePublisher: fp }, importer, review: noAi });
  store.start('a1');
  await assert.rejects(store.approve(), /disk full/);
  const p1 = store.get().review.items.find((x) => x.ref === 'p1');
  assert.equal(p1.published?.id, 'wallet', 'the project committed before the error is recorded');

  // The re-read after publishing fails: the approval is still saved, with a note to check again.
  const ok = { submit: async (body) => ({ outcome: 'published', key: `k-${body.op}` }), discard: () => {} };
  const store2 = createReviewStore({ app: { definitionsNow: async () => { n += 1; if (n > 1) throw new Error('repo read failed'); return defs(); }, refresh: async () => {}, featurePublisher: ok }, importer, review: noAi });
  store2.discard();
  store2.start('a1');
  const r = await store2.approve();
  assert.equal(r.outcome, 'approved');
  assert.match(r.review.last_approval.note, /repo read failed/);
  assert.ok(store2.get().review.items.every((x) => x.published), 'all saved as published');
});

test('tasks that were excluded or invalid are not marked published with their step', async () => {
  const items = [
    { ref: 'p1', level: 'project', name: 'Wallet', owner: 'bo' },
    { ref: 'f1', level: 'feature', name: 'Top up', parent: 'p1', owner: 'bo' },
    { ref: 's1', level: 'step', name: 'API', parent: 'f1', owner: 'cy', done_when: 'deployed' },
    { ref: 't1', level: 'task', name: 'PR 7', parent: 's1', evidence: [{ source: 'github', type: 'pr', repo: 'acme/api', number: 7 }] },
    { ref: 't2', level: 'task', name: 'PR 8', parent: 's1', evidence: [{ source: 'github', type: 'pr', repo: 'acme/api', number: 8 }] },
    { ref: 't3', level: 'task', name: 'Ticket', parent: 's1', evidence: [] },
  ];
  const ok = { submit: async (body) => ({ outcome: 'published', key: `k-${body.op}` }), discard: () => {} };
  const store = storeWith(items, ok);
  const { review } = store.start('a1');
  store.update({ revision: review.revision, edits: [{ ref: 't2', included: false }] });
  const r = await store.approve();
  const by = (ref) => r.review.items.find((x) => x.ref === ref);
  assert.ok(by('s1').published);
  assert.ok(by('t1').published, 'its evidence is in the file');
  assert.equal(by('t2').published, null, 'excluded');
  assert.equal(by('t3').published, null, 'no evidence: invalid');
});

test('a project merged into an existing one is done only once its features are in the shared repo, not while they wait', async () => {
  const items = [
    { ref: 'p1', level: 'project', name: 'Wallet', owner: 'bo', possible_duplicate: { id: 'wallet', name: 'Wallet', kind: 'project' } },
    { ref: 'f1', level: 'feature', name: 'Top up', parent: 'p1', owner: 'bo' },
    { ref: 's1', level: 'step', name: 'API', parent: 'f1', owner: 'cy', done_when: 'deployed' },
  ];
  const store = storeWith(items, { submit: async () => ({ outcome: 'queued', key: 'k-f1' }), discard: () => {} }, { projectDefs: [{ id: 'wallet', name: 'Wallet' }] });
  const { review } = store.start('a1');
  store.update({ revision: review.revision, edits: [{ ref: 'p1', duplicate_choice: 'merge' }] });
  const r = await store.approve();
  assert.equal(r.review.items.find((x) => x.ref === 'f1').published.queued, true);
  assert.equal(r.review.items.find((x) => x.ref === 'p1').published, null, 'not done while its feature waits');
  writeOutcome('k-f1', 'published');
  const p1 = store.get().review.items.find((x) => x.ref === 'p1');
  assert.equal(p1.published.op, 'merge');
  assert.match(p1.result.message, /in the existing project Wallet/);
});

test('features of a project still waiting in the outbox can be checked and approved; they go after it', async () => {
  const submitted = [];
  let first = true;
  const fp = { submit: async (body, ctx) => {
    submitted.push([body.op, body.draft.project || null, (ctx.defs.projectDefs || []).map((p) => p.id)]);
    if (body.op === 'create-project') return { outcome: 'queued', key: 'k-p' };
    if (first) { first = false; return { outcome: 'invalid', errors: [{ field: 'name', message: 'too vague' }], message: 'Not published.' }; }
    return { outcome: 'queued', key: 'k-f' };
  }, discard: () => {} };
  const store = storeWith(importer.progress().proposal.items, fp);
  store.start('a1');
  await store.approve();
  const c = await store.check();
  assert.equal(c.review.items.find((x) => x.ref === 'f1').check.state, 'ready', 'its project waits in the outbox: that is enough');
  await store.approve();
  assert.deepEqual(submitted.at(-1), ['create', 'wallet', ['wallet']]);
});

test('what Approve\'s own refresh refused in the outbox is back in the review, so nothing is published depending on it', async () => {
  const items = [...importer.progress().proposal.items,
    { ref: 'f2', level: 'feature', name: 'Refunds', parent: 'p1', owner: 'bo' },
    { ref: 's2', level: 'step', name: 'Ledger', parent: 'f2', owner: 'cy', done_when: 'deployed' }];
  const sent = [];
  const fp = { submit: async (body) => {
    const key = body.op === 'create-project' ? 'k-proj' : `k-${body.draft.id}`;
    sent.push(body.op === 'create-project' ? body.draft.name : body.draft.name);
    writeEntry({ key, op: body.op, state: 'pending', via: 'import', created_at: new Date().toISOString() });
    return { outcome: 'queued', key, message: 'Not published yet.' };
  }, discard: (key) => fs.rmSync(path.join(outboxDir(), `${key}.json`), { force: true }) };
  let refreshes = 0;
  // The second Approve's refresh retries the outbox: Top up is refused there.
  const refresh = async () => { if (++refreshes === 2) writeEntry({ key: 'k-top-up', op: 'create', state: 'failed', message: 'depends_on: "gone" is not a defined feature', via: 'import', created_at: new Date().toISOString() }); };
  const store = storeWith(items, fp, { app: { refresh } });
  const { review } = store.start('a1');
  store.update({ revision: review.revision, edits: [{ ref: 'f2', included: false, depends_on: ['ref:f1'] }] });
  await store.approve();
  assert.deepEqual(sent, ['Wallet', 'Top up']);
  const now = store.get().review;
  store.update({ revision: now.revision, edits: [{ ref: 'f2', included: true }] });
  sent.length = 0;
  const r = await store.approve();
  assert.deepEqual(sent, ['Top up', 'Refunds'], 'Top up is sent again before Refunds, not counted as waiting');
  assert.equal(r.review.items.find((x) => x.ref === 'p1').published.key, 'k-proj', 'the project still waits');
});

test('a project merged into an existing one with no feature included is not marked done before Approve; its choice can still change', async () => {
  const items = [
    { ref: 'p1', level: 'project', name: 'Wallet', owner: 'bo', possible_duplicate: { id: 'wallet', name: 'Wallet', kind: 'project' } },
    { ref: 'f1', level: 'feature', name: 'Top up', parent: 'p1', owner: 'bo' },
    { ref: 's1', level: 'step', name: 'API', parent: 'f1', owner: 'cy', done_when: 'deployed' },
  ];
  const store = storeWith(items, { submit: async () => ({ outcome: 'queued', key: 'k' }), discard: () => {} }, { projectDefs: [{ id: 'wallet', name: 'Wallet' }] });
  const { review } = store.start('a1');
  store.update({ revision: review.revision, edits: [{ ref: 'p1', duplicate_choice: 'merge' }, { ref: 'f1', included: false }] });
  const before = store.get().review;
  assert.equal(before.items.find((x) => x.ref === 'p1').published, null, 'loading does not settle it');
  store.update({ revision: before.revision, edits: [{ ref: 'p1', duplicate_choice: 'skip' }] });
  assert.equal(store.get().review.items.find((x) => x.ref === 'p1').duplicate_choice, 'skip', 'still editable');
  store.update({ revision: store.get().review.revision, edits: [{ ref: 'p1', duplicate_choice: 'merge' }] });
  const r = await store.approve();
  const p1 = r.review.items.find((x) => x.ref === 'p1');
  assert.equal(p1.published.op, 'merge');
  assert.match(p1.result.message, /Nothing to add/);
  assert.equal(store.get().review.items.find((x) => x.ref === 'p1').published.op, 'merge', 'and stays so on the next load');
});
