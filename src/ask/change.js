// Creating, editing and deleting feature definitions by talking to LifeCycle's chat (the app's Ask
// and the person's own AI tools, through the same service). The chat never saves by itself: it
// collects what a valid definition needs one question at a time, shows the full proposed definition
// (or a before/after of only what changes), runs the same validation and AI product review as the
// form, and saves only after an explicit "yes" — through the form's own publish path
// (src/features/publish.js: direct commit under the person's GitHub identity, conflict detection,
// local outbox when the repo can't be reached).
//
// Status is never typed in: asking to "mark a step done" gets the explanation and what actually
// changes it (attach a PR or issue, add a ramp condition, register a change). Flags, tickets,
// deploys and PRs are never changed from here.
//
// handle() returns null when the message is not about changing a definition and no conversation is
// waiting for an answer; the message is then answered as a question (answer.js).
import { buildFeatureFile, toDraft, slug, dependentsOf } from '../features/edit.js';
import { textHash } from '../features/publish.js';
import { resolveFeature, normalize } from './resolve.js';
import { readSession, saveSession, isYes, isNo } from './confirm.js';
import { isTeamCommand } from '../teams/chat.js';
import { evidenceShort } from '../evidence.js';

export const CHANGE_SCHEMA = 'lifecycle.chat-change/v1';

