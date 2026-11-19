// Matching a registered change to features through the features it names. Every feature that
// depends on an affected one (directly or through others) is affected too.
import { dependents } from '../graph.js';

// ids → { affected: [ids], dependents: [ids not already affected] }
export function withDependents(features, ids) {
  const reverse = dependents(features);
  const affected = [...new Set(ids)].filter((id) => reverse.has(id));
  const seen = new Set(affected);
  const queue = [...affected];
  const deps = [];
  while (queue.length) {
    for (const d of reverse.get(queue.shift()) || []) {
      if (seen.has(d)) continue;
      seen.add(d);
      deps.push(d);
      queue.push(d);
    }
  }
  return { affected, dependents: deps };
}

// Who is told about a change to these features: the owners of the affected features and of the
// features that depend on them (feature owner and step owners).
export function ownersToNotify(features, ids) {
  const byId = new Map(features.map((f) => [f.id, f]));
  const { affected, dependents: deps } = withDependents(features, ids);
  const owners = new Map();
  const add = (owner, feature, as, relation) => {
    if (!owner) return;
    if (!owners.has(owner)) owners.set(owner, { owner, features: [] });
    const entry = owners.get(owner);
    if (!entry.features.some((x) => x.id === feature.id && x.as === as)) entry.features.push({ id: feature.id, name: feature.name, as, relation });
  };
  for (const [list, relation] of [[affected, 'affected'], [deps, 'depends on it']]) {
    for (const id of list) {
      const f = byId.get(id);
      add(f.owner, f, 'feature owner', relation);
      for (const s of f.steps) add(s.owner, f, `owner of step "${s.name}"`, relation);
    }
  }
  return { affected, dependents: deps, owners: [...owners.values()] };
}

// Does a person (their owner names) own any of these features, as feature owner or step owner?
export function ownsAny(features, ids, me = []) {
  if (!me.length) return false;
  const names = new Set(me.map((x) => x.toLowerCase()));
  const set = new Set(ids);
  return features.some((f) => set.has(f.id) && (names.has(String(f.owner).toLowerCase()) || f.steps.some((s) => names.has(String(s.owner).toLowerCase()))));
}
