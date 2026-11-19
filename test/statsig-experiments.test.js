// Experiments with several groups, from Statsig, end to end: the real app,
// server and ask service against a fake GitHub and a fake Statsig MCP server whose experiments are
// copies of a real captured answer (test/fixtures/statsig-experiment-live.json). Walks the work
// order's acceptance criteria in order.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startWorld, DATA } from './last-mile-fixture.js';
import { createApp } from '../src/app.js';
import { createServer } from '../src/server.js';
import { createAskService } from '../src/ask/service.js';
import { validateDefinition } from '../src/definitions.js';
import { DEFAULTS } from '../src/config.js';

const EXP = 'redeem_rewards_test';
let w, lc;

function start(statsigApiKey) {
  const app = createApp({ config: w.configFor('statsig'), token: w.gh.token, statsigApiKey });
  const ask = createAskService({ app, readConfig: () => ({ ai: { ...DEFAULTS.ai, provider: 'none' }, me: { owners: [] } }) });
  const server = createServer(app, ask);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }),
  })));
}
const status = async (id = 'redeem-rewards', base = lc.url) => (await fetch(`${base}/api/features/${id}/status`)).json();

before(async () => {
  process.env.LIFECYCLE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-experiments-'));
  w = await startWorld();
  const files = w.gh.state.files.get(DATA);
  // What the feature does in each group is written in its definition; group B is left to
  // Statsig's own description, and a second feature names an experiment that doesn't exist.
  files.set('features/redeem-rewards.yaml', `${files.get('features/redeem-rewards.yaml')}experiments:
  - id: ${EXP}
    groups:
      Control: No rewards option in the reader
      A: Can redeem rewards in the reader
`);
  files.set('features/loyalty-tiers.yaml', `${files.get('features/loyalty-tiers.yaml')}experiments: [tiers_ghost_experiment]\n`);
  w.st.state.experiment(EXP, { at: '2026-11-04T10:00:00Z', groups: [
    { name: 'Control', size: 50 }, { name: 'A', size: 25 }, { name: 'B', size: 25, description: 'Rewards points plus a 10% bonus' }] });
  lc = await start(w.st.apiKey);
});
after(async () => { await lc.close(); await w.close(); });

test('a feature definition names its experiments, with what the feature does in each group', () => {
  const base = 'id: x\nname: X\nowner: o\nsteps: []\n';
  const ok = validateDefinition('features/x.yaml', `${base}flags: [x_flag]\nexperiments:\n  - id: e1\n    groups: { Control: card only }\n  - e2\n`);
  assert.deepEqual(ok.feature.experiments, [{ id: 'e1', groups: { Control: 'card only' } }, { id: 'e2', groups: {} }]);
  const bad = validateDefinition('features/x.yaml', `${base}experiments:\n  - id: e1\n    groups: { Control: "" }\n`);
  assert.deepEqual(bad.errors.map((e) => e.field), ['experiments[0].groups.Control']);
});

test('three groups in production (50/25/25): "in experiment", every group with its share and what it gets, linking the experiment', async () => {
  const s = await status();
  const lm = s.last_mile;
  assert.equal(lm.state, 'in_experiment');
  assert.equal(lm.label, `In experiment – ${EXP}`);
  assert.notEqual(lm.state, 'partly_rolled_out'); // the gate is at 25%, but the experiment is what users get
  const prod = lm.experiments[0].environments.production;
  assert.equal(prod.state, 'running');
  assert.deepEqual(prod.groups.map((g) => [g.name, g.control, g.share, g.gets, g.gets_from]), [
    ['Control', true, 50, 'No rewards option in the reader', 'definition'],
    ['A', false, 25, 'Can redeem rewards in the reader', 'definition'],
    ['B', false, 25, 'Rewards points plus a 10% bonus', 'statsig'],
  ]);
  // How users are assigned, as Statsig records it.
  assert.deepEqual(prod.assignment, { id_type: 'userID', allocation: 100, targeting_gate: null, segments: [] });
  const link = `https://console.statsig.com/${w.st.company}/experiments/${EXP}`;
  assert.equal(prod.link, link);
  assert.ok(prod.last_successful_read_at);
  assert.match(lm.summary, /Control \(control\) 50%: No rewards option.*A 25%: Can redeem rewards.*B 25%: Rewards points plus a 10% bonus/);
  // The experiment status in the feature's sources opens that experiment, with its read time.
  const src = s.sources.find((t) => t.key === `experiment:${EXP}:production`);
  assert.equal(src.kind, 'experiment');
  assert.equal(src.source, 'statsig');
  assert.deepEqual(src.links.map((l) => l.url), [link]);
  assert.ok(src.read_at);
  // Any running experiment means not ready to ramp.
  const exp = s.ramp.checks.find((c) => c.id === 'experiments');
  assert.equal(s.ramp.verdict, 'not_ready');
  assert.equal(exp.state, 'failed');
  assert.match(exp.detail, /still running in production \(Control 50%, A 25%, B 25%\)/);
  assert.match(lm.experiments[0].events[0].message, /started: Control 50%, A 25%, B 25%/);
});

