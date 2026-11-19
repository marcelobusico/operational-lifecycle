// Check for updates and upgrade from the app (src/update/, bin/apply-update.sh), with no network: a
// fake GitHub serves main's history and tarballs, the npm registry is an address that refuses
// connections, and the restart is a stand-in command instead of launchctl.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGithub } from './fake-github.js';
import { checkForUpdate } from '../src/update/check.js';
import { createUpdater } from '../src/update/upgrade.js';
import { createServer, createUpdateService } from '../src/server.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'acme/lifecycle';
const BLOCKED = 'http://127.0.0.1:9';
const NPM_CLI = path.join(fs.realpathSync(process.execPath), '..', '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `lc-upd-${name}-`));
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');
const A = sha('a'), B = sha('b'), C = sha('c');
const HISTORY = [
  { sha: A, message: 'First version', date: '2026-11-01T10:00:00Z' },
  { sha: B, message: 'Fix the roadmap colours\n\nlonger body', date: '2026-11-03T10:00:00Z' },
  { sha: C, message: 'Add the update button', date: '2026-11-05T10:00:00Z' },
];

// A tiny LifeCycle: what an upgrade checks for, plus a marker saying which version it is.
function writeApp(dir, { version, deps = false }) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  const pkg = { name: 'lifecycle', version: '0.1.0', private: true, ...(deps ? { dependencies: { 'left-pad': '1.3.0' } } : {}) };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  const lock = { name: 'lifecycle', version: '0.1.0', lockfileVersion: 3, requires: true, packages: { '': pkg } };
  if (deps) lock.packages['node_modules/left-pad'] = { version: '1.3.0', resolved: `${BLOCKED}/left-pad/-/left-pad-1.3.0.tgz`, integrity: 'sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQEM5UGxWrMXhMQnIGWtXhMgTSSeRGfKp9U5Gv1PvA2jrLgGx' };
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock));
  fs.writeFileSync(path.join(dir, 'src', 'server.js'), '// stand-in\n');
  fs.writeFileSync(path.join(dir, 'bin', 'lifecycle'), '#!/bin/bash\n');
  fs.copyFileSync(path.join(ROOT, 'bin', 'apply-update.sh'), path.join(dir, 'bin', 'apply-update.sh'));
  fs.writeFileSync(path.join(dir, 'VERSION_MARKER'), version);
}

function tarballOf(version, { deps = false } = {}) {
  const work = tmp('tar');
  const top = path.join(work, `acme-lifecycle-${version}`);
  writeApp(top, { version, deps });
  execFileSync('tar', ['-czf', path.join(work, 'x.tgz'), '-C', work, path.basename(top)]);
  return fs.readFileSync(path.join(work, 'x.tgz'));
}

// An installed LifeCycle home: ~/.lifecycle with app/, settings and credentials.
function makeInstall({ commit = A } = {}) {
  const home = tmp('home');
  writeApp(path.join(home, 'app'), { version: 'old' });
  if (commit) fs.writeFileSync(path.join(home, 'app', 'installed-commit.json'), JSON.stringify({ commit, date: HISTORY.find((h) => h.sha === commit)?.date }));
  fs.writeFileSync(path.join(home, 'config.json'), '{\n  "dataRepo": "acme/features"\n}\n');
  fs.writeFileSync(path.join(home, 'credentials.json'), '{"github":{"token":"keep-me"}}\n', { mode: 0o600 });
  fs.mkdirSync(path.join(home, 'history'));
  fs.writeFileSync(path.join(home, 'history', 'h.json'), '[]');
  process.env.LIFECYCLE_HOME = home;
  return { home, app: path.join(home, 'app') };
}

let gh;
beforeEach(async () => {
  await gh?.close();
  gh = await startFakeGithub();
  gh.state.readable.add(REPO);
  gh.state.history.set(REPO, HISTORY.slice());
  gh.state.tarballs.set(`${REPO}@${C}`, tarballOf('new'));
});
after(() => gh?.close());

const opts = (inst, extra = {}) => ({ appRoot: inst.app, home: inst.home, repo: REPO, token: gh.token, apiUrl: gh.url, ...extra });
const logLines = (home) => fs.readFileSync(path.join(home, 'logs', 'updates.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
async function waitFor(fn, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 200)); }
  throw new Error('timed out');
}
const readResult = (home) => { try { return JSON.parse(fs.readFileSync(path.join(home, 'update', 'result.json'), 'utf8')); } catch { return null; } };

