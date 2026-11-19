// Jira tickets as step evidence: { source: jira, type: ticket, key: ABC-123 }. Done when the
// ticket's status category is Done, or its status is "Done" or "Closed" (any case).
//
// LifeCycle has no Jira app or token of its own: on the machine that reads Jira (sources.jira.enabled)
// it asks Claude Code, signed in to Atlassian's MCP server, to read the tickets with read-only tools
// (cfg.tools), all of one refresh in one run, at most every `intervalMinutes`. The answer is checked
// (only the keys asked for, a status for each, links on the Jira site) before it is used. Everyone
// else, and that machine when the read fails, uses the team snapshot in jira-snapshots/, marked as such.
import fs from 'node:fs';
import path from 'node:path';
import { paths, writeJson } from '../config.js';
import { SourceError } from './github-client.js';
import { runClaude } from '../claude-run.js';
import { parseJson } from '../ask/providers.js';

const cacheFile = () => path.join(paths.cacheDir(), 'jira.json');
const BATCH = 50;
const runJira = (cfg, prompt) => runClaude(cfg, prompt, { what: 'Jira', signIn: 'Atlassian' });

export function jiraPrompt({ keys, siteUrl = null }) {
  return [
    'You read Jira tickets for LifeCycle, a release status tool.',
    'Use only your Atlassian tools, and only to read. Never create, edit, transition, assign or comment on anything.',
    `1. Call getAccessibleAtlassianResources to get the cloudId${siteUrl ? ` of ${siteUrl}` : ' (if there are several sites, use the one where these tickets exist)'}.`,
    `2. Read these tickets, preferably with one searchJiraIssuesUsingJql call (jql: key in (${keys.join(', ')})) with the fields summary, status, assignee, created, updated and resolutiondate. If the search fails, read them one by one with getJiraIssue.`,
    `Tickets: ${keys.join(', ')}`,
    '',
    'Return JSON only, no other text:',
    '{"site_url": "https://your-site.atlassian.net",',
    ' "tickets": [{"key": "ABC-123", "summary": "…", "status": "In Review", "status_category": "To Do" | "In Progress" | "Done",',
    '   "assignee": "display name" or null, "created": "ISO time", "updated": "ISO time", "resolved": "ISO time" or null,',
    '   "url": "https://your-site.atlassian.net/browse/ABC-123"}],',
    ' "missing": ["keys that don\'t exist or that you can\'t see"]}',
    'Copy every value exactly as Jira returns it. Never guess: use null for anything Jira doesn\'t return.',
  ].join('\n');
}

const CATEGORY = { done: 'done', 'in progress': 'in_progress', indeterminate: 'in_progress', 'to do': 'to_do', todo: 'to_do', new: 'to_do' };
const iso = (t) => (t && !isNaN(Date.parse(t)) ? new Date(t).toISOString() : null);
const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const httpsHost = (u) => { try { const x = new URL(u); return x.protocol === 'https:' ? x.host.toLowerCase() : null; } catch { return null; } };

// "your-site.atlassian.net" or "https://your-site.atlassian.net/jira/…" → "https://your-site.atlassian.net"; null if not a site.
export function normalizeSiteUrl(v) {
  const t = typeof v === 'string' ? v.trim() : '';
  if (!t) return null;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(t) ? t : `https://${t}`);
    return u.protocol === 'https:' && u.hostname.includes('.') ? `https://${u.host.toLowerCase()}` : null;
  } catch { return null; }
}

// Keeps only the tickets asked for, with a status; links only on the Jira site. Returns
// { site_url, tickets: Map(key → ticket), missing: Set, dropped: [{ ticket, reason }] }.
export function validateTickets(answer, keys, { siteUrl = null } = {}) {
  const wanted = new Set(keys);
  // Links are trusted only on the configured site, else on Atlassian's own domain.
  const configured = httpsHost(normalizeSiteUrl(siteUrl));
  const siteOk = (host) => Boolean(host) && (configured ? host === configured : /\.atlassian\.net$/.test(host));
  const site = configured || httpsHost(answer?.site_url);
  const tickets = new Map();
  const dropped = [];
  for (const t of Array.isArray(answer?.tickets) ? answer.tickets : []) {
    const key = typeof t?.key === 'string' ? t.key.trim().toUpperCase() : null;
    if (!key || !wanted.has(key)) { dropped.push({ ticket: t, reason: `"${t?.key}" wasn't asked for` }); continue; }
    if (tickets.has(key)) continue;
    const status = text(t.status, 100);
    if (!status) { dropped.push({ ticket: t, reason: `${key} has no status` }); continue; }
    const host = httpsHost(t.url);
    const url = host && siteOk(host) && new URL(t.url).pathname.endsWith(`/browse/${key}`) ? t.url
      : site && siteOk(site) ? `https://${site}/browse/${key}` : null;
    tickets.set(key, {
      key, summary: text(t.summary, 300), status,
      status_category: CATEGORY[String(t.status_category || '').trim().toLowerCase()] || null,
      assignee: text(t.assignee, 120), created: iso(t.created), updated: iso(t.updated), resolved: iso(t.resolved), url,
    });
  }
  const missing = new Set((Array.isArray(answer?.missing) ? answer.missing : []).map((k) => String(k).trim().toUpperCase()).filter((k) => wanted.has(k) && !tickets.has(k)));
  // Asked for but in neither list: not answered, so not known (never "missing").
  return { site_url: site && siteOk(site) ? `https://${site}` : null, tickets, missing, dropped };
}

