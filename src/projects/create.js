// Creating a project from LifeCycle: a direct commit of `projects/<id>.yaml` to the shared repo with
// the person's own GitHub credentials, through the same file operations and access check as feature
// edits (src/features/publish.js). The file goes through exactly the validation a hand-written one
// does (validateProject). A project that already exists is never overwritten. Deleting one
// (deleteProject) is refused while features are still in it.
import { Document, parseDocument } from 'yaml';
import { validateProject } from '../definitions.js';
import { SourceError } from '../sources/github-client.js';
import { looksLikeToken } from '../log.js';

const ID = /^[a-z0-9][a-z0-9-]*$/;
const clean = (v) => (typeof v === 'string' ? v.trim() : '');
export const projectSlug = (text) => clean(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '');

// draft: { id?, name, owner?, description? }. projects: the defined projects.
// Returns { errors: [{ field, message }], path, text, project }.
export function buildProjectFile(draft, projects = []) {
  const d = { name: clean(draft?.name), owner: clean(draft?.owner), description: clean(draft?.description) };
  d.id = clean(draft?.id) || projectSlug(d.name);
  const errors = [];
  if (!d.name) errors.push({ field: 'name', message: 'is required' });
  if (!d.id) errors.push({ field: 'id', message: 'is required' });
  else if (!ID.test(d.id)) errors.push({ field: 'id', message: 'must use lowercase letters, digits and dashes' });
  else if (projects.some((p) => p.id === d.id)) errors.push({ field: 'id', message: `"${d.id}" is already a project; pick another name or id` });
  for (const k of ['name', 'owner', 'description']) if (looksLikeToken(d[k])) errors.push({ field: k, message: 'looks like a token or credential; never put credentials in the shared repo' });
  if (errors.length) return { errors };
  const doc = new Document({ id: d.id, name: d.name, ...(d.owner ? { owner: d.owner } : {}), ...(d.description ? { description: d.description } : {}) });
  const path = `projects/${d.id}.yaml`;
  const text = doc.toString({ lineWidth: 0 });
  const checked = validateProject(path, text);
  if (checked.errors.length) return { errors: checked.errors.map((e) => ({ field: e.field, message: e.message })), path, text };
  return { errors: [], path, text, project: checked.project };
}

// io: featurePublisher.io. Returns { outcome: published | invalid | conflict | not_published, … }.
export async function publishProject({ draft, projects, io, whoAmI, where }) {
  const built = buildProjectFile(draft, projects);
  if (built.errors.length) return { outcome: 'invalid', errors: built.errors, message: "Can't create the project yet: fix the fields marked." };
  const by = await whoAmI();
  if (!by) return { outcome: 'not_published', message: "Not created: LifeCycle can't tell your GitHub user right now. Try again in a moment." };
  try {
    if (await io.readCurrent(built.path)) {
      return { outcome: 'conflict', errors: [{ field: 'id', message: `${built.path} already exists in the shared repo` }], message: `Not created: ${built.path} already exists. Refresh to see it.` };
    }
    await io.writeFile(built.path, built.text, { create: true, message: `Add project ${built.project.id} (by ${by} from LifeCycle)` });
  } catch (err) {
    if (!(err instanceof SourceError)) throw err;
    if (err.kind === 'conflict') return { outcome: 'conflict', message: `Not created: ${err.message}` };
    return { outcome: 'not_published', message: `Not created: ${err.message} Nothing was saved; try again once the shared repo can be reached.` };
  }
  return { outcome: 'published', id: built.project.id, path: built.path, by, message: `Created ${built.project.name}: committed ${built.path} to ${where} as ${by}.` };
}

