// Mobile apps from LifeCycle: create, edit and delete `apps/<id>.yaml` in the shared repo with the
// person's own GitHub credentials, through the same file operations and access check as feature edits
// (src/features/publish.js). The file goes through exactly the validation a hand-written one does
// (validateApp). Editing keeps the file's comments and any key the form doesn't show; the id stays.
//
// The form's draft: { id, name, owner, repo, release_tag, ios_store_id, android_store_id,
// slack, hint }. iOS is published on the App Store, Android on Google Play.
import { Document, parseDocument } from 'yaml';
import { validateApp } from '../definitions.js';
import { SourceError } from '../sources/github-client.js';
import { looksLikeToken } from '../log.js';

const ID = /^[a-z0-9][a-z0-9-]*$/;
const FIELDS = ['name', 'owner', 'repo', 'release_tag', 'ios_store_id', 'android_store_id', 'slack', 'hint'];
const clean = (v) => (typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v).trim());
export const appSlug = (text) => clean(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '');

// The form's fields for an app definition (validated app, or the raw YAML of one).
export function appDraft(app) {
  return {
    id: app.id, name: app.name || '', owner: app.owner || '', repo: app.repo || '', release_tag: app.releaseTag || '',
    ios_store_id: app.platforms?.ios?.store_id || '', android_store_id: app.platforms?.android?.store_id || '',
    slack: app.releaseChannel?.slack || '', hint: app.releaseChannel?.hint || '',
  };
}
const fromDoc = (doc) => {
  const js = doc.toJS() || {};
  const p = js.platforms || {};
  return {
    name: clean(js.name), owner: clean(js.owner), repo: clean(js.repo), release_tag: clean(js.release_tag),
    ios_store_id: clean(p.ios?.store_id), android_store_id: clean(p.android?.store_id),
    slack: clean(js.release_channel?.slack), hint: clean(js.release_channel?.hint),
  };
};

// Applies the draft to a YAML document (new or the current file). Empty optional fields are removed.
// only: the form fields to write (an edit writes just what changed, so untouched parts of a
// hand-written file keep their layout and comments); null writes them all.
function applyDraft(doc, d, only = null) {
  const want = (k) => !only || only.includes(k);
  const set = (key, value) => { if (!want(key)) return; if (value) doc.set(key, value); else if (doc.has(key)) doc.delete(key); };
  set('name', d.name);
  set('owner', d.owner);
  set('repo', d.repo);
  set('release_tag', d.release_tag);
  const platform = (key, store, id) => {
    if (!want(`${key}_store_id`)) return;
    if (!id) { if (doc.hasIn(['platforms', key])) doc.deleteIn(['platforms', key]); return; }
    const node = doc.createNode({ store, store_id: id });
    node.flow = true;
    doc.setIn(['platforms', key], node);
  };
  if (!doc.has('platforms')) doc.set('platforms', doc.createNode({}));
  platform('ios', 'app_store', d.ios_store_id);
  platform('android', 'google_play', d.android_store_id);
  if (!want('slack') && !want('hint')) return;
  if (d.slack) {
    if (want('slack')) doc.setIn(['release_channel', 'slack'], d.slack);
    if (d.hint) doc.setIn(['release_channel', 'hint'], d.hint);
    else if (doc.hasIn(['release_channel', 'hint'])) doc.deleteIn(['release_channel', 'hint']);
  } else if (doc.has('release_channel')) doc.delete('release_channel');
}

function draftErrors(d) {
  const errors = [];
  for (const k of FIELDS) if (looksLikeToken(d[k])) errors.push({ field: k, message: 'looks like a token or credential; never put credentials in the shared repo' });
  if (!d.ios_store_id && !d.android_store_id) errors.push({ field: 'ios_store_id', message: 'add the App Store id (iOS), the Google Play package (Android), or both' });
  return errors;
}

// Maps validateApp's field names to the form's.
const FORM_FIELD = { 'platforms.ios.store_id': 'ios_store_id', 'platforms.android.store_id': 'android_store_id', platforms: 'ios_store_id',
  'release_channel.slack': 'slack', 'release_channel.hint': 'hint', release_channel: 'slack' };
const formErrors = (errors) => errors.map((e) => ({ field: FORM_FIELD[e.field] || e.field, message: e.message }));

// draft → { errors, path, text, app } for a new app. apps: the defined apps.
export function buildAppFile(draft, apps = []) {
  const d = Object.fromEntries(FIELDS.map((k) => [k, clean(draft?.[k])]));
  d.id = clean(draft?.id) || appSlug(d.name);
  const errors = [];
  if (!d.id) errors.push({ field: 'id', message: 'is required' });
  else if (!ID.test(d.id)) errors.push({ field: 'id', message: 'must use lowercase letters, digits and dashes' });
  else if (apps.some((a) => a.id === d.id)) errors.push({ field: 'id', message: `"${d.id}" is already an app; pick another name or id` });
  errors.push(...draftErrors(d));
  if (errors.length) return { errors };
  const doc = new Document({ id: d.id });
  applyDraft(doc, d);
  const path = `apps/${d.id}.yaml`;
  const text = doc.toString({ lineWidth: 0 });
  const checked = validateApp(path, text);
  if (checked.errors.length) return { errors: formErrors(checked.errors), path, text };
  return { errors: [], path, text, app: checked.app };
}

