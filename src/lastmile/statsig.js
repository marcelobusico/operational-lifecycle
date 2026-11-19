// Statsig flag source for the last-mile check (done vs. turned on): the same readProject/readFlag contract as the
// Flagsmith source (src/lastmile/flagsmith.js), so src/lastmile/index.js and the state rules don't
// care which platform answers. A LifeCycle flag key is a Statsig feature gate id (or name).
//
// One gate, one environment (the Statsig environment mapped to QA or production):
//   gate disabled (isEnabled false)                → off
//   rules apply when their `environments` is empty or lists that environment, evaluated in order;
//   the first rule that applies to everyone (no conditions, or only `public`) decides the rest:
//     passPercentage 100                           → on
//     passPercentage 1–99                          → partial, rollout = that %
//   earlier targeted rules passing > 0%           → partial for those segments (rollout unknown)
//   nothing passes                                 → off
// changed_at / changed_by come from the gate's lastModifiedTime / lastModifierName (Statsig records
// them per gate, not per environment). Failures stay SourceErrors (unreachable | no_access).
// An answer that doesn't look like a gate (no boolean isEnabled, no rules list) is "unavailable",
// never guessed as off: Statsig doesn't document these response bodies.
import { SourceError } from '../sources/github-client.js';
import { STATSIG_NAME } from '../sources/statsig.js';

const isPublic = (rule) => !(rule.conditions || []).length || rule.conditions.every((c) => String(c.type || '').toLowerCase() === 'public');
const looksLikeGate = (g) => Boolean(g) && typeof g === 'object' && typeof g.isEnabled === 'boolean' && Array.isArray(g.rules);
const appliesTo = (rule, environment) => !Array.isArray(rule.environments) || !rule.environments.length || rule.environments.includes(environment);
// Statsig names a change made with an API key after the key, with its first characters visible
// ("CONSOLE API - console-HTWw3qe****…"). That fragment is never shown: the change is credited to
// the kind of key instead.
export function changedBy(gate) {
  const name = gate.lastModifierName || gate.lastModifierEmail || null;
  if (!name) return null;
  const m = String(name).match(/^\s*(CONSOLE|SERVER|CLIENT)\s+API\b/i) || (/\b(console|secret|client)-[\w*]+/i.test(name) ? [null, 'an'] : null);
  if (!m) return name;
  return m[1] && m[1] !== 'an' ? `a ${m[1][0]}${m[1].slice(1).toLowerCase()} API key` : 'an API key';
}
const iso = (t) => {
  if (t === null || t === undefined || t === '') return null;
  const d = new Date(typeof t === 'string' && /^\d+$/.test(t) ? Number(t) : t);
  return isNaN(d) ? null : d.toISOString();
};

// The on/off/partial state of one gate in one Statsig environment.
export function gateState(gate, environment) {
  if (!gate.isEnabled) return { state: 'off', rollout_percentage: 0, segments: [] };
  const segments = [];
  for (const rule of (gate.rules || []).filter((r) => appliesTo(r, environment))) {
    const pct = Number(rule.passPercentage ?? 0);
    if (isPublic(rule)) {
      if (pct >= 100) return { state: 'on', rollout_percentage: 100, segments };
      if (pct > 0) return { state: 'partial', rollout_percentage: pct, segments: [...segments, { name: rule.name || 'Everyone', percentage: pct }] };
      break;
    }
    if (pct > 0) segments.push({ name: rule.name || rule.id || 'targeted rule', percentage: pct < 100 ? pct : null });
  }
  return segments.length ? { state: 'partial', rollout_percentage: null, segments } : { state: 'off', rollout_percentage: 0, segments: [] };
}

export function createStatsigSource({ connection, consoleUrl, environmentNames }) {
  // Gate details per refresh: QA and production read the same gate once.
  const details = new Map();

  async function readProject() {
    // The connection explains a missing or wrong key (src/sources/statsig.js), with the fix.
    const gates = await connection.listGates();
    const flags = new Map();
    for (const g of gates) {
      if (g.status === 'Archived' || g.archivedAt) continue;
      const flag = { id: g.id, name: g.name || g.id, gate: looksLikeGate(g) ? g : null };
      flags.set(g.id, flag);
      if (g.name && !flags.has(g.name)) flags.set(g.name, flag);
    }
    // Statsig has no environment list in the gate data: the mapped names are used as given.
    const envs = Object.fromEntries(Object.entries(environmentNames).map(([key, name]) => [key, { id: `statsig:${name}`, name }]));
    return { envs, flags, names: Object.values(environmentNames) };
  }

  async function readFlag({ env, flag }) {
    if (!details.has(flag.id)) details.set(flag.id, flag.gate ? Promise.resolve(flag.gate) : connection.getGate(flag.id));
    const gate = await details.get(flag.id);
    if (!looksLikeGate(gate)) {
      throw new SourceError('unreachable', `${STATSIG_NAME}'s answer for feature gate "${flag.id}" could not be read (no on/off setting or rules in it), so it isn't shown as on or off.`);
    }
    return {
      ...gateState(gate, env.name),
      changed_at: iso(gate.lastModifiedTime),
      changed_by: changedBy(gate),
      // Statsig's gate data doesn't carry the previous setting; index.js falls back to what this
      // machine saw at an earlier refresh.
      was_on_before: null,
      link: gate.permalink || `${consoleUrl}/gates/${encodeURIComponent(gate.id || flag.id)}`,
    };
  }

  return { readProject, readFlag, sourceName: STATSIG_NAME };
}
