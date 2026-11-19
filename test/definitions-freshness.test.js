// Every refresh shows the latest commit of LifeCycle-Data and says which commit it shows.
// Against a fake GitHub whose branch moves like the real one (test/fake-github.js: every change of
// the files is a new commit; reads by commit sha see that commit's files only), and a real local git
// clone for the local data folder setting.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startFakeGithub } from './fake-github.js';
import { startFakeAi } from './fake-ai.js';
import { createApp } from '../src/app.js';
import { createServer } from '../src/server.js';
import { createAskService } from '../src/ask/service.js';
import { DEFAULTS } from '../src/config.js';

const DATA = 'team/LifeCycle-Data';
let gh, ai, home;

const feature = (id, name) => `id: ${id}\nname: ${name}\nowner: "@${id}-owner"\nsteps: []\n`;
const team = (id, name) => `id: ${id}\nname: ${name}\n`;
const setFile = (p, text) => gh.state.files.get(DATA).set(p, text);

function config(overrides = {}) {
  return { ...DEFAULTS, dataRepo: DATA, me: { owners: [], github: null },
    ai: { ...DEFAULTS.ai, provider: 'openai-compatible', apiUrl: ai.url, model: 'fake-model', timeoutMs: 5000 },
    sources: { github: { enabled: true, apiUrl: gh.url }, flagsmith: { ...DEFAULTS.sources.flagsmith, enabled: false }, statsig: { ...DEFAULTS.sources.statsig, enabled: false } },
    ...overrides };
}
const newApp = (overrides) => createApp({ alwaysLive: true, config: config(overrides), token: gh.token, flagsmithApiKey: null, statsigApiKey: null });

