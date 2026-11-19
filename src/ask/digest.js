// The digest: produced on this machine when the person opens LifeCycle (or asks for it from their
// AI tools), covering what changed since their last digest, for the features they own or follow.
// Changes are found by comparing the live snapshot with a compact copy saved at the last digest
// (~/.lifecycle/digest-state.json). A part that can't be read now is never reported as a change:
// the last known value is kept until it can be read again.
import fs from 'node:fs';
import { paths, writeJson } from '../config.js';
import { flagLinkLabel, storeSource } from '../lastmile/state.js';
import { buildFacts, dateRisk, freshness, STATE_LABEL, when } from './facts.js';
import { buildProjectFacts, projectName, projectStatusLink, projectView, projectShownState } from './projects.js';
import { evidenceId, evidenceLabel } from '../evidence.js';

export const DIGEST_SCHEMA = 'lifecycle.digest/v1';
const READABLE_FLAG = new Set(['on', 'off', 'partial']);
const ENV = { qa: 'QA', production: 'production' };
const FIRST_DIGEST_DAYS = 7;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function readFollows() {
  const f = readJson(paths.follows(), { follows: [] });
  return Array.isArray(f.follows) ? f.follows : [];
}

export function setFollow(featureId, follow) {
  const set = new Set(readFollows());
  if (follow) set.add(featureId);
  else set.delete(featureId);
  writeJson(paths.follows(), { follows: [...set].sort() }, 0o600);
  return [...set].sort();
}

const lower = (s) => String(s || '').trim().toLowerCase();

// 'owner' | 'following' | null
export function relationOf(status, owners, follows) {
  const mine = new Set(owners.map(lower).filter(Boolean));
  if (mine.size && (mine.has(lower(status.feature.owner)) || status.steps.some((s) => mine.has(lower(s.owner))))) return 'owner';
  if (follows.includes(status.feature.id)) return 'following';
  return null;
}

const evKey = evidenceId;
const blockerKey = (b) => `${b.kind}:${b.feature}:${b.step}`;

// What is remembered about a feature between digests. Unreadable parts are left out, so the
// previous value survives (see merge()).
function compact(status, now) {
  const lm = status.last_mile;
  const c = { name: status.feature.name, steps: {}, evidence: {}, flags: {}, deploys: {}, experiments: {}, stores: {} };
  if (status.state !== 'unavailable') {
    c.state = status.state;
    c.blockers = status.blockers.map(blockerKey);
  }
  for (const s of status.steps) {
    if (!['unavailable', 'no_access'].includes(s.state)) c.steps[s.id] = s.state;
    for (const e of s.evidence) {
      if (!['unavailable', 'no_access'].includes(e.state)) c.evidence[evKey(e)] = e.state;
    }
  }
  if (lm && lm.state !== 'unavailable') c.last_mile = lm.state;
  for (const fl of lm?.flags || []) {
    for (const env of ['qa', 'production']) {
      const cell = fl.environments[env];
      if (READABLE_FLAG.has(cell.state)) c.flags[`${fl.key}:${env}`] = { state: cell.state, rollout: cell.rollout_percentage ?? null };
    }
  }
  // Experiments in production: running or not, and each group's share.
  for (const x of lm?.experiments || []) {
    const cell = x.environments.production;
    if (!x.unknown && !['unavailable', 'no_access'].includes(cell.state)) {
      c.experiments[x.id] = { state: cell.state, shares: Object.fromEntries((cell.groups || []).map((g) => [g.name, g.share_of_users ?? g.share])) };
    }
  }
  // App stores: per app and platform, the store state of the feature's version (in the same words as the chat).
  for (const a of lm?.apps || []) {
    for (const cell of Object.values(a.platforms || {})) {
      if (!['unavailable', 'no_access', 'not_connected'].includes(cell.state)) c.stores[`${a.id}:${cell.platform}`] = { state: cell.state, label: cell.label, rollout_state: cell.rollout_state ?? null, rollout: cell.rollout_percentage ?? null };
    }
  }
  for (const s of lm?.services || []) {
    for (const env of ['qa', 'production']) {
      const cell = s.environments[env];
      if (cell.state === 'ok') c.deploys[`${s.id}:${env}`] = cell.deployed ? cell.version || cell.ref || cell.sha : null;
    }
  }
  c.at_risk = Boolean(dateRisk(status, { now }));
  return c;
}

