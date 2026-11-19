// "Ask answers questions about how initiatives are going", end to end: the real app, server, ask
// service and MCP handler against a fake GitHub and a fake flag console. An initiative is a
// LifeCycle project. No network, no real credentials.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startWorld, DATA, CATALOG } from './last-mile-fixture.js';
import { createApp } from '../src/app.js';
import { createServer } from '../src/server.js';
import { createAskService } from '../src/ask/service.js';
import { createMcpHandler } from '../src/mcp.js';
import { checkLead } from '../src/ask/answer.js';
import { DEFAULTS } from '../src/config.js';

let w, home, app, ask, lc, localConfig;
const step = (n, owner = '@dev') => `  - { id: development, name: Development, owner: "${owner}", done_when: merged with CI passing, evidence: [{ source: github, type: pr, repo: ${CATALOG}, number: ${n} }] }`;
const withProject = (text, project) => text.replace(/^owner:/m, `project: ${project}\nowner:`);

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-ask-projects-'));
  process.env.LIFECYCLE_HOME = home;
  w = await startWorld();
  const files = w.gh.state.files.get(DATA);
  // Initiatives:
  //  Redeem rewards (same name as a feature): two features waiting on the same release, one flowing.
  //  Loyalty program: everything merged; Rewards points is deployed with its flag off in production.
  //  Releases: the release both Redeem rewards features wait on (outside dependency).
  //  Wishlist: reading-history's PR source goes down in one test.  Empty bet: no features yet.
  files.set('projects/redeem-rewards.yaml', 'id: redeem-rewards\nname: Redeem rewards\nowner: Mobile team\n');
  files.set('projects/loyalty.yaml', 'id: loyalty\nname: Loyalty program\nowner: Growth team\n');
  files.set('projects/releases.yaml', 'id: releases\nname: Releases\nowner: Release team\n');
  files.set('projects/wishlist.yaml', 'id: wishlist\nname: Wishlist\nowner: Wishlist team\n');
  files.set('projects/empty-bet.yaml', 'id: empty-bet\nname: Empty bet\nowner: Strategy\n');
  files.set('features/redeem-rewards.yaml', ['id: redeem-rewards', 'name: Redeem rewards', 'project: redeem-rewards', 'owner: Catalog team', 'target_date: 2026-11-13',
    'depends_on: [rewards-release]', 'services: [catalog-api]', 'flags: [redeem_rewards]', 'steps:', step(2)].join('\n') + '\n');
  files.set('features/split-catalog.yaml', ['id: split-catalog', 'name: Split catalog', 'project: redeem-rewards', 'owner: Catalog team',
    'depends_on: [rewards-release]', 'steps:', step(10)].join('\n') + '\n');
  files.set('features/rewards-release.yaml', ['id: rewards-release', 'name: Release 0.2.1', 'project: releases', 'owner: Release team', 'steps:', step(9, '@releaser')].join('\n') + '\n');
  files.set('features/reader-redesign.yaml', withProject(files.get('features/reader-redesign.yaml'), 'redeem-rewards'));
  for (const id of ['rewards', 'referral-bonus', 'loyalty-tiers']) files.set(`features/${id}.yaml`, withProject(files.get(`features/${id}.yaml`), 'loyalty'));
  for (const id of ['wishlist-share', 'reading-history']) files.set(`features/${id}.yaml`, withProject(files.get(`features/${id}.yaml`), 'wishlist'));
  w.gh.state.prs.set(`${CATALOG}#9`, { title: 'chore: release 0.2.1', state: 'open', merged_at: null, head: { sha: 'head9' } });
  w.gh.state.prs.set(`${CATALOG}#10`, { title: 'Split catalog', state: 'open', merged_at: null, head: { sha: 'head10' } });

  localConfig = { ai: { ...DEFAULTS.ai, provider: 'none' }, me: { owners: ['@dev'] }, atRiskDays: 14 };
  app = createApp({ alwaysLive: true, config: { ...w.config, atRiskDays: 14 }, token: w.gh.token, flagsmithApiKey: w.fs.apiKey });
  ask = createAskService({ app, readConfig: () => localConfig });
  const server = createServer(app, ask);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  lc = { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) };
});

after(async () => {
  await lc.close();
  await w.close();
});

