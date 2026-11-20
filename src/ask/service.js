// One entry point for asking and for digests, shared by the local app (src/server.js) and the
// person's AI tools (src/mcp.js), so both give the same answers and behave the same way. Every
// question, answer and digest is kept on this machine (history.js) and logged without tokens.
import { answerQuestion, isPrdRequest, prdRefusal } from './answer.js';
import { createProvider } from './providers.js';
import { buildDigest, readDigestState, saveDigestState, readFollows, setFollow } from './digest.js';
import { saveHistory, logAsk, readHistory } from './history.js';
import { loadConfig } from '../config.js';
import { createChangeHandler } from './change.js';
import { reviewDefinition } from '../features/review.js';
import { createActions } from './actions.js';

// app: createApp(). configOverride lets tests pin a config; otherwise the local config is re-read
// on every question, so switching the provider in ~/.lifecycle/config.json applies immediately.
export function createAskService({ app, providerFor = createProvider, readConfig = null }) {
  const currentConfig = () => {
    const base = readConfig ? readConfig() : loadConfig();
    return { ...app.config, ai: base.ai, me: base.me, atRiskDays: base.atRiskDays ?? app.config.atRiskDays };
  };

  // Two chat flows that change data, both "the chat proposes, the person confirms": teams
  // (actions.js, one-shot commands confirmed with the action's id) and feature definitions
  // (change.js, a conversation that asks for what's missing, confirmed with a yes in the session).
  const actions = createActions({ app });
  const changes = createChangeHandler({
    app,
    review: (built, defs) => reviewDefinition({ provider: providerFor(currentConfig()), text: built.text, feature: built.feature, features: defs.featureDefs }),
  });

  // session: the conversation (the app page or the AI tool's connection), so a follow-up answer or
  // a "yes" belongs to the right pending change. Without one, the entry point's default conversation is used.
  async function ask(question, { via = 'app', session = null } = {}) {
    const started = Date.now();
    // Constraint: no PRD is ever created from Ask. Checked first, so the change flow never sees it.
    if (isPrdRequest(question)) {
      const refused = prdRefusal({ question });
      saveHistory('asks', { via, question: refused.question, answer: refused });
      logAsk({ kind: 'ask', via, feature: null, outcome: refused.outcome, intent: refused.intent, provider: 'rules', duration_ms: Date.now() - started });
      return refused;
    }
    if (app.featurePublisher) {
      const change = await changes.handle({ question, session: session || `${via}-default`, via });
      if (change) {
        saveHistory('asks', { via, question: change.question, answer: change });
        logAsk({ kind: 'change', via, feature: change.feature?.id || null, outcome: change.outcome, intent: 'change', provider: 'rules', duration_ms: Date.now() - started });
        return change;
      }
    }
    const config = currentConfig();
    // A change typed in the chat ("create a team called …"): a preview to confirm, never applied directly.
    const proposed = await actions.propose(question);
    if (proposed) {
      saveHistory('asks', { via, question: proposed.question, answer: proposed });
      logAsk({ kind: 'ask', via, feature: null, outcome: proposed.outcome, intent: proposed.intent, provider: 'rules', duration_ms: Date.now() - started });
      return proposed;
    }
    const snap = await app.refresh();
    const answer = await answerQuestion({ question, snap, config, provider: providerFor(config) });
    saveHistory('asks', { via, question: answer.question, answer });
    logAsk({ kind: 'ask', via, feature: answer.feature?.id || null,
      ...(answer.scope ? { project: answer.scope === 'projects' ? '*' : answer.project ? answer.project.id ?? 'none' : null } : {}),
      outcome: answer.outcome, intent: answer.intent,
      provider: answer.provider.used ? answer.provider.name : 'rules', duration_ms: Date.now() - started });
    return answer;
  }

  async function digest({ via = 'app' } = {}) {
    const started = Date.now();
    const config = currentConfig();
    const snap = await app.refresh();
    const { digest: d, nextState } = buildDigest({ snap, config, person: { owners: config.me?.owners || [], follows: readFollows() }, state: readDigestState() });
    saveDigestState(nextState);
    saveHistory('digests', { via, digest: d });
    logAsk({ kind: 'digest', via, feature: d.features.map((f) => f.id).join(',') || null, outcome: d.outcome, duration_ms: Date.now() - started });
    return d;
  }

  function lastDigest() {
    return readHistory('digests', 1)[0]?.digest || null;
  }

  return {
    ask,
    // Confirming or cancelling a change the chat proposed (src/ask/actions.js).
    confirmAction: (id, opts) => actions.confirm(id, opts),
    cancelAction: (id) => actions.cancel(id),
    digest,
    lastDigest,
    follows: readFollows,
    follow: (id, on) => setFollow(id, on),
    history: (limit) => readHistory('asks', limit).map((h) => h.answer),
    me: () => currentConfig().me,
    // The saved config as it is now (re-read each call), for settings that apply without a restart.
    savedConfig: () => (readConfig ? readConfig() : loadConfig()),
    // The AI provider as configured right now (also used for the product review of feature edits).
    currentProvider: () => providerFor(currentConfig()),
    provider: () => {
      const c = currentConfig();
      const p = providerFor(c);
      return { name: p.unknown ? `unknown (${p.unknown})` : p.name, model: p.model || null };
    },
  };
}
