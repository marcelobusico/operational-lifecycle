// Local log of every source read: one JSON line per read with source, feature and outcome.
// Values pass through redact() so a token can never end up on disk.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';

const TOKEN_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /ser\.[A-Za-z0-9]{16,}/g, // Flagsmith server-side environment key
  /sk-(ant-)?[A-Za-z0-9_-]{16,}/g, // Anthropic and OpenAI-style API keys
  /(?:console|secret|client)-[A-Za-z0-9]{20,}/g, // Statsig Console API key (and the server/client keys pasted by mistake)
  /(bearer|token|api-key)\s+[^\s"',}]+/gi,
  /(authorization|token|password|secret|api_?key)(["']?\s*[:=]\s*["']?)(?!bearer\b|token\b|api-key\b)[^\s"',}]+/gi,
];

const knownSecrets = new Set();

export function registerSecret(secret) {
  if (secret && secret.length >= 8) knownSecrets.add(secret);
}

export function redact(text) {
  let out = String(text);
  for (const secret of knownSecrets) out = out.split(secret).join('[redacted]');
  for (const p of TOKEN_PATTERNS.slice(0, 5)) out = out.replace(p, '[redacted]');
  out = out.replace(TOKEN_PATTERNS[5], '$1 [redacted]');
  return out.replace(TOKEN_PATTERNS[6], '$1$2[redacted]');
}

export function looksLikeToken(text) {
  return /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|ser\.[A-Za-z0-9]{16,}|sk-(ant-)?[A-Za-z0-9_-]{16,}|console-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(String(text));
}

// entry: { source, feature, step, target, outcome, status?, detail? }
export function logSourceRead(entry) {
  const line = redact(JSON.stringify({ at: new Date().toISOString(), ...entry }));
  try {
    const file = paths.logFile();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, line + '\n');
  } catch (err) {
    console.error(`lifecycle: could not write the source-read log: ${err.message}`);
  }
}
