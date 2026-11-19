// "Ready to ramp?" acceptance criteria, end to end: the real app, server, ask service and MCP
// handler against a fake GitHub and a fake flag console. Each test changes a source (never a
// definition, except where the criterion is about the definition) and refreshes.
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
import { DEFAULTS } from '../src/config.js';

let w, home, app, ask, lc, files, payDefinition;

const REDEEM_FEATURE = [
  'id: redeem-rewards', 'name: Redeem rewards', 'owner: Catalog team', 'depends_on: [rewards]',
  'services: [catalog-api]', 'flags: [redeem_rewards]', 'steps:',
  `  - { id: development, name: Development, owner: "@dev", done_when: merged with CI passing, evidence: [{ source: github, type: pr, repo: ${CATALOG}, number: 2 }] }`,
].join('\n') + '\n';

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-ramp-'));
  process.env.LIFECYCLE_HOME = home;
  w = await startWorld();
  files = w.gh.state.files.get(DATA);
  // Redeem rewards: one step (PR #2, merged, CI passing), catalog-api 0.3.0 in production, its
  // flag at 25%, and a dependency on Rewards points, whose flag is on in production.
  payDefinition = REDEEM_FEATURE;
  files.set('features/redeem-rewards.yaml', payDefinition);
  files.set('services/catalog-api.yaml', `id: catalog-api\nname: Catalog API\nowner: Reading platform\nrepo: ${CATALOG}\n`);
  w.fs.state.set('Production', 'rewards_enabled', { enabled: true, at: '2026-11-03T10:00:00Z' });
  // An alert list with nothing open against it (so the alerts check really runs).
  const alertsFile = path.join(home, 'alerts.json');
  fs.writeFileSync(alertsFile, JSON.stringify({ schema: 'lifecycle.alerts/v1', alerts: [] }));
  app = createApp({ alwaysLive: true, config: { ...w.config, alerts: { source: alertsFile } }, token: w.gh.token, flagsmithApiKey: w.fs.apiKey });
  ask = createAskService({ app, readConfig: () => ({ ai: { ...DEFAULTS.ai, provider: 'none' } }) });
  const server = createServer(app, ask);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  lc = { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) };
});
after(async () => { await lc.close(); await w.close(); });

const ramp = async (id = 'redeem-rewards') => (await (await fetch(`${lc.url}/api/features/${id}/status`)).json()).ramp;
const check = (r, id) => r.checks.find((c) => c.id === id);

test('every step done, deployed to production, dependencies done: "ready", every check listed as passed', async () => {
  const r = await ramp();
  assert.equal(r.verdict, 'ready', JSON.stringify(r.reasons));
  assert.equal(r.label, 'Ready to ramp');
  assert.deepEqual(r.reasons, []);
  assert.deepEqual(r.unavailable, []);
  assert.deepEqual(r.checks.map((c) => c.id), ['steps', 'dependencies', 'development', 'deploys', 'versions', 'flags', 'experiments', 'changes', 'alerts']);
  for (const c of r.checks) assert.equal(c.state, 'passed', `${c.id}: ${c.detail}`);
  assert.equal(check(r, 'experiments').detail, 'The definition lists no experiments.');
  assert.match(check(r, 'deploys').detail, /catalog-api 0\.3\.0/);
  // Its own flag at 25% is what ramping changes, so it isn't a reason.
  assert.match(check(r, 'flags').detail, /redeem_rewards in production: 25%/);
});