function merge(prev = {}, next) {
  return {
    ...prev,
    ...next,
    steps: { ...(prev.steps || {}), ...next.steps },
    evidence: { ...(prev.evidence || {}), ...next.evidence },
    flags: { ...(prev.flags || {}), ...next.flags },
    deploys: { ...(prev.deploys || {}), ...next.deploys },
    experiments: { ...(prev.experiments || {}), ...next.experiments },
    stores: { ...(prev.stores || {}), ...(next.stores || {}) },
  };
}

const flagText = (v) => (v.state === 'partial' ? `on for ${v.rollout ?? '?'}%` : v.state);

// Items for one feature: what moved, blocked, at risk, flags, deploys, registered changes, alerts.
// prev undefined = first time this feature is in the person's digest.
function featureItems({ status, prev, snap, config, now, seenChanges, seenAlerts }) {
  const items = [];
  const push = (kind, label, text, evidence) => items.push({ kind, label, text, evidence: evidence.filter((e) => e && e.link) });
  const built = buildFacts({ status, snap, config, now });
  const cur = compact(status, now);
  const first = !prev;

  // First digest: where it stands now.
  if (first) push('now', 'Now', built.overall.text.replace(/^Overall: /, ''), built.overall.evidence);
  if (first && status.last_mile && status.last_mile.state !== 'not_tracked') {
    const lmFact = built.facts.find((f) => f.section === 'last_mile' && f.last_mile);
    push('now', 'Now', lmFact.text, lmFact.evidence);
  }

  // What moved.
  if (!first && cur.state && prev.state && cur.state !== prev.state) {
    push('moved', 'Moved', `State: ${STATE_LABEL[prev.state]} → ${STATE_LABEL[cur.state]}.`, built.overall.evidence);
  }
  for (const s of status.steps) {
    const merged = [];
    for (const e of s.evidence) {
      const before = prev?.evidence?.[evKey(e)];
      const now_ = cur.evidence[evKey(e)];
      if (!first && before && now_ && before !== 'done' && now_ === 'done') {
        merged.push(e);
        push('moved', 'Moved', `${e.source === 'jira' ? `Jira ${e.key}` : `${e.type === 'pr' ? 'PR' : 'Issue'} #${e.number}`}${e.title ? ` "${e.title}"` : ''} ${e.source === 'jira' ? `is ${e.detail || 'done'}` : e.type === 'pr' ? 'merged' : 'closed as completed'} (step "${s.name}").`,
          [{ label: evidenceLabel(e), link: e.link }]);
      }
    }
    const before = prev?.steps?.[s.id];
    if (!first && before && cur.steps[s.id] && before !== cur.steps[s.id] && !merged.length) {
      push('moved', 'Moved', `Step "${s.name}": ${before.replace('_', ' ')} → ${cur.steps[s.id].replace('_', ' ')}.`,
        s.evidence.map((e) => ({ label: evidenceLabel(e), link: e.link })));
    }
  }
  if (!first && prev.last_mile && cur.last_mile && prev.last_mile !== cur.last_mile && status.last_mile) {
    push('moved', 'Moved', `Available to users: now "${status.last_mile.label}".`, (status.last_mile.evidence || []).map((e) => ({ label: e.label, link: e.link })));
  }

  // What's blocked (new and still), and what got unblocked.
  const prevBlockers = new Set(prev?.blockers || []);
  for (const [i, b] of status.blockers.entries()) {
    const fact = built.blockers.filter((x) => !x.blocker.startsWith('last_mile'))[i];
    const isNew = !first && cur.blockers && !prevBlockers.has(blockerKey(b));
    push(isNew ? 'blocked_new' : 'blocked', isNew ? 'New blocker' : 'Blocked', fact.text, fact.evidence);
  }
  // Done but kept from users (not deployed, flag off, switched off): who to push.
  for (const fact of built.blockers.filter((x) => x.blocker.startsWith('last_mile'))) push('blocked', 'Not reaching users', fact.text, fact.evidence);
  if (!first && prev.blockers && cur.blockers) {
    for (const key of prev.blockers.filter((k) => !cur.blockers.includes(k))) {
      const [, feature] = key.split(':');
      const dep = snap.features.find((f) => f.feature.id === feature);
      push('unblocked', 'Unblocked', `No longer blocked by ${dep?.feature.name || feature}.`,
        dep ? dep.steps.flatMap((s) => s.evidence.map((e) => ({ label: evidenceLabel(e), link: e.link }))) : []);
    }
  }

  // At risk of missing its date.
  const risk = built.facts.find((f) => f.section === 'schedule' && f.at_risk);
  if (risk) push(!first && !prev.at_risk ? 'at_risk_new' : 'at_risk', 'At risk', risk.text, risk.evidence);

  // Flags and deploys.
  if (!first) {
    for (const [key, v] of Object.entries(cur.flags)) {
      const before = prev.flags?.[key];
      if (!before || (before.state === v.state && before.rollout === v.rollout)) continue;
      const [flag, env] = key.split(':');
      const cell = status.last_mile.flags.find((x) => x.key === flag).environments[env];
      push('flag', 'Flag', `${flag} in ${ENV[env]}: ${flagText(before)} → ${flagText(v)}${cell.changed_at ? ` (${when(cell.changed_at)}${cell.changed_by ? `, by ${cell.changed_by}` : ''})` : ''}.`,
        [{ label: `${flag} in ${ENV[env]} (${flagLinkLabel(status.last_mile.flag_platform)})`, link: cell.link }]);
    }
    // Experiments: started, ended, or a group's share changed since the last digest.
    for (const [id, v] of Object.entries(cur.experiments)) {
      const before = prev.experiments?.[id];
      if (!before) continue;
      const x = status.last_mile.experiments.find((e) => e.id === id);
      const cell = x.environments.production;
      const fact = built.facts.find((f) => f.experiment === id && f.env === 'production');
      const ev = fact?.evidence?.length ? fact.evidence : [{ label: `experiment ${x.name || id} (Statsig)`, link: cell.link }];
      const shares = Object.entries(v.shares).filter(([g, n]) => before.shares?.[g] !== undefined && before.shares[g] !== n);
      if (before.state !== v.state) {
        push('experiment', 'Experiment', `${x.name || id} in production: ${before.state.replace(/_/g, ' ')} → ${v.state.replace(/_/g, ' ')}. ${fact ? fact.text : ''}`.trim(), ev);
      } else if (v.state === 'running' && shares.length) {
        push('experiment', 'Experiment', `${x.name || id}: ${shares.map(([g, n]) => `${g} ${before.shares[g]}% → ${n}%`).join(', ')}. ${fact ? fact.text : ''}`.trim(), ev);
      }
    }
    // App stores: review state or rollout changed since the last digest, citing the store.
    for (const [key, v] of Object.entries(cur.stores || {})) {
      const before = prev.stores?.[key];
      if (!before || (before.state === v.state && before.rollout_state === v.rollout_state && before.rollout === v.rollout)) continue;
      const [app, platform] = key.split(':');
      const a = status.last_mile.apps.find((x) => x.id === app);
      const cell = a.platforms[platform];
      const fact = built.facts.find((f) => f.app === app && f.platform === platform);
      push('store', 'App store', `${a.name} on ${cell.platform_label} (${storeSource(cell)}): ${before.label} → ${v.label}.`,
        fact?.evidence?.length ? fact.evidence : [{ label: `${a.name} ${cell.platform_label} (${storeSource(cell)})`, link: cell.link }]);
    }
    for (const [key, v] of Object.entries(cur.deploys)) {
      const before = prev.deploys?.[key];
      if (before === undefined || before === v) continue;
      const [svc, env] = key.split(':');
      const cell = status.last_mile.services.find((x) => x.id === svc).environments[env];
      push('deploy', 'Deploy', `${svc} in ${ENV[env]}: ${before || 'nothing'} → ${v || 'nothing'}${cell.deployed_at ? ` (${when(cell.deployed_at)})` : ''}.`,
        [{ label: `deploy record: ${svc} in ${ENV[env]}`, link: cell.link }]);
    }
  }

  // Registered changes and alerts not seen in an earlier digest (first digest: the last 7 days).
  const recent = (iso) => Date.parse(iso) >= now - FIRST_DIGEST_DAYS * 86400000;
  for (const c of (snap.changes || []).filter((x) => (x.features || [x.feature]).includes(status.feature.id))) {
    if (first ? !recent(c.registered_at) : seenChanges.has(c.id)) continue;
    push('change', 'Registered change', `${c.kind} change by ${c.registered_by} (${when(c.registered_at)}): ${c.state === 'cancelled' ? 'Cancelled: ' : ''}${c.summary}${c.state === 'planned' ? ` (planned for ${c.planned_for})` : ''}`,
      [{ label: `registered change ${c.id}`, link: c.evidence_link }, c.link ? { label: 'linked from the change', link: c.link } : null]);
  }
  for (const a of (snap.alerts || []).filter((x) => (x.features || [x.feature]).includes(status.feature.id))) {
    if (first ? !recent(a.at) : seenAlerts.has(a.id)) continue;
    push('alert', 'Alert', `${a.severity} · ${a.kind} (${when(a.at)}): ${a.message}`,
      [{ label: `alert ${a.id}`, link: `/api/alerts/${encodeURIComponent(a.id)}` }, a.link ? { label: 'alert source', link: a.link } : null]);
  }
  return { items, compact: cur };
}

