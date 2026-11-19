// Experiments a feature takes part in, read from Statsig over the shared connection
// (src/sources/statsig.js, `experiment_read`). Experiments are always read from Statsig, whichever
// platform the flags come from. Pure state logic plus one reader; failures stay SourceErrors.
//
// What Statsig records (live capture: test/fixtures/statsig-experiment-live.json): one status for
// the whole project (setup | active | decision_made | abandoned | …), groups with a size (their share
// of the users in the experiment) and one group marked isControl, `allocation` (% of eligible users
// that enter the experiment), `idType` (what users are bucketed by), an optional targeting gate
// (who is eligible), start/end times, the launched group once a decision is made, and a permalink.
//
// Statsig refuses to change group sizes once an experiment has started ("Groups cannot change after
// experiment is started", checked live 2026-11-05); while it runs, what changes users' shares is the
// allocation. So each group carries both its share of the experiment (`share`, Statsig's size) and
// its share of all eligible users (`share_of_users` = allocation × size).
//
// Per LifeCycle environment (QA / production, mapped to Statsig environments like flags):
//   status active, no targeting gate                    → running
//   status active, targeting gate off in that env      → not_running (nobody is eligible there)
//   status active, targeting gate on/partial there     → running, assignment names the gate's segments
//   status setup                                       → not_started
//   decision_made / abandoned / archived …             → ended (launched group named if any)
// What the feature does in each group comes from the feature definition; a group not
// described there shows Statsig's group description, marked as coming from Statsig.
import { SourceError } from '../sources/github-client.js';
import { STATSIG_NAME } from '../sources/statsig.js';
import { changedBy, gateState } from './statsig.js';

const norm = (s) => String(s || '').toLowerCase().replace(/[\s_-]+/g, ' ').trim();
const iso = (t) => {
  if (t === null || t === undefined || t === '') return null;
  const d = new Date(typeof t === 'string' && /^\d+$/.test(t) ? Number(t) : t);
  return isNaN(d) ? null : d.toISOString();
};
const looksLikeExperiment = (e) => Boolean(e) && typeof e === 'object' && typeof e.status === 'string' && Array.isArray(e.groups);
const ENDED = new Set(['decision_made', 'abandoned', 'archived', 'stopped', 'completed']);

// The groups of an experiment with what the feature does in each, from the definition first.
export function experimentGroups(exp, described = {}) {
  const allocation = Number.isFinite(Number(exp.allocation)) ? Number(exp.allocation) : null;
  const byName = new Map(Object.entries(described).map(([k, v]) => [norm(k), v]));
  const controlId = exp.controlGroupID || null;
  return (exp.groups || []).filter((g) => !g.disabled).map((g) => {
    const mine = byName.get(norm(g.name));
    const theirs = typeof g.description === 'string' && g.description.trim() ? g.description.trim() : null;
    return {
      name: g.name,
      id: g.id || null,
      control: g.isControl === true || (controlId !== null && g.id === controlId),
      // Share of the users in the experiment (Statsig's group size).
      share: Number.isFinite(Number(g.size)) ? Number(g.size) : null,
      // Share of all eligible users (allocation × share).
      share_of_users: Number.isFinite(Number(g.size)) && allocation !== null ? Math.round(allocation * Number(g.size)) / 100 : null,
      gets: mine || theirs || null,
      gets_from: mine ? 'definition' : theirs ? 'statsig' : null,
    };
  });
}

// Groups named in the definition that Statsig doesn't have: worth a warning (likely a typo).
export function undescribedNames(exp, described = {}) {
  const names = new Set((exp.groups || []).map((g) => norm(g.name)));
  return Object.keys(described).filter((k) => !names.has(norm(k)));
}

