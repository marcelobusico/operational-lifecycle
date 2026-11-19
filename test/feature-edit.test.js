// Product managers edit feature data from LifeCycle: walks the acceptance criteria with
// three teammates (each with their own LifeCycle home and GitHub identity) against a fake GitHub and
// a fake AI provider. A PM (ana) and an engineer (bo) can write to the shared repo; cy can only read.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeGithub } from './fake-github.js';
import { startFakeAi } from './fake-ai.js';
import { createApp } from '../src/app.js';
import { createServer } from '../src/server.js';
import { createAskService } from '../src/ask/service.js';
import { DEFAULTS } from '../src/config.js';

const DATA = 'team/LifeCycle-Data';
const APP = 'team/catalog';
let gh, ai, ana, bo, cy;

async function person(name, { login }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `lifecycle-${name}-`));
  const config = { ...DEFAULTS, dataRepo: DATA, me: { owners: [], github: null },
    ai: { ...DEFAULTS.ai, provider: 'openai-compatible', apiUrl: ai.url, model: 'fake-model', timeoutMs: 5000 },
    sources: { github: { enabled: true, apiUrl: gh.url }, flagsmith: { ...DEFAULTS.sources.flagsmith, enabled: false } } };
  process.env.LIFECYCLE_HOME = home;
  const app = createApp({ config, token: gh.token, flagsmithApiKey: null });
  const server = createServer(app, createAskService({ app, readConfig: () => config }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    process.env.LIFECYCLE_HOME = home;
    gh.state.login = login;
    const res = await fetch(url + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  return {
    login,
    get: (p) => call('GET', p).then((r) => r.body),
    post: (p, body = {}) => call('POST', p, body),
    put: (p, body = {}) => call('PUT', p, body),
    // Opening the edit form: the feature as a draft plus the hash of the file as opened.
    open: (id) => call('GET', `/api/features/${id}/definition`).then((r) => r.body),
    close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }),
  };
}

const step = (id, owner, pr) => `  - id: ${id}\n    name: ${id[0].toUpperCase()}${id.slice(1)}\n    owner: "${owner}"\n    done_when: merged to main\n` +
  (pr ? `    evidence:\n      - { source: github, type: pr, repo: ${APP}, number: ${pr} }\n` : '');
const repoFile = (p) => gh.state.files.get(DATA).get(p);
const commitsFor = (p) => gh.state.commits.filter((c) => c.repo === DATA && c.path === p);
// Lines added and removed by a commit (a line-set diff is enough for these small files).
function lineDiff(before, after) {
  const a = (before || '').split('\n');
  const b = after.split('\n');
  return { added: b.filter((l) => !a.includes(l)), removed: a.filter((l) => !b.includes(l)) };
}

before(async () => {
  gh = await startFakeGithub();
  ai = await startFakeAi('openai');
  gh.state.readable.add(DATA).add(APP);
  gh.state.writable.add(DATA);
  gh.state.readOnlyLogins.add('cy');
  gh.state.files.set(DATA, new Map([
    ['features/rewards.yaml', `id: rewards\nname: Rewards\nowner: Catalog team\nsteps:\n${step('development', '@rewards-dev', 4)}`],
    ['features/redeem-rewards.yaml', `id: redeem-rewards\nname: Redeem rewards\nowner: Mobile team\ndepends_on: [rewards]\ntarget_date: 2026-12-01\nsteps:\n${step('development', '@redeem-dev', 5)}`],
    // A comment and a step with evidence: both must survive an edit made in LifeCycle.
    ['features/loyalty.yaml', `# Loyalty tiers: owned by growth.\nid: loyalty\nname: Loyalty tiers\nowner: Growth team\nservices: [catalog-api]\nflags: [loyalty_tiers]\nsteps:\n${step('development', '@loyalty-dev', 6)}${step('release', 'Release team')}`],
    ['projects/reading.yaml', 'id: reading\nname: Reading app\nowner: Catalog team\n'],
    ['features/wishlist.yaml', `id: wishlist\nname: Wishlist\nowner: Wishlist team\nsteps: []\n`],
    ['features/wishlist-share.yaml', `id: wishlist-share\nname: Wishlist share\nowner: Wishlist team\ndepends_on: [wishlist]\nsteps: []\n`],
  ]));
  for (const n of [4, 5, 6]) gh.state.prs.set(`${APP}#${n}`, { title: `PR ${n}`, state: 'open', merged_at: null });
  ana = await person('ana', { login: 'ana' }); // product manager, write access
  bo = await person('bo', { login: 'bo' });    // engineer, write access
  cy = await person('cy', { login: 'cy' });    // read-only access to the shared repo
});
after(async () => { await ana.close(); await bo.close(); await cy.close(); await ai.close(); await gh.close(); });

