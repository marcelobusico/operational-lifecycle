// A dry run of reading app releases from Slack: reads each release channel named in apps/*.yaml
// through Claude Code, and prints what LifeCycle understood from each message, what it dropped and
// why, and the release state per app and platform. Commits nothing and changes no saved state, so it
// can be run before turning sources.slack on, to check the channel is read correctly.
// Usage: lifecycle slack-check [--days 14] [--app <app id>]
import { loadConfig, githubToken, DEFAULTS } from '../config.js';
import { createGithubClient } from '../sources/github-client.js';
import { fetchDefinitionFiles } from '../data-source.js';
import { parseDefinitions } from '../definitions.js';
import { createSlackReleaseReader, foldEvents } from '../stores/slack-releases.js';
import { PLATFORM_LABEL } from '../stores/index.js';

// run: replaces the Claude Code call (tests). out: where lines go.
export async function slackCheck({ argv = process.argv.slice(2), config = loadConfig(), token = githubToken(), run, out = console.log } = {}) {
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const days = Number(opt('--days') || 14);
  if (!Number.isInteger(days) || days < 1 || days > 365) { out('--days must be a whole number of days between 1 and 365.'); return 2; }
  const only = opt('--app');

  const github = createGithubClient({ apiUrl: config.sources.github.apiUrl, enabled: config.sources.github.enabled, token });
  const defs = await fetchDefinitionFiles(config, github);
  if (defs.error && !defs.files.length) { out(`Couldn't read the shared repo: ${defs.error.message}`); return 1; }
  const { apps } = parseDefinitions(defs.files);
  const withChannel = apps.filter((a) => a.releaseChannel?.slack && (!only || a.id === only));
  if (!withChannel.length) {
    out(only ? `apps/${only}.yaml has no release_channel.slack (or there is no app ${only}).`
      : 'No app in the shared repo names a Slack release channel. Add to apps/<app>.yaml:\n  release_channel:\n    slack: "#your-release-channel"\n    hint: "optional: how to tell the apps or platforms apart"');
    return 1;
  }

  const cfg = { ...DEFAULTS.sources.slack, ...(config.sources?.slack || {}) };
  const reader = createSlackReleaseReader({ cfg, ...(run ? { run } : {}) });
  const channels = [...new Set(withChannel.map((a) => a.releaseChannel.slack))];
  let failed = false;
  for (const channel of channels) {
    const onChannel = apps.filter((a) => a.releaseChannel?.slack === channel);
    out(`\n${channel}: the last ${days} days, read through Claude Code (nothing is committed)`);
    let r;
    try {
      r = await reader.read(channel, onChannel, { days });
    } catch (err) {
      out(`  ✗ ${err.message}`);
      failed = true;
      continue;
    }
    out(r.events.length ? '\n  Understood:' : '\n  No release events found in this period.');
    for (const e of r.events) {
      out(`  ${e.at.slice(0, 16).replace('T', ' ')}  ${e.app} ${PLATFORM_LABEL[e.platform]}  ${e.kind}${e.version ? ` ${e.version}` : ''}${e.rollout_percentage !== null ? ` ${e.rollout_percentage}%` : ''}${e.link ? `  ${e.link}` : ''}`);
    }
    if (r.dropped.length) {
      out('\n  Dropped (a value not written in the message, or not one of these apps):');
      for (const d of r.dropped) out(`  - ${d.reason}: ${JSON.stringify(d.event)}`);
    }
    out('\n  Resulting state:');
    for (const app of onChannel.filter((a) => !only || a.id === only)) {
      for (const plat of Object.keys(app.platforms)) {
        const versions = foldEvents(r.events, app.id, plat);
        const live = versions.find((v) => v.state === 'released');
        const latest = versions[0];
        const rollout = (v) => (v.rollout?.state === 'halted' ? `halted at ${v.rollout.percentage ?? '?'}%` : v.rollout?.percentage !== null && v.rollout?.percentage !== undefined ? `${v.rollout.percentage}%` : 'released');
        out(`  ${app.id} ${PLATFORM_LABEL[plat]}: ${!latest ? 'nothing in this period'
          : `${live ? `users get ${live.version} (${rollout(live)})` : 'nothing released'}${latest !== live ? `; newest ${latest.version} ${latest.state.replace(/_/g, ' ')}` : ''}`}`);
      }
    }
  }
  if (!cfg.enabled && !failed) out('\nIf this looks right, turn it on for this machine with: lifecycle setup --extras (Slack release channel), then restart LifeCycle.');
  return failed ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await slackCheck();