// Deleting a project: one commit removing projects/<id>.yaml, as this person. Refused while features
// are still in it (they would point at a project that no longer exists): move them to another project
// or "No project" first. Returns { outcome: published | has_features | not_found | conflict | not_published, … }.
export async function deleteProject({ id, projects, features, io, whoAmI, where }) {
  const p = projects.find((x) => x.id === id);
  if (!p) return { outcome: 'not_found', message: `No project "${id}" is defined, so there is nothing to delete.` };
  const inside = features.filter((f) => f.project === id).map((f) => ({ id: f.id, name: f.name }));
  if (inside.length) {
    return { outcome: 'has_features', features: inside,
      message: `${p.name} still has ${inside.length === 1 ? '1 feature' : `${inside.length} features`} (${inside.map((f) => f.name).join(', ')}). Move ${inside.length === 1 ? 'it' : 'them'} to another project or "No project" (Edit feature), or delete ${inside.length === 1 ? 'it' : 'them'}, then delete the project.` };
  }
  const by = await whoAmI();
  if (!by) return { outcome: 'not_published', message: "Not deleted: LifeCycle can't tell your GitHub user right now. Try again in a moment." };
  try {
    const current = await io.readCurrent(p.file);
    if (!current) return { outcome: 'conflict', message: `Not deleted: ${p.file} is already gone from the shared repo. Refresh to see it.` };
    await io.deleteFile(p.file, { sha: current.sha, message: `Delete project ${id} (by ${by} from LifeCycle)` });
  } catch (err) {
    if (!(err instanceof SourceError)) throw err;
    if (err.kind === 'conflict') return { outcome: 'conflict', message: `Not deleted: ${err.message}` };
    return { outcome: 'not_published', message: `Not deleted: ${err.message} Nothing was changed; try again once the shared repo can be reached.` };
  }
  return { outcome: 'published', id, path: p.file, by, message: `Deleted ${p.name}: removed ${p.file} from ${where} as ${by}.` };
}

// Editing a project: its name, owner and description (the id and file stay, so features keep
// pointing at it). base: those fields as the form opened them; if the file changed since, the edit
// is refused instead of overwriting someone else's change. Comments and other keys are kept.
// Returns { outcome: published | unchanged | invalid | not_found | conflict | not_published, … }.
export async function updateProject({ id, draft, base = null, projects, io, whoAmI, where }) {
  const p = projects.find((x) => x.id === id);
  if (!p) return { outcome: 'not_found', message: `No project "${id}" is defined, so it can't be edited.` };
  const d = { name: clean(draft?.name), owner: clean(draft?.owner), description: clean(draft?.description) };
  const errors = [];
  if (!d.name) errors.push({ field: 'name', message: 'is required' });
  for (const k of ['name', 'owner', 'description']) if (looksLikeToken(d[k])) errors.push({ field: k, message: 'looks like a token or credential; never put credentials in the shared repo' });
  if (errors.length) return { outcome: 'invalid', errors, message: "Can't save yet: fix the fields marked." };
  const by = await whoAmI();
  if (!by) return { outcome: 'not_published', message: "Not saved: LifeCycle can't tell your GitHub user right now. Try again in a moment." };
  try {
    const current = await io.readCurrent(p.file);
    if (!current) return { outcome: 'conflict', message: `Not saved: ${p.file} was deleted from the shared repo after you opened it.` };
    const doc = parseDocument(current.text);
    const now = Object.fromEntries(['name', 'owner', 'description'].map((k) => [k, clean(String(doc.get(k) ?? ''))]));
    if (base && ['name', 'owner', 'description'].some((k) => clean(base[k]) !== now[k])) {
      return { outcome: 'conflict', message: `Not saved: someone changed ${p.name} after you opened it. Reload the page to see their change, then edit again.` };
    }
    const changed = ['name', 'owner', 'description'].filter((k) => d[k] !== now[k]);
    if (!changed.length) return { outcome: 'unchanged', id, message: 'Nothing changed.' };
    for (const k of changed) { if (d[k]) doc.set(k, d[k]); else doc.delete(k); }
    const text = doc.toString({ lineWidth: 0 });
    const checked = validateProject(p.file, text);
    if (checked.errors.length) return { outcome: 'invalid', errors: checked.errors.map((e) => ({ field: e.field, message: e.message })), message: "Can't save yet: fix the fields marked." };
    await io.writeFile(p.file, text, { sha: current.sha, message: `Edit project ${id}: ${changed.join(', ')} (by ${by} from LifeCycle)` });
    return { outcome: 'published', id, path: p.file, by, changed, message: `Saved ${d.name}: committed ${p.file} to ${where} as ${by}.` };
  } catch (err) {
    if (!(err instanceof SourceError)) throw err;
    if (err.kind === 'conflict') return { outcome: 'conflict', message: `Not saved: ${err.message}` };
    return { outcome: 'not_published', message: `Not saved: ${err.message} Nothing was changed; try again once the shared repo can be reached.` };
  }
}
