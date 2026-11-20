// Publishing a feature edit made in LifeCycle: a direct commit of `features/<id>.yaml` to the shared
// repo's main branch with the editor's own GitHub credentials (no pull request), like registered
// changes (src/alerts/publish.js). The repo history shows who changed what and when.
//
// Nothing is ever lost or silently overwritten:
//   - every edit is first saved to ~/.lifecycle/outbox/features/<id>.json and removed from there only
//     once the shared repo has it;
//   - an edit carries a hash of the file as the editor opened it. If the file in the repo is no
//     longer that text (someone else saved first), nothing is written, the person is told who
//     changed it, and their edit stays on this machine;
//   - the write itself carries the file's sha, so a save landing in between is refused by GitHub too;
//   - when the repo can't be reached the edit waits ("not published yet") and is published on a later
//     refresh or retry.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { paths, writeJson } from '../config.js';
import { commitInClone } from '../data-source.js';
import { SourceError } from '../sources/github-client.js';
import { logAlertEvent } from '../alerts/log.js';
import { validateDefinition } from '../definitions.js';
import { buildFeatureFile, dependentsOf } from './edit.js';

export const textHash = (text) => crypto.createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 16);

const dir = () => path.join(paths.outboxDir(), 'features');
const entryFile = (key) => path.join(dir(), `${key}.json`);
const accessCache = () => path.join(paths.cacheDir(), 'data-repo-access.json');
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

