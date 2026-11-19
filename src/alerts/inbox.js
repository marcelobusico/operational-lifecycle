// The alert list: every alert LifeCycle knows about, built on each refresh from
//   - registered changes in the shared repo (one alert per change revision, so an update or a
//     cancellation reaches the same people again),
//   - delay warnings LifeCycle works out itself.
// Plus, per person, which alerts are theirs (features they own or that depend on what changed, or
// that they follow) and which are new since they last looked (~/.lifecycle/alerts-seen.json).
import fs from 'node:fs';
import { paths, writeJson } from '../config.js';
import { ownsAny, withDependents } from './match.js';
import { delayInfo } from './delay.js';
import { logAlertEvent } from './log.js';

export const ALERT_LIST_SCHEMA = 'lifecycle.alert-list/v1';
export const SOURCES = ['registered', 'lifecycle'];

const trim = (t) => String(t || '').replace(/[.\s]+$/, '');
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };

export function buildAlertList({ features, statuses, changes, changeLink, config, now = new Date() }) {
  const names = new Map(features.map((f) => [f.id, f.name]));
  const name = (id) => names.get(id) || id;
  const alerts = [];

  for (const c of changes) {
    const { affected, dependents } = withDependents(features, c.features);
    const ids = affected.length ? affected : c.features;
    const head = c.state === 'cancelled' ? 'Cancelled: ' : c.state === 'planned' ? `Planned for ${c.planned_for}: ` : c.format === 2 ? 'Done: ' : '';
    const updated = c.revision > 1 && c.state !== 'cancelled' ? ' (updated)' : '';
    const by = c.updated_by && c.revision > 1 ? c.updated_by : c.registered_by;
    const summary = trim(c.summary);
    alerts.push({
      id: `change:${c.id}@r${c.revision || 1}`, source: 'registered', source_label: `Registered by ${by}`, at: c.updated_at || c.registered_at,
      kind: c.kind, feature: ids[0], features: ids, dependents, feature_names: Object.fromEntries([...ids, ...dependents].map((id) => [id, name(id)])),
      change: `${head}${summary}${updated}`,
      message: `${head}${summary}${updated}${c.reason ? `. Why: ${trim(c.reason)}` : ''}. Affects ${ids.map(name).join(', ')}${dependents.length ? `; depending on it: ${dependents.map(name).join(', ')}` : ''}. Registered by ${c.registered_by}${c.revision > 1 && c.updated_by ? `, updated by ${c.updated_by}` : ''}.`,
      change_id: c.id, revision: c.revision || 1, state: c.state, planned_for: c.planned_for, reason: c.reason, what: c.what,
      registered_by: c.registered_by, updated_by: c.updated_by,
      evidence: [{ label: `registered change ${c.id}`, link: changeLink(c) }, ...(c.link ? [{ label: 'linked from the change', link: c.link }] : [])],
    });
  }

  const delay = {};
  for (const s of statuses) {
    const d = delayInfo(s, { now, daysPerStep: config.delay?.daysPerStep ?? 3 });
    delay[s.feature.id] = d;
    if (!d.at_risk) continue;
    const { dependents } = withDependents(features, [s.feature.id]);
    alerts.push({
      id: `delay:${s.feature.id}:${d.target_date}`, source: 'lifecycle', source_label: 'LifeCycle (delay warning)', at: now.toISOString(),
      kind: 'schedule', feature: s.feature.id, features: [s.feature.id], dependents, feature_names: Object.fromEntries([s.feature.id, ...dependents].map((id) => [id, name(id)])),
      change: d.text, message: `${s.feature.name}: ${d.text}`, open_steps: d.open_steps, target_date: d.target_date, days_left: d.days_left,
      evidence: s.steps.filter((x) => x.state !== 'done').flatMap((x) => x.evidence.filter((e) => e.link).map((e) => ({ label: `${x.name}: ${e.source === 'jira' ? `Jira ${e.key}` : `${e.type === 'pr' ? 'PR' : 'issue'} #${e.number}`}`, link: e.link }))),
    });
  }

  alerts.sort((a, b) => b.at.localeCompare(a.at));
  return { schema: ALERT_LIST_SCHEMA, alerts, delay };
}

// The person's view: `mine` (owns or follows an affected or dependent feature) and `new` (mine and
// not seen before). Pure: marking as seen is a separate call.
export function personalView(list, { features, me = [], follows = [], sourceFilter = null }) {
  const seen = new Set(readJson(paths.alertsSeen(), { seen: [] }).seen || []);
  const followed = new Set(follows);
  const alerts = list.alerts
    .filter((a) => !sourceFilter || a.source === sourceFilter)
    .map((a) => {
      const ids = [...a.features, ...a.dependents];
      const mine = ownsAny(features, ids, me) || ids.some((id) => followed.has(id));
      return { ...a, mine, new: mine && !seen.has(a.id) };
    });
  return { ...list, alerts,
    filter: sourceFilter, new_count: alerts.filter((a) => a.new).length, me, last_looked_at: readJson(paths.alertsSeen(), {}).last_looked_at || null };
}

// Records that the person has seen these alerts, so the same change is one alert per person.
// `own`: ids of alerts for a change this person just published themselves (not in `list` yet).
export function markSeen(ids, list, { own = false } = {}) {
  const state = readJson(paths.alertsSeen(), { seen: [] });
  const seen = new Set(state.seen || []);
  const byId = new Map(list.alerts.map((a) => [a.id, a]));
  for (const id of ids) {
    if (seen.has(id) || (!byId.has(id) && !own)) continue;
    seen.add(id);
    if (own) continue;
    const a = byId.get(id);
    logAlertEvent({ event: 'alert', id, feature: a.features.join(','), source: a.source, detail: a.change });
  }
  writeJson(paths.alertsSeen(), { last_looked_at: new Date().toISOString(), seen: [...seen] }, 0o600);
  return seen.size;
}
