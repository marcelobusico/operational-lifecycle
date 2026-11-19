// Creating a project from LifeCycle: a direct commit of `projects/<id>.yaml` to the shared repo with
// the person's own GitHub credentials, through the same file operations and access check as feature
// edits (src/features/publish.js). The file goes through exactly the validation a hand-written one
// does (validateProject). A project that already exists is never overwritten.
import { Document } from 'yaml';
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
