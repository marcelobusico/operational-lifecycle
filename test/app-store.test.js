// End to end: mobile release status from the app stores, against a fake App Store Connect (iOS)
// and, for the two-store scenarios, a test-only Google Play connector plugged in through the same
// store layer. No network, no real store account.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startMobileWorld, fakeGooglePlay, IOS_ID } from './mobile-fixture.js';
import { DATA } from './last-mile-fixture.js';
import { createApp } from '../src/app.js';
import { createServer } from '../src/server.js';

let w, home, lc;

function startLifecycle(opts = {}) {
  const app = createApp({ config: { ...w.config, ai: { provider: 'none' } }, token: w.gh.token, flagsmithApiKey: w.fs.apiKey, storeCredentials: w.storeCredentials, ...opts });
  const server = createServer(app);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }),
  })));
}
const getJson = async (p, base = lc.url) => (await fetch(base + p)).json();
const status = async (id, base) => getJson(`/api/features/${id}/status`, base);
const lastMile = async (id, base) => (await status(id, base)).last_mile;
const setPhase = (version, phased) => w.store.state.update(IOS_ID, version, { phased });

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-appstore-'));
  process.env.LIFECYCLE_HOME = home;
  w = await startMobileWorld();
  w.gh.state.writable.add(DATA); // LifeCycle commits store snapshots to LifeCycle-Data
  lc = await startLifecycle();
});
after(async () => { await lc.close(); await w.close(); });