test('a service undeployed from production: "not ready", naming the service and environment with the deploy record', async () => {
  const saved = w.gh.state.deployments.get(`${CATALOG}:production`);
  w.gh.state.deployments.delete(`${CATALOG}:production`);
  try {
    const r = await ramp();
    assert.equal(r.verdict, 'not_ready');
    const reason = r.reasons.find((x) => x.check === 'deploys');
    assert.equal(reason.service, 'catalog-api');
    assert.equal(reason.environment, 'production');
    assert.match(reason.message, /catalog-api isn't deployed to production/);
    assert.equal(reason.owner, 'Reading platform');
    // No successful deploy means no deploy record to link, so the reason links the definition that
    // lists the service, never a generic page such as the environment's list of deployments.
    assert.deepEqual(reason.evidence.map((e) => e.link), ['https://github.com/team/LifeCycle-Data/blob/main/features/redeem-rewards.yaml']);
    assert.equal(check(r, 'deploys').state, 'failed');
  } finally {
    w.gh.state.deployments.set(`${CATALOG}:production`, saved);
  }
  assert.equal((await ramp()).verdict, 'ready');
});

test('a flag a dependency relies on switched off: "not ready", naming the dependency', async () => {
  w.fs.state.set('Production', 'rewards_enabled', { enabled: false, at: '2026-11-04T09:00:00Z' });
  try {
    const r = await ramp();
    assert.equal(r.verdict, 'not_ready');
    const reason = r.reasons.find((x) => x.check === 'dependencies');
    assert.equal(reason.dependency, 'rewards');
    assert.match(reason.message, /^Dependency Rewards points was switched off: flag rewards_enabled in production on 2026-11-04 09:00 UTC by Ana Ops\./);
    assert.equal(reason.owner, 'Ana Ops');
    assert.match(reason.evidence[0].link, /flagsmith|\/project\//);
  } finally {
    w.fs.state.set('Production', 'rewards_enabled', { enabled: true, at: '2026-11-04T10:00:00Z' });
  }
  assert.equal((await ramp()).verdict, 'ready');
});

test('a planned change registered against the feature is a reason, linking to the change', async () => {
  files.set('changes/2026-11-04-points-limit.yaml', [
    'id: 2026-11-04-points-limit', 'what: { type: flag, name: redeem_rewards }', 'change: Lower the rewards redemption limit to 50 points',
    'features: [redeem-rewards]', 'state: planned', 'planned_for: 2026-11-10', 'reason: Fraud review', 'registered_by: "@risk"', 'registered_at: 2026-11-04T08:00:00Z',
  ].join('\n') + '\n');
  try {
    const r = await ramp();
    assert.equal(r.verdict, 'not_ready');
    const reason = r.reasons.find((x) => x.check === 'changes');
    assert.equal(reason.change, '2026-11-04-points-limit');
    assert.match(reason.message, /Planned change for 2026-11-10: Lower the rewards redemption limit to 50 points/);
    assert.equal(reason.owner, '@risk');
    assert.deepEqual(reason.evidence, [{ label: 'registered change 2026-11-04-points-limit', link: `https://github.com/${DATA}/blob/main/changes/2026-11-04-points-limit.yaml` }]);
  } finally {
    files.delete('changes/2026-11-04-points-limit.yaml');
  }
});

test('the deploy source unreachable: "can\'t tell", naming the source and when it was last read', async () => {
  const before = await (await fetch(`${lc.url}/api/features/redeem-rewards/status`)).json();
  const lastRead = before.last_mile.services[0].environments.production.last_successful_read_at;
  w.gh.state.downPaths = [/\/deployments/];
  try {
    const r = await ramp();
    assert.equal(r.verdict, 'cant_tell');
    assert.deepEqual(r.reasons, []);
    const deploy = r.unavailable.find((u) => u.check === 'deploys');
    assert.equal(deploy.source, 'GitHub Deployments');
    assert.equal(deploy.what, 'catalog-api in production');
    assert.equal(deploy.last_successful_read_at, lastRead);
    assert.equal(check(r, 'deploys').state, 'unavailable');
    assert.match(r.summary, /^Can't tell: GitHub Deployments couldn't be read \(last read \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\)/);
  } finally {
    w.gh.state.downPaths = [];
  }
  assert.equal((await ramp()).verdict, 'ready');
});

test('a feature-specific condition in the definition is listed in the checks and blocks "ready" until met', async () => {
  w.gh.state.issues.set(`${CATALOG}#20`, { title: 'QA sign-off for redeem rewards', state: 'open' });
  files.set('features/redeem-rewards.yaml', payDefinition + [
    'ramp_conditions:',
    `  - { id: qa-signoff, name: QA sign-off, owner: "@qa-lead", done_when: QA closes the sign-off issue, evidence: [{ source: github, type: issue, repo: ${CATALOG}, number: 20 }] }`,
  ].join('\n') + '\n');
  try {
    let r = await ramp();
    assert.equal(r.verdict, 'not_ready');
    const c = check(r, 'condition:qa-signoff');
    assert.deepEqual([c.name, c.custom, c.state], ['QA sign-off', true, 'failed']);
    const reason = r.reasons.find((x) => x.check === 'condition:qa-signoff');
    assert.equal(reason.owner, '@qa-lead');
    assert.equal(reason.evidence[0].link, `https://github.com/${CATALOG}/issues/20`);
    // QA closes the issue: met, and the verdict is ready again, with nobody editing anything.
    w.gh.state.issues.set(`${CATALOG}#20`, { title: 'QA sign-off for redeem rewards', state: 'closed', state_reason: 'completed', closed_at: '2026-11-04T12:00:00Z' });
    r = await ramp();
    assert.equal(check(r, 'condition:qa-signoff').state, 'passed');
    assert.equal(r.verdict, 'ready');
  } finally {
    files.set('features/redeem-rewards.yaml', payDefinition);
  }
});

test('"Is redeem rewards ready to ramp?" in the chat and from AI tools matches the browser verdict and reasons', async () => {
  // Not ready: catalog-api out of production (for it and its dependency) and a planned change.
  const saved = w.gh.state.deployments.get(`${CATALOG}:production`);
  w.gh.state.deployments.delete(`${CATALOG}:production`);
  files.set('changes/2026-11-04-points-limit.yaml', [
    'id: 2026-11-04-points-limit', 'what: { type: flag, name: redeem_rewards }', 'change: Lower the rewards redemption limit',
    'features: [redeem-rewards]', 'state: planned', 'planned_for: 2026-11-10', 'reason: Fraud review', 'registered_by: "@risk"', 'registered_at: 2026-11-04T08:00:00Z',
  ].join('\n') + '\n');
  try {
    const browser = await ramp();
    assert.equal(browser.verdict, 'not_ready');
    // catalog-api also runs Rewards points, so the dependency isn't fully on either.
    assert.deepEqual(browser.reasons.map((x) => x.check), ['dependencies', 'deploys', 'changes']);

    const res = await fetch(`${lc.url}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'Is redeem rewards ready to ramp?' }) });
    const chat = await res.json();
    assert.equal(chat.intent, 'ramp');
    assert.equal(chat.feature.id, 'redeem-rewards');
    assert.equal(chat.lead.text, 'Redeem rewards: not ready to ramp, 3 reasons. Push Catalog team, Reading platform, @risk.');
    const statements = chat.sections.flatMap((s) => s.statements);
    assert.equal(statements[0].text, browser.summary);
    assert.deepEqual(statements.filter((s) => s.ramp_reason).map((s) => s.text), browser.reasons.map((x) => `Not ready: ${x.message} Owner: ${x.owner}.`));
    assert.deepEqual(statements.filter((s) => s.ramp_reason).map((s) => s.evidence), browser.reasons.map((x) => x.evidence));
    assert.match(statements.find((s) => s.ramp_checks).text, /Deployed to production on every service \(failed\).*No planned change against it \(failed\)/);

    const handle = createMcpHandler({ app, ask });
    const viaTools = (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lifecycle_ask', arguments: { question: 'Is redeem rewards ready to ramp?' } } })).result;
    const strip = (a) => JSON.parse(JSON.stringify({ ...a, asked_at: null }).replace(/"read_at":"[^"]*"/g, ''));
    assert.deepEqual(strip(viaTools.structuredContent), strip(chat));
    assert.match(viaTools.content[0].text, /Not ready: catalog-api isn't deployed to production\. Owner: Reading platform\./);
  } finally {
    w.gh.state.deployments.set(`${CATALOG}:production`, saved);
    files.delete('changes/2026-11-04-points-limit.yaml');
  }
});
