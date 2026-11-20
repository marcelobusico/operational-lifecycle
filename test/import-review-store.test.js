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
