// Reviewing, editing and approving an import proposal (docs/import-format.md, "Review and approve"):
// walks the acceptance criteria against a fake GitHub and a fake AI provider. ana can write to the
// shared repo; cy can only read it. The analysis itself is a stand-in (test/import.test.js covers it).
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
const SITE = 'https://acme.atlassian.net';
let gh, ai, ana, cy;

// Finished analyses, by id, as the import service would keep them.
const jobs = new Map();
const importer = { links: () => [], availability: () => ({ available: true }), start: () => ({ outcome: 'no_links' }),
  progress: (id) => jobs.get(id) || null, whyGone: () => 'unknown', settled: async () => {} };
let nextJob = 0;
function analysis(items) {
  const id = (++nextJob).toString(16).padStart(16, '0');
  jobs.set(id, { id, state: 'done', proposal: { schema: 'lifecycle.import-proposal/v1', analyzed_at: new Date().toISOString(), provider: { name: 'openai-compatible', model: 'fake-model' },
    sources: [], duplicates_checked: true, duplicates_note: null,
    items: items.map((it) => ({ description: '', parent: null, owner: '', done_when: '', evidence: [], source_links: [`${SITE}/browse/X-1`], level_reason: 'test', possible_duplicate: null, ...it })) } });
  return id;
}

// Jira through the Claude Code stand-in: every key is a ticket in progress.
const jiraCalls = [];
const jiraRun = async (cfg, prompt) => {
  const keys = prompt.match(/^Tickets: (.*)$/m)[1].split(', ');
  jiraCalls.push(keys);
  return JSON.stringify({ site_url: SITE, tickets: keys.map((key) => ({ key, summary: key, status: 'In Progress', status_category: 'In Progress', assignee: null, url: `${SITE}/browse/${key}` })), missing: [] });
};

async function person(name, { login, home = fs.mkdtempSync(path.join(os.tmpdir(), `lifecycle-${name}-`)) }) {
  const config = { ...DEFAULTS, dataRepo: DATA, me: { owners: [], github: null },
    ai: { ...DEFAULTS.ai, provider: 'openai-compatible', apiUrl: ai.url, model: 'fake-model', timeoutMs: 5000 },
    sources: { github: { enabled: true, apiUrl: gh.url }, flagsmith: { ...DEFAULTS.sources.flagsmith, enabled: false }, jira: { ...DEFAULTS.sources.jira, enabled: true } } };
  process.env.LIFECYCLE_HOME = home;
  const app = createApp({ alwaysLive: true, config, token: gh.token, flagsmithApiKey: null, jiraRun });
  const server = createServer(app, createAskService({ app, readConfig: () => config }), undefined, importer);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    process.env.LIFECYCLE_HOME = home;
    gh.state.login = login;
    const res = await fetch(url + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const self = {
    home, login,
    get: (p) => call('GET', p).then((r) => r.body),
    post: (p, body = {}) => call('POST', p, body),
    put: (p, body = {}) => call('PUT', p, body),
    review: () => call('GET', '/api/import/review').then((r) => r.body),
    // Starts a review of an analysis (replacing any other) and returns it.
    start: async (id) => (await call('POST', '/api/import/review', { analysis_id: id, replace: true })).body.review,
    // Edits items: { ref: { field: value } }.
    edit: async (changes) => {
      const r = await self.review();
      const edits = r.review.items.map((it) => ({ ...it, ...(changes[it.ref] || {}) }));
      return call('PUT', '/api/import/review', { revision: r.review.revision, edits });
    },
    check: () => call('POST', '/api/import/review/check', {}),
    approve: () => call('POST', '/api/import/review/approve', {}),
    close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }),
  };
  return self;
}

const repoFile = (p) => gh.state.files.get(DATA).get(p);
const item = (review, ref) => review.items.find((it) => it.ref === ref);

