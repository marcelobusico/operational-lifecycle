import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGithubClient } from '../src/sources/github-client.js';

// A fake fetch that answers from a script of responses and records the request headers.
function fakeFetch(answers) {
  const seen = [];
  const impl = async (url, { headers }) => {
    seen.push(headers);
    const a = answers.shift();
    return { ok: a.status >= 200 && a.status < 300, status: a.status,
      headers: new Map(Object.entries(a.headers || {})), json: async () => a.body, text: async () => JSON.stringify(a.body) };
  };
  return { impl, seen };
}

test('a re-read sends the ETag and a 304 returns the last answer (free under the rate limit)', async () => {
  const f = fakeFetch([{ status: 200, headers: { etag: '"v1"' }, body: { merged_at: 'x' } }, { status: 304 }]);
  const gh = createGithubClient({ apiUrl: 'http://gh1', token: 't', fetchImpl: f.impl });
  assert.deepEqual(await gh.request('/repos/o/r/pulls/1'), { merged_at: 'x' });
  assert.deepEqual(await gh.request('/repos/o/r/pulls/1'), { merged_at: 'x' });
  assert.equal(f.seen[1]['if-none-match'], '"v1"');
});

test('at the rate limit, a route read before returns its last answer; one never read stays unreachable', async () => {
  const limited = { status: 403, headers: { 'x-ratelimit-remaining': '0' } };
  const f = fakeFetch([{ status: 200, headers: { etag: '"v1"' }, body: { n: 1 } }, limited, limited]);
  const gh = createGithubClient({ apiUrl: 'http://gh2', token: 't', fetchImpl: f.impl });
  await gh.request('/a');
  assert.deepEqual(await gh.request('/a'), { n: 1 });
  await assert.rejects(gh.request('/b'), (e) => e.kind === 'unreachable' && /rate limit/.test(e.message));
});

test('the last answers survive a new client (one is built per refresh)', async () => {
  const f = fakeFetch([{ status: 200, headers: { etag: '"v1"' }, body: { n: 1 } }, { status: 304 }]);
  await createGithubClient({ apiUrl: 'http://gh3', token: 't', fetchImpl: f.impl }).request('/a');
  assert.deepEqual(await createGithubClient({ apiUrl: 'http://gh3', token: 't', fetchImpl: f.impl }).request('/a'), { n: 1 });
  assert.equal(f.seen[1]['if-none-match'], '"v1"');
});