const CHANGE_KINDS = new Set(['moved', 'blocked_new', 'unblocked', 'at_risk_new', 'flag', 'experiment', 'store', 'deploy', 'change', 'alert']);

// person: { owners, follows }. Returns the digest and the state to save as "last digest".
export function buildDigest({ snap, config, person, state, now = Date.now() }) {
  const since = state?.at || null;
  const seenChanges = new Set(state?.changes_seen || []);
  const seenAlerts = new Set(state?.alerts_seen || []);
  const features = [];
  const nextFeatures = { ...(state?.features || {}) };
  const fresh = [];
  // Features new to this person's digest (just followed, or just made owner) start like a first digest.
  const included = new Set(state?.included || []);
  for (const status of snap.features) {
    const relation = relationOf(status, person.owners, person.follows);
    const isNew = Boolean(state) && relation && !included.has(status.feature.id);
    const prev = isNew ? undefined : state?.features?.[status.feature.id];
    const { items, compact: cur } = featureItems({ status, prev, snap, config, now, seenChanges: isNew ? new Set() : seenChanges, seenAlerts: isNew ? new Set() : seenAlerts });
    nextFeatures[status.feature.id] = merge(state?.features?.[status.feature.id], cur);
    if (!relation) continue;
    if (isNew) items.unshift({ kind: 'new_in_digest', label: 'New in your digest', text: relation === 'owner' ? 'You own this feature.' : 'You started following this feature.', evidence: [] });
    features.push({ id: status.feature.id, name: status.feature.name, relation, state: status.state,
      last_mile: status.last_mile?.label || null, items, changed: !state || isNew || items.some((i) => CHANGE_KINDS.has(i.kind)) });
    for (const f of freshness(status, snap)) if (!f.info && !fresh.some((x) => x.text === f.text)) fresh.push(f);
  }

  // Per initiative (project) holding any of the person's features: its combined state and the
  // features that changed state since the last digest, each line with its evidence.
  const { projects, nextProjects } = projectItems({ snap, config, state, now, ids: new Set(features.map((f) => f.id)) });

  const changed = features.filter((f) => f.changed);
  let headline;
  let outcome;
  if (!features.length) {
    outcome = 'nothing_followed';
    headline = 'You don\'t own or follow any features yet. Follow a feature from its page, or set the owner names you answer to with `npm run setup`.';
  } else if (!state) {
    outcome = 'first';
    headline = `Your first digest: where your ${features.length} feature${features.length === 1 ? '' : 's'} stand${features.length === 1 ? 's' : ''} now, plus changes and alerts from the last ${FIRST_DIGEST_DAYS} days.`;
  } else if (!changed.length) {
    outcome = 'no_changes';
    headline = `No changes since your last digest (${when(since)}).`;
  } else {
    outcome = 'changes';
    const blocked = features.filter((f) => f.state === 'blocked').length;
    const risk = features.filter((f) => f.items.some((i) => i.kind.startsWith('at_risk'))).length;
    headline = `${changed.length} of your ${features.length} features changed since ${when(since)}.${blocked ? ` ${blocked} blocked.` : ''}${risk ? ` ${risk} at risk of missing the date.` : ''}`;
  }

  const digest = {
    schema: DIGEST_SCHEMA,
    produced_at: new Date(now).toISOString(),
    since,
    outcome,
    headline,
    // "No changes" keeps it short: nothing per feature.
    features: outcome === 'no_changes' ? [] : features.filter((f) => f.items.length || outcome === 'first'),
    following: features.map((f) => ({ id: f.id, name: f.name, relation: f.relation })),
    projects,
    projects_headline: !projects.length ? null : !state ? `Where your ${projects.length} initiative${projects.length === 1 ? '' : 's'} stand${projects.length === 1 ? 's' : ''} now.`
      : `${projects.length} initiative${projects.length === 1 ? '' : 's'} changed since ${when(since)}.`,
    freshness: fresh,
  };
  const nextState = {
    at: digest.produced_at,
    included: features.map((f) => f.id),
    features: nextFeatures,
    projects: nextProjects,
    changes_seen: [...new Set([...seenChanges, ...(snap.changes || []).map((c) => c.id)])],
    alerts_seen: [...new Set([...seenAlerts, ...(snap.alerts || []).map((a) => a.id)])],
  };
  return { digest, nextState };
}

