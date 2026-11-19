// A dry run of reading Jira tickets through Claude Code: reads the tickets named on the command line
// (or every Jira ticket linked in the shared repo's features) and prints, per ticket, its status and
// whether LifeCycle counts it as done. Commits nothing and ignores the read interval.
// Usage: lifecycle jira-check [ABC-123 ...]
import { loadConfig, githubToken, DEFAULTS } from '../config.js';
import { createGithubClient } from '../sources/github-client.js';
import { fetchDefinitionFiles } from '../data-source.js';
import { parseDefinitions } from '../definitions.js';
import { createJiraSource } from '../sources/jira.js';

// run: replaces the Claude Code call (tests). out: where lines go.
export async function jiraCheck({ argv = process.argv.slice(2), config = loadConfig(), token = githubToken(), run, out = console.log } = {}) {
  let keys = argv.map((k) => k.trim().toUpperCase()).filter(Boolean);
  const bad = keys.filter((k) => !/^[A-Z][A-Z0-9_]{0,29}-[1-9]\d{0,9}$/.test(k));
  if (bad.length) { out(`Not a Jira ticket key: ${bad.join(', ')} (expected something like ABC-123).`); return 2; }
  if (!keys.length) {
    const github = createGithubClient({ apiUrl: config.sources.github.apiUrl, enabled: config.sources.github.enabled, token });
    const defs = await fetchDefinitionFiles(config, github);
    const { features } = parseDefinitions(defs.files);
    keys = [...new Set(features.flatMap((f) => [...f.steps, ...(f.rampConditions || [])].flatMap((s) => s.evidence)).filter((e) => e.source === 'jira').map((e) => e.key))];
    if (!keys.length) {
      out('No feature in the shared repo links a Jira ticket yet. Add one to a step in features/<id>.yaml:\n  evidence:\n    - { source: jira, type: ticket, key: ABC-123 }\nor name tickets here: lifecycle jira-check ABC-123');
      return 1;
    }
  }
  const cfg = { ...DEFAULTS.sources.jira, ...(config.sources?.jira || {}), enabled: true };
  const jira = createJiraSource({ cfg, ...(run ? { run } : {}) });
  const evidence = keys.map((key) => ({ source: 'jira', type: 'ticket', key }));
  out(`Reading ${keys.length} Jira ticket${keys.length === 1 ? '' : 's'} through Claude Code (nothing is committed)…\n`);
  await jira.prefetch(evidence, { force: true });
  let failed = false;
  for (const e of evidence) {
    try {
      const r = await jira.readEvidence(e);
      out(`  ${e.key}  ${r.state === 'done' ? '✓ done' : r.state === 'in_progress' ? '… in progress' : '○ not done'}  (${r.detail})${r.title ? `  ${r.title}` : ''}${r.url ? `\n         ${r.url}` : ''}`);
    } catch (err) {
      out(`  ${e.key}  ✗ ${err.message}`);
      failed = true;
    }
  }
  if (!config.sources?.jira?.enabled && !failed) out('\nIf this looks right, turn it on for this machine with: lifecycle setup --extras (Jira), then restart LifeCycle.');
  return failed ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await jiraCheck();
