// Statsig works out of the box: the team's flag platform comes from LifeCycle-Data/team.yaml, a
// config that never chose one follows it (with a one-time notice), setup follows the platform, and
// Home names the configured platform (and only it) when the flag source can't be read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGithub } from './fake-github.js';
import { startFakeStatsig } from './fake-statsig.js';
import { parseTeam, resolveFlagPlatform, chosenFlagPlatform } from '../src/team.js';
import { parseDefinitions } from '../src/definitions.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `lc-${name}-`));
const CONSOLE_KEY = 'console-fake-key-not-a-real-credential';
const SECRET_KEY = 'secret-fake-server-key-not-real';

function run(args, { env, input = '' }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env, cwd: ROOT });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr, all: stdout + stderr }));
    child.stdin.end(input);
  });
}

// A shared repo acme/features whose team.yaml says Statsig, and a Statsig that knows one gate.
async function world({ team = 'flag_platform: statsig\n' } = {}) {
  const gh = await startFakeGithub();
  gh.state.readable.add('acme/features');
  gh.state.files.set('acme/features', new Map(team === null ? [] : [['team.yaml', team]]));
  const st = await startFakeStatsig({ apiKey: CONSOLE_KEY });
  st.state.set('production', 'rewards_enabled', { enabled: true });
  const home = tmp('flags');
  const env = { HOME: home, PATH: '/usr/bin:/bin', LIFECYCLE_HOME: path.join(home, '.lifecycle'), LIFECYCLE_GITHUB_API: gh.url, LIFECYCLE_STATSIG_MCP_URL: st.url };
  const setup = (input, args = []) => run(['src/cli/setup.js', ...args], { env, input });
  const config = () => JSON.parse(fs.readFileSync(path.join(env.LIFECYCLE_HOME, 'config.json'), 'utf8'));
  const credentials = () => fs.readFileSync(path.join(env.LIFECYCLE_HOME, 'credentials.json'), 'utf8');
  return { gh, st, home, env, setup, config, credentials, close: async () => { await gh.close(); await st.close(); } };
}

// --- the team default and who follows it -----------------------------------------------------------

test('team.yaml sets the team default; a person\'s deliberate choice wins, a silent default does not', () => {
  assert.deepEqual(parseTeam('flag_platform: Statsig\n'), { team: { flag_platform: 'statsig' }, errors: [] });
  assert.equal(parseTeam('flag_platform: launchdarkly\n').errors[0].field, 'flag_platform');
  const parsed = parseDefinitions([{ path: 'team.yaml', text: 'flag_platform: flagsmith\n' }]);
  assert.deepEqual(parsed.team, { flag_platform: 'flagsmith' });
  const team = { flag_platform: 'statsig' };
  // A fresh install, or a config that predates the setting: the team default.
  assert.equal(resolveFlagPlatform({}, team).platform, 'statsig');
  assert.equal(resolveFlagPlatform({}, {}).platform, 'statsig', 'no team.yaml: Statsig');
  // Every saved config used to carry flagPlatform "flagsmith" from the defaults: without a Flagsmith
  // project that was never a choice.
  assert.equal(resolveFlagPlatform({ flagPlatform: 'flagsmith', sources: { flagsmith: { projectId: null } } }, team).platform, 'statsig');
  // Deliberate Flagsmith: picked in setup, or set up with a project (also before the setting existed).
  assert.equal(resolveFlagPlatform({ flagPlatform: 'flagsmith', flagPlatformSource: 'chosen' }, team).platform, 'flagsmith');
  assert.equal(resolveFlagPlatform({ flagPlatform: 'flagsmith', sources: { flagsmith: { projectId: 7 } } }, team).platform, 'flagsmith');
  assert.equal(resolveFlagPlatform({ sources: { flagsmith: { projectId: 7 } } }, team).platform, 'flagsmith');
  // Following the team: a later team change is followed.
  assert.equal(resolveFlagPlatform({ flagPlatform: 'statsig', flagPlatformSource: 'team' }, { flag_platform: 'flagsmith' }).platform, 'flagsmith');
  assert.equal(chosenFlagPlatform({ flagPlatform: 'statsig', flagPlatformSource: 'env' }), 'statsig');
});

