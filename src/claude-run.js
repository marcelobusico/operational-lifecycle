// Runs Claude Code (`claude -p`) for a source LifeCycle reads through Claude's own connectors
// (Slack, Jira): the prompt goes in on stdin, the answer comes back on stdout. Failures are SourceErrors
// with the fix.
//
// What Claude may do is locked down, because what it reads (Slack messages, Jira tickets, app hints in
// the shared repo) is written by other people and could try to steer it:
//   --tools ToolSearch            no other built-in tools (no shell, files or web); ToolSearch is how
//                                 Claude loads connector tools, so it must stay;
//   --permission-mode dontAsk     any tool not approved below is refused, even if the person's own
//                                 Claude settings would allow more (e.g. bypassPermissions);
//   --allowedTools <cfg.tools>    the read-only connector tools LifeCycle needs;
//   --disallowedTools <WRITE>     the connectors' known write tools, refused even if allowed elsewhere.
// It runs in LifeCycle's cache folder, outside any project, so no project instructions or settings apply.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { paths, findCli } from './config.js';
import { SourceError } from './sources/github-client.js';

// Write tools of the Slack and Atlassian connectors. Unknown names are harmless; tools added later are
// still refused by dontAsk unless the person's own settings allow them.
export const WRITE_TOOLS = [
  ...['slack_send_message', 'slack_send_message_draft', 'slack_schedule_message', 'slack_create_canvas', 'slack_update_canvas',
    'slack_add_reaction', 'slack_remove_reaction', 'slack_delete_message', 'slack_update_message', 'slack_create_channel',
    'slack_invite_to_channel', 'slack_set_status'].map((t) => `mcp__plugin_slack_slack__${t}`),
  ...['createJiraIssue', 'editJiraIssue', 'transitionJiraIssue', 'addCommentToJiraIssue', 'addWorklogToJiraIssue', 'createIssueLink',
    'createConfluencePage', 'updateConfluencePage', 'createConfluenceFooterComment', 'createConfluenceInlineComment'].map((t) => `mcp__atlassian__${t}`),
];

// what: what is being read, for messages ("the Slack channel"). signIn: where to sign in ("Slack", "Atlassian").
export function runClaude(cfg, prompt, { what, signIn }) {
  const cmd = Array.isArray(cfg.command) && cfg.command.length ? cfg.command : ['claude', '-p'];
  const bin = cmd[0].includes('/') ? cmd[0] : findCli(cmd[0]);
  const name = path.basename(cmd[0]);
  if (!bin) {
    return Promise.reject(new SourceError('unreachable', `${name} isn't installed on this machine (or not where LifeCycle looks), so ${what} can't be read. Install Claude Code and sign in to ${signIn} in it, or turn this source off.`));
  }
  const args = [...cmd.slice(1), '--tools', 'ToolSearch', '--permission-mode', 'dontAsk',
    ...(cfg.tools?.length ? ['--allowedTools', cfg.tools.join(',')] : []), '--disallowedTools', WRITE_TOOLS.join(',')];
  return new Promise((resolve, reject) => {
    fs.mkdirSync(paths.cacheDir(), { recursive: true });
    const child = spawn(bin, args, { cwd: paths.cacheDir(), stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new SourceError('unreachable', `Reading ${what} through ${name} took more than ${Math.round(cfg.timeoutMs / 1000)} seconds.`)); }, cfg.timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(new SourceError('unreachable', `Could not run ${name}: ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const why = err.trim().split('\n').filter(Boolean).pop() || `exit code ${code}`;
        return reject(new SourceError('unreachable', `${name} couldn't read ${what} (${why}). Check that it is signed in, and to ${signIn}: run ${name} and /mcp.`));
      }
      resolve(out);
    });
    child.stdin.on('error', () => { /* Claude exited before reading the prompt: reported by 'close' */ });
    child.stdin.end(`${prompt}\n`);
  });
}