async function startServer(app) {
  const server = createServer(app, createAskService({ app, readConfig: () => app.config }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const res = await fetch(url + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  return { get: (p) => call('GET', p).then((r) => r.body), put: (p, b) => call('PUT', p, b), close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) };
}

const nameOf = (snap, id) => snap.features.find((f) => f.feature.id === id)?.feature.name;
const definitionReads = () => fs.readFileSync(path.join(home, 'logs', 'source-reads.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  .filter((e) => e.feature === '*' && ['github', 'local-clone', 'local-folder'].includes(e.source));

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-fresh-'));
  process.env.LIFECYCLE_HOME = home;
  gh = await startFakeGithub();
  ai = await startFakeAi('openai');
  gh.state.readable.add(DATA);
  gh.state.writable.add(DATA);
  gh.state.files.set(DATA, new Map([
    ['features/rewards.yaml', feature('rewards', 'Rewards')],
    ['features/wishlist.yaml', feature('wishlist', 'Wishlist')],
    ['teams/catalog.yaml', team('catalog', 'Catalog')],
  ]));
});
after(async () => { await ai.close(); await gh.close(); });

test('a commit pushed to main shows after one refresh, with the commit id of the new head; one log entry per refresh', async () => {
  const lc = await startServer(newApp());
  const first = await lc.get('/api/roadmap');
  assert.equal(first.definitions.commit, gh.state.head(DATA));
  assert.equal(first.definitions.commit_short, first.definitions.commit.slice(0, 7));
  assert.equal(first.definitions.commit_url, `https://github.com/${DATA}/commit/${first.definitions.commit}`);
  assert.ok(first.definitions.read_at);
  assert.equal(first.definitions.notice, null, 'the latest from GitHub needs no notice');

  setFile('features/rewards.yaml', feature('rewards', 'Rewards points')); // someone pushes to main
  const logBefore = definitionReads().length;
  const second = await lc.get('/api/roadmap'); // the refresh button
  assert.equal(nameOf(second, 'rewards'), 'Rewards points');
  assert.equal(second.definitions.commit, gh.state.head(DATA));
  assert.notEqual(second.definitions.commit, first.definitions.commit);

  const logged = definitionReads().slice(logBefore);
  assert.equal(logged.length, 1, 'one definitions read logged for one refresh');
  assert.equal(logged[0].outcome, 'ok');
  assert.equal(logged[0].commit, second.definitions.commit);
  await lc.close();
});

test('the branch moving between listing the files and reading them never mixes two commits', async () => {
  const app = newApp();
  let moved = false;
  gh.state.afterTree = async () => {
    if (moved) return;
    moved = true; // a push lands right after the file list was read
    setFile('features/rewards.yaml', feature('rewards', 'Rewards moved'));
    setFile('features/wishlist.yaml', feature('wishlist', 'Wishlist moved'));
    gh.state.head(DATA);
  };
  try {
    const snap = await app.refresh({ live: true });
    const atCommit = gh.state.snapshots.get(snap.definitions.commit);
    assert.ok(atCommit, 'the reported commit is a real commit of the branch');
    const files = (await app.definitionsNow()).files;
    for (const [p, text] of files) assert.equal(text, atCommit.get(p), `${p} is exactly as in ${snap.definitions.commit_short}`);
    assert.equal(files.size, atCommit.size);
    assert.equal(nameOf(snap, 'rewards'), 'Rewards points');
    assert.equal(nameOf(snap, 'wishlist'), 'Wishlist');
    // The next refresh picks up the push as a whole.
    const next = await app.refresh({ live: true });
    assert.equal(nameOf(next, 'rewards'), 'Rewards moved');
    assert.equal(nameOf(next, 'wishlist'), 'Wishlist moved');
    assert.equal(next.definitions.commit, gh.state.head(DATA));
  } finally {
    gh.state.afterTree = null;
  }
});

test('a refresh clicked while another is running returns a read that started after the click', async () => {
  const app = newApp();
  let release;
  const paused = new Promise((r) => { release = r; });
  let reached;
  const atTree = new Promise((r) => { reached = r; });
  let once = false;
  gh.state.afterTree = async () => { if (once) return; once = true; reached(); await paused; };
  try {
    const running = app.refresh({ live: true }); // started before the push; holds at the file list
    await atTree;
    setFile('features/rewards.yaml', feature('rewards', 'Rewards after push'));
    const pushed = gh.state.head(DATA);
    const clicked = app.refresh({ live: true }); // the person presses refresh after the push
    const alsoClicked = app.refresh({ live: true }); // and again: shares the same next read
    assert.notEqual(clicked, running);
    assert.equal(alsoClicked, clicked);
    release();
    const [old, fresh] = await Promise.all([running, clicked]);
    assert.notEqual(old.definitions.commit, pushed);
    assert.equal(fresh.definitions.commit, pushed);
    assert.equal(nameOf(fresh, 'rewards'), 'Rewards after push');
  } finally {
    gh.state.afterTree = null;
  }
});

test('GitHub unreachable or rate limited: a visible "saved copy" notice with the saved commit, its read time and the reason', async () => {
  const lc = await startServer(newApp());
  const good = await lc.get('/api/roadmap');
  for (const [label, set, unset, reason] of [
    ['unreachable', () => { gh.state.down = true; }, () => { gh.state.down = false; }, /HTTP 503/],
    ['rate limited', () => { gh.state.rateLimited = true; }, () => { gh.state.rateLimited = false; }, /rate limit/],
  ]) {
    set();
    const logBefore = definitionReads().length;
    let snap;
    try {
      snap = await lc.get('/api/roadmap');
    } finally {
      unset();
    }
    const d = snap.definitions;
    assert.equal(d.stale, true, label);
    assert.equal(d.fallback, 'saved_copy', label);
    assert.equal(d.commit, good.definitions.commit, `${label}: names the saved commit`);
    assert.equal(d.read_at, good.definitions.read_at, `${label}: names when the saved copy was read`);
    assert.equal(d.notice.level, 'warning');
    assert.match(d.notice.title, /saved copy.*not the latest main/);
    assert.match(d.notice.reason, reason);
    assert.equal(nameOf(snap, 'rewards'), nameOf(good, 'rewards'), 'the saved definitions are still shown');
    const logged = definitionReads().slice(logBefore);
    assert.equal(logged.length, 1);
    assert.notEqual(logged[0].outcome, 'ok');
    assert.match(logged[0].fallback, new RegExp(`saved copy at ${good.definitions.commit_short}`));
  }
  await lc.close();
});

test('after publishing a feature edit, the next snapshot reports the commit the publish made, even if GitHub still answers with the old head', async () => {
  const lc = await startServer(newApp());
  const def = await lc.get('/api/features/wishlist/definition');
  const before = gh.state.head(DATA);
  // Right after the push, GitHub keeps answering the branch with the commit before it.
  gh.state.staleRef = () => before;
  try {
    const r = await lc.put('/api/features/wishlist', { draft: { ...def.draft, name: 'Wishlist sharing' }, base_hash: def.base_hash });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const made = gh.state.head(DATA);
    assert.notEqual(made, before);
    const snap = await lc.get('/api/roadmap');
    assert.equal(snap.definitions.commit, made);
    assert.equal(nameOf(snap, 'wishlist'), 'Wishlist sharing');
  } finally {
    gh.state.staleRef = null;
  }
  await lc.close();
});

test('every view reached through one refresh reports the same commit', async () => {
  const lc = await startServer(newApp());
  const roadmap = await lc.get('/api/roadmap');
  const commit = roadmap.definitions.commit;
  assert.ok(commit);
  for (const f of roadmap.features) assert.equal(f.definitions.commit, commit, `feature page of ${f.feature.id}`);
  assert.equal((await lc.get('/api/alerts?cached=1')).definitions.commit, commit, 'alerts');
  assert.equal((await lc.get('/api/team-definitions?cached=1')).definitions.commit, commit, 'teams');
  await lc.close();
});

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('local data folder: a git clone is pulled on every refresh and the page says the source is a local clone; a failed pull says it may not be the latest', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-clone-'));
  git(dir, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  git(dir, 'clone', '-q', 'origin.git', 'pusher');
  const pusher = path.join(dir, 'pusher');
  fs.mkdirSync(path.join(pusher, 'features'));
  fs.writeFileSync(path.join(pusher, 'features', 'rewards.yaml'), feature('rewards', 'Local rewards'));
  git(pusher, 'add', '.');
  git(pusher, 'commit', '-qm', 'one');
  git(pusher, 'push', '-q', 'origin', 'HEAD:main');
  git(dir, 'clone', '-q', 'origin.git', 'clone');
  const clone = path.join(dir, 'clone');

  const lc = await startServer(newApp({ dataPath: clone }));
  const first = await lc.get('/api/roadmap');
  assert.equal(first.definitions.kind, 'local_clone');
  assert.equal(first.definitions.commit, git(clone, 'rev-parse', 'HEAD').trim());
  assert.equal(first.definitions.notice.level, 'info');
  assert.match(first.definitions.notice.title, /local clone, not GitHub/);
  assert.ok(first.definitions.notice.reason.includes(clone));

  // A teammate pushes: the next refresh pulls it.
  fs.writeFileSync(path.join(pusher, 'features', 'rewards.yaml'), feature('rewards', 'Local rewards v2'));
  git(pusher, 'commit', '-qam', 'two');
  git(pusher, 'push', '-q', 'origin', 'HEAD:main');
  const pushed = git(pusher, 'rev-parse', 'HEAD').trim();
  const second = await lc.get('/api/roadmap');
  assert.equal(second.definitions.commit, pushed);
  assert.equal(nameOf(second, 'rewards'), 'Local rewards v2');
  assert.equal(second.definitions.stale, false);

  // The pull fails (origin gone): the clone's current commit, flagged, with why.
  git(clone, 'remote', 'set-url', 'origin', path.join(dir, 'missing.git'));
  const logBefore = definitionReads().length;
  const third = await lc.get('/api/roadmap');
  assert.equal(third.definitions.commit, pushed);
  assert.equal(third.definitions.stale, true);
  assert.equal(third.definitions.fallback, 'clone_current');
  assert.equal(third.definitions.notice.level, 'warning');
  assert.match(third.definitions.notice.title, /current commit, which may not be the latest main/);
  assert.match(third.definitions.notice.reason, /git pull of main failed/);
  const logged = definitionReads().slice(logBefore);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].source, 'local-clone');
  assert.equal(logged[0].commit, pushed);
  assert.match(logged[0].fallback, /may not be the latest/);
  await lc.close();
});