test('a PM changes the target date and adds a dependency on "redeem rewards": the repo has a commit by that PM with exactly those changes', async () => {
  const before = repoFile('features/loyalty.yaml');
  const statusBefore = (await ana.get('/api/features/loyalty/status')).steps.map((s) => [s.id, s.state]);
  const def = await ana.open('loyalty');
  assert.equal(def.access.can_edit, true);
  const draft = { ...def.draft, target_date: '2027-01-15', depends_on: [...def.draft.depends_on, 'redeem-rewards'] };

  // Before saving: what will change, checked and reviewed.
  const preview = (await ana.post('/api/features/preview', { mode: 'update', id: 'loyalty', draft, base_hash: def.base_hash })).body;
  assert.equal(preview.valid, true);
  assert.deepEqual(preview.diff, [
    { field: 'target_date', label: 'Target date', from: null, to: '2027-01-15' },
    { field: 'depends_on', label: 'Depends on', added: ['redeem-rewards'], removed: [] },
  ]);
  assert.equal(preview.review.ran, true, 'the AI product review ran');
  assert.equal(preview.review.blocking, false);

  const r = await ana.put('/api/features/loyalty', { draft, base_hash: def.base_hash });
  assert.equal(r.status, 200, r.body.message);
  assert.equal(r.body.outcome, 'published');
  assert.equal(r.body.by, '@ana');

  const commits = commitsFor('features/loyalty.yaml');
  assert.equal(commits.length, 1);
  const c = commits[0];
  assert.equal(c.by, 'ana', 'committed with the PM\'s own GitHub credentials');
  assert.equal(c.branch, 'main', 'directly to main, no pull request');
  assert.match(c.message, /^Edit feature loyalty: target date, depends on \(by @ana from LifeCycle\)$/);
  assert.deepEqual(lineDiff(before, repoFile('features/loyalty.yaml')), { added: ['target_date: 2027-01-15', 'depends_on:', '  - redeem-rewards'], removed: [] });
  assert.match(repoFile('features/loyalty.yaml'), /^# Loyalty tiers: owned by growth\./, 'comments and evidence are kept');

  // Editing never changes live status: steps still come from the PRs.
  assert.deepEqual((await ana.get('/api/features/loyalty/status')).steps.map((s) => [s.id, s.state]), statusBefore);
});

test('a teammate refreshing their own LifeCycle sees the new date and dependency', async () => {
  const s = await bo.get('/api/features/loyalty/status');
  assert.equal(s.feature.target_date, '2027-01-15');
  assert.deepEqual(s.depends_on.map((d) => d.id), ['redeem-rewards']);
  assert.equal(s.state, 'blocked', 'redeem rewards is not done, so loyalty is now blocked by it');
});

test('an edit that makes a step\'s owner empty is blocked, with the message on that field, and nothing is saved', async () => {
  const def = await ana.open('loyalty');
  const draft = structuredClone(def.draft);
  draft.steps[1].owner = '';
  const preview = (await ana.post('/api/features/preview', { mode: 'update', id: 'loyalty', draft, base_hash: def.base_hash })).body;
  assert.equal(preview.valid, false);
  assert.deepEqual(preview.errors, [{ field: 'steps[1].owner', message: 'is required' }]);
  assert.equal(preview.review, null, 'an invalid definition is not sent for review');
  const commits = gh.state.commits.length;
  const r = await ana.put('/api/features/loyalty', { draft, base_hash: def.base_hash });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body.errors, [{ field: 'steps[1].owner', message: 'is required' }]);
  assert.equal(gh.state.commits.length, commits, 'nothing was committed');
  // An unknown dependency is refused on depends_on, too.
  const bad = await ana.put('/api/features/loyalty', { draft: { ...def.draft, depends_on: ['no-such-feature'] }, base_hash: def.base_hash });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.errors[0].field, 'depends_on');
  assert.match(bad.body.errors[0].message, /unknown dependency "no-such-feature"/);
});

