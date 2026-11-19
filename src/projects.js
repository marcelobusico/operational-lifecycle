// Groups feature statuses by project and rolls their states up into one project state.
// Features with no project, or an undefined one, go to the "No project" group (id null).

export const PROJECT_SCHEMA = 'lifecycle.project-status/v1';
const STATES = ['blocked', 'unavailable', 'flowing', 'not_started', 'done'];

function rollupState(states) {
  if (!states.length) return 'not_started';
  if (states.includes('blocked')) return 'blocked';
  if (states.includes('unavailable')) return 'unavailable';
  if (states.every((s) => s === 'done')) return 'done';
  if (states.every((s) => s === 'not_started')) return 'not_started';
  return 'flowing';
}

export function projectStatuses(projects, statuses) {
  const known = new Set(projects.map((p) => p.id));
  const groupOf = (s) => (s.project && known.has(s.project.id) ? s.project.id : null);
  const projectOf = new Map(statuses.map((s) => [s.feature.id, groupOf(s)]));
  const groups = [...projects.map((p) => ({ ...p })), { id: null, name: 'No project', owner: null, description: null, target_date: null, file: null }];

  return groups.map((p) => {
    const members = statuses.filter((s) => groupOf(s) === p.id);
    const ids = new Set(members.map((s) => s.feature.id));
    const counts = Object.fromEntries(STATES.map((st) => [st, members.filter((s) => s.state === st).length]));
    // Who to push across the project: the blockers of its blocked features, once each.
    const seen = new Set();
    const blockers = [];
    for (const s of members) {
      for (const b of s.blockers) {
        const key = `${b.kind}:${b.feature}:${b.step}:${b.owner}`;
        if (seen.has(key)) continue;
        seen.add(key);
        blockers.push({ ...b, blocked_feature: s.feature.id });
      }
    }
    // Dependencies that cross the project boundary, in both directions.
    const outside = (list) => [...new Set(list.filter((d) => !ids.has(d.id)).map((d) => d.id))]
      .map((id) => ({ id, project: projectOf.has(id) ? projectOf.get(id) : undefined }));
    return {
      schema: PROJECT_SCHEMA,
      project: { id: p.id, name: p.name, owner: p.owner, description: p.description, target_date: p.target_date ?? null, file: p.file },
      state: rollupState(members.map((s) => s.state)),
      counts,
      features: members.map((s) => s.feature.id),
      blockers,
      depends_on_outside: outside(members.flatMap((s) => s.depends_on)),
      depended_on_from_outside: outside(members.flatMap((s) => s.depended_on_by)),
    };
  }).filter((p) => p.project.id !== null || p.features.length);
}
