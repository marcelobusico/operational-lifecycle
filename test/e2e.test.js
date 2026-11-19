// End to end: the real server and app, against a fake GitHub. Walks the
// acceptance criteria. No network and no real credentials.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeGithub } from './fake-github.js';
import { createApp } from '../src/app.js';
import { createServer } from '../src/server.js';
import { DEFAULTS } from '../src/config.js';

const DATA = 'team/LifeCycle-Data';
const APP = 'team/catalog';
let gh, home;

const feature = (id, { deps = [], steps = [] } = {}) => [
  `id: ${id}`, `name: ${id} name`, `owner: ${id}-owner`, `depends_on: [${deps.join(', ')}]`,
  `steps:${steps.length ? '' : ' []'}`,
  ...steps.map((s) => `  - { id: ${s.id}, name: ${s.id} step, owner: "${s.owner}", done_when: merged to main${s.pr ? `, evidence: [{ source: github, type: pr, repo: ${s.repo || APP}, number: ${s.pr} }]` : ''} }`),
].join('\n') + '\n';

function startLifecycle(overrides = {}) {
  const config = { ...DEFAULTS, dataRepo: DATA, sources: { github: { enabled: true, apiUrl: gh.url } }, ...overrides };
  const server = createServer(createApp({ config, token: gh.token }));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }),
  })));
}
const getJson = async (base, p) => (await fetch(base + p)).json();
const byId = (snap) => Object.fromEntries(snap.features.map((f) => [f.feature.id, f]));

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-test-'));
  process.env.LIFECYCLE_HOME = home;
  gh = await startFakeGithub();
  gh.state.readable.add(DATA);
  gh.state.readable.add(APP);
  gh.state.files.set(DATA, new Map([
    ['features/rewards.yaml', feature('rewards', { steps: [{ id: 'development', owner: '@rewards-dev', pr: 4 }] }).replace('steps:', 'project: rewards-project\nsteps:')],
    ['features/redeem-rewards.yaml', feature('redeem-rewards', { deps: ['rewards'], steps: [{ id: 'development', owner: '@rr-dev', pr: 5 }] }).replace('steps:', 'project: rewards-project\nsteps:')],
    ['features/wishlist-a.yaml', feature('wishlist-a', { deps: ['wishlist-b'] })],
    ['features/wishlist-b.yaml', feature('wishlist-b', { deps: ['wishlist-a'] })],
    ['features/referrals.yaml', feature('referrals', { deps: ['loyalty-tiers'] })],
    ['features/no-steps.yaml', feature('no-steps')],
    ['features/broken.yaml', 'id: broken\nname: Broken\nsteps: []\n'],
    ['features/private.yaml', feature('private', { steps: [{ id: 'dev', owner: '@someone', pr: 7, repo: 'other/secret-repo' }] })],
    ['README.md', '# not a definition'],
    ['projects/rewards-project.yaml', 'id: rewards-project\nname: Redeem rewards\nowner: Mobile team\n'],
  ]));
  gh.state.prs.set(`${APP}#4`, { title: 'Rewards endpoint', state: 'open', merged_at: null });
  gh.state.prs.set(`${APP}#5`, { title: 'Redeem rewards', state: 'open', merged_at: null });
});
after(async () => { await gh.close(); });

