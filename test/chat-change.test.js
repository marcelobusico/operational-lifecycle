// Creating, editing and deleting features from LifeCycle's chat: walks the acceptance
// criteria with three teammates (each with their own LifeCycle home and GitHub identity) against a
// fake GitHub and a fake AI provider. ana and bo can write to the shared repo; cy can only read.
// The chat goes through the app (POST /api/ask) and through the AI tools (MCP lifecycle_ask), and
// saves through the same publish path as the form.
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
import { createMcpHandler } from '../src/mcp.js';
import { DEFAULTS } from '../src/config.js';

const DATA = 'team/LifeCycle-Data';
const APP = 'team/catalog';
let gh, ai, ana, bo, cy;

async function person(name, { login }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `lifecycle-chat-${name}-`));
  const config = { ...DEFAULTS, dataRepo: DATA, me: { owners: [], github: null },
    ai: { ...DEFAULTS.ai, provider: 'openai-compatible', apiUrl: ai.url, model: 'fake-model', timeoutMs: 5000 },
    sources: { github: { enabled: true, apiUrl: gh.url }, flagsmith: { ...DEFAULTS.sources.flagsmith, enabled: false } } };
  process.env.LIFECYCLE_HOME = home;
  const app = createApp({ alwaysLive: true, config, token: gh.token, flagsmithApiKey: null });
  const service = createAskService({ app, readConfig: () => config });
  const server = createServer(app, service);
  const mcp = createMcpHandler({ app, ask: service });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const as = () => { process.env.LIFECYCLE_HOME = home; gh.state.login = login; };
  const call = async (method, p, body) => {
    as();
    const res = await fetch(url + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  let n = 0;
  return {
    login,
    get: (p) => call('GET', p).then((r) => r.body),
    put: (p, body = {}) => call('PUT', p, body),
    post: (p, body = {}) => call('POST', p, body),
    open: (id) => call('GET', `/api/features/${id}/definition`).then((r) => r.body),
    // A new conversation in the app's chat: say(text) sends one message in it.
    chat: () => {
      const session = `t-${name}-${++n}`;
      return async (question) => (await call('POST', '/api/ask', { question, session })).body;
    },
    // The same chat from the person's own AI tool.
    tool: async (question, session) => { as(); return mcp({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name: 'lifecycle_ask', arguments: { question, ...(session ? { session } : {}) } } }); },
    close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }),
  };
}

const step = (id, owner, pr) => `  - id: ${id}\n    name: ${id[0].toUpperCase()}${id.slice(1)}\n    owner: "${owner}"\n    done_when: merged to main\n` +
  (pr ? `    evidence:\n      - { source: github, type: pr, repo: ${APP}, number: ${pr} }\n` : '');
const repoFile = (p) => gh.state.files.get(DATA).get(p);
const commitsFor = (p) => gh.state.commits.filter((c) => c.repo === DATA && c.path === p);
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
    ['features/redeem-rewards.yaml', `# Redeeming reading points in the reader.\nid: redeem-rewards\nname: Redeem rewards\nowner: Mobile team\ndepends_on: [rewards]\ntarget_date: 2026-12-01\nservices: [catalog-api]\nsteps:\n${step('development', '@redeem-dev', 5)}${step('release', 'Release team')}`],
    ['features/loyalty.yaml', `id: loyalty\nname: Loyalty tiers\nowner: Growth team\nsteps:\n${step('development', '@loyalty-dev', 6)}`],
    ['features/wishlist.yaml', `id: wishlist\nname: Wishlist\nowner: Wishlist team\nsteps: []\n`],
    ['features/wishlist-share.yaml', `id: wishlist-share\nname: Wishlist share\nowner: Wishlist team\ndepends_on: [wishlist]\nsteps: []\n`],
  ]));
  for (const n of [4, 5, 6, 7]) gh.state.prs.set(`${APP}#${n}`, { title: `PR ${n}`, state: 'open', merged_at: null });
  ana = await person('ana', { login: 'ana' }); // product manager, write access
  bo = await person('bo', { login: 'bo' });    // engineering manager, write access
  cy = await person('cy', { login: 'cy' });    // developer with read-only access to the shared repo
});
after(async () => { await ana.close(); await bo.close(); await cy.close(); await ai.close(); await gh.close(); });