// --- setup ------------------------------------------------------------------------------------------

test('a clean machine accepting every default ends up on Statsig, named in the setup output', async () => {
  const w = await world();
  try {
    const r = await w.setup(`acme/features\n${w.gh.token}\n\n`);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /Feature flags: Statsig, your team's default \(team\.yaml in acme\/features\)/);
    assert.match(r.stdout, /To see flag status, add your Statsig key: .*--extras/);
    assert.doesNotMatch(r.stdout, /Flagsmith/);
    assert.equal(w.config().flagPlatform, 'statsig');
    assert.equal(w.config().flagPlatformSource, 'team');
  } finally {
    await w.close();
  }
});

test('choosing Statsig asks no Flagsmith questions; a secret- key is explained in plain words; a console- key connects', async () => {
  const w = await world();
  try {
    await w.setup(`acme/features\n${w.gh.token}\n\n`);
    // Extras: branch, platform (Return = Statsig), a secret- key, then the console- key, QA/production names, AI none, owners.
    const r = await w.setup(`\n\n${SECRET_KEY}\n${CONSOLE_KEY}\n\n\nnone\n\n`, ['--extras']);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /Your team reads flags from Statsig \(team\.yaml in acme\/features\)/);
    assert.match(r.stdout, /Flag platform \(statsig or flagsmith; "-" skips\) \[statsig\]/, 'Statsig is offered first, as the default');
    assert.match(r.stdout, /needs a Console API key\s+\(it starts with console-\)/);
    assert.match(r.stdout, /! That is a Server Secret key \(secret-…\), not a Console API key\. Statsig's MCP server only accepts a Console API key \(console-…\)\./);
    assert.match(r.stdout, /Create one at https:\/\/console\.statsig\.com\/api_keys \(Settings → Keys & Environments → Console API Keys/);
    assert.match(r.stdout, /✓ Connected to Statsig: 1 feature gate readable \(QA = staging, production = production\)\./);
    assert.doesNotMatch(r.stdout, /Flagsmith API key|Flag console|Organisation API key|Flagsmith project id|Flagsmith environment/i, 'no Flagsmith question');
    assert.doesNotMatch(r.all, /HTTP 40\d|\b403\b/, 'no raw HTTP error');
    assert.ok(!r.all.includes(CONSOLE_KEY) && !r.all.includes(SECRET_KEY), 'no key is printed');
    // Only the console key is saved, only in credentials.json (mode 600), never in config.json.
    assert.deepEqual(JSON.parse(w.credentials()).statsig, { apiKey: CONSOLE_KEY });
    assert.ok(!w.credentials().includes(SECRET_KEY), 'the refused key was not saved');
    assert.equal(fs.statSync(path.join(w.env.LIFECYCLE_HOME, 'credentials.json')).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(w.config()).includes(CONSOLE_KEY));
    assert.equal(w.config().flagPlatform, 'statsig');
  } finally {
    await w.close();
  }
});

test('a console key Statsig refuses is explained without a raw HTTP error, and is not saved', async () => {
  const w = await world();
  try {
    await w.setup(`acme/features\n${w.gh.token}\n\n`);
    const r = await w.setup('\n\nconsole-revoked-key-not-real\n-\nnone\n\n', ['--extras']);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /! Statsig refused your Console API key \(revoked, expired or for another project\)/);
    assert.doesNotMatch(r.all, /HTTP 40\d/);
    assert.match(r.stdout, /Skipped\./);
    assert.ok(!fs.existsSync(path.join(w.env.LIFECYCLE_HOME, 'credentials.json')) || !w.credentials().includes('console-revoked'));
  } finally {
    await w.close();
  }
});

