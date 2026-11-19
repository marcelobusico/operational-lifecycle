// A fake App Store Connect API for tests: the two routes LifeCycle reads, with Apple's JSON:API
// shapes (data / attributes / relationships / included) and error bodies, and real ES256 JWT
// checking against a key pair made at start. No network, no real credentials.
//   state.setVersions(appId, [{ id?, version, state: 'READY_FOR_SALE' | 'IN_REVIEW' | …, phased?: { state, day } }])
//   state.down = true      → every request answers 503
//   state.forbidden = true → 403 FORBIDDEN_ERROR
import http from 'node:http';
import crypto from 'node:crypto';

export async function startFakeAppStore() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const credentials = {
    issuerId: '57246542-96fe-1a63-e053-0824d011072a',
    keyId: 'FAKEKEY123',
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
  const apps = new Map();
  const state = {
    down: false,
    forbidden: false,
    requests: 0,
    setVersions(appId, versions) {
      apps.set(String(appId), { name: `App ${appId}`, versions: versions.map((v, i) => ({ id: v.id || `ver-${appId}-${v.version}`, ...v, created: v.created || `2026-10-${String(20 + i).padStart(2, '0')}T10:00:00Z` })) });
    },
    // Changes one version in place (state and/or phased release).
    update(appId, version, change) {
      const v = apps.get(String(appId)).versions.find((x) => x.version === version);
      Object.assign(v, change);
    },
  };

  const error = (res, status, code, title, detail) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ errors: [{ status: String(status), code, title, detail }] }));
  };
  const verify = (auth) => {
    const m = /^Bearer (.+)\.(.+)\.(.+)$/.exec(auth || '');
    if (!m) return false;
    const head = JSON.parse(Buffer.from(m[1], 'base64url'));
    const body = JSON.parse(Buffer.from(m[2], 'base64url'));
    if (head.alg !== 'ES256' || head.kid !== credentials.keyId || body.iss !== credentials.issuerId || body.aud !== 'appstoreconnect-v1') return false;
    if (body.exp < Date.now() / 1000) return false;
    return crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url'));
  };

  const server = http.createServer((req, res) => {
    state.requests++;
    if (state.down) return error(res, 503, 'SERVICE_UNAVAILABLE', 'Service Unavailable', 'The service is temporarily unavailable.');
    if (!verify(req.headers.authorization)) return error(res, 401, 'NOT_AUTHORIZED', 'Authentication credentials are missing or invalid.', 'Provide a properly configured and signed bearer token, and make sure that it has not expired.');
    if (state.forbidden) return error(res, 403, 'FORBIDDEN_ERROR', 'This request is forbidden for security reasons', 'The API key in use does not allow this request');
    const url = new URL(req.url, 'http://x');
    const m = /^\/v1\/apps\/([^/]+)(\/appStoreVersions)?$/.exec(url.pathname);
    const app = m && apps.get(decodeURIComponent(m[1]));
    if (!app) return error(res, 404, 'NOT_FOUND', 'The specified resource does not exist', `There is no resource of type 'apps' with id '${m?.[1]}'`);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (!m[2]) return res.end(JSON.stringify({ data: { type: 'apps', id: m[1], attributes: { name: app.name, bundleId: `com.fake.${m[1]}` } } }));
    const sorted = [...app.versions].sort((a, b) => b.created.localeCompare(a.created));
    const data = sorted.map((v) => ({
      type: 'appStoreVersions', id: v.id,
      attributes: { platform: 'IOS', versionString: v.version, appStoreState: v.state, appVersionState: v.state, releaseType: 'AFTER_APPROVAL', earliestReleaseDate: null, createdDate: v.created },
      relationships: { appStoreVersionPhasedRelease: { data: v.phased ? { type: 'appStoreVersionPhasedReleases', id: `pr-${v.id}` } : null } },
    }));
    const included = sorted.filter((v) => v.phased).map((v) => ({
      type: 'appStoreVersionPhasedReleases', id: `pr-${v.id}`,
      attributes: { phasedReleaseState: v.phased.state, startDate: '2026-11-01T00:00:00Z', totalPauseDuration: 0, currentDayNumber: v.phased.day },
    }));
    res.end(JSON.stringify({ data, included, links: { self: req.url } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, state, credentials, close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) };
}
