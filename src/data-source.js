// Where the definition files come from, and exactly which version of them.
//
// Every read is pinned to ONE commit, so a refresh never mixes files from two versions:
//   - GitHub (the default): find the branch's head commit first, then read the file list and every
//     file at that commit. When the repo can't be read, the copy saved on this machine is used and the
//     result says so (which commit, when it was read, and why the latest couldn't be read).
//   - A local data folder that is a git clone of LifeCycle-Data: pull the configured branch first,
//     then read every file at the commit the clone is on after the pull. A failed pull still reads the
//     clone's current commit, flagged as "may not be the latest".
//   - A local folder that is not a git clone (e.g. a checked-out copy): read as it is on disk; there is no commit.
// Every read is logged once (src/log.js source-reads log) with the commit read, or the failure and
// the fallback used, so a "refresh didn't update" report can be traced.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { paths, writeJson } from './config.js';
import { logSourceRead } from './log.js';
import { SourceError } from './sources/github-client.js';

const run = promisify(execFile);
export const DEFINITION_PATH = /^(?:(features|projects|services|teams|apps|changes|store-snapshots|flag-snapshots|jira-snapshots)\/[^/]+\.ya?ml|team\.ya?ml)$/;
const FOLDERS = ['projects', 'services', 'teams', 'apps', 'features', 'changes', 'store-snapshots', 'flag-snapshots', 'jira-snapshots'];
const cacheFile = () => path.join(paths.cacheDir(), 'definitions.json');
const short = (sha) => (sha ? sha.slice(0, 7) : null);
export const commitUrl = (repo, sha) => (repo && sha ? `https://github.com/${repo}/commit/${sha}` : null);

// Returns {
//   files: [{ path, text }],
//   kind: 'github' | 'local_clone' | 'local_folder', repo, branch, path,
//   commit: { sha, short, url } | null,
//   readAt: when the files shown were read (for a saved copy: when that copy was read),
//   stale: true when these are not the latest of the branch,
//   fallback: null | 'saved_copy' | 'clone_current',
//   error: { kind, source, message } | null,
// }
// atLeast: a commit this read must include (one LifeCycle just published). If GitHub still answers
// with an older head right after the push, the read uses that commit instead.
export async function fetchDefinitionFiles(config, github, { atLeast = null } = {}) {
  if (config.dataPath) return readLocal(config);
  return readGithub(config, github, atLeast);
}

