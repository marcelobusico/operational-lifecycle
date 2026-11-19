// A stand-in for Statsig's MCP server (https://api.statsig.com/v3/mcp): streamable HTTP, JSON-RPC,
// header statsig-api-key, grouped read tools gate_read and experiment_read with { action, arguments:
// { params } }. Gates are shaped like the Console API's gate objects; experiments are copies of a real
// answer captured live (test/fixtures/statsig-experiment-live.json) with tests' changes on top. Tests flip gates, set rollouts per environment, take
// the server down or refuse the key, then refresh.
import http from 'node:http';
import fs from 'node:fs';

const LIVE_EXPERIMENT = JSON.parse(fs.readFileSync(new URL('./fixtures/statsig-experiment-live.json', import.meta.url), 'utf8')).structuredContent.data.data;

export function startFakeStatsig({ apiKey = 'fake-statsig-key-not-a-real-credential', company = 'example-co' } = {}) {
  const state = {
    down: false,
    // A key that is accepted by the server but whose tools answer "forbidden" (no read permission).
    readOnlyDenied: false,
    // When true the server answers tools with JSON text content only (no structuredContent).
    textOnly: false,
    gates: new Map(), // id -> Console API gate object
    serverKeys: new Set(), // keys Statsig knows as server/client keys (whatever their prefix)
    experiments: new Map(), // id -> Console API experiment object
    calls: [],
  };

  const gateOf = (id) => {
    if (!state.gates.has(id)) {
      state.gates.set(id, { id, name: id, isEnabled: true, rules: [], lastModifiedTime: null, lastModifierName: null,
        permalink: `https://console.statsig.com/${company}/gates/${id}`, status: 'In Progress', type: 'TEMPORARY' });
    }
    return state.gates.get(id);
  };

  // Test helper: one public rule per environment. enabled → 100%, rollout → that %, else 0%.
  state.set = (environment, id, { enabled, rollout = null, at = new Date().toISOString(), by = 'Ana Ops' }) => {
    const gate = gateOf(id);
    gate.rules = gate.rules.filter((r) => !(r.environments || []).includes(environment));
    gate.rules.push({ id: `${id}:${environment}`, name: `Everyone in ${environment}`, passPercentage: enabled ? 100 : rollout ?? 0,
      conditions: [{ type: 'public' }], environments: [environment] });
    gate.lastModifiedTime = Date.parse(at);
    gate.lastModifierName = by;
  };
  // Test helper: the gate's kill switch (off everywhere).
  state.disable = (id, { at = new Date().toISOString(), by = 'Ana Ops' } = {}) => {
    Object.assign(gateOf(id), { isEnabled: false, lastModifiedTime: Date.parse(at), lastModifierName: by });
  };

  // Test helper: an experiment shaped like the live capture. groups: [{ name, size, description?,
  // control? }] (the first is the control unless one says control: true). status: active | setup |
  // decision_made | abandoned.
  state.experiment = (id, { groups, status = 'active', allocation = 100, targetingGateID = '', launched = null,
    at = new Date().toISOString(), by = 'Ana Ops', startTime = Date.parse(at), endTime = null } = {}) => {
    const prev = state.experiments.get(id);
    const live = structuredClone(LIVE_EXPERIMENT);
    const gs = (groups || prev?.groups.map((g) => ({ name: g.name, size: g.size, description: g.description, control: g.isControl }))).map((g, i, all) => ({
      ...live.groups[0], name: g.name, id: `${id}-g${i}`, size: g.size, description: g.description ?? '', parameterValues: { variant: g.name },
      isControl: all.some((x) => x.control) ? g.control === true : i === 0,
    }));
    const exp = Object.assign(live, { id, name: id, description: '', status, allocation, targetingGateID, groups: gs,
      controlGroupID: gs.find((g) => g.isControl)?.id, launchedGroupID: launched ? gs.find((g) => g.name === launched)?.id : null,
      startTime: status === 'setup' ? null : prev?.startTime ?? startTime, endTime,
      lastModifiedTime: Date.parse(at), lastModifierName: by, permalink: `https://console.statsig.com/${company}/experiments/${id}` });
    state.experiments.set(id, exp);
    return exp;
  };
  // Test helper: change one group's share (and another's, so they still add up).
  state.setShare = (id, sizes, { at = new Date().toISOString(), by = 'Ana Ops' } = {}) => {
    const exp = state.experiments.get(id);
    for (const g of exp.groups) if (g.name in sizes) g.size = sizes[g.name];
    Object.assign(exp, { lastModifiedTime: Date.parse(at), lastModifierName: by });
  };
  // Test helper: end the experiment, as Statsig does when a decision is made (or it is abandoned).
  state.endExperiment = (id, { launched = null, at = new Date().toISOString(), by = 'Ana Ops' } = {}) => {
    const exp = state.experiments.get(id);
    Object.assign(exp, { status: launched ? 'decision_made' : 'abandoned', endTime: Date.parse(at), decisionTime: Date.parse(at),
      launchedGroupID: launched ? exp.groups.find((g) => g.name === launched)?.id : null, lastModifiedTime: Date.parse(at), lastModifierName: by });
  };

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  // Shaped like the live server's answers (checked 2026-11-05): a status line before the JSON text,
  // and structuredContent nesting the Console API body once more.
  const ok = (body, message, tool = 'gate_read') => {
    const inner = { message, ...body };
    const content = [{ type: 'text', text: `Completed ${tool}.\n${JSON.stringify(inner, null, 2)}` }];
    return state.textOnly ? { content } : { content, structuredContent: { data: inner, warnings: [], ...(body.pagination ? { pagination: body.pagination } : {}) } };
  };

  function callTool({ name, arguments: args = {} }) {
    const params = args.arguments?.params;
    if (name === 'experiment_read') {
      if (!params) return { isError: true, content: [{ type: 'text', text: 'arguments.params is required' }] };
      if (state.readOnlyDenied) return { isError: true, content: [{ type: 'text', text: 'Forbidden resource: this key cannot read experiments' }] };
      if (args.action !== 'get_experiment_details_by_id') return { isError: true, content: [{ type: 'text', text: `invalid_arguments: Unknown experiment_read action: ${args.action}.` }] };
      const exp = state.experiments.get(params.path_id);
      // As the live server answers an id it doesn't have (checked 2026-11-05).
      if (!exp) return { isError: true, content: [{ type: 'text', text: 'not_found: API Error (404): {"message":"Experiment not found.","status":404}' }] };
      return ok({ data: exp }, 'Experiment read successfully.', 'experiment_read');
    }
    if (name !== 'gate_read') return { isError: true, content: [{ type: 'text', text: `Unknown tool ${name}` }] };
    if (!params) return { isError: true, content: [{ type: 'text', text: 'arguments.params is required' }] };
    if (state.readOnlyDenied) return { isError: true, content: [{ type: 'text', text: 'Forbidden resource: this key cannot read gates' }] };
    if (args.action === 'get_list_of_gates') {
      const limit = Number(params.query_limit || 10);
      const page = Number(params.query_page || 1);
      const all = [...state.gates.values()];
      const data = all.slice((page - 1) * limit, page * limit);
      return ok({ data, pagination: { itemsPerPage: limit, pageNumber: page, totalItems: all.length, nextPage: page * limit < all.length ? page + 1 : null, previousPage: null } }, 'Gates listed successfully.');
    }
    if (args.action === 'get_gate_details_by_id') {
      const gate = state.gates.get(params.path_id);
      if (!gate) return { isError: true, content: [{ type: 'text', text: `Gate ${params.path_id} not found` }] };
      return ok({ data: gate }, 'Gate read successfully.');
    }
    return { isError: true, content: [{ type: 'text', text: `Unknown action ${args.action}` }] };
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (state.down) return send(res, 503, { message: 'Service Unavailable' });
      if (req.method !== 'POST') return send(res, 405, { message: 'Method not allowed' });
      // Like the real server: any non-console key is refused with this 403 (acme-monolith gotcha).
      const sent = req.headers['statsig-api-key'] || '';
      if (/^(secret|client)-/.test(sent) || state.serverKeys.has(sent)) return send(res, 403, { message: 'This endpoint only accepts an active CONSOLE key, but a SERVER key was used.' });
      // The real server's answer to an unknown key (checked 2026-11-05).
      if (sent !== apiKey) return send(res, 401, { statusCode: 401, message: 'This endpoint only accepts an active CONSOLE key, but an invalid key was sent.', error: 'Unauthorized' });
      const msg = JSON.parse(raw || '{}');
      if (msg.id === undefined) return send(res, 202);
      if (msg.method === 'initialize') {
        return send(res, 200, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'statsig-fake', version: '3' } } },
          { 'mcp-session-id': `s${Math.random().toString(36).slice(2)}` });
      }
      if (msg.method === 'tools/call') {
        state.calls.push({ tool: msg.params.name, action: msg.params.arguments?.action, params: msg.params.arguments?.arguments?.params });
        return send(res, 200, { jsonrpc: '2.0', id: msg.id, result: callTool(msg.params) });
      }
      return send(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
    });
  });

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}/v3/mcp`,
    apiKey,
    company,
    state,
    close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }),
  })));
}
