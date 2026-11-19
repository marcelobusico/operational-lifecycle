// A small stand-in for the GitHub REST API, enough for LifeCycle's reads. Tests mutate `state`
// (merge a PR, add a definition file, take GitHub down, revoke access) and refresh.
import http from 'node:http';
import crypto from 'node:crypto';

export function startFakeGithub({ token = 'test-token-not-a-real-credential' } = {}) {
  const state = {
    down: false,
    downPaths: [],       // regexes: requests whose path matches answer 503 (one source down, the rest up)
    readable: new Set(), // repos the token can see
    files: new Map(),    // "owner/repo" -> Map(path -> text)
    prs: new Map(),      // "owner/repo#n" -> { title, state, merged_at, draft }
    issues: new Map(),   // "owner/repo#n" -> { title, state, state_reason, closed_at }
    runs: new Map(),        // "owner/repo@sha" -> [{ name, status, conclusion, html_url }]
    deployments: new Map(), // "owner/repo:environment" -> [{ id, sha, ref, payload, at, by, status }] oldest first
    ancestors: new Map(),   // sha -> Set(shas it includes)
    tags: new Map(),        // "owner/repo" -> [{ name, sha }] newest first (release tags)
    requests: [],
    login: 'tester',     // GET /user
    writable: new Set(), // repos the token can commit to (PUT contents)
    readOnlyLogins: new Set(), // users (by login) who can read but not write any repo
    commits: [],         // { repo, path, message, branch, by, at, op }
    beforeWrite: null,   // test hook: async (repo, path) => void, runs before a PUT is applied
    history: new Map(),  // "owner/repo" -> commits on main, oldest first: [{ sha, message, date }] (update check)
    tarballs: new Map(), // "owner/repo@sha" -> Buffer, a .tar.gz like GitHub's tarball of that commit
    rateLimited: false,  // every request answers 403 with x-ratelimit-remaining: 0
    // Branch heads: every time a repo's files differ from its last commit, the next look at the
    // branch makes a new commit (a frozen copy of the files). Reads by commit sha use that copy.
    snapshots: new Map(), // sha -> Map(path -> text)
    heads: new Map(),     // "owner/repo" -> [sha] oldest first (definitions reads; not the update check's history)
    staleRef: null,       // test hook: (repo) => sha | null, a head GitHub still answers with right after a push
    afterTree: null,      // test hook: async (repo) => void, runs after a file list is served
    refDelay: null,       // test hook: async (repo) => void, runs before the branch head is answered
  };
  // The repo's head commit, committing the current files first when they changed.
  state.head = (repo) => {
    const list = state.heads.get(repo) || [];
    const last = list[list.length - 1];
    const files = state.files.get(repo) || new Map();
    const same = last && sameFiles(state.snapshots.get(last), files);
    if (same) return last;
    const next = crypto.createHash('sha1').update(`${last || ''}\n${[...files].sort().map(([k, v]) => `${k}\0${v}`).join('\0')}`).digest('hex');
    state.snapshots.set(next, new Map(files));
    state.heads.set(repo, [...list, next]);
    return next;
  };
  const sameFiles = (a, b) => a.size === b.size && [...b].every(([k, v]) => a.get(k) === v);
  let nextDeployment = 1;
  // Test helper: record a successful deployment of `sha` (which includes `includes`) to an environment.
  state.deploy = (repo, environment, { sha, version, includes = [], at = new Date().toISOString(), by = 'deployer', status = 'success', log_url = '' }) => {
    const key = `${repo}:${environment}`;
    state.deployments.set(key, [...(state.deployments.get(key) || []), { id: nextDeployment++, sha, ref: `v${version}`, payload: { version }, at, by, status, log_url }]);
    state.ancestors.set(sha, new Set([...(state.ancestors.get(sha) || []), ...includes]));
  };
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

  const sha = (text) => crypto.createHash('sha1').update(text).digest('hex');
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    state.requests.push({ url: req.url, auth: req.headers.authorization, method: req.method, body: raw });
    if (state.down || state.downPaths.some((r) => r.test(req.url))) return json(res, 503, { message: 'Service Unavailable' });
    if (state.rateLimited) {
      res.writeHead(403, { 'content-type': 'application/json', 'x-ratelimit-remaining': '0' });
      return res.end(JSON.stringify({ message: 'API rate limit exceeded' }));
    }
    if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { message: 'Bad credentials' });
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/user') return json(res, 200, { login: state.login });
    const m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)?$/);
    if (!m) return json(res, 404, { message: 'Not Found' });
    const [, repo, rest = ''] = m;
    if (!state.readable.has(repo)) return json(res, 404, { message: 'Not Found' });
    if (rest === '') return json(res, 200, { full_name: repo, permissions: { pull: true, push: state.writable.has(repo) && !state.readOnlyLogins.has(state.login) } });
    // Update check: the newest commit of a branch, a tarball of a commit, and compare (below).
    const branchHead = rest.match(/^\/commits\/([^/]+)$/);
    if (branchHead && state.history.has(repo)) {
      const list = state.history.get(repo);
      const c = branchHead[1] === 'main' ? list[list.length - 1] : list.find((x) => x.sha === branchHead[1]);
      if (!c) return json(res, 404, { message: 'No commit found' });
      return json(res, 200, { sha: c.sha, commit: { message: c.message, committer: { date: c.date }, author: { date: c.date } } });
    }
    const tarball = rest.match(/^\/tarball\/([^/]+)$/);
    if (tarball) {
      const body = state.tarballs.get(`${repo}@${tarball[1]}`);
      if (!body) return json(res, 404, { message: 'Not Found' });
      res.writeHead(200, { 'content-type': 'application/x-gzip' });
      return res.end(body);
    }
    if (rest.startsWith('/compare/') && state.history.has(repo)) {
      const [base, head] = rest.slice('/compare/'.length).split('...');
      const list = state.history.get(repo);
      const b = list.findIndex((x) => x.sha === base), h = list.findIndex((x) => x.sha === head);
      if (b < 0 || h < 0) return json(res, 404, { message: 'Not Found' });
      const between = list.slice(b + 1, h + 1);
      return json(res, 200, {
        status: h === b ? 'identical' : h > b ? 'ahead' : 'behind', ahead_by: Math.max(0, h - b), behind_by: Math.max(0, b - h),
        html_url: `https://github.com/${repo}/compare/${base}...${head}`,
        commits: between.map((c) => ({ sha: c.sha, html_url: `https://github.com/${repo}/commit/${c.sha}`, commit: { message: c.message, committer: { date: c.date } } })),
      });
    }
    if (rest === '/commits') {
      const file = url.searchParams.get('path');
      const list = state.commits.filter((c) => c.repo === repo && (!file || c.path === file)).reverse()
        .map((c) => ({ sha: sha(c.message + c.at), author: { login: c.by }, commit: { message: c.message, author: { name: c.by, date: c.at } } }));
      return json(res, 200, list.slice(0, Number(url.searchParams.get('per_page')) || 30));
    }
    if (rest.startsWith('/contents/') && req.method === 'DELETE') {
      const file = decodeURIComponent(rest.slice('/contents/'.length));
      if (!state.writable.has(repo) || state.readOnlyLogins.has(state.login)) return json(res, 403, { message: 'Resource not accessible' });
      const body = JSON.parse(raw);
      const files = state.files.get(repo);
      const current = files.get(file);
      if (current === undefined) return json(res, 404, { message: 'Not Found' });
      if (body.sha !== sha(current)) return json(res, 409, { message: `${file} does not match ${body.sha}` });
      files.delete(file);
      state.commits.push({ repo, path: file, message: body.message, branch: body.branch, by: state.login, at: new Date().toISOString(), op: 'delete' });
      return json(res, 200, { commit: { message: body.message, sha: state.head(repo) } });
    }
    const hr = rest.match(/^\/git\/ref\/heads\/(.+)$/);
    if (hr) {
      if (state.refDelay) await state.refDelay(repo);
      return json(res, 200, { ref: `refs/heads/${decodeURIComponent(hr[1])}`, object: { type: 'commit', sha: state.staleRef?.(repo) || state.head(repo) } });
    }
    if (rest.startsWith('/git/trees/')) {
      const ref = decodeURIComponent(rest.slice('/git/trees/'.length));
      const files = state.snapshots.get(ref) || state.files.get(repo) || new Map();
      const tree = [...files.keys()].map((p) => ({ path: p, type: 'blob' }));
      if (state.afterTree) await state.afterTree(repo);
      return json(res, 200, { tree, truncated: false });
    }
    if (rest.startsWith('/contents/') && req.method === 'PUT') {
      const file = decodeURIComponent(rest.slice('/contents/'.length));
      if (!state.writable.has(repo) || state.readOnlyLogins.has(state.login)) return json(res, 403, { message: 'Resource not accessible' });
      const body = JSON.parse(raw);
      if (state.beforeWrite) await state.beforeWrite(repo, file);
      const files = state.files.get(repo);
      const current = files.get(file);
      if (current !== undefined && !body.sha) return json(res, 422, { message: '"sha" wasn\'t supplied.' });
      if (current !== undefined && body.sha !== sha(current)) return json(res, 409, { message: `${file} does not match ${body.sha}` });
      if (current === undefined && body.sha) return json(res, 404, { message: 'Not Found' });
      const text = Buffer.from(body.content, 'base64').toString('utf8');
      files.set(file, text);
      state.commits.push({ repo, path: file, message: body.message, branch: body.branch, by: state.login, at: new Date().toISOString(), op: current === undefined ? 'create' : 'update', before: current, after: text });
      return json(res, current === undefined ? 201 : 200, { content: { path: file, sha: sha(text) }, commit: { sha: state.head(repo), message: body.message } });
    }
    if (rest.startsWith('/contents/')) {
      const ref = url.searchParams.get('ref');
      const text = (state.snapshots.get(ref) || state.files.get(repo))?.get(decodeURIComponent(rest.slice('/contents/'.length)));
      if (text === undefined) return json(res, 404, { message: 'Not Found' });
      if (!String(req.headers.accept).includes('raw')) return json(res, 200, { sha: sha(text), encoding: 'base64', content: Buffer.from(text).toString('base64') });
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(text);
    }
    // Last mile: GitHub Actions runs per commit, deployments per environment, commit ancestry.
    if (rest === '/actions/runs') {
      return json(res, 200, { workflow_runs: state.runs.get(`${repo}@${url.searchParams.get('head_sha')}`) || [] });
    }
    if (rest === '/deployments') {
      const list = state.deployments.get(`${repo}:${url.searchParams.get('environment')}`) || [];
      return json(res, 200, [...list].reverse().map((d) => ({ id: d.id, url: `http://${req.headers.host}/repos/${repo}/deployments/${d.id}`, sha: d.sha, ref: d.ref, payload: d.payload || {}, creator: { login: d.by || 'deployer' }, created_at: d.at })));
    }
    const ds = rest.match(/^\/deployments\/(\d+)\/statuses$/);
    if (ds) {
      const d = [...state.deployments.values()].flat().find((x) => x.id === Number(ds[1]));
      return json(res, 200, d ? [{ state: d.status || 'success', created_at: d.at, creator: { login: d.by || 'deployer' }, log_url: d.log_url || '' }] : []);
    }
    if (rest === '/tags') {
      return json(res, 200, (state.tags.get(repo) || []).map((t) => ({ name: t.name, commit: { sha: t.sha } })));
    }
    if (rest.startsWith('/compare/')) {
      const [base, head] = rest.slice('/compare/'.length).split('...');
      if (base === head) return json(res, 200, { status: 'identical' });
      const order = state.heads.get(repo) || [];
      if (order.includes(base) && order.includes(head)) return json(res, 200, { status: order.indexOf(head) > order.indexOf(base) ? 'ahead' : 'behind' });
      return json(res, 200, { status: (state.ancestors.get(head) || new Set()).has(base) ? 'ahead' : 'behind' });
    }
    const n = rest.match(/^\/(pulls|issues)\/(\d+)$/);
    if (n) {
      const key = `${repo}#${n[2]}`;
      const item = (n[1] === 'pulls' ? state.prs : state.issues).get(key);
      if (!item) return json(res, 404, { message: 'Not Found' });
      return json(res, 200, { number: Number(n[2]), html_url: `https://github.com/${repo}/${n[1] === 'pulls' ? 'pull' : 'issues'}/${n[2]}`, user: { login: 'dev' }, ...item });
    }
    return json(res, 404, { message: 'Not Found' });
  });

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ state, token, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) });
  }));
}