async function readGithub(config, github, atLeast) {
  const repo = config.dataRepo;
  const branch = config.dataBranch;
  const target = `${repo}@${branch}`;
  const base = { kind: 'github', repo, branch, path: null };
  try {
    if (!repo) throw new SourceError('not_found', 'No shared feature repo is set up yet. Run setup (npm run setup) and enter the GitHub repo (owner/name) where your team keeps its LifeCycle data, or set LIFECYCLE_DATA_REPO.');
    const ref = await github.request(`/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, { what: `the ${branch} branch of ${repo}` });
    let sha = ref?.object?.sha;
    if (!sha) throw new SourceError('unreachable', `GitHub did not say which commit ${branch} is on.`);
    if (atLeast && atLeast !== sha) {
      // Right after a push GitHub can still answer with the previous head for a moment.
      const cmp = await github.request(`/repos/${repo}/compare/${atLeast}...${sha}`, { what: `the history of ${repo}` });
      if (cmp?.status === 'behind') sha = atLeast;
    }
    const tree = await github.request(`/repos/${repo}/git/trees/${sha}?recursive=1`, { what: `the shared repo ${repo}` });
    if (tree.truncated) throw new SourceError('unreachable', `GitHub returned only part of the file list of ${repo}.`);
    const entries = tree.tree.filter((e) => e.type === 'blob' && DEFINITION_PATH.test(e.path));
    const files = await Promise.all(entries.map(async (e) => ({
      path: e.path,
      text: await github.request(`/repos/${repo}/contents/${e.path}?ref=${sha}`, {
        accept: 'application/vnd.github.raw+json', what: `${e.path} in ${repo}`,
      }),
    })));
    const readAt = new Date().toISOString();
    const commit = { sha, short: short(sha), url: commitUrl(repo, sha) };
    writeJson(cacheFile(), { repo, branch, syncedAt: readAt, commit, files });
    logSourceRead({ source: 'github', feature: '*', target, outcome: 'ok', commit: sha, detail: `${files.length} definition files at ${short(sha)}` });
    return { ...base, files, commit, readAt, stale: false, fallback: null, error: null };
  } catch (err) {
    if (!(err instanceof SourceError)) throw err;
    const cached = readCache(repo);
    const fallback = cached
      ? `showing the saved copy${cached.commit?.sha ? ` at ${short(cached.commit.sha)}` : ''} read ${cached.syncedAt}`
      : 'no saved copy on this machine: showing nothing';
    logSourceRead({ source: 'github', feature: '*', target, outcome: err.kind, status: err.status, commit: cached?.commit?.sha || null, detail: err.message, fallback });
    return {
      ...base,
      files: cached?.files || [],
      commit: cached?.commit?.sha ? { sha: cached.commit.sha, short: short(cached.commit.sha), url: commitUrl(repo, cached.commit.sha) } : null,
      readAt: cached?.syncedAt || null,
      stale: true,
      fallback: 'saved_copy',
      error: { kind: err.kind, source: `github:${repo}`, message: err.message },
    };
  }
}

function readCache(repo) {
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    return cached.repo === repo ? cached : null;
  } catch {
    return null;
  }
}

const git = (dir, args, opts = {}) => run('git', ['-C', dir, ...args], {
  encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 20000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...opts,
}).then((r) => r.stdout);

// Is `dir` itself the top of a git clone (not just a folder inside some other repository)?
export async function isGitClone(dir) {
  try {
    const top = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
    return fs.realpathSync(top) === fs.realpathSync(dir);
  } catch {
    return false;
  }
}

// A GitHub "owner/name" for the clone's origin, when it is on GitHub (for the commit link).
async function originRepo(dir) {
  try {
    const url = (await git(dir, ['remote', 'get-url', 'origin'])).trim();
    const m = url.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function readLocal(config) {
  const dir = config.dataPath;
  const branch = config.dataBranch;
  if (!(await isGitClone(dir))) {
    const files = readFolder(dir);
    logSourceRead({ source: 'local-folder', feature: '*', target: dir, outcome: 'ok', commit: null, detail: `${files.length} definition files read from disk (not a git clone, so no commit)` });
    return { kind: 'local_folder', repo: null, branch: null, path: dir, files, commit: null, readAt: new Date().toISOString(), stale: false, fallback: null, error: null };
  }
  const repo = await originRepo(dir);
  let error = null;
  try {
    const current = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (current !== branch) throw new Error(`the clone is on branch "${current}", not "${branch}"`);
    await git(dir, ['pull', '--ff-only', '--quiet', 'origin', branch]);
  } catch (err) {
    const why = String(err.stderr || err.message || err).trim().split('\n').filter(Boolean).pop() || 'git pull failed';
    error = { kind: err.killed ? 'timeout' : 'pull_failed', source: `local:${dir}`, message: `git pull of ${branch} failed: ${why.replace(/^fatal: /, '')}` };
  }
  try {
    const sha = (await git(dir, ['rev-parse', 'HEAD'])).trim();
    const names = (await git(dir, ['ls-tree', '-r', '--name-only', '-z', sha])).split('\0').filter((p) => DEFINITION_PATH.test(p));
    const files = await Promise.all(names.map(async (p) => ({ path: p, text: await git(dir, ['show', `${sha}:${p}`]) })));
    const readAt = new Date().toISOString();
    logSourceRead({ source: 'local-clone', feature: '*', target: `${dir}@${branch}`, outcome: error ? error.kind : 'ok', commit: sha,
      detail: error ? error.message : `pulled; ${files.length} definition files at ${short(sha)}`,
      ...(error ? { fallback: `showing the clone's current commit ${short(sha)}, which may not be the latest ${branch}` } : {}) });
    return { kind: 'local_clone', repo, branch, path: dir, files, commit: { sha, short: short(sha), url: commitUrl(repo, sha) }, readAt,
      stale: Boolean(error), fallback: error ? 'clone_current' : null, error };
  } catch (err) {
    const message = `the clone at ${dir} could not be read: ${String(err.stderr || err.message).trim()}`;
    logSourceRead({ source: 'local-clone', feature: '*', target: `${dir}@${branch}`, outcome: 'unreadable', commit: null, detail: message, fallback: 'none' });
    return { kind: 'local_clone', repo, branch, path: dir, files: [], commit: null, readAt: null, stale: true, fallback: 'clone_current',
      error: { kind: 'unreadable', source: `local:${dir}`, message } };
  }
}

function readFolder(dir) {
  const files = [];
  for (const sub of FOLDERS) {
    const full = path.join(dir, sub);
    const names = fs.existsSync(full) ? fs.readdirSync(full).filter((n) => /\.ya?ml$/.test(n)).sort() : [];
    for (const n of names) files.push({ path: `${sub}/${n}`, text: fs.readFileSync(path.join(full, n), 'utf8') });
  }
  for (const n of ['team.yaml', 'team.yml']) {
    if (fs.existsSync(path.join(dir, n))) files.push({ path: n, text: fs.readFileSync(path.join(dir, n), 'utf8') });
  }
  return files;
}

// A LifeCycle publish into a local clone becomes a local commit (never pushed), so the next read,
// which is at the clone's commit, shows it. Uses the person's git identity, else "LifeCycle".
export async function commitInClone(dir, file, message) {
  if (!(await isGitClone(dir))) return null;
  await git(dir, ['add', '-A', '--', file]);
  try {
    await git(dir, ['commit', '--quiet', '-m', message, '--', file]);
  } catch (err) {
    if (!/user\.(name|email)|identity|tell me who you are/i.test(String(err.stderr || err.message))) throw err;
    await git(dir, ['-c', 'user.name=LifeCycle', '-c', 'user.email=lifecycle@localhost', 'commit', '--quiet', '-m', message, '--', file]);
  }
  return (await git(dir, ['rev-parse', 'HEAD'])).trim();
}

// Writes one file LifeCycle itself maintains (a snapshot) to the shared data: a commit on the data
// branch through GitHub, or a local commit in a clone. Replaces the file when it already exists.
export async function writeDataFile({ config, github, file, text, message }) {
  if (config.dataPath) {
    const full = path.join(config.dataPath, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
    await commitInClone(config.dataPath, file, message);
    return;
  }
  let sha;
  try {
    sha = (await github.request(`/repos/${config.dataRepo}/contents/${file}?ref=${encodeURIComponent(config.dataBranch)}`, { what: `${file} in ${config.dataRepo}` })).sha;
  } catch (err) {
    if (!(err.status === 404)) throw err;
  }
  await github.request(`/repos/${config.dataRepo}/contents/${file}`, { method: 'PUT', what: `${file} in ${config.dataRepo}`,
    body: { message, content: Buffer.from(text).toString('base64'), branch: config.dataBranch, ...(sha ? { sha } : {}) } });
}