const DATE = /\b(\d{4}-\d{2}-\d{2})\b/;
const EMPTY = /^(?:""|''|“”|empty|nobody|no one|none|nothing|blank|clear|unset|-)$/i;
const SUGGESTED = /^\s*(?:use (?:the |that |your )?suggest(?:ion|ed(?: value)?|ions)|(?:yes|ok|okay|sure|fine|that'?s fine|sounds good|go with (?:that|it)))\s*[.!]*\s*$/i;
const USE_SUGGESTIONS = /^\s*(?:use|add|apply|take) (?:all )?(?:the |your )?suggestions?\b/i;

// Cleans a captured value: quotes, trailing punctuation; "empty", "nobody", '""' become ''.
function value(text) {
  const v = String(text ?? '').trim().replace(/[.!?]+$/, '').replace(/^["“'`](.*)["”'`]$/, '$1').trim();
  return EMPTY.test(v) || v === '' ? '' : v;
}
const mentionOf = (text) => String(text || '').trim().replace(/[?.!]+$/, '').replace(/^["“']|["”']$/g, '').replace(/^(?:the\s+)?feature\s+/i, '').replace(/'s$/i, '').trim();
const splitList = (text) => String(text || '').split(/\s*(?:,|;|\band\b|&)\s*/i).map((x) => mentionOf(x)).filter(Boolean);

const STEP_FIELD = { owner: 'owner', 'done when': 'done_when', done_when: 'done_when', donewhen: 'done_when', name: 'name', team: 'team' };
const FIELD_LABEL = {
  owner: 'Owner', name: 'Name', description: 'Description', project: 'Project', target_date: 'Target date',
  depends_on: 'Depends on', services: 'Services', flags: 'Flags', steps: 'Steps', ramp_conditions: 'Ramp conditions',
};

// A validator field (steps[0].owner) in plain words, with the field kept for the person to see.
export function fieldLabel(field, draft) {
  const m = String(field).match(/^(steps|ramp_conditions)\[(\d+)\](?:\.(\w+))?/);
  if (m) {
    const s = draft?.[m[1]]?.[Number(m[2])];
    const what = m[1] === 'steps' ? 'step' : 'ramp condition';
    return `${what} "${s?.name || s?.id || Number(m[2]) + 1}"${m[3] ? ` ${m[3] === 'done_when' ? '"done when"' : m[3]}` : ''} (${field})`;
  }
  return `${(FIELD_LABEL[field] || field).toLowerCase()} (${field})`;
}

// ---------------------------------------------------------------------------------------------
// Parsing: what change does the message ask for? Deterministic rules, so the app and the AI tools
// read a message the same way. Each rule returns { kind, ... }; `of` is the words naming the feature
// (missing: the feature this conversation is about).
const OF = '(?:of|for|on|in)';
const RULES = [
  // Status is read live: explain, then offer what changes it.
  [/\bmark\b[\s\S]*\b(?:as\s+)?(done|complete|completed|finished|in progress|started|blocked|not done)\b/i, (m, q) => ({ kind: 'status', ...statusTarget(q) })],
  [/\b(?:update|change|set|edit|move)\s+(?:the\s+)?status\b(?:\s+(?:of|for|on)\s+(.+))?/i, (m, q) => ({ kind: 'status', ...statusTarget(q), of: m[1] ? mentionOf(m[1].replace(/\s+to\s+.*$/i, '')) : statusTarget(q).of })],
  // Create a feature with the exact name the person chose.
  [/^\s*(?:please\s+)?(?:(?:can|could|would) you\s+)?(?:i (?:want|would like|'d like) to\s+)?(create|add|define|make|start|register|new)\s+(?:a\s+|an\s+)?(?:new\s+)?(feature)\b\s*(?:called|named|titled|:)?\s*([\s\S]*)$/i,
    (m) => ({ kind: 'create', ...createClauses(m[3]) })],
  // Attach a PR or issue to a step (or ramp condition): this is what moves a step's status.
  [new RegExp(`\\b(?:attach|link|add|connect)\\s+(?:the\\s+)?(pr|pull request|issue)\\s+#?(\\d+)(?:\\s+(?:in|of|from)\\s+([\\w.-]+/[\\w.-]+))?\\s+(?:to|with)\\s+(?:the\\s+)?(step|ramp condition|condition)\\s+["“]?(.+?)["”]?(?:\\s+${OF}\\s+(.+))?$`, 'i'),
    (m) => ({ kind: 'edit', of: m[6] && mentionOf(m[6]), change: { type: 'attach', list: /cond/i.test(m[4]) ? 'ramp_conditions' : 'steps', step: mentionOf(m[5]), evidence: { source: 'github', type: /issue/i.test(m[1]) ? 'issue' : 'pr', repo: m[3] || '', number: Number(m[2]) } } })],
  // Step / ramp-condition fields: "set the owner of step development of redeem rewards to @bo".
  [new RegExp(`\\b(?:set|change|make|update|rename)\\s+(?:the\\s+)?(owner|done[ _]?when|name|team)\\s+(?:of|for|on)\\s+(?:the\\s+)?(step|ramp condition|condition)\\s+["“]?(.+?)["”]?(?:\\s+${OF}\\s+(.+?))?\\s+(?:to|as|=)\\s*([\\s\\S]*)$`, 'i'),
    (m) => ({ kind: 'edit', of: m[4] && mentionOf(m[4]), change: { type: 'step_field', list: /cond/i.test(m[2]) ? 'ramp_conditions' : 'steps', step: mentionOf(m[3]), field: STEP_FIELD[m[1].toLowerCase().replace(/[ _]/g, ' ').replace('donewhen', 'done when')] || 'owner', value: value(m[5]) } })],
  [new RegExp(`\\b(?:clear|remove|empty)\\s+(?:the\\s+)?(owner|done[ _]?when|team)\\s+(?:of|for|on)\\s+(?:the\\s+)?(step|ramp condition|condition)\\s+["“]?(.+?)["”]?(?:\\s+${OF}\\s+(.+))?$`, 'i'),
    (m) => ({ kind: 'edit', of: m[4] && mentionOf(m[4]), change: { type: 'step_field', list: /cond/i.test(m[2]) ? 'ramp_conditions' : 'steps', step: mentionOf(m[3]), field: STEP_FIELD[m[1].toLowerCase().replace(/[ _]/g, ' ')] || 'owner', value: '' } })],
  // Add / remove a step or ramp condition.
  [/\badd\s+(?:a\s+|an\s+)?(?:new\s+)?(step|ramp condition|condition)\s+["“]?(.+?)["”]?(?:\s+(?:to|on|for)\s+(.+?))?(?:,?\s+owned by\s+(.+?))?(?:,?\s+done when\s+(.+))?$/i,
    (m) => ({ kind: 'edit', of: m[3] && mentionOf(m[3]), change: { type: 'add_step', list: /cond/i.test(m[1]) ? 'ramp_conditions' : 'steps', name: value(m[2]), owner: value(m[4]), done_when: value(m[5]) } })],
  [/\b(?:remove|delete|drop)\s+(?:the\s+)?(step|ramp condition|condition)\s+["“]?(.+?)["”]?(?:\s+(?:from|of|on|in)\s+(.+))?$/i,
    (m) => ({ kind: 'edit', of: m[3] && mentionOf(m[3]), change: { type: 'remove_step', list: /cond/i.test(m[1]) ? 'ramp_conditions' : 'steps', step: mentionOf(m[2]) } })],
  // Target date.
  [/\b(?:move|set|change|push|update|make|pull)\s+(?:the\s+)?target(?:\s+date)?\s+(?:(?:of|for|on)\s+(.+?)\s+)?(?:to|=|as|for)\s+(\S+)/i,
    (m) => ({ kind: 'edit', of: m[1] && mentionOf(m[1]), change: { type: 'field', field: 'target_date', value: value(m[2]) } })],
  [/\b(?:move|push|pull)\s+(.+?)(?:'s)?\s+target(?:\s+date)?\s+to\s+(\S+)/i,
    (m) => ({ kind: 'edit', of: mentionOf(m[1]), change: { type: 'field', field: 'target_date', value: value(m[2]) } })],
  [/\b(?:clear|remove)\s+(?:the\s+)?target(?:\s+date)?(?:\s+(?:of|for|on)\s+(.+))?$/i,
    (m) => ({ kind: 'edit', of: m[1] && mentionOf(m[1]), change: { type: 'field', field: 'target_date', value: '' } })],
  // Feature fields.
  [/\brename\s+(.+?)\s+(?:to|as)\s+([\s\S]+)$/i, (m) => ({ kind: 'edit', of: mentionOf(m[1]), change: { type: 'field', field: 'name', value: value(m[2]) } })],
  [/\b(?:set|change|make|update)\s+(?:the\s+)?(owner|name|description|project)\s+(?:(?:of|for|on)\s+(.+?)\s+)?(?:to|as|=)\s*([\s\S]*)$/i,
    (m) => ({ kind: 'edit', of: m[2] && mentionOf(m[2]), change: { type: 'field', field: m[1].toLowerCase(), value: value(m[3]) } })],
  [/\b(?:clear|remove)\s+(?:the\s+)?(description|project)(?:\s+(?:of|for|on|from)\s+(.+))?$/i,
    (m) => ({ kind: 'edit', of: m[2] && mentionOf(m[2]), change: { type: 'field', field: m[1].toLowerCase(), value: '' } })],
  [/\bmove\s+(.+?)\s+(?:in)?to\s+(?:the\s+)?project\s+(\S+)/i, (m) => ({ kind: 'edit', of: mentionOf(m[1]), change: { type: 'field', field: 'project', value: value(m[2]) } })],
  // Lists: dependencies, services, flags.
  [/\b(?:add|set)\s+(?:a\s+)?(?:dependency|dependencies)\s+(?:on\s+)?(.+?)\s+(?:to|for|on)\s+(.+)$/i,
    (m) => ({ kind: 'edit', of: mentionOf(m[2]), change: { type: 'list', field: 'depends_on', add: splitList(m[1]) } })],
  [/\b(?:remove|drop|delete)\s+(?:the\s+)?(?:dependency|dependencies)\s+(?:on\s+)?(.+?)(?:\s+(?:from|of|on)\s+(.+))?$/i,
    (m) => ({ kind: 'edit', of: m[2] && mentionOf(m[2]), change: { type: 'list', field: 'depends_on', remove: splitList(m[1]) } })],
  [/^\s*(?:make\s+)?(.+?)\s+(?:no longer|doesn'?t|does not|shouldn'?t)\s+depends?\s+on\s+(.+)$/i,
    (m) => ({ kind: 'edit', of: mentionOf(m[1]), change: { type: 'list', field: 'depends_on', remove: splitList(m[2]) } })],
  [/^\s*(?:make\s+)?(.+?)\s+(?:also\s+)?(?:should\s+)?depends?\s+on\s+(.+)$/i,
    (m) => ({ kind: 'edit', of: mentionOf(m[1]), change: { type: 'list', field: 'depends_on', add: splitList(m[2]) } })],
  [/\b(add|remove|drop|delete)\s+(?:the\s+)?(service|flag)s?\s+(.+?)(?:\s+(?:to|from|on|for)\s+(.+))?$/i,
    (m) => ({ kind: 'edit', of: m[4] && mentionOf(m[4]), change: { type: 'list', field: m[2].toLowerCase() === 'flag' ? 'flags' : 'services', [/add/i.test(m[1]) ? 'add' : 'remove']: splitList(m[3]).map((x) => x.replace(/^`|`$/g, '')) } })],
  // Delete a feature.
  [/^\s*(?:please\s+)?(?:(?:can|could) you\s+)?(?:delete|remove|drop)\s+(?:the\s+)?(?:feature)?\s*(.+)$/i, (m) => ({ kind: 'delete', of: mentionOf(m[1]) })],
  // "Edit redeem rewards": which field?
  [/^\s*(?:i want to\s+)?(?:edit|change|modify|update)\s+(?:the\s+)?(?:feature\s+|definition of\s+)?(.+)$/i, (m) => ({ kind: 'edit', of: mentionOf(m[1]), change: null })],
];

function statusTarget(q) {
  const step = q.match(/\b(?:step|condition)\s+["“]?([\w-]+(?:\s[\w-]+)?)["”]?/i)?.[1];
  const of = q.match(new RegExp(`\\b(?:step|condition)\\s+["“]?[\\w -]+?["”]?\\s+${OF}\\s+(.+?)(?:\\s+(?:as|to)\\b|$)`, 'i'))?.[1]
    || q.match(/\bstatus\s+(?:of|for|on)\s+(.+?)(?:\s+to\b|$)/i)?.[1];
  return { step: step ? step.replace(/\s+(?:as|of|for|on|in|to)$/i, '').trim() : null, of: of ? mentionOf(of) : null };
}

// "Bonus points on reviews, owned by @ana, depends on redeem rewards, in project x, due 2027-03-01".
function createClauses(rest) {
  const text = String(rest || '').trim();
  const quoted = text.match(/^["“']([^"”']+)["”']/);
  const STOP = /\s*(?:,|;|\s+(?:owned by|owner is|owner:|that depends on|which depends on|depending on|depends on|in (?:the )?project|due|with target|targeting|target(?:ed)?(?: date)?|by \d{4}-)\b)/i;
  const name = quoted ? quoted[1].trim() : value(text.split(STOP)[0]);
  const tail = quoted ? text.slice(quoted[0].length) : text.slice(text.split(STOP)[0].length);
  const owner = tail.match(/\bown(?:ed by|er is|er:)\s*(@?[^,;]+?)\s*(?=,|;|$|\s+(?:and\s+)?(?:that\s+|which\s+)?(?:depend|in (?:the )?project|due|target))/i)?.[1];
  const deps = tail.match(/\bdepend(?:s|ing)?\s+on\s+([\s\S]+?)\s*(?=;|$|,\s*(?:and\s+)?(?:own|in (?:the )?project|due|target|with)|\s+(?:due|target|in (?:the )?project)\b)/i)?.[1];
  const project = tail.match(/\bin (?:the )?project\s+["“]?([\w-]+)/i)?.[1];
  const date = tail.match(/\b(?:due|target(?:ed)?(?: date)?|targeting|by)\s*(?:on|is|of|:)?\s*(\d{4}-\d{2}-\d{2})/i)?.[1];
  return { name, owner: owner ? value(owner) : '', deps: deps ? splitList(deps) : [], project: project || '', target_date: date || '' };
}

export function parseChange(question) {
  const q = String(question || '').trim();
  for (const [re, build] of RULES) {
    const m = q.match(re);
    if (m) return build(m, q);
  }
  return null;
}

// Whether a message is a question rather than a request (so "Is X done?" is never a change).
const QUESTION = /^\s*(?:how|what|who|whom|when|why|is|are|does|do|did|can users|could we|which|where|tell me)\b/i;

// ---------------------------------------------------------------------------------------------

export function createChangeHandler({ app, review }) {
  const reviews = new Map();
  async function reviewOnce(built, defs) {
    const key = textHash(built.text);
    if (reviews.has(key)) return reviews.get(key);
    const r = await review(built, defs);
    if (r.ran) {
      if (reviews.size > 50) reviews.delete(reviews.keys().next().value);
      reviews.set(key, r);
    }
    return r;
  }

  const all = (defs) => defs.featureDefs;
  const findDef = (defs, id) => all(defs).find((f) => f.id === id) || null;
  const list = (defs) => all(defs).map((f) => ({ id: f.id, name: f.name }));

  // One reply. Text is the plain-words message; the rest lets the app and markdown show the proposal.
  function reply(session, question, outcome, text, extra = {}) {
    return {
      schema: CHANGE_SCHEMA, kind: 'change', session: session.id, question, asked_at: new Date().toISOString(),
      outcome, text, feature: extra.feature || null, ask: null, proposal: null, can_confirm: false, offers: [], result: null,
      // Same envelope as an answer, so history and older renderers still show something sensible.
      lead: { text, cites: [], by: 'rules' }, sections: [], freshness: [], blockers: [], intent: 'change',
      provider: { name: 'rules', model: null, used: false, note: null },
      ...extra,
    };
  }

  // Which feature do these words mean? { feature } or a reply asking which one.
  function resolve(session, question, words, defs) {
    const mention = words || session.focus && findDef(defs, session.focus)?.name;
    if (!mention) return { ask: reply(session, question, 'clarify', 'Which feature do you mean?', { candidates: list(defs) }) };
    const r = resolveFeature(mention, list(defs));
    if (r.kind === 'match') return { feature: findDef(defs, r.feature.id) };
    if (r.kind === 'ambiguous') return { ask: reply(session, question, 'clarify', `Which feature do you mean by "${mention}"? Closest: ${r.candidates.map((c) => c.name).join('; ')}.`, { candidates: r.candidates }) };
    return { ask: reply(session, question, 'unknown_feature', `I don't have a feature called "${mention}".${r.closest.length ? ` Closest: ${r.closest.map((c) => c.name).join('; ')}.` : ''}`, { candidates: r.closest, defined_features: list(defs) }) };
  }

  const findStep = (steps, words) => {
    const w = normalize(words);
    return steps.findIndex((s) => s.id === words || normalize(s.id) === w || normalize(s.name) === w);
  };
  const findStepLoose = (steps, words) => {
    const exact = findStep(steps, words);
    if (exact >= 0) return exact;
    const w = normalize(words);
    const hits = steps.map((s, i) => [s, i]).filter(([s]) => normalize(s.name).startsWith(w) || normalize(s.id).startsWith(w));
    return hits.length === 1 ? hits[0][1] : -1;
  };

  // Applies one parsed change to a draft. Returns null, or { error } / { ask } in plain words.
  function applyChange(draft, change, defs, action) {
    if (change.type === 'field') {
      if (change.field === 'target_date' && change.value && !DATE.test(change.value)) return { error: `The target date must be a date as YYYY-MM-DD (target_date); "${change.value}" isn't.` };
      if (change.field === 'project') { draft.project = slug(change.value) || ''; return null; }
      draft[change.field] = change.value;
      return null;
    }
    if (change.type === 'list') {
      let add = change.add || [];
      let remove = change.remove || [];
      if (change.field === 'depends_on') {
        const ids = (names, keepUnknown) => names.map((n) => {
          const r = resolveFeature(n, list(defs));
          return r.kind === 'match' ? r.feature.id : keepUnknown ? slug(n) : null;
        });
        const unknown = add.filter((n, i) => !ids([n])[0] && i >= 0);
        if (unknown.length) return { error: `I don't have a feature called "${unknown.join('", "')}" to depend on (depends_on).` };
        add = ids(add);
        remove = ids(remove, true);
      }
      draft[change.field] = [...new Set([...(draft[change.field] || []).filter((x) => !remove.includes(x)), ...add])];
      return null;
    }
    if (!draft[change.list]) draft[change.list] = [];
    const steps = draft[change.list];
    const noun = change.list === 'steps' ? 'step' : 'ramp condition';
    if (change.type === 'add_step') {
      if (!change.name) return { error: `The new ${noun} needs a name.` };
      const step = { id: slug(change.name), name: change.name, owner: change.owner, team: '', done_when: change.done_when };
      if (findStep(steps, step.id) >= 0) return { error: `"${change.name}" is already a ${noun} of this feature.` };
      steps.push(step);
      action.added = [...(action.added || []), `${change.list}:${step.id}`];
      return null;
    }
    const at = findStepLoose(steps, change.step);
    if (at < 0) return { error: `There is no ${noun} "${change.step}" on this feature. ${steps.length ? `Its ${noun}s: ${steps.map((s) => s.name).join(', ')}.` : `It has no ${noun}s.`}` };
    if (change.type === 'remove_step') { steps.splice(at, 1); return null; }
    if (change.type === 'step_field') { steps[at] = { ...steps[at], [change.field]: change.value }; return null; }
    if (change.type === 'attach') {
      const s = steps[at];
      let repo = change.evidence.repo;
      if (!repo) {
        const repos = [...new Set((action.baseFeature?.[change.list === 'steps' ? 'steps' : 'rampConditions'] || []).flatMap((x) => x.evidence.map((e) => e.repo)).filter(Boolean))];
        if (repos.length !== 1) return { error: `Which repository is ${change.evidence.type === 'issue' ? 'issue' : 'PR'} #${change.evidence.number} in? Say it as owner/name, e.g. "attach PR #${change.evidence.number} in team/app to step ${s.id}".` };
        repo = repos[0];
      }
      s.add_evidence = [...(s.add_evidence || []), { ...change.evidence, repo }];
      return null;
    }
    return null;
  }

  // What a valid definition still needs, as the next single question (create, or steps added here).
  function nextQuestion(action, defs, me) {
    const d = action.draft;
    const depOwners = d.depends_on.map((id) => findDef(defs, id)?.owner).filter(Boolean);
    if (!d.owner) return { field: 'owner', label: 'Owner', text: `Who owns ${d.name}? (owner)`, suggestion: depOwners[0] || me || null };
    if (action.op === 'create' && !d.steps.length && !(d.ramp_conditions || []).length) {
      return { field: 'steps[0].name', label: 'First step', text: `What is the first step of ${d.name}? A feature needs at least one step, each with an owner and "done when". (steps[0].name)`, suggestion: 'Development' };
    }
    for (const key of ['steps', 'ramp_conditions']) {
      for (const [i, s] of (d[key] || []).entries()) {
        const mine = action.op === 'create' || (action.added || []).includes(`${key}:${s.id}`);
        if (!mine) continue;
        const noun = key === 'steps' ? 'step' : 'ramp condition';
        if (!s.owner) return { field: `${key}[${i}].owner`, label: `Owner of ${noun} "${s.name}"`, text: `Who owns the ${noun} "${s.name}"? (${key}[${i}].owner)`, suggestion: d.owner || null };
        if (!s.done_when) return { field: `${key}[${i}].done_when`, label: `"Done when" of ${noun} "${s.name}"`, text: `When is the ${noun} "${s.name}" done? Say it so a PR or issue can show it. (${key}[${i}].done_when)`,
          suggestion: /develop/i.test(s.name) ? 'Merged to main with tests' : /release/i.test(s.name) ? 'A versioned release containing the change is published' : null };
      }
    }
    return null;
  }

  function setAnswer(draft, field, answer) {
    const m = field.match(/^(steps|ramp_conditions)\[(\d+)\]\.(\w+)$/);
    if (!m) { draft[field] = answer; return; }
    const listKey = m[1];
    const i = Number(m[2]);
    if (!draft[listKey][i]) draft[listKey][i] = { id: slug(answer), name: answer, owner: '', team: '', done_when: '' };
    else draft[listKey][i] = { ...draft[listKey][i], [m[3]]: answer, ...(m[3] === 'name' ? { id: slug(answer) } : {}) };
  }

  // Values the chat can propose for a new feature, from what it depends on.
  function suggestionsFor(d, defs) {
    const deps = d.depends_on.map((id) => findDef(defs, id)).filter(Boolean);
    const out = [];
    if (!d.project) {
      const projects = [...new Set(deps.map((f) => f.project).filter(Boolean))];
      if (projects.length === 1) out.push({ field: 'project', value: projects[0], why: `the project of ${deps.find((f) => f.project === projects[0]).name}` });
    }
    if (!d.services.length) {
      const services = [...new Set(deps.flatMap((f) => f.services))];
      if (services.length) out.push({ field: 'services', value: services, why: 'the services its dependencies touch' });
    }
    if (!d.flags.length && d.id) out.push({ field: 'flags', value: [d.id.replace(/-/g, '_')], why: 'a flag named after the feature, if it ships behind one' });
    if (!d.target_date) {
      const dates = deps.map((f) => f.targetDate).filter(Boolean).sort();
      if (dates.length) {
        const after = new Date(Date.parse(dates.at(-1)) + 30 * 86400000).toISOString().slice(0, 10);
        out.push({ field: 'target_date', value: after, why: `30 days after its latest dependency's target date (${dates.at(-1)})` });
      }
    }
    if (!d.depends_on.length && d.name) {
      const r = resolveFeature(d.name, list(defs));
      const near = r.kind === 'ambiguous' ? r.candidates : r.kind === 'unknown' ? r.closest : [];
      if (near.length) out.push({ field: 'depends_on', value: near.slice(0, 2).map((f) => f.id), why: 'features with a similar name, if it builds on them' });
    }
    return out;
  }

  // Builds the preview (validation + AI product review) for the open action and sets its step.
  async function preview(session, question, action, defs, note = '') {
    const feature = { id: action.op === 'create' ? action.draft.id : action.id, name: action.draft?.name || action.name };
    if (action.op === 'delete') {
      const base = findDef(defs, action.id);
      if (!base) { session.action = null; return reply(session, question, 'not_found', `${action.name} isn't defined any more, so there is nothing to delete.`); }
      const dependents = dependentsOf(base.id, defs.featureDefs);
      action.step = 'confirm';
      action.dependents = dependents;
      const text = `${note}Delete ${base.name} (${base.file})? This removes the file from the shared repo in one commit.${dependents.length
        ? ` ${dependents.map((x) => x.name).join(', ')} ${dependents.length === 1 ? 'depends' : 'depend'} on it and would be left with an unknown dependency; you'll be asked to confirm twice.` : ''} Say "yes" to delete it or "no" to keep it.`;
      return reply(session, question, 'preview', text, { feature: { id: base.id, name: base.name }, can_confirm: true,
        proposal: { op: 'delete', id: base.id, name: base.name, path: base.file, dependents, diff: [], errors: [], review: null } });
    }
    const base = action.op === 'create' ? null : findDef(defs, action.id);
    if (action.op !== 'create' && !base) { session.action = null; return reply(session, question, 'not_found', `${action.name} isn't defined any more.`); }
    const built = buildFeatureFile({ draft: action.draft, mode: action.op === 'create' ? 'create' : 'update', base: base ? { text: defs.files.get(base.file), feature: base } : null,
      features: defs.featureDefs, invalidIds: defs.invalidIds, projects: defs.projectDefs });
    const stale = Boolean(base && action.base_hash && textHash(defs.files.get(base.file)) !== action.base_hash);
    const proposal = { op: action.op, id: feature.id, name: action.draft.name, path: built.path || (base?.file ?? `features/${feature.id}.yaml`),
      text: action.op === 'create' ? built.text || null : null, draft: action.draft, diff: built.diff || [], errors: built.errors, review: null, stale,
      suggestions: action.op === 'create' ? suggestionsFor(action.draft, defs) : [] };
    if (built.errors.length) {
      action.step = 'fix';
      const named = built.errors.map((e) => `${fieldLabel(e.field, action.draft)} ${e.message}`);
      const at = built.errors.map((e) => e.field.match(/^(steps|ramp_conditions)\[(\d+)\]\.(owner|done_when|name)/)).find(Boolean);
      const example = at ? `set the ${at[3] === 'done_when' ? 'done when' : at[3]} of ${at[1] === 'steps' ? 'step' : 'ramp condition'} ${action.draft[at[1]][Number(at[2])]?.id} to …` : 'set the owner to @someone';
      return reply(session, question, 'invalid', `${note}Can't save this yet: ${named.join('; ')}. Tell me the fix (e.g. "${example}"), or "cancel".`,
        { feature, proposal });
    }
    if (action.op !== 'create' && !built.diff.length) {
      action.step = 'fix';
      return reply(session, question, 'no_change', `${note}That doesn't change anything in ${base.name}'s definition, so there is nothing to save.`, { feature, proposal });
    }
    proposal.review = await reviewOnce(built, defs);
    if (proposal.review.blocking) {
      action.step = 'fix';
      const named = proposal.review.findings.filter((f) => f.kind === 'contradiction').map((f) => `${fieldLabel(f.field, action.draft)}: ${f.message}${f.suggestion ? ` (${f.suggestion})` : ''}`);
      return reply(session, question, 'invalid', `${note}Can't save this yet: the AI product review found contradictions. ${named.join(' ')} Tell me the fix, or "cancel".`, { feature, proposal });
    }
    action.step = 'confirm';
    const what = action.op === 'create'
      ? `Here is the new feature "${action.draft.name}", saved as ${built.path} (id ${built.feature.id}).`
      : `Here is what changes in ${base.name} (${base.file}); nothing else in the file is touched.`;
    const ideas = proposal.suggestions.length ? ` Suggestions: ${proposal.suggestions.map((s) => `${FIELD_LABEL[s.field].toLowerCase()} ${Array.isArray(s.value) ? s.value.join(', ') : s.value} (${s.why})`).join('; ')}. Say "use the suggestions" to add them.` : '';
    const reviewNote = proposal.review.ran ? (proposal.review.findings.length ? ` The AI product review has ${proposal.review.findings.length} suggestion${proposal.review.findings.length === 1 ? '' : 's'}.` : ' The AI product review found no problems.') : ` ${proposal.review.note}`;
    const staleNote = stale ? ' Note: this feature changed in the shared repo after we started; saving will be refused and your edit kept on this machine.' : '';
    return reply(session, question, 'preview', `${note}${what} It passes validation.${reviewNote}${ideas}${staleNote} Save it? Say "yes" to commit it as you, or "no" to drop it.`,
      { feature, proposal, can_confirm: true });
  }

  // Starts an action (create / update / delete) after checking this person may write.
  async function start(session, question, parsed, defs, access) {
    if (!access.can_edit) {
      return reply(session, question, 'read_only', `I can't change feature definitions for you: ${access.reason} You can still ask me anything about the features.`, { access });
    }
    if (parsed.kind === 'create') {
      const name = parsed.name;
      if (!name) {
        session.action = { kind: 'feature', op: 'create', step: 'ask', draft: emptyDraft('', parsed), ask: { field: 'name', label: 'Name', text: 'What should the feature be called? Give the exact name you want.' } };
        return askReply(session, question, defs);
      }
      const draft = emptyDraft(name, parsed);
      const unknownDeps = [];
      for (const n of parsed.deps) {
        const r = resolveFeature(n, list(defs));
        if (r.kind === 'match') draft.depends_on.push(r.feature.id); else unknownDeps.push(n);
      }
      session.action = { kind: 'feature', op: 'create', step: 'ask', draft };
      const note = unknownDeps.length ? `I don't have a feature called "${unknownDeps.join('", "')}", so I left it out of depends_on. ` : '';
      return await nameCheck(session, question, defs, note);
    }
    const r = resolve(session, question, parsed.of, defs);
    if (r.ask) { if (r.ask.candidates?.length) session.clarify = parsed; return r.ask; }
    const f = r.feature;
    session.focus = f.id;
    const base_hash = textHash(defs.files.get(f.file));
    if (parsed.kind === 'delete') {
      session.action = { kind: 'feature', op: 'delete', id: f.id, name: f.name, base_hash };
      return preview(session, question, session.action, defs);
    }
    // update
    session.action = { kind: 'feature', op: 'update', id: f.id, name: f.name, base_hash, draft: toDraft(f), baseFeature: f };
    if (!parsed.change) {
      session.action.step = 'fix';
      return reply(session, question, 'ask_change', `What should change in ${f.name}? You can change its name, owner, description, project, target date, steps, dependencies, services, flags or ramp conditions — e.g. "move the target date to 2027-02-15" or "add step QA, owned by @qa, done when signed off".`,
        { feature: { id: f.id, name: f.name } });
    }
    return change(session, question, parsed.change, defs);
  }

  function emptyDraft(name, parsed) {
    return { id: slug(name), name, owner: parsed.owner || '', description: '', project: parsed.project ? slug(parsed.project) : '', target_date: parsed.target_date || '',
      depends_on: [], services: [], flags: [], steps: [], ramp_conditions: [] };
  }

  // A name already taken, or very close to an existing feature: did they mean that one?
  async function nameCheck(session, question, defs, note = '') {
    const a = session.action;
    const d = a.draft;
    const taken = findDef(defs, d.id) || all(defs).find((f) => normalize(f.name) === normalize(d.name));
    if (taken) {
      a.step = 'name';
      a.candidate = taken.id;
      return reply(session, question, 'name_taken', `${note}The name "${d.name}" ${taken.id === d.id ? `(id ${d.id}) ` : ''}is already taken by the feature ${taken.name}. Did you mean that one? Say "yes" to change ${taken.name} instead, or give the new feature a different name.`,
        { feature: { id: taken.id, name: taken.name }, candidates: [{ id: taken.id, name: taken.name }] });
    }
    const r = resolveFeature(d.name, list(defs));
    const close = r.kind === 'match' ? [r.feature] : r.kind === 'ambiguous' ? r.candidates : [];
    if (close.length && !a.nameChecked) {
      a.step = 'name';
      a.candidate = close.length === 1 ? close[0].id : null;
      return reply(session, question, 'name_close', `${note}"${d.name}" is very close to ${close.map((c) => c.name).join(', ')}. Did you mean ${close.length === 1 ? 'that one' : 'one of those'}? Say "no" to create "${d.name}" as a new feature (id ${d.id}), or name the existing one you meant.`,
        { candidates: close });
    }
    a.nameChecked = true;
    return askReply(session, question, defs, `${note}New feature "${d.name}", id ${d.id} (saved as features/${d.id}.yaml). `);
  }

  // Asks the next missing field, or shows the preview when nothing is missing.
  async function askReply(session, question, defs, note = '') {
    const a = session.action;
    const currentMe = me || (me = await app.publisher.whoAmI().catch(() => null));
    const next = a.ask?.field === 'name' && !a.draft.name ? a.ask : nextQuestion(a, defs, currentMe);
    if (!next) { a.ask = null; return preview(session, question, a, defs, note); }
    a.step = 'ask';
    a.ask = next;
    return reply(session, question, 'ask_field', `${note}${next.text}${next.suggestion ? ` Suggested: ${next.suggestion} (say "yes" to use it).` : ''}`,
      { feature: a.draft.id ? { id: a.draft.id, name: a.draft.name } : null, ask: next, proposal: { op: a.op, id: a.draft.id, name: a.draft.name, draft: a.draft, diff: [], errors: [], review: null } });
  }

  async function change(session, question, ch, defs) {
    const a = session.action;
    const problem = applyChange(a.draft, ch, defs, a);
    if (problem?.error) {
      a.step = a.step === 'confirm' ? 'fix' : a.step || 'fix';
      return reply(session, question, 'invalid', problem.error, { feature: { id: a.id || a.draft.id, name: a.draft.name } });
    }
    return askReply(session, question, defs);
  }

  // Saving, after the explicit yes: the form's own publish path, tagged as coming from the chat.
  async function commit(session, question, a) {
    await app.refresh();
    const defs = await app.definitionsNow();
    const access = await app.featurePublisher.access();
    if (!access.can_edit) { session.action = null; return reply(session, question, 'read_only', `Nothing was saved: ${access.reason}`, { access }); }
    const op = a.op;
    const r = await app.featurePublisher.submit({ op, id: op === 'create' ? null : a.id, draft: a.draft || null, base_hash: a.base_hash || null,
      confirm_dependents: a.op === 'delete' && a.dependentsConfirmed === true, via: 'chat' }, { defs, files: defs.files, review: (built) => reviewOnce(built, defs) });
    const feature = { id: r.id || a.id || a.draft?.id, name: a.draft?.name || a.name };
    if (r.outcome === 'has_dependents') {
      a.step = 'confirm_again';
      a.dependents = r.dependents;
      return reply(session, question, 'has_dependents', `${r.message} Say "yes, delete it" to confirm a second time, or "no".`, { feature, can_confirm: true,
        proposal: { op: 'delete', id: a.id, name: a.name, dependents: r.dependents, diff: [], errors: [], review: null } });
    }
    if (r.outcome === 'invalid') {
      a.step = 'fix';
      const named = (r.errors || []).map((e) => `${fieldLabel(e.field, a.draft)} ${e.message}`);
      return reply(session, question, 'invalid', `Nothing was saved. ${r.message}${named.length ? ` ${named.join('; ')}.` : ''}`, { feature, result: r });
    }
    session.action = null;
    if (r.outcome === 'published') {
      await app.refresh();
      const did = { create: 'Created', update: 'Saved', delete: 'Deleted' }[a.op];
      return reply(session, question, 'saved', `${did} ${feature.name}. ${r.message}`, { feature, result: r });
    }
    if (r.outcome === 'conflict') return reply(session, question, 'conflict', `${r.message} Your change is kept on this machine (Features → kept edits).`, { feature, result: r });
    if (r.outcome === 'not_found') return reply(session, question, 'not_found', r.message, { feature, result: r });
    // queued / not_published: kept locally, exactly like the form.
    return reply(session, question, 'not_saved_yet', `Not saved yet. ${r.message.replace(/^Not published yet:\s*/, '')}`, { feature, result: r });
  }

  const LIVE = 'Status in LifeCycle is never typed in: it is read live from its sources, so a step is done when the PRs or issues linked to it are merged or closed, and the last mile comes from deploys and flags.';
  const repoOf = (f) => [...new Set([...f.steps, ...f.rampConditions].flatMap((s) => s.evidence.map((e) => e.repo)).filter(Boolean))][0] || 'owner/repo';

  // "Mark step development as done": status is live. Explain, then offer what changes it.
  async function statusLive(session, question, parsed, defs, access) {
    let f = null;
    if (parsed.of) {
      const r = resolve(session, question, parsed.of, defs);
      if (r.ask) { if (r.ask.candidates?.length) session.clarify = parsed; return r.ask; }
      f = r.feature;
    } else if (parsed.step) {
      const owners = all(defs).filter((x) => findStepLoose([...x.steps, ...x.rampConditions].map((s) => ({ id: s.id, name: s.name })), parsed.step) >= 0);
      const focused = owners.find((x) => x.id === session.focus);
      f = focused || (owners.length === 1 ? owners[0] : null);
      if (!f && owners.length > 1) {
        session.clarify = parsed;
        const offers = owners.slice(0, 3).map((x) => `attach PR #<number> in ${repoOf(x)} to step ${x.steps[findStepLoose(x.steps, parsed.step)]?.id || parsed.step} of ${x.name}`);
        return reply(session, question, 'status_is_live', `${LIVE} Several features have a step "${parsed.step}": ${owners.map((x) => x.name).join('; ')}. Which one do you mean? ${access.can_edit ? 'I can attach a PR or issue to that step, add a ramp condition, or you can register a change (Changes → Register a change).' : `Changing what's linked needs write access to the shared repo: ${access.reason}`}`,
          { candidates: owners.map((x) => ({ id: x.id, name: x.name })), offers: access.can_edit ? offers : [] });
      }
    } else if (session.focus) f = findDef(defs, session.focus);
    const lead = LIVE;
    if (!f) return reply(session, question, 'status_is_live', `${lead} Tell me which feature and step you mean, and I can attach a PR or issue to that step.`);
    session.focus = f.id;
    const steps = f.steps;
    const at = parsed.step ? findStepLoose(steps, parsed.step) : -1;
    const step = at >= 0 ? steps[at] : null;
    const repo = repoOf(f);
    const offers = [
      `attach PR #<number> in ${repo} to step ${step?.id || steps[0]?.id || '<step>'} of ${f.name}`,
      `attach issue #<number> in ${repo} to step ${step?.id || steps[0]?.id || '<step>'} of ${f.name}`,
      `add ramp condition <name> to ${f.name}`,
    ];
    const linked = step?.evidence?.length ? ` It already links ${step.evidence.map(evidenceShort).join(', ')}; it turns done when ${step.evidence.length === 1 ? 'that is' : 'those are'} merged or closed (a Jira ticket: Done or Closed).` : step ? ' It has no PR, issue or ticket linked yet, so LifeCycle can\'t see it done.' : '';
    const stepText = step ? ` Step "${step.name}" of ${f.name} is done when: ${step.doneWhen.trim().replace(/[.\s]+$/, '')}.${linked}` : '';
    const can = access.can_edit ? ` I can attach a PR or issue to ${step ? 'that step' : 'a step'} (say e.g. "${offers[0]}"), add a ramp condition, or you can register a change (Changes → Register a change).`
      : ` Changing what's linked needs write access to the shared repo: ${access.reason}`;
    return reply(session, question, 'status_is_live', `${lead}${stepText}${can}`, { feature: { id: f.id, name: f.name }, offers: access.can_edit ? offers : [], step: step ? { id: step.id, name: step.name } : null });
  }

  // message → reply, or null (not a change: answer it as a question).
  let me = null; // the person's GitHub user, suggested as an owner
  async function handle({ question, session: sessionId }) {
    const q = String(question || '').trim();
    const session = readSession(sessionId);
    const a = session.action;
    // Team commands ("create a team called …", "delete team catalog") belong to the teams flow
    // (src/ask/actions.js), unless they answer an open question here.
    if (isTeamCommand(q) && a?.step !== 'ask') return null;
    const parsed = QUESTION.test(q) && !/\bmark\b/i.test(q) ? null : parseChange(q);
    const done = (r) => { saveSession(session); return r; };

    if (a) {
      if (isNo(q) && !(a.step === 'name' && /^\s*no\b/i.test(q)) && !(a.step === 'ask' && /^\s*(?:no|nope|n)\s*[.!]*\s*$/i.test(q))) {
        session.action = null;
        return done(reply(session, q, 'declined', `OK, nothing was saved${a.op === 'delete' ? `: ${a.name} stays` : ''}. The shared repo is unchanged.`, { feature: a.id ? { id: a.id, name: a.name } : null }));
      }
      if (a.step === 'confirm' || a.step === 'confirm_again') {
        if (isYes(q)) {
          if (a.op === 'delete' && a.dependents?.length && a.step === 'confirm') {
            a.step = 'confirm_again';
            return done(reply(session, q, 'confirm_again', `${a.dependents.map((x) => x.name).join(', ')} ${a.dependents.length === 1 ? 'depends' : 'depend'} on ${a.name}. Deleting it leaves ${a.dependents.length === 1 ? 'that feature' : 'those features'} with an unknown dependency. Are you sure? Say "yes, delete it" a second time to delete it, or "no" to keep it.`,
              { feature: { id: a.id, name: a.name }, can_confirm: true, proposal: { op: 'delete', id: a.id, name: a.name, dependents: a.dependents, diff: [], errors: [], review: null } }));
          }
          if (a.op === 'delete' && a.step === 'confirm_again') a.dependentsConfirmed = true;
          return done(await commit(session, q, a));
        }
      }
      if (a.step === 'fix' && isYes(q)) {
        return done(reply(session, q, 'invalid', 'This can\'t be saved yet: fix the fields named above first, or say "cancel".', { feature: { id: a.id || a.draft?.id, name: a.name || a.draft?.name } }));
      }
      const defs = await defsNow();
      if (a.step === 'name') {
        if (isYes(q) && a.candidate) {
          const f = findDef(defs, a.candidate);
          session.action = null;
          session.focus = f?.id || null;
          return done(reply(session, q, 'ask_change', `OK, ${f?.name || a.candidate} then. What should change in it? (e.g. "move the target date to 2027-02-15")`, { feature: f ? { id: f.id, name: f.name } : null }));
        }
        if (/^\s*no\b/i.test(q)) { a.nameChecked = true; return done(await askReply(session, q, defs, `OK, a new feature "${a.draft.name}" (id ${a.draft.id}). `)); }
        const other = resolveFeature(q, list(defs));
        if (other.kind === 'match' && normalize(q) === normalize(other.feature.name)) {
          session.action = null;
          session.focus = other.feature.id;
          return done(reply(session, q, 'ask_change', `OK, ${other.feature.name} then. What should change in it?`, { feature: other.feature }));
        }
        // A different name.
        a.draft = { ...a.draft, name: value(q), id: slug(value(q)) };
        a.nameChecked = false;
        return done(await nameCheck(session, q, defs));
      }
      // A question in the middle ("How is X going?") is answered normally; the open question waits.
      if (a.step === 'ask' && QUESTION.test(q) && /\?\s*$/.test(q)) return null;
      if (a.step === 'ask' && a.ask && /^\s*(?:no|nope|n)\s*[.!]*\s*$/i.test(q)) {
        return done(reply(session, q, 'ask_field', `Then tell me the value. ${a.ask.text}`, { ask: { ...a.ask, suggestion: null } }));
      }
      if (a.step === 'ask' && a.ask && !(parsed && parsed.kind === 'edit' && parsed.change)) {
        const answer = SUGGESTED.test(q) && a.ask.suggestion ? a.ask.suggestion : value(q);
        if (!answer) return done(reply(session, q, 'ask_field', `${a.ask.label} (${a.ask.field}) can't be empty. ${a.ask.text}`, { ask: a.ask }));
        if (a.ask.field === 'name') {
          a.draft = { ...a.draft, name: answer, id: slug(answer) };
          a.ask = null;
          return done(await nameCheck(session, q, defs));
        }
        setAnswer(a.draft, a.ask.field, answer);
        return done(await askReply(session, q, defs));
      }
      if (USE_SUGGESTIONS.test(q) && a.op === 'create') {
        for (const s of suggestionsFor(a.draft, defs)) a.draft[s.field] = s.value;
        return done(await preview(session, q, a, defs, 'Suggestions added. '));
      }
      // A change to what's being proposed ("set the target date to 2027-03-01").
      if (parsed?.kind === 'edit' && parsed.change && a.draft && (!parsed.of || sameFeature(parsed.of, a, defs))) {
        return done(await change(session, q, parsed.change, defs));
      }
      if (parsed && parsed.kind !== 'edit') {
        // A new request replaces the open one (which was never saved).
        session.action = null;
      } else if (parsed?.kind === 'edit' && parsed.of) {
        session.action = null;
      } else if (isYes(q)) {
        return done(reply(session, q, 'invalid', 'There is nothing to confirm yet.'));
      } else {
        return null; // a question in the middle of a conversation: answered normally, the proposal waits
      }
    }

    // The answer to "Which feature do you mean?": carry on with the request it was about.
    const pendingClarify = session.clarify;
    session.clarify = null;
    if (!parsed && pendingClarify) {
      const defs = await defsNow();
      const r = resolveFeature(mentionOf(q), list(defs));
      if (r.kind === 'match') {
        const again = { ...pendingClarify, of: r.feature.name };
        const access = await app.featurePublisher.access();
        return done(again.kind === 'status' ? await statusLive(session, q, again, defs, access) : await start(session, q, again, defs, access));
      }
    }
    if (!parsed) {
      if (isNo(q) && session.id) return done(reply(session, q, 'nothing_to_confirm', 'OK. Nothing is waiting for your confirmation, and nothing was changed.'));
      if (isYes(q) && session.id) return done(reply(session, q, 'nothing_to_confirm', 'There is nothing waiting for your confirmation. Ask me to create, change or delete a feature first.'));
      return null;
    }
    const defs = await defsNow();
    const access = await app.featurePublisher.access();
    if (parsed.kind === 'status') return done(await statusLive(session, q, parsed, defs, access));
    return done(await start(session, q, parsed, defs, access));
  }

  function sameFeature(words, a, defs) {
    const r = resolveFeature(words, list(defs));
    if (r.kind === 'match') return r.feature.id === (a.id || a.draft?.id);
    return normalize(words) === normalize(a.draft?.name || a.name || '');
  }

  async function defsNow() {
    await app.refresh();
    return app.definitionsNow();
  }

  return { handle };
}
