// Answers a question about a feature from the live snapshot (app.refresh()). The same function
// serves the local app and the AI-tools (MCP) entry point, so both give the same answer.
//
// 1. Interpret: which intent, and which words name the feature (AI provider, else rules).
// 2. Resolve the feature deterministically (resolve.js): match, unclear (ask), or unknown (say so).
// 3. Build statements with evidence from the live status, registered changes and alerts (facts.js).
// 4. Lead sentence: the AI provider may write one, but only citing statement ids; numbers and dates
//    in it must appear in the statements it cites, otherwise the rules lead is used.
import { groupsText } from '../lastmile/experiments.js';
import { resolveFeature, extractMention } from './resolve.js';
import { buildFacts, STATE_LABEL } from './facts.js';
import { projectRoute, answerProjectQuestion } from './project-answer.js';
import { storeSource } from '../lastmile/state.js';

export const ANSWER_SCHEMA = 'lifecycle.answer/v1';
export const INTENTS = ['status', 'blockers', 'availability', 'ramp', 'push', 'teams', 'other'];

// "Which teams do I depend on for X?", "What teams does X need?": the team dependency view (src/teams).
const TEAMS_Q = /\b(which|what) teams?\b|\bteams?\b.*\b(depend|rel(y|ies) on|need|involved)|\bdepend\w*\b.*\bteams?\b/;

