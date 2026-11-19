// Upgrade from the app: get the newest `main`, build it next to the running version, then swap it in
// and restart. Steps: download → unpack → libraries → restart. Until the restart the running version is
// never touched, so a failed download, unpack or library install just leaves it running; the restart
// itself is done by bin/apply-update.sh, which puts the previous version back if the new one doesn't
// answer. Only ~/.lifecycle/app changes: settings, credentials, cache, history and logs are kept.
// One upgrade at a time (in this process, and across the restart through a lock file).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { githubToken, loadConfig, paths, homeDir } from '../config.js';
import { registerSecret } from '../log.js';
import { installInfo, writeRecord, APP_ROOT, SOURCE_REPO, SOURCE_BRANCH } from './install.js';
import { logUpdate, explainFailure } from './check.js';

export const STEPS = [
  { id: 'download', label: 'Download the new version' },
  { id: 'unpack', label: 'Unpack it' },
  { id: 'libraries', label: 'Install its libraries' },
  { id: 'restart', label: 'Restart LifeCycle' },
];
const LOCK_MAX_MS = 15 * 60 * 1000;
const SHA = /^[0-9a-f]{40}$/;
const TERMINAL = '~/.lifecycle/bin/lifecycle update';

class StepError extends Error {
  constructor(step, message, fix) { super(message); this.step = step; this.fix = fix; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };

function run(cmd, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, out: err.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

export function createUpdater({
  appRoot = APP_ROOT, home = homeDir(), repo = SOURCE_REPO(), token, apiUrl, fetchImpl = fetch,
  nodeBin, npmCli, npmRegistry = process.env.LIFECYCLE_NPM_REGISTRY || 'https://registry.npmjs.org/',
  port, helperEnv = {},
} = {}) {
  const work = path.join(home, 'update');
  const lockFile = path.join(work, 'lock');
  const resultFile = path.join(work, 'result.json');
  const staging = path.join(work, 'staging');
  const node = nodeBin || path.join(home, 'runtime', 'node', 'bin', 'node');
  const npm = npmCli || path.join(path.dirname(path.dirname(node)), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  let current = null; // the upgrade running in this process: { from, to, step, started_at }

  function lockHeld() {
    const lock = readJson(lockFile);
    if (!lock) return false;
    const fresh = Date.now() - Date.parse(lock.started_at || 0) < LOCK_MAX_MS;
    if (fresh && lock.pid && alive(lock.pid)) return true;
    fs.rmSync(lockFile, { force: true }); // left by an upgrade that died
    return false;
  }

  function progress() {
    const lock = current ? null : readJson(lockFile);
    const running = Boolean(current) || lockHeld();
    return {
      running,
      steps: STEPS,
      step: current?.step || (running ? lock?.step || 'restart' : null),
      from: current?.from ?? null,
      to: current?.to ?? null,
      last: readJson(resultFile),
    };
  }

  function finish(result) {
    fs.mkdirSync(work, { recursive: true, mode: 0o700 });
    fs.writeFileSync(resultFile, JSON.stringify({ ...result, finished_at: new Date().toISOString() }, null, 2) + '\n');
    logUpdate({ action: 'upgrade', from: result.from, to: result.to, outcome: result.outcome, ...(result.step ? { step: result.step } : {}) });
  }

  async function steps(tok) {
    const api = apiUrl || loadConfig().sources.github.apiUrl;
    const headers = { authorization: `Bearer ${tok}`, accept: 'application/vnd.github+json', 'user-agent': 'lifecycle-local' };

    // 1. download: the exact newest commit of main, as GitHub's tarball of it.
    current.step = 'download';
    let to = current.to;
    let date = null;
    const tgz = path.join(work, 'lifecycle.tgz');
    try {
      const res = await fetchImpl(`${api}/repos/${repo}/commits/${SOURCE_BRANCH}`, { headers, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { kind: res.status === 401 || res.status === 403 || res.status === 404 ? 'no_access' : 'unreachable', status: res.status });
      const head = await res.json();
      to = current.to = head.sha;
      date = head.commit?.committer?.date || null;
      const tar = await fetchImpl(`${api}/repos/${repo}/tarball/${to}`, { headers, signal: AbortSignal.timeout(120000) });
      if (!tar.ok) throw Object.assign(new Error(`HTTP ${tar.status}`), { kind: tar.status === 401 || tar.status === 403 || tar.status === 404 ? 'no_access' : 'unreachable', status: tar.status });
      fs.writeFileSync(tgz, Buffer.from(await tar.arrayBuffer()));
    } catch (err) {
      const why = err.kind ? explainFailure(err, { repo, kind: 'installed' }) : explainFailure({ kind: 'unreachable', status: null }, { repo, kind: 'installed' });
      throw new StepError('download', `The new version could not be downloaded. ${why.message.replace(/, so LifeCycle couldn't check for updates\.$/, '.')}`, why.fix);
    }

    // 2. unpack into ~/.lifecycle/update/staging and record which commit it is.
    current.step = 'unpack';
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    const untar = await run('tar', ['-xzf', tgz, '-C', staging, '--strip-components', '1'], { timeoutMs: 60000 });
    fs.rmSync(tgz, { force: true });
    if (untar.code !== 0 || !['package.json', 'src/server.js', 'bin/lifecycle'].every((f) => fs.existsSync(path.join(staging, f)))) {
      throw new StepError('unpack', 'The downloaded version could not be unpacked, or it is not a complete copy of LifeCycle.', 'Check free disk space and try again.');
    }
    writeRecord(staging, { commit: to, date });

    // 3. libraries, with LifeCycle's private Node.js only (never another Node on this Mac).
    current.step = 'libraries';
    const env = {
      HOME: process.env.HOME, PATH: `${path.dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      npm_config_registry: npmRegistry, npm_config_fetch_retries: '1', npm_config_fetch_timeout: '20000',
      npm_config_update_notifier: 'false', ...(process.env.npm_config_cache ? { npm_config_cache: process.env.npm_config_cache } : {}),
    };
    const ci = await run(node, [npm, 'ci', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: staging, env, timeoutMs: 5 * 60 * 1000 });
    if (ci.code !== 0) {
      throw new StepError('libraries', "The new version's libraries could not be installed from the npm registry.",
        'Check your internet connection (a company VPN or network may block registry.npmjs.org), then try again.');
    }

    // 4. restart: handed to a detached helper, because restarting ends this process.
    current.step = 'restart';
    const helper = path.join(work, 'apply-update.sh');
    fs.copyFileSync(path.join(appRoot, 'bin', 'apply-update.sh'), helper);
    const log = fs.openSync(path.join(work, 'apply.log'), 'w');
    const child = spawn('/bin/bash', [helper, home, staging, to, String(port || loadConfig().port), current.from || ''], {
      detached: true, stdio: ['ignore', log, log], env: { ...process.env, ...helperEnv },
    });
    fs.closeSync(log);
    child.unref();
    return child;
  }

  // Starts an upgrade; resolves at once with { status, body }. The work goes on in the background.
  function start() {
    const install = installInfo({ appRoot, home });
    if (install.kind === 'developer') {
      return { status: 409, body: { started: false, reason: 'developer', message: 'This is a git working copy, so LifeCycle does not update it. Get the changes with:', command: 'git pull origin main && npm install' } };
    }
    if (install.kind !== 'installed') {
      return { status: 409, body: { started: false, reason: 'not_installed', message: 'This copy of LifeCycle was not installed with the Mac installer, so it can\'t update itself.', command: 'bash <unzipped LifeCycle folder>/install.sh' } };
    }
    if (current || lockHeld()) return { status: 409, body: { started: false, reason: 'already_updating', message: 'LifeCycle is already updating. Wait for it to finish.' } };
    const tok = token === undefined ? githubToken() : token;
    if (!tok) {
      const why = explainFailure({ reason: 'not_connected' }, { repo, kind: install.kind });
      return { status: 409, body: { started: false, reason: 'not_connected', message: why.message, fix: why.fix } };
    }
    registerSecret(tok);
    current = { from: install.commit, to: null, step: 'download', started_at: new Date().toISOString() };
    fs.mkdirSync(work, { recursive: true, mode: 0o700 });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, started_at: current.started_at, step: 'download' }) + '\n');
    fs.rmSync(resultFile, { force: true });
    const job = steps(tok).then((child) => {
      // The helper took over the lock (it rewrites it with its own pid); this process may now be restarted.
      current = null;
      return child;
    }, (err) => {
      const step = err.step || current.step;
      fs.rmSync(staging, { recursive: true, force: true });
      fs.rmSync(path.join(work, 'lifecycle.tgz'), { force: true });
      finish({ outcome: 'failed', step, from: current.from, to: current.to, message: `${err.message} Your current version was kept and is still running.`, fix: err.fix || `Try again, or update in Terminal: ${TERMINAL}` });
      fs.rmSync(lockFile, { force: true });
      current = null;
      return null;
    });
    return { status: 202, body: { started: true, steps: STEPS, from: install.commit }, job };
  }

  return { start, progress, lockHeld };
}