export function listFeatureOutbox() {
  if (!fs.existsSync(dir())) return [];
  return fs.readdirSync(dir()).filter((n) => n.endsWith('.json')).map((n) => readJson(path.join(dir(), n))).filter(Boolean)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

const LABEL = { create: 'Add feature', update: 'Edit feature', delete: 'Delete feature' };

export function createFeaturePublisher({ config, github, whoAmI }) {
  const toRepo = !config.dataPath;
  const where = () => (toRepo ? config.dataRepo : config.dataPath);

  // Can this person write to the shared data? { can_edit, reason, checked_at, cached? }
  async function access() {
    if (!toRepo) {
      try {
        fs.accessSync(config.dataPath, fs.constants.W_OK);
        return { can_edit: true, reason: null };
      } catch {
        return { can_edit: false, reason: `The local data folder ${config.dataPath} can't be written by you, so feature data can only be viewed here.` };
      }
    }
    try {
      const repo = await github.request(`/repos/${config.dataRepo}`, { what: `the shared repo ${config.dataRepo}` });
      const can = Boolean(repo?.permissions?.push);
      const out = { can_edit: can, reason: can ? null : `Your GitHub user has read-only access to ${config.dataRepo}, so you can view feature data but not change it. Ask a maintainer of ${config.dataRepo} for write access to edit features from LifeCycle.`, checked_at: new Date().toISOString() };
      writeJson(accessCache(), { repo: config.dataRepo, ...out }, 0o600);
      return out;
    } catch (err) {
      if (!(err instanceof SourceError)) throw err;
      if (err.kind === 'no_access') return { can_edit: false, reason: `${err.message} Without write access to ${config.dataRepo} you can't edit feature data from LifeCycle.` };
      // Unreachable: go by the last answer; an edit is then kept locally until the repo is back.
      const cached = readJson(accessCache());
      if (cached?.repo === config.dataRepo) return { ...cached, cached: true };
      return { can_edit: true, reason: null, unknown: true };
    }
  }

  const save = (entry) => { writeJson(entryFile(entry.key), entry, 0o600); return entry; };
  const drop = (key) => fs.rmSync(entryFile(key), { force: true });

  // The file as it is in the shared data now: { text, sha } or null when there is no such file.
  async function readCurrent(file) {
    if (!toRepo) {
      const full = path.join(config.dataPath, file);
      try {
        return { text: fs.readFileSync(full, 'utf8'), sha: null };
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw new SourceError('unreachable', `The local data folder can't be read (${err.code || err.message}).`);
      }
    }
    try {
      const body = await github.request(`/repos/${config.dataRepo}/contents/${file}?ref=${encodeURIComponent(config.dataBranch)}`, { what: `${file} in ${config.dataRepo}` });
      return { text: Buffer.from(body.content || '', 'base64').toString('utf8'), sha: body.sha };
    } catch (err) {
      if (err.kind === 'no_access' && err.status === 404) return null;
      throw err;
    }
  }

  // Who last changed the file, and when (for the conflict message). Best effort.
  async function lastChange(file) {
    if (!toRepo) return null;
    try {
      const list = await github.request(`/repos/${config.dataRepo}/commits?path=${encodeURIComponent(file)}&sha=${encodeURIComponent(config.dataBranch)}&per_page=1`, { what: `the history of ${file}` });
      const c = Array.isArray(list) ? list[0] : null;
      if (!c) return null;
      return { by: c.author?.login ? `@${c.author.login}` : c.commit?.author?.name || null, at: c.commit?.author?.date || null };
    } catch {
      return null;
    }
  }

  async function staleError(file, what) {
    const last = await lastChange(file);
    const who = last?.by ? `${last.by} ${what}` : `Someone else ${what}`;
    return new SourceError('conflict', `${who}${last?.at ? ` at ${last.at}` : ''} after you opened it.`, 409);
  }

  // In a local git clone of LifeCycle-Data the edit becomes a local commit (never pushed), because
  // definitions are read at the clone's commit (src/data-source.js). A plain folder just has the file.
  async function commitLocal(file, message) {
    try {
      await commitInClone(config.dataPath, file, message);
    } catch (err) {
      throw new SourceError('unreachable', `The edit was saved to ${file} but could not be committed in the local clone (${String(err.stderr || err.message).trim()}).`);
    }
  }

  async function writeFile(file, text, { sha, message, create }) {
    if (!toRepo) {
      const full = path.join(config.dataPath, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      try {
        fs.writeFileSync(full, text, create ? { flag: 'wx' } : undefined);
      } catch (err) {
        if (err.code === 'EEXIST') throw new SourceError('conflict', `${file} already exists.`, 422);
        throw new SourceError('unreachable', `The local data folder can't be written (${err.code || err.message}).`);
      }
      return commitLocal(file, message);
    }
    const content = Buffer.from(text, 'utf8').toString('base64');
    await github.request(`/repos/${config.dataRepo}/contents/${file}`, { method: 'PUT', what: `${file} in ${config.dataRepo}`,
      body: { message, content, branch: config.dataBranch, ...(sha ? { sha } : {}) } });
  }

  async function deleteFile(file, { sha, message }) {
    if (!toRepo) {
      fs.rmSync(path.join(config.dataPath, file), { force: true });
      return commitLocal(file, message);
    }
    await github.request(`/repos/${config.dataRepo}/contents/${file}`, { method: 'DELETE', what: `${file} in ${config.dataRepo}`,
      body: { message, sha, branch: config.dataBranch } });
  }

  const summary = (diff) => [...new Set((diff || []).map((d) => (d.field.startsWith('steps') ? 'steps' : d.field.startsWith('ramp_conditions') ? 'ramp conditions' : d.label.toLowerCase())))].join(', ');
  // Where the edit was made: the form ("from LifeCycle") or the chat ("from the LifeCycle chat").
  // The person's role is never written: their GitHub identity is the commit's author.
  const commitMessage = (entry, diff, by) => {
    const from = entry.via === 'chat' ? 'from the LifeCycle chat' : 'from LifeCycle';
    return `${LABEL[entry.op]} ${entry.feature_id}${entry.op === 'update' && diff?.length ? `: ${summary(diff)}` : ''} (by ${by} ${from})`;
  };

  // One try at publishing an outbox entry. defs: { featureDefs, invalidIds }.
  async function attempt(entry, defs) {
    const now = () => new Date().toISOString();
    const by = await whoAmI();
    if (!by) {
      save({ ...entry, state: 'failed', message: 'LifeCycle can\'t tell your GitHub user (GitHub unreachable and none saved).', last_try_at: now() });
      return { outcome: 'not_published', key: entry.key, message: 'Not published yet: LifeCycle can\'t tell your GitHub user. Your edit is kept on this machine.' };
    }
    let diff = entry.diff || null;
    try {
      const current = await readCurrent(entry.file);
      if (entry.op === 'create') {
        if (current) throw new SourceError('conflict', `${entry.feature_id} was created by someone else in the meantime.`, 422);
      } else {
        if (!current) throw new SourceError('conflict', `${entry.feature_id} was deleted from the shared repo after you opened it.`, 404);
        if (textHash(current.text) !== entry.base_hash) throw await staleError(entry.file, `changed ${entry.feature_id}`);
      }
      if (entry.op === 'delete') {
        await deleteFile(entry.file, { sha: current.sha, message: commitMessage(entry, null, by) });
      } else {
        // The edit is applied to the file as it is in the repo now (the same text the editor opened).
        const baseFeature = current ? validateDefinition(entry.file, current.text).feature : null;
        if (entry.op === 'update' && !baseFeature) throw new SourceError('conflict', `${entry.file} in the shared repo is not a valid definition any more.`, 409);
        const others = defs.featureDefs.filter((f) => f.id !== entry.feature_id);
        const built = buildFeatureFile({ draft: entry.draft, mode: entry.op, base: baseFeature ? { text: current.text, feature: baseFeature } : null,
          features: baseFeature ? [...others, baseFeature] : others, invalidIds: defs.invalidIds });
        if (built.errors.length) {
          save({ ...entry, by, state: 'failed', message: built.errors.map((e) => `${e.field}: ${e.message}`).join(' '), last_try_at: now() });
          return { outcome: 'invalid', key: entry.key, errors: built.errors, message: 'Not published: the edit is no longer valid against the current definitions. It is kept on this machine.' };
        }
        diff = built.diff;
        await writeFile(entry.file, built.text, { sha: current?.sha, create: entry.op === 'create', message: commitMessage(entry, diff, by) });
      }
    } catch (err) {
      if (!(err instanceof SourceError)) throw err;
      if (err.kind === 'conflict') {
        save({ ...entry, by, state: 'conflict', message: err.message, last_try_at: now() });
        logAlertEvent({ event: 'feature_edit_conflict', feature: entry.feature_id, source: 'feature-edit', id: entry.key, detail: err.message });
        return { outcome: 'conflict', key: entry.key, message: `Not published: ${err.message} Nothing was overwritten and your edit is kept on this machine. Open the latest version, then apply your edit again.` };
      }
      const pending = err.kind === 'unreachable';
      save({ ...entry, by, state: pending ? 'pending' : 'failed', message: err.message, last_try_at: now() });
      logAlertEvent({ event: 'feature_edit_failed', feature: entry.feature_id, source: 'feature-edit', id: entry.key, detail: err.message });
      return {
        outcome: pending ? 'queued' : 'not_published', key: entry.key,
        message: pending
          ? `Not published yet: the shared repo can't be reached (${err.message}) Your edit is kept on this machine and will be published once the repo is reachable again.`
          : `Not published yet: ${err.message} Your edit is kept on this machine.`,
      };
    }
    drop(entry.key);
    logAlertEvent({ event: 'feature_edit_published', feature: entry.feature_id, source: 'feature-edit', id: entry.key, detail: `${entry.op}${diff?.length ? ` (${summary(diff)})` : ''} by ${by}` });
    return { outcome: 'published', key: entry.key, op: entry.op, id: entry.feature_id, by, diff,
      message: `Committed to ${where()} as ${by}. Teammates see it on their next Refresh View.` };
  }

  // op: create | update | delete. base_hash: hash of the file as the editor opened it (update/delete).
  // files: Map(path -> text) of the definitions LifeCycle has now. defs: { featureDefs, invalidIds }.
  // review: async (built) => review result (src/features/review.js), run before anything is saved.
  // via: 'chat' when the edit was confirmed in the LifeCycle chat (app or AI tools); shown in the commit.
  async function submit({ op, id, draft, base_hash, confirm_dependents = false, via = 'form' }, { defs, files, review }) {
    const base = op === 'create' ? null : defs.featureDefs.find((f) => f.id === id);
    if (op !== 'create' && !base) return { outcome: 'not_found', message: `No valid feature "${id}" is defined, so it can't be ${op === 'delete' ? 'deleted' : 'edited'} here.` };
    if (op !== 'create' && files.has(base.file) && base_hash && textHash(files.get(base.file)) !== base_hash) {
      // This LifeCycle has already loaded someone else's newer version: keep the edit, say who.
      const err = await staleError(base.file, `changed ${id}`);
      const entry = save({ key: `${id}-${crypto.randomBytes(3).toString('hex')}`, op, feature_id: id, file: base.file, draft: op === 'delete' ? null : draft,
        base_hash, diff: null, name: base.name, via, state: 'conflict', message: err.message, created_at: new Date().toISOString(), last_try_at: new Date().toISOString() });
      logAlertEvent({ event: 'feature_edit_conflict', feature: id, source: 'feature-edit', id: entry.key, detail: err.message });
      return { outcome: 'conflict', key: entry.key, message: `Not published: ${err.message} Nothing was overwritten and your edit is kept on this machine. Open the latest version, then apply your edit again.` };
    }
    let built = null;
    let reviewed = null;
    if (op === 'delete') {
      const dependents = dependentsOf(id, defs.featureDefs);
      if (dependents.length && !confirm_dependents) {
        return { outcome: 'has_dependents', dependents, message: `${dependents.map((d) => d.name).join(', ')} ${dependents.length === 1 ? 'depends' : 'depend'} on ${base.name}. Deleting it leaves ${dependents.length === 1 ? 'that feature' : 'those features'} with an unknown dependency. Confirm to delete anyway.` };
      }
    } else {
      built = buildFeatureFile({ draft, mode: op, base: base ? { text: files.get(base.file), feature: base } : null, features: defs.featureDefs, invalidIds: defs.invalidIds, projects: defs.projectDefs || null });
      if (built.errors.length) return { outcome: 'invalid', errors: built.errors, diff: built.diff || null, message: 'Can\'t publish: fix the fields marked below.' };
      if (op === 'update' && !built.diff.length) return { outcome: 'invalid', errors: [], diff: [], message: 'Nothing to publish: no field changed.' };
      reviewed = await review(built);
      if (reviewed.blocking) return { outcome: 'invalid', errors: [], review: reviewed, diff: built.diff, message: 'Can\'t publish: the AI product review found contradictions. Fix them first.' };
    }
    const fid = op === 'create' ? built.feature.id : id;
    const entry = save({
      key: `${fid}-${crypto.randomBytes(3).toString('hex')}`,
      op, feature_id: fid, file: op === 'create' ? built.path : base.file,
      draft: op === 'delete' ? null : draft,
      base_hash: op === 'create' ? null : base_hash || textHash(files.get(base.file)),
      diff: built?.diff || null, name: op === 'create' ? built.feature.name : base.name, via,
      state: 'pending', message: null, created_at: new Date().toISOString(), last_try_at: null,
    });
    const result = await attempt(entry, defs);
    return { ...result, review: reviewed };
  }

  // Retries edits waiting for the shared repo (all: also failed ones).
  async function flush(defs, { all = false } = {}) {
    const results = [];
    for (const e of listFeatureOutbox()) if (e.state === 'pending' || (all && e.state === 'failed')) results.push(await attempt(e, defs));
    return results;
  }

  function discard(key) {
    const e = readJson(entryFile(key));
    if (e) logAlertEvent({ event: 'feature_edit_discarded', feature: e.feature_id, source: 'feature-edit', id: key });
    drop(key);
  }

  // The shared data's file operations, also used to publish team edits (src/teams/publish.js).
  const io = { readCurrent, writeFile, deleteFile, staleError, where, toRepo };
  return { submit, flush, discard, access, io };
}