test('someone who deliberately types flagsmith gets the Flagsmith questions and keeps Flagsmith', async () => {
  const w = await world();
  try {
    await w.setup(`acme/features\n${w.gh.token}\n\n`);
    const r = await w.setup('\nflagsmith\n\nnone\n\n', ['--extras']);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /Flagsmith API key/);
    assert.doesNotMatch(r.stdout, /Statsig Console API key/);
    assert.equal(w.config().flagPlatform, 'flagsmith');
    assert.equal(w.config().flagPlatformSource, 'chosen');
    // Re-running setup without extras keeps that choice.
    const again = await w.setup('\n\n\n');
    assert.match(again.stdout, /Feature flags: Flagsmith \(your own choice; your team's default is Statsig\)/);
    assert.equal(w.config().flagPlatform, 'flagsmith');
  } finally {
    await w.close();
  }
});

// --- Home, end to end (real app and server against a fake GitHub and fake Statsig) -------------------

async function lifecycleOn(w, { config, statsigApiKey = w.st.apiKey, flagsmithApiKey = w.fs.apiKey } = {}) {
  const { createApp } = await import('../src/app.js');
  const { createServer } = await import('../src/server.js');
  const server = createServer(createApp({ alwaysLive: true, config, token: w.gh.token, flagsmithApiKey, statsigApiKey }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    snap: async () => (await fetch(`${url}/api/roadmap`)).json(),
    close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }),
  };
}
const freshHome = () => { process.env.LIFECYCLE_HOME = tmp('home'); return process.env.LIFECYCLE_HOME; };
const flagBanner = (snap) => (snap.flag_source?.state === 'problem' ? snap.flag_source : null);
const flagAccess = (snap) => snap.features.flatMap((f) => f.last_mile?.access_problems || []).filter((a) => a.source === 'statsig' || a.source === 'flagsmith');

test('Statsig configured and reachable: no flag warning on Home; Rewards points reads its gate from Statsig with link and read time', async () => {
  freshHome();
  const { startWorld, DATA } = await import('./last-mile-fixture.js');
  const w = await startWorld();
  w.gh.state.files.get(DATA).set('team.yaml', 'flag_platform: statsig\n');
  // No flag platform in the config at all: the team default applies.
  const config = { ...w.configFor('statsig'), flagPlatform: null };
  config.sources = { ...config.sources, flagsmith: { ...config.sources.flagsmith, projectId: null } };
  const lc = await lifecycleOn(w, { config });
  try {
    const snap = await lc.snap();
    assert.deepEqual(snap.flag_platform, { platform: 'statsig', from: 'team', team_default: 'statsig', name: 'Statsig' });
    assert.equal(snap.flag_source.state, 'ok');
    assert.equal(flagBanner(snap), null, 'no flag banner');
    assert.deepEqual(flagAccess(snap), [], 'no flag "Missing access"');
    assert.doesNotMatch(JSON.stringify(snap.features.map((f) => f.last_mile)), /Flagsmith/);
    const rewards = snap.features.find((f) => f.feature.id === 'rewards');
    assert.equal(rewards.last_mile.flag_platform, 'statsig');
    const prod = rewards.last_mile.flags[0].environments.production;
    assert.equal(prod.state, 'off');
    assert.equal(prod.link, `https://console.statsig.com/${w.st.company}/gates/rewards_enabled`);
    assert.ok(prod.last_successful_read_at, 'last read time');
    // The click-through to the source: the flag status opens the gate in Statsig, with its read time.
    const src = rewards.sources.find((t) => t.key === 'flag:rewards_enabled:production');
    assert.equal(src.source, 'statsig');
    assert.deepEqual(src.links.map((l) => l.url), [prod.link]);
    assert.ok(src.read_at, 'with its read time');
  } finally {
    await lc.close();
    await w.close();
  }
});