before(async () => {
  gh = await startFakeGithub();
  ai = await startFakeAi('openai');
  gh.state.readable.add(DATA).add(APP);
  gh.state.writable.add(DATA);
  gh.state.readOnlyLogins.add('cy');
  gh.state.files.set(DATA, new Map([
    ['features/checkout.yaml', 'id: checkout\nname: Checkout\nowner: Payments team\nsteps:\n  - id: build\n    name: Build\n    owner: "@pay-dev"\n    done_when: merged to main\n'],
    ['projects/reading.yaml', 'id: reading\nname: Reading app\nowner: Catalog team\n'],
  ]));
  for (const n of [12, 13]) gh.state.prs.set(`${APP}#${n}`, { title: `PR ${n}`, state: 'open', merged_at: null });
  ana = await person('ana', { login: 'ana' });
  cy = await person('cy', { login: 'cy' });
});
after(async () => { await ana.close(); await cy.close(); await ai.close(); await gh.close(); });

test('edited owner and "done when" land exactly in the published files; the features show on the Roadmap and Refresh Data reads their Jira tickets and PRs', async () => {
  const id = analysis([
    { ref: 'p1', level: 'project', name: 'Loyalty program', owner: 'Growth team' },
    { ref: 'f1', level: 'feature', name: 'Tier badges', parent: 'p1', owner: 'AI guess' },
    { ref: 's1', level: 'step', name: 'Badge API', parent: 'f1', owner: 'AI guess', done_when: 'AI guess', evidence: [{ source: 'jira', type: 'ticket', key: 'LOY-2' }] },
    { ref: 't1', level: 'task', name: 'API PR', parent: 's1', evidence: [{ source: 'github', type: 'pr', repo: APP, number: 12 }] },
  ]);
  const review = await ana.start(id);
  assert.equal(item(review, 'f1').included, true);
  await ana.edit({ f1: { owner: 'Growth squad' }, s1: { owner: '@badge-dev', done_when: 'Badges show on the profile for 100% of users' } });

  const checked = (await ana.check()).body;
  assert.equal(checked.fresh, true);
  assert.deepEqual(checked.review.items.map((it) => [it.ref, it.check.state]), [['p1', 'ready'], ['f1', 'ready'], ['s1', 'ready'], ['t1', 'ready']]);
  assert.equal(checked.ready, 2, 'one project and one feature to publish');

  const commits = gh.state.commits.length;
  jiraCalls.length = 0;
  const reqs = gh.state.requests.length;
  const r = await ana.approve();
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results.map((x) => [x.kind, x.id, x.outcome, x.link]), [['project', 'loyalty-program', 'published', '#/project/loyalty-program'], ['feature', 'tier-badges', 'published', '#/feature/tier-badges']]);
  const made = gh.state.commits.slice(commits).filter((c) => /^(features|projects)\//.test(c.path)); // (tests read live, so Jira snapshots are committed too)
  assert.deepEqual(made.map((c) => [c.path, c.by, c.op]), [['projects/loyalty-program.yaml', 'ana', 'create'], ['features/tier-badges.yaml', 'ana', 'create']], 'one commit per file, as the person');
  assert.match(made[1].message, /^Add feature tier-badges \(by @ana from LifeCycle import\)$/);
  const file = repoFile('features/tier-badges.yaml');
  assert.match(file, /^owner: Growth squad$/m);
  assert.match(file, /^project: loyalty-program$/m);
  assert.match(file, /^ {4}owner: "?@badge-dev"?$/m);
  assert.match(file, /^ {4}done_when: Badges show on the profile for 100% of users$/m);
  assert.match(file, /key: LOY-2/);
  assert.match(file, /repo: team\/catalog, number: 12/, 'the task is evidence on its step');
  assert.ok(r.body.review.items.every((it) => it.published), 'everything is marked published');

  const roadmap = await ana.get('/api/roadmap');
  assert.ok(roadmap.features.some((f) => f.feature.id === 'tier-badges'), 'the feature is on the Roadmap');
  // Read like any other feature (these tests read live, so the refresh after publishing already does).
  await ana.post('/api/refresh-data');
  assert.ok(jiraCalls.flat().includes('LOY-2'), 'its Jira ticket is read');
  assert.ok(gh.state.requests.slice(reqs).some((q) => String(q.url || q).includes(`/repos/${APP}/pulls/12`)), 'and its PR');
});