test('3.4.0 released to 20% on iOS: "released in 3.4.0 to 20% of iOS users", with a store link and a last-read time', async () => {
  const lm = await lastMile('mobile-rewards');
  assert.equal(lm.state, 'app_partly_released');
  assert.equal(lm.label, 'Released in 3.4.0 to 20% of iOS users');
  assert.equal(lm.rollout_percentage, 20);
  const ios = lm.apps[0].platforms.ios;
  assert.equal(ios.label, 'released in 3.4.0 to 20% of iOS users');
  assert.equal(ios.version, '3.4.0');
  assert.equal(ios.rollout_percentage, 20);
  assert.match(ios.link, /^https:\/\/appstoreconnect\.apple\.com\/apps\/1234567890\//);
  assert.ok(Date.parse(ios.last_successful_read_at), 'last read time');
  assert.equal(ios.tag_check.state, 'ok');
  assert.ok(lm.evidence.some((e) => e.kind === 'store_release' && e.link === ios.link));
  // Android's store isn't connected: said, never guessed.
  assert.equal(lm.apps[0].platforms.android.state, 'not_connected');
  assert.equal(lm.apps[0].platforms.android.label, 'store not connected');
  // A snapshot of the read was committed to LifeCycle-Data by LifeCycle.
  const snap = w.gh.state.files.get(DATA).get('store-snapshots/acme-mobile-ios.yaml');
  assert.match(snap, /released_version: 3\.4\.0/);
  assert.match(snap, /rollout_percentage: 20/);
  assert.match(snap, /read_at: /);
});

test('raising the rollout to 100% in the store shows "fully released" after refresh, with nobody editing', async () => {
  const commits = w.gh.state.commits.length;
  setPhase('3.4.0', { state: 'ACTIVE', day: 7 });
  try {
    const lm = await lastMile('mobile-rewards');
    assert.equal(lm.state, 'fully_on');
    assert.equal(lm.label, 'Fully released');
    assert.equal(lm.apps[0].platforms.ios.label, 'fully released in 3.4.0');
    // The definitions weren't touched; only LifeCycle's own snapshot moved on.
    assert.deepEqual(w.gh.state.commits.slice(commits).map((c) => c.path), ['store-snapshots/acme-mobile-ios.yaml']);
  } finally {
    setPhase('3.4.0', { state: 'ACTIVE', day: 5 });
  }
});

test('first version still in review: "in review" and a "not ready" ramp verdict naming the store review', async () => {
  const s = await status('mobile-reader');
  assert.equal(s.last_mile.state, 'in_store_review');
  assert.equal(s.last_mile.label, 'In review – iOS 3.5.0');
  assert.equal(s.last_mile.apps[0].platforms.ios.label, 'in version 3.5.0, in review');
  assert.equal(s.ramp.verdict, 'not_ready');
  const reason = s.ramp.reasons.find((r) => r.check === 'store');
  assert.match(reason.message, /3\.5\.0 is in App Store review/);
  assert.equal(reason.owner, 'Mobile team');
  assert.ok(reason.evidence.some((e) => /appstoreconnect\.apple\.com/.test(e.link)));
});

test('halting the rollout: "rollout halted", a timeline entry, and the ramp verdict names it', async () => {
  setPhase('3.4.0', { state: 'PAUSED', day: 5 });
  try {
    const s = await status('mobile-rewards');
    assert.equal(s.last_mile.state, 'rollout_halted');
    assert.match(s.last_mile.label, /^Rollout halted – iOS 3\.4\.0 at 20%/);
    const ios = s.last_mile.apps[0].platforms.ios;
    const ev = ios.events.find((e) => e.kind === 'store_rollout_halted');
    assert.ok(ev, JSON.stringify(ios.events));
    assert.match(ev.message, /iOS 3\.4\.0 rollout was paused at 20%/);
    assert.equal(s.ramp.verdict, 'not_ready');
    assert.match(s.ramp.reasons.find((r) => r.check === 'store').message, /3\.4\.0 rollout is halted in App Store at 20%/);
  } finally {
    setPhase('3.4.0', { state: 'ACTIVE', day: 5 });
  }
});

test('released on Android but in review on iOS: both shown, with the mismatch visible', async () => {
  const gp = fakeGooglePlay([{ version: '3.5.0', state: 'released', store_state: 'completed', rollout: { state: 'complete', percentage: 100 } }]);
  const two = await startLifecycle({ storeConnectors: { google_play: gp.factory } });
  try {
    const lm = await lastMile('mobile-reader', two.url);
    const { ios, android } = lm.apps[0].platforms;
    assert.equal(android.label, 'fully released in 3.5.0');
    assert.equal(android.store_name, 'Google Play');
    assert.equal(ios.label, 'in version 3.5.0, in review');
    assert.equal(lm.state, 'in_store_review');
    const mismatch = lm.warnings.find((x) => x.kind === 'platform_mismatch');
    assert.match(mismatch.message, /iOS in version 3\.5\.0, in review; Android fully released in 3\.5\.0/);
  } finally {
    await two.close();
  }
});

test('fully released in the app but its Statsig flag off: "done but not turned on", naming the flag', async () => {
  const st = await startLifecycle({ config: { ...w.configFor('statsig'), sources: { ...w.configFor('statsig').sources, appStore: w.config.sources.appStore } }, statsigApiKey: w.st.apiKey });
  try {
    const lm = await lastMile('mobile-wishlist', st.url);
    assert.equal(lm.flag_platform, 'statsig');
    assert.equal(lm.apps[0].platforms.ios.label, 'fully released in 3.4.0');
    assert.equal(lm.state, 'deployed_flag_off');
    assert.equal(lm.label, 'Done but not turned on');
    assert.deepEqual(lm.reasons.filter((r) => r.kind === 'flag').map((r) => r.flag), ['rewards_enabled']);
    // Android isn't read on this machine: it comes from the snapshot the Google Play reader committed above.
    assert.match(lm.summary, /released in the app \(iOS 3\.4\.0, Android 3\.5\.0\), but flag rewards_enabled is off in production/);
    assert.equal(lm.apps[0].platforms.android.from_snapshot, true);
  } finally {
    await st.close();
  }
});

test('store unreachable: the team snapshot stands in, marked as such; without one, "status unavailable", never "released"', async () => {
  await lastMile('mobile-rewards'); // a successful read (and snapshot) first
  const committed = w.gh.state.files.get(DATA).get('store-snapshots/acme-mobile-ios.yaml').match(/read_at: (.+)/)[1].replace(/"/g, '');
  w.store.state.down = true;
  try {
    const lm = await lastMile('mobile-rewards');
    assert.equal(lm.state, 'app_partly_released');
    const ios = lm.apps[0].platforms.ios;
    assert.equal(ios.label, 'released in 3.4.0 to 20% of iOS users');
    assert.equal(ios.from_snapshot, true);
    assert.equal(ios.snapshot_read_at, committed);
    assert.equal(ios.last_successful_read_at, committed);
    assert.equal(ios.live_state, 'unavailable');
    assert.ok(ios.link, 'keeps the snapshot\'s store link');
    // Without a snapshot: unavailable, never guessed.
    const saved = w.gh.state.files.get(DATA).get('store-snapshots/acme-mobile-ios.yaml');
    w.gh.state.files.get(DATA).delete('store-snapshots/acme-mobile-ios.yaml');
    try {
      const none = await lastMile('mobile-rewards');
      assert.equal(none.state, 'unavailable');
      assert.equal(none.label, 'Status unavailable');
      const c = none.apps[0].platforms.ios;
      assert.equal(c.state, 'unavailable');
      assert.equal(c.label, 'status unavailable');
      assert.ok(Date.parse(c.last_successful_read_at));
      assert.doesNotMatch(JSON.stringify([none.label, none.summary, c.label]), /released/i);
      assert.match(none.summary, /the App Store couldn't be read/);
    } finally {
      w.gh.state.files.get(DATA).set('store-snapshots/acme-mobile-ios.yaml', saved);
    }
  } finally {
    w.store.state.down = false;
  }
});

test('a store identifier that doesn\'t exist shows an "unknown app" warning; a version with no release tag is flagged', async () => {
  const ghost = await lastMile('mobile-ghost');
  assert.equal(ghost.state, 'unavailable');
  assert.ok(ghost.warnings.some((x) => x.kind === 'unknown_app' && /no app with the identifier 999/.test(x.message)));
  const untagged = await lastMile('mobile-untagged');
  assert.ok(untagged.warnings.some((x) => x.kind === 'app_version_tag' && /No release tag v3\.6\.0 in team\/mobile/.test(x.message)));
});

test('the chat answer gives the app version, rollout % per platform and the store as evidence', async () => {
  const res = await fetch(`${lc.url}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'Is rewards in the app available to users?' }) });
  const a = await res.json();
  assert.equal(a.feature.id, 'mobile-rewards');
  // Android comes from the team snapshot the Google Play reader committed earlier, and says so.
  assert.match(a.lead.text, /iOS: released in 3\.4\.0 to 20% of iOS users \(App Store\); Android: fully released in 3\.5\.0 \(Google Play, team snapshot from \d{4}-\d\d-\d\d \d\d:\d\d UTC\)/);
  const iosFact = a.sections.flatMap((s) => s.statements).find((f) => f.platform === 'ios');
  assert.match(iosFact.text, /Acme on iOS \(App Store\): the feature first ships in Acme 3\.4\.0; released in 3\.4\.0 to 20% of iOS users/);
  assert.ok(iosFact.evidence.some((e) => /\(App Store\)$/.test(e.label) && /appstoreconnect\.apple\.com/.test(e.link)), JSON.stringify(iosFact.evidence));
  assert.ok(a.lead.cites.includes(iosFact.id));
});

// --- store credentials ---------------------------------------------------------------------------

function run(args, env, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env, cwd: path.resolve(import.meta.dirname, '..') });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(input);
  });
}

test('after setup, LifeCycle-Data, the local logs and the page output hold no store credentials', async () => {
  const setupHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-appstore-setup-'));
  const lcHome = path.join(setupHome, '.lifecycle');
  const p8 = path.join(setupHome, 'AuthKey_FAKEKEY123.p8');
  fs.writeFileSync(p8, w.store.credentials.privateKey);
  const env = { HOME: setupHome, PATH: '/usr/bin:/bin', LIFECYCLE_HOME: lcHome, LIFECYCLE_GITHUB_API: w.gh.url, LIFECYCLE_DATA_REPO: DATA, LIFECYCLE_APP_STORE_API: w.store.url };
  const first = await run(['src/cli/setup.js'], env, `${DATA}\n${w.gh.token}\n\n`);
  assert.equal(first.code, 0, first.out);
  // Extras: branch, Statsig key (skip), AI provider, owners, then the App Store key.
  const r = await run(['src/cli/setup.js', '--extras'], env, `\n-\nnone\n\ny\n${w.store.credentials.issuerId}\n${w.store.credentials.keyId}\n${p8}\n`);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /✓ App Store Connect accepted the key\./);
  const creds = JSON.parse(fs.readFileSync(path.join(lcHome, 'credentials.json'), 'utf8'));
  assert.equal(creds.appStore.keyId, w.store.credentials.keyId);
  assert.equal(fs.statSync(path.join(lcHome, 'credentials.json')).mode & 0o777, 0o600);
  assert.doesNotMatch(fs.readFileSync(path.join(lcHome, 'config.json'), 'utf8'), /PRIVATE KEY|FAKEKEY123/);

  // LifeCycle reading with the saved credentials (none passed in), the way the app starts.
  const saved = process.env.LIFECYCLE_HOME;
  process.env.LIFECYCLE_HOME = lcHome;
  const app = createApp({ config: { ...w.config, ai: { provider: 'none' } }, token: w.gh.token, flagsmithApiKey: w.fs.apiKey });
  const server = createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    w.store.state.forbidden = true; // and a refused read, whose message goes to the logs
    await getJson('/api/roadmap', base);
    w.store.state.forbidden = false;
    const lm = await lastMile('mobile-rewards', base);
    assert.equal(lm.apps[0].platforms.ios.version, '3.4.0', 'the saved key reads the store');
    const pages = await Promise.all(['/api/roadmap', '/api/last-mile', '/api/features/mobile-rewards/status', '/', '/app.js'].map(async (p) => (await fetch(base + p)).text()));
    const answer = await (await fetch(`${base}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'Is rewards in the app available to users?' }) })).text();
    const keyBody = w.store.credentials.privateKey.split('\n').filter((l) => l && !l.startsWith('-----'))[0];
    const secrets = [keyBody, w.store.credentials.keyId, w.store.credentials.issuerId, 'PRIVATE KEY'];
    const data = [...w.gh.state.files.get(DATA).values(), ...w.gh.state.commits.map((c) => `${c.message}\n${c.after || ''}`)].join('\n');
    const logsDir = path.join(lcHome, 'logs');
    const logs = fs.existsSync(logsDir) ? fs.readdirSync(logsDir).map((n) => fs.readFileSync(path.join(logsDir, n), 'utf8')).join('\n') : '';
    assert.ok(logs.includes('app_store'), 'store reads are logged');
    for (const [where, text] of [['LifeCycle-Data', data], ['local logs', logs], ['page output', [...pages, answer].join('\n')]]) {
      for (const s of secrets) assert.ok(!text.includes(s), `${where} contains ${s.slice(0, 12)}…`);
    }
  } finally {
    process.env.LIFECYCLE_HOME = saved;
    server.close(); server.closeAllConnections();
  }
});
