// Questions, answers and digests stay on this machine: ~/.lifecycle/history/*.jsonl (readable only
// by you) plus one line per question or digest in ~/.lifecycle/logs/ask.log with the feature and
// the outcome. Everything passes through redact(), so no token reaches the disk.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../config.js';
import { redact } from '../log.js';

const file = (kind) => path.join(paths.historyDir(), `${kind}.jsonl`);

function append(target, line, mode) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.appendFileSync(target, line + '\n', { mode });
  if (mode) fs.chmodSync(target, mode);
}

// kind: 'asks' | 'digests'
export function saveHistory(kind, record) {
  try {
    append(file(kind), redact(JSON.stringify(record)), 0o600);
  } catch (err) {
    console.error(`lifecycle: could not save ${kind} history: ${err.message}`);
  }
}

export function readHistory(kind, limit = 50) {
  try {
    const lines = fs.readFileSync(file(kind), 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// entry: { kind: 'ask' | 'digest', via: 'app' | 'ai-tools' | 'cli', feature, project? (initiative id, 'none' or '*' for all), outcome, intent?, provider?, duration_ms? }
export function logAsk(entry) {
  try {
    append(paths.askLog(), redact(JSON.stringify({ at: new Date().toISOString(), ...entry })), 0o600);
  } catch (err) {
    console.error(`lifecycle: could not write the ask log: ${err.message}`);
  }
}
