// Statsig connection, over Statsig's own MCP server (no adapter of ours in between). Shared by every
// LifeCycle reader that needs Statsig: the flag source of the last-mile check (done vs. turned on)
// (src/lastmile/statsig.js) and the experiments a feature takes part in (src/lastmile/experiments.js). Read-only, with the person's own Console API key,
// which stays in ~/.lifecycle/credentials.json (or LIFECYCLE_STATSIG_API_KEY) and is never logged.
//
// Server: https://api.statsig.com/v3/mcp, streamable HTTP, header `statsig-api-key: console-…`.
// Grouped read tools take { action, arguments: { params } } (docs.statsig.com/integrations/mcp):
//   gate_read  get_list_of_gates       params: query_limit, query_page, …
//   gate_read  get_gate_details_by_id  params: path_id
//   experiment_read  get_experiment_details_by_id  params: path_id
//     (checked live 2026-11-05: same double wrapping as gates; a missing id is a tool error
//     "not_found: API Error (404)", which getExperiment answers as null = unknown experiment.
//     A real answer is kept in test/fixtures/statsig-experiment-live.json.)
// Statsig doesn't document the response bodies of these tools; they carry the Console API's objects
// (a gate: id, name, isEnabled, rules[{ name, passPercentage, conditions, environments }],
// lastModifiedTime, lastModifierName, permalink), either as structuredContent or as JSON text, bare
// or wrapped in { data, pagination }. unwrap() accepts all of those.
// Checked live (2026-11-05): the real server nests twice. structuredContent is
// { data: { message, data: <gates or gate>, pagination }, warnings, pagination }, and the text content
// is "Completed gate_read.\n" followed by { message, data, pagination }.
// Every failure is a SourceError: unreachable | no_access, never a flag state.
import { createMcpClient, McpNoAccess, WRONG_KIND } from '../mcp-client.js';
import { SourceError } from './github-client.js';
import { registerSecret } from '../log.js';

// Defaults (MCP URL, console URL, environment mapping) live in DEFAULTS.sources.statsig (src/config.js).
export const STATSIG_NAME = 'Statsig';

export const CONSOLE_KEYS_URL = 'https://console.statsig.com/api_keys';
const SETUP = '`npm run setup -- --extras`';
const KEY_HELP = `Fix: create a Console API key (it starts with console-; read-only is enough) at ${CONSOLE_KEYS_URL} (Settings → Keys & Environments → Console API Keys), then run ${SETUP} and paste it.`;

// Statsig's MCP server (the Console API) only accepts a Console API key. The other kinds of key
// Statsig hands out are refused with a 403 "only accepts an active CONSOLE key".
const KEY_KINDS = { secret: 'a Server Secret key (secret-…)', client: 'a Client SDK key (client-…)' };
export function statsigKeyKind(key) {
  const m = String(key || '').trim().match(/^(console|secret|client)-/i);
  return m ? m[1].toLowerCase() : null;
}
// Plain words for a key of the wrong kind, or null when the key looks like a Console API key.
export function wrongKeyMessage(key) {
  const kind = statsigKeyKind(key);
  if (kind !== 'secret' && kind !== 'client') return null;
  return `The ${STATSIG_NAME} key on this machine is ${KEY_KINDS[kind]}, but ${STATSIG_NAME}'s MCP server only accepts a Console API key (console-…). ${KEY_HELP}`;
}
const failure = (kind, reason, message, status) => Object.assign(new SourceError(kind, message, status), { reason });

