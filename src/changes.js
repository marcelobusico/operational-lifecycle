// Registered changes and the alert list: the two inputs, besides the live feature status, that
// answers and digests are built from (docs/ask-format.md).
//
// - Registered changes are files in the shared repo, `changes/<id>.yaml`, read with the
//   definitions (same cache and "last synced" handling).
// - The alert list (`lifecycle.alerts/v1`) is produced by the alerts work and read from a file or
//   URL set in the local config (`alerts.source`). Its last good copy is cached, so when it can't
//   be read the answer says so and gives the time of the last successful read.
import fs from 'node:fs';
import path from 'node:path';
import { paths, writeJson } from './config.js';
import { logSourceRead, redact } from './log.js';

export const CHANGE_KINDS = ['flag', 'dependency', 'schedule', 'scope', 'deploy', 'service', 'contract', 'decision', 'other'];
// What a registered change is about (format v2, docs/alerts-format.md).
export const CHANGE_TARGETS = ['flag', 'service', 'contract', 'decision'];
export const CHANGE_STATES = ['planned', 'done', 'cancelled'];
export const ALERTS_SCHEMA = 'lifecycle.alerts/v1';
const ID = /^[a-z0-9][a-z0-9-]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// Only these fields may be in a registered change: the change, the features, the reason and the
// author's GitHub user. Anything else (emails, names, notes, credentials) is refused.
const V2_FIELDS = new Set(['id', 'what', 'change', 'features', 'state', 'planned_for', 'reason', 'registered_by', 'registered_at', 'updated_at', 'updated_by', 'revision', 'link']);
const V1_FIELDS = new Set(['id', 'feature', 'kind', 'summary', 'registered_by', 'registered_at', 'link']);

const isoOf = (v) => (v instanceof Date ? v.toISOString() : v);

