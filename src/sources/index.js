// Registry of the systems a step's evidence can come from. To add one, add an entry with the
// evidence types it understands and a factory returning { readEvidence, linkFor } (and optionally
// prefetch(evidence) to read a refresh's items in one go, and reads() for team snapshots).
import fs from 'node:fs';
import path from 'node:path';
import { paths, writeJson, DEFAULTS } from '../config.js';
import { logSourceRead } from '../log.js';
import { createGithubClient, SourceError } from './github-client.js';
import { createGithubSource } from './github.js';
import { createJiraSource } from './jira.js';
import { evidenceId } from '../evidence.js';

const SOURCES = {
  github: {
    types: ['pr', 'issue'],
    create: ({ config, token, fetchImpl }) => createGithubSource(createGithubClient({
      apiUrl: config.sources.github.apiUrl,
      enabled: config.sources.github.enabled,
      token,
      fetchImpl,
    })),
  },
  // Jira tickets, read through Claude Code (src/sources/jira.js); team snapshots when not read here.
  jira: {
    types: ['ticket'],
    create: ({ config, jiraSnapshots, jiraRun }) => createJiraSource({ cfg: { ...DEFAULTS.sources.jira, ...(config.sources?.jira || {}) },
      snapshots: jiraSnapshots, ...(jiraRun ? { run: jiraRun } : {}) }),
  },
};

export function sourceTypes(name) {
  return SOURCES[name]?.types || null;
}

const lastReadsFile = () => path.join(paths.cacheDir(), 'last-reads.json');
// When each read started failing (cleared by the next successful read): "unavailable since".
const failingFile = () => path.join(paths.cacheDir(), 'failing-since.json');
// What the last live read said about each item, so a refresh that doesn't read the sources
// (live: false, src/app.js) shows that instead of calling GitHub or Claude again.
const resultsFile = () => path.join(paths.cacheDir(), 'evidence-results.json');
export const NOT_READ_YET = 'Not read on this machine yet. Press Refresh data to read it.';
const evidenceKey = evidenceId;

// Builds a reader for one refresh. read() never throws: a failed read comes back as
// { state: 'unavailable' | 'no_access', message, lastSuccessfulReadAt }.
// jiraSnapshots: parsed jira-snapshots/. jiraRun: replaces the Claude Code call for Jira (tests).
// live: false reads (almost) nothing: each item is what the last live read said (a newer Jira team
// snapshot, which comes with the shared repo, wins). A GitHub PR or issue never read before (just
// linked to a step) is read once: one API call, no Claude. A new Jira ticket waits for Refresh data.
export function createEvidenceReader({ config, tokens, fetchImpl, jiraSnapshots = [], jiraRun, live = true }) {
  const adapters = {};
  for (const [name, def] of Object.entries(SOURCES)) {
    adapters[name] = def.create({ config, token: tokens[name], fetchImpl, jiraSnapshots, jiraRun });
  }
  let results = {};
  try {
    results = JSON.parse(fs.readFileSync(resultsFile(), 'utf8'));
  } catch {
    results = {};
  }
  // Snapshots only, never Claude: what teammates shared about a ticket.
  const jiraSnapshotOnly = createJiraSource({ cfg: { ...DEFAULTS.sources.jira, enabled: false }, snapshots: jiraSnapshots });
  let lastReads = {};
  try {
    lastReads = JSON.parse(fs.readFileSync(lastReadsFile(), 'utf8'));
  } catch {
    lastReads = {};
  }
  let failing = {};
  try {
    failing = JSON.parse(fs.readFileSync(failingFile(), 'utf8'));
  } catch {
    failing = {};
  }

  async function cachedRead(evidence, key, base) {
    const saved = results[key] || null;
    if (evidence.source === 'jira') {
      const snap = await jiraSnapshotOnly.readEvidence(evidence).catch(() => null);
      if (snap && (!saved || Date.parse(snap.read_at) > Date.parse(saved.readAt || 0))) return { ...base, ...snap, link: snap.url || base.link, readAt: snap.read_at };
    }
    if (saved) return { ...base, ...saved, link: saved.link || base.link };
    return { ...base, state: 'unavailable', message: NOT_READ_YET, lastSuccessfulReadAt: lastReads[key] || null, unavailableSince: null };
  }

  let readAny = live; // save only when something was read live
  async function read(evidence, opts) {
    const key = evidenceKey(evidence);
    const base = { ...evidence, link: adapters[evidence.source].linkFor(evidence) };
    if (!live && (results[key] || evidence.source !== 'github')) return cachedRead(evidence, key, base);
    readAny = true;
    const r = await readLive(evidence, opts, key, base);
    // Without the definition fields: those come from the definitions on every refresh.
    const { link, state, message, readAt, lastSuccessfulReadAt, unavailableSince, ...rest } = r;
    results[key] = { ...Object.fromEntries(Object.entries(rest).filter(([k]) => !(k in evidence))), link, state, message, readAt, lastSuccessfulReadAt, unavailableSince };
    return r;
  }

  async function readLive(evidence, { feature, step }, key, base) {
    const adapter = adapters[evidence.source];
    const target = evidence.source === 'jira' ? evidence.key : `${evidence.repo}#${evidence.number} (${evidence.type})`;
    try {
      const result = await adapter.readEvidence(evidence);
      const readAt = new Date().toISOString();
      lastReads[key] = result.read_at || readAt;
      delete failing[key];
      logSourceRead({ source: evidence.source, feature, step, target, outcome: 'ok', detail: result.state });
      // A result from a team snapshot carries its own read time.
      return { ...base, ...result, link: result.url || base.link, readAt: result.read_at || readAt };
    } catch (err) {
      if (!(err instanceof SourceError)) throw err;
      logSourceRead({ source: evidence.source, feature, step, target, outcome: err.kind, status: err.status, detail: err.message });
      if (!failing[key]) failing[key] = new Date().toISOString();
      return {
        ...base,
        state: err.kind === 'no_access' ? 'no_access' : 'unavailable',
        message: err.message,
        lastSuccessfulReadAt: lastReads[key] || null,
        unavailableSince: failing[key],
      };
    }
  }

  function save() {
    if (!readAny) return;
    try {
      writeJson(lastReadsFile(), lastReads);
      writeJson(failingFile(), failing);
      writeJson(resultsFile(), results);
    } catch (err) {
      console.error(`lifecycle: could not save last read times: ${err.message}`);
    }
  }

  // Lets a source read all of a refresh's items in one go (Jira: one Claude run) before read() asks one by one.
  async function prefetch(features) {
    if (!live) return;
    const evidence = features.flatMap((f) => [...f.steps, ...(f.rampConditions || [])].flatMap((s) => s.evidence));
    await Promise.all(Object.values(adapters).map((a) => a.prefetch?.(evidence)));
  }

  return { read, save, prefetch, jiraReads: () => adapters.jira.reads() };
}
