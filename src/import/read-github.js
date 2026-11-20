// GitHub links as import sources, read with the person's own GitHub access and GET requests only.
//   repository: README, the Markdown files in docs/, and the most recently updated PRs and issues
//               (open and closed). Source code is never read to infer features.
//   PR / issue: that one, with its description.
//   file:       that one file at the linked ref (e.g. a plan committed to the repo).
// Every list is cut to the caps in config `import`; what is skipped is said in left_out.
import { SourceError } from '../sources/github-client.js';
import { evidenceKey } from './analyze.js';

const RAW = 'application/vnd.github.raw';
const DOC = /\.(md|mdx|markdown|txt|rst|adoc)$/i;
const BODY_MAX = 2000; // a PR's or issue's description, in a repository's list
const ISSUE_PAGE = 100; // GitHub's largest page
const ISSUE_PAGES = 3;
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
const cut = (s, max) => (typeof s === 'string' ? (s.length > max ? `${s.slice(0, max)}\n[… cut at ${max} characters]` : s) : '');
const reasonOf = (err) => (err instanceof SourceError ? err.message : `GitHub couldn't be read: ${err.message}`);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// get(route, opts): a GET through LifeCycle's GitHub client (app.githubRead). Called only after the
// repository itself was read, so a 404 here means "there is none" (no README, no docs/ folder).
async function readOptional(get, route, opts) {
  try { return await get(route, opts); } catch (err) {
    if (err?.status === 404) return null;
    throw err;
  }
}

const itemText = (kind, x) => [
  `${kind === 'pr' ? 'PR' : 'Issue'} #${x.number}: ${x.title}`,
  `State: ${x.merged_at ? 'merged' : x.state}${x.user?.login ? ` · Author: @${x.user.login}` : ''}`,
  x.body ? cut(x.body, BODY_MAX) : '(no description)',
].join('\n');

async function readRepo(get, e, caps) {
  const repoInfo = await get(`/repos/${e.repo}`, { what: `the repository ${e.repo}` });
  const html = typeof repoInfo?.html_url === 'string' && /^https:\/\//.test(repoInfo.html_url) ? repoInfo.html_url : `https://github.com/${e.repo}`;
  const branch = repoInfo?.default_branch || 'HEAD';
  const docs = [];
  const evidence = [];
  const leftOut = [];
  const readme = await readOptional(get, `/repos/${e.repo}/readme`, { accept: RAW, what: `the README of ${e.repo}` });
  if (typeof readme === 'string' && readme.trim()) docs.push({ origin: `${html}#readme`, title: `README of ${e.repo}`, text: cut(readme, caps.maxCharsPerSource) });
  const listing = await readOptional(get, `/repos/${e.repo}/contents/docs`, { what: `the docs folder of ${e.repo}` });
  const files = (Array.isArray(listing) ? listing : []).filter((f) => f?.type === 'file' && DOC.test(f.name || '')).sort((a, b) => a.name.localeCompare(b.name));
  for (const f of files.slice(0, caps.maxDocsPerRepo)) {
    const text = await readOptional(get, `/repos/${e.repo}/contents/${enc(f.path)}`, { accept: RAW, what: `${f.path} in ${e.repo}` });
    if (typeof text === 'string' && text.trim()) docs.push({ origin: `${html}/blob/${branch}/${enc(f.path)}`, title: `${f.path} in ${e.repo}`, text: cut(text, caps.maxCharsPerSource) });
  }
  if (files.length > caps.maxDocsPerRepo) leftOut.push(`${plural(files.length - caps.maxDocsPerRepo, 'more file', 'more files')} in docs/ not read (limit ${caps.maxDocsPerRepo})`);
  // One more than the cap, so the result can say older ones were left out; in pages of at most 100.
  const prList = [];
  const prPage = Math.min(ISSUE_PAGE, caps.maxPrsPerRepo + 1);
  for (let page = 1; prList.length <= caps.maxPrsPerRepo; page += 1) {
    const got = await get(`/repos/${e.repo}/pulls?state=all&sort=updated&direction=desc&per_page=${prPage}&page=${page}`, { what: `the PRs of ${e.repo}` });
    const list = Array.isArray(got) ? got : [];
    prList.push(...list);
    if (list.length < prPage) break;
  }
  for (const p of prList.slice(0, caps.maxPrsPerRepo)) {
    const ev = { source: 'github', type: 'pr', repo: e.repo, number: p.number, title: p.title, url: `${html}/pull/${p.number}` };
    docs.push({ origin: `${html}/pull/${p.number}`, title: `PR ${e.repo}#${p.number}: ${p.title}`, text: itemText('pr', p), evidence: evidenceKey(ev) });
    evidence.push(ev);
  }
  if (prList.length > caps.maxPrsPerRepo) leftOut.push(`older PRs not read (only the ${caps.maxPrsPerRepo} most recently updated)`);
  // GitHub's issues list has the PRs in it too, so on a busy repository one page may hold no issues at
  // all: read pages until there are enough issues or the list ends (at most ISSUE_PAGES pages).
  const issueList = [];
  let listEnded = false;
  for (let page = 1; page <= ISSUE_PAGES && issueList.length <= caps.maxIssuesPerRepo; page += 1) {
    const got = await get(`/repos/${e.repo}/issues?state=all&sort=updated&direction=desc&per_page=${ISSUE_PAGE}&page=${page}`, { what: `the issues of ${e.repo}` });
    const list = Array.isArray(got) ? got : [];
    issueList.push(...list.filter((i) => !i.pull_request));
    if (list.length < ISSUE_PAGE) { listEnded = true; break; }
  }
  for (const i of issueList.slice(0, caps.maxIssuesPerRepo)) {
    const ev = { source: 'github', type: 'issue', repo: e.repo, number: i.number, title: i.title, url: `${html}/issues/${i.number}` };
    docs.push({ origin: `${html}/issues/${i.number}`, title: `Issue ${e.repo}#${i.number}: ${i.title}`, text: itemText('issue', i), evidence: evidenceKey(ev) });
    evidence.push(ev);
  }
  if (issueList.length > caps.maxIssuesPerRepo) leftOut.push(`older issues not read (only the ${caps.maxIssuesPerRepo} most recently updated)`);
  else if (!listEnded) leftOut.push(`older issues not looked for: only the ${ISSUE_PAGES * ISSUE_PAGE} most recently updated PRs and issues were checked, and ${issueList.length ? `only ${plural(issueList.length, 'was an issue', 'were issues')}` : 'none was an issue'}`);
  const docCount = docs.length - evidence.length;
  const counts = [docCount && plural(docCount, 'document', 'documents'),
    prList.length && plural(Math.min(prList.length, caps.maxPrsPerRepo), 'PR', 'PRs'), issueList.length && plural(Math.min(issueList.length, caps.maxIssuesPerRepo), 'issue', 'issues')].filter(Boolean);
  return { status: 'read', reason: null, label: `GitHub repository ${e.repo}${counts.length ? ` (${counts.join(', ')} read)` : ' (nothing to read)'}`, url: html, docs, evidence, left_out: leftOut };
}