test('an AI review contradiction blocks publishing; suggestions alone do not', async () => {
  const def = await ana.open('rewards');
  const draft = { ...def.draft, target_date: '2027-06-01' };
  ai.state.reviewFindings = [{ kind: 'contradiction', field: 'target_date', message: 'Rewards is due after redeem rewards, which depends on it.', suggestion: 'Move it before 2026-12-01.' }];
  const blocked = await ana.put('/api/features/rewards', { draft, base_hash: def.base_hash });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.review.blocking, true);
  assert.equal(blocked.body.review.findings[0].field, 'target_date');
  assert.equal(commitsFor('features/rewards.yaml').length, 0);
  const prompt = ai.state.requests.at(-1).body.messages;
  assert.match(prompt[0].content, /Contradictions/, 'the review applies the lifecycle-feature-review rules');
  assert.match(prompt[1].content, /redeem-rewards \(Redeem rewards\), target_date 2026-12-01/, 'it sees the features that depend on this one');

  ai.state.reviewFindings = [{ kind: 'ambiguity', field: 'steps[0].done_when', message: '"merged to main" names no repo.', suggestion: 'Say which repo.' }];
  const ok = await ana.put('/api/features/rewards', { draft: { ...def.draft, target_date: '2026-11-20' }, base_hash: def.base_hash });
  assert.equal(ok.status, 200, ok.body.message);
  assert.equal(ok.body.review.findings[0].kind, 'ambiguity');
  ai.state.reviewFindings = null;
});

test('two people editing the same feature at once: the second save is told about the conflict and neither change is lost', async () => {
  const anaDef = await ana.open('redeem-rewards');
  const boDef = await bo.open('redeem-rewards');
  const boSave = await bo.put('/api/features/redeem-rewards', { draft: { ...boDef.draft, owner: 'Mobile catalog team' }, base_hash: boDef.base_hash });
  assert.equal(boSave.status, 200);

  const anaDraft = { ...anaDef.draft, description: 'Readers redeem their reading points in the reader.' };
  const conflict = await ana.put('/api/features/redeem-rewards', { draft: anaDraft, base_hash: anaDef.base_hash });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.outcome, 'conflict');
  assert.match(conflict.body.message, /^Not published: @bo changed redeem-rewards at .+ after you opened it\. Nothing was overwritten and your edit is kept on this machine\./);
  assert.match(repoFile('features/redeem-rewards.yaml'), /owner: Mobile catalog team/, 'bo\'s change is in the repo, untouched');
  assert.doesNotMatch(repoFile('features/redeem-rewards.yaml'), /description/);

  const kept = (await ana.get('/api/roadmap')).feature_outbox.find((e) => e.key === conflict.body.key);
  assert.equal(kept.state, 'conflict');
  assert.equal(kept.draft.description, anaDraft.description, 'ana\'s refused edit is kept on her machine');

  // Ana applies her edit to the latest version: both changes end up in the repo.
  const latest = await ana.open('redeem-rewards');
  const r = await ana.put('/api/features/redeem-rewards', { draft: { ...latest.draft, description: anaDraft.description }, base_hash: latest.base_hash });
  assert.equal(r.status, 200, r.body.message);
  const text = repoFile('features/redeem-rewards.yaml');
  assert.match(text, /owner: Mobile catalog team/);
  assert.match(text, /description: Readers redeem their reading points in the reader\./);
  assert.deepEqual(commitsFor('features/redeem-rewards.yaml').map((c) => c.by), ['bo', 'ana']);
  await ana.post(`/api/features-outbox/${kept.key}/discard`); // what the form does once the edit is published
});

