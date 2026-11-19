// Alerts on flag, dependency and schedule changes: walks the acceptance criteria with
// two teammates (each with their own LifeCycle home and identity) against a fake GitHub. No network
// and no real credentials.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeGithub } from './fake-github.js';
import { createApp } from '../src/app.js';
import { createServer } from '../src/server.js';
import { DEFAULTS } from '../src/config.js';
import { looksLikeToken } from '../src/log.js';

const DATA = 'team/LifeCycle-Data';
const APP = 'team/catalog';
let gh, ana, bo;

const isoDay = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

// A teammate: own LifeCycle home (seen state, outbox, logs), own owner names and GitHub login.
async function person(name, { owners, login }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `lifecycle-${name}-`));
  const config = { ...DEFAULTS, dataRepo: DATA, me: { owners, github: null }, sources: { github: { enabled: true, apiUrl: gh.url }, flagsmith: { ...DEFAULTS.sources.flagsmith, enabled: false } } };
  process.env.LIFECYCLE_HOME = home;
  const server = createServer(createApp({ alwaysLive: true, config, token: gh.token, flagsmithApiKey: null }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  // Every call runs "as" this person: their home, their GitHub login.
  const as = async (fn) => { process.env.LIFECYCLE_HOME = home; gh.state.login = login; return fn(); };
  const call = (method, p, body) => as(async () => {
    const res = await fetch(url + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  });
  return {
    home, owners,
    get: (p) => call('GET', p).then((r) => r.body),
    post: (p, body = {}) => call('POST', p, body),
    put: (p, body = {}) => call('PUT', p, body),
    // Opening LifeCycle: read the alerts and mark the new ones as seen, as the page does.
    async open(query = '') {
      const view = await this.get(`/api/alerts${query}`);
      const fresh = view.alerts.filter((a) => a.new).map((a) => a.id);
      if (fresh.length) await this.post('/api/alerts/seen', { ids: fresh });
      return { ...view, fresh };
    },
    close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }),
  };
}

const feature = (id, { owner, deps = [], flags = [], target = null, pr }) => [
  `id: ${id}`, `name: ${id} name`, `owner: ${owner}`, `depends_on: [${deps.join(', ')}]`, `flags: [${flags.join(', ')}]`,
  ...(target ? [`target_date: ${target}`] : []),
  'steps:', `  - { id: development, name: Development, owner: "@${id}-dev", done_when: merged to main, evidence: [{ source: github, type: pr, repo: ${APP}, number: ${pr} }] }`,
  '  - { id: release, name: Release, owner: Release team, done_when: released }',
].join('\n') + '\n';

const planned = (over = {}) => ({ what_type: 'flag', what_name: 'rewards_enabled', change: 'Switch off rewards flag', features: ['rewards'],
  state: 'planned', planned_for: isoDay(6), reason: 'Incident follow-up while the points bug is fixed', ...over });
const repoChanges = () => [...gh.state.files.get(DATA).entries()].filter(([p]) => p.startsWith('changes/'));
const strip = (f) => ({ state: f.state, summary: f.summary, blockers: f.blockers.map((b) => b.why), steps: f.steps.map((s) => [s.id, s.state]), last_mile: f.last_mile?.state ?? null });

before(async () => {
  gh = await startFakeGithub();
  gh.state.readable.add(DATA).add(APP);
  gh.state.writable.add(DATA);
  gh.state.files.set(DATA, new Map([
    ['features/rewards.yaml', feature('rewards', { owner: 'Catalog team', flags: ['rewards_enabled'], pr: 4 })],
    ['features/redeem-rewards.yaml', feature('redeem-rewards', { owner: 'Mobile team', deps: ['rewards'], flags: ['redeem_rewards'], target: isoDay(2), pr: 5 })],
    ['features/wishlist.yaml', feature('wishlist', { owner: 'Wishlist team', pr: 6 })],
  ]));
  for (const n of [4, 5, 6]) gh.state.prs.set(`${APP}#${n}`, { title: `PR ${n}`, state: 'open', merged_at: null });
  ana = await person('ana', { owners: ['Catalog team'], login: 'ana' });   // teammate A, owner of rewards
  bo = await person('bo', { owners: ['Mobile team'], login: 'bo' });        // teammate B, owner of redeem rewards
});
after(async () => { await ana.close(); await bo.close(); await gh.close(); });

