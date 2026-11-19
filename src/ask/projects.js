// Initiative (project) answers. LifeCycle calls them projects; "initiative" is a synonym. An
// initiative answer is built the same way as a feature answer (facts.js): numbered statements,
// each saying one thing and carrying its evidence, and a lead sentence that only cites them.
// Everything comes from the project rollup (src/projects.js, the same object as
// GET /api/projects/<id>/status) and its features' live statuses; nothing is guessed.
import { buildFacts, dateRisk, freshness, STATE_LABEL, when } from './facts.js';
import { definitionLink } from '../changes.js';
import { evidenceLabel } from '../evidence.js';

export const NO_PROJECT_NAME = 'Features without an initiative';
const STATES = ['blocked', 'unavailable', 'flowing', 'not_started', 'done'];
const AT_RISK_DAYS = 14;
// Last-mile states that mean "done, but not (fully) in users' hands".
const LAST_MILE_GAP = new Set(['done_not_deployed', 'deployed_flag_off', 'switched_off', 'partly_rolled_out', 'in_experiment',
  'not_in_app_version', 'in_store_review', 'waiting_for_release', 'store_rejected', 'rollout_halted', 'app_partly_released']);

const pid = (id) => id ?? 'none';
export const projectView = (id) => ({ label: `project view: ${id === null ? NO_PROJECT_NAME : id}`, link: `/#/project/${encodeURIComponent(pid(id))}` });
export const projectStatusLink = (id) => ({ label: 'project status', link: `/api/projects/${encodeURIComponent(pid(id))}/status` });
const featureView = (s) => ({ label: `feature: ${s.feature.name}`, link: `/#/feature/${encodeURIComponent(s.feature.id)}` });
const evLabel = evidenceLabel;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const names = (list) => (list.length <= 2 ? list.join(' and ') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`);
const uniqLinks = (list) => list.filter((e, i, all) => e && e.link && all.findIndex((x) => x.link === e.link) === i);

export function projectName(p) {
  return p.project.id === null ? NO_PROJECT_NAME : p.project.name;
}

// "2 blocked, 1 flowing, 1 done": every non-zero count, in the rollup's order.
export function countsText(counts) {
  return STATES.filter((s) => counts[s]).map((s) => `${counts[s]} ${STATE_LABEL[s]}`).join(', ');
}

// The parts of a feature's status that can't be read right now: its own freshness entries,
// leaving out what applies to every feature (the shared repo, the alert list).
function unreadable(status, snap) {
  return freshness(status, snap).filter((f) => !f.info && !['shared repo', 'alerts'].includes(f.source));
}

// The rollup for an initiative, plus whether it must not be shown as done: an unreadable source
// behind a feature means LifeCycle can't confirm it is done or on.
function shownState(p, members, snap) {
  const blind = members.filter((s) => unreadable(s, snap).length);
  if (p.state === 'done' && blind.length) return { state: 'unavailable', blind };
  return { state: p.state, blind };
}

// One-line reason for an initiative's state, used in lists across initiatives.
function reasonText(p, members, state, blind) {
  const n = members.length;
  if (!n) return 'not started, no features yet';
  if (state === 'blocked') {
    const blocked = members.filter((s) => s.state === 'blocked');
    const by = [...new Set(blocked.flatMap((s) => s.blockers.map((b) => b.feature_name || b.kind.replace(/_/g, ' '))))];
    return `${names(blocked.map((s) => s.feature.name))} blocked by ${names(by)}`;
  }
  if (state === 'unavailable') {
    const list = blind.length ? blind : members.filter((s) => s.state === 'unavailable');
    return `status unavailable for ${names(list.map((s) => s.feature.name))}`;
  }
  if (state === 'done') return `all ${plural(n, 'feature')} done`;
  if (state === 'not_started') return `${plural(n, 'feature')}, none started`;
  return `${p.counts.done} of ${plural(n, 'feature')} done (${countsText(p.counts)})`;
}

// p: an entry of snap.projects (or an empty group). Returns { facts, overall, blockers, freshness, state }.
export function buildProjectFacts({ p, snap, config, now = Date.now() }) {
  const facts = [];
  const add = (section, text, evidence = [], extra = {}) => {
    const fact = { id: `f${facts.length + 1}`, section, text, ...extra, evidence: uniqLinks(evidence) };
    facts.push(fact);
    return fact;
  };
  const name = projectName(p);
  const members = snap.features.filter((s) => p.features.includes(s.feature.id));
  const { state, blind } = shownState(p, members, snap);
  const base = [projectStatusLink(p.project.id), projectView(p.project.id)];
  const defEv = p.project.file ? { label: `definition ${p.project.file}`, link: definitionLink(config, p.project.file) } : null;

  // Overall: the combined state and how many features are in each state.
  const overallText = !members.length
    ? p.project.id === null ? 'Overall: every feature belongs to an initiative; there are no features without one.' : `Overall: ${name} is not started, no features yet.`
    : state !== p.state
      ? `Overall: ${name} can't be confirmed done: the status of ${names(blind.map((s) => s.feature.name))} is unavailable. ${plural(members.length, 'feature')}: ${countsText(p.counts)}.`
      : `Overall: ${name} ${p.project.id === null ? 'are' : 'is'} ${STATE_LABEL[state]}. ${plural(members.length, 'feature')}: ${countsText(p.counts)}.`;
  const overall = add('overall', overallText, [...base, defEv], { state, rollup_state: p.state, counts: p.counts, features: members.length });

  // Blockers: each distinct blocker once, with every feature of the initiative it holds up.
  const groups = new Map();
  for (const s of members) {
    for (const b of s.blockers) {
      const key = `${b.kind}:${b.feature}:${b.step}:${b.owner}`;
      if (!groups.has(key)) groups.set(key, { b, blocked: [] });
      if (!groups.get(key).blocked.includes(s)) groups.get(key).blocked.push(s);
    }
  }
  const blockers = [];
  for (const { b, blocked } of groups.values()) {
    const what = b.step_name ? `"${b.step_name}" of ${b.feature_name}` : b.feature_name || b.kind.replace(/_/g, ' ');
    const open = (b.evidence || []).filter((e) => e.link).map((e) => e.label).join(', ');
    const owner = b.owner || blocked[0].feature.owner;
    const message = `Hi ${owner}, ${names(blocked.map((s) => s.feature.name))} ${blocked.length === 1 ? 'is' : 'are'} waiting on ${what}. Is there an ETA, or anything you need from us to move it?`;
    blockers.push(add('blockers', `${names(blocked.map((s) => s.feature.name))} ${blocked.length === 1 ? 'is' : 'are'} blocked by ${what}${open ? ` (${open})` : ''}. Push: ${owner}.`,
      [...(b.evidence || []).map((e) => ({ label: e.label, link: e.link })), ...blocked.map(featureView)],
      { blocker: b.kind, blocked_features: blocked.map((s) => s.feature.id), push: { owner, message } }));
  }

  // What's left: features not done yet and the current step of each.
  const open = members.filter((s) => s.state !== 'done' && s.state !== 'unavailable');
  if (members.length) {
    add('remaining', open.length ? `${open.length} of ${plural(members.length, 'feature')} aren't done yet.` : `None of the ${plural(members.length, 'feature')} is left: all are done or unavailable.`,
      [...base], { remaining: open.length });
  }
  for (const s of open) {
    const cur = s.steps.find((x) => x.id === s.current_step);
    const ev = cur ? cur.evidence.filter((e) => e.link).map((e) => ({ label: evLabel(e), link: e.link })) : [];
    add('remaining', `${s.feature.name}: ${STATE_LABEL[s.state]}${cur ? `; current step "${cur.name}" (${cur.owner}), ${cur.state.replace(/_/g, ' ')}` : s.steps.length ? '' : '; no steps defined yet'}.`,
      [...ev, featureView(s)], { feature: s.feature.id, step: cur?.id || null });
  }

  // Unavailable: a feature whose source can't be read, since when and what access is missing.
  for (const s of members) {
    const bad = unreadable(s, snap);
    if (!bad.length) continue;
    const times = bad.map((x) => x.last_successful_read_at);
    const since = times.includes(null) ? null : times.sort()[0];
    const access = s.access_problems.map((a) => a.message).filter(Boolean);
    add('unavailable', `${s.feature.name}: ${s.state === 'unavailable' ? 'status unavailable' : 'part of its status is unavailable'}, last read fine ${when(since)}. ${bad.map((x) => x.text).join(' ')}${access.length ? ` Missing access: ${access.join(' ')}` : ''} It is not counted as done or on.`,
      [featureView(s), ...s.steps.flatMap((x) => x.evidence.filter((e) => e.link).map((e) => ({ label: evLabel(e), link: e.link })))],
      { feature: s.feature.id, unavailable_since: since, last_successful_read_at: since });
  }

  // Target dates: only when features have them. At risk names the features that put it at risk.
  const dated = members.filter((s) => s.feature.target_date);
  const risky = dated.map((s) => ({ s, risk: dateRisk(s, { now, days: config.atRiskDays ?? AT_RISK_DAYS }) })).filter((x) => x.risk);
  const datesSeen = [...new Set(dated.map((s) => s.feature.target_date))].sort();
  if (risky.length) {
    add('schedule', `At risk of missing its target dates: ${risky.map(({ s, risk }) => `${s.feature.name} (${risk.target}, ${risk.overdue ? `passed ${-risk.days_left} days ago` : `${risk.days_left} days left`})`).join('; ')}.`,
      risky.map(({ s }) => featureView(s)), { at_risk: risky.map(({ s }) => s.feature.id) });
  }
  for (const s of dated) {
    const r = risky.find((x) => x.s === s);
    add('schedule', `${s.feature.name}: target date ${s.feature.target_date}${r ? ', at risk' : ''}.`, [featureView(s)], { feature: s.feature.id, target_date: s.feature.target_date });
  }

  // Last mile: features done but not (fully) in users' hands, with the flag, deploy or store link.
  const tracked = members.filter((s) => s.last_mile && s.last_mile.state !== 'not_tracked');
  const gap = tracked.filter((s) => LAST_MILE_GAP.has(s.last_mile.state));
  const on = tracked.filter((s) => s.last_mile.state === 'fully_on' && !unreadable(s, snap).length);
  if (tracked.length) {
    add('last_mile', `In users' hands: ${on.length} of ${plural(tracked.length, 'tracked feature')} fully on${gap.length ? `; ${gap.length} done but not fully available` : ''}.`,
      [...base, ...on.map(featureView)], { last_mile_summary: true, fully_on: on.length, gap: gap.length });
  }
  for (const s of gap) {
    const built = buildFacts({ status: s, snap, config, now });
    const ev = built.blockers.filter((b) => String(b.blocker).startsWith('last_mile')).flatMap((b) => b.evidence);
    const lmEv = (s.last_mile.evidence || []).map((e) => ({ label: e.label, link: e.link }));
    add('last_mile', `${s.feature.name}: ${s.last_mile.label}. ${s.last_mile.summary}`, [...ev, ...lmEv, featureView(s)],
      { feature: s.feature.id, last_mile: s.last_mile.state });
  }

  // Work outside the initiative it depends on, or that depends on it.
  const byId = new Map(snap.features.map((s) => [s.feature.id, s]));
  const projName = (id) => (id === null ? NO_PROJECT_NAME : (snap.projects || []).find((x) => x.project.id === id)?.project.name || id);
  for (const d of p.depends_on_outside || []) {
    const dep = byId.get(d.id);
    const users = members.filter((s) => s.depends_on.some((x) => x.id === d.id)).map((s) => s.feature.name);
    add('outside', dep
      ? `${names(users)} ${users.length === 1 ? 'depends' : 'depend'} on ${dep.feature.name} in ${projName(d.project)} (${STATE_LABEL[dep.state]}).`
      : `${names(users)} ${users.length === 1 ? 'depends' : 'depend'} on "${d.id}", which isn't a defined feature.`,
    dep ? [featureView(dep), projectView(d.project)] : [defEv, ...members.filter((s) => users.includes(s.feature.name)).map(featureView)], { depends_on: d.id, other_project: d.project ?? null });
  }
  for (const d of p.depended_on_from_outside || []) {
    const other = byId.get(d.id);
    if (!other) continue;
    const used = members.filter((s) => s.depended_on_by.some((x) => x.id === d.id)).map((s) => s.feature.name);
    add('outside', `${other.feature.name} in ${projName(d.project)} depends on ${names(used)}.`, [featureView(other), projectView(d.project)], { depended_on_by: d.id, other_project: d.project ?? null });
  }

  // Freshness: what can't be read, deduplicated across the features (stale definitions included).
  const fresh = [];
  const defs = snap.definitions;
  if (defs?.stale) fresh.push({ source: 'shared repo', text: `Feature and project definitions come from the last sync at ${when(defs.synced_at)}: the shared repo couldn't be read (${defs.error?.message || 'unreachable'}).`, last_successful_read_at: defs.synced_at });
  for (const s of members) for (const f of freshness(s, snap)) if (f.source !== 'shared repo' && !fresh.some((x) => x.text === f.text)) fresh.push(f);
  if (!members.length) for (const f of freshness({ steps: [] }, snap)) if (f.source !== 'shared repo' && !fresh.some((x) => x.text === f.text)) fresh.push(f);

  return { facts, overall, blockers, freshness: fresh, state, members, dates: datesSeen, risky: risky.map(({ s }) => s.feature.id) };
}

// One line per initiative for questions across initiatives ("which initiatives are blocked?").
export function buildProjectListFacts({ projects, snap }) {
  const facts = [];
  for (const p of projects) {
    const members = snap.features.filter((s) => p.features.includes(s.feature.id));
    const { state, blind } = shownState(p, members, snap);
    const blockerEv = state === 'blocked' ? members.flatMap((s) => s.blockers.flatMap((b) => (b.evidence || []).map((e) => ({ label: e.label, link: e.link })))) : [];
    facts.push({ id: `f${facts.length + 1}`, section: 'projects', text: `${projectName(p)}: ${STATE_LABEL[state]}. ${reasonText(p, members, state, blind).replace(/^./, (c) => c.toUpperCase())}.`,
      evidence: uniqLinks([projectStatusLink(p.project.id), projectView(p.project.id), ...blockerEv]), project: p.project.id, state, counts: p.counts });
  }
  return facts;
}

// The state an initiative is shown with (the rollup, unless an unreadable source keeps it from done).
export function projectShownState(p, snap) {
  return shownState(p, snap.features.filter((s) => p.features.includes(s.feature.id)), snap).state;
}
