// Thin GitHub REST client. Every failure is classified as either "unreachable" (network, outage,
// rate limit, connection disabled) or "no_access" (the person's credentials can't see it), so
// callers never mistake a failed read for a real state.
import { registerSecret } from '../log.js';

export class SourceError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.kind = kind; // 'unreachable' | 'no_access' | 'not_found' | 'conflict'
    this.status = status ?? null;
  }
}

const CACHES = new Map();

export function createGithubClient({ apiUrl, token, enabled = true, fetchImpl = fetch }) {
  registerSecret(token);
  // Last answer per GET route with its ETag. Re-reads ask "changed since?" (If-None-Match): a 304
  // doesn't count against GitHub's rate limit, so refreshing costs almost nothing for work that
  // hasn't moved (merged PRs never do). When the rate limit is reached anyway, the last answer read
  // in this session is used instead of turning every step into "status unavailable".
  // Shared by every client with the same API and token: a new client is built on each refresh.
  const cacheKey = `${apiUrl}|${token || ''}`;
  if (!CACHES.has(cacheKey)) CACHES.set(cacheKey, new Map());
  const cache = CACHES.get(cacheKey);

  async function request(route, { accept = 'application/vnd.github+json', what = route, method = 'GET', body } = {}) {
    if (!enabled) throw new SourceError('unreachable', 'The GitHub connection is disabled in your LifeCycle config.');
    const headers = { accept, 'x-github-api-version': '2022-11-28', 'user-agent': 'lifecycle-local' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const key = method === 'GET' ? `${accept} ${route}` : null;
    const cached = key ? cache.get(key) : null;
    if (cached?.etag) headers['if-none-match'] = cached.etag;
    let res;
    try {
      res = await fetchImpl(`${apiUrl}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    } catch (err) {
      throw new SourceError('unreachable', `GitHub could not be reached (${err.cause?.code || err.cause?.message || err.name}).`);
    }
    if (res.status === 304 && cached) return cached.body;
    if (res.ok) {
      // The timeout also covers reading the body, so a slow or cut-off body is "unreachable" too.
      try {
        const out = await (accept.includes('raw') ? res.text() : res.json());
        const etag = res.headers?.get?.('etag');
        if (key && etag) cache.set(key, { etag, body: out });
        return out;
      } catch (err) {
        throw new SourceError('unreachable', `GitHub's answer could not be read (${err.name === 'TimeoutError' ? 'timed out' : err.name}).`);
      }
    }
    if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
      if (cached) return cached.body;
      throw new SourceError('unreachable', 'GitHub rate limit reached; try again in a few minutes.', 403);
    }
    // Writes: the file changed (or already exists) since it was read.
    if (method !== 'GET' && (res.status === 409 || res.status === 422)) {
      throw new SourceError('conflict', `${what} was changed by someone else in the meantime.`, res.status);
    }
    if (res.status === 401) {
      throw new SourceError('no_access', token
        ? 'GitHub rejected your credentials (expired or revoked token). Run `npm run setup` again.'
        : 'No GitHub credentials are set up. Run `npm run setup`.', 401);
    }
    if (res.status === 403 || res.status === 404) {
      throw new SourceError('no_access', `Your GitHub credentials can't read ${what}.`, res.status);
    }
    throw new SourceError('unreachable', `GitHub answered HTTP ${res.status}.`, res.status);
  }

  return { request };
}