const writeError = (err, verb) => {
  if (!(err instanceof SourceError)) throw err;
  if (err.kind === 'conflict') return { outcome: 'conflict', message: `Not ${verb}: ${err.message}` };
  return { outcome: 'not_published', message: `Not ${verb}: ${err.message} Nothing was changed; try again once the shared repo can be reached.` };
};

// io: featurePublisher.io. Returns { outcome: published | invalid | conflict | not_published, … }.
export async function createAppDefinition({ draft, apps, io, whoAmI, where }) {
  const built = buildAppFile(draft, apps);
  if (built.errors.length) return { outcome: 'invalid', errors: built.errors, message: "Can't create the app yet: fix the fields marked." };
  const by = await whoAmI();
  if (!by) return { outcome: 'not_published', message: "Not created: LifeCycle can't tell your GitHub user right now. Try again in a moment." };
  try {
    if (await io.readCurrent(built.path)) {
      return { outcome: 'conflict', errors: [{ field: 'id', message: `${built.path} already exists in the shared repo` }], message: `Not created: ${built.path} already exists. Refresh View to see it.` };
    }
    await io.writeFile(built.path, built.text, { create: true, message: `Add app ${built.app.id} (by ${by} from LifeCycle)` });
  } catch (err) {
    return writeError(err, 'created');
  }
  return { outcome: 'published', id: built.app.id, path: built.path, by, message: `Created ${built.app.name}: committed ${built.path} to ${where} as ${by}.` };
}

// base: the form's fields as it was opened; if the file changed since, the edit is refused.
export async function updateAppDefinition({ id, draft, base = null, apps, io, whoAmI, where }) {
  const a = apps.find((x) => x.id === id);
  if (!a) return { outcome: 'not_found', message: `No app "${id}" is defined, so it can't be edited.` };
  const d = Object.fromEntries(FIELDS.map((k) => [k, clean(draft?.[k])]));
  const errors = draftErrors(d);
  if (errors.length) return { outcome: 'invalid', errors, message: "Can't save yet: fix the fields marked." };
  const by = await whoAmI();
  if (!by) return { outcome: 'not_published', message: "Not saved: LifeCycle can't tell your GitHub user right now. Try again in a moment." };
  try {
    const current = await io.readCurrent(a.file);
    if (!current) return { outcome: 'conflict', message: `Not saved: ${a.file} was deleted from the shared repo after you opened it.` };
    const doc = parseDocument(current.text);
    const now = fromDoc(doc);
    if (base && FIELDS.some((k) => clean(base[k]) !== now[k])) {
      return { outcome: 'conflict', message: `Not saved: someone changed ${now.name || id} after you opened it. Reload the page to see their change, then edit again.` };
    }
    const changed = FIELDS.filter((k) => d[k] !== now[k]);
    if (!changed.length) return { outcome: 'unchanged', id, message: 'Nothing changed.' };
    applyDraft(doc, d, changed);
    const text = doc.toString({ lineWidth: 0 });
    const checked = validateApp(a.file, text);
    if (checked.errors.length) return { outcome: 'invalid', errors: formErrors(checked.errors), message: "Can't save yet: fix the fields marked." };
    const words = { release_tag: 'release tag', ios_store_id: 'iOS', android_store_id: 'Android', slack: 'Slack channel', hint: 'Slack hint' };
    await io.writeFile(a.file, text, { sha: current.sha, message: `Edit app ${id}: ${[...new Set(changed.map((k) => words[k] || k))].join(', ')} (by ${by} from LifeCycle)` });
    return { outcome: 'published', id, path: a.file, by, changed, message: `Saved ${d.name}: committed ${a.file} to ${where} as ${by}.` };
  } catch (err) {
    return writeError(err, 'saved');
  }
}

// Refused while features still list the app (they would point at an app that no longer exists).
export async function deleteAppDefinition({ id, apps, features, io, whoAmI, where }) {
  const a = apps.find((x) => x.id === id);
  if (!a) return { outcome: 'not_found', message: `No app "${id}" is defined, so there is nothing to delete.` };
  const using = features.filter((f) => (f.apps || []).some((x) => x.id === id)).map((f) => ({ id: f.id, name: f.name }));
  if (using.length) {
    return { outcome: 'has_features', features: using,
      message: `${using.length === 1 ? '1 feature ships' : `${using.length} features ship`} in ${a.name} (${using.map((f) => f.name).join(', ')}). Remove the app from ${using.length === 1 ? 'it' : 'them'} first (apps: in the feature definition), then delete the app.` };
  }
  const by = await whoAmI();
  if (!by) return { outcome: 'not_published', message: "Not deleted: LifeCycle can't tell your GitHub user right now. Try again in a moment." };
  try {
    const current = await io.readCurrent(a.file);
    if (!current) return { outcome: 'conflict', message: `Not deleted: ${a.file} is already gone from the shared repo. Refresh View to see it.` };
    await io.deleteFile(a.file, { sha: current.sha, message: `Delete app ${id} (by ${by} from LifeCycle)` });
  } catch (err) {
    return writeError(err, 'deleted');
  }
  return { outcome: 'published', id, path: a.file, by, message: `Deleted ${a.name}: removed ${a.file} from ${where} as ${by}.` };
}
