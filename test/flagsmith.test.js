// Flagsmith adapter: reads on/off/rollout, who and when, and classifies failures.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeFlagsmith } from './fake-flagsmith.js';
import { createFlagsmithClient, createFlagsmithSource, percentageOf } from '../src/lastmile/flagsmith.js';

let fs;
const source = (apiKey = fs.apiKey) => createFlagsmithSource({
  client: createFlagsmithClient({ apiUrl: fs.url, apiKey }),
  projectId: fs.projectId,
  appUrl: 'https://app.flagsmith.com',
  environmentNames: { qa: 'QA', production: 'Production' },
});

before(async () => {
  fs = await startFakeFlagsmith();
  fs.state.set('Production', 'rewards_enabled', { enabled: false, at: '2026-11-01T10:00:00Z' });
  fs.state.set('Production', 'redeem_rewards', { enabled: false, rollout: 25, at: '2026-11-02T10:00:00Z' });
  fs.state.set('Production', 'new_reader', { enabled: true, at: '2026-11-02T11:00:00Z' });
});
after(() => fs.close());

test('reads off, on and a 25% rollout, with who and when', async () => {
  const src = source();
  const project = await src.readProject();
  assert.equal(project.envs.production.id, 2);
  const read = (name) => src.readFlag({ env: project.envs.production, flag: project.flags.get(name) });
  const off = await read('rewards_enabled');
  assert.equal(off.state, 'off');
  assert.equal(off.changed_at, '2026-11-01T10:00:00Z');
  assert.equal(off.changed_by, 'Ana Ops');
  assert.match(off.link, /app\.flagsmith\.com\/project\/7\/environment\/prodEnvKey456\/features\?feature=\d+/);
  const partial = await read('redeem_rewards');
  assert.equal(partial.state, 'partial');
  assert.equal(partial.rollout_percentage, 25);
  assert.equal((await read('new_reader')).state, 'on');
});

test('a wrong key is no access naming Flagsmith; a down console is unreachable', async () => {
  await assert.rejects(source('wrong-key').readProject(), (e) => e.kind === 'no_access' && /Flagsmith \(flag console\)/.test(e.message));
  fs.state.down = true;
  await assert.rejects(source().readProject(), (e) => e.kind === 'unreachable');
  fs.state.down = false;
});

test('finds a nested PERCENTAGE_SPLIT', () => {
  assert.equal(percentageOf({ rules: [{ rules: [{ conditions: [{ operator: 'PERCENTAGE_SPLIT', value: '40' }] }] }] }), 40);
  assert.equal(percentageOf({ rules: [{ conditions: [{ operator: 'EQUAL', value: 'x' }] }] }), null);
});
