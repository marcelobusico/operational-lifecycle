// App store access, one connector per store. Everything else in LifeCycle (last mile, ramp, chat,
// digest, UI) only sees what readRelease() returns, so connecting a second store means adding a
// connector here and nothing else.
//
// Connector contract: { store, name, platforms, readApp(storeId, platform) } where readApp resolves
// to { unknown: true, link } for an identifier the store doesn't know, or
// { unknown: false, name, link, versions: [{ version, state, store_state, rollout, released_at, link }] }
// newest first, and rejects with a SourceError (unreachable | no_access, with a fix) otherwise.
//   state:   preparing | in_review | approved_waiting | rejected | released | replaced | removed | unknown
//   rollout: { state: none | gradual | complete | halted, percentage, day?, store_word? }
//
// Connected now: App Store (iOS). Google Play (Android) has no connector yet: its platforms show
// "store not connected", never a guessed state.
import { createAppStoreConnector } from './app-store.js';

export const STORE_NAME = { app_store: 'App Store', google_play: 'Google Play' };
export const PLATFORM_LABEL = { ios: 'iOS', android: 'Android' };

// Built-in connectors, by store. Each factory gets ({ config, credentials, fetchImpl }).
export const CONNECTORS = {
  app_store: ({ config, credentials, fetchImpl }) => createAppStoreConnector({ cfg: config.sources?.appStore || {}, credentials: credentials.app_store || null, fetchImpl }),
};

// Returns { connector(store) → connector | null }. `connectors` overrides/extends the built-in set
// (tests plug a second store in this way, exactly as a real one would be added).
export function createStores({ config, credentials = {}, fetchImpl = fetch, connectors = {} }) {
  const factories = { ...CONNECTORS, ...connectors };
  const made = new Map();
  return {
    connector(store) {
      if (!factories[store]) return null;
      if (!made.has(store)) made.set(store, factories[store]({ config, credentials, fetchImpl }));
      return made.get(store);
    },
  };
}

// Compares two versions like 3.4.0 and 3.10.1. Missing parts count as 0.
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// Where a feature that first ships in `first` stands, given the store's versions (newest first):
//   { state, version, rollout, link, store_state, latest }
//   state: not_in_version (no version written, or none ≥ it in the store yet) | preparing |
//          in_review | approved_waiting | rejected | released (with rollout) | removed
export function featureRelease(read, first) {
  const versions = read.versions || [];
  const latest = versions[0] || null;
  const brief = (v) => (v ? { version: v.version, state: v.state, store_state: v.store_state, rollout: v.rollout, link: v.link } : null);
  // The version users get now: the newest released one.
  const live = versions.find((v) => v.state === 'released');
  const base = { latest: brief(latest), live: brief(live) };
  if (!first) return { ...base, state: 'not_in_version', version: null, rollout: null, link: read.link, store_state: null };
  if (live && compareVersions(live.version, first) >= 0) {
    // A later version going out gradually still leaves everyone on a version that has it, as long
    // as the version before it (also ≥ first) was fully out; when the live one IS the first, its rollout counts.
    const rollout = compareVersions(live.version, first) === 0 ? live.rollout : { state: 'complete', percentage: 100, day: null };
    return { ...base, state: 'released', version: live.version, rollout, link: live.link, store_state: live.store_state };
  }
  // Not live yet: the oldest version in the pipeline that has it.
  const pending = versions.filter((v) => compareVersions(v.version, first) >= 0 && !['replaced'].includes(v.state));
  const next = pending[pending.length - 1];
  if (!next) return { ...base, state: 'not_in_version', version: null, rollout: null, link: read.link, store_state: null, missing_version: first };
  return { ...base, state: next.state === 'unknown' ? 'preparing' : next.state, version: next.version, rollout: next.rollout, link: next.link, store_state: next.store_state };
}