let published;
test('teammate A registers a planned change, sees who will be notified, publishes; teammate B sees it as new, on both timelines, statuses unchanged', async () => {
  const beforeSnap = await bo.get('/api/roadmap');
  const preview = (await ana.post('/api/changes/preview', { features: ['rewards'] })).body;
  assert.deepEqual(preview.affected, ['rewards']);
  assert.deepEqual(preview.dependents, ['redeem-rewards']);
  const owners = preview.owners.map((o) => o.owner);
  for (const o of ['Catalog team', 'Mobile team', '@rewards-dev', '@redeem-rewards-dev', 'Release team']) assert.ok(owners.includes(o), o);

  const commitsBefore = gh.state.commits.length;
  const r = await ana.post('/api/changes', { draft: planned() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.outcome, 'published');
  published = r.body.change;
  // A direct commit to main: no pull request, no review step.
  const commit = gh.state.commits[commitsBefore];
  assert.equal(commit.branch, 'main');
  assert.equal(commit.path, `changes/${published.id}.yaml`);
  assert.ok(!gh.state.requests.some((q) => q.url.includes('/pulls') && q.method === 'POST'));
  assert.equal(published.registered_by, '@ana');

  const view = await bo.open();
  const a = view.alerts.find((x) => x.id === `change:${published.id}@r1`);
  assert.ok(a && a.new && a.mine, 'new for B');
  assert.equal(a.source_label, 'Registered by @ana');
  assert.match(a.change, /^Planned for \d{4}-\d{2}-\d{2}: Switch off rewards flag/);
  assert.equal(a.reason, 'Incident follow-up while the points bug is fixed');
  // Timelines: the UI lists an alert on every feature it affects or that depends on it.
  assert.ok(a.features.includes('rewards') && a.dependents.includes('redeem-rewards'));
  // A's own change is not "new" for A.
  assert.ok(!(await ana.open()).fresh.includes(a.id));

  const afterSnap = await bo.get('/api/roadmap');
  for (const id of ['rewards', 'redeem-rewards']) {
    const b4 = beforeSnap.features.find((f) => f.feature.id === id);
    const af = afterSnap.features.find((f) => f.feature.id === id);
    assert.deepEqual(strip(af), strip(b4), `${id}: status unchanged by the registered change`);
  }
});

test('cancelling the planned change shows a cancellation to the same owners on their next refresh', async () => {
  const r = await ana.post(`/api/changes/${published.id}/cancel`, { reason: 'Bug fixed without switching off', base_revision: 1 });
  assert.equal(r.body.outcome, 'published', JSON.stringify(r.body));
  const before = (await ana.post('/api/changes/preview', { features: ['rewards'] })).body.owners.map((o) => o.owner).sort();
  assert.deepEqual(r.body.notify.owners.map((o) => o.owner).sort(), before);
  const view = await bo.open();
  const c = view.alerts.find((x) => x.id === `change:${published.id}@r2`);
  assert.ok(c && c.new, 'cancellation is a new alert');
  assert.match(c.change, /^Cancelled: Switch off rewards flag/);
  assert.equal(c.state, 'cancelled');
  assert.match(gh.state.files.get(DATA).get(`changes/${published.id}.yaml`), /state: cancelled[\s\S]*revision: 2/);
});

test('editing a change that someone else updated first is refused, told, and kept locally', async () => {
  const r = await ana.post('/api/changes', { draft: planned({ change: 'Pause rewards rollout', what_type: 'decision', what_name: 'rewards rollout' }) });
  const id = r.body.change.id;
  assert.equal((await bo.put(`/api/changes/${id}`, { draft: planned({ change: 'Pause rewards rollout until Monday', what_type: 'decision', what_name: 'rewards rollout' }), base_revision: 1 })).body.outcome, 'published');
  const stale = await ana.put(`/api/changes/${id}`, { draft: planned({ change: 'Pause rewards rollout for a week', what_type: 'decision', what_name: 'rewards rollout' }), base_revision: 1 });
  assert.equal(stale.status, 409);
  assert.match(stale.body.message, /@bo published revision 2.*Nothing was overwritten/);
  assert.match(gh.state.files.get(DATA).get(`changes/${id}.yaml`), /until Monday/);
  const outbox = (await ana.get('/api/changes')).outbox;
  assert.ok(outbox.some((e) => e.id === id && e.state === 'conflict' && e.draft.change === 'Pause rewards rollout for a week'));
});

test('two teammates publishing different changes at the same moment both end up in the shared repo', async () => {
  const before = repoChanges().length;
  let waiting = 0;
  let release;
  const both = new Promise((r) => { release = r; });
  gh.state.beforeWrite = async () => { if (++waiting === 2) release(); await both; };
  // Each person's server runs in this process; both requests are in flight before either write lands.
  const [a, b] = await Promise.all([
    ana.post('/api/changes', { draft: planned({ change: 'Rewards contract v2', what_type: 'contract', what_name: 'rewards points API', state: 'done', planned_for: '' }) }),
    bo.post('/api/changes', { draft: planned({ change: 'Reader uses rewards v2', what_type: 'decision', what_name: 'reader', features: ['redeem-rewards'], state: 'done', planned_for: '' }) }),
  ]);
  gh.state.beforeWrite = null;
  assert.equal(a.body.outcome, 'published');
  assert.equal(b.body.outcome, 'published');
  const files = repoChanges().map(([p]) => p);
  assert.equal(files.length, before + 2);
  assert.ok(files.includes(`changes/${a.body.change.id}.yaml`) && files.includes(`changes/${b.body.change.id}.yaml`));
});

test('with the shared repo unreachable, a change is kept locally as "not published yet" and published once it is back', async () => {
  gh.state.down = true;
  const r = await ana.post('/api/changes', { draft: planned({ change: 'Move rewards launch', what_type: 'decision', what_name: 'launch date' }) });
  assert.equal(r.status, 202);
  assert.equal(r.body.outcome, 'queued');
  assert.match(r.body.message, /^Not published yet: the shared repo can't be reached .* kept on this machine/);
  const queued = fs.readdirSync(path.join(ana.home, 'outbox')).filter((n) => n.endsWith('.json'));
  assert.ok(queued.includes(`${r.body.id}.json`));
  assert.ok(!gh.state.files.get(DATA).has(`changes/${r.body.id}.yaml`));
  gh.state.down = false;
  await ana.get('/api/roadmap'); // the next refresh publishes it
  assert.ok(gh.state.files.get(DATA).has(`changes/${r.body.id}.yaml`));
  assert.ok(!(await ana.get('/api/changes')).outbox.some((e) => e.id === r.body.id));
});

test('a registered change with no reason is blocked and the message names the missing field', async () => {
  const before = repoChanges().length;
  const r = await ana.post('/api/changes', { draft: planned({ reason: '  ' }) });
  assert.equal(r.status, 400);
  assert.equal(r.body.outcome, 'invalid');
  assert.deepEqual(r.body.errors.map((e) => e.field), ['reason']);
  assert.match(r.body.message, /Why is missing/);
  const noFeature = await ana.post('/api/changes', { draft: planned({ features: [] }) });
  assert.deepEqual(noFeature.body.errors.map((e) => e.field), ['features']);
  const noWhat = await ana.post('/api/changes', { draft: planned({ what_name: '' }) });
  assert.deepEqual(noWhat.body.errors.map((e) => e.field), ['what']);
  assert.equal(repoChanges().length, before);
});

test('a feature 2 days from its target date with open steps gets a delay warning naming steps and owners; no target date says so', async () => {
  const snap = await bo.get('/api/roadmap');
  const rr = snap.features.find((f) => f.feature.id === 'redeem-rewards');
  assert.equal(rr.delay.at_risk, true);
  assert.equal(rr.delay.days_left, 2);
  assert.deepEqual(rr.delay.open_steps.map((s) => [s.name, s.owner]), [['Development', '@redeem-rewards-dev'], ['Release', 'Release team']]);
  assert.match(rr.delay.text, /2 days before its target date .* “Development” \(@redeem-rewards-dev\), “Release” \(Release team\)/);
  const view = await bo.open();
  const w = view.alerts.find((a) => a.source === 'lifecycle' && a.feature === 'redeem-rewards');
  assert.ok(w && w.source_label === 'LifeCycle (delay warning)');
  const wishlist = snap.features.find((f) => f.feature.id === 'wishlist');
  assert.equal(wishlist.delay.text, 'no target date: delay warnings off');
  assert.ok(!view.alerts.some((a) => a.source === 'lifecycle' && a.feature === 'wishlist'));
});

test('filtering the alert list by "registered" shows only registered changes', async () => {
  const view = await bo.get('/api/alerts?source=registered');
  assert.ok(view.alerts.length >= 3);
  assert.ok(view.alerts.every((a) => a.source === 'registered'));
  assert.ok((await bo.get('/api/alerts?source=lifecycle')).alerts.every((a) => a.source === 'lifecycle'));
});

test('the shared repo holds no tokens or credentials, and logs hold none either', async () => {
  const r = await ana.post('/api/changes', { draft: planned({ reason: 'use ghp_abcdefghijklmnopqrstuvwxyz0123456789 to switch' }) });
  assert.equal(r.body.outcome, 'invalid');
  assert.match(r.body.errors[0].message, /looks like a token/);
  for (const [p, text] of repoChanges()) {
    assert.ok(!looksLikeToken(text), `${p} has no token-shaped value`);
    assert.ok(!text.includes(gh.token), `${p} has no credential`);
    assert.ok(!/@[\w.-]+\.\w+|token|password|secret/i.test(text.replace(/registered_by: "@\w+"|updated_by: "@\w+"/g, '')), `${p} has no emails or secrets`);
  }
  for (const p of [ana, bo]) {
    await p.open(); // each has seen at least one teammate's change
    const log = fs.readFileSync(path.join(p.home, 'logs', 'alerts.log'), 'utf8');
    assert.ok(!log.includes(gh.token));
    const events = log.trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(events.every((e) => e.feature && e.source), 'every line has feature and source');
    assert.ok(events.some((e) => e.event === 'alert'));
  }
  const anaLog = fs.readFileSync(path.join(ana.home, 'logs', 'alerts.log'), 'utf8');
  assert.match(anaLog, /"event":"publish"/);
  assert.match(anaLog, /"event":"publish_failed"/);
});