test('each Statsig failure: Home names Statsig, what is wrong and the fix, and never mentions Flagsmith', async () => {
  freshHome();
  const { startWorld } = await import('./last-mile-fixture.js');
  const w = await startWorld();
  const config = w.configFor('statsig');
  const check = async (key, before, expect) => {
    before();
    const lc = await lifecycleOn(w, { config, statsigApiKey: key });
    try {
      const snap = await lc.snap();
      const b = flagBanner(snap);
      assert.ok(b, `a flag banner for ${expect.reason}`);
      assert.equal(b.platform, 'statsig');
      assert.equal(b.name, 'Statsig');
      assert.equal(b.reason, expect.reason);
      assert.match(b.message, /Statsig/);
      assert.match(b.message, expect.fix);
      assert.doesNotMatch(JSON.stringify({ b, lm: snap.features.map((f) => f.last_mile) }), /Flagsmith/);
      assert.doesNotMatch(b.message, /HTTP 40\d/);
      if (key) assert.ok(!JSON.stringify(snap).includes(key), 'the key never reaches the browser');
      return b;
    } finally {
      await lc.close();
    }
  };
  try {
    // A good read first, so later failures can say when Statsig was last read.
    const ok = await lifecycleOn(w, { config });
    assert.equal((await ok.snap()).flag_source.state, 'ok');
    await ok.close();
    await check(null, () => {}, { reason: 'no_credential', fix: /Console API key.*console-.*https:\/\/console\.statsig\.com\/api_keys.*npm run setup -- --extras/ });
    await check(SECRET_KEY, () => {}, { reason: 'wrong_key_type', fix: /Server Secret key \(secret-…\).*only accepts a Console API key \(console-…\).*npm run setup -- --extras/ });
    await check('console-revoked-key-not-real', () => {}, { reason: 'rejected', fix: /refused your Console API key.*npm run setup -- --extras/ });
    // A server key without the usual prefix: Statsig itself says it's the wrong kind.
    w.st.state.serverKeys.add('legacyserverkey-not-real-0000');
    await check('legacyserverkey-not-real-0000', () => {}, { reason: 'wrong_key_type', fix: /only accepts a Console API key \(console-…\).*npm run setup -- --extras/ });
    const down = await check(w.st.apiKey, () => { w.st.state.down = true; }, { reason: 'unreachable', fix: /^Statsig could not be reached right now \(Statsig is having trouble: it answered with an error, HTTP 503\)\. LifeCycle tries again on the next Refresh/ });
    assert.ok(down.last_successful_read_at, 'unreachable: the last successful read time is shown');
    w.st.state.down = false;
    // No key in any log, cache or notice file under the LifeCycle home.
    const all = [];
    const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else all.push(fs.readFileSync(p, 'utf8')); } };
    walk(process.env.LIFECYCLE_HOME);
    assert.ok(all.length, 'logs were written');
    for (const k of [w.st.apiKey, SECRET_KEY, 'console-revoked-key-not-real']) assert.ok(!all.some((t) => t.includes(k)), `${k.slice(0, 7)}… is not on disk outside credentials`);
  } finally {
    await w.close();
  }
});

test('a config that silently defaulted to Flagsmith moves to Statsig with a one-time notice; a deliberate Flagsmith choice stays', async () => {
  const home = freshHome();
  const { startWorld, DATA } = await import('./last-mile-fixture.js');
  const { loadConfig } = await import('../src/config.js');
  const w = await startWorld();
  w.gh.state.files.get(DATA).set('team.yaml', 'flag_platform: statsig\n');
  const file = path.join(home, 'config.json');
  const legacy = { dataRepo: DATA, flagPlatform: 'flagsmith',
    sources: { github: { apiUrl: w.gh.url }, flagsmith: { apiUrl: w.fs.url, projectId: null }, statsig: { mcpUrl: w.st.url } } };
  try {
    fs.writeFileSync(file, JSON.stringify(legacy));
    let lc = await lifecycleOn(w, { config: loadConfig() });
    let snap = await lc.snap();
    assert.equal(snap.flag_platform.platform, 'statsig');
    assert.equal(snap.flag_source.state, 'ok', 'no Flagsmith warning: flags come from Statsig');
    assert.deepEqual(flagAccess(snap), []);
    assert.equal(snap.notices.length, 1);
    assert.match(snap.notices[0].title, /Feature flags are now read from Statsig/);
    assert.match(snap.notices[0].message, /team's flag platform.*Flagsmith/);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).flagPlatformSource, 'team');
    // Shown until dismissed, then never again (also after a restart).
    const seen = await fetch(`${lc.url}/api/notices/flagPlatformSwitched/seen`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    assert.equal(seen.status, 200);
    await lc.close();
    lc = await lifecycleOn(w, { config: loadConfig() });
    snap = await lc.snap();
    assert.deepEqual(snap.notices, []);
    assert.equal(snap.flag_platform.platform, 'statsig');
    await lc.close();

    // Deliberately Flagsmith (a project set up): nothing moves, flags still come from Flagsmith.
    fs.rmSync(path.join(home, 'notices.json'));
    fs.writeFileSync(file, JSON.stringify({ ...legacy, sources: { ...legacy.sources, flagsmith: { apiUrl: w.fs.url, projectId: w.fs.projectId } } }));
    lc = await lifecycleOn(w, { config: loadConfig() });
    snap = await lc.snap();
    assert.equal(snap.flag_platform.platform, 'flagsmith');
    assert.equal(snap.flag_platform.from, 'chosen');
    assert.deepEqual(snap.notices, []);
    assert.equal(snap.flag_source.state, 'ok');
    assert.equal(snap.features.find((f) => f.feature.id === 'rewards').last_mile.flag_platform, 'flagsmith');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).flagPlatform, 'flagsmith', 'the file is untouched');
    await lc.close();
  } finally {
    await w.close();
  }
});

