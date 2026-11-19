// The Mac installer (install.sh) and first-run setup (src/cli/setup.js), with no network: a local
// stand-in for nodejs.org serves a tiny "Node.js" that wraps the Node running these tests, and the
// npm registry is an address that refuses connections. See docs/install-mac.md.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGithub } from './fake-github.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const mac = process.platform === 'darwin';
const BLOCKED = 'http://127.0.0.1:9'; // nothing listens on the discard port: connection refused
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `lc-${name}-`));

function run(cmd, args, { env, input = '' } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, cwd: ROOT });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr, all: stdout + stderr }));
    child.stdin.end(input);
  });
}

// A local "nodejs.org/dist/latest-v24.x": SHASUMS256.txt plus a node-<version>-darwin-<arch>.tar.gz
// whose bin/node runs the Node running this test, and whose npm is that Node's npm.
let dist;
before(async () => {
  if (!mac) return;
  const arch = execFileSync('sysctl', ['-n', 'hw.optional.arm64'], { encoding: 'utf8' }).trim() === '1' ? 'arm64' : 'x64';
  const name = `node-${process.version}-darwin-${arch}`;
  const work = tmp('dist');
  const pkg = path.join(work, name);
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(pkg, 'lib', 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'bin', 'node'), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  const realNpm = path.join(fs.realpathSync(process.execPath), '..', '..', 'lib', 'node_modules', 'npm');
  fs.symlinkSync(realNpm, path.join(pkg, 'lib', 'node_modules', 'npm'));
  const file = `${name}.tar.gz`;
  execFileSync('tar', ['-czf', path.join(work, file), '-C', work, name]);
  const tarball = fs.readFileSync(path.join(work, file));
  const sha = crypto.createHash('sha256').update(tarball).digest('hex');
  dist = { file, sha, sums: `${sha}  ${file}\n`, requests: [] };
  dist.server = http.createServer((req, res) => {
    dist.requests.push(req.url);
    if (req.url === '/SHASUMS256.txt') return res.end(dist.sums);
    if (req.url === `/${file}`) return res.end(tarball);
    res.writeHead(404).end();
  });
  await new Promise((r) => dist.server.listen(0, '127.0.0.1', r));
  dist.url = `http://127.0.0.1:${dist.server.address().port}`;
});
after(() => dist?.server.close());

function installEnv(home, extra = {}) {
  return {
    HOME: home, // nothing outside the temp home is written (LaunchAgents, Applications)
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LIFECYCLE_HOME: path.join(home, '.lifecycle'),
    LIFECYCLE_NODE_DIST: dist?.url,
    LIFECYCLE_NPM_REGISTRY: BLOCKED,
    LIFECYCLE_NO_SETUP: '1', LIFECYCLE_NO_LAUNCHD: '1', LIFECYCLE_NO_OPEN: '1',
    npm_config_cache: path.join(home, 'npm-cache'), // no help from a warm npm cache
    ...extra,
  };
}

test('with the Node.js download site unreachable, install stops naming the step, what went wrong and the fix', { skip: !mac }, async () => {
  const home = tmp('home');
  const r = await run('bash', ['install.sh'], { env: installEnv(home, { LIFECYCLE_NODE_DIST: BLOCKED }) });
  assert.equal(r.status, 1, r.all);
  assert.match(r.stdout, /✓ macOS .* on (Apple Silicon|Intel)/);
  assert.match(r.stderr, /✗ Step 3 of 6 \(Get Node\.js .*\) did not work\./);
  assert.match(r.stderr, /What went wrong: Could not reach the Node\.js download site/);
  assert.match(r.stderr, /What to do: Check that you are connected to the internet.*nodejs\.org/);
  assert.match(r.stderr, /Nothing outside LifeCycle.s own folder .* was changed\. When it is fixed, run the same install command again/);
  assert.ok(!fs.existsSync(path.join(home, '.lifecycle', 'runtime')), 'no half-installed Node.js is left behind');
});