test('turning a feature into a step of another feature gives one feature, not two; excluded items are not published, the rest are', async () => {
  const id = analysis([
    { ref: 'f1', level: 'feature', name: 'Gift cards', owner: 'Payments team' },
    { ref: 's1', level: 'step', name: 'Gift card API', parent: 'f1', owner: '@gift-dev', done_when: 'API live' },
    { ref: 'f2', level: 'feature', name: 'Gift card emails', owner: 'Payments team' },
    { ref: 'f3', level: 'feature', name: 'Gift card refunds', owner: 'Payments team' },
    { ref: 's3', level: 'step', name: 'Refund flow', parent: 'f3', owner: '@refund-dev', done_when: 'refunds work' },
  ]);
  await ana.start(id);
  await ana.edit({ f2: { level: 'step', parent: 'f1', owner: '@mail-dev', done_when: 'Emails sent' }, f3: { included: false } });
  const r = await ana.approve();
  assert.deepEqual(r.body.results.map((x) => [x.id, x.outcome]), [['gift-cards', 'published']]);
  assert.equal(repoFile('features/gift-card-emails.yaml'), undefined, 'one feature, not two');
  assert.equal(repoFile('features/gift-card-refunds.yaml'), undefined, 'excluded: not published');
  assert.match(repoFile('features/gift-cards.yaml'), /name: Gift card emails/);
  const rv = (await ana.review()).review;
  assert.equal(item(rv, 'f3').published, null);
  assert.equal(item(rv, 's3').check.state, 'excluded');
  assert.match(item(rv, 's3').check.reason, /Gift card refunds/);
});

test('a possible duplicate needs a choice; "add to existing" adds steps and evidence to the existing feature and creates no new file', async () => {
  const id = analysis([
    { ref: 'f1', level: 'feature', name: 'Checkout revamp', owner: 'Payments team', possible_duplicate: { id: 'checkout', name: 'Checkout', kind: 'feature' } },
    { ref: 's1', level: 'step', name: 'Wallet button', parent: 'f1', owner: '@wallet-dev', done_when: 'button live', evidence: [{ source: 'github', type: 'pr', repo: APP, number: 13 }] },
  ]);
  await ana.start(id);
  const first = (await ana.check()).body;
  assert.equal(item(first.review, 'f1').check.state, 'invalid');
  assert.match(item(first.review, 'f1').check.errors[0].message, /choose skip, create anyway, or add/);
  assert.equal(first.ready, 0);

  await ana.edit({ f1: { duplicate_choice: 'merge' } });
  const commits = gh.state.commits.length;
  const r = await ana.approve();
  assert.deepEqual(r.body.results.map((x) => [x.op, x.id, x.outcome]), [['update', 'checkout', 'published']]);
  assert.deepEqual(gh.state.commits.slice(commits).map((c) => c.path), ['features/checkout.yaml'], 'no new file');
  assert.equal(repoFile('features/checkout-revamp.yaml'), undefined);
  const file = repoFile('features/checkout.yaml');
  assert.match(file, /id: build/, 'the existing step stays');
  assert.match(file, /id: wallet-button\n {4}name: Wallet button/);
  assert.match(file, /repo: team\/catalog, number: 13/);
});

test('a missing required field shows on its item and blocks it; the rest publishes; after the fix, Approve publishes it', async () => {
  const id = analysis([
    { ref: 'f1', level: 'feature', name: 'Reading streaks', owner: 'Catalog team', parent: 'existing:reading' },
    { ref: 's1', level: 'step', name: 'Streak counter', parent: 'f1', owner: '', done_when: 'counter shows' },
    { ref: 'f2', level: 'feature', name: 'Reading goals', owner: 'Catalog team' },
  ]);
  await ana.start(id);
  const checked = (await ana.check()).body.review;
  assert.equal(item(checked, 's1').check.state, 'invalid');
  assert.deepEqual(item(checked, 's1').check.errors, [{ field: 'owner', message: 'is required' }]);
  assert.equal(item(checked, 'f1').check.state, 'invalid', 'its feature is blocked with it');
  assert.equal(item(checked, 'f2').check.state, 'ready');

  const r = await ana.approve();
  assert.deepEqual(r.body.results.map((x) => [x.id, x.outcome]), [['reading-goals', 'published']]);
  assert.equal(repoFile('features/reading-streaks.yaml'), undefined);
  assert.equal(item(r.body.review, 's1').published, null, 'stays in the review');

  await ana.edit({ s1: { owner: '@streak-dev' } });
  const again = await ana.approve();
  assert.deepEqual(again.body.results.map((x) => [x.id, x.outcome]), [['reading-streaks', 'published']]);
  assert.match(repoFile('features/reading-streaks.yaml'), /^project: reading$/m);
});