const askHttp = async (question) => {
  const res = await fetch(`${lc.url}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question }) });
  assert.equal(res.status, 200);
  return res.json();
};
const statements = (a) => a.sections.flatMap((s) => s.statements);
const section = (a, id) => a.sections.find((s) => s.id === id)?.statements || [];
const projectStatus = async (id) => (await fetch(`${lc.url}/api/projects/${id}/status`)).json();

test('"How is <initiative> going?" gives the combined state and per-state counts the project endpoint reports', async () => {
  for (const [q, id] of [['How is the Loyalty program initiative going?', 'loyalty'], ['How is the Redeem rewards project going?', 'redeem-rewards'], ['How is the Releases initiative going?', 'releases']]) {
    const a = await askHttp(q);
    const p = await projectStatus(id);
    assert.equal(a.outcome, 'answered', q);
    assert.equal(a.scope, 'project');
    assert.equal(a.project.id, id);
    assert.equal(a.feature, null);
    assert.equal(a.project_state.rollup_state, p.state);
    assert.equal(a.project_state.state, p.state);
    assert.deepEqual(a.project_state.counts, p.counts);
    const overall = section(a, 'overall')[0];
    assert.equal(overall.state, p.state);
    assert.deepEqual(overall.counts, p.counts);
    assert.ok(overall.evidence.some((e) => e.link === `/api/projects/${id}/status`));
    assert.ok(a.lead.cites.includes(overall.id));
  }
});

test('the same statements and evidence links from the AI tools (MCP) as from the app', async () => {
  const handle = createMcpHandler({ app, ask });
  for (const q of ['How is the Redeem rewards project going?', 'Which initiatives are blocked?']) {
    const viaTools = (await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'lifecycle_ask', arguments: { question: q } } })).result;
    const viaApp = await askHttp(q);
    const strip = (a) => JSON.parse(JSON.stringify({ ...a, asked_at: null }, (k, v) => (k.endsWith('read_at') || k === 'unavailable_since' ? undefined : v)));
    assert.deepEqual(strip(viaTools.structuredContent), strip(viaApp));
    // The markdown an AI tool relays carries every evidence link.
    for (const s of statements(viaApp)) for (const e of s.evidence) assert.ok(viaTools.content[0].text.includes(e.link), `${q}: ${e.link}`);
  }
  const log = fs.readFileSync(path.join(home, 'logs', 'ask.log'), 'utf8');
  assert.match(log, /"via":"ai-tools","feature":null,"project":"redeem-rewards","outcome":"answered"/);
});

test('"What\'s blocking <initiative>?" names the blocked features, the blocker once, the owner to push and the PR', async () => {
  const a = await askHttp('What\'s blocking the Redeem rewards project?');
  assert.equal(a.intent, 'blockers');
  const bl = section(a, 'blockers');
  // Redeem rewards and Split catalog share the same blocker: it appears once, naming both.
  assert.equal(bl.length, 1);
  assert.match(bl[0].text, /^Redeem rewards and Split catalog are blocked by "Development" of Release 0\.2\.1 \(PR #9 in team\/catalog\)\. Push: @releaser\.$/);
  assert.deepEqual(bl[0].blocked_features, ['redeem-rewards', 'split-catalog']);
  assert.ok(bl[0].evidence.some((e) => e.link === `https://github.com/${CATALOG}/pull/9`));
  assert.equal(a.blockers.length, 1);
  assert.equal(a.blockers[0].owner, '@releaser');
  assert.match(a.lead.text, /Push @releaser/);
  // The blocker link is the real PR in GitHub.
  const pr = w.gh.state.prs.get(`${CATALOG}#9`);
  assert.equal(pr.state, 'open');
  // It depends on work in another initiative.
  assert.ok(section(a, 'outside').some((s) => /Redeem rewards and Split catalog depend on Release 0\.2\.1 in Releases/.test(s.text)));
});