// --- the check --------------------------------------------------------------------------------

test('installed commit equals the newest main commit: up to date, with that commit and its date', async () => {
  gh.state.history.set(REPO, HISTORY.slice(0, 1));
  const inst = makeInstall({ commit: A });
  const r = await checkForUpdate(opts(inst));
  assert.equal(r.state, 'up_to_date');
  assert.equal(r.install.commit, A);
  assert.equal(r.install.date, HISTORY[0].date);
  assert.equal(r.can_upgrade, true);
});

test('two commits pushed after the install: 2 updates available, both titles, the compare link and the CI state', async () => {
  gh.state.runs.set(`${REPO}@${C}`, [{ name: 'CI', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/acme/lifecycle/actions/runs/1' }]);
  const inst = makeInstall({ commit: A });
  const r = await checkForUpdate(opts(inst));
  assert.equal(r.state, 'update_available');
  assert.equal(r.behind, 2);
  assert.deepEqual(r.commits.map((c) => c.title), ['Add the update button', 'Fix the roadmap colours']);
  assert.equal(r.latest.date, HISTORY[2].date);
  assert.equal(r.compare_url, `https://github.com/${REPO}/compare/${A}...${C}`);
  assert.equal(r.ci.state, 'failed');
  gh.state.runs.set(`${REPO}@${C}`, [{ name: 'CI', status: 'in_progress', conclusion: null }]);
  assert.equal((await checkForUpdate(opts(inst))).ci.state, 'running');
});

test('an install with no recorded commit: "Installed version unknown", with the upgrade offered', async () => {
  const inst = makeInstall({ commit: null });
  const r = await checkForUpdate(opts(inst));
  assert.equal(r.state, 'unknown_version');
  assert.equal(r.install.commit, null);
  assert.equal(r.latest.commit, C);
  assert.equal(r.can_upgrade, true);
});

test('offline: says GitHub can\'t be reached and never "up to date"', async () => {
  const inst = makeInstall();
  const r = await checkForUpdate(opts(inst, { apiUrl: BLOCKED }));
  assert.equal(r.ok, false);
  assert.notEqual(r.state, 'up_to_date');
  assert.equal(r.error.reason, 'offline');
  assert.match(r.error.message, /GitHub can't be reached/);
  assert.match(r.error.fix, /internet/);
});

test('no access to the LifeCycle repo, rejected access and GitHub not connected each name the cause and the fix', async () => {
  const inst = makeInstall();
  gh.state.readable.delete(REPO);
  const noAccess = await checkForUpdate(opts(inst));
  assert.equal(noAccess.error.reason, 'no_access');
  assert.match(noAccess.error.message, /can't read the LifeCycle repo \(acme\/lifecycle\)/);
  const rejected = await checkForUpdate(opts(inst, { token: 'expired-not-a-real-credential' }));
  assert.equal(rejected.error.reason, 'rejected');
  const none = await checkForUpdate(opts(inst, { token: null }));
  assert.equal(none.error.reason, 'not_connected');
  assert.match(none.error.fix, /lifecycle setup/);
  for (const r of [noAccess, rejected, none]) assert.equal(r.state, 'error');
});

test('a git working copy gets the check and the pull command, never the upgrade, and is left unchanged', async () => {
  const dev = tmp('dev');
  writeApp(dev, { version: 'dev' });
  const git = (...a) => execFileSync('git', ['-C', dev, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'dev');
  const home = tmp('devhome');
  process.env.LIFECYCLE_HOME = home;
  const r = await checkForUpdate({ appRoot: dev, home, repo: REPO, token: gh.token, apiUrl: gh.url });
  assert.equal(r.install.kind, 'developer');
  assert.equal(r.install.commit, git('rev-parse', 'HEAD'));
  assert.equal(r.can_upgrade, false);
  assert.equal(r.pull_command, 'git pull origin main && npm install');
  const before = git('status', '--porcelain');
  const s = createUpdater({ appRoot: dev, home, repo: REPO, token: gh.token, apiUrl: gh.url }).start();
  assert.equal(s.status, 409);
  assert.equal(s.body.reason, 'developer');
  assert.equal(git('status', '--porcelain'), before);
  assert.ok(!fs.existsSync(path.join(home, 'update')));
});

// --- the upgrade ------------------------------------------------------------------------------

// A stand-in for the LaunchAgent restart: serves /api/update/version from the app folder's record.
function fakeService(port, inst) {
  const script = path.join(inst.home, 'service.mjs');
  fs.writeFileSync(script, `import http from 'node:http'; import fs from 'node:fs';
http.createServer((q, s) => { let c = null; try { c = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(inst.app, 'installed-commit.json'))}, 'utf8')).commit; } catch {}
  s.end(JSON.stringify({ kind: 'installed', commit: c }, null, 2)); }).listen(${port}, '127.0.0.1');
setTimeout(() => process.exit(0), 20000);\n`);
  return `"${process.execPath}" "${script}" >/dev/null 2>&1 & echo $! > "${path.join(inst.home, 'service.pid')}"`;
}
const stopService = (inst) => { try { process.kill(Number(fs.readFileSync(path.join(inst.home, 'service.pid'), 'utf8'))); } catch { /* not started */ } };

test('a confirmed upgrade installs the newest main, records it, keeps settings byte-identical, and the next check is up to date', { timeout: 60000 }, async () => {
  const inst = makeInstall({ commit: A });
  const settings = ['config.json', 'credentials.json', 'history/h.json'].map((f) => fs.readFileSync(path.join(inst.home, f)));
  const port = await freePort();
  const updater = createUpdater(opts(inst, { nodeBin: process.execPath, npmCli: NPM_CLI, npmRegistry: BLOCKED, port, helperEnv: { LIFECYCLE_RESTART_CMD: fakeService(port, inst), LIFECYCLE_HEALTH_SECONDS: '10' } }));
  try {
    const s = updater.start();
    assert.equal(s.status, 202);
    await s.job;
    const result = await waitFor(() => readResult(inst.home));
    assert.equal(result.outcome, 'ok', JSON.stringify(result));
    assert.equal(fs.readFileSync(path.join(inst.app, 'VERSION_MARKER'), 'utf8'), 'new');
    assert.equal(JSON.parse(fs.readFileSync(path.join(inst.app, 'installed-commit.json'), 'utf8')).commit, C);
    ['config.json', 'credentials.json', 'history/h.json'].forEach((f, i) => assert.deepEqual(fs.readFileSync(path.join(inst.home, f)), settings[i], `${f} changed`));
    assert.ok(!fs.existsSync(path.join(inst.home, 'update', 'previous')));
    await waitFor(() => !fs.existsSync(path.join(inst.home, 'update', 'lock')), 5000);
    assert.equal((await checkForUpdate(opts(inst))).state, 'up_to_date');
    const lines = logLines(inst.home);
    const up = lines.filter((l) => l.action === 'upgrade');
    assert.equal(up.length, 1);
    assert.deepEqual([up[0].from, up[0].to, up[0].outcome], [A, C, 'ok']);
    assert.ok(lines.some((l) => l.action === 'check' && l.from === C && l.outcome === 'up_to_date'));
    assert.doesNotMatch(fs.readFileSync(path.join(inst.home, 'logs', 'updates.log'), 'utf8'), new RegExp(gh.token));
  } finally {
    stopService(inst);
  }
});

test('the libraries step fails: the previous version stays, the failed step is named, and a new check still shows the old commit', { timeout: 60000 }, async () => {
  gh.state.tarballs.set(`${REPO}@${C}`, tarballOf('new', { deps: true }));
  const inst = makeInstall({ commit: A });
  const updater = createUpdater(opts(inst, { nodeBin: process.execPath, npmCli: NPM_CLI, npmRegistry: BLOCKED, helperEnv: { LIFECYCLE_RESTART_CMD: 'exit 1' } }));
  const s = updater.start();
  assert.equal(s.status, 202);
  await s.job;
  const result = readResult(inst.home);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.step, 'libraries');
  assert.match(result.message, /libraries could not be installed.*current version was kept/);
  assert.match(result.fix, /registry\.npmjs\.org/);
  assert.equal(fs.readFileSync(path.join(inst.app, 'VERSION_MARKER'), 'utf8'), 'old');
  assert.ok(!fs.existsSync(path.join(inst.home, 'update', 'staging')));
  assert.equal(updater.progress().running, false);
  const again = await checkForUpdate(opts(inst));
  assert.equal(again.install.commit, A);
  assert.equal(again.state, 'update_available');
  const up = logLines(inst.home).filter((l) => l.action === 'upgrade');
  assert.deepEqual([up.length, up[0].from, up[0].to, up[0].outcome, up[0].step], [1, A, C, 'failed', 'libraries']);
});

test('the new version does not come up after the restart: the previous version is put back and restarted', { timeout: 60000 }, async () => {
  const inst = makeInstall({ commit: A });
  const port = await freePort();
  const restarts = path.join(inst.home, 'restarts');
  const updater = createUpdater(opts(inst, { nodeBin: process.execPath, npmCli: NPM_CLI, npmRegistry: BLOCKED, port, helperEnv: { LIFECYCLE_RESTART_CMD: `echo x >> "${restarts}"`, LIFECYCLE_HEALTH_SECONDS: '2' } }));
  const s = updater.start();
  await s.job;
  assert.equal(updater.start().body.reason, 'already_updating', 'the helper holds the lock through the restart');
  const result = await waitFor(() => readResult(inst.home));
  assert.equal(result.outcome, 'failed');
  assert.equal(result.step, 'restart');
  assert.match(result.message, /went back to the version you had/);
  assert.equal(fs.readFileSync(path.join(inst.app, 'VERSION_MARKER'), 'utf8'), 'old');
  assert.equal(JSON.parse(fs.readFileSync(path.join(inst.app, 'installed-commit.json'), 'utf8')).commit, A);
  assert.equal(fs.readFileSync(restarts, 'utf8').trim().split('\n').length, 2, 'restarted the new version, then the previous one');
  await waitFor(() => !fs.existsSync(path.join(inst.home, 'update', 'lock')), 5000); // the helper's last act
});

// --- the server: one at a time, and only from LifeCycle's own page -----------------------------

async function startServer(inst, extra = {}) {
  const update = createUpdateService(opts(inst, { nodeBin: process.execPath, npmCli: NPM_CLI, npmRegistry: BLOCKED, ...extra }));
  const server = createServer({}, {}, update);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) };
}
const post = (base, headers = {}) => fetch(`${base}/api/update/upgrade`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: '{}' });

test('two upgrade requests at the same time start exactly one upgrade; the other gets "already updating"', { timeout: 60000 }, async () => {
  gh.state.tarballs.delete(`${REPO}@${C}`); // the upgrade that starts ends quickly, at the download step
  const inst = makeInstall({ commit: A });
  const srv = await startServer(inst);
  try {
    const answers = await Promise.all([post(srv.base), post(srv.base)]);
    const codes = answers.map((r) => r.status).sort();
    assert.deepEqual(codes, [202, 409]);
    const busy = await answers.find((r) => r.status === 409).json();
    assert.equal(busy.reason, 'already_updating');
    assert.match(busy.message, /already updating/);
    await waitFor(() => readResult(inst.home));
    assert.equal(gh.state.requests.filter((q) => q.url.includes('/tarball/')).length, 1);
    assert.equal(logLines(inst.home).filter((l) => l.action === 'upgrade').length, 1);
  } finally {
    await srv.close();
  }
});

test('an upgrade request from another site, without an Origin, or through a non-local host name is refused and nothing changes on disk', async () => {
  const inst = makeInstall({ commit: A });
  const before = execFileSync('ls', ['-laR', inst.home], { encoding: 'utf8' });
  const srv = await startServer(inst);
  try {
    for (const headers of [{ origin: 'https://evil.example' }, { origin: '' }]) {
      const r = await post(srv.base, headers);
      assert.equal(r.status, 403, JSON.stringify(headers));
      assert.match((await r.json()).error, /only be started from LifeCycle's own page/);
    }
    // A site whose name points at 127.0.0.1 (DNS rebinding): its Origin matches its Host, but the host isn't local.
    const rebound = await new Promise((resolve, reject) => {
      const u = new URL(srv.base);
      const q = http.request({ host: u.hostname, port: u.port, path: '/api/update/upgrade', method: 'POST',
        headers: { host: `evil.example:${u.port}`, origin: `http://evil.example:${u.port}`, 'content-type': 'application/json' } }, (res) => resolve(res.statusCode));
      q.on('error', reject);
      q.end('{}');
    });
    assert.equal(rebound, 403);
    assert.equal(execFileSync('ls', ['-laR', inst.home], { encoding: 'utf8' }), before);
    assert.equal(gh.state.requests.length, 0);
  } finally {
    await srv.close();
  }
});
