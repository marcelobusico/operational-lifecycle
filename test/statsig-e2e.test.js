// End to end with Statsig as the flag platform: the real server and app against a fake GitHub and a
// fake Statsig MCP server, walking the acceptance criteria. The same world also holds
// equivalent Flagsmith settings, so switching platforms is only a config change.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startWorld } from './last-mile-fixture.js';
import { createApp } from '../src/app.js';
import { createServer } from '../src/server.js';

let w, home, lc;

function startLifecycle({ platform = 'statsig', statsigApiKey = w.st.apiKey } = {}) {
  const server = createServer(createApp({ alwaysLive: true, config: w.configFor(platform), token: w.gh.token, flagsmithApiKey: w.fs.apiKey, statsigApiKey }));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }),
  })));
}
const getJson = async (p, base = lc.url) => (await fetch(base + p)).json();
const lastMile = async (id, base) => (await getJson(`/api/features/${id}/status`, base)).last_mile;

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-statsig-'));
  process.env.LIFECYCLE_HOME = home;
  w = await startWorld();
  lc = await startLifecycle();
});
after(async () => { await lc.close(); await w.close(); });

test('switching config from Flagsmith to Statsig gives the same states for equivalent flag settings', async () => {
  const flagsmith = await startLifecycle({ platform: 'flagsmith' });
  const a = await getJson('/api/roadmap', flagsmith.url);
  await flagsmith.close();
  const b = await getJson('/api/roadmap');
  const view = (snap) => Object.fromEntries(snap.features.map((f) => [f.feature.id, {
    state: f.last_mile.state, label: f.last_mile.label, rollout: f.last_mile.rollout_percentage,
    warnings: f.last_mile.warnings.map((x) => [x.kind, x.flag || x.service]),
    flags: f.last_mile.flags.map((fl) => [fl.key, fl.unknown, fl.environments.qa.state, fl.environments.production.state, fl.environments.production.rollout_percentage]),
  }]));
  assert.deepEqual(view(b), view(a));
  assert.equal(a.features[0].last_mile.flag_platform, 'flagsmith');
  assert.equal(b.features[0].last_mile.flag_platform, 'statsig');
  // Covers every scenario of the existing walkthrough, not just one.
  assert.deepEqual(new Set(Object.values(view(b)).map((x) => x.state)),
    new Set(['deployed_flag_off', 'partly_rolled_out', 'fully_on', 'done_not_deployed', 'in_development']));
});

test('a Statsig gate at 25% in production: "partly rolled out – 25%", linking to the gate in Statsig', async () => {
  const lm = await lastMile('redeem-rewards');
  assert.equal(lm.state, 'partly_rolled_out');
  assert.equal(lm.label, 'Partly rolled out – 25%');
  const prod = lm.flags[0].environments.production;
  assert.equal(prod.link, `https://console.statsig.com/${w.st.company}/gates/redeem_rewards`);
  assert.ok(prod.last_successful_read_at, 'shows when it was last read');
  assert.ok(lm.evidence.some((e) => e.kind === 'flag_setting' && e.link === prod.link && /25%/.test(e.label)));
  // The flag status in the feature's sources opens that gate in Statsig, with its read time.
  const src = (await getJson('/api/features/redeem-rewards/status')).sources.find((t) => t.key === 'flag:redeem_rewards:production');
  assert.equal(src.source, 'statsig');
  assert.deepEqual(src.links.map((l) => l.url), [prod.link]);
  assert.ok(src.read_at);
});

test('switching the gate off in Statsig and refreshing shows "switched off" with when and who', async () => {
  assert.equal((await lastMile('referral-bonus')).state, 'fully_on'); // seen on
  w.st.state.disable('referral_bonus', { at: '2026-11-03T08:15:00Z', by: 'Bea Release' });
  const lm = await lastMile('referral-bonus');
  assert.equal(lm.state, 'switched_off');
  assert.equal(lm.label, 'Switched off');
  assert.equal(lm.switched_off.changed_at, '2026-11-03T08:15:00.000Z');
  assert.equal(lm.switched_off.changed_by, 'Bea Release');
  w.st.state.gates.get('referral_bonus').isEnabled = true;
});