// The state of one experiment in one environment. gate: its targeting gate (or null), already read.
export function experimentState(exp, environment, { gate = null } = {}) {
  const status = String(exp.status || '').toLowerCase();
  const base = {
    statsig_status: exp.status,
    started_at: iso(exp.startTime),
    ended_at: iso(exp.endTime) || (ENDED.has(status) ? iso(exp.decisionTime) : null),
    launched_group: exp.launchedGroupID ? (exp.groups || []).find((g) => g.id === exp.launchedGroupID)?.name || exp.launchedGroupID : null,
  };
  if (ENDED.has(status)) return { state: 'ended', ...base };
  if (status !== 'active') return { state: 'not_started', ...base };
  if (exp.targetingGateID && gate) {
    const g = gateState(gate, environment);
    if (g.state === 'off') return { state: 'not_running', ...base, reason: `its targeting gate ${exp.targetingGateID} lets nobody in here` };
    return { state: 'running', ...base, targeting: g };
  }
  return { state: 'running', ...base };
}

export function createExperimentSource({ connection, consoleUrl }) {
  // Each experiment (and targeting gate) is read once per refresh, whichever features list it.
  const reads = new Map();
  const once = (key, fn) => {
    if (!reads.has(key)) reads.set(key, fn());
    return reads.get(key);
  };

  // { exp, gate } or { unknown: true }.
  async function readExperiment(id) {
    // The shared connection explains a missing or wrong key, with the fix (src/sources/statsig.js).
    const exp = await once(`exp:${id}`, () => connection.getExperiment(id));
    if (exp === null) return { unknown: true };
    if (!looksLikeExperiment(exp)) {
      throw new SourceError('unreachable', `${STATSIG_NAME}'s answer for experiment "${id}" could not be read (no status or groups in it), so it isn't shown as running or not.`);
    }
    const gate = exp.targetingGateID ? await once(`gate:${exp.targetingGateID}`, () => connection.getGate(exp.targetingGateID)) : null;
    return { exp, gate };
  }

  // Everything shown about one experiment in one environment, besides the read times.
  function cell({ exp, gate }, environment, described) {
    const s = experimentState(exp, environment, { gate });
    return {
      ...s,
      name: exp.name || exp.id,
      groups: experimentGroups(exp, described),
      assignment: {
        id_type: exp.idType || null,
        // % of eligible users that enter the experiment; the rest get the default.
        allocation: Number.isFinite(Number(exp.allocation)) ? Number(exp.allocation) : null,
        targeting_gate: exp.targetingGateID || null,
        segments: s.targeting?.segments?.map((x) => x.name) || [],
      },
      changed_at: iso(exp.lastModifiedTime),
      changed_by: changedBy(exp),
      link: exp.permalink || `${consoleUrl}/experiments/${encodeURIComponent(exp.id)}`,
    };
  }

  return { readExperiment, cell, sourceName: STATSIG_NAME };
}

// How users are put into groups, in words: "by userID; 100% of eligible users enter; eligible: gate x (segments a, b)".
export function assignmentText(a) {
  if (!a) return '';
  const parts = [];
  if (a.id_type) parts.push(`users are assigned by ${a.id_type}`);
  if (a.allocation !== null && a.allocation !== undefined) parts.push(`${a.allocation}% of eligible users enter`);
  if (a.targeting_gate) parts.push(`eligible: targeting gate ${a.targeting_gate}${a.segments?.length ? ` (${a.segments.join(', ')})` : ''}`);
  return parts.join('; ');
}

// "Control (control) 50%: no rewards option · Rewards 25%: can redeem points" (with each group's share of
// all users when not every eligible user is in the experiment).
const ofUsers = (g) => (g.share_of_users !== null && g.share_of_users !== undefined && g.share_of_users !== g.share ? ` (${g.share_of_users}% of users)` : '');
export function groupsText(groups) {
  return groups.map((g) => `${g.name}${g.control ? ' (control)' : ''} ${g.share ?? '?'}%${ofUsers(g)}: ${g.gets ? `${g.gets}${g.gets_from === 'statsig' ? ' (from Statsig)' : ''}` : 'not described in the definition'}`).join(' · ');
}