// Validates one parsed `changes/<id>.yaml`. readDoc is the shared YAML reader from definitions.js.
// Format v2 (features/what/change/state/reason) and the earlier v1 (feature/kind/summary) are both read.
export function validateChangeDoc(r, file) {
  if (!r.doc) return { errors: r.errors };
  const { doc, fail, str } = r;
  const v2 = doc.features !== undefined || doc.what !== undefined || doc.change !== undefined || doc.state !== undefined;
  const allowed = v2 ? V2_FIELDS : V1_FIELDS;
  for (const k of Object.keys(doc)) if (!allowed.has(k)) fail(k, 'is not a registered-change field (only the change, features, reason and author belong here)');

  let features;
  let kind;
  let summary;
  let what = null;
  let state = 'done';
  let plannedFor = null;
  let reason = null;
  let revision = 1;
  if (v2) {
    if (!Array.isArray(doc.features) || !doc.features.length) fail('features', 'is required: at least one feature id');
    else if (doc.features.some((x) => typeof x !== 'string' || !ID.test(x))) fail('features', 'must be a list of feature ids');
    features = Array.isArray(doc.features) ? [...new Set(doc.features.filter((x) => typeof x === 'string'))] : [];
    if (!doc.what || typeof doc.what !== 'object' || Array.isArray(doc.what)) fail('what', 'is required: what will change (type and name)');
    else {
      const type = str(doc.what, 'type', 'what.type');
      if (type !== undefined && !CHANGE_TARGETS.includes(type)) fail('what.type', `must be one of: ${CHANGE_TARGETS.join(', ')}`);
      const name = str(doc.what, 'name', 'what.name');
      for (const k of Object.keys(doc.what)) if (!['type', 'name'].includes(k)) fail(`what.${k}`, 'is not a field of what');
      what = { type, name };
    }
    summary = str(doc, 'change', 'change');
    kind = what?.type || 'other';
    state = str(doc, 'state', 'state');
    if (state !== undefined && !CHANGE_STATES.includes(state)) fail('state', `must be one of: ${CHANGE_STATES.join(', ')}`);
    let pf = doc.planned_for ?? null;
    if (pf instanceof Date) pf = pf.toISOString().slice(0, 10);
    if (pf !== null && (typeof pf !== 'string' || !DATE.test(pf) || isNaN(Date.parse(pf)))) fail('planned_for', 'must be a date as YYYY-MM-DD');
    else plannedFor = pf;
    if (state === 'planned' && !plannedFor) fail('planned_for', 'is required for a planned change');
    reason = str(doc, 'reason', 'reason');
    if (doc.revision !== undefined && (!Number.isInteger(doc.revision) || doc.revision < 1)) fail('revision', 'must be a positive whole number');
    else if (doc.revision !== undefined) revision = doc.revision;
  } else {
    const feature = str(doc, 'feature', 'feature');
    if (feature !== undefined && !ID.test(feature)) fail('feature', 'must be a feature id (lowercase letters, digits and dashes)');
    features = feature ? [feature] : [];
    kind = str(doc, 'kind', 'kind');
    if (kind !== undefined && !CHANGE_KINDS.includes(kind)) fail('kind', `must be one of: ${CHANGE_KINDS.join(', ')}`);
    summary = str(doc, 'summary', 'summary');
  }
  const registeredBy = str(doc, 'registered_by', 'registered_by');
  const registeredAt = isoOf(doc.registered_at);
  if (registeredAt === undefined || registeredAt === null || registeredAt === '') fail('registered_at', 'is required');
  else if (typeof registeredAt !== 'string' || isNaN(Date.parse(registeredAt))) fail('registered_at', 'must be a date-time, e.g. 2026-11-02T15:00:00Z');
  const updatedAt = isoOf(doc.updated_at ?? null);
  if (updatedAt !== null && (typeof updatedAt !== 'string' || isNaN(Date.parse(updatedAt)))) fail('updated_at', 'must be a date-time');
  const updatedBy = v2 ? str(doc, 'updated_by', 'updated_by', false) || null : null;
  const link = str(doc, 'link', 'link', false) || null;
  if (link && !/^https?:\/\//.test(link)) fail('link', 'must be an http(s) URL');
  if (r.errors.length) return { errors: r.errors };
  return {
    errors: [],
    change: {
      id: r.id, format: v2 ? 2 : 1,
      feature: features[0], features, kind, what, summary, reason, state, planned_for: plannedFor, revision,
      registered_by: registeredBy, registered_at: new Date(registeredAt).toISOString(),
      updated_at: updatedAt ? new Date(updatedAt).toISOString() : null, updated_by: updatedBy, link, file,
    },
  };
}

// Where a registered change can be opened: the file in the shared repo (or the local API when the
// definitions come from a local folder).
export function changeLink(config, change) {
  if (config.dataPath) return `/api/changes/${encodeURIComponent(change.id)}`;
  return `https://github.com/${config.dataRepo}/blob/${encodeURIComponent(config.dataBranch)}/${change.file}`;
}

export function definitionLink(config, file) {
  if (!file) return null;
  if (config.dataPath) return `/api/definitions/${file}`;
  return `https://github.com/${config.dataRepo}/blob/${encodeURIComponent(config.dataBranch)}/${file}`;
}

const alertsCache = () => path.join(paths.cacheDir(), 'alerts.json');

function validAlert(a) {
  return a && typeof a === 'object' && typeof a.id === 'string' && typeof a.feature === 'string'
    && typeof a.message === 'string' && typeof a.at === 'string' && !isNaN(Date.parse(a.at));
}

function normalizeAlerts(body) {
  if (!body || body.schema !== ALERTS_SCHEMA || !Array.isArray(body.alerts)) {
    throw new Error(`not a ${ALERTS_SCHEMA} alert list`);
  }
  return body.alerts.filter(validAlert).map((a) => ({
    id: a.id, feature: a.feature, kind: a.kind || 'other', severity: a.severity || 'info', message: a.message,
    at: new Date(a.at).toISOString(), link: typeof a.link === 'string' && /^https?:\/\//i.test(a.link.trim()) ? a.link.trim() : null,
    registered_change: typeof a.registered_change === 'string' ? a.registered_change : null,
  }));
}

// Returns { alerts, meta: { source, configured, stale, read_at, last_successful_read_at, error } }.
export async function readAlerts(config, { fetchImpl = fetch } = {}) {
  const source = config.alerts?.source || null;
  if (!source) {
    return { alerts: [], meta: { source: null, configured: false, stale: false, read_at: null, last_successful_read_at: null, error: null } };
  }
  const readAt = new Date().toISOString();
  try {
    let body;
    if (/^https?:\/\//.test(source)) {
      const res = await fetchImpl(source, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = await res.json();
    } else {
      body = JSON.parse(fs.readFileSync(path.resolve(source), 'utf8'));
    }
    const alerts = normalizeAlerts(body);
    writeJson(alertsCache(), { source, read_at: readAt, alerts });
    logSourceRead({ source: 'alerts', feature: '*', target: source, outcome: 'ok', detail: `${alerts.length} alerts` });
    return { alerts, meta: { source, configured: true, stale: false, read_at: readAt, last_successful_read_at: readAt, error: null } };
  } catch (err) {
    const message = redact(`The alert list (${source}) could not be read: ${err.message}`);
    logSourceRead({ source: 'alerts', feature: '*', target: source, outcome: 'unreachable', detail: message });
    let cached = null;
    try {
      cached = JSON.parse(fs.readFileSync(alertsCache(), 'utf8'));
      if (cached.source !== source) cached = null;
    } catch { /* never read */ }
    return {
      alerts: cached?.alerts || [],
      meta: { source, configured: true, stale: true, read_at: readAt, last_successful_read_at: cached?.read_at || null, error: message },
    };
  }
}
