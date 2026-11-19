import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDefinitions } from '../src/definitions.js';
import { computeStatuses } from '../src/status.js';

const yaml = (id, { deps = [], steps = '[]' } = {}) =>
  ({ path: `features/${id}.yaml`, text: `id: ${id}\nname: ${id} name\nowner: ${id}-owner\ndepends_on: [${deps.join(', ')}]\nsteps: ${steps}\n` });

const prStep = (id, number, owner = 'dev-owner') =>
  `\n  - id: ${id}\n    name: ${id} step\n    owner: ${owner}\n    done_when: merged\n    evidence: [{ source: github, type: pr, repo: example/app, number: ${number} }]`;

// Fake reader: evidence state by PR number.
const reader = (states) => async (e) => {
  const s = states[e.number];
  const link = `https://github.com/${e.repo}/pull/${e.number}`;
  if (s === 'unavailable') return { ...e, link, state: 'unavailable', message: 'GitHub could not be reached.', lastSuccessfulReadAt: '2026-11-01T10:00:00.000Z' };
  if (s === 'no_access') return { ...e, link, state: 'no_access', message: `Your GitHub credentials can't read pull request #${e.number} in ${e.repo}.` };
  return { ...e, link, state: s, detail: s === 'done' ? 'merged' : 'open PR, not merged', readAt: new Date().toISOString() };
};

async function run(files, states) {
  const { features, invalid, invalidIds } = parseDefinitions(files);
  const statuses = await computeStatuses({ features, invalidIds, read: reader(states) });
  return { invalid, by: Object.fromEntries(statuses.map((s) => [s.feature.id, s])) };
}

const rewardsFiles = [
  yaml('rewards', { steps: prStep('development', 4, 'catalog-dev') }),
  yaml('redeem-rewards', { deps: ['rewards'], steps: prStep('development', 5) }),
];

test('open PR on a dependency blocks the dependent, naming step, owner and PR', async () => {
  const { by } = await run(rewardsFiles, { 4: 'in_progress', 5: 'in_progress' });
  const rr = by['redeem-rewards'];
  assert.equal(rr.state, 'blocked');
  assert.equal(rr.blockers.length, 1);
  const b = rr.blockers[0];
  assert.equal(b.feature, 'rewards');
  assert.equal(b.step, 'development');
  assert.equal(b.owner, 'catalog-dev');
  assert.equal(b.evidence[0].link, 'https://github.com/example/app/pull/4');
  assert.equal(by.rewards.state, 'flowing');
});

test('merging the dependency PR clears the blocker', async () => {
  const { by } = await run(rewardsFiles, { 4: 'done', 5: 'in_progress' });
  assert.equal(by.rewards.state, 'done');
  assert.equal(by.rewards.steps[0].state, 'done');
  assert.equal(by['redeem-rewards'].state, 'flowing');
  assert.deepEqual(by['redeem-rewards'].blockers, []);
});

test('all steps and dependencies done -> done', async () => {
  const { by } = await run(rewardsFiles, { 4: 'done', 5: 'done' });
  assert.equal(by['redeem-rewards'].state, 'done');
});

test('blockers pass through a chain to the root step', async () => {
  const files = [...rewardsFiles, yaml('reader', { deps: ['redeem-rewards'], steps: '[]' })];
  const { by } = await run(files, { 4: 'in_progress', 5: 'done' });
  const roots = by.reader.blockers.map((b) => `${b.feature}/${b.step}`);
  assert.deepEqual(roots, ['rewards/development']);
  assert.deepEqual(by.reader.blockers[0].via, ['redeem-rewards']);
  assert.equal(by.reader.state, 'blocked');
});

test('unreachable source -> steps unavailable with last read time, never done or blocked', async () => {
  const { by } = await run(rewardsFiles, { 4: 'unavailable', 5: 'unavailable' });
  for (const s of Object.values(by)) {
    assert.equal(s.state, 'unavailable');
    for (const step of s.steps) {
      assert.equal(step.state, 'unavailable');
      assert.equal(step.last_successful_read_at, '2026-11-01T10:00:00.000Z');
    }
    assert.deepEqual(s.blockers, []);
  }
});

test('missing access -> no_access with a message naming the repo', async () => {
  const { by } = await run(rewardsFiles, { 4: 'no_access', 5: 'in_progress' });
  assert.equal(by.rewards.steps[0].state, 'no_access');
  assert.match(by.rewards.access_problems[0].message, /example\/app/);
  assert.notEqual(by['redeem-rewards'].state, 'blocked');
});

test('feature with no steps or no linked work -> empty state, not an error', async () => {
  const files = [yaml('empty'), yaml('unlinked', { steps: '\n  - { id: design, name: Design, owner: x, done_when: approved }' })];
  const { by, invalid } = await run(files, {});
  assert.deepEqual(invalid, []);
  assert.equal(by.empty.state, 'not_started');
  assert.equal(by.empty.summary, 'No steps defined yet.');
  assert.equal(by.unlinked.steps[0].linked_work, false);
  assert.deepEqual(by.empty.depends_on, []);
});

test('two features depending on each other are flagged as circular on both', async () => {
  const { by } = await run([yaml('a', { deps: ['b'] }), yaml('b', { deps: ['a'] })], {});
  for (const id of ['a', 'b']) {
    assert.equal(by[id].state, 'blocked');
    assert.ok(by[id].warnings.some((w) => w.kind === 'circular_dependency' && w.ids.join() === 'a,b'));
  }
});

test('dependency on an undefined id -> unknown dependency warning naming it', async () => {
  const { by } = await run([yaml('a', { deps: ['ghost'] })], {});
  assert.equal(by.a.warnings[0].kind, 'unknown_dependency');
  assert.match(by.a.warnings[0].message, /"ghost"/);
});

test('invalid definition is reported with file and field; other features still display', async () => {
  const broken = { path: 'features/broken.yaml', text: 'id: broken\nowner: x\nsteps: []\n' };
  const { by, invalid } = await run([broken, ...rewardsFiles], { 4: 'done', 5: 'done' });
  assert.deepEqual(invalid, [{ file: 'features/broken.yaml', field: 'name', message: 'is required' }]);
  assert.deepEqual(Object.keys(by).sort(), ['redeem-rewards', 'rewards']);
});
