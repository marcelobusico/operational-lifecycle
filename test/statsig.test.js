// Statsig adapter, over Statsig's MCP server (a stand-in here): on/off/rollout per environment, who
// and when, unknown gates, and failures classified as no access / unreachable naming Statsig.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeStatsig } from './fake-statsig.js';
import { createStatsigConnection } from '../src/sources/statsig.js';
import { createStatsigSource, gateState } from '../src/lastmile/statsig.js';

let st;
const source = (apiKey = st.apiKey) => createStatsigSource({
  connection: createStatsigConnection({ mcpUrl: st.url, apiKey }),
  consoleUrl: 'https://console.statsig.com',
  environmentNames: { qa: 'staging', production: 'production' },
});

before(async () => {
  st = await startFakeStatsig();
  st.state.set('staging', 'redeem_rewards', { enabled: true, at: '2026-11-02T09:00:00Z' });
  st.state.set('production', 'redeem_rewards', { enabled: false, rollout: 25, at: '2026-11-02T10:00:00Z', by: 'Ana Ops' });
  st.state.set('production', 'new_reader', { enabled: true, at: '2026-11-02T11:00:00Z' });
  st.state.set('production', 'rewards_enabled', { enabled: true, at: '2026-11-01T10:00:00Z' });
  st.state.disable('rewards_enabled', { at: '2026-11-03T08:00:00Z', by: 'Bea Release' });
});
after(() => st.close());

test('reads a 25% production rollout, on in staging, with who, when and a link to the gate', async () => {
  const src = source();
  const project = await src.readProject();
  const read = (env, name) => src.readFlag({ env: project.envs[env], flag: project.flags.get(name) });
  const prod = await read('production', 'redeem_rewards');
  assert.equal(prod.state, 'partial');
  assert.equal(prod.rollout_percentage, 25);
  assert.equal(prod.changed_at, '2026-11-02T10:00:00.000Z');
  assert.equal(prod.changed_by, 'Ana Ops');
  assert.equal(prod.link, `https://console.statsig.com/${st.company}/gates/redeem_rewards`);
  assert.equal((await read('qa', 'redeem_rewards')).state, 'on');
  assert.equal((await read('production', 'new_reader')).state, 'on');
  // No rule for staging: nobody passes there.
  assert.equal((await read('qa', 'new_reader')).state, 'off');
  // The request shape Statsig documents: { action, arguments: { params } }.
  assert.ok(st.state.calls.every((c) => c.tool === 'gate_read' && c.params && typeof c.params === 'object'));
});

test('a disabled gate is off, with who switched it off and when', async () => {
  const src = source();
  const project = await src.readProject();
  const off = await src.readFlag({ env: project.envs.production, flag: project.flags.get('rewards_enabled') });
  assert.equal(off.state, 'off');
  assert.equal(off.changed_at, '2026-11-03T08:00:00.000Z');
  assert.equal(off.changed_by, 'Bea Release');
});

test('a gate missing from Statsig is not in the project (reported as unknown flag upstream)', async () => {
  const project = await source().readProject();
  assert.equal(project.flags.has('ghost_flag'), false);
});

test('answers with JSON text only (no structuredContent) are read the same', async () => {
  st.state.textOnly = true;
  const src = source();
  const project = await src.readProject();
  const r = await src.readFlag({ env: project.envs.production, flag: project.flags.get('redeem_rewards') });
  st.state.textOnly = false;
  assert.equal(r.rollout_percentage, 25);
});

test('no key, a refused key and a key without gate access are "no access" naming Statsig; a down server is unreachable', async () => {
  await assert.rejects(source(null).readProject(), (e) => e.kind === 'no_access' && /No Statsig Console API key/.test(e.message));
  await assert.rejects(source('wrong-key-not-real').readProject(), (e) => e.kind === 'no_access' && /Statsig refused your Console API key/.test(e.message) && /read access to the project's feature gates/.test(e.message));
  st.state.readOnlyDenied = true;
  await assert.rejects(source().readProject(), (e) => e.kind === 'no_access' && /Statsig/.test(e.message));
  st.state.readOnlyDenied = false;
  st.state.down = true;
  await assert.rejects(source().readProject(), (e) => e.kind === 'unreachable' && /Statsig/.test(e.message));
  st.state.down = false;
});

test('an answer that does not look like a gate is unavailable, never off', async () => {
  st.state.gates.set('odd_gate', { id: 'odd_gate', name: 'odd_gate', permalink: 'https://console.statsig.com/x/gates/odd_gate' });
  const src = source();
  const project = await src.readProject();
  await assert.rejects(src.readFlag({ env: project.envs.production, flag: project.flags.get('odd_gate') }),
    (e) => e.kind === 'unreachable' && /Statsig's answer for feature gate "odd_gate" could not be read/.test(e.message));
  st.state.gates.delete('odd_gate');
});

test('rule evaluation: environments, targeted segments and the first public rule', () => {
  const gate = (rules, isEnabled = true) => ({ isEnabled, rules });
  const pub = (pct, environments = null) => ({ name: 'Everyone', passPercentage: pct, conditions: [{ type: 'public' }], environments });
  const seg = (pct) => ({ name: 'Employees', passPercentage: pct, conditions: [{ type: 'email', operator: 'str_contains_any', targetValue: ['@acme.com'] }] });
  assert.deepEqual(gateState(gate([pub(100)]), 'production').state, 'on');
  assert.equal(gateState(gate([pub(100)], false), 'production').state, 'off');
  assert.equal(gateState(gate([pub(100, ['staging'])]), 'production').state, 'off');
  assert.deepEqual(gateState(gate([seg(100)]), 'production'), { state: 'partial', rollout_percentage: null, segments: [{ name: 'Employees', percentage: null }] });
  assert.equal(gateState(gate([seg(100), pub(40)]), 'production').rollout_percentage, 40);
  assert.equal(gateState(gate([pub(0), seg(100)]), 'production').state, 'off');
});

test('a change made with an API key is credited to the kind of key, never to the key fragment Statsig shows', async () => {
  const { changedBy } = await import('../src/lastmile/statsig.js');
  assert.equal(changedBy({ lastModifierName: 'CONSOLE API - console-HTWw3qe***************' }), 'a Console API key');
  assert.equal(changedBy({ lastModifierName: 'something console-abc123' }), 'an API key');
  assert.equal(changedBy({ lastModifierName: 'Ana Ops' }), 'Ana Ops');
  assert.equal(changedBy({ lastModifierName: null, lastModifierEmail: null }), null);
});