test('dependency with an open PR blocks; merging it clears the blocker with nobody editing', async () => {
  const lc = await startLifecycle();
  let rr = byId(await getJson(lc.url, '/api/roadmap'))['redeem-rewards'];
  assert.equal(rr.state, 'blocked');
  assert.equal(rr.blockers[0].feature, 'rewards');
  assert.equal(rr.blockers[0].step, 'development');
  assert.equal(rr.blockers[0].owner, '@rewards-dev');
  assert.equal(rr.blockers[0].evidence[0].link, `https://github.com/${APP}/pull/4`);

  gh.state.prs.set(`${APP}#4`, { title: 'Rewards endpoint', state: 'closed', merged_at: '2026-11-03T12:00:00Z' });
  const snap = byId(await getJson(lc.url, '/api/roadmap'));
  assert.equal(snap.rewards.steps[0].state, 'done');
  assert.equal(snap.rewards.state, 'done');
  rr = snap['redeem-rewards'];
  assert.deepEqual(rr.blockers, []);
  assert.equal(rr.state, 'flowing');

  gh.state.prs.set(`${APP}#5`, { title: 'Redeem rewards', state: 'closed', merged_at: '2026-11-03T13:00:00Z' });
  assert.equal(byId(await getJson(lc.url, '/api/roadmap'))['redeem-rewards'].state, 'done');
  gh.state.prs.set(`${APP}#4`, { title: 'Rewards endpoint', state: 'open', merged_at: null });
  gh.state.prs.set(`${APP}#5`, { title: 'Redeem rewards', state: 'open', merged_at: null });
  await lc.close();
});

test('a new definition in the shared repo appears for another teammate after refresh', async () => {
  const teammate = await startLifecycle();
  assert.equal(byId(await getJson(teammate.url, '/api/roadmap')).reader, undefined);
  gh.state.files.get(DATA).set('features/reader.yaml', feature('reader', { deps: ['redeem-rewards'] }));
  const reader = byId(await getJson(teammate.url, '/api/roadmap')).reader;
  assert.equal(reader.feature.name, 'reader name');
  assert.equal(reader.state, 'blocked');
  gh.state.files.get(DATA).delete('features/reader.yaml');
  await teammate.close();
});

test('two teammates see the same step states; the status API matches the map', async () => {
  const a = await startLifecycle();
  const b = await startLifecycle();
  const [sa, sb] = await Promise.all([getJson(a.url, '/api/roadmap'), getJson(b.url, '/api/roadmap')]);
  const shape = (snap) => snap.features.map((f) => [f.feature.id, f.state, f.steps.map((s) => s.state), f.blockers.map((bl) => bl.why)]);
  assert.deepEqual(shape(sa), shape(sb));

  const single = await getJson(a.url, '/api/features/redeem-rewards/status');
  assert.equal(single.schema, 'lifecycle.feature-status/v1');
  const inMap = byId(sa)['redeem-rewards'];
  for (const k of ['state', 'steps', 'blockers', 'depends_on', 'depended_on_by']) {
    assert.deepEqual(stripTimes(single[k]), stripTimes(inMap[k]), k);
  }
  await a.close();
  await b.close();
});
const stripTimes = (v) => JSON.parse(JSON.stringify(v, (k, val) => (k.endsWith('read_at') ? undefined : val)));

test('GitHub connection disabled: steps unavailable with last read time, nothing done or blocked', async () => {
  const lc = await startLifecycle({ sources: { github: { enabled: false, apiUrl: gh.url } } });
  const snap = await getJson(lc.url, '/api/roadmap');
  assert.equal(snap.definitions.stale, true);
  for (const f of snap.features) {
    for (const s of f.steps.filter((st) => st.linked_work)) {
      assert.equal(s.state, 'unavailable', `${f.feature.id}/${s.id}`);
      if (f.feature.id === 'rewards') assert.ok(s.last_successful_read_at, 'last successful read time is shown');
    }
    if (f.steps.some((s) => s.linked_work) || f.depends_on.some((d) => d.id === 'rewards')) {
      assert.notEqual(f.state, 'done', f.feature.id);
      assert.notEqual(f.state, 'blocked', f.feature.id);
    }
  }
  await lc.close();
});

test('shared repo unreachable: last known features with "last synced" time', async () => {
  const lc = await startLifecycle();
  const fresh = await getJson(lc.url, '/api/roadmap');
  gh.state.readable.delete(DATA);
  const files = gh.state.files.get(DATA);
  gh.state.files.delete(DATA);
  const stale = await getJson(lc.url, '/api/roadmap');
  assert.equal(stale.definitions.stale, true);
  assert.equal(stale.definitions.synced_at, fresh.definitions.synced_at);
  assert.deepEqual(stale.features.map((f) => f.feature.id).sort(), fresh.features.map((f) => f.feature.id).sort());
  gh.state.readable.add(DATA);
  gh.state.files.set(DATA, files);
  await lc.close();
});

