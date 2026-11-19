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
const evidenceKey = evidenceId;

// Builds a reader for one refresh. read() never throws: a failed read comes back as
// { state: 'unavailable' | 'no_access', message, lastSuccessfulReadAt }.
// jiraSnapshots: parsed jira-snapshots/. jiraRun: replaces the Claude Code call for Jira (tests).
export function createEvidenceReader({ config, tokens, fetchImpl, jiraSnapshots = [], jiraRun }) {
  const adapters = {};
  for (const [name, def] of Object.entries(SOURCES)) {
    adapters[name] = def.create({ config, token: tokens[name], fetchImpl, jiraSnapshots, jiraRun });
  }
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

  async function read(evidence, { feature, step }) {
    const adapter = adapters[evidence.source];
    const key = evidenceKey(evidence);
    const target = evidence.source === 'jira' ? evidence.key : `${evidence.repo}#${evidence.number} (${evidence.type})`;
    const base = { ...evidence, link: adapter.linkFor(evidence) };
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
    try {
      writeJson(lastReadsFile(), lastReads);
      writeJson(failingFile(), failing);
    } catch (err) {
      console.error(`lifecycle: could not save last read times: ${err.message}`);
    }
  }

  // Lets a source read all of a refresh's items in one go (Jira: one Claude run) before read() asks one by one.
  async function prefetch(features) {
    const evidence = features.flatMap((f) => [...f.steps, ...(f.rampConditions || [])].flatMap((s) => s.evidence));
    await Promise.all(Object.values(adapters).map((a) => a.prefetch?.(evidence)));
  }

  return { read, save, prefetch, jiraReads: () => adapters.jira.reads() };
}