test('Statsig experiments get the same key explanations as flags (no key, wrong kind of key)', async () => {
  freshHome();
  const { startWorld, DATA } = await import('./last-mile-fixture.js');
  const w = await startWorld();
  const files = w.gh.state.files.get(DATA);
  files.set('features/exp-only.yaml', 'id: exp-only\nname: Experiment only\nowner: Catalog team\nservices: [catalog-api]\nexperiments: [reader_test]\nsteps:\n  - { id: development, name: Development, owner: "@dev", done_when: merged, evidence: [{ source: github, type: pr, repo: team/catalog, number: 1 }] }\n');
  w.st.state.experiment('reader_test', { at: '2026-11-04T10:00:00Z', groups: [{ name: 'Control', size: 50 }, { name: 'A', size: 50 }] });
  try {
    for (const [key, expect] of [[null, /^No Statsig Console API key is set up on this machine, so LifeCycle can't read experiment "reader_test"\. Fix: .*npm run setup -- --extras/], [SECRET_KEY, /Server Secret key \(secret-…\).*only accepts a Console API key/]]) {
      const lc = await lifecycleOn(w, { config: w.configFor('statsig'), statsigApiKey: key });
      const lm = (await lc.snap()).features.find((f) => f.feature.id === 'exp-only').last_mile;
      await lc.close();
      const p = lm.access_problems.find((a) => a.source === 'statsig');
      assert.ok(p, 'the experiment names Statsig as the missing access');
      assert.match(p.message, expect);
      assert.doesNotMatch(p.message, /Flagsmith/);
    }
  } finally {
    await w.close();
  }
});

test('ramp reasons and digest entries read from Statsig name Statsig, never "flag console"', async () => {
  freshHome();
  const { startWorld } = await import('./last-mile-fixture.js');
  const { createApp } = await import('../src/app.js');
  const { buildDigest } = await import('../src/ask/digest.js');
  const w = await startWorld();
  try {
    const app = createApp({ alwaysLive: true, config: w.configFor('statsig'), token: w.gh.token, statsigApiKey: w.st.apiKey });
    let snap = await app.refresh({ live: true });
    // A flag the definition names but Statsig doesn't have: the ramp reason says where it looked.
    const ghost = snap.features.find((f) => f.feature.id === 'loyalty-tiers').ramp.reasons.find((r) => r.check === 'flags');
    assert.equal(ghost.message, 'Flag ghost_flag doesn\'t exist in Statsig.');
    // A flag that changed between two digests: its evidence is labelled with Statsig.
    const person = { owners: [], follows: ['rewards'] };
    const first = buildDigest({ snap, config: app.config, person, state: null });
    w.st.state.set('production', 'rewards_enabled', { enabled: true, at: '2026-11-05T09:00:00Z' });
    snap = await app.refresh({ live: true });
    const { digest } = buildDigest({ snap, config: app.config, person, state: first.nextState });
    const item = digest.features.find((f) => f.id === 'rewards').items.find((i) => i.kind === 'flag');
    assert.match(item.text, /^rewards_enabled in production: off → on/);
    assert.deepEqual(item.evidence.map((e) => e.label), ['rewards_enabled in production (Statsig)']);
    const everything = JSON.stringify([snap.features.map((f) => [f.ramp, f.sources]), digest]);
    assert.doesNotMatch(everything, /flag console/i);
  } finally {
    await w.close();
  }
});
