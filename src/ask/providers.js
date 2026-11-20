// AI providers for ask & digest. Which one answers is set in the local config (`ai.provider`), so
// switching needs no code change. Keys are read from the environment or ~/.lifecycle/credentials.json,
// never from the shared repo, and never logged.
//
// A provider does two small jobs, both on top of LifeCycle's own data (answer.js):
//   interpret({ question, features }) -> { intent, mention }   which intent, which words name the feature
//   lead({ question, intent, feature, facts }) -> { text, cites }   1–2 sentences citing statement ids
// Everything else in an answer (statements, evidence, who to push) comes from the data, never the model.
//
// Providers:
//   claude             Anthropic API (default). Key: ANTHROPIC_API_KEY or `npm run setup`.
//   claude-code        Claude Code (`claude -p`) with the person's own Claude login: no API key. Runs with no
//                      tools or connectors (src/claude-run.js), since the prompt holds everything it needs.
//   openai-compatible  Any /chat/completions endpoint (Azure OpenAI, Ollama, LM Studio, a company gateway…).
//   command            A local CLI of your own that reads the prompt on stdin and prints JSON, e.g. ["claude", "-p"].
//   none               LifeCycle's rules only, no AI.
import { spawn } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';
import { aiKey } from '../config.js';
import { registerSecret } from '../log.js';
import { runClaude } from '../claude-run.js';
import { rulesInterpreter, INTENTS } from './answer.js';

export const PROVIDERS = ['claude', 'claude-code', 'openai-compatible', 'command', 'none'];
// What to do when a provider rejects its key (HTTP 401).
const KEY_REJECTED = (who) => `${who} rejected the API key (HTTP 401: wrong, revoked, or not an API key). Set a new one with \`lifecycle setup --extras\`, or use the AI provider "claude-code" (your Claude Code login, no key)`;
export const CLAUDE_DEFAULT_MODEL = 'claude-opus-5-5';

const INTERPRET_SYSTEM = [
  'You route questions about software features to LifeCycle, a feature status map.',
  'Return JSON only: {"intent": one of "status" | "blockers" | "availability" | "ramp" | "push" | "other", "mention": string}.',
  'status = how is it going / overall update. blockers = what is blocking it. availability = is it available / turned on / live for users.',
  'ramp = is it ready to ramp / safe to turn up for more users.',
  'push = who to push, nudge or ask. other = anything LifeCycle\'s status data cannot answer (budget, design, opinions…).',
  'mention = the words in the question that name the feature. If one feature in the list is clearly meant, return its exact id.',
  'If the name could fit several features, or none, return the words as written; never pick one at random. Empty string if no feature is named.',
].join('\n');

const LEAD_SYSTEM = [
  'You write the first line of an answer for a product manager, from numbered statements produced by LifeCycle.',
  'Use ONLY facts stated in the statements. Never add a status, date, number, name or reason that isn\'t in them.',
  'If the statements don\'t answer the question, say so. Mention data that is out of date if it matters.',
  'Return JSON only: {"text": "one or two short sentences", "cites": ["f1", ...]} where cites lists every statement id the text relies on.',
].join('\n');

const INTERPRET_SCHEMA = {
  type: 'object',
  properties: { intent: { type: 'string', enum: INTENTS }, mention: { type: 'string' } },
  required: ['intent', 'mention'],
  additionalProperties: false,
};
const LEAD_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' }, cites: { type: 'array', items: { type: 'string' } } },
  required: ['text', 'cites'],
  additionalProperties: false,
};

// Product review of a feature definition (src/features/review.js builds the system prompt from
// src/features/review-rules.md).
export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: { kind: { type: 'string', enum: ['contradiction', 'ambiguity'] }, field: { type: 'string' }, message: { type: 'string' }, suggestion: { type: 'string' } },
        required: ['kind', 'field', 'message', 'suggestion'],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
};

// Import from links (src/import/analyze.js): the proposed projects, features, steps and tasks.
export const IMPORT_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          level: { type: 'string', enum: ['project', 'feature', 'step', 'task'] },
          name: { type: 'string' },
          description: { type: 'string' },
          parent: { type: 'string' },
          owner: { type: 'string' },
          done_when: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
          sources: { type: 'array', items: { type: 'string' } },
          level_reason: { type: 'string' },
        },
        required: ['ref', 'level', 'name', 'description', 'parent', 'owner', 'done_when', 'evidence', 'sources', 'level_reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};
// An analysis reads many sources and writes a long answer: more room and time than a chat answer.
const ANALYZE = { maxTokens: 16000, minTimeoutMs: 180000 };

function interpretPrompt({ question, features }) {
  return `Defined features (id: name):\n${features.map((f) => `${f.id}: ${f.name}`).join('\n')}\n\nQuestion: ${question}`;
}

function leadPrompt({ question, intent, feature, facts, freshness }) {
  return [
    `Question: ${question}`,
    `Intent: ${intent}`,
    `Feature: ${feature.name} (${feature.id})`,
    'Statements:',
    ...facts.map((f) => `[${f.id}] ${f.text}`),
    ...(freshness?.length ? ['Out of date:', ...freshness.filter((x) => !x.info).map((x) => `- ${x.text}`)] : []),
  ].join('\n');
}

// Models sometimes wrap JSON in prose or code fences; take the first JSON object.
export function parseJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('the provider did not return JSON');
  return JSON.parse(s.slice(start, end + 1));
}