test('Statsig down: "status unavailable" with the last read time, never on or off', async () => {
  const before = await lastMile('redeem-rewards');
  w.st.state.down = true;
  const snap = await getJson('/api/roadmap');
  w.st.state.down = false;
  for (const f of snap.features.filter((x) => x.feature.flags.length)) {
    assert.equal(f.last_mile.state, 'unavailable', f.feature.id);
    for (const fl of f.last_mile.flags) for (const env of ['qa', 'production']) assert.ok(!['on', 'off', 'partial'].includes(fl.environments[env].state));
  }
  const rr = snap.features.find((f) => f.feature.id === 'redeem-rewards').last_mile;
  // "Source unavailable since <time>", still linking the gate read last time.
  const src = snap.features.find((f) => f.feature.id === 'redeem-rewards').sources.find((t) => t.key === 'flag:redeem_rewards:production');
  assert.ok(src.unavailable && src.unavailable_since);
  assert.deepEqual(src.links.map((l) => l.url), [before.flags[0].environments.production.link]);
  assert.equal(rr.label, 'Status unavailable');
  assert.match(rr.summary, /Statsig couldn't be read/);
  assert.ok(rr.last_successful_read_at && rr.last_successful_read_at <= before.read_at);
  assert.equal(snap.features.find((f) => f.feature.id === 'reading-history').last_mile.state, 'fully_on');
});

test('a person without Statsig access sees a message naming Statsig and the missing access', async () => {
  const other = await startLifecycle({ statsigApiKey: 'someone-elses-wrong-key' });
  const lm = await lastMile('rewards', other.url);
  await other.close();
  assert.equal(lm.state, 'unavailable');
  assert.equal(lm.access_problems[0].source, 'statsig');
  assert.match(lm.access_problems[0].message, /^Statsig refused your Console API key/);
  assert.match(lm.access_problems[0].message, /read access to the project's feature gates/);
  const none = await startLifecycle({ statsigApiKey: null });
  const missing = await lastMile('rewards', none.url);
  await none.close();
  assert.match(missing.access_problems[0].message, /No Statsig Console API key is set up/);
});

test('a feature listing a gate that does not exist in Statsig shows an "unknown flag" warning naming it', async () => {
  const lm = await lastMile('loyalty-tiers');
  const warn = lm.warnings.find((x) => x.kind === 'unknown_flag');
  assert.equal(warn.flag, 'ghost_flag');
  assert.match(warn.message, /Unknown flag "ghost_flag".*doesn't exist in Statsig/);
});

test('Statsig reads are logged per feature, and no Statsig key appears in the logs or the shared repo', async () => {
  w.st.state.down = true;
  await getJson('/api/roadmap');
  w.st.state.down = false;
  const logDir = path.join(home, 'logs');
  const logs = fs.readdirSync(logDir).map((f) => fs.readFileSync(path.join(logDir, f), 'utf8')).join('\n');
  const lines = fs.readFileSync(path.join(logDir, 'source-reads.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.source === 'statsig' && l.feature === 'rewards' && l.outcome === 'unreachable'));
  assert.ok(lines.some((l) => l.source === 'statsig' && l.feature === 'loyalty-tiers' && l.outcome === 'unknown_flag'));
  assert.ok(!logs.includes(w.st.apiKey), 'Statsig key leaked into the logs');
  assert.ok(!/console-[A-Za-z0-9]{20,}/.test(logs));
  // The shared repo: nothing shaped like a Statsig Console API key is tracked.
  // (git grep exits 1 when nothing matches.)
  let tracked = '';
  try {
    tracked = execFileSync('git', ['grep', '-I', '-l', '-E', 'console-[A-Za-z0-9]{20,}'], { encoding: 'utf8', cwd: path.resolve(import.meta.dirname, '..') });
  } catch (err) {
    if (err.status !== 1) throw err;
  }
  assert.equal(tracked, '');
});