test('asking "Is redeem rewards available to users?" answers with the groups and shares, citing the experiment', async () => {
  const res = await fetch(`${lc.url}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'Is redeem rewards available to users?' }) });
  const a = await res.json();
  assert.equal(a.feature.id, 'redeem-rewards');
  assert.match(a.lead.text, /In experiment – redeem_rewards_test.*Control \(control\) 50%: No rewards option.*A 25%.*B 25%/);
  const statements = a.sections.flatMap((x) => x.statements);
  const cited = statements.filter((x) => a.lead.cites.includes(x.id));
  const expFact = cited.find((x) => /^Experiment redeem_rewards_test is running in production/.test(x.text));
  assert.ok(expFact, 'the lead cites the experiment statement');
  assert.deepEqual(expFact.evidence.map((e) => e.link), [`https://console.statsig.com/${w.st.company}/experiments/${EXP}`]);
  assert.ok(expFact.read_at, 'with the time it was read');
  assert.match(expFact.text, /How users are assigned: users are assigned by userID/);
});

test('changing group B\'s share in Statsig and refreshing shows the new share and a timeline entry', async () => {
  w.st.state.setShare(EXP, { A: 35, B: 15 }, { at: '2026-11-05T09:00:00Z', by: 'Bea Release' });
  const lm = (await status()).last_mile;
  const prod = lm.experiments[0].environments.production;
  assert.deepEqual(prod.groups.map((g) => g.share), [50, 35, 15]);
  const change = lm.experiments[0].events.find((e) => e.kind === 'experiment_share_changed');
  assert.equal(change.at, '2026-11-05T09:00:00.000Z');
  assert.equal(change.message, `Experiment ${EXP}: A 25% → 35%, B 25% → 15% by Bea Release.`);
});

test('ending the experiment shows the feature\'s resulting state (from its flag) and a timeline entry for the end', async () => {
  w.st.state.endExperiment(EXP, { launched: 'A', at: '2026-11-05T12:00:00Z', by: 'Bea Release' });
  const s = await status();
  const lm = s.last_mile;
  assert.equal(lm.state, 'partly_rolled_out'); // the gate redeem_rewards is at 25% in production
  assert.equal(lm.label, 'Partly rolled out – 25%');
  assert.equal(lm.experiments[0].environments.production.state, 'ended');
  assert.equal(lm.experiments[0].environments.production.launched_group, 'A');
  const end = lm.experiments[0].events.find((e) => e.kind === 'experiment_ended');
  assert.equal(end.at, '2026-11-05T12:00:00.000Z');
  assert.equal(end.message, `Experiment ${EXP} ended: A was shipped by Bea Release.`);
  assert.equal(s.ramp.checks.find((c) => c.id === 'experiments').state, 'passed');
  // The gate turned fully on afterwards: fully on.
  w.setFlag('Production', 'redeem_rewards', { enabled: true });
  assert.equal((await status()).last_mile.state, 'fully_on');
});

test('a feature naming a nonexistent experiment shows an "unknown experiment" warning', async () => {
  const s = await status('loyalty-tiers');
  const warn = s.last_mile.warnings.find((x) => x.kind === 'unknown_experiment');
  assert.equal(warn.experiment, 'tiers_ghost_experiment');
  assert.match(warn.message, /Unknown experiment "tiers_ghost_experiment".*doesn't exist in Statsig/);
  const src = s.sources.find((t) => t.key === 'experiment:tiers_ghost_experiment:production');
  assert.equal(src.links.length, 0);
  assert.match(src.no_source_item, /doesn't exist in Statsig/);
});

test('Statsig unreachable: the experiment shows "status unavailable" with the last read time and keeps its link', async () => {
  const before = (await status()).last_mile.experiments[0].environments.production;
  w.st.state.down = true;
  const s = await status();
  w.st.state.down = false;
  const c = s.last_mile.experiments[0].environments.production;
  assert.equal(s.last_mile.state, 'unavailable');
  assert.equal(c.state, 'unavailable');
  assert.ok(c.last_successful_read_at && c.last_successful_read_at <= before.last_successful_read_at);
  assert.ok(c.unavailable_since);
  assert.equal(c.link, before.link);
  const src = s.sources.find((t) => t.key === `experiment:${EXP}:production`);
  assert.ok(src.unavailable && src.unavailable_since);
  assert.deepEqual(src.links.map((l) => l.url), [before.link]);
  assert.equal(s.ramp.verdict, 'cant_tell');
});

test('no access: the message names Statsig and the experiments it can\'t read', async () => {
  const other = await start('someone-elses-wrong-key');
  const lm = (await status('redeem-rewards', other.url)).last_mile;
  await other.close();
  assert.equal(lm.state, 'unavailable');
  assert.ok(lm.access_problems.some((a) => a.source === 'statsig' && /^Statsig refused your Console API key/.test(a.message)));
});