test('a contradiction blocks its item; an item with only ambiguities is approved, with the suggestions shown', async () => {
  const id = analysis([
    { ref: 'f1', level: 'feature', name: 'Audio books', owner: 'Media team' },
    { ref: 's1', level: 'step', name: 'Player', parent: 'f1', owner: '@audio-dev', done_when: 'CONTRADICTION: ships before it is built' },
    { ref: 'f2', level: 'feature', name: 'Podcasts', owner: 'Media team' },
    { ref: 's2', level: 'step', name: 'Feed', parent: 'f2', owner: '@pod-dev', done_when: 'feed works' },
  ]);
  await ana.start(id);
  // Podcasts gets an ambiguity; Audio books gets the fake AI's contradiction for its done_when.
  ai.state.reviewFindings = (user) => (user.includes('id: podcasts') ? [{ kind: 'ambiguity', field: 'steps[0].done_when', message: '"feed works" is vague.', suggestion: 'Say which apps show it.' }] : null);
  try {
    const checked = (await ana.check()).body.review;
    assert.equal(item(checked, 's1').check.state, 'blocked');
    assert.equal(item(checked, 's1').check.findings[0].kind, 'contradiction');
    assert.equal(item(checked, 'f1').check.state, 'blocked');
    assert.equal(item(checked, 's2').check.state, 'ready');
    assert.equal(item(checked, 's2').check.findings[0].kind, 'ambiguity');
    assert.equal(item(checked, 's2').check.findings[0].suggestion, 'Say which apps show it.');
    const r = await ana.approve();
    assert.deepEqual(r.body.results.map((x) => [x.id, x.outcome]), [['podcasts', 'published']]);
    assert.equal(repoFile('features/audio-books.yaml'), undefined);
  } finally { ai.state.reviewFindings = null; }
});

test('with the AI provider unavailable, the review is reported as not run and valid items still publish', async () => {
  const id = analysis([
    { ref: 'f1', level: 'feature', name: 'Book clubs', owner: 'Social team' },
    { ref: 's1', level: 'step', name: 'Club pages', parent: 'f1', owner: '@club-dev', done_when: 'pages live' },
  ]);
  await ana.start(id);
  ai.state.down = true;
  try {
    const checked = (await ana.check()).body;
    assert.equal(item(checked.review, 'f1').check.state, 'ready');
    assert.equal(item(checked.review, 'f1').check.review_ran, false);
    assert.match(item(checked.review, 'f1').check.review_note, /did not run/);
    assert.match(checked.review.plan[0].review_note, /did not run/);
    const r = await ana.approve();
    assert.deepEqual(r.body.results.map((x) => [x.id, x.outcome]), [['book-clubs', 'published']]);
  } finally { ai.state.down = false; }
});

test('when the repo is unreachable, items go to the outbox, the person is told they publish later, and they do once it is back', async () => {
  const id = analysis([
    { ref: 'p1', level: 'project', name: 'Kids corner', owner: 'Kids team' },
    { ref: 'f1', level: 'feature', name: 'Kids profiles', parent: 'p1', owner: 'Kids team' },
    { ref: 's1', level: 'step', name: 'Profile picker', parent: 'f1', owner: '@kids-dev', done_when: 'picker live' },
  ]);
  await ana.start(id);
  await ana.review(); // write access is known before the repo goes away
  gh.state.down = true;
  let r;
  try {
    r = await ana.approve();
  } finally { gh.state.down = false; }
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results.map((x) => [x.kind, x.outcome]), [['project', 'queued'], ['feature', 'queued']]);
  assert.match(r.body.results[1].message, /will be published once the repo is reachable again/);
  assert.equal(repoFile('features/kids-profiles.yaml'), undefined);
  assert.ok(item(r.body.review, 'f1').published.queued);

  const back = await ana.get('/api/roadmap'); // the next refresh publishes them, project first
  assert.equal(back.feature_outbox.length, 0);
  assert.match(repoFile('projects/kids-corner.yaml'), /name: Kids corner/);
  assert.match(repoFile('features/kids-profiles.yaml'), /^project: kids-corner$/m);
  assert.ok(back.features.some((f) => f.feature.id === 'kids-profiles'));
  const later = (await ana.review()).review;
  assert.ok(later.items.every((it) => it.published && !it.published.queued), 'the review sees they were published');
});