async function readItem(get, e) {
  const pr = e.kind === 'github_pr';
  const x = await get(`/repos/${e.repo}/${pr ? 'pulls' : 'issues'}/${e.number}`, { what: `${pr ? 'PR' : 'issue'} #${e.number} in ${e.repo}` });
  const type = pr || x?.pull_request ? 'pr' : 'issue';
  const ev = { source: 'github', type, repo: e.repo, number: e.number, title: x.title, url: e.url };
  return {
    status: 'read', reason: null, label: `${type === 'pr' ? 'PR' : 'Issue'} ${e.repo}#${e.number}: ${x.title}`, url: e.url,
    docs: [{ origin: e.url, title: `${type === 'pr' ? 'PR' : 'Issue'} ${e.repo}#${e.number}: ${x.title}`, text: itemText(type, x), evidence: evidenceKey(ev) }],
    evidence: [ev],
    left_out: [],
  };
}

// The ways a /blob/ link's segments split into ref + path, shortest ref first (main/docs/a.md, then a
// branch with slashes: feature/x + docs/a.md, …).
export function fileSplits(e) {
  const segs = e.segments?.length >= 2 ? e.segments : [e.ref, ...e.path.split('/')];
  return segs.slice(0, -1).map((_, i) => ({ ref: segs.slice(0, i + 1).join('/'), path: segs.slice(i + 1).join('/') }));
}

async function readFile(get, e, caps) {
  let text = null;
  let at = null;
  let first = null; // the first 404, for its kind
  for (const split of fileSplits(e)) {
    try {
      text = await get(`/repos/${e.repo}/contents/${enc(split.path)}?ref=${encodeURIComponent(split.ref)}`, { accept: RAW, what: `${split.path} in ${e.repo} (${split.ref})` });
      at = split;
      break;
    } catch (err) {
      // A plain 404: not a file at this ref (or no such ref): try the next split. Anything else (no
      // GitHub access, single sign-on, rate limit) is the answer, with its own fix.
      if (!(err?.status === 404 && err.plainNotFound)) throw err;
      first ||= err;
    }
  }
  // Every split was a 404: name the whole link, since which part is the ref is unknown.
  if (!at) throw new SourceError(first.kind, `${e.repo} has no file at ${fileSplits(e)[0].ref}/${fileSplits(e)[0].path}, or your GitHub credentials can't read it. Check the link (branch and path).`, 404);
  const s = typeof text === 'string' ? text : '';
  return {
    status: 'read', reason: null, label: `File ${at.path} in ${e.repo} (${at.ref})`, url: e.url,
    docs: [{ origin: e.url, title: `${at.path} in ${e.repo}`, text: cut(s, caps.maxCharsPerSource) }],
    evidence: [],
    left_out: s.length > caps.maxCharsPerSource ? [`the file is longer than ${caps.maxCharsPerSource} characters; the rest was not read`] : [],
  };
}

// One GitHub link → { status, reason, label, url, docs, evidence, left_out }. Never throws.
export async function readGithubSource({ entry, get, caps }) {
  try {
    if (entry.kind === 'github_repo') return await readRepo(get, entry, caps);
    if (entry.kind === 'github_pr' || entry.kind === 'github_issue') return await readItem(get, entry);
    if (entry.kind === 'github_file') return await readFile(get, entry, caps);
    return { status: 'failed', reason: 'Not a GitHub link LifeCycle reads.', docs: [], evidence: [], left_out: [] };
  } catch (err) {
    return { status: 'failed', reason: reasonOf(err), docs: [], evidence: [], left_out: [] };
  }
}