test('a Node.js download that does not match the official checksum is refused', { skip: !mac }, async () => {
  const home = tmp('home');
  const original = dist.sums;
  dist.sums = `${'0'.repeat(64)}  ${dist.file}\n`;
  try {
    const r = await run('bash', ['install.sh'], { env: installEnv(home) });
    assert.equal(r.status, 1, r.all);
    assert.match(r.stderr, /Step 3 of 6 .*did not work[\s\S]*checksum does not match/);
    assert.ok(!fs.existsSync(path.join(home, '.lifecycle', 'runtime', 'node')));
  } finally {
    dist.sums = original;
  }
});

test('with the npm registry unreachable, install stops at the libraries step naming that registry', { skip: !mac, timeout: 120000 }, async () => {
  const home = tmp('home');
  const r = await run('bash', ['install.sh'], { env: installEnv(home) });
  assert.equal(r.status, 1, r.all);
  assert.match(r.stdout, /✓ Node\.js v[\d.]+ installed/);
  assert.match(r.stderr, /✗ Step 4 of 6 \(Install LifeCycle's libraries\) did not work\./);
  assert.match(r.stderr, /from the npm registry \(http:\/\/127\.0\.0\.1:9\)[\s\S]*What to do: .*ask IT to allow 127\.0\.0\.1:9\./);
});

test('an older Node.js already on the PATH is never used or changed; LifeCycle gets its own private copy', { skip: !mac, timeout: 120000 }, async () => {
  const home = tmp('home');
  const userBin = path.join(home, 'old-node', 'bin');
  fs.mkdirSync(userBin, { recursive: true });
  const marker = path.join(home, 'old-node-was-run');
  const oldNode = `#!/bin/sh\ntouch "${marker}"\necho v18.20.8\n`;
  fs.writeFileSync(path.join(userBin, 'node'), oldNode, { mode: 0o755 });
  fs.writeFileSync(path.join(userBin, 'npm'), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
  const env = installEnv(home, { PATH: `${userBin}:/usr/bin:/bin:/usr/sbin:/sbin` });
  const r = await run('bash', ['install.sh'], { env });
  // Step 4 fails only because the registry is blocked in this test; what matters is which Node ran.
  assert.match(r.stdout, /✓ Node\.js v[\d.]+ installed in .*runtime\/node \(your PATH and any other Node\.js are untouched\)/, r.all);
  assert.match(r.all, /Step 4 of 6/);
  assert.ok(!fs.existsSync(marker), 'the installer ran the Node.js or npm already on the PATH');
  assert.equal(fs.readFileSync(path.join(userBin, 'node'), 'utf8'), oldNode);
  assert.equal(execFileSync('sh', ['-c', 'node -v'], { env, encoding: 'utf8' }).trim(), 'v18.20.8');
  for (const rc of ['.zshrc', '.zprofile', '.bash_profile', '.profile']) assert.ok(!fs.existsSync(path.join(home, rc)), `${rc} was written`);
});

test('LIFECYCLE_NODE=system uses the Node.js and npm on the PATH, downloads nothing, and updates keep that choice', { skip: !mac, timeout: 180000 }, async () => {
  const home = tmp('home');
  const lc = path.join(home, '.lifecycle');
  // A wrapper on the PATH, like a version manager's shim: the real node file is what gets saved.
  const userBin = path.join(home, 'my-node', 'bin');
  fs.mkdirSync(userBin, { recursive: true });
  fs.writeFileSync(path.join(userBin, 'node'), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  const env = installEnv(home, { PATH: `${userBin}:/usr/bin:/bin:/usr/sbin:/sbin`, LIFECYCLE_NODE: 'system' });
  dist.requests.length = 0;
  const r = await run('bash', ['install.sh'], { env });
  // Step 4 fails only because the registry is blocked in this test.
  assert.match(r.stdout, /Step 3 of 6: Use your own Node\.js/, r.all);
  assert.match(r.stdout, new RegExp(`✓ Using your Node\\.js ${process.version.replace(/\./g, '\\.')} at .* with its npm \\(nothing downloaded\\)`), r.all);
  assert.match(r.stderr, /✗ Step 4 of 6 \(Install LifeCycle's libraries\)/);
  assert.deepEqual(dist.requests, [], 'nodejs.org was contacted');
  assert.ok(!fs.existsSync(path.join(lc, 'runtime')), 'a private Node.js was installed');
  assert.equal(fs.readFileSync(path.join(lc, 'node-path'), 'utf8').trim(), process.execPath);
  const status = await run('bash', [path.join(lc, 'bin', 'lifecycle'), 'status'], { env: { HOME: home, PATH: '/usr/bin:/bin', LIFECYCLE_HOME: lc, LIFECYCLE_PORT: '9' } });
  assert.match(status.stdout, /Node\.js v[\d.]+ \(yours, at /, status.all);
  // An update (no LIFECYCLE_NODE) keeps using it.
  const again = await run('bash', ['install.sh'], { env: { ...env, LIFECYCLE_NODE: '' } });
  assert.match(again.stdout, /✓ Using your Node\.js/, again.all);
  assert.deepEqual(dist.requests, []);
  // LIFECYCLE_NODE=private goes back to the private copy.
  const back = await run('bash', ['install.sh'], { env: { ...env, LIFECYCLE_NODE: 'private' } });
  assert.match(back.stdout, /✓ Node\.js v[\d.]+ installed in .*runtime\/node/, back.all);
  assert.ok(!fs.existsSync(path.join(lc, 'node-path')));
  // Switching to your own Node.js again, with the install failing later (registry blocked): the private
  // copy stays, since the service may still run on it until an install finishes.
  const fails = await run('bash', ['install.sh'], { env });
  assert.match(fails.stderr, /Step 4 of 6/, fails.all);
  assert.ok(fs.existsSync(path.join(lc, 'runtime', 'node', 'bin', 'node')), 'the private copy was removed before the install finished');
  // Your Node.js removed later: the command says how to pick another, with the installer that is already there.
  fs.writeFileSync(path.join(lc, 'node-path'), path.join(home, 'removed', 'bin', 'node') + '\n');
  const gone = await run('bash', [path.join(lc, 'bin', 'lifecycle'), 'setup'], { env: { HOME: home, PATH: '/usr/bin:/bin', LIFECYCLE_HOME: lc } });
  assert.equal(gone.status, 1);
  assert.match(gone.stderr, /The Node\.js LifeCycle was set to use is gone[\s\S]*LIFECYCLE_NODE=system bash .*app\/install\.sh/, gone.all);
});

test('LIFECYCLE_NODE refuses a Node.js older than 20, and one that is missing', { skip: !mac, timeout: 60000 }, async () => {
  const home = tmp('home');
  const userBin = path.join(home, 'old-node', 'bin');
  fs.mkdirSync(userBin, { recursive: true });
  fs.writeFileSync(path.join(userBin, 'node'), '#!/bin/sh\ncase "$1" in -v) echo v18.20.8 ;; *) echo /x/bin/node ;; esac\n', { mode: 0o755 });
  const old = await run('bash', ['install.sh'], { env: installEnv(home, { PATH: `${userBin}:/usr/bin:/bin:/usr/sbin:/sbin`, LIFECYCLE_NODE: 'system' }) });
  assert.equal(old.status, 1, old.all);
  assert.match(old.stderr, /Step 3 of 6 \(Use your own Node\.js\)[\s\S]*is v18\.20\.8, and LifeCycle needs 20 or newer/);
  assert.ok(!fs.existsSync(path.join(home, '.lifecycle', 'node-path')));
  const gone = await run('bash', ['install.sh'], { env: installEnv(home, { LIFECYCLE_NODE: path.join(home, 'nope', 'node') }) });
  assert.equal(gone.status, 1);
  assert.match(gone.stderr, /There is no Node\.js at .*nope\/node/);
  const none = await run('bash', ['install.sh'], { env: installEnv(home, { LIFECYCLE_NODE: 'system' }) });
  assert.match(none.stderr, /there is no 'node' on your PATH/);
});

// A stand-in npm registry that answers 404 to everything and records what it was asked.
async function fakeRegistry({ tls } = {}) {
  const reg = { requests: [] };
  const handler = (req, res) => { reg.requests.push(req.url); res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}'); };
  reg.server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  await new Promise((r) => reg.server.listen(0, '127.0.0.1', r));
  reg.url = `${tls ? 'https' : 'http'}://127.0.0.1:${reg.server.address().port}/`;
  return reg;
}
// The test's own Node.js, used as "your Node.js" so nothing is downloaded.
function ownNodeEnv(home, extra = {}) {
  const userBin = path.join(home, 'my-node', 'bin');
  fs.mkdirSync(userBin, { recursive: true });
  fs.writeFileSync(path.join(userBin, 'node'), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  const env = installEnv(home, { PATH: `${userBin}:/usr/bin:/bin:/usr/sbin:/sbin`, LIFECYCLE_NODE: 'system', ...extra });
  delete env.LIFECYCLE_NPM_REGISTRY;
  return env;
}

test('npm uses the registry from the person\'s ~/.npmrc, and a failure names that registry', { skip: !mac, timeout: 120000 }, async () => {
  const reg = await fakeRegistry();
  try {
    const home = tmp('home');
    fs.writeFileSync(path.join(home, '.npmrc'), `registry=${reg.url}\n`);
    const r = await run('bash', ['install.sh'], { env: ownNodeEnv(home) });
    assert.match(r.stdout, new RegExp(`Using your npm registry: ${reg.url}`), r.all);
    assert.ok(reg.requests.length > 0, 'npm never asked the registry from ~/.npmrc');
    assert.match(r.stderr, new RegExp(`Step 4 of 6[\\s\\S]*from the npm registry \\(${reg.url}\\)`), r.all);
    assert.match(r.stderr, /What to do: Check that you are connected .*127\.0\.0\.1:\d+\./);
  } finally {
    reg.server.close();
  }
});

let cert = null;
try {
  const dir = tmp('cert');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=Test Proxy Root',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
  cert = { file: path.join(dir, 'cert.pem'), tls: { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) } };
} catch { /* no openssl: the certificate test is skipped */ }

test('a registry behind a self-signed certificate works with LIFECYCLE_CA_FILE, which is saved and kept on update', { skip: !mac || !cert, timeout: 180000 }, async () => {
  const reg = await fakeRegistry({ tls: cert.tls });
  try {
    const home = tmp('home');
    const lc = path.join(home, '.lifecycle');
    fs.writeFileSync(path.join(home, '.npmrc'), `registry=${reg.url}\n`);
    // Without the certificate: the TLS check fails, nothing reaches the registry, the fix says what to ask IT for.
    const no = await run('bash', ['install.sh'], { env: ownNodeEnv(home) });
    assert.equal(no.status, 1, no.all);
    assert.equal(reg.requests.length, 0);
    assert.match(no.stderr, /What to do: Your network seems to re-sign HTTPS with its own certificate.*LIFECYCLE_CA_FILE=/, no.all);
    // With it: npm talks to the registry (which then answers 404 in this test).
    const yes = await run('bash', ['install.sh'], { env: ownNodeEnv(home, { LIFECYCLE_CA_FILE: cert.file }) });
    assert.match(yes.stdout, /✓ Your network's root certificate is trusted \(saved as .*ca\.pem\)/, yes.all);
    assert.ok(reg.requests.length > 0, 'npm did not reach the registry with the certificate');
    assert.equal(fs.readFileSync(path.join(lc, 'ca.pem'), 'utf8'), fs.readFileSync(cert.file, 'utf8'));
    const status = await run('bash', [path.join(lc, 'bin', 'lifecycle'), 'status'], { env: { HOME: home, PATH: '/usr/bin:/bin', LIFECYCLE_HOME: lc, LIFECYCLE_PORT: '9' } });
    assert.match(status.stdout, /Extra root certificate trusted: .*ca\.pem/);
    // An update without LIFECYCLE_CA_FILE keeps it; LIFECYCLE_CA_FILE=none removes it.
    const seen = reg.requests.length;
    const again = await run('bash', ['install.sh'], { env: ownNodeEnv(home) });
    assert.match(again.stdout, /root certificate is trusted/, again.all);
    assert.ok(reg.requests.length > seen);
    await run('bash', ['install.sh'], { env: ownNodeEnv(home, { LIFECYCLE_CA_FILE: 'none' }) });
    assert.ok(!fs.existsSync(path.join(lc, 'ca.pem')));
    // A file that is not a certificate is refused before anything is downloaded.
    const bad = path.join(home, 'not-a-cert.txt');
    fs.writeFileSync(bad, 'hello');
    const r = await run('bash', ['install.sh'], { env: ownNodeEnv(home, { LIFECYCLE_CA_FILE: bad }) });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Step 2 of 6[\s\S]*is missing or is not a PEM certificate/);
  } finally {
    reg.server.close();
  }
});

// A GitHub ZIP is `git archive` of main: .lifecycle-source comes filled in (export-subst).
function archiveOfThisCode(work) {
  const repo = path.join(work, 'repo');
  fs.mkdirSync(repo);
  execFileSync('sh', ['-c', `cd "${ROOT}" && tar --exclude ./node_modules --exclude ./.git -cf - . | (cd "${repo}" && tar -xf -)`]);
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'main');
  const zip = path.join(work, 'operational-lifecycle-main');
  fs.mkdirSync(zip);
  execFileSync('sh', ['-c', `git -C "${repo}" archive HEAD | tar -xf - -C "${zip}"`]);
  return { dir: zip, commit: git('rev-parse', 'HEAD'), date: git('log', '-1', '--format=%cI') };
}

test('a fresh install from a GitHub ZIP records the main commit it came from in the install folder', { skip: !mac, timeout: 120000 }, async () => {
  const home = tmp('home');
  const src = archiveOfThisCode(tmp('zip'));
  assert.match(fs.readFileSync(path.join(src.dir, '.lifecycle-source'), 'utf8'), new RegExp(`^${src.commit} `));
  // Stops at step 3 (Node.js download blocked): the commit is recorded in step 2, before it.
  const r = await run('bash', [path.join(src.dir, 'install.sh')], { env: installEnv(home, { LIFECYCLE_NODE_DIST: BLOCKED }) });
  assert.match(r.stdout, new RegExp(`LifeCycle's files are in .*\\(commit ${src.commit.slice(0, 7)} of main\\)`), r.all);
  const rec = JSON.parse(fs.readFileSync(path.join(home, '.lifecycle', 'app', 'installed-commit.json'), 'utf8'));
  assert.equal(rec.commit, src.commit);
  assert.equal(rec.date, src.date);
  // An update (`lifecycle update`, or the app's button) passes the commit it fetched.
  const next = 'a'.repeat(40);
  await run('bash', [path.join(src.dir, 'install.sh')], { env: installEnv(home, { LIFECYCLE_NODE_DIST: BLOCKED, LIFECYCLE_INSTALL_COMMIT: next, LIFECYCLE_INSTALL_COMMIT_DATE: '2026-11-05T10:00:00Z' }) });
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.lifecycle', 'app', 'installed-commit.json'), 'utf8')).commit, next);
});

test('a copy that does not say its commit installs with no record (shown as "Installed version unknown")', { skip: !mac, timeout: 120000 }, async () => {
  const home = tmp('home');
  const src = tmp('plain');
  execFileSync('sh', ['-c', `cd "${ROOT}" && tar --exclude ./node_modules --exclude ./.git -cf - . | (cd "${src}" && tar -xf -)`]);
  const r = await run('bash', [path.join(src, 'install.sh')], { env: installEnv(home, { LIFECYCLE_NODE_DIST: BLOCKED }) });
  assert.match(r.stdout, /Installed version unknown/, r.all);
  assert.ok(!fs.existsSync(path.join(home, '.lifecycle', 'app', 'installed-commit.json')));
});

test('the lifecycle command refuses to uninstall from a copy that is not installed', async () => {
  const home = tmp('home');
  const r = await run('bash', ['bin/lifecycle', 'uninstall', '--remove-settings'], { env: { HOME: home, PATH: '/usr/bin:/bin' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not an installed one, so there is nothing to uninstall/);
});

// --- first-run setup ---------------------------------------------------------------------------

async function setup(gh, home, input, args = []) {
  const env = { HOME: home, PATH: '/usr/bin:/bin', LIFECYCLE_HOME: path.join(home, '.lifecycle'), LIFECYCLE_GITHUB_API: gh.url };
  return run(process.execPath, ['src/cli/setup.js', ...args], { env, input });
}

test('setup asks only for the shared repo and GitHub access, in plain language, and saves them', async () => {
  const gh = await startFakeGithub();
  gh.state.readable.add('acme/features');
  const home = tmp('setup');
  try {
    const r = await setup(gh, home, `https://github.com/acme/features\nnot-a-token\n${gh.token}\n\n`);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /Two questions and you are done/);
    assert.match(r.stdout, /1\. Shared feature repo/);
    assert.match(r.stdout, /2\. GitHub access/);
    assert.match(r.stdout, /github\.com\/settings\/tokens\/new\?description=LifeCycle.*scopes=repo/);
    assert.match(r.stdout, /! GitHub did not accept that token/);
    assert.match(r.stdout, /✓ Connected to GitHub as tester\. You can read acme\/features\./);
    assert.match(r.stdout, /Type y to set them up now, or press Return to skip/);
    assert.doesNotMatch(r.stdout, /Flagsmith API key|Provider|Branch of the shared repo|comma-separated/, 'optional extras were asked without opting in');
    const dir = path.join(home, '.lifecycle');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).dataRepo, 'acme/features');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8')), { github: { token: gh.token } });
    assert.equal(fs.statSync(path.join(dir, 'credentials.json')).mode & 0o777, 0o600);
  } finally {
    await gh.close();
  }
});

test('setup can be re-run: current answers are the defaults and saved access is kept', async () => {
  const gh = await startFakeGithub();
  gh.state.readable.add('acme/features');
  const home = tmp('setup');
  try {
    await setup(gh, home, `acme/features\n${gh.token}\n\n`);
    const again = await setup(gh, home, '\n\n\n');
    assert.equal(again.status, 0, again.all);
    assert.match(again.stdout, /Press Return to keep each current answer/);
    assert.match(again.stdout, /Shared repo \[acme\/features\]/);
    assert.match(again.stdout, /You are already connected to GitHub\. Press Return to keep that/);
    assert.match(again.stdout, /✓ Connected to GitHub as tester/);
    const extras = await setup(gh, home, 'release\n-\nnone\n@me\n', ['--extras']);
    assert.equal(extras.status, 0, extras.all);
    assert.doesNotMatch(extras.stdout, /1\. Shared feature repo/);
    const config = JSON.parse(fs.readFileSync(path.join(home, '.lifecycle', 'config.json'), 'utf8'));
    assert.equal(config.dataRepo, 'acme/features');
    assert.equal(config.dataBranch, 'release');
    assert.deepEqual(config.me.owners, ['@me']);
  } finally {
    await gh.close();
  }
});

test('setup says in plain words when GitHub works but the shared repo is not visible yet', async () => {
  const gh = await startFakeGithub();
  const home = tmp('setup');
  try {
    const r = await setup(gh, home, `acme/secret\n${gh.token}\n\n`);
    assert.match(r.stdout, /! Connected to GitHub as tester, but you can't see acme\/secret yet\./);
    assert.match(r.stdout, /Ask its owner to invite your GitHub user \(tester\)/);
  } finally {
    await gh.close();
  }
});

test('GitHub access through gh still works when LifeCycle runs with a minimal PATH (as at login)', async () => {
  const home = tmp('gh');
  const bin = path.join(home, 'tools');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\necho gho_from_fake_gh\n', { mode: 0o755 });
  const lc = path.join(home, '.lifecycle');
  fs.mkdirSync(lc);
  fs.writeFileSync(path.join(lc, 'credentials.json'), JSON.stringify({ github: { useGhCli: true, ghPath: path.join(bin, 'gh') } }));
  const env = { HOME: home, PATH: '/usr/bin:/bin', LIFECYCLE_HOME: lc };
  const script = "const m = await import('./src/config.js'); process.stdout.write(String(m.githubToken()))";
  const r = await run(process.execPath, ['--input-type=module', '-e', script], { env });
  assert.equal(r.stdout, 'gho_from_fake_gh', r.all);
  // Installs from before the path was saved: gh in ~/.local/bin is found even though it's not on PATH.
  // (Only checkable when no real gh sits in a system folder, which is searched first.)
  if (['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/opt/local/bin/gh'].some((f) => fs.existsSync(f))) return;
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.renameSync(path.join(bin, 'gh'), path.join(home, '.local', 'bin', 'gh'));
  fs.writeFileSync(path.join(lc, 'credentials.json'), JSON.stringify({ github: { useGhCli: true } }));
  const old = await run(process.execPath, ['--input-type=module', '-e', script], { env });
  assert.equal(old.stdout, 'gho_from_fake_gh', old.all);
});
