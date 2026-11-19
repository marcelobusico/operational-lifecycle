// A small stand-in for the Flagsmith Admin API (shapes from its OpenAPI spec), enough for the
// last-mile reads. Tests flip flags, set rollouts, take it down or revoke the key, then refresh.
import http from 'node:http';

export function startFakeFlagsmith({ apiKey = 'fake-flagsmith-key-not-real', projectId = 7 } = {}) {
  const state = {
    down: false,
    projectId,
    auditEnabled: true,
    environments: [
      { id: 1, name: 'QA', api_key: 'qaEnvKey123', use_v2_feature_versioning: false },
      { id: 2, name: 'Production', api_key: 'prodEnvKey456', use_v2_feature_versioning: false },
    ],
    features: [], // { id, name }
    // "<envApiKey>:<flagName>" -> { enabled, updated_at, rollout: null | percentage }
    flags: new Map(),
    audit: [], // { created_date, log, author, environment, related_object_type }
    requests: [],
  };
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const page = (results) => ({ count: results.length, next: null, previous: null, results });
  const SEGMENT_BASE = 1000;

  // Test helper: set a flag in an environment, recording an audit entry like Flagsmith does.
  state.set = (envName, flagName, { enabled, rollout = null, at = new Date().toISOString(), by = { first_name: 'Ana', last_name: 'Ops', email: 'ana@example.com' } }) => {
    const env = state.environments.find((e) => e.name === envName);
    if (!state.features.some((f) => f.name === flagName)) state.features.push({ id: state.features.length + 1, name: flagName });
    state.flags.set(`${env.api_key}:${flagName}`, { enabled, updated_at: at, rollout });
    state.audit.push({ created_date: at, log: `Flag state / Remote config updated for feature: ${flagName}`, author: by, environment: { id: env.id }, related_object_type: 'FEATURE_STATE' });
  };

  const server = http.createServer((req, res) => {
    state.requests.push({ url: req.url, auth: req.headers.authorization });
    if (state.down) return json(res, 503, { detail: 'Service Unavailable' });
    if (req.headers.authorization !== `Api-Key ${apiKey}`) return json(res, 401, { detail: 'Invalid token.' });
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.replace(/^\/api\/v1/, '');
    const q = url.searchParams;
    if (p === '/projects/') return json(res, 200, [{ id: state.projectId, name: 'Example' }]);
    if (p === '/environments/') {
      if (Number(q.get('project')) !== state.projectId) return json(res, 403, { detail: 'forbidden' });
      return json(res, 200, page(state.environments));
    }
    let m = p.match(/^\/projects\/(\d+)\/features\/$/);
    if (m) return Number(m[1]) === state.projectId ? json(res, 200, page(state.features)) : json(res, 404, { detail: 'Not found.' });
    m = p.match(/^\/environments\/([^/]+)\/featurestates\/$/);
    if (m) {
      const feature = state.features.find((f) => f.id === Number(q.get('feature')));
      const s = feature && state.flags.get(`${m[1]}:${feature.name}`);
      if (!feature) return json(res, 200, page([]));
      const base = { feature: feature.id, identity: null, identifier: null, deleted_at: null, live_from: null, created_at: '2026-01-01T00:00:00Z' };
      const rows = [{ ...base, id: feature.id * 10, enabled: s ? s.enabled : false, feature_segment: null, updated_at: s?.updated_at || '2026-01-01T00:00:00Z' }];
      if (s?.rollout !== null && s?.rollout !== undefined) rows.push({ ...base, id: feature.id * 10 + 1, enabled: true, feature_segment: SEGMENT_BASE + feature.id, updated_at: s.updated_at });
      return json(res, 200, page(rows));
    }
    if (p === '/features/feature-segments/') {
      const fid = Number(q.get('feature'));
      return json(res, 200, page([{ id: SEGMENT_BASE + fid, segment: SEGMENT_BASE + fid, segment_name: `rollout-${fid}`, priority: 0 }]));
    }
    m = p.match(/^\/projects\/\d+\/segments\/(\d+)\/$/);
    if (m) {
      const feature = state.features.find((f) => SEGMENT_BASE + f.id === Number(m[1]));
      const s = [...state.flags.entries()].find(([k]) => k.endsWith(`:${feature?.name}`) && state.flags.get(k).rollout !== null)?.[1];
      return json(res, 200, { id: Number(m[1]), name: `${feature?.name} rollout`, rules: [{ type: 'ALL', conditions: [], rules: [{ type: 'ANY', rules: [], conditions: [{ operator: 'PERCENTAGE_SPLIT', property: null, value: String(s?.rollout ?? 0) }] }] }] });
    }
    m = p.match(/^\/projects\/\d+\/audit\/$/);
    if (m) {
      if (!state.auditEnabled) return json(res, 403, { detail: 'Audit log requires a paid plan.' });
      const envId = Number(q.get('environments'));
      const search = q.get('search') || '';
      return json(res, 200, page(state.audit.filter((e) => e.environment.id === envId && e.log.includes(search))));
    }
    return json(res, 404, { detail: 'Not found.' });
  });

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ state, apiKey, projectId, url: `http://127.0.0.1:${server.address().port}/api/v1`, close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) });
  }));
}
