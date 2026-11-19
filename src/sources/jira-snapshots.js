// Jira snapshots: after each refresh, the LifeCycle that reads Jira commits what it read about each
// ticket to LifeCycle-Data (jira-snapshots/<KEY>.yaml): summary, status, status category, assignee,
// created / resolved and the link, with the read time. Teammates who don't read Jira use them.
// Committed when one of those changed or the last one is over 6 hours old, and only by someone who
// can write to the shared repo. Never a credential. A failed write is logged and never affects the refresh.
import { parse, stringify } from 'yaml';
import { logSourceRead } from '../log.js';
import { writeDataFile } from '../data-source.js';

export const JIRA_SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const FIELDS = ['summary', 'status', 'status_category', 'assignee', 'created', 'resolved', 'url'];
const KEY = /^[A-Z][A-Z0-9_]{0,29}-[1-9]\d{0,9}$/;
export const jiraSnapshotFile = (key) => `jira-snapshots/${key}.yaml`;

export function jiraSnapshotDue(t, existing, now = Date.now()) {
  if (!existing) return true;
  if (FIELDS.some((k) => (t[k] ?? null) !== (existing[k] ?? null))) return true;
  return now - Date.parse(existing.read_at) > JIRA_SNAPSHOT_MAX_AGE_MS;
}

export function jiraSnapshotText(t) {
  const doc = Object.fromEntries([['key', t.key], ...FIELDS.map((k) => [k, t[k] ?? null]), ['updated', t.updated ?? null], ['read_at', t.read_at]]);
  return `# Written by LifeCycle from a Jira read (through Claude Code). Do not edit by hand.\n${stringify(doc, { lineWidth: 0 })}`;
}

// null when unreadable or not shaped like one (it is then ignored).
export function parseJiraSnapshot(text) {
  try {
    const d = parse(text);
    if (!d || typeof d !== 'object' || !KEY.test(String(d.key || '')) || !d.status || !d.read_at) return null;
    const iso = (v) => (v instanceof Date ? v.toISOString() : v ?? null);
    const url = typeof d.url === 'string' && /^https:\/\//.test(d.url) ? d.url : null;
    const out = { key: String(d.key), summary: d.summary ? String(d.summary) : null, status: String(d.status), status_category: d.status_category || null,
      assignee: d.assignee ? String(d.assignee) : null, created: iso(d.created), updated: iso(d.updated), resolved: iso(d.resolved), url, read_at: iso(d.read_at) };
    return isNaN(Date.parse(out.read_at)) ? null : out;
  } catch {
    return null;
  }
}

// reads: the Jira source's reads(). Returns [{ file, outcome: committed | unchanged | read_only | failed, message? }].
export async function commitJiraSnapshots({ config, github, reads, existing = [], canWrite = async () => true, now = Date.now() }) {
  const out = [];
  const due = [];
  for (const t of reads) {
    const file = jiraSnapshotFile(t.key);
    if (jiraSnapshotDue(t, existing.find((s) => s.key === t.key) || null, now)) due.push({ t, file });
    else out.push({ file, outcome: 'unchanged' });
  }
  if (!due.length) return out;
  if (!(await canWrite())) return [...out, ...due.map(({ file }) => ({ file, outcome: 'read_only' }))];
  for (const { t, file } of due) {
    try {
      await writeDataFile({ config, github, file, text: jiraSnapshotText(t), message: `Jira snapshot: ${t.key} ${t.status} (LifeCycle)` });
      logSourceRead({ source: 'jira-snapshot', feature: '*', target: file, outcome: 'ok' });
      out.push({ file, outcome: 'committed' });
    } catch (err) {
      logSourceRead({ source: 'jira-snapshot', feature: '*', target: file, outcome: err.kind || 'error', status: err.status, detail: err.message });
      out.push({ file, outcome: 'failed', message: err.message });
    }
  }
  return out;
}
