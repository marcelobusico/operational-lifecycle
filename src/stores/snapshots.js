// Store snapshots: after each refresh, LifeCycle commits what the store said about each app and
// platform to LifeCycle-Data (store-snapshots/<app>-<platform>.yaml): version, review state,
// rollout percentage and the time it was read. Written by LifeCycle, never by people. It is the
// record behind the release history and the last-known state when a store can't be reached.
//
// To keep LifeCycle-Data's history readable, a snapshot is committed when something other than the
// read time changed, or when the last committed one is more than 6 hours old. Never holds a
// credential: only the fields below are written. A failed write (no write access, conflict with a
// teammate's fresher snapshot, repo down) is logged and never affects the refresh.
import { stringify } from 'yaml';
import { logSourceRead } from '../log.js';
import { writeDataFile } from '../data-source.js';
import { PLATFORM_LABEL, STORE_NAME } from './index.js';

export const SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const FIELDS = ['version', 'state', 'store_state', 'released_version', 'rollout_state', 'rollout_percentage', 'via'];
export const snapshotFile = (app, platform) => `store-snapshots/${app}-${platform}.yaml`;

// True when `read` should be committed over `existing` (the last committed snapshot or null).
export function snapshotDue(read, existing, now = Date.now()) {
  if (!existing) return true;
  const via = (x) => (x.via === 'slack' ? 'slack' : null);
  if (FIELDS.some((k) => (k === 'via' ? via(read) !== via(existing) : (read[k] ?? null) !== (existing[k] ?? null)))) return true;
  return now - Date.parse(existing.read_at) > SNAPSHOT_MAX_AGE_MS;
}

export function snapshotText(read) {
  const doc = {
    app: read.app, platform: read.platform, store: read.store, store_id: read.store_id,
    // The newest version and its review state…
    version: read.version, state: read.state, store_state: read.store_state,
    // …and the version users get now, with its rollout (gradual | complete | halted).
    released_version: read.released_version, rollout_state: read.rollout_state, rollout_percentage: read.rollout_percentage,
    link: read.link, read_at: read.read_at,
    // Read from the store itself, or from the app's Slack release channel (no message text is kept).
    ...(read.via === 'slack' ? { via: 'slack', release_channel: read.release_channel } : {}),
  };
  const from = read.via === 'slack' ? `the Slack channel ${read.release_channel}` : `a live ${STORE_NAME[read.store] || read.store} read`;
  return `# Written by LifeCycle from ${from}. Do not edit by hand.\n${stringify(doc, { lineWidth: 0 })}`;
}

// reads: lastMile.storeReads(). existing: parsed storeSnapshots. Returns [{ file, outcome, message? }].
// canWrite: whether this person may write to the shared repo (asked once, only when something is due).
export async function commitSnapshots({ config, github, reads, existing = [], canWrite = async () => true, now = Date.now() }) {
  const out = [];
  let allowed = null;
  for (const read of reads) {
    const prev = existing.find((s) => s.app === read.app && s.platform === read.platform) || null;
    const file = snapshotFile(read.app, read.platform);
    // A store read (someone with store access) beats a Slack read: a Slack read replaces it only once
    // it is clearly no longer kept up to date, so two LifeCycles never overwrite each other's snapshot.
    const storeKept = prev && prev.via !== 'slack' && now - Date.parse(prev.read_at) <= 2 * SNAPSHOT_MAX_AGE_MS;
    if (!snapshotDue(read, prev, now) || (read.via === 'slack' && storeKept)) { out.push({ file, outcome: 'unchanged' }); continue; }
    if (allowed === null) allowed = await canWrite();
    if (!allowed) { out.push({ file, outcome: 'read_only' }); continue; }
    const text = snapshotText(read);
    try {
      const live = read.released_version ? `, ${read.released_version} ${read.rollout_state === 'halted' ? 'halted at ' : 'at '}${read.rollout_percentage ?? '?'}%` : '';
      const what = `${read.version || 'no version'} ${String(read.state || '').replace(/_/g, ' ')}${read.version === read.released_version ? '' : live}${read.version === read.released_version ? ` ${read.rollout_percentage ?? '?'}%` : ''}`;
      const message = config.dataPath ? `Store snapshot: ${read.app} ${PLATFORM_LABEL[read.platform]} (LifeCycle)` : `Store snapshot: ${read.app} ${PLATFORM_LABEL[read.platform]} ${what} (LifeCycle)`;
      await writeDataFile({ config, github, file, text, message });
      logSourceRead({ source: 'store-snapshot', feature: '*', target: file, outcome: 'ok' });
      out.push({ file, outcome: 'committed' });
    } catch (err) {
      logSourceRead({ source: 'store-snapshot', feature: '*', target: file, outcome: err.kind || 'error', status: err.status, detail: err.message });
      out.push({ file, outcome: 'failed', message: err.message });
    }
  }
  return out;
}
