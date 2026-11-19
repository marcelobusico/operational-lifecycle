// App releases read from a Slack channel where a bot and people announce them (versions cut,
// review, release, rollout %, halts). LifeCycle has no Slack app of its own: it asks Claude Code,
// signed in to Slack on this machine, to read the channel with read-only tools and return the
// release events as JSON. Claude reads; LifeCycle decides:
//
//   1. Claude returns each message it used (exact text) and the events it found in them.
//   2. LifeCycle keeps an event only when its message is among those returned and every value in it
//      is written in that message (the version may also come from the thread's first message).
//      Anything else is dropped and logged, never guessed.
//   3. LifeCycle works the release state out of the kept events itself (foldEvents), in the same
//      shape a store connector returns (src/stores/index.js), so the last mile treats it like a store.
//
// Only the events are kept on this machine (cache/slack-releases.json), never message text. The
// channel is read at most every `intervalMinutes`; a first read goes back `lookbackDays`. Config:
// sources.slack (src/config.js). The result reaches teammates through store-snapshots/.
import fs from 'node:fs';
import path from 'node:path';
import { paths, writeJson } from '../config.js';
import { runClaude } from '../claude-run.js';
import { SourceError } from '../sources/github-client.js';
import { compareVersions } from './index.js';
import { parseJson } from '../ask/providers.js';

export const KINDS = ['cut', 'submitted', 'in_review', 'approved', 'rejected', 'released', 'rollout', 'halted', 'resumed'];
// Kinds that may leave the version out (a thread reply "now at 50%"): they apply to the newest released version.
const ROLLOUT_KINDS = new Set(['rollout', 'halted', 'resumed']);
// At least one dot, so a bare number (often a percentage, "3%") is never read as a version.
const VERSION = /^\d+(\.\d+){1,3}$/;
// A Slack message timestamp ("1731400000.000100"), not in the future (5 minutes of clock slack).
const validTs = (ts, nowS) => /^\d{9,11}(\.\d{1,6})?$/.test(String(ts ?? '')) && Number(ts) <= nowS + 300;
const cacheFile = () => path.join(paths.cacheDir(), 'slack-releases.json');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const toIso = (ts) => new Date(Number(String(ts).split('.')[0]) * 1000).toISOString();

// The instructions Claude gets. Plain text on stdin; the answer is JSON on stdout.
export function slackPrompt({ channel, apps, oldestTs, threadsSinceTs }) {
  return [
    'You read release announcements from one Slack channel for LifeCycle, a release status tool.',
    'Use only your Slack tools, and only to read. Never post, react or change anything.',
    `Channel: ${channel}${channel.startsWith('#') ? ' (if you need its id, find it with the channel search tool)' : ''}`,
    `Read every message posted after Slack timestamp ${oldestTs} (${toIso(oldestTs)}), oldest first,`,
    `and the replies posted after that time in threads started after ${threadsSinceTs} (${toIso(threadsSinceTs)}).`,
    '',
    'Apps announced in this channel (id: name, platforms, how to read their messages):',
    ...apps.map((a) => `- ${a.id}: ${a.name} (${Object.keys(a.platforms).join(', ')})${a.releaseChannel?.hint ? `. ${a.releaseChannel.hint}` : ''}`),
    '',
    'For each message about a release of one of these apps, return one event per app, platform and kind it reports:',
    '  cut         a release version was cut, branched, created or started',
    '  submitted   sent to store review',
    '  in_review   in store review',
    '  approved    approved by the store, not released to users yet',
    '  rejected    rejected in store review',
    '  released    released / available to users (with its rollout percentage if written)',
    '  rollout     the rollout percentage changed (phased or staged rollout)',
    '  halted      the rollout was paused, halted or stopped',
    '  resumed     the rollout was resumed',
    'Rules:',
    '- A message about both platforms gives one event per platform. Use the app id and platform (ios or android) from the list above.',
    '- version and rollout_percentage exactly as written in the message. A thread reply that does not repeat the version may use the version in its thread\'s first message.',
    '- Never guess: use null for anything not written. Skip messages that are not about these releases.',
    '',
    'Return JSON only, no other text:',
    '{"channel_found": true, "messages": [{"ts": "1731400000.000100", "thread_ts": null, "permalink": "https://….slack.com/archives/…", "text": "the exact message text"}],',
    ' "events": [{"ts": "1731400000.000100", "app": "app-id", "platform": "ios", "kind": "rollout", "version": "3.4.0", "rollout_percentage": 20}]}',
    'List in "messages" every message an event cites, plus the first message of its thread when that is where the version is written.',
    'If the channel cannot be found or read, return {"channel_found": false, "messages": [], "events": []}.',
  ].join('\n');
}

