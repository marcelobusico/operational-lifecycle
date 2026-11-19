// Which teams a feature depends on, each with the reasons why: the team doing one of its
// steps, the team owning it, the team owning a service, repo, ticket source, flag or app it touches,
// and the teams of every feature it depends on, followed through to the end. Every reason links to
// the step, service, flag, repo or dependency behind it. The app's view, the API and the chat answer
// all come from this one function, so they always agree. Pure logic: no I/O.
import { definitionLink } from '../changes.js';
import { KIND_LABEL, ticketText } from './registry.js';

export const TEAM_DEPS_SCHEMA = 'lifecycle.team-dependencies/v1';
const pageOf = (f) => `/#/feature/${encodeURIComponent(f.id)}`;

// reg: buildTeamRegistry(...). feature: a parsed definition. featuresById: Map(id → definition) of
// the active features dependencies are followed through. config: for links.
export function teamDependencies(reg, feature, { featuresById, config = null }) {
  const defLink = (file) => (config && file ? definitionLink(config, file) : null);

  // The reasons a feature needs teams by itself, without its dependencies.
  function direct(f) {
    const out = [];
    const add = (team, r) => { if (team) out.push({ team, ...r }); };
    const link = pageOf(f);
    add(reg.resolve(f.owner), { kind: 'owner', text: `owns ${f.name} (feature owner)`, link, label: `feature: ${f.name}` });
    for (const s of f.steps || []) {
      const t = reg.resolve(s.team);
      add(t, { kind: 'step', text: `does step "${s.name}"`, link, label: `step: ${s.name}`, step: s.id });
      const o = reg.resolve(s.owner);
      if (o && o !== t) add(o, { kind: 'step', text: `owns step "${s.name}"`, link, label: `step: ${s.name}`, step: s.id });
    }
    for (const u of reg.usesOf(f)) {
      const what = `${KIND_LABEL[u.kind]} ${u.key}`;
      const target = u.kind === 'service' ? defLink(reg.serviceById.get(u.key)?.file) || link
        : u.kind === 'app' ? defLink(reg.appById.get(u.key)?.file) || link
        : u.kind === 'repo' ? `https://github.com/${u.key}` : link;
      for (const t of reg.ownersOf(u.kind, u.key)) add(t, { kind: u.kind, text: `owns ${what} (${f.name} ${u.why})`, link: target, label: what });
    }
    // Issues the steps link to, in a repo whose tickets a team owns.
    for (const s of f.steps || []) for (const e of s.evidence || []) {
      if (e.type !== 'issue') continue;
      for (const t of reg.ticketOwnersOf(e.repo)) {
        add(t, { kind: 'tickets', text: `owns the ${ticketText({ repo: e.repo })} (step "${s.name}" links issue #${e.number})`,
          link: `https://github.com/${e.repo}/issues/${e.number}`, label: `issue ${e.repo}#${e.number}` });
      }
    }
    return out;
  }

  const reasons = direct(feature).map((r) => ({ ...r, via: [] }));
  // Dependencies, breadth first so each one is reached by its shortest path; cycles stop on their own.
  const seen = new Set([feature.id]);
  const queue = (feature.dependsOn || []).map((id) => ({ id, path: [] }));
  const undefinedDeps = [];
  while (queue.length) {
    const { id, path } = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const dep = featuresById.get(id);
    if (!dep) { undefinedDeps.push(id); continue; }
    const via = [...path, { id: dep.id, name: dep.name, link: pageOf(dep) }];
    const chain = via.map((v) => v.name).join(' → ');
    for (const r of direct(dep)) {
      reasons.push({ ...r, kind: 'dependency', reason_kind: r.kind, via, text: `${r.text}, and ${feature.name} depends on ${chain}`,
        link: pageOf(dep), label: `dependency: ${dep.name}`, inner_link: r.link });
    }
    for (const next of dep.dependsOn || []) queue.push({ id: next, path: via });
  }

  const teams = new Map();
  for (const r of reasons) {
    if (!teams.has(r.team.id)) teams.set(r.team.id, { team: reg.brief(r.team), direct: false, reasons: [] });
    const entry = teams.get(r.team.id);
    const { team, ...rest } = r;
    if (!entry.reasons.some((x) => x.text === rest.text)) entry.reasons.push(rest);
    if (!r.via.length) entry.direct = true;
  }
  const list = [...teams.values()].sort((a, b) => Number(b.direct) - Number(a.direct) || a.team.name.localeCompare(b.team.name));

  const uses = reg.usesOf(feature);
  const usedKeys = new Set(uses.map((u) => `${u.kind}|${u.key}`));
  return {
    schema: TEAM_DEPS_SCHEMA,
    feature: { id: feature.id, name: feature.name, link: pageOf(feature) },
    teams: list,
    // Things this feature touches that no team owns, or that two teams claim.
    no_owner: reg.noOwner.filter((n) => usedKeys.has(`${n.kind}|${n.key}`)).map((n) => ({ kind: n.kind, key: n.key, message: `No owner: ${KIND_LABEL[n.kind]} ${n.key} is used here but no team owns it.` })),
    conflicts: reg.conflicts.filter((c) => usedKeys.has(`${c.kind}|${c.key}`)),
    unknown_teams: reg.warningsFor(feature.id),
    undefined_dependencies: undefinedDeps,
    summary: list.length
      ? `${feature.name} depends on ${list.length} team${list.length === 1 ? '' : 's'}: ${list.map((t) => t.team.name).join(', ')}.`
      : `No defined team is linked to ${feature.name} yet: none of its steps, owner, services, repos, flags, apps or dependencies point to a team in LifeCycle-Data.`,
  };
}
