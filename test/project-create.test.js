// Creating a project from LifeCycle (sidebar → New project): one commit of projects/<id>.yaml under
// the person's GitHub user; an existing id is never overwritten; read-only people are told why.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startWorld, DATA } from './last-mile-fixture.js';
import { createApp } from '../src/app.js';
import { createServer } from '../src/server.js';
import { createAskService } from '../src/ask/service.js';
import { DEFAULTS } from '../src/config.js';
import { buildProjectFile } from '../src/projects/create.js';

let w, server, url;

before(async () => {
  process.env.LIFECYCLE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-project-'));
  w = await startWorld();
  w.gh.state.writable.add(DATA);
  w.gh.state.login = 'ana';
  w.gh.state.readOnlyLogins.add('cy');
  w.gh.state.files.get(DATA).set('projects/catalog.yaml', 'id: catalog\nname: Catalog\n');
  const config = { ...w.config, ai: { ...DEFAULTS.ai, provider: 'none' } };
  const app = createApp({ config, token: w.gh.token, flagsmithApiKey: w.fs.apiKey });
  server = createServer(app, createAskService({ app, readConfig: () => config }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await w.close(); });

const post = async (draft) => {
  const res = await fetch(`${url}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ draft }) });
  return { status: res.status, body: await res.json() };
};

test('a new project is committed as projects/<id>.yaml under the person\'s user and shows on the next refresh', async () => {
  w.gh.state.login = 'ana';
  const r = await post({ name: 'Wishlist sharing', owner: 'Wishlist team', description: 'Share the wishlist with friends.' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.id, 'wishlist-sharing', 'the id comes from the name');
  const c = w.gh.state.commits.at(-1);
  assert.deepEqual([c.path, c.by, c.message], ['projects/wishlist-sharing.yaml', 'ana', 'Add project wishlist-sharing (by @ana from LifeCycle)']);
  assert.equal(c.after, 'id: wishlist-sharing\nname: Wishlist sharing\nowner: Wishlist team\ndescription: Share the wishlist with friends.\n');
  const roadmap = await (await fetch(`${url}/api/roadmap`)).json();
  assert.ok(roadmap.projects.some((p) => p.project.id === 'wishlist-sharing' && p.project.name === 'Wishlist sharing'));
});

test('an id that is already a project, a missing name or a bad id is refused, naming the field; nothing is committed', async () => {
  w.gh.state.login = 'ana';
  const before = w.gh.state.commits.length;
  let r = await post({ name: 'Catalog' });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body.errors, [{ field: 'id', message: '"catalog" is already a project; pick another name or id' }]);
  r = await post({ name: '' });
  assert.ok(r.body.errors.some((e) => e.field === 'name'));
  r = await post({ name: 'Ok', id: 'Not OK' });
  assert.deepEqual(r.body.errors.map((e) => e.field), ['id']);
  assert.equal(w.gh.state.commits.length, before);
});

test('a person with read-only access is told why and nothing is written', async () => {
  w.gh.state.login = 'cy';
  const before = w.gh.state.commits.length;
  const r = await post({ name: 'Read only project' });
  assert.equal(r.status, 403);
  assert.equal(r.body.outcome, 'read_only');
  assert.equal(w.gh.state.commits.length, before);
  w.gh.state.login = 'ana';
});

test('the project file never carries a credential', () => {
  const built = buildProjectFile({ name: 'Secret', owner: 'ghp_1234567890abcdefghijklmnopqrstuvwxyz12' }, []);
  assert.deepEqual(built.errors.map((e) => e.field), ['owner']);
});

test('the sidebar offers "New project" under the project list', () => {
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(js, /<li class="side-new"><a href="#\/projects\/new"/);
  assert.match(js, /if \(h === '#\/projects\/new'\) return \{ route: 'project-new' \};/);
});