const hasVersion = (text, v) => new RegExp(`(?<![\\d.])v?${esc(v)}(?![\\d]|\\.\\d)`).test(String(text || ''));
const hasPercent = (text, n) => new RegExp(`(?<![\\d.])${n}\\s*(%|percent)`, 'i').test(String(text || ''));
const slackLink = (u) => (typeof u === 'string' && /^https:\/\/[a-z0-9-]+(\.enterprise)?\.slack\.com\//i.test(u) ? u : null);

// Keeps the events whose every value is written in the cited message. Returns { kept, dropped: [{ event, reason }] }.
export function validateEvents({ messages = [], events = [], apps = [], now = Date.now() }) {
  const nowS = Math.floor(now / 1000);
  const byTs = new Map((Array.isArray(messages) ? messages : []).filter((m) => m && typeof m === 'object' && validTs(m.ts, nowS)).map((m) => [String(m.ts), m]));
  const appById = new Map(apps.map((a) => [a.id, a]));
  const kept = [];
  const dropped = [];
  for (const e of Array.isArray(events) ? events : []) {
    const drop = (reason) => dropped.push({ event: e, reason });
    if (!e || typeof e !== 'object') { drop('not an event'); continue; }
    const msg = byTs.get(String(e.ts));
    if (!msg) { drop('cites a message that was not returned'); continue; }
    const app = appById.get(e.app);
    if (!app) { drop(`unknown app "${e.app}"`); continue; }
    if (!Object.hasOwn(app.platforms, String(e.platform))) { drop(`${app.id} has no ${e.platform} platform`); continue; }
    if (!KINDS.includes(e.kind)) { drop(`unknown kind "${e.kind}"`); continue; }
    const version = e.version === null || e.version === undefined || e.version === '' ? null : String(e.version).replace(/^v/i, '');
    if (version !== null) {
      if (!VERSION.test(version)) { drop(`"${e.version}" is not a version`); continue; }
      const parent = msg.thread_ts && String(msg.thread_ts) !== String(msg.ts) ? byTs.get(String(msg.thread_ts)) : null;
      if (!hasVersion(msg.text, version) && !hasVersion(parent?.text, version)) { drop(`version ${version} is not written in the message`); continue; }
    } else if (!ROLLOUT_KINDS.has(e.kind)) { drop(`a ${e.kind} event needs a version`); continue; }
    let pct = e.rollout_percentage;
    if (pct === undefined || pct === '') pct = null;
    if (pct !== null) {
      pct = Number(pct);
      if (!Number.isInteger(pct) || pct < 0 || pct > 100) { drop(`"${e.rollout_percentage}" is not a percentage`); continue; }
      if (!hasPercent(msg.text, pct)) { drop(`${pct}% is not written in the message`); continue; }
    } else if (e.kind === 'rollout') { drop('a rollout event needs a percentage'); continue; }
    kept.push({ ts: String(e.ts), at: toIso(e.ts), app: e.app, platform: e.platform, kind: e.kind, version, rollout_percentage: pct, link: slackLink(msg.permalink) });
  }
  return { kept, dropped };
}

// The release state of one app and platform from its events, newest version first, in the store
// connector shape: [{ version, state, store_state, rollout: { state, percentage }, released_at, link }].
export function foldEvents(events, app, platform) {
  const mine = events.filter((e) => e.app === app && e.platform === platform).sort((a, b) => Number(a.ts) - Number(b.ts));
  const versions = new Map();
  const get = (v) => {
    if (!versions.has(v)) versions.set(v, { version: v, state: 'preparing', store_state: null, rollout: null, released_at: null, link: null });
    return versions.get(v);
  };
  const newestReleased = () => [...versions.values()].filter((x) => x.state === 'released').sort((a, b) => compareVersions(b.version, a.version))[0] || null;
  const STATE = { cut: 'preparing', submitted: 'in_review', in_review: 'in_review', approved: 'approved_waiting', rejected: 'rejected' };
  for (const e of mine) {
    const v = e.version ? get(e.version) : newestReleased();
    if (!v) continue; // "now at 50%" with no version and nothing released yet: nothing to apply it to
    v.link = e.link || v.link;
    v.store_state = `${e.kind.replace(/_/g, ' ')} (Slack)`;
    const pct = e.rollout_percentage;
    if (STATE[e.kind]) { v.state = STATE[e.kind]; continue; }
    v.released_at ||= e.at;
    v.state = 'released';
    const prev = v.rollout?.percentage ?? null;
    if (e.kind === 'halted') v.rollout = { state: 'halted', percentage: pct ?? prev, store_word: 'halted' };
    else if (e.kind === 'released' && pct === null) v.rollout = v.rollout?.state === 'gradual' ? v.rollout : { state: 'complete', percentage: 100 };
    else {
      const p = pct ?? prev;
      v.rollout = p === null ? { state: 'gradual', percentage: null } : p >= 100 ? { state: 'complete', percentage: 100 } : { state: 'gradual', percentage: p };
    }
  }
  return [...versions.values()].sort((a, b) => compareVersions(b.version, a.version));
}

const runSlack = (cfg, prompt) => runClaude(cfg, prompt, { what: 'the Slack channel', signIn: 'Slack' });

// One reader per LifeCycle process. read(channel, apps, { force, days }) → { events, checked_at, dropped }.
// run: (cfg, prompt) → stdout, replaceable in tests.
export function createSlackReleaseReader({ cfg, run = runSlack, now = () => Date.now(), log = () => {} }) {
  const inflight = new Map();
  const load = () => {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
      return c && typeof c === 'object' && c.channels && typeof c.channels === 'object' ? c : { channels: {} };
    } catch { return { channels: {} }; }
  };

  // The apps read from a channel and how: when it changes (an app added, a hint edited), the channel is
  // read again from `lookbackDays`, so the new app's past releases are found too.
  const scopeOf = (apps) => JSON.stringify(apps.map((a) => [a.id, Object.keys(a.platforms).sort(), a.releaseChannel?.hint || null]).sort());
  const save = (all) => { try { writeJson(cacheFile(), all, 0o600); } catch (err) { log({ outcome: 'error', detail: `could not save the Slack cache: ${err.message}` }); } };

  async function fetchNew(channel, apps, { days = null } = {}) {
    const all = load();
    const prev = all.channels?.[channel] || null;
    const scope = scopeOf(apps);
    const saved = days ? null : prev;
    const nowS = Math.floor(now() / 1000);
    const lookback = nowS - (days ?? cfg.lookbackDays) * 86400;
    const oldestTs = (saved?.scope === scope && saved?.last_ts) || `${lookback}.000000`;
    const threadsSinceTs = `${Math.max(lookback, nowS - 7 * 86400)}.000000`;
    try {
      const text = await run(cfg, slackPrompt({ channel, apps, oldestTs, threadsSinceTs }));
      let answer;
      try { answer = parseJson(text); } catch { answer = null; }
      if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw new SourceError('unreachable', `Claude's answer about ${channel} wasn't the JSON LifeCycle asked for, so nothing was read from it.`);
      if (answer.channel_found === false) {
        throw new SourceError('no_access', `Claude couldn't find or read the Slack channel ${channel}. Check the channel name in apps/<app>.yaml (release_channel.slack) and that your Slack account can read it.`);
      }
      const messages = Array.isArray(answer.messages) ? answer.messages : [];
      const { kept, dropped } = validateEvents({ messages, events: answer.events, apps, now: now() });
      for (const d of dropped) log({ outcome: 'dropped', detail: `${d.reason}: ${JSON.stringify(d.event)}` });
      const key = (e) => `${e.ts}|${e.app}|${e.platform}|${e.kind}|${e.version}`;
      const merged = new Map([...(saved?.events || []), ...kept].map((e) => [key(e), e]));
      // Next read starts after the newest real message seen (never a future one, which would hide everything after it).
      const seen = messages.filter((m) => m && validTs(m.ts, nowS)).map((m) => Number(m.ts));
      const base = saved?.scope === scope ? Number(saved?.last_ts || 0) : 0;
      const lastTs = seen.length || base ? String(Math.max(...seen, base)) : null;
      const entry = { events: [...merged.values()].sort((a, b) => Number(a.ts) - Number(b.ts)), last_ts: lastTs, scope, checked_at: new Date(now()).toISOString() };
      if (!days) {
        all.channels = { ...(all.channels || {}), [channel]: entry };
        save(all);
      }
      return { ...entry, dropped };
    } catch (err) {
      const e = err instanceof SourceError ? err : new SourceError('unreachable', `Reading ${channel} failed: ${err.message}`);
      // Remember the failure so the next refreshes use the team snapshot instead of waiting on Claude again.
      if (!days) {
        all.channels = { ...(all.channels || {}), [channel]: { ...(prev || {}), failed_at: new Date(now()).toISOString(), failure: { kind: e.kind, message: e.message } } };
        save(all);
      }
      throw e;
    }
  }

  async function read(channel, apps, opts = {}) {
    if (!opts.force && !opts.days) {
      const saved = load().channels?.[channel];
      const fresh = (t) => t && now() - Date.parse(t) < cfg.intervalMinutes * 60000;
      if (saved?.failed_at && fresh(saved.failed_at) && !(saved.checked_at > saved.failed_at)) {
        throw new SourceError(saved.failure?.kind || 'unreachable', `${saved.failure?.message || `Reading ${channel} failed.`} LifeCycle tries again ${cfg.intervalMinutes} minutes after that failure.`);
      }
      if (saved?.checked_at && fresh(saved.checked_at) && saved.scope === scopeOf(apps)) return { ...saved, dropped: [], cached: true };
    }
    if (!inflight.has(channel)) inflight.set(channel, fetchNew(channel, apps, opts).finally(() => inflight.delete(channel)));
    return inflight.get(channel);
  }

  // In the store connector shape for one app and platform.
  async function readApp(app, platform, apps) {
    const { events } = await read(app.releaseChannel.slack, apps);
    const versions = foldEvents(events, app.id, platform);
    return { unknown: false, name: app.name, link: versions[0]?.link || null, versions };
  }

  return { read, readApp };
}
