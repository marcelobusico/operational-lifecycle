// Flag snapshots: after each refresh, LifeCycle commits what the flag platform said about each flag to
// LifeCycle-Data (flag-snapshots/<flag>.yaml): per environment the on / off / partial state, the
// rollout percentage, the segment names and their share, and when it was read; or that the flag
// doesn't exist on the platform (unknown: true). Written by LifeCycle, never by people.
//
// Who writes: anyone whose LifeCycle read the flag live (they have a key) and who can write to the
// shared repo. Who reads: anyone whose live read fails, most often because they have no key. They
// see the snapshot's state with its read time instead of "status unavailable" (src/lastmile/index.js).
//
// Never holds a credential or a rule's conditions: only the fields below are written. To keep the
// history readable, a snapshot is committed when the state changed, or when the last committed one
// is more than 6 hours old. A failed write is logged and never affects the refresh.
import { parse, stringify } from 'yaml';
import { logSourceRead } from '../log.js';
import { writeDataFile } from '../data-source.js';
import { ENVIRONMENTS } from './state.js';

export const FLAG_SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const PLATFORM_NAME = { statsig: 'Statsig', flagsmith: 'Flagsmith' };
const STATES = new Set(['on', 'off', 'partial']);
const ENV_FIELDS = ['platform_environment', 'state', 'rollout_percentage', 'segments', 'changed_at', 'changed_by', 'was_on_before', 'link'];

// A flag key as a file name: anything outside letters, digits, dot, dash and underscore becomes "_".
export const flagSnapshotFile = (key) => `flag-snapshots/${String(key).replace(/[^A-Za-z0-9._-]/g, '_')}.yaml`;

// One environment's cell, reduced to what a snapshot keeps.
export function snapshotEnvironment(cell) {
  return {
    platform_environment: cell.platform_environment ?? null,
    state: cell.state,
    rollout_percentage: cell.rollout_percentage ?? null,
    segments: (cell.segments || []).map((s) => ({ name: String(s.name ?? ''), percentage: s.percentage ?? null })),
    changed_at: cell.changed_at ?? null,
    changed_by: cell.changed_by ?? null,
    was_on_before: cell.was_on_before ?? null,
    link: cell.link ?? null,
  };
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// True when `read` should be committed over `existing` (the last committed snapshot of that flag, or null).
export function flagSnapshotDue(read, existing, now = Date.now()) {
  if (!existing || existing.platform !== read.platform) return true;
  if (Boolean(read.unknown) !== Boolean(existing.unknown)) return true;
  for (const env of read.unknown ? [] : ENVIRONMENTS) {
    const a = read.environments[env] || {};
    const b = existing.environments?.[env] || {};
    if (ENV_FIELDS.some((k) => !same(a[k], b[k]))) return true;
  }
  return now - Date.parse(existing.read_at) > FLAG_SNAPSHOT_MAX_AGE_MS;
}

export function flagSnapshotText(read) {
  const doc = read.unknown ? { platform: read.platform, flag: read.flag, unknown: true, read_at: read.read_at }
    : { platform: read.platform, flag: read.flag, environments: read.environments, read_at: read.read_at };
  return `# Written by LifeCycle from a live ${PLATFORM_NAME[read.platform] || read.platform} read. Do not edit by hand.\n${stringify(doc, { lineWidth: 0 })}`;
}

// A committed flag snapshot. null when unreadable or not shaped like one (it is then ignored).
export function parseFlagSnapshot(text) {
  try {
    const d = parse(text);
    if (!d || typeof d !== 'object' || !d.flag || !d.platform || !d.read_at) return null;
    const read_at = d.read_at instanceof Date ? d.read_at.toISOString() : String(d.read_at);
    if (isNaN(Date.parse(read_at))) return null;
    if (d.unknown === true) return { platform: String(d.platform), flag: String(d.flag), unknown: true, environments: {}, read_at };
    if (!d.environments || typeof d.environments !== 'object') return null;
    const environments = {};
    for (const env of ENVIRONMENTS) {
      const e = d.environments[env];
      if (!e || !STATES.has(e.state)) continue;
      const iso = (t) => (t instanceof Date ? t.toISOString() : t ?? null);
      environments[env] = { ...snapshotEnvironment(e), changed_at: iso(e.changed_at) };
    }
    return { platform: String(d.platform), flag: String(d.flag), environments, read_at };
  } catch {
    return null;
  }
}

const summary = (read) => read.unknown ? 'not found' : ENVIRONMENTS.map((env) => {
  const c = read.environments[env];
  return `${env} ${c.state === 'partial' ? `${c.rollout_percentage ?? 'some segments'}${c.rollout_percentage !== null ? '%' : ''}` : c.state}`;
}).join(', ');

// reads: lastMile.flagReads(). existing: parsed flagSnapshots. canWrite: async () => boolean, asked
// only when something is due. Returns [{ file, outcome: committed | unchanged | read_only | failed, message? }].
export async function commitFlagSnapshots({ config, github, reads, existing = [], canWrite = async () => true, now = Date.now() }) {
  const due = [];
  const out = [];
  for (const read of reads) {
    const prev = existing.find((s) => s.flag === read.flag && s.platform === read.platform) || null;
    const file = flagSnapshotFile(read.flag);
    if (flagSnapshotDue(read, prev, now)) due.push({ read, file });
    else out.push({ file, outcome: 'unchanged' });
  }
  if (!due.length) return out;
  // Without write access there is nothing to try: say so once instead of failing every file.
  if (!(await canWrite())) return [...out, ...due.map(({ file }) => ({ file, outcome: 'read_only' }))];
  for (const { read, file } of due) {
    try {
      await writeDataFile({ config, github, file, text: flagSnapshotText(read),
        message: `Flag snapshot: ${read.flag} ${summary(read)} (LifeCycle)` });
      logSourceRead({ source: 'flag-snapshot', feature: '*', target: file, outcome: 'ok' });
      out.push({ file, outcome: 'committed' });
    } catch (err) {
      logSourceRead({ source: 'flag-snapshot', feature: '*', target: file, outcome: err.kind || 'error', status: err.status, detail: err.message });
      out.push({ file, outcome: 'failed', message: err.message });
    }
  }
  return out;
}