test('no access to a repo: message naming the repo and the missing access', async () => {
  const lc = await startLifecycle();
  const priv = await getJson(lc.url, '/api/features/private/status');
  assert.equal(priv.steps[0].state, 'no_access');
  assert.match(priv.access_problems[0].message, /other\/secret-repo/);
  assert.match(priv.access_problems[0].message, /read access/);
  assert.notEqual(priv.state, 'done');
  assert.notEqual(priv.state, 'blocked');
  await lc.close();
});

test('empty state, cycles, unknown ids and invalid files', async () => {
  const lc = await startLifecycle();
  const snap = await getJson(lc.url, '/api/roadmap');
  const f = byId(snap);
  assert.equal(f['no-steps'].state, 'not_started');
  assert.deepEqual(f['no-steps'].steps, []);
  for (const id of ['wishlist-a', 'wishlist-b']) {
    assert.ok(f[id].warnings.some((w) => w.kind === 'circular_dependency'), id);
  }
  assert.match(f.referrals.warnings[0].message, /"loyalty-tiers"/);
  assert.deepEqual(snap.invalid_definitions, [{ file: 'features/broken.yaml', field: 'owner', message: 'is required' }]);
  assert.equal(f.broken, undefined);
  assert.ok(f.rewards && f['redeem-rewards'], 'other features still display');
  const res = await fetch(`${lc.url}/api/features/broken/status`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).invalid_definitions[0].field, 'owner');
  await lc.close();
});

test('source reads are logged with source and feature; no token in logs, nothing written to the shared repo', async () => {
  const log = fs.readFileSync(path.join(home, 'logs', 'source-reads.log'), 'utf8');
  const lines = log.trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.source === 'github' && l.feature === 'private' && l.outcome === 'no_access'));
  assert.ok(lines.some((l) => l.source === 'github' && l.feature === 'rewards' && l.outcome === 'unreachable'));
  assert.ok(!log.includes(gh.token), 'token value never logged');
  assert.ok(!/gh[pousr]_[A-Za-z0-9]{20,}|github_pat_/.test(log));
  // LifeCycle only ever reads: every request to GitHub was a GET-style read of known endpoints.
  assert.ok(gh.state.requests.every((r) => /^\/repos\//.test(r.url)));
  for (const file of fs.readdirSync(path.join(home, 'cache'))) {
    assert.ok(!fs.readFileSync(path.join(home, 'cache', file), 'utf8').includes(gh.token), file);
  }
});

test('projects: roadmap groups features and the project status API matches', async () => {
  const lc = await startLifecycle();
  const snap = await getJson(lc.url, '/api/roadmap');
  const proj = snap.projects.find((p) => p.project.id === 'rewards-project');
  assert.deepEqual(proj.features.sort(), ['redeem-rewards', 'rewards']);
  assert.equal(proj.state, 'blocked');
  assert.ok(snap.projects.find((p) => p.project.id === null).features.includes('wishlist-a'), 'unassigned features listed under No project');
  const api = await getJson(lc.url, '/api/projects/rewards-project/status');
  assert.equal(api.schema, 'lifecycle.project-status/v1');
  assert.deepEqual(api.feature_statuses.map((f) => f.feature.id).sort(), ['redeem-rewards', 'rewards']);
  assert.equal((await fetch(`${lc.url}/api/projects/nope/status`)).status, 404);
  await lc.close();
});

test('a GitHub answer whose body never finishes shows the step unavailable, not an error', async () => {
  const { createGithubClient } = await import('../src/sources/github-client.js');
  const stalled = async () => ({ ok: true, status: 200, headers: new Headers(), json: () => Promise.reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })) });
  const client = createGithubClient({ apiUrl: 'http://x', token: 't', fetchImpl: stalled });
  await assert.rejects(client.request('/repos/o/r/pulls/1'), (err) => err.kind === 'unreachable' && /timed out/.test(err.message));
});