test('local data folder: a publish from LifeCycle into a clone is a local commit the next snapshot shows', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-clone-pub-'));
  git(dir, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  git(dir, 'clone', '-q', 'origin.git', 'clone');
  const clone = path.join(dir, 'clone');
  fs.mkdirSync(path.join(clone, 'features'));
  fs.writeFileSync(path.join(clone, 'features', 'rewards.yaml'), feature('rewards', 'Rewards'));
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'one');
  git(clone, 'push', '-q', 'origin', 'HEAD:main');

  const lc = await startServer(newApp({ dataPath: clone }));
  const def = await lc.get('/api/features/rewards/definition');
  const r = await lc.put('/api/features/rewards', { draft: { ...def.draft, name: 'Rewards renamed' }, base_hash: def.base_hash });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const head = git(clone, 'rev-parse', 'HEAD').trim();
  assert.match(git(clone, 'log', '-1', '--format=%s'), /rewards/i);
  const snap = await lc.get('/api/roadmap');
  assert.equal(snap.definitions.commit, head);
  assert.equal(nameOf(snap, 'rewards'), 'Rewards renamed');
  await lc.close();
});

test('local data folder that is not a git clone: the page says it is a local folder, with no commit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-folder-'));
  fs.mkdirSync(path.join(dir, 'features'));
  fs.writeFileSync(path.join(dir, 'features', 'rewards.yaml'), feature('rewards', 'Folder rewards'));
  const lc = await startServer(newApp({ dataPath: dir }));
  const snap = await lc.get('/api/roadmap');
  assert.equal(snap.definitions.kind, 'local_folder');
  assert.equal(snap.definitions.commit, null);
  assert.match(snap.definitions.notice.title, /local folder, not GitHub/);
  assert.equal(nameOf(snap, 'rewards'), 'Folder rewards');
  await lc.close();
});