test('a save racing a teammate\'s save between check and write is refused by the repo, and the edit is kept', async () => {
  const def = await ana.open('wishlist');
  // Bo's save lands after ana's LifeCycle read the file but before its write reaches GitHub.
  gh.state.beforeWrite = async (repo, file) => {
    if (file !== 'features/wishlist.yaml' || gh.state.login !== 'ana') return;
    gh.state.beforeWrite = null;
    gh.state.files.get(DATA).set(file, `${repoFile(file)}target_date: 2027-02-01\n`);
    gh.state.commits.push({ repo, path: file, message: 'Edit feature wishlist: target date (by @bo from LifeCycle)', branch: 'main', by: 'bo', at: new Date().toISOString(), op: 'update' });
  };
  const r = await ana.put('/api/features/wishlist', { draft: { ...def.draft, owner: 'Wishlist squad' }, base_hash: def.base_hash });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /Nothing was overwritten and your edit is kept on this machine/);
  assert.match(repoFile('features/wishlist.yaml'), /target_date: 2027-02-01/);
  assert.match(repoFile('features/wishlist.yaml'), /owner: Wishlist team/);
  const kept = (await ana.get('/api/roadmap')).feature_outbox.find((e) => e.key === r.body.key);
  assert.equal(kept.state, 'conflict');
  assert.equal(kept.draft.owner, 'Wishlist squad');
  await ana.post(`/api/features-outbox/${kept.key}/discard`);
});

test('with the shared repo unreachable, an edit shows "not published yet" and is in the repo once it is reachable again', async () => {
  const def = await ana.open('rewards');
  gh.state.down = true;
  const r = await ana.put('/api/features/rewards', { draft: { ...def.draft, owner: 'Rewards squad' }, base_hash: def.base_hash });
  assert.equal(r.status, 202);
  assert.equal(r.body.outcome, 'queued');
  assert.match(r.body.message, /^Not published yet: the shared repo can't be reached/);
  const offline = await ana.get('/api/roadmap');
  assert.equal(offline.feature_outbox.length, 1);
  assert.equal(offline.feature_outbox[0].state, 'pending');
  assert.doesNotMatch(repoFile('features/rewards.yaml'), /Rewards squad/);

  gh.state.down = false;
  const back = await ana.get('/api/roadmap'); // the next refresh publishes it
  assert.equal(back.feature_outbox.length, 0);
  assert.match(repoFile('features/rewards.yaml'), /owner: Rewards squad/);
  assert.equal(commitsFor('features/rewards.yaml').at(-1).by, 'ana');
  assert.equal(back.features.find((f) => f.feature.id === 'rewards').feature.owner, 'Rewards squad');
});

test('a person with read-only access sees the feature, gets no save, and is told why', async () => {
  const def = await cy.open('loyalty');
  assert.equal(def.access.can_edit, false);
  assert.match(def.access.reason, /read-only access to team\/LifeCycle-Data/);
  const status = await cy.get('/api/features/loyalty/status');
  assert.equal(status.feature.target_date, '2027-01-15', 'everything stays viewable');
  const commits = gh.state.commits.length;
  const r = await cy.put('/api/features/loyalty', { draft: { ...def.draft, owner: 'Someone' }, base_hash: def.base_hash });
  assert.equal(r.status, 403);
  assert.equal(r.body.outcome, 'read_only');
  assert.match(r.body.message, /read-only access/);
  assert.equal(gh.state.commits.length, commits);
});

test('deleting a feature others depend on lists those features before it is deleted', async () => {
  const def = await ana.open('wishlist');
  assert.deepEqual(def.dependents.map((d) => d.id), ['wishlist-share'], 'the form knows the dependents up front');
  const commits = gh.state.commits.length;
  const r = await ana.post('/api/features/wishlist/delete', { base_hash: def.base_hash });
  assert.equal(r.status, 409);
  assert.equal(r.body.outcome, 'has_dependents');
  assert.deepEqual(r.body.dependents, [{ id: 'wishlist-share', name: 'Wishlist share', owner: 'Wishlist team' }]);
  assert.match(r.body.message, /Wishlist share depends on Wishlist/);
  assert.equal(gh.state.commits.length, commits, 'nothing deleted before confirming');
  assert.ok(repoFile('features/wishlist.yaml'));

  const confirmed = await ana.post('/api/features/wishlist/delete', { base_hash: def.base_hash, confirm_dependents: true });
  assert.equal(confirmed.status, 200, confirmed.body.message);
  assert.equal(repoFile('features/wishlist.yaml'), undefined);
  assert.match(gh.state.commits.at(-1).message, /^Delete feature wishlist \(by @ana from LifeCycle\)$/);
  const s = await bo.get('/api/features/wishlist-share/status');
  assert.match(s.warnings[0].message, /unknown dependency "wishlist"/);
});

test('a PM creates a feature from LifeCycle; it is validated, committed and appears for teammates', async () => {
  const draft = { id: 'book-clubs', name: 'Book clubs', owner: 'Catalog team', target_date: '2027-03-01', depends_on: ['rewards'],
    services: ['catalog-api'], flags: [], steps: [{ name: 'Development', owner: '@club-dev', team: 'Catalog team', done_when: 'Book club API merged to main' }] };
  const taken = await ana.post('/api/features', { draft: { ...draft, id: 'loyalty' } });
  assert.equal(taken.status, 400);
  assert.equal(taken.body.errors[0].field, 'id');
  const r = await ana.post('/api/features', { draft });
  assert.equal(r.status, 200, r.body.message);
  assert.equal(commitsFor('features/book-clubs.yaml')[0].by, 'ana');
  assert.equal(repoFile('features/book-clubs.yaml'), [
    'id: book-clubs', 'name: Book clubs', 'owner: Catalog team', 'target_date: 2027-03-01', 'depends_on:', '  - rewards', 'services:', '  - catalog-api',
    'steps:', '  - id: development', '    name: Development', '    owner: "@club-dev"', '    team: Catalog team', '    done_when: Book club API merged to main', '',
  ].join('\n'));
  const s = await bo.get('/api/features/book-clubs/status');
  assert.equal(s.feature.name, 'Book clubs');
  assert.equal(s.steps[0].state, 'not_started', 'status comes from the evidence (none yet), never from the edit');
});

test('a feature created from a project\'s page goes in that project; an edit can move it out, and an unknown project is refused', async () => {
  const draft = { id: 'reading-goals', name: 'Reading goals', owner: 'Catalog team', project: 'reading', target_date: '', depends_on: [],
    services: [], flags: [], steps: [{ name: 'Development', owner: '@goals-dev', team: 'Catalog team', done_when: 'merged to main' }] };
  const unknown = await ana.post('/api/features', { draft: { ...draft, project: 'no-such-project' } });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.errors[0].field, 'project');
  assert.match(unknown.body.errors[0].message, /not a defined project .*defined: reading/);
  const r = await ana.post('/api/features', { draft });
  assert.equal(r.status, 200, r.body.message);
  assert.match(repoFile('features/reading-goals.yaml'), /^owner: Catalog team\nproject: reading\n/m);
  const roadmap = await bo.get('/api/roadmap');
  assert.ok(roadmap.projects.find((p) => p.project.id === 'reading').features.includes('reading-goals'), 'the feature shows in its project');
  // "No project" in the form removes the key.
  const def = await ana.open('reading-goals');
  assert.equal(def.draft.project, 'reading');
  const out = await ana.put('/api/features/reading-goals', { draft: { ...def.draft, project: '' }, base_hash: def.base_hash });
  assert.equal(out.status, 200, out.body.message);
  assert.doesNotMatch(repoFile('features/reading-goals.yaml'), /project:/);
});

