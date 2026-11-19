// Questions about an initiative (a LifeCycle project) or about all of them. Recognising them is
// rules-based, the same for every AI provider and entry point, so the app and the person's AI tools
// give the same answer. The AI may only rewrite the lead sentence, under the same check as feature
// answers (checkLead): cite statements, and no number or date the cited statements don't contain.
import { extractMention, normalize, resolveFeature } from './resolve.js';
import { ruleIntent } from './answer.js';
import { buildProjectFacts, buildProjectListFacts, projectName, countsText, NO_PROJECT_NAME, projectShownState } from './projects.js';
import { STATE_LABEL } from './facts.js';

const PROJECT_WORD = /\b(initiatives?|projects?)\b/i;
const FEATURE_WORD = /\bfeatures?\b/i;
const NO_PROJECT_Q = /\bfeatures?\s+(without|with no|outside)\s+(an?\s+|any\s+)?(initiative|project)s?\b|\bno (initiative|project)\b|\bunassigned features?\b/i;
const ALL_Q = /\b(which|what|all|every|each|list|any)\b|status of|overview|across/i;
const BARE_STATE_Q = /^\s*(what'?s|what is|what are|which are|is anything|anything)\s+(blocked|stuck|flowing|moving|done|finished|not started)\s*[?.!]*\s*$/i;
// Words that are about the question, not the initiative's name.
const EXTRA_WORDS = /\b(initiatives?|projects?|overall|left|remaining|before|done|finished|complete|really|hands|users'?|our|this|that|whole|entire|still|open|far|close|at|risk|target|dates?|deadline|missing|give|summary|a|of|in)\b|'/gi;

const PROGRESS_Q = /what'?s left|what is left|\bremaining\b|left to do|left before|still (open|to do|left)|how (far|close)|before .* (is )?(done|finished|complete)|\bwhat'?s next\b/i;
const LAST_MILE_Q = /users'? hands|in (the )?hands|really (out|live|shipped|done|available)|turned on|\bavailable\b|rolled out|\blive\b|last mile|\breleased\b|\bshipped\b/i;
const SCHEDULE_Q = /target date|deadline|on time|on track|at risk|\blate\b|\bwhen will\b|\bdates?\b/i;

function stateFilter(q) {
  if (/\b(blocked|stuck|blocking)\b/i.test(q)) return 'blocked';
  if (/\bnot started\b/i.test(q)) return 'not_started';
  if (/\b(flowing|moving|in progress)\b/i.test(q)) return 'flowing';
  if (/\b(done|finished|complete)\b/i.test(q)) return 'done';
  if (/\bunavailable\b/i.test(q)) return 'unavailable';
  return null;
}

export function projectIntent(q) {
  if (PROGRESS_Q.test(q)) return 'progress';
  if (LAST_MILE_Q.test(q)) return 'availability';
  const r = ruleIntent(q);
  if (r === 'blockers' || r === 'push') return 'blockers';
  if (SCHEDULE_Q.test(q)) return 'schedule';
  if (r === 'status' || /\btell me about\b|\boverview\b/i.test(q)) return 'status';
  return r === 'availability' ? 'availability' : 'other';
}

const projectMention = (q) => extractMention(q).replace(EXTRA_WORDS, ' ').replace(/\s+/g, ' ').trim();

// Is the question about an initiative, or about all of them? null = it's a feature question.
// features: the defined features ({ id, name }), for names shared by a feature and an initiative.
export function projectRoute(q, { intent, snap, features }) {
  if (intent === 'teams') return null;
  const projects = snap.projects || [];
  const named = projects.filter((p) => p.project.id !== null);
  if (NO_PROJECT_Q.test(q)) return { kind: 'one', p: projects.find((p) => p.project.id === null) || emptyNoProject(), intent: projectIntent(q) };
  if (FEATURE_WORD.test(q)) return null;
  if ((/\b(initiatives|projects)\b/i.test(q) && ALL_Q.test(q)) || BARE_STATE_Q.test(q)) return { kind: 'list', filter: stateFilter(q), intent: 'list' };

  const items = named.map((p) => ({ id: p.project.id, name: p.project.name }));
  const mention = projectMention(q);
  if (PROJECT_WORD.test(q)) {
    if (!mention) return { kind: 'clarify', mention: '', candidates: items };
    const r = resolveFeature(mention, items);
    if (r.kind === 'match') return { kind: 'one', p: named.find((p) => p.project.id === r.feature.id), intent: projectIntent(q) };
    if (r.kind === 'ambiguous') return { kind: 'clarify', mention, candidates: r.candidates };
    return { kind: 'unknown', mention, closest: r.closest.length ? r.closest : nearest(mention, items) };
  }
  // No "initiative"/"project" in the question: only an exact initiative name counts. When that name
  // is also a feature, ask which one is meant instead of picking silently.
  const raw = extractMention(q);
  const exact = named.filter((p) => [normalize(raw), normalize(mention)].some((m) => m && (m === normalize(p.project.name) || m === normalize(p.project.id))));
  if (exact.length !== 1) return null;
  const f = resolveFeature(raw, features);
  if (f.kind === 'match' || (f.kind === 'ambiguous' && f.candidates.some((c) => normalize(c.name) === normalize(exact[0].project.name)))) {
    const feature = f.kind === 'match' ? f.feature : f.candidates.find((c) => normalize(c.name) === normalize(exact[0].project.name));
    return { kind: 'both', mention: raw, feature, p: exact[0] };
  }
  return { kind: 'one', p: exact[0], intent: projectIntent(q) };
}

// Rough nearest names when nothing fits at all: shared words or a similar start.
function nearest(mention, items) {
  const words = new Set(normalize(mention).split(' ').filter((w) => w.length > 2));
  return items.filter((x) => normalize(x.name).split(' ').some((w) => words.has(w) || [...words].some((m) => w.startsWith(m.slice(0, 4)))))
    .slice(0, 3);
}

function emptyNoProject() {
  return { project: { id: null, name: 'No project', owner: null, description: null, file: null }, state: 'not_started',
    counts: { blocked: 0, unavailable: 0, flowing: 0, not_started: 0, done: 0 }, features: [], blockers: [], depends_on_outside: [], depended_on_from_outside: [] };
}

// The question with the shared name pointed at one of the two ("… the project "Redeem rewards" …").
function rephrase(q, mention, kind, name) {
  const target = `the ${kind} "${name}"`;
  const i = q.toLowerCase().indexOf(String(mention).toLowerCase());
  if (mention && i >= 0) return q.slice(0, i) + target + q.slice(i + mention.length);
  return `How is ${target} going?`;
}

export const PROJECT_SECTIONS = {
  status: ['overall', 'blockers', 'remaining', 'unavailable', 'schedule', 'last_mile', 'outside'],
  blockers: ['overall', 'blockers', 'unavailable', 'schedule', 'outside'],
  progress: ['overall', 'remaining', 'unavailable', 'schedule', 'outside'],
  availability: ['last_mile', 'unavailable', 'overall', 'schedule', 'outside'],
  schedule: ['schedule', 'overall', 'remaining', 'unavailable', 'outside'],
};

export const PROJECT_SECTION_TITLE = {
  overall: 'Overall', blockers: 'Blockers · who to push', remaining: "What's left", unavailable: "Can't be read",
  schedule: 'Target dates', last_mile: "In users' hands?", outside: 'Outside this initiative', projects: 'Initiatives', all_projects: 'All initiatives',
};

const p0 = (name) => name === NO_PROJECT_NAME;
const nameList = (list) => (list.length <= 2 ? list.join(' and ') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`);

function ruleLead(intent, name, built, picked) {
  const by = (sec) => picked.filter((f) => f.section === sec);
  const overall = picked.find((f) => f.section === 'overall');
  const unav = by('unavailable');
  const risk = by('schedule').find((f) => f.at_risk);
  const n = built.members.length;
  const lead = (text, cites) => ({ text, cites: cites.filter(Boolean).map((f) => f.id), by: 'rules' });
  if (!n) return lead(p0(name) ? 'There are no features without an initiative: every feature belongs to one.' : `${name} is not started, no features yet.`, [overall]);
  if (intent === 'blockers') {
    const bl = by('blockers');
    if (bl.length) {
      const owners = [...new Set(bl.map((f) => f.push.owner))];
      const blocked = [...new Set(bl.flatMap((f) => f.blocked_features))].map((id) => built.members.find((s) => s.feature.id === id).feature.name);
      return lead(`${nameList(blocked)} ${blocked.length === 1 ? 'is' : 'are'} blocked in ${name}. Push ${nameList(owners)}.`, [overall, ...bl]);
    }
    if (unav.length) return lead(`I can't confirm nothing is blocking ${name}: part of its status is unavailable.`, [overall, ...unav]);
    return lead(`Nothing is blocking ${name} right now.`, [overall]);
  }
  if (intent === 'progress') {
    const rem = by('remaining');
    const head = rem[0];
    const open = rem.slice(1);
    if (!open.length) return lead(unav.length ? `Nothing is known to be left on ${name}, but part of its status is unavailable.` : `Nothing is left on ${name}: every feature is done.`, [overall, head, ...unav]);
    return lead(`${name}: ${head.text.replace(/\.$/, '')}: ${nameList(open.map((f) => f.text.split(':')[0]))}.`, [head, ...open]);
  }
  if (intent === 'availability') {
    const lm = by('last_mile');
    const summary = lm.find((f) => f.last_mile_summary);
    if (!summary) return lead(`LifeCycle doesn't track whether ${name}'s features are available to users.`, [overall]);
    const gap = lm.filter((f) => f.last_mile);
    const text = `${name}: ${summary.text.replace(/^In users' hands: /, '').replace(/;.*$/, '').replace(/\.$/, '')}${gap.length ? `. Not fully in users' hands yet: ${gap.map((f) => f.text.split('. ')[0]).join('; ')}` : ''}.${unav.length ? ' Part of its status is unavailable.' : ''}`;
    return lead(text, [summary, ...gap, ...unav]);
  }
  if (intent === 'schedule') {
    if (risk) return lead(`${name} is at risk of missing its target dates: ${nameList(risk.at_risk.map((id) => built.members.find((s) => s.feature.id === id).feature.name))}.`, [risk]);
    const dated = by('schedule');
    return lead(dated.length ? `No feature of ${name} is at risk of missing its target date.` : `None of ${name}'s features has a target date.`, [overall, ...dated]);
  }
  // status
  const gap = by('last_mile').filter((f) => f.last_mile);
  const verb = built.members.length && p0(name) ? 'are' : 'is';
  const text = built.state !== overall.rollup_state
    ? `${name} can't be confirmed done: part of its status is unavailable.`
    : `${name} ${verb} ${STATE_LABEL[built.state]}: ${countsText(overall.counts)}.${risk ? ' At risk of missing its target dates.' : ''}${gap.length ? ` Not fully in users' hands yet: ${nameList(gap.map((f) => f.text.split(':')[0]))}.` : ''}`;
  return lead(text, [overall, ...(risk ? [risk] : []), ...gap, ...(built.state !== overall.rollup_state ? unav : [])]);
}

async function aiLead({ provider, providerFailed, base, q, intent, subject, picked, freshness, rules, checkLead }) {
  if (!provider.lead || providerFailed || !rules.cites.length) return rules;
  try {
    const ai = await provider.lead({ question: q, intent, feature: subject, facts: picked, freshness });
    const problem = checkLead(ai, picked);
    if (problem) {
      base.provider.note = `${provider.name}'s summary was dropped (${problem}); showing LifeCycle's own.`;
      return rules;
    }
    base.provider.used = true;
    return { text: ai.text.trim(), cites: ai.cites, by: provider.name };
  } catch (err) {
    base.provider.note = `${provider.name} couldn't write the summary (${err.message}); showing LifeCycle's own.`;
    return rules;
  }
}

const definedProjects = (snap) => (snap.projects || []).filter((p) => p.project.id !== null).map((p) => ({ id: p.project.id, name: p.project.name }));

// route: projectRoute(). Returns the answer (lifecycle.answer/v1 with scope 'project' or 'projects').
export async function answerProjectQuestion({ route, base, q, snap, config, provider, providerFailed, now, freshness, checkLead }) {
  const ans = (fields) => ({ blockers: [], ...base, feature: null, ...fields });
  if (route.kind === 'both') {
    const candidates = [
      { id: route.feature.id, name: route.feature.name, kind: 'feature', ask: rephrase(q, route.mention, 'feature', route.feature.name) },
      { id: route.p.project.id, name: route.p.project.name, kind: 'project', ask: rephrase(q, route.mention, 'project', route.p.project.name) },
    ];
    return ans({ scope: 'project', outcome: 'clarify', mention: route.mention, candidates, sections: [], freshness,
      lead: { text: `"${route.p.project.name}" is both a feature and a project (initiative). Which one do you mean?`, cites: [], by: 'rules' } });
  }
  if (route.kind === 'clarify') {
    return ans({ scope: 'project', outcome: 'clarify', mention: route.mention, sections: [], freshness,
      candidates: route.candidates.map((c) => ({ ...c, kind: 'project', ask: route.mention ? rephrase(q, route.mention, 'project', c.name) : `How is the project "${c.name}" going?` })),
      lead: { text: route.mention ? `Which initiative do you mean by "${route.mention}"? Closest matches: ${route.candidates.map((c) => c.name).join('; ')}.` : 'Which initiative do you mean?', cites: [], by: 'rules' } });
  }
  if (route.kind === 'unknown') {
    const defined = definedProjects(snap);
    const tail = route.closest.length ? ` Closest matches: ${route.closest.map((c) => c.name).join('; ')}.`
      : defined.length ? ` The initiatives I know: ${defined.map((c) => c.name).join('; ')}.` : ' No initiatives (projects) are defined yet.';
    return ans({ scope: 'project', outcome: 'unknown_project', mention: route.mention, closest: route.closest, defined_projects: defined, sections: [], freshness,
      lead: { text: `I couldn't find that initiative ("${route.mention}").${tail}`, cites: [], by: 'rules' } });
  }

  if (route.kind === 'list') {
    const all = (snap.projects || []).filter((p) => p.project.id !== null);
    const matching = route.filter ? all.filter((p) => projectShownState(p, snap) === route.filter) : all;
    const facts = buildProjectListFacts({ projects: matching.length ? matching : all, snap });
    const section = matching.length ? 'projects' : 'all_projects';
    for (const f of facts) f.section = section;
    const label = route.filter ? STATE_LABEL[route.filter] : null;
    const rules = !all.length ? { text: 'No initiatives (projects) are defined yet.', cites: [], by: 'rules' }
      : !matching.length ? { text: `No initiative is ${label} right now.`, cites: facts.map((f) => f.id), by: 'rules' }
        : route.filter ? { text: `${label.charAt(0).toUpperCase()}${label.slice(1)}: ${nameList(matching.map(projectName))}.`, cites: facts.map((f) => f.id), by: 'rules' }
          : { text: `Status of every initiative: ${matching.map((p) => `${projectName(p)} ${STATE_LABEL[projectShownState(p, snap)]}`).join('; ')}.`, cites: facts.map((f) => f.id), by: 'rules' };
    const lead = await aiLead({ provider, providerFailed, base, q, intent: 'status', subject: { id: null, name: 'all initiatives' }, picked: facts, freshness, rules, checkLead });
    return ans({ scope: 'projects', intent: 'list', outcome: 'answered', filter: route.filter, lead, freshness,
      sections: facts.length ? [{ id: section, title: PROJECT_SECTION_TITLE[section], statements: facts }] : [] });
  }

  const p = route.p;
  const name = projectName(p);
  const project = { id: p.project.id, name, owner: p.project.owner };
  const built = buildProjectFacts({ p, snap, config, now });
  const intent = route.intent;
  if (intent === 'other') {
    return ans({ scope: 'project', project, intent, outcome: 'no_data', sections: [], freshness: built.freshness,
      lead: { text: `LifeCycle's data doesn't answer that for ${name}. I can tell you how it's going, what's blocking it, what's left, its target dates and whether it's in users' hands.`, cites: [], by: 'rules' } });
  }
  const wanted = PROJECT_SECTIONS[intent];
  const renumber = new Map();
  const picked = wanted.flatMap((sec) => built.facts.filter((f) => f.section === sec)).map((f, i) => {
    const copy = { ...f, id: `f${i + 1}` };
    renumber.set(f, copy);
    return copy;
  });
  const sections = wanted.map((s) => ({ id: s, title: PROJECT_SECTION_TITLE[s], statements: picked.filter((f) => f.section === s) })).filter((s) => s.statements.length);
  const rules = ruleLead(intent, name, built, picked);
  const lead = await aiLead({ provider, providerFailed, base, q, intent, subject: project, picked, freshness: built.freshness, rules, checkLead });
  const blockers = picked.filter((f) => f.section === 'blockers').map((f) => ({ statement: f.id, owner: f.push.owner, message: f.push.message }));
  return ans({ scope: 'project', project, intent, outcome: 'answered', lead, sections, freshness: built.freshness, blockers,
    project_state: { state: built.state, rollup_state: p.state, counts: p.counts, features: built.members.length } });
}

export { NO_PROJECT_NAME };