test('creating "Bonus points on reviews" in the chat: one question at a time, a full preview, then a commit by that person', async () => {
  const say = ana.chat();
  const commits = gh.state.commits.length;
  let r = await say('create a feature called Bonus points on reviews, owned by @ana, depends on redeem rewards');
  assert.equal(r.kind, 'change');
  assert.equal(r.outcome, 'ask_field');
  assert.match(r.text, /New feature "Bonus points on reviews", id bonus-points-on-reviews/, 'the id derived from the name is shown before saving');
  assert.equal(r.ask.field, 'steps[0].name');
  r = await say('Development');
  assert.equal(r.ask.field, 'steps[0].owner');
  assert.equal(r.ask.suggestion, '@ana', 'it suggests a value where it can');
  r = await say('yes');
  assert.equal(r.ask.field, 'steps[0].done_when');
  r = await say('Bonus points are given for every review, merged to main with tests');
  assert.equal(r.outcome, 'preview');
  assert.equal(r.can_confirm, true);
  assert.equal(r.proposal.path, 'features/bonus-points-on-reviews.yaml');
  assert.match(r.proposal.text, /^name: Bonus points on reviews$/m, 'the full proposed definition is shown');
  assert.match(r.proposal.text, /depends_on:\n {2}- redeem-rewards/);
  assert.equal(r.proposal.review.ran, true, 'the same AI product review as the form ran');
  assert.ok(ai.state.requests.some((x) => x.body.messages?.[0]?.content.includes('review a LifeCycle feature definition')));
  assert.ok(r.proposal.suggestions.some((s) => s.field === 'services' && s.value.includes('catalog-api')), 'it suggests services from what it depends on');
  assert.equal(gh.state.commits.length, commits, 'nothing is committed before the person confirms');

  r = await say('yes');
  assert.equal(r.outcome, 'saved', r.text);
  const [c] = commitsFor('features/bonus-points-on-reviews.yaml');
  assert.equal(c.by, 'ana');
  assert.equal(c.op, 'create');
  assert.equal(c.message, 'Add feature bonus-points-on-reviews (by @ana from the LifeCycle chat)');
  assert.doesNotMatch(c.message, /\b(PM|EM|product manager|developer)\b/i, 'the role is not recorded');
  assert.match(repoFile('features/bonus-points-on-reviews.yaml'), /^name: Bonus points on reviews$/m);
  assert.match(repoFile('features/bonus-points-on-reviews.yaml'), /^owner: "@ana"$/m);
});

test('a teammate refreshing their own LifeCycle sees the new feature on the roadmap', async () => {
  const roadmap = await bo.get('/api/roadmap');
  const f = roadmap.features.find((x) => x.feature.id === 'bonus-points-on-reviews');
  assert.ok(f, 'the new feature is on bo\'s roadmap');
  assert.equal(f.feature.name, 'Bonus points on reviews');
});

test('declining at the confirmation step leaves the repo unchanged', async () => {
  const say = ana.chat();
  const commits = gh.state.commits.length;
  await say('create a feature called Instant payouts, owned by @ana');
  await say('Development');
  await say('@payouts-dev');
  const preview = await say('Payout API merged to main');
  assert.equal(preview.outcome, 'preview');
  const r = await say('no');
  assert.equal(r.outcome, 'declined');
  assert.match(r.text, /nothing was saved/i);
  assert.equal(gh.state.commits.length, commits);
  assert.equal(repoFile('features/instant-payouts.yaml'), undefined);
  assert.equal((await say('yes')).outcome, 'nothing_to_confirm', 'a later yes saves nothing');
  assert.equal(gh.state.commits.length, commits);
});

test('setting an empty owner on a step is blocked and the message names that field', async () => {
  const say = ana.chat();
  const commits = gh.state.commits.length;
  const r = await say('set the owner of step development of redeem rewards to empty');
  assert.equal(r.outcome, 'invalid');
  assert.equal(r.can_confirm, false);
  assert.match(r.text, /steps\[0\]\.owner/);
  assert.deepEqual(r.proposal.errors.map((e) => e.field), ['steps[0].owner']);
  assert.equal((await say('yes')).outcome, 'invalid', 'an invalid definition can\'t be saved');
  assert.equal(gh.state.commits.length, commits);
});

