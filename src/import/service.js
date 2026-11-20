// Import from links: the pasted links → sources read (read-only) → the AI's proposal
// (docs/import-format.md). An analysis runs in the background on this machine, one at a time; the
// screen follows it with progress(). Nothing is written to LifeCycle-Data, Jira or GitHub: Jira is
// read through Claude Code with read-only tools (read-jira.js), GitHub with GET requests only
// (app.githubRead), and the proposal is kept in memory for the screen to show.
import crypto from 'node:crypto';
import { DEFAULTS } from '../config.js';
import { redact } from '../log.js';
import { parseLinks, linkId } from './links.js';
import { readJiraSources } from './read-jira.js';
import { readGithubSource } from './read-github.js';
import { analyzeSources, PROPOSAL_SCHEMA } from './analyze.js';

export const NO_AI_MESSAGE = 'Analysis needs an AI provider, and none is set up on this machine (ai.provider is "none"). '
  + 'Set one up with `lifecycle setup --extras` (AI provider: claude, claude-code, openai-compatible or command), '
  + 'or set ai.provider in ~/.lifecycle/config.json (docs/ask-format.md). Nothing was read and nothing is proposed.';
const UNKNOWN_AI = (name) => `Analysis needs an AI provider, and the one set up on this machine ("${name}") isn't one LifeCycle knows. `
  + 'Set ai.provider in ~/.lifecycle/config.json to claude, claude-code, openai-compatible or command, or run `lifecycle setup --extras`. Nothing was read and nothing is proposed.';
const KEEP_JOBS = 5;

// providerNow(): the AI provider as configured right now (src/ask/service.js currentProvider).
// jiraRun / getGithub: replace the Claude Code run and the GitHub reads (tests).
export function createImportService({ app, providerNow, jiraRun = app.jiraRun, getGithub = app.githubRead }) {
  const jobs = new Map();
  let running = null;

  // Whether analysis can run, and if not, how to set it up.
  function availability() {
    const p = providerNow();
    if (typeof p?.analyze === 'function') return { available: true, provider: { name: p.name, model: p.model || null }, message: null };
    return { available: false, provider: { name: p?.unknown ? `unknown (${p.unknown})` : 'none', model: null }, message: p?.unknown ? UNKNOWN_AI(p.unknown) : NO_AI_MESSAGE };
  }

  const view = (job) => ({
    id: job.id, state: job.state, phase: job.phase, started_at: job.started_at, finished_at: job.finished_at || null, message: job.message || null,
    sources: job.sources.map(({ docs, evidence, ...s }) => s),
    proposal: job.proposal || null,
  });

  async function run(job, provider, entries) {
    const caps = { ...DEFAULTS.import, ...(app.config.import || {}) };
    const readable = entries.filter((e) => e.status === 'ok');
    const set = (e, patch) => Object.assign(job.sources.find((s) => s.id === linkId(e)), patch);
    for (const e of readable) set(e, { status: 'reading' });
    const jiraEntries = readable.filter((e) => e.kind === 'jira');
    const jiraCfg = { ...DEFAULTS.sources.jira, ...(app.config.sources?.jira || {}) };
    await Promise.all([
      jiraEntries.length ? readJiraSources({ entries: jiraEntries, cfg: jiraCfg, caps, ...(jiraRun ? { run: jiraRun } : {}) })
        .then((results) => { for (const e of jiraEntries) set(e, results.get(e.key)); }) : null,
      ...readable.filter((e) => e.kind.startsWith('github_')).map((e) => readGithubSource({ entry: e, get: getGithub, caps }).then((r) => set(e, r))),
    ]);
    const read = job.sources.filter((s) => s.status === 'read');
    if (!read.length) {
      job.state = 'failed';
      job.phase = 'failed';
      job.message = entries.length ? 'None of the links could be read, so there is nothing to analyze. See each link for the reason.' : 'Paste at least one Jira or GitHub link.';
      return;
    }
    job.phase = 'analyzing';
    const defs = await app.definitionsNow().catch(() => null);
    const features = (defs?.featureDefs || []).map((f) => ({ id: f.id, name: f.name }));
    const projects = (defs?.projectDefs || []).map((p) => ({ id: p.id, name: p.name }));
    let result;
    try {
      result = await analyzeSources({ provider, sources: read, features, projects });
    } catch (err) {
      job.state = 'failed';
      job.phase = 'failed';
      job.message = `The AI provider (${provider.name}) couldn't analyze the sources: ${redact(err.message)}. Nothing is proposed; try Analyze again.`;
      return;
    }
    for (const [id, n] of result.cut) {
      const s = job.sources.find((x) => x.id === id);
      s.left_out = [...s.left_out, `${n} ${n === 1 ? 'document' : 'documents'} not analyzed: the analysis reads at most 300,000 characters in all`];
    }
    job.proposal = {
      schema: PROPOSAL_SCHEMA, analyzed_at: new Date().toISOString(), provider: { name: provider.name, model: provider.model || null },
      sources: job.sources.map(({ id, docs, evidence, ...s }) => s),
      items: result.items,
    };
    job.state = 'done';
    job.phase = 'done';
    job.message = result.items.length ? null : 'The AI proposed nothing from these sources.';
  }

  // text: what the person pasted. { outcome: 'no_ai' | 'no_links' | 'started' | 'running', ... }
  function start(text) {
    const ai = availability();
    if (!ai.available) return { outcome: 'no_ai', message: ai.message };
    if (running) return { outcome: 'running', id: running.id, message: 'An analysis is already running; its progress is shown.' };
    const entries = parseLinks(text);
    if (!entries.some((e) => e.status === 'ok')) {
      return { outcome: 'no_links', links: entries, message: entries.length ? 'None of these links is one LifeCycle can read yet (Jira tickets, GitHub repositories, PRs, issues or files).' : 'Paste at least one Jira or GitHub link.' };
    }
    const provider = providerNow();
    const job = {
      id: crypto.randomBytes(8).toString('hex'), state: 'running', phase: 'reading', started_at: new Date().toISOString(),
      sources: entries.map((e) => ({ id: linkId(e), input: e.input, kind: e.kind, label: e.label, url: e.url, status: e.status === 'ok' ? 'pending' : e.status, reason: e.reason, left_out: [], docs: [], evidence: [] })),
    };
    jobs.set(job.id, job);
    while (jobs.size > KEEP_JOBS) jobs.delete(jobs.keys().next().value);
    running = job;
    job.done = run(job, provider, entries)
      .catch((err) => { job.state = 'failed'; job.phase = 'failed'; job.message = `The analysis stopped: ${redact(err.message)}`; })
      .finally(() => { job.finished_at = new Date().toISOString(); running = null; });
    return { outcome: 'started', id: job.id };
  }

  return {
    links: (text) => parseLinks(text),
    availability,
    start,
    progress: (id) => (jobs.has(id) ? view(jobs.get(id)) : null),
    // Tests: wait for a job to end.
    settled: (id) => jobs.get(id)?.done || Promise.resolve(),
  };
}
