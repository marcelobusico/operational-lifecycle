// Compiling an import review into feature and project drafts (src/import/approve.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDefinition } from '../src/definitions.js';
import { createReview, applyEdits, compileReview, checkReview, publishOrder } from '../src/import/approve.js';

const CHECKOUT_YAML = `id: checkout
name: Checkout
owner: ana
steps:
  - id: build
    name: Build
    owner: ana
    done_when: merged
`;
const checkout = validateDefinition('features/checkout.yaml', CHECKOUT_YAML).feature;
const defs = () => ({ featureDefs: [checkout], projectDefs: [{ id: 'payments', name: 'Payments' }], invalidIds: new Set(), files: new Map([['features/checkout.yaml', CHECKOUT_YAML]]) });

const proposal = () => ({
  analyzed_at: '2026-11-20T00:00:00Z', provider: 'openai', sources: [],
  items: [
    { ref: 'p1', level: 'project', name: 'Wallet', description: 'Wallet work', parent: null, owner: 'bo', evidence: [], source_links: [], level_reason: 'epic', possible_duplicate: null },
    { ref: 'f1', level: 'feature', name: 'Top up', description: 'Add money', parent: 'p1', owner: 'bo', evidence: [], source_links: [], level_reason: 'story', possible_duplicate: null },
    { ref: 's1', level: 'step', name: 'API', parent: 'f1', owner: 'cy', done_when: 'deployed', evidence: [{ source: 'jira', type: 'ticket', key: 'WAL-1' }], source_links: [], level_reason: '', possible_duplicate: null },
    { ref: 't1', level: 'task', name: 'PR 7', parent: 's1', evidence: [{ source: 'github', type: 'pr', repo: 'acme/api', number: 7 }], source_links: [], level_reason: '', possible_duplicate: null },
    { ref: 'f2', level: 'feature', name: 'Refunds', parent: 'p1', owner: 'bo', evidence: [], source_links: [], level_reason: '', possible_duplicate: null },
    { ref: 's2', level: 'step', name: 'Refund UI', parent: 'f2', owner: 'di', done_when: 'shipped', evidence: [], source_links: [], level_reason: '', possible_duplicate: null },
    { ref: 'f3', level: 'feature', name: 'Checkout v2', parent: null, owner: 'ana', evidence: [], source_links: [], level_reason: '', possible_duplicate: { id: 'checkout', name: 'Checkout', kind: 'feature' } },
    { ref: 's3', level: 'step', name: 'Polish', parent: 'f3', owner: 'ana', done_when: 'reviewed', evidence: [{ source: 'jira', type: 'ticket', key: 'CHK-9' }], source_links: [], level_reason: '', possible_duplicate: null },
  ],
});

test('edited owner and done_when land in the draft; task evidence goes onto its step', () => {
  const r = createReview(proposal());
  applyEdits(r, [{ ref: 's1', owner: 'eve', done_when: 'live in prod' }, { ref: 'f3', duplicate_choice: 'skip' }]);
  const c = compileReview(r, defs());
  const topUp = c.features.find((u) => u.id === 'top-up');
  assert.equal(topUp.draft.project, 'wallet');
  assert.deepEqual(topUp.draft.steps.map((s) => [s.owner, s.done_when]), [['eve', 'live in prod']]);
  assert.deepEqual(topUp.draft.steps[0].add_evidence.map((e) => e.key || e.number), ['WAL-1', 7]);
  assert.deepEqual(c.projects.map((p) => p.draft.id), ['wallet']);
});

test('a feature turned into a step of another feature gives one feature', () => {
  const r = createReview(proposal());
  applyEdits(r, [{ ref: 'f2', level: 'step', parent: 'f1', done_when: 'refunds work' }, { ref: 's2', included: false }, { ref: 'f3', included: false }]);
  const c = compileReview(r, defs());
  assert.deepEqual(c.features.map((u) => u.id), ['top-up']);
  assert.deepEqual(c.features[0].draft.steps.map((s) => s.name), ['API', 'Refunds']);
});

test('excluded items, and what sits under them, are not compiled', () => {
  const r = createReview(proposal());
  applyEdits(r, [{ ref: 'f2', included: false }, { ref: 'f3', duplicate_choice: 'skip' }]);
  const c = compileReview(r, defs());
  assert.deepEqual(c.features.map((u) => u.id), ['top-up']);
  assert.equal(c.status.get('f2').state, 'excluded');
  assert.equal(c.status.get('s2').state, 'excluded');
  assert.equal(c.status.get('f3').state, 'skipped');
  assert.equal(c.status.get('s3').state, 'excluded');
});

test('"add to existing" adds steps and evidence to the existing feature, no new file', () => {
  const r = createReview(proposal());
  applyEdits(r, [{ ref: 'f3', duplicate_choice: 'merge' }]);
  const c = compileReview(r, defs());
  const upd = c.features.find((u) => u.op === 'update');
  assert.equal(upd.id, 'checkout');
  assert.deepEqual(upd.draft.steps.map((s) => s.id), ['build', 'polish']);
  assert.equal(upd.draft.steps[1].add_evidence[0].key, 'CHK-9');
  assert.ok(!c.features.some((u) => u.op === 'create' && u.id === 'checkout-v2'));
});

test('a possible duplicate blocks until the person chooses', () => {
  const c = compileReview(createReview(proposal()), defs());
  assert.equal(c.problems.get('f3')[0].field, 'duplicate_choice');
});

test('check: a missing step owner shows on the step and blocks its feature only', async () => {
  const r = createReview(proposal());
  applyEdits(r, [{ ref: 's2', owner: '' }, { ref: 'f3', duplicate_choice: 'merge' }]);
  const noAi = async () => ({ ran: false, findings: [], blocking: false, note: 'did not run' });
  const c = await checkReview(r, defs(), noAi);
  const st = Object.fromEntries(r.items.map((it) => [it.ref, it.check.state]));
  assert.equal(st.s2, 'invalid');
  assert.equal(r.items.find((it) => it.ref === 's2').check.errors[0].field, 'owner');
  assert.equal(st.f2, 'invalid');
  assert.equal(st.f1, 'ready');
  assert.equal(st.s1, 'ready');
  assert.equal(st.t1, 'ready');
  assert.equal(st.f3, 'ready');
  assert.deepEqual(publishOrder(c.features.filter((u) => u.ready)).map((u) => `${u.op}:${u.id}`), ['create:top-up', 'update:checkout']);
});

test('check: a contradiction blocks its item; an ambiguity is a suggestion', async () => {
  const r = createReview(proposal());
  applyEdits(r, [{ ref: 'f3', duplicate_choice: 'skip' }]);
  const ai = async (built) => (built.feature.id === 'refunds'
    ? { ran: true, findings: [{ kind: 'contradiction', field: 'steps[0].done_when', message: 'contradicts', suggestion: 'fix' }], blocking: true, note: 'x' }
    : { ran: true, findings: [{ kind: 'ambiguity', field: 'owner', message: 'vague', suggestion: 'name a person' }], blocking: false, note: 'Ready with suggestions.' });
  await checkReview(r, defs(), ai);
  const it = (ref) => r.items.find((x) => x.ref === ref).check;
  assert.equal(it('s2').state, 'blocked');
  assert.equal(it('f2').state, 'blocked');
  assert.equal(it('f1').state, 'ready');
  assert.equal(it('f1').findings[0].kind, 'ambiguity');
});
