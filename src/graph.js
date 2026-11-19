// Dependency graph checks: unknown ids and cycles. Cycles are found with Tarjan's strongly
// connected components, so nothing ever walks the graph recursively without an end.

// Returns Map<featureId, [{ kind: 'unknown' | 'invalid' | 'cycle', ids, message }]>.
export function dependencyIssues(features, invalidIds = new Set()) {
  const byId = new Map(features.map((f) => [f.id, f]));
  const issues = new Map(features.map((f) => [f.id, []]));

  for (const f of features) {
    for (const dep of f.dependsOn) {
      if (!byId.has(dep) && invalidIds.has(dep)) {
        issues.get(f.id).push({ kind: 'invalid', ids: [dep], message: `depends on "${dep}", whose definition is invalid (see the definition errors)` });
      } else if (!byId.has(dep)) {
        issues.get(f.id).push({ kind: 'unknown', ids: [dep], message: `unknown dependency "${dep}": no feature with that id is defined` });
      }
    }
  }

  for (const component of stronglyConnected(features, byId)) {
    if (component.length < 2) continue;
    const ids = [...component].sort();
    for (const id of ids) {
      issues.get(id).push({ kind: 'cycle', ids, message: `circular dependency: ${ids.join(' → ')} → ${ids[0]} depend on each other` });
    }
  }
  return issues;
}

function stronglyConnected(features, byId) {
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const out = [];

  // Iterative Tarjan to stay safe on long chains.
  for (const root of features) {
    if (idx.has(root.id)) continue;
    const work = [{ id: root.id, next: 0 }];
    idx.set(root.id, index); low.set(root.id, index); index++;
    stack.push(root.id); onStack.add(root.id);
    while (work.length) {
      const frame = work[work.length - 1];
      const deps = byId.get(frame.id).dependsOn.filter((d) => byId.has(d));
      if (frame.next < deps.length) {
        const dep = deps[frame.next++];
        if (!idx.has(dep)) {
          idx.set(dep, index); low.set(dep, index); index++;
          stack.push(dep); onStack.add(dep);
          work.push({ id: dep, next: 0 });
        } else if (onStack.has(dep)) {
          low.set(frame.id, Math.min(low.get(frame.id), idx.get(dep)));
        }
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1].id;
        low.set(parent, Math.min(low.get(parent), low.get(frame.id)));
      }
      if (low.get(frame.id) === idx.get(frame.id)) {
        const component = [];
        let id;
        do {
          id = stack.pop();
          onStack.delete(id);
          component.push(id);
        } while (id !== frame.id);
        out.push(component);
      }
    }
  }
  return out;
}

// Features that depend on each feature (the reverse edges), for "what depends on it".
export function dependents(features) {
  const map = new Map(features.map((f) => [f.id, []]));
  for (const f of features) for (const dep of f.dependsOn) if (map.has(dep)) map.get(dep).push(f.id);
  return map;
}
