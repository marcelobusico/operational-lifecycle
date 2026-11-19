// GitHub reads for the last-mile check (done vs. turned on), on top of the shared GitHub client:
//  - development: a feature's PRs are merged and the GitHub Actions runs on each merge commit pass;
//  - deploy records: the latest successful GitHub Deployment per service and environment;
//  - containment: whether a deployed commit includes a feature's merge commit (compare API).
// Every function throws SourceError (unreachable | no_access | not_found) on a failed read.
import { SourceError } from '../sources/github-client.js';

const PASSING = new Set(['success', 'skipped', 'neutral']);

export function createLastMileGithub(client) {
  // Whether a repo defines no GitHub Actions workflows, read once per repo. Any failed read keeps the
  // strict answer ("can't be confirmed"), never assumes there is no CI.
  const noWorkflows = new Map();
  function hasNoWorkflows(repo) {
    if (!noWorkflows.has(repo)) {
      noWorkflows.set(repo, client.request(`/repos/${repo}/actions/workflows?per_page=1`, { what: `GitHub Actions workflows in ${repo}` })
        .then((r) => Number(r?.total_count) === 0).catch(() => false));
    }
    return noWorkflows.get(repo);
  }
  // Development state of one PR: merged? and the GitHub Actions verdict on its merge commit.
  async function readPrActions({ repo, number }) {
    const pr = await client.request(`/repos/${repo}/pulls/${number}`, {
      what: `pull request #${number} in ${repo} (needs read access to that repo's pull requests)`,
    });
    const base = {
      repo, number, title: pr.title, link: pr.html_url || `https://github.com/${repo}/pull/${number}`,
      merged: Boolean(pr.merged_at), merged_at: pr.merged_at || null, merge_sha: pr.merged_at ? pr.merge_commit_sha : null,
    };
    if (!base.merged) {
      return { ...base, actions: 'not_merged', actions_link: base.link, detail: pr.state === 'open' ? 'open PR, not merged' : 'closed without merging' };
    }
    const runsOf = async (sha) => (await client.request(`/repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`, {
      what: `GitHub Actions runs in ${repo} (needs read access to Actions)`,
    })).workflow_runs || [];
    // The merge commit's runs are the verdict on what landed; without any, fall back to the PR's own checks.
    let runs = await runsOf(base.merge_sha);
    let actionsLink = `https://github.com/${repo}/commit/${base.merge_sha}`;
    if (!runs.length && pr.head?.sha) {
      runs = await runsOf(pr.head.sha);
      actionsLink = `${base.link}/checks`;
    }
    if (!runs.length) {
      // A repo with no GitHub Actions workflows at all has no CI to wait for: merged is as done as it gets.
      if (await hasNoWorkflows(repo)) return { ...base, actions: 'success', actions_link: base.link, detail: 'merged; this repo has no GitHub Actions workflows (no CI to wait for)' };
      return { ...base, actions: 'none', actions_link: base.link, detail: 'no GitHub Actions ran on this PR or its merge commit, so passing checks can\'t be confirmed' };
    }
    const failed = runs.find((r) => r.status === 'completed' && !PASSING.has(r.conclusion));
    if (failed) return { ...base, actions: 'failure', actions_link: failed.html_url, detail: `GitHub Actions "${failed.name}" ${failed.conclusion}` };
    const running = runs.find((r) => r.status !== 'completed');
    if (running) return { ...base, actions: 'pending', actions_link: running.html_url, detail: `GitHub Actions "${running.name}" still ${running.status}` };
    return { ...base, actions: 'success', actions_link: runs.length === 1 ? runs[0].html_url : actionsLink, detail: `GitHub Actions passed (${runs.map((r) => r.name).join(', ')})` };
  }

  // Latest successful deployment of a repo to one GitHub environment, or { deployed: false }.
  async function readDeployment({ repo, environment }) {
    const what = `deployments of ${repo} to "${environment}" (needs read access to Deployments)`;
    const list = await client.request(`/repos/${repo}/deployments?environment=${encodeURIComponent(environment)}&per_page=30`, { what });
    const link = `https://github.com/${repo}/deployments/${encodeURIComponent(environment)}`;
    for (const d of list) {
      const statuses = await client.request(`/repos/${repo}/deployments/${d.id}/statuses?per_page=1`, { what });
      const latest = statuses[0];
      if (latest?.state !== 'success') continue;
      const payload = typeof d.payload === 'string' ? safeJson(d.payload) : d.payload || {};
      return {
        deployed: true,
        version: payload.version || String(d.ref).replace(/^v(?=\d)/, ''),
        ref: d.ref,
        sha: d.sha,
        deployed_at: latest.created_at || d.created_at,
        deployed_by: d.creator?.login || latest.creator?.login || null,
        // The exact item: the pipeline run that deployed it when the record names one, else the
        // record itself (GitHub has no web page per deployment, only its API record).
        link: latest.log_url || latest.target_url || d.url || `https://api.github.com/repos/${repo}/deployments/${d.id}`,
        link_kind: latest.log_url || latest.target_url ? 'pipeline_run' : 'deploy_record',
        deployment_id: d.id,
        history_link: link,
      };
    }
    // No successful deploy: there is no item to link to (the environment's list is not one).
    return { deployed: false, version: null, ref: null, sha: null, deployed_at: null, deployed_by: null, link: null, link_kind: null, deployment_id: null, history_link: link };
  }

  // True when `head` includes `commit` (head is the commit itself or comes after it).
  async function contains({ repo, commit, head }) {
    if (commit === head) return true;
    try {
      const cmp = await client.request(`/repos/${repo}/compare/${commit}...${head}`, { what: `commit history of ${repo} (needs read access to Contents)` });
      return cmp.status === 'ahead' || cmp.status === 'identical';
    } catch (err) {
      // 404 on compare with access to the repo: the commits share no history, so it's not included.
      if (err instanceof SourceError && err.status === 404) {
        try {
          await client.request(`/repos/${repo}`, { what: repo });
        } catch {
          throw err;
        }
        return false;
      }
      throw err;
    }
  }

  // Release tags of a repo (newest first, up to 100): [{ name, sha, link }].
  async function readTags({ repo }) {
    const list = await client.request(`/repos/${repo}/tags?per_page=100`, { what: `release tags of ${repo} (needs read access to Contents)` });
    return (list || []).map((t) => ({ name: t.name, sha: t.commit?.sha, link: `https://github.com/${repo}/releases/tag/${encodeURIComponent(t.name)}` }));
  }

  return { readPrActions, readDeployment, contains, readTags };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
