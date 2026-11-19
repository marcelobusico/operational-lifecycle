// Minimal MCP client (JSON-RPC 2.0). Used for Statsig's and the App Store's MCP servers
// (src/sources/statsig.js): `name` is who the messages talk about, `headers` adds auth headers a
// server needs besides a bearer token (Statsig: statsig-api-key). Two transports:
//   - stdio: `command` is [program, ...args]; one JSON message per line, the process is started for
//     each call and stopped afterwards (LifeCycle only calls on open/refresh/publish).
//   - streamable HTTP: `url`; each message is a POST, the answer is JSON or an SSE stream.
// Every failure is thrown as McpUnavailable, so callers can say "unavailable" and never guess.
import { spawn } from 'node:child_process';
import { registerSecret } from './log.js';

const PROTOCOL_VERSION = '2025-06-18';

export class McpUnavailable extends Error {}
// The server answered but this person may not read the data (HTTP 401/403, a JSON-RPC error with
// code 403, or a tool error whose content says `no_access`). Still "unavailable" for callers that
// don't care about the difference (alerts).
export class McpNoAccess extends McpUnavailable {}
const NO_ACCESS = /\bno[_ ]access\b|\bforbidden\b|\bunauthori[sz]ed\b/i;

export function createMcpClient({ command = null, url = null, token = null, headers: extraHeaders = {}, name: serverName = 'the server', timeoutMs = 10000, fetchImpl = fetch } = {}) {
  registerSecret(token);
  for (const v of Object.values(extraHeaders)) registerSecret(v);
  if (!command && !url) throw new McpUnavailable(`no ${serverName} MCP connection is set up`);
  const S = `${serverName}'s MCP server`;

  async function callTool(name, args = {}) {
    const result = url ? await httpCall(name, args) : await stdioCall(name, args);
    if (result?.isError) {
      const text = (result.content || []).map((c) => c.text).filter(Boolean).join(' ');
      if (result.structuredContent?.error === 'no_access' || NO_ACCESS.test(text)) throw new McpNoAccess(`${serverName} says you have no access to ${name}${!text ? '' : ` (${text})`}`);
      throw new McpUnavailable(`${serverName}'s ${name} failed: ${text || 'error'}`);
    }
    if (result?.structuredContent) return result.structuredContent;
    const text = (result?.content || []).find((c) => c.type === 'text')?.text;
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      // Some servers (Statsig) put a status line before the JSON: "Completed gate_read.\n{…}".
      const at = text.search(/[[{]/);
      if (at > 0) {
        try { return JSON.parse(text.slice(at)); } catch { /* not JSON after all */ }
      }
      return { text };
    }
  }

  const initMsg = (id) => ({ jsonrpc: '2.0', id, method: 'initialize', params: {
    protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'lifecycle', version: '0.1.0' },
  } });
  const callMsg = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };

  async function httpCall(name, args) {
    let session = null;
    const post = async (msg) => {
      const headers = { ...extraHeaders, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'user-agent': 'lifecycle-local' };
      if (token) headers.authorization = `Bearer ${token}`;
      if (session) headers['mcp-session-id'] = session;
      if (session) headers['mcp-protocol-version'] = PROTOCOL_VERSION;
      let res;
      try {
        res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(msg), signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        throw new McpUnavailable(`${S} could not be reached (${err.cause?.code || err.name})`);
      }
      if (res.status === 401 || res.status === 403) {
        // Statsig answers "only accepts an active CONSOLE key, but <what> was sent/used". For a key of
        // another kind (a server/client key) that's a wrong key type; "an invalid key" is just refused.
        const hint = wrongKindHint(await res.text().catch(() => ''));
        throw new McpNoAccess(`${S} refused access (HTTP ${res.status})${hint}`);
      }
      if (!res.ok && res.status !== 202) throw new McpUnavailable(`${S} answered HTTP ${res.status}`);
      session = res.headers.get('mcp-session-id') || session;
      if (msg.id === undefined) return null;
      const type = res.headers.get('content-type') || '';
      let body;
      try {
        body = type.includes('text/event-stream') ? parseSse(await res.text(), msg.id) : await res.json();
      } catch {
        throw new McpUnavailable(`${serverName}'s MCP answer could not be read`);
      }
      if (!body) throw new McpUnavailable(`${S} sent no answer`);
      if (body.error) throw rpcError(body.error, S);
      return body.result;
    };
    await post(initMsg(1));
    await post(initialized);
    return post(callMsg(2, name, args));
  }

  function stdioCall(name, args) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'ignore'], env: token ? { ...process.env, MCP_TOKEN: token } : process.env });
      } catch (err) {
        return reject(new McpUnavailable(`${S} could not be started (${err.code || err.message})`));
      }
      let buffer = '';
      let done = false;
      const finish = (fn, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.kill();
        fn(value);
      };
      const timer = setTimeout(() => finish(reject, new McpUnavailable(`${S} didn't answer in time`)), timeoutMs);
      child.on('error', (err) => finish(reject, new McpUnavailable(`${S} could not be started (${err.code || err.message})`)));
      child.on('exit', () => finish(reject, new McpUnavailable(`${S} stopped before answering`)));
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.id === 1) {
            if (msg.error) return finish(reject, new McpUnavailable(`${S}: ${msg.error.message}`));
            child.stdin.write(JSON.stringify(initialized) + '\n');
            child.stdin.write(JSON.stringify(callMsg(2, name, args)) + '\n');
          } else if (msg.id === 2) {
            if (msg.error) return finish(reject, rpcError(msg.error, S));
            return finish(resolve, msg.result);
          }
        }
      });
      child.stdin.on('error', () => { /* reported through exit */ });
      child.stdin.write(JSON.stringify(initMsg(1)) + '\n');
    });
  }

  return { callTool };
}

export const WRONG_KIND = 'wrong kind of key';
function wrongKindHint(text) {
  return /only accepts an active CONSOLE key/i.test(text) && !/invalid key/i.test(text) ? `: ${WRONG_KIND}, it only accepts a Console API key` : '';
}

function rpcError(error, S) {
  if (error?.code === 403 || error?.code === 401 || NO_ACCESS.test(error?.message || '')) {
    return new McpNoAccess(`${S} refused access${wrongKindHint(error?.message || '')}`);
  }
  return new McpUnavailable(`${S}: ${error?.message}`);
}

function parseSse(text, id) {
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
    if (!data) continue;
    const msg = JSON.parse(data);
    if (msg.id === id) return msg;
  }
  return null;
}
