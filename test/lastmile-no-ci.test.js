import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLastMileGithub } from '../src/lastmile/github.js';

// A stub GitHub client: one merged PR, no Actions runs, and the given workflow list (or a failed read).
const client = (workflows) => ({
  async request(path) {
    if (path.startsWith('/repos/o/r/pulls/1')) return { title: 'PR', html_url: 'https://github.com/o/r/pull/1', merged_at: '2026-11-05T00:00:00Z', merge_commit_sha: 'abc', head: { sha: 'def' } };
    if (path.includes('/actions/runs')) return { workflow_runs: [] };
    if (path.includes('/actions/workflows')) { if (workflows instanceof Error) throw workflows; return workflows; }
    throw new Error(`unexpected ${path}`);
  },
});

test('a merged PR in a repo with no GitHub Actions workflows counts as developed', async () => {
  const r = await createLastMileGithub(client({ total_count: 0, workflows: [] })).readPrActions({ repo: 'o/r', number: 1 });
  assert.equal(r.actions, 'success');
  assert.match(r.detail, /no GitHub Actions workflows/);
});

test('a repo that has workflows but none ran, or whose workflows cannot be read, stays unconfirmed', async () => {
  for (const w of [{ total_count: 2 }, new Error('no access')]) {
    const r = await createLastMileGithub(client(w)).readPrActions({ repo: 'o/r', number: 1 });
    assert.equal(r.actions, 'none');
  }
});
