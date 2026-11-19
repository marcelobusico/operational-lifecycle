// App Store Connect (Apple's App Store, iOS). The first store LifeCycle connects to.
//
// Apple offers no MCP server for App Store Connect (checked 2026-11-05), so this reads the official
// App Store Connect API (https://developer.apple.com/documentation/appstoreconnectapi) behind a
// tool-style connection: `callTool('app_read' | 'versions_list', args)`, the same shape as an MCP
// client. Setting sources.appStore.mcpUrl reads the same two tools from an MCP server instead,
// with nothing else changing.
//
// Auth: an App Store Connect API key (Users and Access → Integrations → App Store Connect API):
// issuer id, key id and the .p8 private key. Each request carries a short-lived ES256 JWT signed
// with it. The key stays in ~/.lifecycle/credentials.json and is never logged.
//
// Read-only routes used:
//   GET /v1/apps/{id}                                   the app (404 = unknown app)
//   GET /v1/apps/{id}/appStoreVersions?filter[platform]=IOS&include=appStoreVersionPhasedRelease
//     versions newest first, each with appVersionState (or the older appStoreState) and its
//     phased release: phasedReleaseState INACTIVE | ACTIVE | PAUSED | COMPLETE, currentDayNumber 1–7.
// Apple's phased release goes up on a fixed 7-day schedule (1, 2, 5, 10, 20, 50, 100 % of users
// with automatic updates on); the team can pause it (up to 30 days) or release to everyone early.
// Apple has no "halt": a paused phased release is what LifeCycle calls a halted rollout.
import crypto from 'node:crypto';
import { createMcpClient, McpNoAccess } from '../mcp-client.js';
import { SourceError } from '../sources/github-client.js';
import { registerSecret } from '../log.js';

export const APP_STORE_NAME = 'App Store';
export const PHASED_SCHEDULE = [1, 2, 5, 10, 20, 50, 100];
const SETUP = '`npm run setup -- --extras`';
export const ACCESS_NEEDED = 'an App Store Connect API key (Users and Access → Integrations → App Store Connect API) whose role can see this app\'s App Store versions (Developer, App Manager or Admin)';
const KEY_HELP = `Fix: create ${ACCESS_NEEDED}, then run ${SETUP} and enter its issuer id, key id and .p8 file.`;

// Apple's version states → LifeCycle's review states.
const STATE = {
  READY_FOR_SALE: 'released', READY_FOR_DISTRIBUTION: 'released',
  WAITING_FOR_REVIEW: 'in_review', IN_REVIEW: 'in_review', READY_FOR_REVIEW: 'in_review',
  PENDING_DEVELOPER_RELEASE: 'approved_waiting', PENDING_APPLE_RELEASE: 'approved_waiting', ACCEPTED: 'approved_waiting',
  PROCESSING_FOR_APP_STORE: 'approved_waiting', PROCESSING_FOR_DISTRIBUTION: 'approved_waiting', WAITING_FOR_EXPORT_COMPLIANCE: 'in_review',
  REJECTED: 'rejected', METADATA_REJECTED: 'rejected', INVALID_BINARY: 'rejected',
  PREPARE_FOR_SUBMISSION: 'preparing', DEVELOPER_REJECTED: 'preparing',
  REPLACED_WITH_NEW_VERSION: 'replaced', DEVELOPER_REMOVED_FROM_SALE: 'removed', REMOVED_FROM_SALE: 'removed',
};

const failure = (kind, reason, message, status) => Object.assign(new SourceError(kind, message, status), { reason });

function jwt({ issuerId, keyId, privateKey }) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'ES256', kid: keyId, typ: 'JWT' });
  const body = b64({ iss: issuerId, iat: now, exp: now + 15 * 60, aud: 'appstoreconnect-v1' });
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${head}.${body}.${sig}`;
}

// The REST side of the connection: answers the two tools from the App Store Connect API.
function createRestConnection({ apiUrl, credentials, timeoutMs, fetchImpl }) {
  async function get(route, what) {
    let token;
    try {
      token = jwt(credentials);
    } catch {
      throw failure('no_access', 'bad_key', `The App Store Connect private key on this machine can't be used (it isn't a valid .p8 key). ${KEY_HELP}`);
    }
    let res;
    try {
      res = await fetchImpl(`${apiUrl}${route}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'user-agent': 'lifecycle-local' }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw failure('unreachable', 'unreachable', `App Store Connect could not be reached right now (${err.cause?.code || err.name}). LifeCycle tries again on the next Refresh.`);
    }
    if (res.status === 401) throw failure('no_access', 'rejected', `App Store Connect refused your API key (revoked, or wrong issuer id / key id), so LifeCycle can't read ${what}. ${KEY_HELP}`, 401);
    if (res.status === 403) throw failure('no_access', 'no_access', `Your App Store Connect API key can't see ${what}: LifeCycle needs ${ACCESS_NEEDED}. ${KEY_HELP}`, 403);
    if (res.status === 404) throw failure('not_found', 'not_found', `App Store Connect has no ${what}.`, 404);
    if (!res.ok) throw failure('unreachable', 'unreachable', `App Store Connect could not be read right now (it answered HTTP ${res.status}). LifeCycle tries again on the next Refresh.`, res.status);
    try {
      return await res.json();
    } catch {
      throw failure('unreachable', 'unreachable', 'App Store Connect\'s answer could not be read.');
    }
  }
  return {
    async callTool(name, args) {
      const id = encodeURIComponent(args.app_id);
      if (name === 'app_read') return get(`/v1/apps/${id}`, `app with Apple ID ${args.app_id}`);
      if (name === 'versions_list') {
        return get(`/v1/apps/${id}/appStoreVersions?filter[platform]=${args.platform === 'android' ? 'ANDROID' : 'IOS'}&include=appStoreVersionPhasedRelease&limit=10`, `App Store versions of app ${args.app_id}`);
      }
      throw new Error(`unknown App Store tool ${name}`);
    },
  };
}

