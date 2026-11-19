// AI product review of an edited feature definition, before it is published. It applies the rules
// in review-rules.md (next to this file) with the AI provider set up for Ask & digest.
//
// Contradictions block publishing; ambiguities are suggestions. When no provider is set up, or it
// can't be reached, the review is reported as not run and a valid definition can still be published.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from '../log.js';

const RULES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'review-rules.md');

let rulesCache = null;
function reviewRules() {
  if (rulesCache) return rulesCache;
  rulesCache = fs.readFileSync(RULES, 'utf8').trim();
  return rulesCache;
}

export function reviewSystem() {
  return [
    'You review a LifeCycle feature definition (YAML) as a product manager and as the engineers who will do the work.',
    'The format is already valid; do not report format problems. Apply these rules:',
    '',
    reviewRules(),
    '',
    'Return JSON only: {"findings": [{"kind": "contradiction" | "ambiguity", "field": "<the YAML field at fault, e.g. target_date, depends_on, steps[1].done_when>", "message": "<what is wrong, one sentence>", "suggestion": "<a concrete fix>"}]}.',
    'Report only real problems; an empty list is the right answer for a clear definition. Never invent facts that are not in the files.',
  ].join('\n');
}

// The definition plus what the rules need to compare against: the features it depends on (their
// target dates) and the features that depend on it.
export function reviewPrompt({ text, feature, features }) {
  const brief = (f) => `- ${f.id} (${f.name})${f.targetDate ? `, target_date ${f.targetDate}` : ''}`;
  const deps = features.filter((f) => feature.dependsOn.includes(f.id));
  const dependents = features.filter((f) => f.dependsOn.includes(feature.id) && f.id !== feature.id);
  return [
    `File: ${feature.file}`,
    '```yaml', text.trim(), '```',
    deps.length ? `Features it depends on:\n${deps.map(brief).join('\n')}` : 'It depends on no other feature.',
    dependents.length ? `Features that depend on it:\n${dependents.map(brief).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

// Returns { ran, provider, findings: [{ kind, field, message, suggestion }], blocking, note }.
export async function reviewDefinition({ provider, text, feature, features }) {
  const name = provider?.name || 'none';
  if (!provider || typeof provider.review !== 'function') {
    return { ran: false, provider: name, findings: [], blocking: false,
      note: 'The AI product review did not run: no AI provider is set up on this machine (see ai.provider in ~/.lifecycle/config.json). The definition passed validation.' };
  }
  let out;
  try {
    out = await provider.review({ system: reviewSystem(), prompt: reviewPrompt({ text, feature, features }) });
  } catch (err) {
    return { ran: false, provider: name, findings: [], blocking: false,
      note: `The AI product review did not run (${redact(err.message)}). The definition passed validation.` };
  }
  const findings = (Array.isArray(out?.findings) ? out.findings : [])
    .filter((f) => f && typeof f.message === 'string' && f.message.trim())
    .map((f) => ({
      kind: f.kind === 'contradiction' ? 'contradiction' : 'ambiguity',
      field: typeof f.field === 'string' && f.field.trim() ? f.field.trim() : '(file)',
      message: f.message.trim(),
      suggestion: typeof f.suggestion === 'string' ? f.suggestion.trim() : '',
    }));
  const blocking = findings.some((f) => f.kind === 'contradiction');
  return { ran: true, provider: name, findings, blocking,
    note: blocking ? 'The AI product review found contradictions. Fix them before publishing.'
      : findings.length ? 'Ready with suggestions.' : 'The AI product review found no problems.' };
}
