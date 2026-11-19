// "Check for updates": compares the commit this copy runs with the newest commit on `main` of the
// LifeCycle repo, with the person's saved GitHub access (token or gh login, src/config.js). It never
// asks for credentials of its own, and it never says "up to date" when it couldn't check.
// Any new commit on `main` counts as an update (not only a version-number change).
import fs from 'node:fs';
import path from 'node:path';
import { createGithubClient } from '../sources/github-client.js';
import { githubToken, loadConfig, paths, homeDir } from '../config.js';
import { redact } from '../log.js';
import { installInfo, APP_ROOT, SOURCE_REPO, SOURCE_BRANCH } from './install.js';

// One JSON line per check or upgrade: from/to commits and the outcome. Never a token (redact()).
export function logUpdate(entry) {
  try {
    const file = paths.updateLog();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, redact(JSON.stringify({ at: new Date().toISOString(), ...entry })) + '\n');
  } catch (err) {
    console.error(`lifecycle: could not write the update log: ${err.message}`);
  }
}

const SETUP = (kind) => (kind === 'developer' ? 'npm run setup' : '~/.lifecycle/bin/lifecycle setup');

// Plain words for each way a check can fail: what happened and what to do.
export function explainFailure(err, { repo, kind }) {
  if (err.reason === 'not_connected') {
    return { reason: 'not_connected', message: "GitHub isn't connected to LifeCycle yet, so it can't look for updates.",
      fix: `Connect it once in Terminal: ${SETUP(kind)}` };
  }
  if (err.kind === 'unreachable' && err.status === null) {
    return { reason: 'offline', message: "GitHub can't be reached from this Mac, so LifeCycle couldn't check for updates.",
      fix: 'Check that you are connected to the internet (open any website), then check again.' };
  }
  if (err.kind === 'no_access' && err.status === 401) {
    return { reason: 'rejected', message: "GitHub didn't accept your saved access (the token may have expired or been revoked).",
      fix: `Connect GitHub again in Terminal: ${SETUP(kind)}` };
  }
  if (err.kind === 'no_access') {
    return { reason: 'no_access', message: `Your GitHub access can't read the LifeCycle repo (${repo}), so LifeCycle couldn't check for updates.`,
      fix: `Ask the LifeCycle team to give your GitHub user access to ${repo}, or use a token that can read it (${SETUP(kind)}).` };
  }
  return { reason: 'unreachable', message: `GitHub isn't answering right now (${err.message}), so LifeCycle couldn't check for updates.`,
    fix: 'Try again in a few minutes.' };
}

const title = (message) => String(message || '').split('\n')[0];

// The newest commit's GitHub Actions state. passed | failed | running | none | unknown.
async function ciState(client, repo, sha) {
  try {
    const { workflow_runs: runs = [] } = await client.request(`/repos/${repo}/actions/runs?head_sha=${sha}&per_page=50`, { what: `${repo} Actions runs` });
    const url = `https://github.com/${repo}/commit/${sha}`;
    if (!runs.length) return { state: 'none', url };
    if (runs.some((r) => r.status === 'completed' && ['failure', 'timed_out', 'cancelled', 'startup_failure', 'action_required'].includes(r.conclusion))) {
      const failed = runs.find((r) => r.conclusion && !['success', 'skipped', 'neutral'].includes(r.conclusion));
      return { state: 'failed', url: failed?.html_url || url, workflow: failed?.name || null };
    }
    if (runs.some((r) => r.status !== 'completed')) {
      const running = runs.find((r) => r.status !== 'completed');
      return { state: 'running', url: running?.html_url || url, workflow: running?.name || null };
    }
    return { state: 'passed', url };
  } catch {
    return { state: 'unknown', url: `https://github.com/${repo}/commit/${sha}` };
  }
}

export async function checkForUpdate({
  appRoot = APP_ROOT, home = homeDir(), repo = SOURCE_REPO(), token, apiUrl, fetchImpl, log = true,
} = {}) {
  const install = installInfo({ appRoot, home });
  const base = {
    checked_at: new Date().toISOString(), repo, branch: SOURCE_BRANCH, install,
    can_upgrade: install.kind === 'installed',
    pull_command: install.kind === 'developer' ? 'git pull origin main && npm install' : null,
  };
  const done = (result) => {
    if (log) {
      logUpdate({ action: 'check', from: install.commit, to: result.latest?.commit || null, outcome: result.state,
        ...(result.behind !== undefined ? { behind: result.behind } : {}), ...(result.error ? { reason: result.error.reason } : {}) });
    }
    return result;
  };
  try {
    const tok = token === undefined ? githubToken() : token;
    if (!tok) throw Object.assign(new Error('no GitHub access'), { reason: 'not_connected' });
    const client = createGithubClient({ apiUrl: apiUrl || loadConfig().sources.github.apiUrl, token: tok, ...(fetchImpl ? { fetchImpl } : {}) });
    const head = await client.request(`/repos/${repo}/commits/${SOURCE_BRANCH}`, { what: repo });
    const latest = { commit: head.sha, date: head.commit?.committer?.date || head.commit?.author?.date || null, title: title(head.commit?.message), url: `https://github.com/${repo}/commit/${head.sha}` };
    if (install.commit && install.commit === latest.commit) {
      return done({ ...base, ok: true, state: 'up_to_date', install: { ...install, date: install.date || latest.date }, latest, behind: 0, commits: [] });
    }
    const ci = await ciState(client, repo, latest.commit);
    if (!install.commit) {
      return done({ ...base, ok: true, state: 'unknown_version', latest, ci, commits: [], compare_url: `https://github.com/${repo}/commits/${SOURCE_BRANCH}` });
    }
    let cmp = null;
    try {
      cmp = await client.request(`/repos/${repo}/compare/${install.commit}...${latest.commit}`, { what: repo });
    } catch (err) {
      if (err.kind !== 'no_access' || err.status !== 404) throw err; // 404 here: the installed commit isn't on GitHub
    }
    if (cmp && (cmp.status === 'behind' || cmp.status === 'identical' || cmp.ahead_by === 0)) {
      // A working copy with commits of its own that main doesn't have yet: nothing newer to get.
      return done({ ...base, ok: true, state: 'up_to_date', latest, behind: 0, commits: [] });
    }
    const commits = (cmp?.commits || []).map((c) => ({ commit: c.sha, title: title(c.commit?.message), date: c.commit?.committer?.date || c.commit?.author?.date || null, url: c.html_url || `https://github.com/${repo}/commit/${c.sha}` })).reverse();
    return done({
      ...base, ok: true, state: 'update_available', latest, ci,
      behind: cmp ? cmp.ahead_by ?? commits.length : null,
      commits,
      compare_url: cmp?.html_url || `https://github.com/${repo}/compare/${install.commit}...${latest.commit}`,
    });
  } catch (err) {
    return done({ ...base, ok: false, state: 'error', error: explainFailure(err, { repo, kind: install.kind }) });
  }
}
