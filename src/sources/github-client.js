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
// When no token works: the usual cause on a Mac is gh working in Terminal only through GITHUB_TOKEN.
const NO_TOKEN_FIX = 'LifeCycle runs at login without your Terminal\'s environment: if gh works for you only through GITHUB_TOKEN, give gh its own login (env -u GITHUB_TOKEN gh auth login), or paste a token with `lifecycle setup`.';

// token: the token, or a function returning the current one. access: optional function returning
// { source, problem } (src/config.js githubAccess), so "no access" messages say which access was used.
export function createGithubClient({ apiUrl, token, access = null, enabled = true, fetchImpl = fetch }) {
  // Last answer per GET route with its ETag. Re-reads ask "changed since?" (If-None-Match): a 304
  // doesn't count against GitHub's rate limit, so refreshing costs almost nothing for work that
  // hasn't moved (merged PRs never do). When the rate limit is reached anyway, the last answer read
  // in this session is used instead of turning every step into "status unavailable".
  // Shared by every client with the same API and token: a new client is built on each refresh.
  const cacheFor = (tok) => {
    const cacheKey = `${apiUrl}|${tok || ''}`;
    if (!CACHES.has(cacheKey)) CACHES.set(cacheKey, new Map());
    return CACHES.get(cacheKey);
  };
  const tokenNow = () => (typeof token === 'function' ? token() : token) || null;
  registerSecret(tokenNow());

  async function request(route, { accept = 'application/vnd.github+json', what = route, method = 'GET', body } = {}) {
    if (!enabled) throw new SourceError('unreachable', 'The GitHub connection is disabled in your LifeCycle config.');
    const token = tokenNow();
    registerSecret(token);
    const cache = cacheFor(token);
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
    const info = access?.() || {};
    const via = info.source ? ` (${info.source})` : '';
    if (!token && (res.status === 401 || res.status === 403 || res.status === 404)) {
      throw new SourceError('no_access', `No GitHub access works for LifeCycle right now${info.problem ? ` (${info.problem})` : ''}, so it can't read ${what}. ${NO_TOKEN_FIX}`, res.status);
    }
    if (res.status === 401) {
      throw new SourceError('no_access', `GitHub rejected your access${via} (expired or revoked). Run \`lifecycle setup\` again.`, 401);
    }
    // An organization with single sign-on hides its repos from a token not authorized for it.
    const sso = res.headers?.get?.('x-github-sso');
    if ((res.status === 403 || res.status === 404) && sso) {
      const link = /url=(\S+)/.exec(sso)?.[1];
      throw new SourceError('no_access', `Your GitHub access${via} isn't authorized for this organization's single sign-on, so it can't read ${what}. Authorize it${link ? ` at ${link}` : ' in GitHub (Settings → Applications, or Developer settings → tokens → Configure SSO)'}; for gh, run: gh auth refresh -h github.com.`, res.status);
    }
    if (res.status === 403 || res.status === 404) {
      const err = new SourceError('no_access', `Your GitHub credentials${via} can't read ${what}.`, res.status);
      // Working credentials, and GitHub says there is nothing there: callers that try alternatives (a
      // /blob/ link's ref/path splits) may go on. The cases above need the person to fix their access.
      err.plainNotFound = res.status === 404;
      throw err;
    }
    throw new SourceError('unreachable', `GitHub answered HTTP ${res.status}.`, res.status);
  }

  return { request };
}
