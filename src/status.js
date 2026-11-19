// Turns feature definitions plus live evidence into the shared feature status format
// (docs/status-format.md). Pure logic: the evidence reader is passed in.
import { dependencyIssues, dependents } from './graph.js';
import { evidenceId, evidenceLabel } from './evidence.js';

export const STATUS_SCHEMA = 'lifecycle.feature-status/v1';

const describeEvidence = evidenceLabel;

function stepState(evidence) {
  if (!evidence.length) return { state: 'not_started', linkedWork: false };
  const noAccess = evidence.filter((e) => e.state === 'no_access');
  if (noAccess.length) return { state: 'no_access', linkedWork: true, message: noAccess.map((e) => e.message).join(' ') };
  const unavailable = evidence.filter((e) => e.state === 'unavailable');
  if (unavailable.length) {
    const times = unavailable.map((e) => e.lastSuccessfulReadAt);
    return {
      state: 'unavailable',
      linkedWork: true,
      message: unavailable.map((e) => e.message).join(' '),
      // The oldest one is what the whole step can be vouched for; null if any was never read.
      lastSuccessfulReadAt: times.includes(null) ? null : times.sort()[0],
      // Unavailable since the first of its reads started failing.
      unavailableSince: unavailable.map((e) => e.unavailableSince).filter(Boolean).sort()[0] || null,
    };
  }
  if (evidence.every((e) => e.state === 'done')) return { state: 'done', linkedWork: true };
  if (evidence.some((e) => e.state === 'in_progress' || e.state === 'done')) return { state: 'in_progress', linkedWork: true };
  return { state: 'not_started', linkedWork: true };
}

const UNKNOWN = new Set(['unavailable', 'no_access']);

function whyStepPending(feature, step) {
  if (!step.linked_work) return `"${step.name}" has no tasks linked yet (no PR, issue or Jira ticket in the definition)`;
  const open = step.evidence.filter((e) => e.state !== 'done').map((e) => `${describeEvidence(e)} is ${e.detail || e.state}`);
  return `"${step.name}" isn't done: ${open.join('; ')}`;
}

