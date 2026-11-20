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

test('a new feature is not ready while its new project, or a proposed feature it depends on, is not', async () => {
  const p = proposal();
  p.items[0].possible_duplicate = { id: 'payments', name: 'Payments', kind: 'project' }; // no choice yet: the project is not ready
  p.items.push({ ref: 'f4', level: 'feature', name: 'Gift cards', parent: null, owner: 'bo', evidence: [], source_links: [], level_reason: '', possible_duplicate: null },
    { ref: 's4', level: 'step', name: 'Cards', parent: 'f4', owner: 'bo', done_when: 'sold', evidence: [], source_links: [], level_reason: '', possible_duplicate: null });
  const r = createReview(p);
  applyEdits(r, [{ ref: 'f3', duplicate_choice: 'skip' }, { ref: 'f4', depends_on: ['ref:f1'] }]);
  const reviewed = [];
  const c = await checkReview(r, defs(), async (built) => { reviewed.push(built.feature.id); return { ran: true, findings: [], blocking: false, note: 'ok' }; });
  const it = (ref) => r.items.find((x) => x.ref === ref).check;
  assert.equal(it('p1').state, 'invalid');
  assert.equal(it('f1').state, 'invalid');
  assert.match(it('f1').errors.find((e) => e.field === 'parent').message, /new project "Wallet" can't be created yet/);
  assert.equal(it('s1').state, 'invalid', 'its steps wait too');
  assert.equal(it('f4').state, 'invalid', 'a feature depending on it waits too');
  assert.match(it('f4').errors.find((e) => e.field === 'depends_on').message, /"Top up", which can't be published yet/);
  assert.deepEqual(c.features.filter((u) => u.ready), []);
  assert.ok(!reviewed.includes('top-up'), 'no AI review for a feature that is waiting on its project');
});

test('a project put into the existing one shows as merged, not as needing a fix', async () => {
  const p = proposal();
  p.items[0].possible_duplicate = { id: 'payments', name: 'Payments', kind: 'project' };
  const r = createReview(p);
  applyEdits(r, [{ ref: 'p1', duplicate_choice: 'merge' }, { ref: 'f3', duplicate_choice: 'skip' }]);
  const c = await checkReview(r, defs(), async () => ({ ran: false, findings: [], blocking: false, note: 'did not run' }));
  const p1 = r.items.find((x) => x.ref === 'p1').check;
  assert.equal(p1.state, 'merged');
  assert.match(p1.reason, /existing project Payments/);
  assert.equal(c.features.find((u) => u.id === 'top-up').draft.project, 'payments');
  assert.equal(r.items.find((x) => x.ref === 'f1').check.state, 'ready');
});

test('"add to existing" with no step left to add is an error on the feature, not a file to publish', () => {
  const r = createReview(proposal());
  applyEdits(r, [{ ref: 'f3', duplicate_choice: 'merge' }, { ref: 's3', included: false }]);
  const c = compileReview(r, defs());
  assert.ok(!c.features.some((u) => u.op === 'update'));
  assert.match(c.problems.get('f3')[0].message, /nothing to add to the existing feature Checkout/);
});

test('the evidence box takes GitHub links, owner/repo#n (PR, or issue with "issue"), and Jira keys in any case', async () => {
  const fs = await import('node:fs');
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const src = js.slice(js.indexOf('function impParseEvidence'), js.indexOf('const impMsgs'));
  const jiraKey = js.match(/^const JIRA_KEY = (.*);$/m)[1];
  const parse = new Function(`const JIRA_KEY = ${jiraKey}; ${src}; return impParseEvidence;`)();
  assert.deepEqual(parse('https://github.com/acme/api/pull/12'), { source: 'github', type: 'pr', repo: 'acme/api', number: 12 });
  assert.deepEqual(parse('acme/api#42'), { source: 'github', type: 'pr', repo: 'acme/api', number: 42 });
  assert.deepEqual(parse('PR acme/api#42'), { source: 'github', type: 'pr', repo: 'acme/api', number: 42 });
  assert.deepEqual(parse('issue acme/api#3'), { source: 'github', type: 'issue', repo: 'acme/api', number: 3 });
  assert.deepEqual(parse('abc-123'), { source: 'jira', type: 'ticket', key: 'ABC-123' });
  assert.deepEqual(parse('https://acme.atlassian.net/browse/ops-7'), { source: 'jira', type: 'ticket', key: 'OPS-7' });
  assert.equal(parse('acme/api#0'), null);
  assert.equal(parse('hello world'), null);
});

test('two proposed projects with the same id are both an error on their id, not both ready', async () => {
  const p = proposal();
  p.items.push({ ref: 'p2', level: 'project', name: 'Wallet', parent: null, owner: 'bo', evidence: [], source_links: [], level_reason: '', possible_duplicate: null });
  const r = createReview(p);
  applyEdits(r, [{ ref: 'f3', duplicate_choice: 'skip' }]);
  const c = await checkReview(r, defs(), async () => ({ ran: false, findings: [], blocking: false }));
  assert.deepEqual(c.projects.map((x) => [x.ref, x.ready]), [['p1', false], ['p2', false]]);
  for (const ref of ['p1', 'p2']) assert.match(r.items.find((x) => x.ref === ref).check.errors.map((e) => `${e.field}: ${e.message}`).join(), /^id: "wallet" is already a project/);
  applyEdits(r, [{ ref: 'p2', id: 'wallet-2' }]);
  const c2 = await checkReview(r, defs(), async () => ({ ran: false, findings: [], blocking: false }));
  assert.deepEqual(c2.projects.map((x) => x.ready), [true, true], 'a different id fixes both');
});

// The review screen's functions, taken from public/app.js.
const appJs = async () => (await import('node:fs')).readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('the review tree draws every item once, also items that edits made each other\'s parent', async () => {
  const js = await appJs();
  const impTree = new Function(`${js.slice(js.indexOf('function impTree'), js.indexOf('function importReviewHtml'))}; return impTree;`)();
  const items = [
    { ref: 'p1', parent: null }, { ref: 'f1', parent: 'p1' },
    { ref: 'a', parent: 'b' }, { ref: 'b', parent: 'a' }, { ref: 'c', parent: 'b' },
  ];
  const { roots, kidsOf } = impTree(items);
  const drawn = [];
  const draw = (it) => { drawn.push(it.ref); kidsOf(it.ref).forEach(draw); };
  roots.forEach(draw);
  assert.deepEqual(roots.map((x) => x.ref), ['p1', 'a']);
  assert.deepEqual(drawn.sort(), ['a', 'b', 'c', 'f1', 'p1']);
});

test('Discard keeps the review on screen, with the reason, when the server refuses it', async () => {
  const js = await appJs();
  const src = js.slice(js.indexOf('async function reviewAction'), js.indexOf('async function impOutboxAction'));
  const run = async (status, out) => {
    const calls = [];
    const env = new Function('fetch', 'calls', `let importReview = { review: { items: [] }, access: null };
      const confirm = () => true; const flushReview = async () => {}; const toast = () => {}; const load = () => {};
      const render = () => calls.push('render'); const rerenderReview = () => calls.push('rerender'); const loadImportReview = () => calls.push('reload');
      ${src}; return { reviewAction, state: () => importReview };`)(async () => ({ ok: status < 400, status, json: async () => out }), calls);
    await env.reviewAction('discard');
    return { state: env.state(), calls };
  };
  const refused = await run(409, { outcome: 'busy', message: 'A approve is running. Wait for it to finish, then edit again.' });
  assert.ok(refused.state.review, 'the review is still shown');
  assert.match(refused.state.error, /approve is running/);
  const done = await run(200, { outcome: 'discarded' });
  assert.equal(done.state.review, null);
  assert.ok(done.calls.includes('reload'), 'reloads to show what an earlier import left in the outbox');
});
