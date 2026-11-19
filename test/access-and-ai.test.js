// Setup and AI problems a new machine runs into, each told in plain words with the fix:
// a rejected AI key, Claude Code as the AI with no key, GitHub access that only works in the
// Terminal (GITHUB_TOKEN) or isn't authorized for single sign-on, and access fixed while running.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createProvider } from '../src/ask/providers.js';
import { reviewDefinition } from '../src/features/review.js';
import { createGithubClient } from '../src/sources/github-client.js';
import { liveGithubToken, githubToken, githubAccess, ghWorksAtLogin, DEFAULTS } from '../src/config.js';

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `lc-${name}-`));
const servers = [];
after(() => servers.forEach((s) => s.close()));
async function serve(handler) {
  const s = http.createServer(handler);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  servers.push(s);
  return `http://127.0.0.1:${s.address().port}`;
}
const aiConfig = (ai) => ({ ...DEFAULTS, ai: { ...DEFAULTS.ai, timeoutMs: 5000, ...ai } });
const review = (provider) => reviewDefinition({ provider, text: 'id: x\nname: X\n', feature: { id: 'x', file: 'features/x.yaml', dependsOn: [] }, features: [] });

test('an AI key the provider rejects (401) is named as such, with the fix, and the definition still passes', async () => {
  const url = await serve((req, res) => {
    req.resume();
    res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
  });
  process.env.LIFECYCLE_AI_API_KEY = 'sk-ant-wrong';
  try {
    for (const ai of [{ provider: 'claude', apiUrl: url }, { provider: 'openai-compatible', apiUrl: url, model: 'm' }]) {
      const r = await review(createProvider(aiConfig(ai)));
      assert.equal(r.ran, false);
      assert.equal(r.blocking, false);
      assert.match(r.note, /rejected the API key \(HTTP 401: wrong, revoked, or not an API key\)\. Set a new one with `lifecycle setup --extras`, or use the AI provider "claude-code"/, ai.provider);
      assert.match(r.note, /The definition passed validation\./);
    }
  } finally {
    delete process.env.LIFECYCLE_AI_API_KEY;
  }
});

test('the claude-code provider answers through Claude Code with no tools and no connectors', async () => {
  const dir = tmp('claude');
  const log = path.join(dir, 'args.txt');
  const fake = path.join(dir, 'claude');
  // Records its arguments and the prompt, answers like `claude -p` would.
  fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\ncat > "${log}.stdin"\necho '{"findings": [{"kind": "ambiguity", "field": "name", "message": "Name is vague", "suggestion": "Say what users get"}]}'\n`, { mode: 0o755 });
  const r = await review(createProvider(aiConfig({ provider: 'claude-code', command: [fake, '-p'], model: 'opus' })));
  assert.equal(r.ran, true, r.note);
  assert.equal(r.findings[0].message, 'Name is vague');
  assert.deepEqual(fs.readFileSync(log, 'utf8').split('\n').slice(0, 7), ['-p', '--tools', '', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--model']);
  assert.match(fs.readFileSync(`${log}.stdin`, 'utf8'), /features\/x\.yaml/);
  // Not installed: says so, and the review just doesn't run.
  const missing = await review(createProvider(aiConfig({ provider: 'claude-code', command: [path.join(dir, 'nope')] })));
  assert.equal(missing.ran, false);
  assert.match(missing.note, /Could not run nope|isn't installed/);
});

test('with no working GitHub access, a read says why (gh\'s own words) and how to fix GITHUB_TOKEN-only gh', async () => {
  const url = await serve((req, res) => { req.resume(); res.writeHead(404, { 'content-type': 'application/json' }).end('{"message":"Not Found"}'); });
  const gh = createGithubClient({ apiUrl: url, token: () => null, access: () => ({ source: 'the GitHub CLI (gh) login', problem: 'gh said: no oauth token found for github.com' }) });
  await assert.rejects(gh.request('/repos/team/LifeCycle-Data', { what: 'the shared repo team/LifeCycle-Data' }), (err) => {
    assert.equal(err.kind, 'no_access');
    assert.match(err.message, /^No GitHub access works for LifeCycle right now \(gh said: no oauth token found for github\.com\), so it can't read the shared repo team\/LifeCycle-Data\./);
    assert.match(err.message, /env -u GITHUB_TOKEN gh auth login/);
    return true;
  });
});

test('a repo hidden by single sign-on says to authorize the access, with GitHub\'s link; other no-access names the access used', async () => {
  const sso = 'https://github.com/orgs/team/sso?authorization_request=abc';
  const url = await serve((req, res) => {
    req.resume();
    if (req.url.includes('sso')) return res.writeHead(403, { 'x-github-sso': `required; url=${sso}` }).end('{}');
    res.writeHead(404).end('{}');
  });
  const gh = createGithubClient({ apiUrl: url, token: 'gho_x', access: () => ({ source: 'the GitHub CLI (gh) login' }) });
  await assert.rejects(gh.request('/repos/team/sso-repo', { what: 'team/sso-repo' }),
    (err) => err.message.includes(`isn't authorized for this organization's single sign-on, so it can't read team/sso-repo. Authorize it at ${sso}`) && err.message.includes('gh auth refresh'));
  await assert.rejects(gh.request('/repos/team/other', { what: 'team/other' }),
    (err) => err.message === "Your GitHub credentials (the GitHub CLI (gh) login) can't read team/other.");
});

test('a token that starts working while LifeCycle runs is picked up without a restart', async () => {
  const home = tmp('home');
  const old = process.env.LIFECYCLE_HOME;
  const env = { a: process.env.GITHUB_TOKEN, b: process.env.LIFECYCLE_GITHUB_TOKEN };
  delete process.env.GITHUB_TOKEN; delete process.env.LIFECYCLE_GITHUB_TOKEN;
  process.env.LIFECYCLE_HOME = home;
  try {
    let t = 0;
    const live = liveGithubToken(() => t);
    assert.equal(live(), null);
    assert.match(githubAccess().problem, /no GitHub access is set up/);
    fs.writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({ github: { token: 'ghp_now' } }));
    t = 10000; assert.equal(live(), null, 'not read again within 30 seconds');
    t = 31000; assert.equal(live(), 'ghp_now');
    assert.equal(githubAccess().source, 'the token saved by setup');
    assert.equal(githubToken(), 'ghp_now');
  } finally {
    process.env.LIFECYCLE_HOME = old;
    if (env.a) process.env.GITHUB_TOKEN = env.a;
    if (env.b) process.env.LIFECYCLE_GITHUB_TOKEN = env.b;
  }
});

test('setup checks gh the way LifeCycle runs at login: no GITHUB_TOKEN, minimal PATH, the saved config folder', () => {
  const calls = [];
  const fakeRun = (ok) => (cmd, args, opts) => { calls.push(opts.env); if (!ok) throw new Error('no oauth token'); return 'gho_x\n'; };
  process.env.GITHUB_TOKEN = 'from-shell';
  try {
    assert.equal(ghWorksAtLogin('/opt/homebrew/bin/gh', null, fakeRun(false)), false);
    assert.equal(ghWorksAtLogin('/opt/homebrew/bin/gh', '/Users/x/dotfiles/gh', fakeRun(true)), true);
  } finally {
    delete process.env.GITHUB_TOKEN;
  }
  assert.ok(calls.every((e) => !('GITHUB_TOKEN' in e) && !('GH_TOKEN' in e) && e.PATH === '/usr/bin:/bin:/usr/sbin:/sbin'));
  assert.equal(calls[1].GH_CONFIG_DIR, '/Users/x/dotfiles/gh');
});