// features: validated definitions. read(evidence, ctx) -> evidence result (never throws).
export async function computeStatuses({ features, projects = [], invalidIds = new Set(), read, definitions = null }) {
  const issues = dependencyIssues(features, invalidIds);
  const reverse = dependents(features);
  const byId = new Map(features.map((f) => [f.id, f]));
  const projectsById = new Map(projects.map((p) => [p.id, p]));
  const readAt = new Date().toISOString();

  // One read per distinct evidence item per refresh, shared by every step that cites it.
  const reads = new Map();
  const readOnce = (e, ctx) => {
    const key = evidenceId(e);
    if (!reads.has(key)) reads.set(key, read(e, ctx));
    return reads.get(key);
  };

  const own = new Map();
  const conditions = new Map();
  await Promise.all(features.map(async (f) => {
    const readStep = async (s) => {
      const evidence = await Promise.all(s.evidence.map((e) => readOnce(e, { feature: f.id, step: s.id })));
      const st = stepState(evidence);
      return {
        id: s.id,
        name: s.name,
        owner: s.owner,
        team: s.team || null,
        done_when: s.doneWhen,
        state: st.state,
        linked_work: st.linkedWork,
        message: st.message || null,
        // Read now, unless some of its evidence came from an older team snapshot: then the oldest read time.
        last_successful_read_at: st.state === 'unavailable' ? st.lastSuccessfulReadAt : (st.state === 'no_access' || !st.linkedWork ? null
          : evidence.map((e) => e.readAt).filter(Boolean).sort()[0] || readAt),
        from_snapshot: evidence.some((e) => e.from_snapshot),
        unavailable_since: st.state === 'unavailable' ? st.unavailableSince : null,
        evidence: evidence.map((e) => ({
          source: e.source,
          type: e.type,
          repo: e.repo ?? null,
          number: e.number ?? null,
          key: e.key ?? null,
          link: e.link,
          title: e.title || null,
          state: e.state,
          detail: e.detail || null,
          message: e.message || null,
          last_successful_read_at: e.readAt || e.lastSuccessfulReadAt || null,
          unavailable_since: e.state === 'unavailable' ? e.unavailableSince || null : null,
          opened_at: e.opened_at || null,
          closed_at: e.closed_at || null,
          // Not read on this machine: the team snapshot in the shared repo (Jira tickets).
          from_snapshot: Boolean(e.from_snapshot),
        })),
      };
    };
    own.set(f.id, await Promise.all(f.steps.map(readStep)));
    // The feature's own ramp conditions, read the same way (used by the ramp verdict, src/ramp/).
    conditions.set(f.id, await Promise.all((f.rampConditions || []).map(readStep)));
  }));

  const cycleOf = new Map();
  for (const [id, list] of issues) for (const i of list) if (i.kind === 'cycle') cycleOf.set(id, new Set(i.ids));

  const memo = new Map();
  function resolve(id) {
    if (memo.has(id)) return memo.get(id);
    const f = byId.get(id);
    const steps = own.get(id);
    const blockers = [];
    const unknownDeps = [];

    for (const i of issues.get(id)) {
      if (i.kind === 'cycle') {
        blockers.push({ kind: 'circular_dependency', feature: null, feature_name: null, step: null, step_name: null, owner: f.owner,
          why: `${i.message}; none of them can finish first. Fix the depends_on lists.`, evidence: [] });
      } else {
        blockers.push({ kind: `${i.kind}_dependency`, feature: i.ids[0], feature_name: null,
          step: null, step_name: null, owner: f.owner, why: i.message, evidence: [] });
      }
    }

    const sameCycle = cycleOf.get(id) || new Set();
    for (const depId of f.dependsOn) {
      if (!byId.has(depId) || sameCycle.has(depId)) continue;
      const dep = resolve(depId);
      if (dep.state === 'done') continue;
      if (dep.state === 'unavailable') {
        unknownDeps.push(depId);
        continue;
      }
      const depDef = byId.get(depId);
      const before = blockers.length;
      const pending = dep.steps.find((s) => s.state !== 'done');
      if (pending && !UNKNOWN.has(pending.state)) {
        blockers.push({
          kind: 'dependency',
          feature: depId,
          feature_name: depDef.name,
          step: pending.id,
          step_name: pending.name,
          owner: pending.owner,
          why: `${f.name} depends on ${depDef.name}; ${whyStepPending(depDef, pending)}`,
          evidence: pending.evidence.map((e) => ({ link: e.link, label: describeEvidence(e), state: e.state })),
        });
      } else if (!dep.steps.length) {
        blockers.push({ kind: 'dependency', feature: depId, feature_name: depDef.name, step: null, step_name: null, owner: depDef.owner,
          why: `${f.name} depends on ${depDef.name}, which has no steps defined yet`, evidence: [] });
      }
      // Pass through what blocks the dependency, so the person to push is the one at the root.
      for (const b of dep.blockers) if (b.kind === 'dependency') blockers.push({ ...b, via: [depId, ...(b.via || [])] });
      if (blockers.length === before) {
        blockers.push({ kind: 'dependency', feature: depId, feature_name: depDef.name, step: null, step_name: null, owner: depDef.owner,
          why: `${f.name} depends on ${depDef.name}, which is blocked: ${dep.blockers.map((b) => b.why).join(' · ')}`, evidence: [] });
      }
    }

    const seen = new Set();
    const unique = blockers.filter((b) => {
      const key = `${b.kind}:${b.feature}:${b.step}:${b.why}`;
      return seen.has(key) ? false : seen.add(key);
    });

    const ownUnknown = steps.some((s) => UNKNOWN.has(s.state));
    const ownDone = steps.length > 0 && steps.every((s) => s.state === 'done');
    let state;
    if (unique.length) state = 'blocked';
    else if (ownUnknown || unknownDeps.length) state = 'unavailable';
    else if (ownDone) state = 'done';
    else if (!steps.some((s) => s.linked_work)) state = 'not_started';
    else state = 'flowing';

    const result = { state, steps, blockers: unique, unknownDeps };
    memo.set(id, result);
    return result;
  }

  const statuses = features.map((f) => {
    const r = resolve(f.id);
    const current = r.steps.find((s) => s.state !== 'done') || null;
    const stepTimes = r.steps.map((s) => s.last_successful_read_at).filter(Boolean).sort();
    // When work started (earliest linked PR/issue opened) and, once done, when it finished (latest
    // one merged/closed). For the roadmap's time bars; null when no linked work was read.
    const opened = r.steps.flatMap((s) => s.evidence.map((e) => e.opened_at)).filter(Boolean).sort();
    const closed = r.steps.flatMap((s) => s.evidence.map((e) => e.closed_at)).filter(Boolean).sort();
    return {
      schema: STATUS_SCHEMA,
      feature: { id: f.id, name: f.name, owner: f.owner, description: f.description ?? null, target_date: f.targetDate, file: f.file, services: f.services, flags: f.flags, experiments: (f.experiments || []).map((e) => e.id) },
      project: f.project ? { id: f.project, name: projectsById.get(f.project)?.name || null } : null,
      state: r.state,
      summary: summarize(f, r, current),
      current_step: current ? current.id : null,
      steps: r.steps,
      ramp_conditions: conditions.get(f.id),
      blockers: r.blockers,
      depends_on: f.dependsOn.map((d) => ({ id: d, name: byId.get(d)?.name || null, state: byId.has(d) ? resolve(d).state : 'unknown' })),
      depended_on_by: reverse.get(f.id).map((d) => ({ id: d, name: byId.get(d).name, state: resolve(d).state })),
      warnings: [
        ...issues.get(f.id).map((i) => ({ kind: i.kind === 'cycle' ? 'circular_dependency' : `${i.kind}_dependency`, ids: i.ids, message: i.message })),
        ...(f.project && !projectsById.has(f.project)
          ? [{ kind: 'unknown_project', ids: [f.project], message: `unknown project "${f.project}": no file projects/${f.project}.yaml is defined` }]
          : []),
      ],
      access_problems: r.steps.filter((s) => s.state === 'no_access').map((s) => ({ step: s.id, message: s.message })),
      read_at: readAt,
      last_successful_read_at: stepTimes[0] || null,
      timeline: { start: opened[0] || null, finished: r.state === 'done' ? closed[closed.length - 1] || null : null },
      definitions,
    };
  });
  return statuses;
}

function summarize(f, r, current) {
  switch (r.state) {
    case 'done': return 'All steps and dependencies are done.';
    case 'blocked': return r.blockers.map((b) => b.why).join(' · ');
    case 'unavailable': {
      const own = r.steps.filter((s) => UNKNOWN.has(s.state)).map((s) => `"${s.name}"`);
      const parts = [];
      if (own.length) parts.push(`status unavailable for ${own.join(', ')}`);
      if (r.unknownDeps.length) parts.push(`status of dependency ${r.unknownDeps.join(', ')} unavailable`);
      const text = `${parts.join('; ')}: can't confirm done or blocked.`;
      return text[0].toUpperCase() + text.slice(1);
    }
    case 'not_started':
      return r.steps.length ? 'No tasks linked yet: none of the steps has a PR or issue.' : 'No steps defined yet.';
    default:
      return current ? `In progress: "${current.name}" (${current.owner}).` : 'In progress.';
  }
}