test('"What\'s left?" lists the features not done and the current step of each; target dates and risk', async () => {
  const a = await askHttp('What\'s left before the Redeem rewards initiative is done?');
  assert.equal(a.intent, 'progress');
  const rem = section(a, 'remaining');
  assert.match(rem[0].text, /^3 of 3 features aren't done yet\.$/);
  assert.ok(rem.some((s) => s.feature === 'reader-redesign' && /current step "Development" \(@dev\), in progress/.test(s.text)));
  // A target date close enough is flagged, naming the feature that puts it at risk.
  const risk = section(a, 'schedule').find((s) => s.at_risk);
  assert.deepEqual(risk.at_risk, ['redeem-rewards']);
  assert.match(risk.text, /Redeem rewards \(2026-11-13/);
  // No feature of Loyalty program has a target date: no dates, no risk.
  const b = await askHttp('How is the Loyalty program initiative going?');
  assert.deepEqual(section(b, 'schedule'), []);
  assert.doesNotMatch(b.lead.text, /risk|target/i);
});

test('"Which initiatives are blocked?" lists exactly the blocked initiatives, each with a one-line reason', async () => {
  const a = await askHttp('Which initiatives are blocked?');
  assert.equal(a.scope, 'projects');
  const ids = ['empty-bet', 'loyalty', 'redeem-rewards', 'releases', 'wishlist'];
  const blocked = [];
  for (const id of ids) if ((await projectStatus(id)).state === 'blocked') blocked.push(id);
  assert.deepEqual(section(a, 'projects').map((s) => s.project), blocked);
  assert.deepEqual(blocked, ['redeem-rewards']);
  assert.match(section(a, 'projects')[0].text, /^Redeem rewards: blocked\. Redeem rewards and Split catalog blocked by Release 0\.2\.1\.$/);
  const every = await askHttp('Give me a status of all initiatives');
  assert.deepEqual(section(every, 'projects').map((s) => s.project).sort(), ['empty-bet', 'loyalty', 'redeem-rewards', 'releases', 'wishlist']);
  const flowing = await askHttp('What\'s flowing?');
  assert.deepEqual(section(flowing, 'projects').map((s) => s.project), ['releases']);
});

test('last mile: a deployed feature with its flag off in production is named as done but not turned on, linked to the flag', async () => {
  const a = await askHttp('Is the Loyalty program initiative really in users\' hands?');
  assert.equal(a.intent, 'availability');
  const off = section(a, 'last_mile').find((s) => s.feature === 'rewards');
  assert.match(off.text, /^Rewards points: Done but not turned on\./);
  assert.ok(off.evidence.some((e) => e.label.startsWith('rewards_enabled in production') && e.link.startsWith(DEFAULTS.sources.flagsmith.appUrl)), JSON.stringify(off.evidence));
  assert.match(a.lead.text, /Rewards points: Done but not turned on/);
});

test('a source behind a feature is down: that feature is unavailable since its last good read, and the initiative is not done', async () => {
  const before = await askHttp('How is the Wishlist initiative going?');
  assert.equal(before.project_state.state, 'done');
  w.gh.state.downPaths.push(/\/pulls\/5$/);
  try {
    const a = await askHttp('How is the Wishlist initiative going?');
    assert.notEqual(a.project_state.state, 'done');
    assert.doesNotMatch(a.lead.text, /\bis done\b/);
    const u = section(a, 'unavailable').find((s) => s.feature === 'reading-history');
    assert.ok(u, JSON.stringify(a.sections));
    assert.match(u.text, /^Reading history: status unavailable, last read fine \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\./);
    assert.ok(u.last_successful_read_at);
    assert.match(u.text, /not counted as done or on/);
  } finally {
    w.gh.state.downPaths.pop();
  }
});

test('names: no match says so with close matches; a name shared by a feature and an initiative asks which one', async () => {
  const a = await askHttp('How is the Loyality progam initiative going?');
  assert.equal(a.outcome, 'answered'); // one typo per word still matches
  const u = await askHttp('How is the reader initiative going?');
  assert.equal(u.outcome, 'unknown_project');
  assert.match(u.lead.text, /^I couldn't find that initiative \("reader"\)\. The initiatives I know: /);
  const close = await askHttp('How is the Loyalty bonus initiative going?');
  assert.equal(close.outcome, 'unknown_project');
  assert.deepEqual(close.closest.map((c) => c.id), ['loyalty']);
  assert.match(close.lead.text, /Closest matches: Loyalty program\./);

  const both = await askHttp('How is redeem rewards going?');
  assert.equal(both.outcome, 'clarify');
  assert.match(both.lead.text, /both a feature and a project/);
  assert.deepEqual(both.candidates.map((c) => c.kind), ['feature', 'project']);
  // Each choice re-asks unambiguously.
  const f = await askHttp(both.candidates[0].ask);
  assert.equal(f.feature.id, 'redeem-rewards');
  const p = await askHttp(both.candidates[1].ask);
  assert.equal(p.project.id, 'redeem-rewards');
});

test('an initiative with no features is "not started, no features yet"; features without an initiative can be asked about', async () => {
  const a = await askHttp('How is the Empty bet initiative going?');
  assert.equal(a.outcome, 'answered');
  assert.equal(a.lead.text, 'Empty bet is not started, no features yet.');
  // Every feature here belongs to an initiative: said so, not an error.
  const n = await askHttp('How are features without an initiative going?');
  assert.equal(n.outcome, 'answered');
  assert.equal(n.project.id, null);
  assert.match(n.lead.text, /^There are no features without an initiative/);
  // One feature without an initiative: it is counted there, as the "No project" group of the endpoint.
  const files = w.gh.state.files.get(DATA);
  files.set('features/book-clubs.yaml', ['id: book-clubs', 'name: Book clubs', 'owner: Catalog team', 'steps:', step(11)].join('\n') + '\n');
  w.gh.state.prs.set(`${CATALOG}#11`, { title: 'Book clubs', state: 'open', merged_at: null, head: { sha: 'head11' } });
  try {
    const g = await askHttp('How are features without an initiative going?');
    const none = await projectStatus('none');
    assert.deepEqual(g.project_state.counts, none.counts);
    assert.ok(section(g, 'remaining').some((s) => s.feature === 'book-clubs'));
  } finally {
    files.delete('features/book-clubs.yaml');
  }
});

test('every number or date in an initiative lead appears in a statement it cites', async () => {
  const qs = ['How is the Redeem rewards project going?', 'What\'s blocking the Redeem rewards project?', 'What\'s left before the Redeem rewards initiative is done?',
    'Is the Loyalty program initiative really in users\' hands?', 'Is the Redeem rewards initiative at risk of missing its target date?', 'Which initiatives are blocked?',
    'Give me a status of all initiatives', 'How is the Releases initiative going?', 'How are features without an initiative going?'];
  for (const q of qs) {
    const a = await askHttp(q);
    assert.equal(a.outcome, 'answered', q);
    assert.ok(a.lead.cites.length, q);
    assert.equal(checkLead(a.lead, statements(a)), null, `${q}: ${a.lead.text}`);
    for (const s of statements(a)) assert.ok(s.evidence.length && s.evidence.every((e) => e.link), `${q}: ${s.id} ${s.text}`);
  }
});

test('stale definitions: the answer says so and when they were last read', async () => {
  await askHttp('How is the Releases initiative going?');
  w.gh.state.down = true;
  try {
    const a = await askHttp('How is the Releases initiative going?');
    const f = a.freshness.find((x) => x.source === 'shared repo');
    assert.ok(f, JSON.stringify(a.freshness));
    assert.match(f.text, /last sync at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
  } finally {
    w.gh.state.down = false;
  }
});

test('the digest summarises each initiative: combined state and features that changed state, with evidence', async () => {
  const digest = async () => (await fetch(`${lc.url}/api/digest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  const first = await digest();
  assert.ok(first.projects.some((p) => p.id === 'redeem-rewards' && p.items[0].kind === 'now'));
  w.gh.state.prs.set(`${CATALOG}#9`, { title: 'chore: release 0.2.1', state: 'closed', merged_at: '2026-11-04T10:00:00Z', merge_commit_sha: 'aaa9', head: { sha: 'head9' } });
  try {
    const d = await digest();
    const rr = d.projects.find((p) => p.id === 'redeem-rewards');
    const moved = rr.items.find((i) => i.kind === 'project_moved');
    assert.match(moved.text, /^Redeem rewards: blocked → flowing\.$/);
    assert.ok(moved.evidence.some((e) => e.link === '/api/projects/redeem-rewards/status'));
    const feat = rr.items.find((i) => i.kind === 'feature_moved' && /^Split catalog: blocked → flowing\.$/.test(i.text));
    assert.ok(feat && feat.evidence.some((e) => e.link === `https://github.com/${CATALOG}/pull/10`));
    // Feature content of the digest is unchanged in shape.
    assert.ok(Array.isArray(d.features) && d.features.every((f) => f.items));
  } finally {
    w.gh.state.prs.set(`${CATALOG}#9`, { title: 'chore: release 0.2.1', state: 'open', merged_at: null, head: { sha: 'head9' } });
  }
});

test('initiative questions are kept in the local history and logged without tokens', async () => {
  const asks = fs.readFileSync(path.join(home, 'history', 'asks.jsonl'), 'utf8');
  assert.match(asks, /Which initiatives are blocked\?/);
  for (const f of ['logs/ask.log', 'history/asks.jsonl']) {
    const text = fs.readFileSync(path.join(home, f), 'utf8');
    assert.ok(!text.includes(w.gh.token), f);
    assert.ok(!text.includes(w.fs.apiKey), f);
  }
});

test('constraint: Ask never creates a PRD, from the app or the AI tools, and writes nothing', async () => {
  const files = w.gh.state.files.get(DATA);
  const before = [...files.keys()].sort();
  const handle = createMcpHandler({ app, ask });
  for (const q of ['Create a PRD for the Redeem rewards initiative', 'Write a PRD for the loyalty project',
    'Can you draft a product requirements document for Loyalty program?', 'Generate PRD for Rewards points']) {
    const a = await askHttp(q);
    assert.equal(a.outcome, 'not_allowed', q);
    assert.equal(a.intent, 'prd');
    assert.match(a.lead.text, /^I can't create a PRD here\./);
    assert.deepEqual(a.sections, []);
    const viaTools = (await handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'lifecycle_ask', arguments: { question: q } } })).result;
    assert.equal(viaTools.structuredContent.outcome, 'not_allowed');
  }
  assert.deepEqual([...files.keys()].sort(), before);
  // Questions that only mention the word still get their normal answer.
  assert.equal((await askHttp('How is the Redeem rewards project going?')).outcome, 'answered');
});