test('deleting a project: refused while it has features (named), read-only people can\'t, and an empty one is removed by one commit', async () => {
  const def = await ana.open('reading-goals');
  await ana.put('/api/features/reading-goals', { draft: { ...def.draft, project: 'reading' }, base_hash: def.base_hash });
  const busy = await ana.post('/api/projects/reading/delete');
  assert.equal(busy.status, 409);
  assert.equal(busy.body.outcome, 'has_features');
  assert.deepEqual(busy.body.features, [{ id: 'reading-goals', name: 'Reading goals' }]);
  assert.match(busy.body.message, /Reading app still has 1 feature \(Reading goals\)\. Move it to another project or "No project"/);
  assert.ok(repoFile('projects/reading.yaml'), 'nothing was deleted');
  assert.equal((await cy.post('/api/projects/reading/delete')).status, 403);
  assert.equal((await ana.post('/api/projects/nope/delete')).status, 404);

  const again = await ana.open('reading-goals');
  await ana.put('/api/features/reading-goals', { draft: { ...again.draft, project: '' }, base_hash: again.base_hash });
  const r = await ana.post('/api/projects/reading/delete');
  assert.equal(r.status, 200, r.body.message);
  assert.equal(repoFile('projects/reading.yaml'), undefined);
  const c = commitsFor('projects/reading.yaml').at(-1);
  assert.equal(c.by, 'ana');
  assert.match(c.message, /^Delete project reading \(by @ana from LifeCycle\)$/);
  assert.ok(!(await bo.get('/api/roadmap')).projects.some((p) => p.project.id === 'reading'));
});