export function ruleIntent(question) {
  const q = String(question || '').toLowerCase();
  if (TEAMS_Q.test(q)) return 'teams';
  if (/\bwho\b.*\b(push|ping|chase|nudge|ask|talk to|contact|follow up)\b|\bwho (do|should) (i|we)\b|\bwho owns\b/.test(q)) return 'push';
  if (/\bramp(ed|ing)?\b|ready to (roll|turn|go|launch|ship|release)|(ok|okay|safe) to (roll|turn up|ramp|increase|expand)/.test(q)) return 'ramp';
  if (/block|holding .* up|holding up|stuck|waiting on|in the way/.test(q)) return 'blockers';
  if (/available|turned on|switched on|\blive\b|enabled|rolled out|rollout|can (users|customers)|(users|customers) (get|see|use)|\bflag/.test(q)) return 'availability';
  if (/\bhow('s| is| are)\b|going|status|update|progress|where (are|is)|summary|state of/.test(q)) return 'status';
  return 'other';
}

// Constraint: Ask never creates a PRD (product requirements document), in the app, the AI tools or
// the CLI. A request to write one is refused before the change flow, the AI provider or any source
// is involved, and nothing is written anywhere.
const PRD_WORD = /\b(prds?|product requirements?(?: doc(?:ument)?s?)?)\b/i;
const PRD_MAKE = /\b(create|write|draft|generate|make|produce|build|prepare|start|new|add|put together|turn .* into|give me|spin up|author)\b/i;
export function isPrdRequest(question) {
  const q = String(question || '');
  return PRD_WORD.test(q) && (PRD_MAKE.test(q) || /^\s*(a\s+)?(prd|product requirements)/i.test(q));
}

export function prdRefusal({ question, provider = rulesInterpreter, now = Date.now() }) {
  return {
    schema: ANSWER_SCHEMA, question: String(question || '').trim(), asked_at: new Date(now).toISOString(), feature: null, intent: 'prd',
    provider: { name: provider.name, model: provider.model || null, used: false, note: null },
    outcome: 'not_allowed', blockers: [], sections: [], freshness: [],
    lead: { text: "I can't create a PRD here. Ask only answers how features and initiatives are going, from live data with evidence, and edits feature definitions; it never writes product requirements documents. I can tell you how something is going, what's blocking it, what's left, or whether it's in users' hands.", cites: [], by: 'rules' },
  };
}

export const rulesInterpreter = {
  name: 'rules',
  async interpret({ question }) {
    return { intent: ruleIntent(question), mention: extractMention(question) };
  },
};

const SECTIONS_FOR = {
  status: ['overall', 'blockers', 'last_mile', 'schedule', 'changes', 'alerts', 'steps'],
  blockers: ['overall', 'blockers', 'schedule', 'changes', 'alerts'],
  availability: ['last_mile', 'blockers', 'changes', 'alerts'],
  push: ['overall', 'blockers', 'steps'],
  ramp: ['ramp'],
};

export const SECTION_TITLE = {
  overall: 'Overall', blockers: 'Blockers · who to push', last_mile: 'Available to users?', schedule: 'Target date',
  changes: 'Registered changes', alerts: 'Alerts', steps: 'Steps', ramp: 'Ready to ramp?',
  teams: 'Teams it depends on', team_issues: 'Ownership to fix',
};

function ruleLead(intent, status, picked, built) {
  const name = status.feature.name;
  const lm = status.last_mile;
  const lmFact = picked.find((f) => f.section === 'last_mile' && f.last_mile);
  const risk = picked.find((f) => f.section === 'schedule' && f.at_risk);
  const cites = [];
  let text;
  if (intent === 'ramp') {
    const v = picked.find((f) => f.section === 'ramp' && f.ramp_verdict);
    if (!v) return { text: `LifeCycle doesn't give a ramp verdict for ${name}.`, cites: [], by: 'rules' };
    const reasonFacts = picked.filter((f) => f.section === 'ramp' && f.ramp_reason);
    const owners = [...new Set(reasonFacts.map((f) => f.owner))];
    text = status.ramp.verdict === 'not_ready'
      ? `${name}: ${status.ramp.label.toLowerCase()}, ${reasonFacts.length} reason${reasonFacts.length === 1 ? '' : 's'}. Push ${owners.join(', ')}.`
      : `${name}: ${status.ramp.verdict === 'ready' ? 'ready to ramp' : "can't tell if it's ready to ramp"}.`;
    cites.push(v.id, ...reasonFacts.map((f) => f.id), ...picked.filter((f) => f.section === 'ramp' && f.ramp_unavailable).map((f) => f.id));
    return { text, cites, by: 'rules' };
  }
  if (intent === 'availability') {
    if (lmFact) {
      text = `${name}: ${lm.label}.`;
      cites.push(lmFact.id);
      // In an experiment: the groups, their shares and what each gets, citing the experiment itself.
      const exp = lm.state === 'in_experiment' && picked.find((f) => f.experiment === lm.experiment?.id && f.experiment_state === 'running');
      if (exp) {
        text = `${name}: ${lm.label}. Users get different behavior by group: ${groupsText(lm.experiment.groups)}.`;
        cites.push(exp.id);
      }
      // A mobile feature: the app version and rollout per platform, citing each store.
      const storeFacts = picked.filter((f) => f.section === 'last_mile' && f.platform && f.store_state);
      if (storeFacts.length) {
        const per = (lm.apps || []).flatMap((a) => Object.values(a.platforms || {}).map((c) => `${c.platform_label}: ${c.label}${c.connected ? ` (${storeSource(c)})` : ''}`));
        text += ` ${per.join('; ')}.`;
        cites.push(...storeFacts.map((f) => f.id));
      }
    } else {
      text = `LifeCycle doesn't track whether ${name} is available to users.`;
    }
  } else if ((intent === 'push' || intent === 'blockers') && !built.blockers.length && ['unavailable'].includes(status.state)) {
    text = `I can't confirm whether anything is blocking ${name}: its status is unavailable (see "Out of date").`;
    cites.push(built.overall.id);
  } else if (intent === 'push') {
    if (built.blockers.length) {
      const owners = [...new Set(built.blockers.map((b) => b.push.owner))];
      text = `Push ${owners.join(' and ')}: ${built.blockers.length} blocker${built.blockers.length === 1 ? '' : 's'} on ${name}.`;
      cites.push(...built.blockers.map((b) => b.id));
    } else {
      const cur = picked.find((f) => f.section === 'steps' && f.current);
      text = cur ? `Nothing is blocking ${name}; the current step is owned by ${status.steps.find((s) => s.id === cur.step).owner}.` : `Nothing is blocking ${name}.`;
      cites.push(built.overall.id, ...(cur ? [cur.id] : []));
    }
  } else if (intent === 'blockers' && !built.blockers.length) {
    text = `Nothing is blocking ${name} right now (${STATE_LABEL[status.state]}).`;
    cites.push(built.overall.id);
  } else {
    text = `${name}: ${STATE_LABEL[status.state] || status.state}${lmFact ? `. Available to users: ${lm.label.toLowerCase()}` : ''}${risk ? '. At risk of missing its target date' : ''}.`;
    cites.push(built.overall.id, ...(lmFact ? [lmFact.id] : []), ...(risk ? [risk.id] : []));
  }
  return { text, cites, by: 'rules' };
}

// Rejects an AI lead that cites nothing, cites an unknown statement, or carries a number or date
// that none of its cited statements contains.
export function checkLead(lead, facts) {
  if (!lead || typeof lead.text !== 'string' || !lead.text.trim() || !Array.isArray(lead.cites) || !lead.cites.length) return 'no citations';
  const byId = new Map(facts.map((f) => [f.id, f]));
  if (lead.cites.some((c) => !byId.has(c))) return 'cites a statement that does not exist';
  const cited = lead.cites.map((c) => byId.get(c).text).join(' ');
  const numbers = lead.text.match(/\d[\d.:-]*\d|\d/g) || [];
  const missing = numbers.filter((n) => !cited.includes(n));
  if (missing.length) return `mentions ${missing.join(', ')}, which the cited statements don't say`;
  if (lead.text.length > 400) return 'too long';
  return null;
}

// snap: app.refresh(). provider: { name, interpret(), lead()? } (see providers.js).
export async function answerQuestion({ question, snap, config, provider = rulesInterpreter, now = Date.now() }) {
  if (isPrdRequest(question)) return prdRefusal({ question, provider, now });
  const askedAt = new Date(now).toISOString();
  const q = String(question || '').trim();
  const features = snap.features.map((s) => ({ id: s.feature.id, name: s.feature.name }));
  const base = {
    schema: ANSWER_SCHEMA, question: q, asked_at: askedAt, feature: null, intent: null,
    provider: { name: provider.name, model: provider.model || null, used: false, note: null },
  };
  const defined = features.map((f) => ({ id: f.id, name: f.name }));
  if (provider.unknown) base.provider.note = `Unknown AI provider "${provider.unknown}" in the local config (use claude, openai-compatible, command or none); answered with LifeCycle's rules.`;

  let interpretation;
  let providerFailed = false;
  try {
    interpretation = await provider.interpret({ question: q, features });
    base.provider.used = provider.name !== 'rules';
  } catch (err) {
    interpretation = await rulesInterpreter.interpret({ question: q });
    providerFailed = true;
    base.provider.note = `${provider.name} couldn't be used (${err.message}); answered with LifeCycle's rules.`;
  }
  // Team questions are recognised by their wording even if the AI picked another intent.
  const intent = ruleIntent(q) === 'teams' ? 'teams' : INTENTS.includes(interpretation.intent) ? interpretation.intent : ruleIntent(q);
  base.intent = intent;
  // "Which teams do I depend on for redeem rewards?": the feature is what follows "for".
  const teamsFor = intent === 'teams' ? teamsMention(q, features) : null;
  const mention = (teamsFor || (interpretation.mention ?? extractMention(q))).trim();

  // An initiative (project) or every initiative: rules-based, so every provider routes it the same way.
  const route = projectRoute(q, { intent, snap, features });
  if (route) {
    return answerProjectQuestion({ route, base, q, snap, config, provider, providerFailed, now, freshness: snapFreshness(snap), checkLead });
  }

  if (!mention) {
    return finish({ ...base, outcome: 'clarify', candidates: defined,
      lead: { text: 'Which feature do you mean?', cites: [], by: 'rules' }, sections: [], freshness: [], defined_features: defined });
  }
  const r = resolveFeature(mention, features);
  if (r.kind === 'unknown') {
    return finish({ ...base, outcome: 'unknown_feature', mention, defined_features: defined, closest: r.closest,
      lead: { text: `I don't have a feature called "${mention}".`, cites: [], by: 'rules' }, sections: [], freshness: snapFreshness(snap) });
  }
  if (r.kind === 'ambiguous') {
    return finish({ ...base, outcome: 'clarify', mention, candidates: r.candidates,
      lead: { text: `Which feature do you mean by "${mention}"? Closest matches: ${r.candidates.map((c) => c.name).join('; ')}.`, cites: [], by: 'rules' },
      sections: [], freshness: snapFreshness(snap) });
  }

  // The teams a feature depends on: the same list, reasons and links as its Teams view.
  if (intent === 'teams') {
    const holder = snap.features.find((s) => s.feature.id === r.feature.id);
    const deps = holder?.team_dependencies;
    const item = holder.feature;
    base.feature = { id: item.id, name: item.name, owner: item.owner };
    return finish({ ...base, outcome: 'answered', ...teamsAnswer(deps), freshness: snapFreshness(snap), team_dependencies: deps });
  }

  const status = snap.features.find((s) => s.feature.id === r.feature.id);
  base.feature = { id: status.feature.id, name: status.feature.name, owner: status.feature.owner };
  const built = buildFacts({ status, snap, config, now });

  if (intent === 'other') {
    return finish({ ...base, outcome: 'no_data',
      lead: { text: `LifeCycle's data doesn't answer that for ${status.feature.name}. I can tell you how it's going, what's blocking it, whether it's available to users, and who to push.`, cites: [], by: 'rules' },
      sections: [], freshness: built.freshness });
  }

  // Keep the sections this question needs, numbered in the order they are shown.
  const wanted = SECTIONS_FOR[intent];
  const renumber = new Map();
  const picked = wanted.flatMap((sec) => built.facts.filter((f) => f.section === sec)).map((f, i) => {
    const copy = { ...f, id: `f${i + 1}` };
    renumber.set(f, copy);
    return copy;
  });
  built.overall = renumber.get(built.overall) || built.overall;
  built.blockers = built.blockers.map((b) => renumber.get(b) || b);
  const sections = wanted
    .map((s) => ({ id: s, title: SECTION_TITLE[s], statements: picked.filter((f) => f.section === s) }))
    .filter((s) => s.statements.length);

  let lead = ruleLead(intent, status, picked, built);
  if (provider.lead && !providerFailed) {
    try {
      const ai = await provider.lead({ question: q, intent, feature: base.feature, facts: picked, freshness: built.freshness });
      const problem = checkLead(ai, picked);
      if (problem) base.provider.note = `${provider.name}'s summary was dropped (${problem}); showing LifeCycle's own.`;
      else {
        lead = { text: ai.text.trim(), cites: ai.cites, by: provider.name };
        base.provider.used = true;
      }
    } catch (err) {
      base.provider.note = `${provider.name} couldn't write the summary (${err.message}); showing LifeCycle's own.`;
    }
  }

  return finish({ ...base, outcome: 'answered', lead, sections, freshness: built.freshness,
    blockers: built.blockers.filter((b) => wanted.includes('blockers')).map((b) => ({ statement: b.id, owner: b.push.owner, message: b.push.message })) });
}

// The feature named in a team question: after "for"/"of", or between "does" and "need/depend".
function teamsMention(q, features) {
  const t = q.replace(/[?.!]+$/, '').trim();
  const candidates = [
    t.match(/\b(?:for|of)\s+(.+)$/i)?.[1],
    t.match(/\b(?:does|do|will)\s+(.+?)\s+(?:depend|need|rely|involve)/i)?.[1],
  ].filter(Boolean).map((c) => c.replace(/\s+(?:depend|need|rel)\w*(?:\s+on)?$/i, '').trim());
  return candidates.find((c) => resolveFeature(c, features).kind === 'match') || null;
}

// A team dependency view (src/teams/dependencies.js) as answer statements: one per team with every
// reason as an evidence link, then what to fix (unknown team names, conflicts, things with no owner).
export function teamsAnswer(deps) {
  const facts = [];
  const add = (section, text, evidence = [], extra = {}) => facts.push({ id: `f${facts.length + 1}`, section, text, evidence, ...extra });
  for (const t of deps.teams) {
    add('teams', `${t.team.name}${t.direct ? '' : ' (through dependencies)'}: ${t.reasons.map((r) => r.text).join('; ')}.`,
      [{ label: `team: ${t.team.name}`, link: t.team.link }, ...t.reasons.map((r) => ({ label: r.label, link: r.link }))].filter((e, i, all) => all.findIndex((x) => x.link === e.link && x.label === e.label) === i),
      { team: t.team.id });
  }
  for (const u of deps.unknown_teams) add('team_issues', u.message, [{ label: `feature: ${deps.feature.name}`, link: deps.feature.link }], { kind: 'unknown_team' });
  for (const c of deps.conflicts) add('team_issues', c.message, c.teams.map((t) => ({ label: `team: ${t.name}`, link: t.link })), { kind: 'ownership_conflict' });
  for (const n of deps.no_owner) add('team_issues', n.message, [], { kind: 'no_owner' });
  const sections = ['teams', 'team_issues'].map((s) => ({ id: s, title: SECTION_TITLE[s], statements: facts.filter((f) => f.section === s) })).filter((s) => s.statements.length);
  return { lead: { text: deps.summary, cites: facts.filter((f) => f.section === 'teams').map((f) => f.id), by: 'rules' }, sections };
}

function snapFreshness(snap) {
  const d = snap.definitions;
  return d?.stale
    ? [{ source: 'shared repo', text: `Feature definitions come from the last sync at ${d.synced_at || 'never'}: the shared repo couldn't be read.`, last_successful_read_at: d.synced_at }]
    : [];
}

function finish(answer) {
  return { blockers: [], ...answer };
}
