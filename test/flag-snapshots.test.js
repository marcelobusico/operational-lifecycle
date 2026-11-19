// Flag snapshots: a publisher's LifeCycle (Statsig key + write access) commits what Statsig said to
// LifeCycle-Data; a teammate without a key (or with Statsig down) sees that snapshot, marked as such
// with its read time, instead of "status unavailable". A live read always wins when it works.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startWorld, DATA } from './last-mile-fixture.js';
import { createApp } from '../src/app.js';
import { flagSnapshotDue, flagSnapshotFile, flagSnapshotText, parseFlagSnapshot, commitFlagSnapshots } from '../src/lastmile/flag-snapshots.js';

let w, home;
const files = () => w.gh.state.files.get(DATA);
const snapFiles = () => [...files().keys()].filter((p) => p.startsWith('flag-snapshots/')).sort();
const snapCommits = (from = 0) => w.gh.state.commits.slice(from).filter((c) => c.path.startsWith('flag-snapshots/'));
const refresh = (statsigApiKey) => createApp({ alwaysLive: true, config: w.configFor('statsig'), token: w.gh.token, flagsmithApiKey: w.fs.apiKey, statsigApiKey }).refresh({ live: true });
const feature = (snap, id) => snap.features.find((f) => f.feature.id === id).last_mile;

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-flag-snapshots-'));
  process.env.LIFECYCLE_HOME = home;
  w = await startWorld();
  w.gh.state.writable.add(DATA); // the publisher can write to LifeCycle-Data
});
after(async () => { await w.close(); fs.rmSync(home, { recursive: true, force: true }); });