const featureEvidence = (s) => [{ label: `feature: ${s.feature.name}`, link: `/#/feature/${encodeURIComponent(s.feature.id)}` },
  ...s.steps.flatMap((x) => x.evidence.filter((e) => e.link).map((e) => ({ label: evidenceLabel(e), link: e.link })))];

// The initiatives section of the digest. A state that can't be read (status unavailable) is never
// reported as a change: the last known one is kept, as for features.
function projectItems({ snap, config, state, now, ids }) {
  const prevAll = state?.projects || {};
  const nextProjects = { ...prevAll };
  const out = [];
  for (const p of snap.projects || []) {
    const key = p.project.id ?? 'none';
    const members = snap.features.filter((s) => p.features.includes(s.feature.id));
    const shown = projectShownState(p, snap);
    const cur = { state: shown === 'unavailable' ? undefined : shown, features: {} };
    for (const s of members) if (s.state !== 'unavailable') cur.features[s.feature.id] = s.state;
    const prev = state ? prevAll[key] : undefined;
    nextProjects[key] = { state: cur.state ?? prev?.state, features: { ...(prev?.features || {}), ...cur.features } };
    if (!members.some((s) => ids.has(s.feature.id))) continue;
    const items = [];
    const push = (kind, label, text, evidence) => items.push({ kind, label, text, evidence: evidence.filter((e) => e && e.link) });
    const base = [projectStatusLink(p.project.id), projectView(p.project.id)];
    if (!prev) {
      const built = buildProjectFacts({ p, snap, config, now });
      push('now', 'Now', built.overall.text.replace(/^Overall: /, ''), built.overall.evidence);
    } else {
      if (cur.state && prev.state && cur.state !== prev.state) {
        const blockerEv = cur.state === 'blocked' ? members.flatMap((s) => s.blockers.flatMap((b) => (b.evidence || []).map((e) => ({ label: e.label, link: e.link })))) : [];
        push('project_moved', 'Combined state', `${projectName(p)}: ${STATE_LABEL[prev.state]} → ${STATE_LABEL[cur.state]}.`, [...base, ...blockerEv]);
      }
      for (const s of members) {
        const before = prev.features?.[s.feature.id];
        const now_ = cur.features[s.feature.id];
        if (now_ && before && before !== now_) push('feature_moved', 'Feature', `${s.feature.name}: ${STATE_LABEL[before]} → ${STATE_LABEL[now_]}.`, featureEvidence(s));
        else if (now_ && !before && prev.features) push('feature_added', 'Feature', `${s.feature.name} is now part of ${projectName(p)} (${STATE_LABEL[now_]}).`, featureEvidence(s));
      }
    }
    if (items.length) out.push({ id: p.project.id, name: projectName(p), state: shown, items });
  }
  return { projects: out, nextProjects };
}

export function readDigestState() {
  return readJson(paths.digestState(), null);
}

export function saveDigestState(state) {
  writeJson(paths.digestState(), state, 0o600);
}
