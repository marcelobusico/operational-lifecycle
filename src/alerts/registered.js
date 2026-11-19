// Registering a change: the form's draft → a `changes/<id>.yaml` file in format v2
// (docs/alerts-format.md). The file holds only the change, the features, the reason and the
// author's GitHub user. A draft missing what, which feature or why can't be built, and each error
// names the field.
import crypto from 'node:crypto';
import { stringify } from 'yaml';
import { CHANGE_TARGETS } from '../changes.js';
import { validateChange } from '../definitions.js';
import { looksLikeToken } from '../log.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const clean = (v) => (typeof v === 'string' ? v.trim() : '');

const slug = (text) => clean(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'change';

export function newChangeId(draft, now = new Date()) {
  return `${now.toISOString().slice(0, 10)}-${slug(draft.change || draft.what_name)}-${crypto.randomBytes(3).toString('hex')}`;
}

// draft: { what_type, what_name, change, features: [ids], state: planned|done, planned_for, reason, link }
// Returns [{ field, message }]. `field` is the form field: what, features, reason, planned_for, link, state.
export function draftErrors(draft, features) {
  const errors = [];
  const d = draft || {};
  if (!CHANGE_TARGETS.includes(d.what_type)) errors.push({ field: 'what', message: `What will change is missing: choose a flag, service, contract or decision.` });
  if (!clean(d.what_name)) errors.push({ field: 'what', message: 'What will change is missing: name the flag, service, contract or decision.' });
  if (!clean(d.change)) errors.push({ field: 'what', message: 'What will change is missing: describe the change.' });
  const ids = Array.isArray(d.features) ? d.features.filter((x) => typeof x === 'string') : [];
  if (!ids.length) errors.push({ field: 'features', message: 'Which feature is missing: choose at least one affected feature.' });
  const known = new Set(features.map((f) => f.id));
  for (const id of ids) if (!known.has(id)) errors.push({ field: 'features', message: `"${id}" is not a defined feature.` });
  if (!clean(d.reason)) errors.push({ field: 'reason', message: 'Why is missing: give the reason for the change.' });
  if (!['planned', 'done'].includes(d.state)) errors.push({ field: 'state', message: 'Say whether the change is planned or already done.' });
  if (d.state === 'planned' && (!DATE.test(clean(d.planned_for)) || isNaN(Date.parse(d.planned_for)))) {
    errors.push({ field: 'planned_for', message: 'A planned change needs its date (YYYY-MM-DD).' });
  }
  if (clean(d.link) && !/^https?:\/\//.test(clean(d.link))) errors.push({ field: 'link', message: 'The evidence link must be an http(s) URL.' });
  for (const k of ['what_name', 'change', 'reason', 'link']) {
    if (looksLikeToken(d[k] || '')) errors.push({ field: k === 'what_name' || k === 'change' ? 'what' : k, message: 'This looks like a token or credential; never put credentials in the shared repo.' });
  }
  return errors;
}

// Builds the file for a new change, an update (prev given) or a cancellation (cancel: true).
// Returns { errors, change, path, text }.
export function buildChangeFile({ draft, features, by, now = new Date(), prev = null, cancel = false, id: fixedId = null }) {
  const d = cancel ? { ...toDraft(prev), state: 'done', ...(clean(draft?.reason) ? { reason: draft.reason } : {}) } : draft;
  const errors = draftErrors(d, features);
  if (errors.length) return { errors };
  const id = prev ? prev.id : fixedId || newChangeId(d, now);
  const doc = {
    id,
    what: { type: d.what_type, name: clean(d.what_name) },
    change: clean(d.change),
    features: [...new Set(d.features)],
    state: cancel ? 'cancelled' : d.state,
    ...(d.state === 'planned' || (cancel && prev?.planned_for) ? { planned_for: clean(d.planned_for) || prev?.planned_for } : {}),
    reason: clean(d.reason),
    registered_by: prev ? prev.registered_by : by,
    registered_at: prev ? prev.registered_at : now.toISOString(),
    ...(prev ? { updated_at: now.toISOString(), updated_by: by } : {}),
    revision: prev ? (prev.revision || 1) + 1 : 1,
    ...(clean(d.link) ? { link: clean(d.link) } : {}),
  };
  const path = `changes/${id}.yaml`;
  const text = stringify(doc, { lineWidth: 0 });
  const checked = validateChange(path, text);
  if (checked.errors.length) return { errors: checked.errors.map((e) => ({ field: e.field, message: e.message })) };
  return { errors: [], change: checked.change, path, text };
}

// A published change back into the form's shape (for editing or cancelling).
export function toDraft(c) {
  return {
    what_type: c.what?.type || (CHANGE_TARGETS.includes(c.kind) ? c.kind : null),
    what_name: c.what?.name || '',
    change: c.summary || '',
    features: c.features || [c.feature],
    state: c.state === 'planned' ? 'planned' : 'done',
    planned_for: c.planned_for || '',
    reason: c.reason || '',
    link: c.link || '',
  };
}
