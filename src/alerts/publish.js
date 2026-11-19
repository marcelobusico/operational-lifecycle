// Publishing a registered change: a direct commit of `changes/<id>.yaml` to the shared repo's main
// branch (no pull request).
//
// Nothing is ever lost or overwritten:
//   - every change is first saved to ~/.lifecycle/outbox/<id>.json, and removed from there only
//     once the shared repo has it;
//   - new changes get their own file (random suffix), so two people publishing at the same moment
//     never write the same file;
//   - an update or cancellation carries the revision it was based on; if the file in the repo has
//     moved on, nothing is written, the person is told, and their edit stays in the outbox;
//   - when the repo can't be reached the change waits in the outbox ("not published yet") and is
//     published on a later refresh or retry.
import fs from 'node:fs';
import path from 'node:path';
import { paths, writeJson } from '../config.js';
import { SourceError } from '../sources/github-client.js';
import { commitInClone } from '../data-source.js';
import { validateChange } from '../definitions.js';
import { buildChangeFile, draftErrors, newChangeId } from './registered.js';
import { ownersToNotify } from './match.js';
import { logAlertEvent } from './log.js';

const outboxFile = (id) => path.join(paths.outboxDir(), `${id}.json`);
const userCache = () => path.join(paths.cacheDir(), 'github-user.json');

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