test('editing a project renames it (same id and file, comments kept); a stale form or a read-only person is refused', async () => {
  gh.state.files.get(DATA).set('projects/shelf.yaml', '# Shelf work, owned by catalog.\nid: shelf\nname: Shelf\nowner: Catalog team\n');
  await ana.get('/api/roadmap');
  const base = { name: 'Shelf', owner: 'Catalog team', description: '' };
  const r = await ana.put('/api/projects/shelf', { draft: { name: 'Bookshelf', owner: 'Catalog team', description: 'Saved books' }, base });
  assert.equal(r.status, 200, r.body.message);
  assert.deepEqual(r.body.changed, ['name', 'description']);
  assert.equal(repoFile('projects/shelf.yaml'), '# Shelf work, owned by catalog.\nid: shelf\nname: Bookshelf\nowner: Catalog team\ndescription: Saved books\n');
  assert.match(commitsFor('projects/shelf.yaml').at(-1).message, /^Edit project shelf: name, description \(by @ana from LifeCycle\)$/);
  assert.equal((await bo.get('/api/roadmap')).projects.find((p) => p.project.id === 'shelf').project.name, 'Bookshelf');
  // bo still has the old name in his form: refused, ana's change is kept.
  const stale = await bo.put('/api/projects/shelf', { draft: { name: 'Shelves', owner: 'Catalog team', description: '' }, base });
  assert.equal(stale.status, 409);
  assert.match(stale.body.message, /someone changed Bookshelf after you opened it/);
  assert.match(repoFile('projects/shelf.yaml'), /name: Bookshelf/);
  assert.equal((await ana.put('/api/projects/shelf', { draft: { name: '', owner: '', description: '' } })).status, 400);
  assert.equal((await cy.put('/api/projects/shelf', { draft: { name: 'X' } })).status, 403);
});