function claudeProvider(config) {
  const model = config.ai.model || CLAUDE_DEFAULT_MODEL;
  const key = aiKey('claude');
  registerSecret(key);
  let client = null;
  const getClient = () => {
    if (!key) throw new Error('no Claude API key is set up on this machine (set ANTHROPIC_API_KEY or run `npm run setup`)');
    client ||= new Anthropic({ apiKey: key, baseURL: config.ai.apiUrl || undefined, timeout: config.ai.timeoutMs, maxRetries: 1 });
    return client;
  };
  async function call(system, user, schema, { maxTokens = 4000, timeoutMs = null } = {}) {
    const res = await getClient().beta.messages.create({
      model,
      max_tokens: maxTokens,
      // If a safety classifier declines, Anthropic re-runs the request on its recommended fallback.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      system,
      messages: [{ role: 'user', content: user }],
    }, timeoutMs ? { timeout: timeoutMs } : undefined);
    if (res.stop_reason === 'refusal') throw new Error('Claude declined to answer');
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return parseJson(text);
  }
  const guarded = (system, user, schema, opts) => call(system, user, schema, opts).catch((err) => {
    if (err?.status === 401) throw new Error(KEY_REJECTED('Anthropic'));
    throw err;
  });
  return {
    name: 'claude',
    model,
    interpret: (input) => guarded(INTERPRET_SYSTEM, interpretPrompt(input), INTERPRET_SCHEMA),
    lead: (input) => guarded(LEAD_SYSTEM, leadPrompt(input), LEAD_SCHEMA),
    review: ({ system, prompt }) => guarded(system, prompt, REVIEW_SCHEMA),
    analyze: ({ system, prompt }) => guarded(system, prompt, IMPORT_SCHEMA, { maxTokens: ANALYZE.maxTokens, timeoutMs: Math.max(config.ai.timeoutMs || 0, ANALYZE.minTimeoutMs) }),
  };
}

function openAiCompatibleProvider(config, { fetchImpl = fetch } = {}) {
  const model = config.ai.model;
  const key = aiKey('openai-compatible');
  registerSecret(key);
  async function call(system, user, { timeoutMs = config.ai.timeoutMs } = {}) {
    if (!config.ai.apiUrl) throw new Error('ai.apiUrl is not set for the openai-compatible provider');
    if (!model) throw new Error('ai.model is not set for the openai-compatible provider');
    const res = await fetchImpl(`${config.ai.apiUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401) throw new Error(KEY_REJECTED('The AI provider'));
    if (!res.ok) throw new Error(`the provider answered HTTP ${res.status}`);
    const body = await res.json();
    return parseJson(body.choices?.[0]?.message?.content);
  }
  return {
    name: 'openai-compatible',
    model,
    interpret: (input) => call(INTERPRET_SYSTEM, interpretPrompt(input)),
    lead: (input) => call(LEAD_SYSTEM, leadPrompt(input)),
    review: ({ system, prompt }) => call(system, prompt),
    analyze: ({ system, prompt }) => call(system, prompt, { timeoutMs: Math.max(config.ai.timeoutMs || 0, ANALYZE.minTimeoutMs) }),
  };
}

function commandProvider(config) {
  const cmd = Array.isArray(config.ai.command) ? config.ai.command : null;
  function call(system, user, { timeoutMs = config.ai.timeoutMs } = {}) {
    if (!cmd?.length) return Promise.reject(new Error('ai.command is not set (e.g. ["claude", "-p"])'));
    return new Promise((resolve, reject) => {
      const child = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('the command timed out')); }, timeoutMs);
      child.stdout.on('data', (d) => { out += d; });
      child.on('error', (err) => { clearTimeout(timer); reject(new Error(`could not run ${cmd[0]}: ${err.message}`)); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(`${cmd[0]} exited with code ${code}`));
        try { resolve(parseJson(out)); } catch (err) { reject(err); }
      });
      child.stdin.end(`${system}\n\n${user}\n`);
    });
  }
  return {
    name: 'command',
    model: cmd ? cmd.join(' ') : null,
    interpret: (input) => call(INTERPRET_SYSTEM, interpretPrompt(input)),
    lead: (input) => call(LEAD_SYSTEM, leadPrompt(input)),
    review: ({ system, prompt }) => call(system, prompt),
    analyze: ({ system, prompt }) => call(system, prompt, { timeoutMs: Math.max(config.ai.timeoutMs || 0, ANALYZE.minTimeoutMs) }),
  };
}

// Claude Code with the person's own login. ai.command overrides the command (default claude -p);
// ai.model is passed as --model. Claude Code takes a few seconds to start, so at least 2 minutes.
function claudeCodeProvider(config, { run = runClaude } = {}) {
  const cfg = { command: Array.isArray(config.ai.command) && config.ai.command.length ? config.ai.command : ['claude', '-p'],
    timeoutMs: Math.max(config.ai.timeoutMs || 0, 120000) };
  const call = async (system, user, c = cfg) => parseJson(await run(c, `${system}\n\n${user}`, { what: 'the AI answer', noTools: true, model: config.ai.model || null }));
  return {
    name: 'claude-code',
    model: config.ai.model || 'Claude Code default',
    interpret: (input) => call(INTERPRET_SYSTEM, interpretPrompt(input)),
    lead: (input) => call(LEAD_SYSTEM, leadPrompt(input)),
    review: ({ system, prompt }) => call(system, prompt),
    analyze: ({ system, prompt }) => call(system, prompt, { ...cfg, timeoutMs: Math.max(cfg.timeoutMs, ANALYZE.minTimeoutMs) }),
  };
}

// The provider named in the local config. An unknown name falls back to rules and says so.
export function createProvider(config, opts = {}) {
  const name = config.ai?.provider || 'claude';
  if (name === 'claude') return claudeProvider(config);
  if (name === 'claude-code') return claudeCodeProvider(config, opts);
  if (name === 'openai-compatible') return openAiCompatibleProvider(config, opts);
  if (name === 'command') return commandProvider(config);
  if (name === 'none') return rulesInterpreter;
  return { ...rulesInterpreter, name: 'rules', unknown: name };
}
