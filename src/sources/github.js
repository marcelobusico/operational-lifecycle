// GitHub evidence: pull requests (merged = done) and issues (closed as completed = done).
import { SourceError } from './github-client.js';

export function createGithubSource(client) {
  // GitHub answers 404 both for "no such PR" and for "can't see this private repo"; probe the
  // repo to tell a wrong number in the definition apart from missing access.
  async function explain404(err, { repo, number, type }) {
    if (err.kind !== 'no_access' || err.status !== 404) throw err;
    try {
      await client.request(`/repos/${repo}`, { what: repo });
    } catch {
      throw err;
    }
    const kind = type === 'pr' ? 'pull request' : 'issue';
    throw new SourceError('not_found', `${repo} has no ${kind} #${number}. Check the number in the feature definition.`, 404);
  }

  async function readPr({ repo, number }) {
    const pr = await client.request(`/repos/${repo}/pulls/${number}`, {
      what: `pull request #${number} in ${repo} (needs read access to that repo's pull requests)`,
    });
    const base = { title: pr.title, url: pr.html_url, author: pr.user?.login || null, opened_at: pr.created_at || null, closed_at: pr.merged_at || null };
    if (pr.merged_at) return { ...base, state: 'done', detail: `merged ${pr.merged_at.slice(0, 10)}` };
    if (pr.state === 'open') return { ...base, state: 'in_progress', detail: pr.draft ? 'draft PR' : 'open PR, not merged' };
    return { ...base, state: 'not_done', detail: 'closed without merging' };
  }

  async function readIssue({ repo, number }) {
    const issue = await client.request(`/repos/${repo}/issues/${number}`, {
      what: `issue #${number} in ${repo} (needs read access to that repo's issues)`,
    });
    const base = { title: issue.title, url: issue.html_url, author: issue.user?.login || null, opened_at: issue.created_at || null, closed_at: issue.closed_at || null };
    if (issue.state === 'open') return { ...base, state: 'in_progress', detail: 'open issue' };
    if (issue.state_reason === 'not_planned') return { ...base, state: 'not_done', detail: 'closed as not planned' };
    return { ...base, state: 'done', detail: `closed ${issue.closed_at?.slice(0, 10) || ''}`.trim() };
  }

  return {
    readEvidence(evidence) {
      const read = evidence.type === 'pr' ? readPr(evidence) : readIssue(evidence);
      return read.catch((err) => explain404(err, evidence));
    },
    // Where a person can look even when the API can't be read.
    linkFor({ type, repo, number }) {
      return `https://github.com/${repo}/${type === 'pr' ? 'pull' : 'issues'}/${number}`;
    },
  };
}