// The MCP side: the same tools from an MCP server. Its failures become the same SourceErrors.
function createMcpConnection({ mcpUrl, credentials, timeoutMs, fetchImpl }) {
  const mcp = createMcpClient({ url: mcpUrl, name: APP_STORE_NAME, token: jwt(credentials), timeoutMs, fetchImpl });
  return {
    async callTool(name, args) {
      try {
        return await mcp.callTool(name, args);
      } catch (err) {
        if (err instanceof McpNoAccess) throw failure('no_access', 'no_access', `The App Store MCP server refused access. LifeCycle needs ${ACCESS_NEEDED}. ${KEY_HELP}`, 403);
        if (/\bnot_found\b|\(404\)/.test(err.message)) throw failure('not_found', 'not_found', `App Store Connect has no app ${args.app_id}.`);
        throw failure('unreachable', 'unreachable', `The App Store MCP server could not be reached right now (${err.message}).`);
      }
    },
  };
}

// The connector LifeCycle's store layer uses (src/stores/index.js).
export function createAppStoreConnector({ cfg, credentials, fetchImpl = fetch }) {
  if (credentials) {
    registerSecret(credentials.privateKey);
    registerSecret(credentials.keyId);
    registerSecret(credentials.issuerId);
  }
  const consoleUrl = cfg.consoleUrl || 'https://appstoreconnect.apple.com';
  const connection = !credentials ? null
    : cfg.mcpUrl ? createMcpConnection({ mcpUrl: cfg.mcpUrl, credentials, timeoutMs: cfg.timeoutMs || 15000, fetchImpl })
      : createRestConnection({ apiUrl: cfg.apiUrl, credentials, timeoutMs: cfg.timeoutMs || 15000, fetchImpl });

  // { name, link, versions: [{ version, state, store_state, rollout, released_at, link }] } newest first.
  async function readApp(storeId, platform) {
    if (cfg.enabled === false) throw failure('unreachable', 'disabled', 'The App Store connection is turned off in your LifeCycle config (sources.appStore.enabled).');
    if (!connection) throw failure('no_access', 'no_credential', `No App Store Connect API key is set up on this machine, so LifeCycle can't read the App Store. ${KEY_HELP}`);
    let app;
    try {
      app = await connection.callTool('app_read', { app_id: storeId });
    } catch (err) {
      if (err.kind === 'not_found') return { unknown: true, link: `${consoleUrl}/apps` };
      throw err;
    }
    const list = await connection.callTool('versions_list', { app_id: storeId, platform });
    const link = `${consoleUrl}/apps/${encodeURIComponent(storeId)}/distribution/ios/version/inflight`;
    const phased = new Map((list.included || []).filter((x) => x.type === 'appStoreVersionPhasedReleases').map((x) => [x.id, x.attributes || {}]));
    const versions = (list.data || []).map((v) => {
      const a = v.attributes || {};
      const raw = a.appVersionState || a.appStoreState || 'UNKNOWN';
      const state = STATE[raw] || 'unknown';
      const pr = phased.get(v.relationships?.appStoreVersionPhasedRelease?.data?.id);
      return {
        version: a.versionString,
        state,
        store_state: raw,
        rollout: rolloutOf(state, pr),
        released_at: a.earliestReleaseDate || null,
        created_at: a.createdDate || null,
        link: `${consoleUrl}/apps/${encodeURIComponent(storeId)}/distribution/ios/version/${encodeURIComponent(v.id)}`,
      };
    }).filter((v) => v.version);
    return { unknown: false, name: app?.data?.attributes?.name || null, link, versions };
  }

  return { store: 'app_store', name: APP_STORE_NAME, platforms: ['ios'], readApp };
}

// A released version's rollout: { state: complete | gradual | halted | none, percentage, day }.
export function rolloutOf(state, pr) {
  if (state !== 'released') return { state: 'none', percentage: null, day: null };
  if (!pr || pr.phasedReleaseState === 'INACTIVE' || pr.phasedReleaseState === 'COMPLETE' || !pr.phasedReleaseState) {
    return { state: 'complete', percentage: 100, day: null };
  }
  const day = Math.min(Math.max(Number(pr.currentDayNumber) || 1, 1), 7);
  const percentage = PHASED_SCHEDULE[day - 1];
  if (pr.phasedReleaseState === 'PAUSED') return { state: 'halted', percentage, day, store_word: 'paused' };
  return { state: percentage >= 100 ? 'complete' : 'gradual', percentage, day };
}
