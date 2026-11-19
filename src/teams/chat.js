// Team commands typed in the LifeCycle chat, read with plain rules (no AI needed):
//   create a team called Wishlist that owns the acme-wishlist repo and the redeem_rewards flag
//   rename team wishlist to Reading wishlist            · rename the Wishlist team to Reading wishlist
//   team wishlist now owns the catalog-api service   · add the wishlist-ios app to team wishlist
//   remove the redeem_rewards flag from team wishlist · team wishlist no longer owns …
//   describe team wishlist as Wishlists and saved books
//   delete team catalog                            · delete team catalog and hand it over to platform
// The result is a draft for src/teams/publish.js. Nothing is saved here: the chat shows a preview
// and only a confirmation publishes it (src/ask/actions.js).
import { teamSlug } from './registry.js';
import { toTeamDraft, emptyOwns } from './edit.js';

const Q = `["'“”‘’\`]`;
const unquote = (s) => String(s || '').trim().replace(new RegExp(`^${Q}+|${Q}+$`, 'g'), '').replace(/[.!?]+$/, '').trim();
const TEAM = '(?:the\\s+)?(?:team\\s+)?(.+?)(?:\\s+team)?';

// Does this look like a team command at all? (Questions about teams go to the answer instead.)
export function isTeamCommand(question) {
  const q = String(question || '').trim();
  return /^(?:please\s+)?(?:create|add|define|make|set up|new|rename|delete|remove|describe)\b.*\bteam\b/i.test(q)
    || /^(?:please\s+)?(?:the\s+)?(?:team\s+.+?|.+?\s+team)\s+(?:now\s+|also\s+)*(?:owns?|no longer owns?|doesn't own|does not own)\b/i.test(q);
}

// ctx: { teams, services, flags, apps, repos, defaultOwner }. Returns null (not a team command),
// { error } (a command LifeCycle couldn't read, with what to type instead) or { op, id, draft, handover_to? }.
export function parseTeamCommand(question, ctx) {
  const q = String(question || '').trim().replace(/\s+/g, ' ');
  if (!isTeamCommand(q)) return null;
  const findTeam = (text) => {
    const t = unquote(text);
    const lower = t.toLowerCase();
    return ctx.teams.find((x) => x.id === t || x.name === t || x.aliases.includes(t))
      || ctx.teams.find((x) => x.id === lower || x.name.toLowerCase() === lower || x.aliases.some((a) => a.toLowerCase() === lower) || x.id === teamSlug(t))
      || null;
  };
  const noTeam = (text) => ({ error: `There is no team "${unquote(text)}" in LifeCycle-Data. Defined teams: ${ctx.teams.map((t) => t.name).join(', ') || 'none yet'}.` });

  let m;
  // Create.
  if ((m = q.match(/^(?:please\s+)?(?:create|add|define|make|set up)\s+(?:a\s+|an\s+)?(?:new\s+)?team\s+(?:called\s+|named\s+)?(.+?)(?:\s*,?\s+(?:that|which|who)\s+(?:will\s+)?owns?\s+(.+)|\s*,?\s+owning\s+(.+))?$/i))) {
    const name = unquote(m[1]);
    if (!name) return { error: 'What should the team be called? For example: "create a team called Wishlist".' };
    const owns = parseOwned(m[2] || m[3] || '', ctx);
    if (owns.error) return owns;
    return { op: 'create', id: teamSlug(name), draft: { id: teamSlug(name), name, description: '', aliases: [], owns: owns.owns } };
  }
  // Rename.
  if ((m = q.match(new RegExp(`^(?:please\\s+)?rename\\s+${TEAM}\\s+(?:to|as)\\s+(.+)$`, 'i')))) {
    const t = findTeam(m[1]);
    if (!t) return noTeam(m[1]);
    const name = unquote(m[2]);
    return { op: 'update', id: t.id, draft: { ...toTeamDraft(t), name } };
  }
  // Delete (optionally handing everything over).
  if ((m = q.match(new RegExp(`^(?:please\\s+)?(?:delete|remove)\\s+${TEAM}(?:\\s*,?\\s+(?:and\\s+)?(?:hand(?:ing)?|give|giving|move|moving|transfer(?:ring)?)\\s+(?:(?:it|everything|its \\w+|what it owns)\\s+)?(?:over\\s+)?to\\s+(?:the\\s+)?(?:team\\s+)?(.+?)(?:\\s+team)?)?$`, 'i')))
    && !/\bfrom\b/i.test(q)) {
    const t = findTeam(m[1]);
    if (!t) return noTeam(m[1]);
    let handover = null;
    if (m[2]) {
      handover = findTeam(m[2]);
      if (!handover) return noTeam(m[2]);
    }
    return { op: 'delete', id: t.id, handover_to: handover?.id || null };
  }
  // Description.
  if ((m = q.match(new RegExp(`^(?:please\\s+)?describe\\s+${TEAM}\\s+as\\s+(.+)$`, 'i')))) {
    const t = findTeam(m[1]);
    if (!t) return noTeam(m[1]);
    return { op: 'update', id: t.id, draft: { ...toTeamDraft(t), description: unquote(m[2]) } };
  }
  // Ownership: add or remove.
  let teamText = null;
  let itemsText = null;
  let remove = false;
  if ((m = q.match(new RegExp(`^(?:please\\s+)?${TEAM}\\s+(?:now\\s+|also\\s+)*owns?\\s+(.+)$`, 'i')))) [teamText, itemsText] = [m[1], m[2]];
  else if ((m = q.match(new RegExp(`^(?:please\\s+)?${TEAM}\\s+(?:no longer owns?|doesn't own|does not own)\\s+(.+)$`, 'i')))) [teamText, itemsText, remove] = [m[1], m[2], true];
  else if ((m = q.match(new RegExp(`^(?:please\\s+)?add\\s+(.+?)\\s+to\\s+${TEAM}$`, 'i')))) [itemsText, teamText] = [m[1], m[2]];
  else if ((m = q.match(new RegExp(`^(?:please\\s+)?remove\\s+(.+?)\\s+from\\s+${TEAM}$`, 'i')))) [itemsText, teamText, remove] = [m[1], m[2], true];
  if (teamText) {
    const t = findTeam(teamText);
    if (!t) return noTeam(teamText);
    const parsed = parseOwned(itemsText, ctx);
    if (parsed.error) return parsed;
    const draft = toTeamDraft(t);
    const key = (x) => JSON.stringify(x);
    for (const k of Object.keys(draft.owns)) {
      for (const x of parsed.owns[k]) {
        const has = draft.owns[k].some((y) => key(y) === key(x));
        if (remove) draft.owns[k] = draft.owns[k].filter((y) => key(y) !== key(x));
        else if (!has) draft.owns[k].push(x);
      }
    }
    return { op: 'update', id: t.id, draft };
  }
  return { error: 'I couldn\'t read that team command. Try: "create a team called Wishlist that owns the acme-wishlist repo and the redeem_rewards flag", "rename team wishlist to Reading wishlist", "team wishlist now owns the catalog-api service" or "delete team wishlist".' };
}

// "the acme-wishlist repo and the redeem_rewards flag" → { owns } or { error }.
export function parseOwned(text, ctx) {
  const owns = emptyOwns();
  const t = String(text || '').trim().replace(/[.!?]+$/, '');
  if (!t) return { owns };
  const items = t.split(/\s*,\s*(?:and\s+)?|\s+and\s+|\s*;\s*/i).map((x) => x.trim()).filter(Boolean);
  const unknown = [];
  const repoOf = (name) => {
    const n = unquote(name);
    if (n.includes('/')) return n;
    const known = ctx.repos.find((r) => r.split('/')[1] === n);
    return known || (ctx.defaultOwner ? `${ctx.defaultOwner}/${n}` : null);
  };
  let m;
  for (const raw of items) {
    const item = raw.replace(/^(?:the|its|their|all)\s+/i, '').trim();
    if ((m = item.match(/^(?:tickets|issues)\s+(?:labell?ed|with\s+(?:the\s+)?label|tagged)\s+(.+)$/i)) || (m = item.match(/^(.+?)\s+label$/i)) || (m = item.match(/^label\s+(.+)$/i))) {
      owns.tickets.push({ repo: null, label: unquote(m[1]) });
    } else if ((m = item.match(/^(?:tickets|issues)\s+(?:of|in|from)\s+(?:the\s+)?(.+?)(?:\s+(?:repo|repository))?$/i)) || (m = item.match(/^(.+?)\s+(?:tickets|issues)$/i))) {
      const repo = repoOf(m[1]);
      if (!repo) unknown.push(raw); else owns.tickets.push({ repo, label: null });
    } else if ((m = item.match(/^(.+?)\s+(?:repo|repository)$/i)) || (m = item.match(/^(?:repo|repository)\s+(.+)$/i))) {
      const repo = repoOf(m[1]);
      if (!repo) unknown.push(raw); else owns.repos.push(repo);
    } else if ((m = item.match(/^(.+?)\s+(?:feature\s+)?flag$/i)) || (m = item.match(/^(?:feature\s+)?flag\s+(.+)$/i))) {
      owns.flags.push(unquote(m[1]));
    } else if ((m = item.match(/^(.+?)\s+service$/i)) || (m = item.match(/^service\s+(.+)$/i))) {
      owns.services.push(teamSlug(unquote(m[1])) === unquote(m[1]).toLowerCase() ? unquote(m[1]).toLowerCase() : unquote(m[1]));
    } else if ((m = item.match(/^(.+?)\s+(?:app|component)$/i)) || (m = item.match(/^(?:app|component)\s+(.+)$/i))) {
      owns.apps.push(unquote(m[1]));
    } else {
      // No kind word: a known service, flag, app or repo by that exact name.
      const n = unquote(item);
      if (ctx.services.includes(n)) owns.services.push(n);
      else if (ctx.flags.includes(n)) owns.flags.push(n);
      else if (ctx.apps.includes(n)) owns.apps.push(n);
      else if (n.includes('/') || ctx.repos.some((r) => r.split('/')[1] === n)) owns.repos.push(repoOf(n));
      else unknown.push(raw);
    }
  }
  if (unknown.length) return { error: `I couldn't tell what ${unknown.map((u) => `"${u}"`).join(', ')} ${unknown.length === 1 ? 'is' : 'are'}. Say what kind it is, e.g. "the ${unknown[0]} repo", "the ${unknown[0]} flag", "the ${unknown[0]} service" or "the ${unknown[0]} app".` };
  for (const k of Object.keys(owns)) owns[k] = [...new Map(owns[k].map((x) => [JSON.stringify(x), x])).values()];
  return { owns };
}

// What the parser may match against: the teams and every service, flag, app and repo LifeCycle knows.
export function commandContext({ defs, dataRepo }) {
  const features = defs.featureDefs;
  const repos = [...new Set([...(defs.serviceDefs || []).map((s) => s.repo), ...features.flatMap((f) => f.steps.flatMap((s) => s.evidence.map((e) => e.repo))),
    ...defs.teamDefs.flatMap((t) => t.owns.repos)].filter(Boolean))];
  const owners = repos.map((r) => r.split('/')[0]);
  const counts = new Map();
  for (const o of owners) counts.set(o, (counts.get(o) || 0) + 1);
  const defaultOwner = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || (dataRepo ? dataRepo.split('/')[0] : null);
  return {
    teams: defs.teamDefs,
    services: (defs.serviceDefs || []).map((s) => s.id),
    flags: [...new Set(features.flatMap((f) => f.flags))],
    apps: [...new Set([...(defs.appDefs || []).map((a) => a.id), ...features.flatMap((f) => (f.apps || []).map((a) => (typeof a === 'string' ? a : a.id)))])],
    repos,
    defaultOwner,
  };
}
