// "Ask the path" acceptance criteria, end to end: the real app, server, ask service and MCP
// handler against a fake GitHub, a fake flag console and fake AI providers. No network, no real
// credentials.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startWorld, DATA, CATALOG } from './last-mile-fixture.js';
import { startFakeAi } from './fake-ai.js';
import { createApp } from '../src/app.js';
import { createServer } from '../src/server.js';
import { createAskService } from '../src/ask/service.js';
import { createMcpHandler } from '../src/mcp.js';
import { checkLead } from '../src/ask/answer.js';
import { DEFAULTS } from '../src/config.js';

const FAKE_CLAUDE_KEY = 'fake-anthropic-key-not-a-real-credential';
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
let w, home, claude, openai, app, ask, lc, localConfig, untrackedBefore;

const untracked = () => execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--ignored'], { cwd: REPO_ROOT, encoding: 'utf8' })
  .split('\n').filter((l) => l && !l.includes('node_modules/'));

before(async () => {
  untrackedBefore = new Set(untracked());
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-ask-'));
  process.env.LIFECYCLE_HOME = home;
  process.env.ANTHROPIC_API_KEY = FAKE_CLAUDE_KEY;
  w = await startWorld();
  claude = await startFakeAi('claude');
  openai = await startFakeAi('openai');

  // "Redeem rewards" waits on a release whose PR is still open, has its own second PR,
  // a target date close enough to be at risk, two registered changes and an alert.
  const files = w.gh.state.files.get(DATA);
  files.set('features/redeem-rewards.yaml', [
    'id: redeem-rewards', 'name: Redeem rewards', 'owner: Catalog team', 'target_date: 2026-11-13',
    'depends_on: [rewards-release]', 'services: [catalog-api]', 'flags: [redeem_rewards]', 'steps:',
    `  - { id: development, name: Development, owner: "@dev", done_when: merged with CI passing, evidence: [{ source: github, type: pr, repo: ${CATALOG}, number: 2 }] }`,
    `  - { id: reader, name: Reader UI, owner: "@ui", done_when: merged with CI passing, evidence: [{ source: github, type: pr, repo: ${CATALOG}, number: 8 }] }`,
  ].join('\n') + '\n');
  files.set('features/rewards-release.yaml', [
    'id: rewards-release', 'name: Release 0.2.1', 'owner: Release team', 'steps:',
    `  - { id: release, name: Release 0.2.1, owner: "@releaser", done_when: release PR merged, evidence: [{ source: github, type: pr, repo: ${CATALOG}, number: 9 }] }`,
  ].join('\n') + '\n');
  files.set('changes/2026-11-02-rr-rollout-25.yaml', 'id: 2026-11-02-rr-rollout-25\nfeature: redeem-rewards\nkind: flag\nsummary: Rolled out to 25% of production users.\nregistered_by: "@example-dev"\nregistered_at: 2026-11-02T15:00:00Z\n');
  files.set('changes/2026-11-03-rr-needs-release.yaml', 'id: 2026-11-03-rr-needs-release\nfeature: redeem-rewards\nkind: dependency\nsummary: Now waits on release 0.2.1.\nregistered_by: "@pm"\nregistered_at: 2026-11-03T18:30:00Z\n');
  w.gh.state.prs.set(`${CATALOG}#8`, { title: 'Reader UI', state: 'open', merged_at: null, head: { sha: 'head8' } });
  w.gh.state.prs.set(`${CATALOG}#9`, { title: 'chore: release 0.2.1', state: 'open', merged_at: null, head: { sha: 'head9' } });

  const alertsFile = path.join(home, 'alerts.json');
  fs.writeFileSync(alertsFile, JSON.stringify({ schema: 'lifecycle.alerts/v1', alerts: [
    { id: 'alert-rr-dep', feature: 'redeem-rewards', kind: 'dependency', severity: 'warning', message: 'New dependency on release 0.2.1.', at: '2026-11-03T18:31:00Z', registered_change: '2026-11-03-rr-needs-release' },
  ] }));

  const config = { ...w.config, alerts: { source: alertsFile }, atRiskDays: 14 };
  // The person's local config: provider and identity. Tests change it the way a person would.
  localConfig = { ai: { ...DEFAULTS.ai, provider: 'claude', apiUrl: claude.url }, me: { owners: ['@dev'] }, atRiskDays: 14 };
  app = createApp({ config, token: w.gh.token, flagsmithApiKey: w.fs.apiKey });
  ask = createAskService({ app, readConfig: () => localConfig });
  const server = createServer(app, ask);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  lc = { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) };
});

