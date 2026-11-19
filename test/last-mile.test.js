// End to end: the real server and app against a fake GitHub and a fake Flagsmith, walking the
// "done vs. turned on" acceptance criteria. No network, no real credentials.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startWorld, CATALOG, WISHLIST } from './last-mile-fixture.js';
import { createApp } from '../src/app.js';
import { createServer } from '../src/server.js';

let w, home, lc;

function startLifecycle({ config = w.config, flagsmithApiKey = w.fs.apiKey } = {}) {
  const server = createServer(createApp({ alwaysLive: true, config, token: w.gh.token, flagsmithApiKey }));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }),
  })));
}
const getJson = async (p, base = lc.url) => (await fetch(base + p)).json();
const lastMile = async (id, base) => (await getJson(`/api/features/${id}/status`, base)).last_mile;

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-lastmile-'));
  process.env.LIFECYCLE_HOME = home;
  w = await startWorld();
  lc = await startLifecycle();
});
after(async () => { await lc.close(); await w.close(); });

test('done and deployed but the rewards flag is off: "done but not turned on", naming the flag', async () => {
  const lm = await lastMile('rewards');
  assert.equal(lm.state, 'deployed_flag_off');
  assert.equal(lm.label, 'Done but not turned on');
  assert.equal(lm.done_but_not_turned_on, true);
  assert.deepEqual(lm.reasons.map((r) => [r.kind, r.flag]), [['flag', 'rewards_enabled']]);
  assert.match(lm.summary, /rewards_enabled is off in production/);
  // Evidence: GitHub Actions, deploy record, flag setting.
  const kinds = new Set(lm.evidence.map((e) => e.kind));
  for (const k of ['pull_request', 'github_actions', 'deploy_record', 'flag_setting']) assert.ok(kinds.has(k), k);
  assert.equal(lm.services[0].environments.production.version, '0.3.0');
  assert.equal(lm.services[0].environments.production.contains_feature, true);
});

test('switching the flag on in the console shows it on after refresh, with nobody editing', async () => {
  w.fs.state.set('Production', 'rewards_enabled', { enabled: true, at: '2026-11-03T10:00:00Z' });
  const lm = await lastMile('rewards');
  assert.equal(lm.state, 'fully_on');
  assert.equal(lm.flags[0].environments.production.state, 'on');
  w.fs.state.set('Production', 'rewards_enabled', { enabled: false, at: '2026-11-01T08:00:00Z' });
});

test('flag at 25% in production: "partly rolled out – 25%"', async () => {
  const lm = await lastMile('redeem-rewards');
  assert.equal(lm.state, 'partly_rolled_out');
  assert.equal(lm.label, 'Partly rolled out – 25%');
  assert.equal(lm.rollout_percentage, 25);
});

test('flag switched off after being on: "switched off" with when and who', async () => {
  assert.equal((await lastMile('referral-bonus')).state, 'fully_on'); // seen on
  w.fs.state.set('Production', 'referral_bonus', { enabled: false, at: '2026-11-03T08:15:00Z' });
  const lm = await lastMile('referral-bonus');
  assert.equal(lm.state, 'switched_off');
  assert.equal(lm.switched_off.flag, 'referral_bonus');
  assert.equal(lm.switched_off.changed_at, '2026-11-03T08:15:00Z');
  assert.equal(lm.switched_off.changed_by, 'Ana Ops');
});