test('moving the target date of redeem rewards shows only that field, and the commit changes only that line', async () => {
  const say = ana.chat();
  const before = repoFile('features/redeem-rewards.yaml');
  const r = await say('move the target date of redeem rewards to 2027-02-15');
  assert.equal(r.outcome, 'preview');
  assert.deepEqual(r.proposal.diff, [{ field: 'target_date', label: 'Target date', from: '2026-12-01', to: '2027-02-15' }]);
  const saved = await say('yes');
  assert.equal(saved.outcome, 'saved', saved.text);
  const c = commitsFor('features/redeem-rewards.yaml').at(-1);
  assert.equal(c.by, 'ana');
  assert.equal(c.message, 'Edit feature redeem-rewards: target date (by @ana from the LifeCycle chat)');
  assert.deepEqual(lineDiff(before, repoFile('features/redeem-rewards.yaml')), { added: ['target_date: 2027-02-15'], removed: ['target_date: 2026-12-01'] });
  assert.match(repoFile('features/redeem-rewards.yaml'), /^# Redeeming reading points in the reader\.$/m, 'comments are kept');
  assert.match(repoFile('features/redeem-rewards.yaml'), /{ source: github, type: pr, repo: team\/catalog, number: 5 }/, 'evidence is kept');
});

test('deleting a feature others depend on lists them and needs a second confirmation; then one commit removes the file', async () => {
  const say = bo.chat();
  const commits = gh.state.commits.length;
  let r = await say('delete wishlist');
  assert.equal(r.outcome, 'preview');
  assert.deepEqual(r.proposal.dependents.map((d) => d.id), ['wishlist-share']);
  assert.match(r.text, /Wishlist share depends on it/);
  r = await say('yes');
  assert.equal(r.outcome, 'confirm_again');
  assert.match(r.text, /Wishlist share depends on Wishlist/);
  assert.equal(gh.state.commits.length, commits, 'the first yes deletes nothing');
  assert.ok(repoFile('features/wishlist.yaml'));
  r = await say('yes, delete it');
  assert.equal(r.outcome, 'saved', r.text);
  assert.equal(gh.state.commits.length, commits + 1, 'one commit');
  const c = gh.state.commits.at(-1);
  assert.deepEqual([c.op, c.path, c.by, c.message], ['delete', 'features/wishlist.yaml', 'bo', 'Delete feature wishlist (by @bo from the LifeCycle chat)']);
  assert.equal(repoFile('features/wishlist.yaml'), undefined);
});

test('a person with read-only access gets the explanation and no save option, and can still ask questions', async () => {
  const say = cy.chat();
  const commits = gh.state.commits.length;
  const r = await say('create a feature called Split bills, owned by @cy');
  assert.equal(r.outcome, 'read_only');
  assert.equal(r.can_confirm, false);
  assert.equal(r.proposal, null);
  assert.match(r.text, /read-only access to team\/LifeCycle-Data/);
  assert.match(r.text, /can still ask/);
  assert.equal((await say('yes')).outcome, 'nothing_to_confirm');
  const q = await say('How is redeem rewards going?');
  assert.equal(q.schema, 'lifecycle.answer/v1');
  assert.equal(q.feature.id, 'redeem-rewards');
  assert.equal(gh.state.commits.length, commits);
});

test('"mark step development as done" explains status is live and offers to attach a PR or issue to that step', async () => {
  const say = ana.chat();
  const commits = gh.state.commits.length;
  let r = await say('mark step development of redeem rewards as done');
  assert.equal(r.outcome, 'status_is_live');
  assert.match(r.text, /never typed in: it is read live/);
  assert.match(r.text, /Step "Development" of Redeem rewards is done when: merged to main/);
  assert.ok(r.offers.some((o) => /^attach PR #<number> in team\/catalog to step development of Redeem rewards$/.test(o)));
  // Without naming the feature: still the explanation, and the offer for each feature with that step.
  const bare = await ana.chat()('mark step development as done');
  assert.equal(bare.outcome, 'status_is_live');
  assert.match(bare.text, /read live/);
  assert.ok(bare.offers.some((o) => /attach PR .* to step development of Redeem rewards/.test(o)));
  assert.equal(gh.state.commits.length, commits, 'asking never changes anything');

  // Taking the offer: attaching a PR is a definition edit, previewed and confirmed like any other.
  const before = repoFile('features/redeem-rewards.yaml');
  r = await say('attach PR #7 in team/catalog to step development of redeem rewards');
  assert.equal(r.outcome, 'preview');
  assert.deepEqual(r.proposal.diff.map((d) => d.attached), [['PR team/catalog#7']]);
  r = await say('yes');
  assert.equal(r.outcome, 'saved', r.text);
  assert.deepEqual(lineDiff(before, repoFile('features/redeem-rewards.yaml')).added, ['      - { source: github, type: pr, repo: team/catalog, number: 7 }']);
});

test('one person in the chat and one in the form edit the same feature: the second save is told about the conflict and neither change is lost', async () => {
  const say = ana.chat();
  const preview = await say('set the description of loyalty tiers to Points that unlock perks at each tier');
  assert.equal(preview.outcome, 'preview');
  // Meanwhile bo saves an edit of the same feature in the form.
  const def = await bo.open('loyalty');
  const form = await bo.put('/api/features/loyalty', { draft: { ...def.draft, owner: 'Growth squad' }, base_hash: def.base_hash });
  assert.equal(form.status, 200, form.body.message);

  const r = await say('yes');
  assert.equal(r.outcome, 'conflict');
  assert.match(r.text, /@bo changed loyalty at .+ after you opened it\. Nothing was overwritten and your edit is kept on this machine/);
  assert.match(repoFile('features/loyalty.yaml'), /owner: Growth squad/, 'bo\'s change is in the repo');
  assert.doesNotMatch(repoFile('features/loyalty.yaml'), /description/);
  const kept = (await ana.get('/api/roadmap')).feature_outbox.find((e) => e.feature_id === 'loyalty');
  assert.equal(kept.state, 'conflict');
  assert.equal(kept.via, 'chat');
  assert.equal(kept.draft.description, 'Points that unlock perks at each tier', 'ana\'s change is kept on her machine');

  // Asking again applies it on top of the latest version: both changes end up in the repo.
  await say('set the description of loyalty tiers to Points that unlock perks at each tier');
  assert.equal((await say('yes')).outcome, 'saved');
  assert.match(repoFile('features/loyalty.yaml'), /owner: Growth squad/);
  assert.match(repoFile('features/loyalty.yaml'), /description: Points that unlock perks at each tier/);
  await ana.post(`/api/features-outbox/${kept.key}/discard`); // the refused copy, once its change is in the repo
});

test('with LifeCycle-Data unreachable a chat change shows "not saved yet" and is saved once the repo is back', async () => {
  const say = ana.chat();
  const preview = await say('set the owner of rewards to Rewards squad');
  assert.equal(preview.outcome, 'preview');
  gh.state.down = true;
  const r = await say('yes');
  assert.equal(r.outcome, 'not_saved_yet');
  assert.match(r.text, /^Not saved yet\. the shared repo can't be reached/i);
  assert.doesNotMatch(repoFile('features/rewards.yaml'), /Rewards squad/);
  const pending = (await ana.get('/api/roadmap')).feature_outbox.filter((e) => e.feature_id === 'rewards');
  assert.equal(pending[0].state, 'pending');

  gh.state.down = false;
  await ana.get('/api/roadmap'); // the next refresh saves it
  assert.match(repoFile('features/rewards.yaml'), /owner: Rewards squad/);
  const c = commitsFor('features/rewards.yaml').at(-1);
  assert.equal(c.by, 'ana');
  assert.equal(c.message, 'Edit feature rewards: owner (by @ana from the LifeCycle chat)');
});

test('a name that is taken or very close to an existing feature: the chat asks whether they meant that one', async () => {
  let say = ana.chat();
  let r = await say('create a feature called Loyalty tiers');
  assert.equal(r.outcome, 'name_taken');
  assert.match(r.text, /The name "Loyalty tiers" is already taken by the feature Loyalty tiers\. Did you mean that one\?/);
  r = await say('yes');
  assert.equal(r.outcome, 'ask_change', 'yes: carry on with the existing feature');
  assert.equal(r.feature.id, 'loyalty');
  say = ana.chat();
  r = await say('create a feature called Rewardss, owned by @ana');
  assert.equal(r.outcome, 'name_close');
  assert.match(r.text, /very close to Rewards\. Did you mean that one\?/);
  r = await say('no, create it');
  assert.equal(r.outcome, 'ask_field', 'a no carries on with the new feature');
});