test('a queued item whose outbox entry ends in a conflict comes back to the review with the error, and the entry is dropped', async () => {
  const id = analysis([
    { ref: 'p1', level: 'project', name: 'Music room', owner: 'Music team' },
    { ref: 'f1', level: 'feature', name: 'Playlists', parent: 'p1', owner: 'Music team' },
    { ref: 's1', level: 'step', name: 'Playlist API', parent: 'f1', owner: '@music-dev', done_when: 'API live' },
  ]);
  await ana.start(id);
  await ana.review();
  gh.state.down = true;
  let r;
  try { r = await ana.approve(); } finally { gh.state.down = false; }
  assert.deepEqual(r.body.results.map((x) => x.outcome), ['queued', 'queued']);
  // A teammate creates the same project before this machine reaches the repo again.
  gh.state.files.get(DATA).set('projects/music-room.yaml', 'id: music-room\nname: Music room\nowner: Someone else\n');
  await ana.get('/api/roadmap'); // the next refresh tries the outbox
  const p1 = item((await ana.review()).review, 'p1');
  const outbox = (await ana.get('/api/roadmap')).feature_outbox;
  assert.ok(!outbox.some((e) => e.project_id === 'music-room'), 'no hidden project entry is left in the outbox');
  assert.equal(p1.published, null);
  assert.equal(p1.result.outcome, 'conflict');
  assert.match(p1.result.message, /created by someone else/);
  assert.match(repoFile('projects/music-room.yaml'), /Someone else/, 'nothing overwritten');
});

test('a project put into the existing one: its features go there, and once they are published the review is done', async () => {
  const id = analysis([
    { ref: 'p1', level: 'project', name: 'Reading', owner: 'Catalog team', possible_duplicate: { id: 'reading', name: 'Reading app', kind: 'project' } },
    { ref: 'f1', level: 'feature', name: 'Shelf sharing', parent: 'p1', owner: 'Catalog team' },
    { ref: 's1', level: 'step', name: 'Share pages', parent: 'f1', owner: '@shelf-dev', done_when: 'pages live' },
  ]);
  await ana.start(id);
  await ana.edit({ p1: { duplicate_choice: 'merge' } });
  const checked = (await ana.check()).body;
  assert.equal(item(checked.review, 'p1').check.state, 'merged');
  assert.equal(checked.ready, 1, 'only the feature is a file to publish');
  const r = await ana.approve();
  assert.deepEqual(r.body.results.map((x) => [x.kind, x.id, x.outcome]), [['feature', 'shelf-sharing', 'published']]);
  assert.match(repoFile('features/shelf-sharing.yaml'), /^project: reading$/m);
  assert.equal(repoFile('projects/reading.yaml'), 'id: reading\nname: Reading app\nowner: Catalog team\n', 'the existing project is not touched');
  assert.deepEqual(item(r.body.review, 'p1').published, { ...item(r.body.review, 'p1').published, kind: 'project', op: 'merge', id: 'reading' });
  assert.ok(r.body.review.items.every((it) => it.published), 'nothing left to publish');
  const next = await ana.post('/api/import/review', { analysis_id: analysis([{ ref: 'f9', level: 'feature', name: 'Other' }]) });
  assert.equal(next.body.outcome, 'started', 'a new review does not ask to replace a finished one');
});

test('a feature added to an existing one with no step left to add needs a fix, instead of failing at Approve', async () => {
  const id = analysis([
    { ref: 'f1', level: 'feature', name: 'Checkout again', owner: 'Payments team', possible_duplicate: { id: 'checkout', name: 'Checkout', kind: 'feature' } },
    { ref: 's1', level: 'step', name: 'Pay later', parent: 'f1', owner: '@pay-dev', done_when: 'live' },
  ]);
  await ana.start(id);
  await ana.edit({ f1: { duplicate_choice: 'merge' }, s1: { included: false } });
  const checked = (await ana.check()).body;
  assert.equal(item(checked.review, 'f1').check.state, 'invalid');
  assert.match(item(checked.review, 'f1').check.errors[0].message, /nothing to add to the existing feature Checkout/);
  assert.equal(checked.ready, 0);
});

