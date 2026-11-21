// The feature outbox (src/features/publish.js): retry order, what it records when an entry leaves it,
// and the log line of a discarded project.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFeaturePublisher, listFeatureOutbox, featureOutboxOutcome } from '../src/features/publish.js';
import { SourceError } from '../src/sources/github-client.js';

const defs = { featureDefs: [], projectDefs: [], invalidIds: new Set(), files: new Map() };
// A shared repo that can't be reached: every submit waits in the outbox.
const unreachable = () => createFeaturePublisher({
  config: { dataRepo: 'acme/lifecycle-data', dataBranch: 'main' },
  github: { request: async () => { throw new SourceError('unreachable', 'GitHub is down.'); } },
  whoAmI: async () => 'ana',
});

beforeEach(() => { process.env.LIFECYCLE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-outbox-')); });

test('entries saved in the same millisecond are retried in the order they were made', async () => {
  const fp = unreachable();
  const names = Array.from({ length: 12 }, (_, i) => `Project ${String.fromCharCode(97 + i)}`);
  for (const name of names) assert.equal((await fp.submit({ op: 'create-project', draft: { name }, via: 'import' }, { defs, files: defs.files })).outcome, 'queued');
  const list = listFeatureOutbox();
  assert.deepEqual(list.map((e) => e.name), names);
  for (let i = 1; i < list.length; i++) assert.ok(list[i].created_at > list[i - 1].created_at, 'times are strictly increasing');
});

test('a discarded project entry is logged with its project and recorded as discarded; a published one as published', async () => {
  const fp = unreachable();
  const res = await fp.submit({ op: 'create-project', draft: { name: 'Wallet' }, via: 'import' }, { defs, files: defs.files });
  assert.equal(featureOutboxOutcome(res.key), null, 'still waiting: nothing recorded');
  fp.discard(res.key);
  assert.deepEqual(listFeatureOutbox(), []);
  assert.equal(featureOutboxOutcome(res.key).outcome, 'discarded');
  const log = fs.readFileSync(path.join(process.env.LIFECYCLE_HOME, 'logs', 'alerts.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const line = log.find((l) => l.event === 'feature_edit_discarded');
  assert.equal(line.feature, 'wallet');

  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-data-'));
  const local = createFeaturePublisher({ config: { dataPath }, github: null, whoAmI: async () => 'ana' });
  const ok = await local.submit({ op: 'create-project', draft: { name: 'Cards' }, via: 'import' }, { defs, files: defs.files });
  assert.equal(ok.outcome, 'published');
  assert.equal(featureOutboxOutcome(ok.key).outcome, 'published');
  assert.ok(fs.existsSync(path.join(dataPath, 'projects', 'cards.yaml')));
});

// A shared repo that can be switched off: files by path; writes are recorded.
function switchable() {
  const state = { down: true, files: new Map(), writes: [] };
  const github = { request: async (url, opts = {}) => {
    if (state.down) throw new SourceError('unreachable', 'GitHub is down.');
    const file = url.split('/contents/')[1]?.split('?')[0];
    if (opts.method === 'PUT') { state.writes.push(file); state.files.set(file, Buffer.from(opts.body.content, 'base64').toString('utf8')); return {}; }
    if (!state.files.has(file)) throw new SourceError('no_access', 'Not found.', 404);
    return { content: Buffer.from(state.files.get(file)).toString('base64'), sha: 'abc' };
  } };
  return { state, fp: createFeaturePublisher({ config: { dataRepo: 'acme/lifecycle-data', dataBranch: 'main' }, github, whoAmI: async () => 'ana' }) };
}
const noReview = async () => ({ ran: false, findings: [], blocking: false });
const draft = (name, extra = {}) => ({ id: name.toLowerCase().replace(/ /g, '-'), name, owner: 'ana', description: '', project: '', target_date: '', depends_on: [], services: [], flags: [],
  steps: [{ id: 'api', name: 'API', owner: 'ana', done_when: 'deployed', add_evidence: [] }], ...extra });

test('a retry leaves waiting what needs a new project or feature that was refused, and never writes a feature into a project that is not there', async () => {
  const { state, fp } = switchable();
  const withP = { ...defs, projectDefs: [{ id: 'wallet', name: 'Wallet' }] };
  const p = await fp.submit({ op: 'create-project', draft: { name: 'Wallet' }, via: 'import' }, { defs, files: defs.files });
  const f = await fp.submit({ op: 'create', draft: draft('Top up', { project: 'wallet' }), via: 'import' }, { defs: withP, files: defs.files, review: noReview });
  const topUp = { id: 'top-up', name: 'Top up', owner: 'ana', project: 'wallet', dependsOn: [], services: [], flags: [], steps: [], rampConditions: [], file: 'features/top-up.yaml' };
  const g = await fp.submit({ op: 'create', draft: draft('Refunds', { depends_on: ['top-up'] }), via: 'import' }, { defs: { ...withP, featureDefs: [topUp] }, files: defs.files, review: noReview });
  assert.deepEqual([p, f, g].map((x) => x.outcome), ['queued', 'queued', 'queued']);

  // Someone else created projects/wallet.yaml meanwhile: the project is a conflict, its feature and the one after wait.
  state.down = false;
  state.files.set('projects/wallet.yaml', 'id: wallet\nname: Wallet\n');
  const r1 = await fp.flush({ ...defs, projectDefs: [] });
  assert.deepEqual(r1.map((x) => x.outcome), ['conflict', 'queued', 'queued']);
  assert.match(r1[1].message, /waits for the project wallet/);
  assert.match(r1[2].message, /waits for the feature top-up/);
  assert.deepEqual(state.writes, []);
  assert.deepEqual(listFeatureOutbox().map((e) => e.state), ['conflict', 'pending', 'pending']);

  // The project's entry is discarded: the feature is checked against the projects there are, and refused.
  fp.discard(p.key);
  state.files.delete('projects/wallet.yaml');
  const r2 = await fp.flush({ ...defs, projectDefs: [] });
  assert.deepEqual(r2.map((x) => x.outcome), ['invalid', 'queued']);
  assert.match(r2[0].errors.map((e) => e.message).join(), /"wallet" is not a defined project/);
  assert.deepEqual(state.writes, [], 'nothing written');
});

test('a retry in order publishes a new project, then its feature in it', async () => {
  const { state, fp } = switchable();
  const withP = { ...defs, projectDefs: [{ id: 'wallet', name: 'Wallet' }] };
  await fp.submit({ op: 'create-project', draft: { name: 'Wallet' }, via: 'import' }, { defs, files: defs.files });
  await fp.submit({ op: 'create', draft: draft('Top up', { project: 'wallet' }), via: 'import' }, { defs: withP, files: defs.files, review: noReview });
  state.down = false;
  const r = await fp.flush({ ...defs, projectDefs: [] });
  assert.deepEqual(r.map((x) => x.outcome), ['published', 'published']);
  assert.deepEqual(state.writes, ['projects/wallet.yaml', 'features/top-up.yaml']);
});

test('Retry with keys tries only those entries; Discard removes an entry file that can no longer be read', async () => {
  const fp = unreachable();
  const a = await fp.submit({ op: 'create-project', draft: { name: 'Alpha' }, via: 'import' }, { defs, files: defs.files });
  await fp.submit({ op: 'create-project', draft: { name: 'Beta' }, via: 'form' }, { defs, files: defs.files });
  const r = await fp.flush(defs, { all: true, keys: [a.key] });
  assert.deepEqual(r.map((x) => x.key), [a.key]);

  const dir = path.join(process.env.LIFECYCLE_HOME, 'outbox', 'features');
  fs.writeFileSync(path.join(dir, 'broken-1.json'), '{"key": "broken-1", "op"');
  fp.discard('broken-1');
  assert.equal(fs.existsSync(path.join(dir, 'broken-1.json')), false);
  assert.equal(featureOutboxOutcome('broken-1').outcome, 'discarded');
});

test('a failed entry held back by a retry is reported as not published, not as queued', async () => {
  const { state, fp } = switchable();
  const withP = { ...defs, projectDefs: [{ id: 'wallet', name: 'Wallet' }] };
  await fp.submit({ op: 'create-project', draft: { name: 'Wallet' }, via: 'import' }, { defs, files: defs.files });
  const f = await fp.submit({ op: 'create', draft: draft('Top up', { project: 'wallet' }), via: 'import' }, { defs: withP, files: defs.files, review: noReview });
  const file = path.join(process.env.LIFECYCLE_HOME, 'outbox', 'features', `${f.key}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), state: 'failed' }));
  state.files.set('projects/wallet.yaml', 'id: wallet\nname: Wallet\n'); // the project's entry is refused: conflict
  state.down = false;
  const r = await fp.flush({ ...defs, projectDefs: [] }, { all: true });
  assert.deepEqual(r.map((x) => x.outcome), ['conflict', 'not_published']);
  assert.match(r[1].message, /waits for the project wallet/);
  assert.equal(listFeatureOutbox()[1].state, 'failed');
});