// A ticket as step evidence: done | in_progress | not_done, with its status as the detail.
export function ticketState(t) {
  if (t.status_category === 'done' || /^(done|closed)$/i.test(t.status)) return { state: 'done', detail: t.status };
  if (t.status_category === 'in_progress') return { state: 'in_progress', detail: t.status };
  return { state: 'not_done', detail: t.status };
}

const asEvidence = (t, extra = {}) => ({ title: t.summary, url: t.url, author: t.assignee, opened_at: t.created, closed_at: ticketState(t).state === 'done' ? t.resolved || t.updated : null, ...ticketState(t), ...extra });

// snapshots: parsed jira-snapshots/. run: replaces the Claude Code call (tests).
export function createJiraSource({ cfg, snapshots = [], run = runJira, now = () => Date.now() }) {
  const enabled = Boolean(cfg?.enabled);
  const snapOf = (key) => snapshots.find((s) => s.key === key) || null;
  const load = () => {
    let c = null;
    try { c = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')); } catch { /* none yet, or unreadable: start over */ }
    const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
    return { ...obj(c), tickets: obj(c?.tickets), checked: obj(c?.checked), missing: obj(c?.missing) };
  };
  const save = () => { try { writeJson(cacheFile(), cache, 0o600); } catch { /* a cache only: the next refresh reads again */ } };
  let cache = null;
  let failure = null;          // the SourceError of this refresh's failed run, if any
  const failed = new Set();    // keys whose run failed this refresh (they use the snapshot)
  const attempted = new Set(); // keys already asked for this refresh: never a second run for them
  let fetching = null;
  const live = new Map();      // tickets read live (or within the interval) and used this refresh

  // Reads every ticket that is due, in as few Claude runs as possible. force: ignore the interval.
  function prefetch(evidence, { force = false } = {}) {
    if (!enabled) return Promise.resolve();
    const keys = [...new Set(evidence.filter((e) => e.source === 'jira').map((e) => e.key))];
    fetching = (fetching || Promise.resolve()).then(async () => {
      cache ||= load();
      const lastFailed = cache.failed_at && now() - Date.parse(cache.failed_at) < cfg.intervalMinutes * 60000;
      if (!force && lastFailed && !failure) {
        // The last run failed within the interval: use the snapshots instead of waiting on Claude again.
        failure = new SourceError(cache.failure?.kind || 'unreachable', `${cache.failure?.message || 'Reading Jira failed.'} LifeCycle tries again ${cfg.intervalMinutes} minutes after that failure.`);
      }
      const due = keys.filter((k) => !attempted.has(k) && (force || !cache.checked[k] || now() - Date.parse(cache.checked[k]) >= cfg.intervalMinutes * 60000));
      for (const k of due) attempted.add(k);
      if (failure && !force) { for (const k of due) failed.add(k); return; } // one failed run per refresh is enough
      for (let i = 0; i < due.length; i += BATCH) {
        const batch = due.slice(i, i + BATCH);
        let answer;
        try {
          const out = await run(cfg, jiraPrompt({ keys: batch, siteUrl: normalizeSiteUrl(cfg.siteUrl) }));
          try { answer = parseJson(out); } catch { answer = null; }
          if (!answer || typeof answer !== 'object') throw new SourceError('unreachable', 'Claude\'s answer about the Jira tickets wasn\'t the JSON LifeCycle asked for, so nothing was read from it.');
        } catch (err) {
          failure = err instanceof SourceError ? err : new SourceError('unreachable', err.message);
          for (const k of due.slice(i)) failed.add(k);
          cache.failed_at = new Date(now()).toISOString();
          cache.failure = { kind: failure.kind, message: failure.message };
          break;
        }
        const v = validateTickets(answer, batch, { siteUrl: cfg.siteUrl });
        const at = new Date(now()).toISOString();
        if (v.site_url) cache.site_url = v.site_url;
        for (const [k, t] of v.tickets) { cache.tickets[k] = { ...t, read_at: at }; delete cache.missing[k]; }
        for (const k of v.missing) { cache.missing[k] = at; delete cache.tickets[k]; }
        // Every key asked for waits for the next interval, answered or not (unanswered ones use the snapshot).
        for (const k of batch) cache.checked[k] = at;
        delete cache.failed_at;
        delete cache.failure;
      }
      if (due.length) save();
    });
    return fetching;
  }

  async function readEvidence(e) {
    const key = e.key;
    if (enabled) {
      await prefetch([e]);
      const t = cache?.tickets?.[key];
      if (!failed.has(key) && t) { live.set(key, t); return asEvidence(t, { read_at: t.read_at }); }
      if (!failed.has(key) && cache?.missing?.[key]) throw new SourceError('not_found', `Jira has no ticket ${key}, or your Atlassian account can't see it. Check the key in the feature definition.`);
    }
    const snap = snapOf(key);
    if (snap) return asEvidence(snap, { read_at: snap.read_at, from_snapshot: true, detail: `${snap.status} (team snapshot)` });
    if (enabled && failed.has(key) && failure) throw failure;
    if (enabled) throw new SourceError('unreachable', `Claude didn't return Jira ticket ${key}, so its status isn't known.`);
    throw new SourceError('no_access', `Jira isn't read on this machine, and nobody's LifeCycle has shared ${key} yet. One person with Claude Code signed in to Atlassian can turn it on: lifecycle setup --extras.`);
  }

  return {
    prefetch,
    readEvidence,
    // Where a person can look even when Jira can't be read.
    linkFor: ({ key }) => snapOf(key)?.url || cache?.tickets?.[key]?.url || (cache?.site_url ? `${cache.site_url}/browse/${key}` : null),
    // The tickets read live this refresh, for the team snapshots.
    reads: () => [...live.values()],
  };
}