export function createStatsigConnection({ mcpUrl, apiKey, enabled = true, timeoutMs = 15000, fetchImpl = fetch }) {
  // Same protection as every other credential: redacted from logs, warnings and the browser.
  registerSecret(apiKey);
  const mcp = apiKey && mcpUrl
    ? createMcpClient({ url: mcpUrl, name: STATSIG_NAME, headers: { 'statsig-api-key': apiKey }, timeoutMs, fetchImpl })
    : null;

  async function read(tool, action, params = {}, { what = action } = {}) {
    if (!enabled) throw failure('unreachable', 'disabled', `The ${STATSIG_NAME} connection is turned off in your LifeCycle config (sources.statsig.enabled).`);
    if (!mcp) throw failure('no_access', 'no_credential', `No ${STATSIG_NAME} Console API key is set up on this machine, so LifeCycle can't read ${what}. ${KEY_HELP}`);
    const wrong = wrongKeyMessage(apiKey);
    if (wrong) throw failure('no_access', 'wrong_key_type', wrong);
    try {
      return await mcp.callTool(tool, { action, arguments: { params } });
    } catch (err) {
      if (err instanceof McpNoAccess) {
        if (err.message.includes(WRONG_KIND)) {
          throw failure('no_access', 'wrong_key_type', `${STATSIG_NAME} only accepts a Console API key (console-…), and the key on this machine isn't one. ${KEY_HELP}`, 403);
        }
        const needs = tool === 'experiment_read' ? 'experiments' : 'feature gates';
        throw failure('no_access', 'rejected', `${STATSIG_NAME} refused your Console API key (revoked, expired or for another project), so LifeCycle can't read ${what}: it needs read access to the project's ${needs}. ${KEY_HELP}`, 403);
      }
      if (/\bnot_found\b|\(404\)/.test(err.message)) throw failure('not_found', 'not_found', `${STATSIG_NAME} has no ${what}.`);
      // The MCP client's text already starts with "Statsig…"; only keep what it adds.
      const code = err.message.match(/answered HTTP (\d+)/)?.[1];
      const detail = /could not be reached/i.test(err.message) ? 'no connection, or Statsig is down'
        : code ? `Statsig is having trouble: it answered with an error, HTTP ${code}` : err.message;
      throw failure('unreachable', 'unreachable', `${STATSIG_NAME} could not be reached right now (${detail}). LifeCycle tries again on the next Refresh Data; check your internet connection if it keeps happening.`);
    }
  }

  // Every feature gate (paged, up to 20 pages of 100).
  async function listGates() {
    const out = [];
    for (let page = 1; page <= 20; page++) {
      const body = await read('gate_read', 'get_list_of_gates', { query_limit: 100, query_page: page }, { what: 'the feature gates of your Statsig project' });
      const gates = unwrap(body);
      if (!Array.isArray(gates)) throw failure('unreachable', 'unreachable', `${STATSIG_NAME}'s gate list could not be read (unexpected answer).`);
      out.push(...gates);
      if (!pagination(body)?.nextPage || !gates.length) break;
    }
    return out;
  }

  async function getGate(id) {
    const gate = unwrap(await read('gate_read', 'get_gate_details_by_id', { path_id: id }, { what: `feature gate "${id}"` }));
    if (!gate || typeof gate !== 'object' || Array.isArray(gate)) throw new SourceError('unreachable', `${STATSIG_NAME} returned no details for feature gate "${id}".`);
    return gate;
  }

  // One experiment, or null when Statsig has no experiment with that id (an unknown experiment).
  async function getExperiment(id) {
    let body;
    try {
      body = await read('experiment_read', 'get_experiment_details_by_id', { path_id: id }, { what: `experiment "${id}"` });
    } catch (err) {
      if (err instanceof SourceError && err.kind === 'not_found') return null;
      throw err;
    }
    const exp = unwrap(body);
    if (!exp || typeof exp !== 'object' || Array.isArray(exp)) throw new SourceError('unreachable', `${STATSIG_NAME} returned no details for experiment "${id}".`);
    return exp;
  }

  return { read, listGates, getGate, getExperiment, hasKey: Boolean(apiKey) };
}

const isWrapper = (x) => Boolean(x) && typeof x === 'object' && !Array.isArray(x) && 'data' in x && !('isEnabled' in x) && !('rules' in x) && !('groups' in x);

// X | { data: X } | { data: { message, data: X, pagination } }, where the MCP client already parsed
// structuredContent or JSON text. Unwraps until it reaches the gate list or the gate itself.
export function unwrap(body) {
  let out = body;
  for (let i = 0; i < 4 && isWrapper(out); i++) out = out.data;
  return out;
}

// The pagination block, at whichever wrapping level the answer carries it.
export function pagination(body) {
  let at = body;
  for (let i = 0; i < 4 && at && typeof at === 'object'; i++) {
    if (at.pagination) return at.pagination;
    at = isWrapper(at) ? at.data : null;
  }
  return null;
}