test('done but service not deployed to production: "done but not deployed", naming service and environment; version mismatch shown', async () => {
  const lm = await lastMile('wishlist-share');
  assert.equal(lm.state, 'done_not_deployed');
  assert.equal(lm.label, 'Done but not deployed');
  assert.deepEqual(lm.reasons.map((r) => [r.service, r.environment]), [['wishlist-api', 'production']]);
  assert.match(lm.summary, /wishlist-api 1\.0\.0 in production doesn't include this work/);
  const mismatch = lm.warnings.find((x) => x.kind === 'version_mismatch');
  assert.deepEqual([mismatch.service, mismatch.qa, mismatch.production], ['wishlist-api', '1.1.0', '1.0.0']);
  // Not deployed at all to production also names it.
  w.gh.state.deployments.delete(`${WISHLIST}:production`);
  const none = await lastMile('wishlist-share');
  assert.match(none.reasons[0].message, /wishlist-api isn't deployed to production/);
});

test('a feature with no flags gets its state from deploys alone, labeled "no flags"', async () => {
  const lm = await lastMile('reading-history');
  assert.equal(lm.state, 'fully_on');
  assert.equal(lm.flags_mode, 'no_flags');
  assert.equal(lm.label, 'Fully on · no flags');
});

test('a flag missing from the console is an "unknown flag" warning naming it', async () => {
  const lm = await lastMile('loyalty-tiers');
  const warn = lm.warnings.find((x) => x.kind === 'unknown_flag');
  assert.equal(warn.flag, 'ghost_flag');
  assert.match(warn.message, /ghost_flag/);
  assert.equal(lm.flags[0].unknown, true);
});

test('unfinished development is "not done yet", not a last-mile problem', async () => {
  const lm = await lastMile('reader-redesign');
  assert.equal(lm.state, 'in_development');
  assert.equal(lm.done_but_not_turned_on, false);
});

test('the status API matches what the view renders (same objects in roadmap, status and last-mile endpoints)', async () => {
  const roadmap = await getJson('/api/roadmap');
  const all = await getJson('/api/last-mile');
  for (const f of roadmap.features) {
    const one = await getJson(`/api/features/${f.feature.id}/last-mile`);
    const strip = (x) => JSON.parse(JSON.stringify(x, (k, v) => (/read_at$/.test(k) ? undefined : v)));
    assert.deepEqual(strip(one.last_mile), strip(f.last_mile), f.feature.id);
    assert.equal(all.features.find((x) => x.id === f.feature.id).last_mile.state, f.last_mile.state);
  }
});

test('flag console unreachable: "status unavailable" with last read time, never on or off', async () => {
  const before = await lastMile('redeem-rewards');
  w.fs.state.down = true;
  const snap = await getJson('/api/roadmap');
  w.fs.state.down = false;
  const withFlags = snap.features.filter((f) => f.feature.flags.length);
  assert.ok(withFlags.length >= 4);
  for (const f of withFlags) {
    assert.equal(f.last_mile.state, 'unavailable', f.feature.id);
    assert.ok(!['fully_on', 'deployed_flag_off', 'switched_off', 'partly_rolled_out'].includes(f.last_mile.state));
    for (const fl of f.last_mile.flags) for (const env of ['qa', 'production']) {
      assert.ok(!['on', 'off', 'partial'].includes(fl.environments[env].state));
    }
  }
  const rr = snap.features.find((f) => f.feature.id === 'redeem-rewards').last_mile;
  assert.ok(rr.last_successful_read_at);
  assert.ok(rr.last_successful_read_at <= before.read_at);
  // Features without flags are not affected.
  assert.equal(snap.features.find((f) => f.feature.id === 'reading-history').last_mile.state, 'fully_on');
});

test('deploy records unreachable: affected features "status unavailable"', async () => {
  w.gh.state.readable.delete(CATALOG);
  const lm = await lastMile('reading-history');
  w.gh.state.readable.add(CATALOG);
  assert.equal(lm.state, 'unavailable');
  assert.ok(lm.access_problems.some((a) => a.source === 'github' && /Deployments|Actions/.test(a.message)));
});

test('no access to the flag console: a message naming it and the missing access', async () => {
  const other = await startLifecycle({ flagsmithApiKey: 'someone-elses-wrong-key' });
  const lm = await lastMile('rewards', other.url);
  await other.close();
  assert.equal(lm.state, 'unavailable');
  assert.ok(lm.access_problems.length);
  assert.match(lm.access_problems[0].message, /Flagsmith \(flag console\)/);
  assert.match(lm.access_problems[0].message, /API key/);
  const none = await startLifecycle({ flagsmithApiKey: null });
  const missing = await lastMile('rewards', none.url);
  await none.close();
  assert.match(missing.access_problems[0].message, /No Flagsmith \(flag console\) API key is set up/);
});

test('every source read is logged with source, feature and outcome, and no credential appears', async () => {
  w.fs.state.down = true;
  await getJson('/api/roadmap');
  w.fs.state.down = false;
  const log = fs.readFileSync(path.join(home, 'logs', 'source-reads.log'), 'utf8');
  const lines = log.trim().split('\n').map((l) => JSON.parse(l));
  const failure = lines.find((l) => l.source === 'flagsmith' && l.feature === 'rewards' && l.outcome === 'unreachable');
  assert.ok(failure, 'flag console failure logged for the feature');
  for (const src of ['github-actions', 'github-deployments', 'flagsmith']) assert.ok(lines.some((l) => l.source === src && l.feature && l.outcome), src);
  assert.ok(!log.includes(w.fs.apiKey), 'Flagsmith key leaked');
  assert.ok(!log.includes(w.gh.token), 'GitHub token leaked');
  assert.ok(!/gh[pousr]_|github_pat_|Api-Key [^\[]/.test(log));
});