export function listOutbox() {
  const dir = paths.outboxDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => readJson(path.join(dir, n))).filter(Boolean)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function createPublisher({ config, github }) {
  const toRepo = !config.dataPath;
  const featuresOf = (snap) => snap.featureDefs;

  // The author's GitHub user, "@login": from GitHub (cached for offline use), else me.github.
  async function whoAmI() {
    if (toRepo && github) {
      try {
        const me = await github.request('/user', { what: 'your GitHub user' });
        if (me?.login) {
          writeJson(userCache(), { login: me.login });
          return `@${me.login}`;
        }
      } catch (err) {
        if (!(err instanceof SourceError)) throw err;
      }
    }
    const cached = readJson(userCache())?.login;
    if (cached) return `@${cached}`;
    const configured = config.me?.github;
    return configured ? `@${String(configured).replace(/^@/, '')}` : null;
  }

  function saveEntry(entry) {
    writeJson(outboxFile(entry.id), entry, 0o600);
    return entry;
  }
  const dropEntry = (id) => fs.rmSync(outboxFile(id), { force: true });

  const commitMessage = (op, c) => `${{ create: 'Register', update: 'Update', cancel: 'Cancel' }[op]} change: ${c.summary} (${c.features.join(', ')})`;

  // Writes one built file. Returns { ok } or throws SourceError (unreachable | no_access | conflict).
  async function write(entry, built) {
    if (!toRepo) return writeLocal(entry, built);
    const repo = config.dataRepo;
    const route = `/repos/${repo}/contents/${built.path}`;
    const content = Buffer.from(built.text, 'utf8').toString('base64');
    const branch = config.dataBranch;
    if (entry.op === 'create') {
      try {
        await github.request(route, { method: 'PUT', what: `${built.path} in ${repo}`, body: { message: commitMessage('create', built.change), content, branch } });
        return;
      } catch (err) {
        if (err.kind !== 'conflict') throw err;
        // The file exists: either an earlier try of this very change got through, or (very
        // unlikely) another change has the same id. Never overwrite it.
        const current = await readRemote(built.path);
        if (current && current.registered_at === built.change.registered_at && current.revision === built.change.revision && current.summary === built.change.summary) return;
        throw new SourceError('conflict', `Another change already uses the id ${entry.id}.`, 422);
      }
    }
    const current = await readRemote(built.path, { withSha: true });
    if (!current) throw new SourceError('conflict', `The change ${entry.id} is no longer in the shared repo.`, 404);
    if (current.change.revision !== entry.base_revision) throw staleError(current.change);
    await github.request(route, { method: 'PUT', what: `${built.path} in ${repo}`, body: { message: commitMessage(entry.op, built.change), content, branch, sha: current.sha } });
  }

  function staleError(c) {
    return new SourceError('conflict', `${c.updated_by || c.registered_by} published revision ${c.revision} of this change${c.updated_at ? ` at ${c.updated_at}` : ''} after you opened it.`, 409);
  }

  async function readRemote(file, { withSha = false } = {}) {
    const repo = config.dataRepo;
    let body;
    try {
      body = await github.request(`/repos/${repo}/contents/${file}?ref=${encodeURIComponent(config.dataBranch)}`, { what: `${file} in ${repo}` });
    } catch (err) {
      if (err.kind === 'no_access' && err.status === 404) return null;
      throw err;
    }
    const text = Buffer.from(body.content || '', 'base64').toString('utf8');
    const parsed = validateChange(file, text);
    if (!parsed.change) return null;
    return withSha ? { sha: body.sha, change: parsed.change } : parsed.change;
  }

  async function writeLocal(entry, built) {
    const file = path.join(config.dataPath, built.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (entry.op === 'create') {
      try {
        fs.writeFileSync(file, built.text, { flag: 'wx' });
      } catch (err) {
        if (err.code === 'EEXIST') throw new SourceError('conflict', `Another change already uses the id ${entry.id}.`, 422);
        throw new SourceError('unreachable', `The local data folder can't be written (${err.code || err.message}).`);
      }
      return commitLocal(built.path, commitMessage('create', built.change));
    }
    let current;
    try {
      current = validateChange(built.path, fs.readFileSync(file, 'utf8')).change;
    } catch {
      current = null;
    }
    if (!current) throw new SourceError('conflict', `The change ${entry.id} is no longer in the data folder.`, 404);
    if (current.revision !== entry.base_revision) throw staleError(current);
    fs.writeFileSync(file, built.text);
    return commitLocal(built.path, commitMessage(entry.op, built.change));
  }

  // In a local git clone the change becomes a local commit (never pushed), since definitions are
  // read at the clone's commit (src/data-source.js). A plain folder just has the file.
  async function commitLocal(file, message) {
    try {
      await commitInClone(config.dataPath, file, message);
    } catch (err) {
      throw new SourceError('unreachable', `The change was saved to ${file} but could not be committed in the local clone (${String(err.stderr || err.message).trim()}).`);
    }
  }

  // Tries one outbox entry. Returns the outcome object shown to the person.
  async function attempt(entry, snap) {
    const features = featuresOf(snap);
    const by = entry.by || await whoAmI();
    if (!by) {
      saveEntry({ ...entry, state: 'failed', message: 'LifeCycle can\'t tell your GitHub user (GitHub unreachable and none saved). Set "me.github" in ~/.lifecycle/config.json or run npm run setup.', last_try_at: new Date().toISOString() });
      return { outcome: 'not_published', id: entry.id, message: 'Not published yet: LifeCycle can\'t tell your GitHub user. It\'s kept on this machine.' };
    }
    const built = buildChangeFile({ draft: entry.draft, features, by, prev: entry.prev, cancel: entry.op === 'cancel', id: entry.id, now: new Date(entry.created_at) });
    if (built.errors.length) {
      saveEntry({ ...entry, by, state: 'failed', message: built.errors.map((e) => `${e.field}: ${e.message}`).join(' '), last_try_at: new Date().toISOString() });
      return { outcome: 'invalid', id: entry.id, errors: built.errors, message: 'The change can\'t be published until these fields are fixed.' };
    }
    const feature = built.change.features.join(',');
    try {
      await write(entry, built);
    } catch (err) {
      if (!(err instanceof SourceError)) throw err;
      const now = new Date().toISOString();
      if (err.kind === 'conflict') {
        saveEntry({ ...entry, by, state: 'conflict', message: err.message, last_try_at: now });
        logAlertEvent({ event: 'publish_conflict', feature, source: 'registered', id: entry.id, detail: err.message });
        return { outcome: 'conflict', id: entry.id, message: `Not published: ${err.message} Nothing was overwritten and your edit is kept on this machine. Review the latest version, then publish again.` };
      }
      const pending = err.kind === 'unreachable';
      saveEntry({ ...entry, by, state: pending ? 'pending' : 'failed', message: err.message, last_try_at: now });
      logAlertEvent({ event: 'publish_failed', feature, source: 'registered', id: entry.id, detail: err.message });
      return {
        outcome: pending ? 'queued' : 'not_published', id: entry.id,
        message: pending
          ? `Not published yet: the shared repo can't be reached (${err.message}) The change is kept on this machine and will be published once the repo is reachable again.`
          : `Not published yet: ${err.message} The change is kept on this machine.`,
      };
    }
    dropEntry(entry.id);
    logAlertEvent({ event: 'publish', feature, source: 'registered', id: entry.id, detail: `${entry.op} revision ${built.change.revision} (${built.change.state})` });
    return { outcome: 'published', id: entry.id, change: built.change, message: `Published to ${toRepo ? config.dataRepo : config.dataPath}.` };
  }

  // op: create | update | cancel. snap: { featureDefs, changes }.
  async function submit({ op, draft, id = null, baseRevision = null }, snap) {
    const features = featuresOf(snap);
    let prev = null;
    if (op !== 'create') {
      prev = snap.changes.find((c) => c.id === id);
      if (!prev) return { outcome: 'not_found', message: `No registered change "${id}".` };
      if (prev.state === 'cancelled') return { outcome: 'invalid', errors: [{ field: 'state', message: 'This change is already cancelled.' }], message: 'This change is already cancelled.' };
    }
    if (op !== 'cancel') {
      const errors = draftErrors(draft, features);
      if (errors.length) return { outcome: 'invalid', errors, message: `Can't publish: ${errors.map((e) => e.message).join(' ')}` };
    }
    const entry = saveEntry({
      id: op === 'create' ? newChangeId(draft) : id,
      op,
      draft: op === 'cancel' ? { reason: draft?.reason || '' } : draft,
      prev,
      base_revision: prev ? (baseRevision ?? prev.revision) : null,
      state: 'pending',
      message: null,
      created_at: new Date().toISOString(),
      last_try_at: null,
    });
    const result = await attempt(entry, snap);
    const ids = op === 'cancel' ? prev.features : draft.features;
    return { ...result, notify: ownersToNotify(features, ids) };
  }

  // Retries what is waiting: changes not yet in the shared repo.
  async function flush(snap, { all = false } = {}) {
    const results = [];
    for (const entry of listOutbox()) {
      if (entry.state === 'pending' || (all && entry.state === 'failed')) results.push(await attempt(entry, snap));
    }
    return results;
  }

  // Throws away an outbox entry (e.g. after a conflict the person resolved).
  function discard(id) {
    const e = readJson(outboxFile(id));
    if (e) logAlertEvent({ event: 'outbox_discarded', feature: (e.draft?.features || e.prev?.features || []).join(','), source: 'registered', id });
    dropEntry(id);
  }

  return { submit, flush, discard, whoAmI, preview: (features, ids) => ownersToNotify(features, ids) };
}
