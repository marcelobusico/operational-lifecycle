// Which pasted links LifeCycle can read for an import (docs/import-format.md). Recognition only: nothing
// is read here. Every entry comes back, so a link LifeCycle can't use is shown with the reason instead
// of being silently dropped.
//
// kinds: jira (a ticket: epic or story, told apart when read), github_repo, github_pr, github_issue,
// github_file (one file at a ref, e.g. a committed doc), confluence (not read yet), unrecognized.
import { JIRA_KEY } from '../definitions.js';

const REPO_PART = /^[A-Za-z0-9_.-]+$/;
const MAX_LINKS = 50;

const jiraEntry = (input, key, url = null) => ({ input, kind: 'jira', key, url, label: `Jira ticket ${key}`, status: 'ok', reason: null });
const unrecognized = (input, reason) => ({ input, kind: 'unrecognized', url: null, label: input, status: 'unrecognized', reason });

function fromUrl(input, u) {
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (host === 'github.com' || host === 'www.github.com') {
    const [owner, name, what, ...rest] = parts;
    if (!owner || !name || !REPO_PART.test(owner) || !REPO_PART.test(name)) return unrecognized(input, 'A GitHub link must name a repository (github.com/owner/repo).');
    const repo = `${owner}/${name.replace(/\.git$/, '')}`;
    const url = `https://github.com/${repo}`;
    if (!what) return { input, kind: 'github_repo', repo, url, label: `GitHub repository ${repo}`, status: 'ok', reason: null };
    if ((what === 'pull' || what === 'issues') && /^[1-9]\d*$/.test(rest[0] || '')) {
      const number = Number(rest[0]);
      const pr = what === 'pull';
      return { input, kind: pr ? 'github_pr' : 'github_issue', repo, number, url: `${url}/${what}/${number}`, label: `${pr ? 'PR' : 'issue'} ${repo}#${number}`, status: 'ok', reason: null };
    }
    if (what === 'blob' && rest.length >= 2) {
      // A branch name may contain slashes (blob/feature/x/docs/plan.md), so the URL alone can't tell
      // where the ref ends: ref and path are the shortest-ref guess, and the reader tries the other
      // splits of `segments` (read-github.js) until one is a file.
      const [ref, ...p] = rest;
      const file = p.join('/');
      return { input, kind: 'github_file', repo, ref, path: file, segments: rest, url: `${url}/blob/${rest.map(encodeURIComponent).join('/')}`, label: `File ${rest.join('/')} in ${repo}`, status: 'ok', reason: null };
    }
    if (what === 'tree' && rest.length <= 1) return { input, kind: 'github_repo', repo, url, label: `GitHub repository ${repo}`, status: 'ok', reason: null };
    return unrecognized(input, 'LifeCycle reads a GitHub repository, a PR, an issue or a single file (a /blob/ link). This GitHub link is none of those.');
  }
  if (host.endsWith('.atlassian.net') || host.endsWith('.jira.com')) {
    if (parts[0] === 'wiki') {
      return { input, kind: 'confluence', url: u.href, label: 'Confluence page', status: 'unsupported', reason: "Confluence pages aren't read yet, so this link is left out of the analysis." };
    }
    const key = (parts[0] === 'browse' && parts[1]) || u.searchParams.get('selectedIssue');
    const k = key ? key.toUpperCase() : null;
    if (k && JIRA_KEY.test(k)) return jiraEntry(input, k, `https://${host}/browse/${k}`);
    return unrecognized(input, 'This Jira link names no ticket. Paste the ticket\'s link (…/browse/ABC-123) or its key.');
  }
  return unrecognized(input, 'Not a Jira ticket or a GitHub repository, PR, issue or file, so it is left out of the analysis.');
}

function one(input) {
  if (/^https?:\/\//i.test(input)) {
    let u;
    try { u = new URL(input); } catch { return unrecognized(input, 'This is not a valid link.'); }
    return fromUrl(input, u);
  }
  if (JIRA_KEY.test(input.toUpperCase()) && /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(input)) return jiraEntry(input, input.toUpperCase());
  const repo = input.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (repo) return fromUrl(input, new URL(`https://github.com/${repo[1]}/${repo[2]}`));
  return unrecognized(input, 'Not a link, a Jira key (ABC-123) or a GitHub owner/repo.');
}

// The text a person pasted → one entry per distinct link, in order. Separated by whitespace or commas.
export function parseLinks(text) {
  const words = String(text || '').split(/[\s,]+/).map((w) => w.trim().replace(/^[<(["']+|[>)\]"'.;]+$/g, '')).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const w of words) {
    const e = one(w);
    const id = linkId(e);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(e);
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

// Same source, however it was written ("ABC-1" and its /browse/ link are one ticket).
export function linkId(e) {
  if (e.kind === 'jira') return `jira:${e.key}`;
  if (e.kind === 'github_repo') return `repo:${e.repo.toLowerCase()}`;
  if (e.kind === 'github_pr' || e.kind === 'github_issue') return `${e.kind}:${e.repo.toLowerCase()}#${e.number}`;
  if (e.kind === 'github_file') return `file:${e.repo.toLowerCase()}@${(e.segments || [e.ref, e.path]).join('/')}`;
  return `other:${e.input}`;
}

export const MAX_IMPORT_LINKS = MAX_LINKS;
