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