test('a feature whose new project is not ready is not ready either, and Approve publishes nothing', async () => {
  const id = analysis([
    { ref: 'p1', level: 'project', name: 'Reading two', owner: 'Catalog team', possible_duplicate: { id: 'reading', name: 'Reading app', kind: 'project' } },
    { ref: 'f1', level: 'feature', name: 'Reading goals', parent: 'p1', owner: 'Catalog team' },
    { ref: 's1', level: 'step', name: 'Goal API', parent: 'f1', owner: '@goal-dev', done_when: 'live' },
  ]);
  await ana.start(id);
  const checked = (await ana.check()).body;
  assert.equal(item(checked.review, 'f1').check.state, 'invalid');
  assert.match(item(checked.review, 'f1').check.errors.find((e) => e.field === 'parent').message, /new project "Reading two" can't be created yet/);
  assert.equal(checked.ready, 0);
  const commits = gh.state.commits.length;
  const r = await ana.approve();
  assert.deepEqual(r.body.results, []);
  assert.equal(gh.state.commits.slice(commits).filter((c) => /^(features|projects)\//.test(c.path)).length, 0);
});

test('a person with read-only access sees Approve refused, with the reason', async () => {
  const id = analysis([{ ref: 'f1', level: 'feature', name: 'Read only idea', owner: 'Someone' }]);
  await cy.start(id);
  const view = await cy.review();
  assert.equal(view.access.can_edit, false);
  assert.match(view.access.reason, /read-only access to team\/LifeCycle-Data/);
  const commits = gh.state.commits.length;
  const r = await cy.approve();
  assert.equal(r.status, 403);
  assert.equal(r.body.outcome, 'read_only');
  assert.match(r.body.message, /read-only access/);
  assert.equal(gh.state.commits.length, commits);
});

test('edits survive leaving the screen, a reload and a LifeCycle restart', async () => {
  const id = analysis([{ ref: 'f1', level: 'feature', name: 'Night mode', owner: 'AI guess' }, { ref: 'f2', level: 'feature', name: 'Fonts', owner: 'x' }]);
  await ana.start(id);
  await ana.edit({ f1: { owner: 'Reader team', target_date: '2027-03-01' }, f2: { included: false } });
  const again = await person('ana-again', { login: 'ana', home: ana.home });
  try {
    const r = (await again.review()).review;
    assert.equal(item(r, 'f1').owner, 'Reader team');
    assert.equal(item(r, 'f1').target_date, '2027-03-01');
    assert.equal(item(r, 'f2').included, false);
  } finally { await again.close(); }
  // Starting a review of another analysis asks first: the edits would be lost.
  const other = analysis([{ ref: 'x', level: 'feature', name: 'Other', owner: 'y' }]);
  const asked = await ana.post('/api/import/review', { analysis_id: other });
  assert.equal(asked.status, 409);
  assert.equal(asked.body.outcome, 'has_review');
});

test('a failed item keeps its error inline (a file created meanwhile); the others still publish; fixing the id and approving again publishes it', async () => {
  const id = analysis([
    { ref: 'f1', level: 'feature', name: 'Shelves', owner: 'Catalog team' },
    { ref: 'f2', level: 'feature', name: 'Bookmarks', owner: 'Catalog team' },
  ]);
  await ana.start(id);
  assert.equal((await ana.check()).body.ready, 2);
  gh.state.files.get(DATA).set('features/bookmarks.yaml', 'id: bookmarks\nname: Bookmarks\nowner: Someone else\nsteps: []\n');
  const r = await ana.approve();
  assert.deepEqual(r.body.results.map((x) => [x.id, x.outcome]), [['shelves', 'published']]);
  const f2 = item(r.body.review, 'f2');
  assert.equal(f2.published, null);
  assert.equal(f2.check.state, 'invalid');
  assert.equal(f2.check.errors[0].field, 'id');
  assert.match(repoFile('features/bookmarks.yaml'), /Someone else/, 'nothing overwritten');

  await ana.edit({ f2: { id: 'reader-bookmarks' } });
  const again = await ana.approve();
  assert.deepEqual(again.body.results.map((x) => [x.id, x.outcome]), [['reader-bookmarks', 'published']]);
});