after(async () => {
  await lc.close();
  await claude.close();
  await openai.close();
  await w.close();
  delete process.env.ANTHROPIC_API_KEY;
});

const askHttp = async (question) => {
  const res = await fetch(`${lc.url}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question }) });
  assert.equal(res.status, 200);
  return res.json();
};
const statements = (a) => a.sections.flatMap((s) => s.statements);
const section = (a, id) => a.sections.find((s) => s.id === id)?.statements || [];
const digestNow = async () => (await fetch(`${lc.url}/api/digest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();

test('"How is redeem rewards going?" gives overall state, blockers with owners, last mile, registered changes and evidence', async () => {
  const a = await askHttp('How is redeem rewards going?');
  assert.equal(a.outcome, 'answered');
  assert.equal(a.feature.id, 'redeem-rewards');
  assert.equal(a.provider.name, 'claude');
  assert.equal(a.provider.used, true);
  assert.match(section(a, 'overall')[0].text, /^Overall: blocked\. Blocked by Release 0\.2\.1/);
  const blocker = section(a, 'blockers')[0];
  assert.match(blocker.text, /Push: @releaser/);
  // Its own "Reader UI" PR is still open, so it can't be available to users yet; the flag already is at 25%.
  assert.match(section(a, 'last_mile')[0].text, /^Available to users: Not done yet\. .*PR #8/);
  assert.ok(section(a, 'last_mile').some((s) => /^Flag redeem_rewards in production: on for 25% of users/.test(s.text)));
  assert.deepEqual(section(a, 'changes').map((s) => s.change), ['2026-11-02-rr-rollout-25', '2026-11-03-rr-needs-release']);
  assert.equal(section(a, 'alerts')[0].alert, 'alert-rr-dep');
  assert.ok(section(a, 'schedule')[0].at_risk);
  // Every statement links its source, or says there is no specific item to link to.
  for (const s of statements(a)) assert.ok((s.evidence.length && s.evidence.every((e) => e.link)) || s.no_source_item, `${s.id} has no evidence: ${s.text}`);
  // The AI's lead cites real statements only.
  assert.ok(a.lead.cites.every((c) => statements(a).some((s) => s.id === c)));
});

test('every evidence link matches its statement when opened', async () => {
  const a = await askHttp('How is redeem rewards going?');
  const repoFiles = w.gh.state.files.get(DATA);
  for (const s of statements(a)) {
    const links = s.evidence.map((e) => e.link);
    for (const [, n] of s.text.matchAll(/PR #(\d+)/g)) assert.ok(links.some((l) => l.endsWith(`/pull/${n}`)), `${s.id}: no link for PR #${n}`);
    const flag = s.text.match(/^Flag (\w+) in (QA|production)/);
    if (flag) assert.ok(s.evidence.some((e) => e.label.startsWith(`${flag[1]} in ${flag[2]}`) && e.link.startsWith(DEFAULTS.sources.flagsmith.appUrl)), `${s.id}: flag link`);
    const deploy = s.text.match(/^catalog-api in (QA|production) runs ([\d.]+)/);
    if (deploy) {
      // The exact deploy record of that environment and version, not the environment's list.
      const env = deploy[1] === 'QA' ? 'qa' : 'production';
      const ids = (w.gh.state.deployments.get(`${CATALOG}:${env}`) || []).filter((d) => d.payload.version === deploy[2]).map((d) => d.id);
      assert.ok(s.evidence.some((e) => ids.some((id) => e.link.endsWith(`/repos/${CATALOG}/deployments/${id}`))), `${s.id}: deploy link`);
    }
    if (s.change) {
      const link = s.evidence[0].link;
      assert.ok(link.endsWith(`/changes/${s.change}.yaml`), link);
      const summary = repoFiles.get(`changes/${s.change}.yaml`).match(/summary: (.*)/)[1];
      assert.ok(s.text.includes(summary), `${s.id}: change summary`);
    }
    if (s.alert) {
      const opened = await (await fetch(lc.url + s.evidence[0].link)).json();
      assert.ok(s.text.includes(opened.message));
    }
  }
  // Steps link their own PRs and, as in the browser view, the GitHub Actions run on each PR.
  for (const s of section(a, 'steps')) {
    assert.ok(s.evidence.some((e) => /\/pull\/\d+$/.test(e.link)));
    assert.ok(s.evidence.every((e) => /\/pull\/\d+$/.test(e.link) || /\/actions\/runs\/\d+$/.test(e.link) || /\/pull\/\d+\/checks$/.test(e.link)), s.evidence.map((e) => e.link).join(' '));
  }
});

test('the answer for a feature carries every source link its browser view shows, with read times', async () => {
  const a = await askHttp('How is redeem rewards going?');
  const status = await (await fetch(`${lc.url}/api/features/redeem-rewards/status`)).json();
  const answerLinks = new Set(statements(a).flatMap((s) => s.evidence.map((e) => e.link)));
  const viewLinks = status.sources.flatMap((t) => t.links.map((l) => l.url));
  assert.ok(viewLinks.length >= 6, viewLinks.join(' '));
  for (const l of viewLinks) assert.ok(answerLinks.has(l), `answer is missing ${l}`);
  // The text an AI tool relays shows when each statement was read.
  const md = (await createMcpHandler({ app, ask })({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'lifecycle_ask', arguments: { question: 'How is redeem rewards going?' } } })).result.content[0].text;
  assert.match(md, /· read \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
  for (const l of viewLinks) assert.ok(md.includes(`(${l})`), `markdown is missing ${l}`);
});

test('an undefined feature: "I don\'t have a feature called …", the defined features, and no status', async () => {
  const a = await askHttp('How is reader v2 going?');
  assert.equal(a.outcome, 'unknown_feature');
  assert.equal(a.lead.text, 'I don\'t have a feature called "reader v2".');
  assert.ok(a.defined_features.some((f) => f.id === 'redeem-rewards'));
  assert.equal(a.defined_features.length, app.config && (await app.refresh()).features.length);
  assert.deepEqual(a.sections, []);
  assert.equal(a.feature, null);
});

test('an unclear name gets a clarifying question listing the closest matches', async () => {
  const a = await askHttp('How is rewards going?');
  assert.equal(a.outcome, 'clarify');
  const ids = a.candidates.map((c) => c.id);
  assert.ok(ids.includes('rewards') && ids.includes('redeem-rewards'), ids.join(','));
  assert.match(a.lead.text, /^Which feature do you mean by "rewards"\? Closest matches: /);
  assert.deepEqual(a.sections, []);
});

test('a blocker comes with the owner to push and a suggested message', async () => {
  const a = await askHttp('Who do I push on redeem rewards?');
  assert.equal(a.intent, 'push');
  assert.equal(a.blockers.length, 1);
  assert.equal(a.blockers[0].owner, '@releaser');
  assert.match(a.blockers[0].message, /^Hi @releaser, Redeem rewards is waiting on "Release 0\.2\.1"/);
  // "Done but not turned on" is a blocker too: push the owner to turn the flag on.
  const r = await askHttp('Is rewards points available to users?');
  assert.equal(r.feature.id, 'rewards');
  assert.equal(r.blockers[0].owner, 'Catalog team');
  assert.match(r.blockers[0].message, /flag rewards_enabled being turned on in production/);
});

test('the data doesn\'t answer it: says so, with no made-up status', async () => {
  const a = await askHttp('What is the budget for redeem rewards?');
  assert.equal(a.outcome, 'no_data');
  assert.match(a.lead.text, /doesn't answer that/);
  assert.deepEqual(a.sections, []);
});

test('flag console unreachable: the answer says flag data is unavailable and gives the last read time', async () => {
  await askHttp('Is redeem rewards available to users?'); // a successful read first
  w.fs.state.down = true;
  try {
    const a = await askHttp('Is redeem rewards available to users?');
    const f = a.freshness.find((x) => x.source === 'flagsmith');
    assert.ok(f, JSON.stringify(a.freshness));
    assert.match(f.text, /^Flag data is unavailable \(redeem_rewards\)/);
    assert.ok(f.last_successful_read_at);
    assert.match(f.text, /Last successful read: \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\./);
    // No flag state is asserted while it can't be read.
    assert.ok(!statements(a).some((s) => /^Flag redeem_rewards in production/.test(s.text)));
  } finally {
    w.fs.state.down = false;
  }
});

test('the same answer from the person\'s AI tools (MCP) as from the app', async () => {
  const handle = createMcpHandler({ app, ask });
  const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.serverInfo.name, 'lifecycle');
  const tools = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(tools.result.tools.map((t) => t.name), ['lifecycle_ask', 'lifecycle_digest', 'lifecycle_follow', 'lifecycle_features']);
  const viaTools = (await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'lifecycle_ask', arguments: { question: 'Who do I push on redeem rewards?' } } })).result;
  const viaApp = await askHttp('Who do I push on redeem rewards?');
  const strip = (a) => JSON.parse(JSON.stringify({ ...a, asked_at: null }, (k, v) => (k.endsWith('read_at') ? undefined : v)));
  assert.deepEqual(strip(viaTools.structuredContent), strip(viaApp));
  assert.match(viaTools.content[0].text, /Suggested message to @releaser/);
  const log = fs.readFileSync(path.join(home, 'logs', 'ask.log'), 'utf8');
  assert.match(log, /"via":"ai-tools","feature":"redeem-rewards","outcome":"answered"/);
});

test('switching the configured provider changes which provider answers, with no code change', async () => {
  const before = { claude: claude.state.requests.length, openai: openai.state.requests.length };
  localConfig.ai = { ...DEFAULTS.ai, provider: 'openai-compatible', apiUrl: openai.url, model: 'company-model' };
  const a = await askHttp('How is redeem rewards going?');
  assert.equal(a.provider.name, 'openai-compatible');
  assert.equal(a.provider.model, 'company-model');
  assert.equal(a.provider.used, true);
  assert.equal(claude.state.requests.length, before.claude);
  assert.equal(openai.state.requests.length, before.openai + 2);
  assert.equal(openai.state.requests.at(-1).url, '/v1/chat/completions');

  localConfig.ai = { ...DEFAULTS.ai, provider: 'claude', apiUrl: claude.url };
  const b = await askHttp('How is redeem rewards going?');
  assert.equal(b.provider.name, 'claude');
  assert.equal(b.provider.model, 'claude-opus-5-5');
  assert.equal(claude.state.requests.length, before.claude + 2);
  assert.equal(claude.state.requests.at(-1).body.model, 'claude-opus-5-5');

  // Provider down: the answer still comes from the data, and says the provider couldn't be used.
  claude.state.down = true;
  const c = await askHttp('How is redeem rewards going?');
  claude.state.down = false;
  assert.equal(c.outcome, 'answered');
  assert.equal(c.provider.used, false);
  assert.match(c.provider.note, /claude couldn't be used/);
  assert.equal(c.feature.id, 'redeem-rewards');
});

test('an AI lead that states something the cited statements don\'t is dropped', () => {
  const facts = [{ id: 'f1', text: 'Overall: blocked. Blocked by Release 0.2.1.' }];
  assert.equal(checkLead({ text: 'Blocked by Release 0.2.1.', cites: ['f1'] }, facts), null);
  assert.match(checkLead({ text: 'It ships on 2026-12-01.', cites: ['f1'] }, facts), /2026-12-01/);
  assert.match(checkLead({ text: 'All good.', cites: [] }, facts), /no citations/);
  assert.match(checkLead({ text: 'All good.', cites: ['f9'] }, facts), /does not exist/);
});

test('digest: after a day of changes (flag on, PR merged, change registered) it lists all three under the right features; then "no changes"', async () => {
  localConfig.me = { owners: ['@dev'] }; // owns rewards, redeem-rewards, referral-bonus… via step owner "@dev"
  localConfig.ai = { ...DEFAULTS.ai, provider: 'none' };
  // Follow only through ownership; "Release 0.2.1" (owner @releaser) is neither owned nor followed.
  const first = await digestNow();
  assert.equal(first.outcome, 'first');
  assert.ok(!first.following.some((f) => f.id === 'rewards-release'));

  // A day of changes.
  w.fs.state.set('Production', 'rewards_enabled', { enabled: true, at: '2026-11-03T10:00:00Z' });
  w.gh.state.prs.set(`${CATALOG}#8`, { title: 'Reader UI', state: 'closed', merged_at: '2026-11-03T11:00:00Z', merge_commit_sha: 'aaa8', head: { sha: 'head8' } });
  w.gh.state.files.get(DATA).set('changes/2026-11-03-referral-paused.yaml',
    'id: 2026-11-03-referral-paused\nfeature: referral-bonus\nkind: schedule\nsummary: Referral bonus launch moved to December.\nregistered_by: "@pm"\nregistered_at: 2026-11-03T12:00:00Z\n');

  const d = await digestNow();
  assert.equal(d.outcome, 'changes');
  const items = (id, kind) => d.features.find((f) => f.id === id)?.items.filter((i) => i.kind === kind) || [];
  assert.match(items('rewards', 'flag')[0].text, /^rewards_enabled in production: off → on/);
  assert.ok(items('rewards', 'flag')[0].evidence[0].link.startsWith(DEFAULTS.sources.flagsmith.appUrl));
  assert.match(items('redeem-rewards', 'moved').map((i) => i.text).join(' '), /PR #8 "Reader UI" merged/);
  assert.match(items('referral-bonus', 'change')[0].text, /Referral bonus launch moved to December/);
  // Each under its own feature only.
  assert.equal(items('redeem-rewards', 'flag').length, 0);
  assert.equal(items('rewards', 'change').length, 0);
  assert.equal(items('referral-bonus', 'moved').length, 0);

  const again = await digestNow();
  assert.equal(again.outcome, 'no_changes');
  assert.match(again.headline, /^No changes since your last digest \(/);
  assert.deepEqual(again.features, []);
  // The last digest is what LifeCycle shows when opened.
  assert.equal((await (await fetch(`${lc.url}/api/digest/latest`)).json()).digest.outcome, 'no_changes');
});

test('a person only sees features they own or follow', async () => {
  localConfig.me = { owners: [] };
  let d = await digestNow();
  assert.equal(d.outcome, 'nothing_followed');
  assert.deepEqual(d.features, []);

  const res = await fetch(`${lc.url}/api/follows/reading-history`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"follow":true}' });
  assert.deepEqual((await res.json()).follows, ['reading-history']);
  d = await digestNow();
  assert.deepEqual(d.following.map((f) => f.id), ['reading-history']);
  assert.deepEqual(d.features.map((f) => f.id), ['reading-history']);
  assert.equal(d.features[0].items[0].kind, 'new_in_digest');

  // A cross-site page can't change follows.
  const bad = await fetch(`${lc.url}/api/follows/rewards`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{"follow":true}' });
  assert.equal(bad.status, 403);
});

test('the digest is shown inside LifeCycle when it opens', async () => {
  const js = await (await fetch(`${lc.url}/app.js`)).text();
  assert.match(js, /digest = await post\('\/api\/digest'\)/);
  // The home page carries the "Your digest" card built from the digest LifeCycle produced on open.
  assert.match(js, /<b>Your digest<\/b>/);
  assert.match(js, /\(digest\?\.features \|\| \[\]\)/);
  assert.match(js, /\$\{askDigestCard\(\)\}/);
});

test('history, digests and credentials stay on this machine: nothing in the shared repo or this repo, no tokens in logs', async () => {
  // Kept locally.
  const asks = fs.readFileSync(path.join(home, 'history', 'asks.jsonl'), 'utf8');
  assert.match(asks, /How is redeem rewards going\?/);
  assert.ok(fs.existsSync(path.join(home, 'history', 'digests.jsonl')));
  assert.equal(fs.statSync(path.join(home, 'history', 'asks.jsonl')).mode & 0o777, 0o600);
  // Shared repo: definitions and registered changes only.
  for (const [p, text] of w.gh.state.files.get(DATA)) {
    assert.match(p, /^(features|projects|services|changes)\/|^README\.md$/);
    assert.ok(!/redeem rewards going|lifecycle\.digest|lifecycle\.answer|sk-ant-|api03/.test(text), p);
  }
  // Nothing new written into the app's own repo.
  const now = untracked().filter((l) => !untrackedBefore.has(l));
  assert.deepEqual(now, []);
  // No tokens in any local log or history file.
  for (const f of ['logs/ask.log', 'logs/source-reads.log', 'history/asks.jsonl', 'history/digests.jsonl']) {
    const text = fs.readFileSync(path.join(home, f), 'utf8');
    assert.ok(!text.includes(FAKE_CLAUDE_KEY), f);
    assert.ok(!text.includes(w.gh.token), f);
    assert.ok(!text.includes(w.fs.apiKey), f);
  }
  const log = fs.readFileSync(path.join(home, 'logs', 'ask.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(log.every((l) => l.kind && 'feature' in l && l.outcome));
});