test('the publisher\'s refresh commits one snapshot per flag read live, with states and no credentials', async () => {
  const snap = await refresh(w.st.apiKey);
  assert.deepEqual(snap.flag_snapshots.failed, []);
  // Every flag, including ghost_flag, which doesn't exist in Statsig (recorded as unknown).
  assert.deepEqual(snapFiles(), ['flag-snapshots/ghost_flag.yaml', 'flag-snapshots/new_reader.yaml', 'flag-snapshots/redeem_rewards.yaml', 'flag-snapshots/referral_bonus.yaml', 'flag-snapshots/rewards_enabled.yaml']);
  const doc = parseFlagSnapshot(files().get('flag-snapshots/redeem_rewards.yaml'));
  assert.equal(doc.platform, 'statsig');
  assert.equal(doc.environments.qa.state, 'on');
  assert.equal(doc.environments.production.state, 'partial');
  assert.equal(doc.environments.production.rollout_percentage, 25);
  assert.equal(doc.environments.production.platform_environment, 'production');
  assert.ok(Date.parse(doc.read_at));
  const text = files().get('flag-snapshots/redeem_rewards.yaml');
  assert.match(text, /^# Written by LifeCycle from a live Statsig read\. Do not edit by hand\./);
  assert.ok(!text.includes(w.st.apiKey), 'no Statsig key in the snapshot');
  assert.ok(!/conditions|console-/.test(text), 'no rule conditions or key fragments');
  assert.match(snapCommits().find((c) => c.path === 'flag-snapshots/redeem_rewards.yaml').message, /^Flag snapshot: redeem_rewards qa on, production 25% \(LifeCycle\)$/);
});

test('an unchanged flag is not committed again; a change in Statsig commits only that flag', async () => {
  const from = w.gh.state.commits.length;
  await refresh(w.st.apiKey);
  assert.deepEqual(snapCommits(from), [], 'nothing changed, nothing committed');
  w.setFlag('Production', 'redeem_rewards', { enabled: false, rollout: 50, at: '2026-11-03T10:00:00Z' });
  try {
    await refresh(w.st.apiKey);
    assert.deepEqual(snapCommits(from).map((c) => c.path), ['flag-snapshots/redeem_rewards.yaml']);
    assert.equal(parseFlagSnapshot(files().get('flag-snapshots/redeem_rewards.yaml')).environments.production.rollout_percentage, 50);
  } finally {
    w.setFlag('Production', 'redeem_rewards', { enabled: false, rollout: 25, at: '2026-11-02T16:00:00Z' });
    await refresh(w.st.apiKey);
  }
});

test('a reader without a Statsig key sees the snapshot\'s state, marked as a snapshot with its read time', async () => {
  const committedAt = parseFlagSnapshot(files().get('flag-snapshots/redeem_rewards.yaml')).read_at;
  const from = w.gh.state.commits.length;
  const snap = await refresh(null);
  const lm = feature(snap, 'redeem-rewards');
  assert.equal(lm.state, 'partly_rolled_out');
  assert.equal(lm.label, 'Partly rolled out – 25%');
  const prod = lm.flags[0].environments.production;
  assert.equal(prod.from_snapshot, true);
  assert.equal(prod.snapshot_read_at, committedAt);
  assert.equal(prod.last_successful_read_at, committedAt);
  assert.equal(prod.live_state, 'no_access');
  assert.match(prod.message, /No Statsig Console API key is set up/);
  assert.equal(lm.flags[0].environments.qa.from_snapshot, true);
  // Flags aren't a "missing access" problem when a snapshot covers them, and the flag source says so.
  assert.deepEqual(lm.access_problems, []);
  assert.equal(snap.flag_source.state, 'snapshot');
  assert.equal(snap.flag_source.reason, 'no_credential');
  assert.ok(snap.flag_source.snapshot_read_at);
  // Same verdicts as the publisher sees for the other flags.
  assert.equal(feature(snap, 'referral-bonus').state, 'fully_on');
  assert.equal(feature(snap, 'rewards').state, 'deployed_flag_off');
  // The sources view says where the state came from.
  const src = snap.features.find((f) => f.feature.id === 'redeem-rewards').sources.find((t) => t.key === 'flag:redeem_rewards:production');
  assert.equal(src.from_snapshot, true);
  assert.equal(src.read_at, committedAt);
  assert.match(src.message, /No Statsig Console API key is set up/);
  // ghost_flag doesn't exist in Statsig: the snapshot says so, so the reader gets the same warning.
  assert.equal(feature(snap, 'loyalty-tiers').warnings.find((x) => x.kind === 'unknown_flag').flag, 'ghost_flag');
  // The ramp verdict names the snapshot too.
  assert.ok(JSON.stringify(snap.features.find((f) => f.feature.id === 'redeem-rewards').ramp).includes('team snapshot, read'));
  // A reader without a key reads nothing live, so it writes no snapshot.
  assert.deepEqual(snapCommits(from), []);
});

test('Statsig down for someone with a key: snapshot instead of "unavailable"', async () => {
  w.st.state.down = true;
  try {
    const snap = await refresh(w.st.apiKey);
    const lm = feature(snap, 'redeem-rewards');
    assert.equal(lm.state, 'partly_rolled_out');
    assert.equal(lm.flags[0].environments.production.from_snapshot, true);
    assert.equal(lm.flags[0].environments.production.live_state, 'unavailable');
    assert.equal(snap.flag_source.state, 'snapshot');
    assert.equal(snap.flag_source.reason, 'unreachable');
  } finally {
    w.st.state.down = false;
  }
  // Back up: the live read wins again.
  const lm = feature(await refresh(w.st.apiKey), 'redeem-rewards');
  assert.equal(lm.flags[0].environments.production.from_snapshot, false);
});

test('a flag with no snapshot stays "status unavailable", and the flag source is still a problem', async () => {
  const saved = files().get('flag-snapshots/referral_bonus.yaml');
  files().delete('flag-snapshots/referral_bonus.yaml');
  try {
    const snap = await refresh(null);
    assert.equal(feature(snap, 'referral-bonus').state, 'unavailable');
    assert.equal(feature(snap, 'redeem-rewards').state, 'partly_rolled_out', 'other flags still use their snapshot');
    assert.equal(snap.flag_source.state, 'problem');
  } finally {
    files().set('flag-snapshots/referral_bonus.yaml', saved);
  }
});

test('someone with a key but read-only access to LifeCycle-Data reads live and never tries to commit', async () => {
  w.gh.state.writable.delete(DATA);
  w.setFlag('Production', 'redeem_rewards', { enabled: false, rollout: 75, at: '2026-11-04T10:00:00Z' });
  const from = w.gh.state.commits.length;
  try {
    const snap = await refresh(w.st.apiKey);
    assert.equal(feature(snap, 'redeem-rewards').rollout_percentage, 75);
    assert.deepEqual(snap.flag_snapshots, { committed: [], failed: [] });
    assert.deepEqual(snapCommits(from), []);
  } finally {
    w.gh.state.writable.add(DATA);
    w.setFlag('Production', 'redeem_rewards', { enabled: false, rollout: 25, at: '2026-11-02T16:00:00Z' });
  }
});

test('snapshot rules: due when changed or older than 6 hours; odd flag keys get safe file names; junk is ignored', async () => {
  const env = (state, pct) => ({ platform_environment: 'x', state, rollout_percentage: pct, segments: [], changed_at: null, changed_by: null, was_on_before: null, link: null });
  const read = { platform: 'statsig', flag: 'f', read_at: '2026-11-10T12:00:00.000Z', environments: { qa: env('on', 100), production: env('partial', 25) } };
  const now = Date.parse('2026-11-10T12:00:00Z');
  const committed = parseFlagSnapshot(flagSnapshotText({ ...read, read_at: '2026-11-10T10:00:00.000Z' }));
  assert.equal(flagSnapshotDue(read, committed, now), false, 'same state, 2 hours old');
  assert.equal(flagSnapshotDue(read, committed, now + 5 * 3600e3), true, 'same state, 7 hours old');
  assert.equal(flagSnapshotDue({ ...read, environments: { ...read.environments, production: env('partial', 30) } }, committed, now), true, 'rollout changed');
  assert.equal(flagSnapshotDue(read, { ...committed, platform: 'flagsmith' }, now), true, 'other platform');
  assert.equal(flagSnapshotDue(read, null, now), true);
  assert.equal(flagSnapshotFile('../etc/passwd'), 'flag-snapshots/.._etc_passwd.yaml');
  assert.equal(flagSnapshotFile('my gate/1'), 'flag-snapshots/my_gate_1.yaml');
  assert.equal(parseFlagSnapshot('not: [valid'), null);
  assert.equal(parseFlagSnapshot('flag: x\nplatform: statsig\n'), null);
  // An environment with a state that isn't on/off/partial is dropped, never shown.
  const odd = parseFlagSnapshot('platform: statsig\nflag: x\nread_at: 2026-11-10T10:00:00Z\nenvironments:\n  qa: { state: maybe }\n  production: { state: off }\n');
  assert.deepEqual(Object.keys(odd.environments), ['production']);
  // Without write access nothing is attempted.
  const out = await commitFlagSnapshots({ config: {}, github: { request: () => assert.fail('no request') }, reads: [read], canWrite: async () => false });
  assert.deepEqual(out, [{ file: 'flag-snapshots/f.yaml', outcome: 'read_only' }]);
});