test('apps: created from LifeCycle with stores and a Slack channel, edited keeping comments, refused when stale, deleted once no feature lists it', async () => {
  const draft = { name: 'Reader', owner: 'Mobile team', repo: 'team/reader-mobile', ios_store_id: '1234567890', android_store_id: '', slack: '#mobile-releases', hint: 'iOS messages mention the App Store' };
  const noStore = await ana.post('/api/apps', { draft: { ...draft, ios_store_id: '' } });
  assert.equal(noStore.status, 400);
  assert.equal(noStore.body.errors[0].field, 'ios_store_id');
  const badChannel = await ana.post('/api/apps', { draft: { ...draft, slack: 'mobile releases' } });
  assert.equal(badChannel.status, 400);
  assert.equal(badChannel.body.errors[0].field, 'slack');
  assert.equal((await cy.post('/api/apps', { draft })).status, 403);

  const r = await ana.post('/api/apps', { draft });
  assert.equal(r.status, 201, r.body.message);
  assert.equal(r.body.id, 'reader', 'the id comes from the name');
  assert.equal(repoFile('apps/reader.yaml'), [
    'id: reader', 'name: Reader', 'owner: Mobile team', 'repo: team/reader-mobile', 'platforms:', '  ios: { store: app_store, store_id: "1234567890" }',
    'release_channel:', '  slack: "#mobile-releases"', '  hint: iOS messages mention the App Store', ''].join('\n'));
  assert.equal(commitsFor('apps/reader.yaml')[0].by, 'ana');
  const listed = (await bo.get('/api/roadmap')).apps.find((a) => a.id === 'reader');
  assert.deepEqual(listed.release_channel, { slack: '#mobile-releases', hint: 'iOS messages mention the App Store' });

  // A comment written by hand survives an edit; the edit adds Android and drops the hint.
  gh.state.files.get(DATA).set('apps/reader.yaml', `# Reader app, owned by mobile.\n${repoFile('apps/reader.yaml')}`);
  const base = { ...draft };
  const e = await ana.put('/api/apps/reader', { draft: { ...draft, android_store_id: 'com.team.reader', hint: '' }, base });
  assert.equal(e.status, 200, e.body.message);
  assert.match(repoFile('apps/reader.yaml'), /^# Reader app, owned by mobile\.\n/);
  assert.match(repoFile('apps/reader.yaml'), /android: \{ store: google_play, store_id: com\.team\.reader \}/);
  assert.doesNotMatch(repoFile('apps/reader.yaml'), /hint:/);
  assert.match(commitsFor('apps/reader.yaml').at(-1).message, /^Edit app reader: Android, Slack hint \(by @ana from LifeCycle\)$/);
  const stale = await bo.put('/api/apps/reader', { draft: { ...draft, name: 'Reader app' }, base });
  assert.equal(stale.status, 409);
  assert.match(repoFile('apps/reader.yaml'), /com\.team\.reader/, "ana's change is kept");

  // Delete: refused while a feature ships in it, then removed.
  gh.state.files.get(DATA).set('features/reader-sync.yaml', 'id: reader-sync\nname: Reader sync\nowner: Mobile team\napps:\n  - id: reader\n    first_version: { ios: 3.4.0 }\nsteps: []\n');
  const busy = await ana.post('/api/apps/reader/delete');
  assert.equal(busy.status, 409);
  assert.deepEqual(busy.body.features, [{ id: 'reader-sync', name: 'Reader sync' }]);
  gh.state.files.get(DATA).delete('features/reader-sync.yaml');
  const del = await ana.post('/api/apps/reader/delete');
  assert.equal(del.status, 200, del.body.message);
  assert.equal(repoFile('apps/reader.yaml'), undefined);
});

test('editing one field of a hand-written app leaves the rest of the file as it was written', async () => {
  const text = 'id: shelf-app\nname: Shelf\nrepo: team/shelf\nplatforms:\n  # The store listing is managed by the growth team.\n  ios:\n    store: app_store\n    store_id: "987654321"\n';
  gh.state.files.get(DATA).set('apps/shelf-app.yaml', text);
  await ana.get('/api/roadmap');
  const base = { name: 'Shelf', owner: '', repo: 'team/shelf', release_tag: '', ios_store_id: '987654321', android_store_id: '', slack: '', hint: '' };
  const r = await ana.put('/api/apps/shelf-app', { draft: { ...base, slack: '#shelf-releases' }, base });
  assert.equal(r.status, 200, r.body.message);
  assert.equal(repoFile('apps/shelf-app.yaml'), `${text}release_channel:\n  slack: "#shelf-releases"\n`);
});

test('linking a PR to a step from the form: written as evidence, read live, an invalid repo refused', async () => {
  gh.state.prs.set(`${APP}#21`, { title: 'Wish links API', state: 'closed', merged_at: '2026-11-10T10:00:00Z' });
  gh.state.files.get(DATA).set('features/wish-links.yaml', 'id: wish-links\nname: Wish links\nowner: Wishlist team\nsteps:\n  - id: development\n    name: Development\n    owner: "@wish-dev"\n    done_when: API merged to main\n');
  await ana.get('/api/roadmap');
  const def = await ana.open('wish-links');
  const step = { id: 'development', name: 'Development', owner: '@wish-dev', team: '', done_when: 'API merged to main',
    add_evidence: [{ source: 'github', type: 'pr', repo: APP, number: 21 }] };
  const bad = await ana.put('/api/features/wish-links', { draft: { ...def.draft, steps: [{ ...step, add_evidence: [{ source: 'github', type: 'pr', repo: 'not a repo', number: 3 }] }] }, base_hash: def.base_hash });
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  assert.match(bad.body.errors[0].field, /^steps\[0\]\.evidence/);
  const r = await ana.put('/api/features/wish-links', { draft: { ...def.draft, steps: [step] }, base_hash: def.base_hash });
  assert.equal(r.status, 200, r.body.message);
  assert.match(repoFile('features/wish-links.yaml'), /evidence:\n\s+- \{ ?source: github, type: pr, repo: team\/catalog, number: 21 ?\}/);
  const s = await bo.get('/api/features/wish-links/status');
  assert.equal(s.steps[0].state, 'done', 'the merged PR makes the step done');
});
