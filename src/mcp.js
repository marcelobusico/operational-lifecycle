// LifeCycle for your own AI tools: a local MCP server (stdio) exposing ask, digest and follow.
// It runs the same ask service as the local app (src/ask/service.js), with the same live data,
// the same provider from ~/.lifecycle/config.json and the same local history, so an answer is the
// same wherever it is asked. Nothing is sent anywhere except to the sources and the configured
// AI provider; questions, answers and digests stay in ~/.lifecycle/.
//
// Claude Code:   claude mcp add lifecycle -- node /path/to/LifeCycle/src/mcp.js
// Other tools:   command "node", args ["/path/to/LifeCycle/src/mcp.js"]
//
// Protocol: JSON-RPC 2.0, one message per line on stdin/stdout. stdout carries protocol messages
// only; diagnostics go to stderr.
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { appUrl } from './config.js';
import { createAskService } from './ask/service.js';
import { answerMarkdown, digestMarkdown } from './ask/render.js';
import { redact } from './log.js';
import { newSessionId } from './ask/confirm.js';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export const TOOLS = [
  {
    name: 'lifecycle_ask',
    description: 'Talk to LifeCycle\'s chat. Ask about a feature: "How is X going?", "What\'s blocking X?", "Is X available to users?", "Is X ready to ramp?", "Who do I push on X?", '
      + 'about an initiative (a LifeCycle project): "How is the <name> initiative going?", "What\'s blocking the <name> project?", "What\'s left before <name> is done?", "Is <name> really in users\' hands?", '
      + '"Which initiatives are blocked?", "Give me a status of all initiatives", "How are features without an initiative going?". '
      + 'Answers are built only from the live feature status, registered changes and alerts, with an evidence link for every statement. '
      + 'The same chat creates, edits and deletes feature definitions: "create a feature called <name>, owned by @x, depends on <feature>", "move the target date of X to 2027-02-15", '
      + '"set the owner of step <step> of X to @y", "add step <name> to X", "attach PR #12 in owner/repo to step <step> of X", "delete X". '
      + 'It asks one question at a time for what is missing and shows the full definition before anything is saved; saving is a commit under the person\'s own GitHub identity. '
      + 'Pass the person\'s words as they are, relay every reply as given (do not add statuses, dates or owners that are not in it), and only send "yes" when the person themselves confirms. '
      + 'Keep passing the same session so follow-up answers and confirmations reach the same pending change. Status is never typed in; flags, tickets, deploys and PRs are never changed. It never creates a PRD (product requirements document): such requests are refused.',
    inputSchema: { type: 'object', properties: {
      question: { type: 'string', description: 'The person\'s message, in their words.' },
      session: { type: 'string', description: 'Conversation id (lowercase letters, digits, dashes). Reuse the one returned in the previous reply; omit to use this connection\'s conversation.' },
    }, required: ['question'], additionalProperties: false },
  },
  {
    name: 'lifecycle_digest',
    description: 'Produce the person\'s LifeCycle digest: what moved, what is blocked, what is at risk of missing its date, and changes in flags, deploys, '
      + 'registered changes and alerts since their last digest, for the features they own or follow.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'lifecycle_follow',
    description: 'Follow or stop following a feature, so it appears in the person\'s digest. Use the feature id (e.g. redeem-rewards).',
    inputSchema: { type: 'object', properties: { feature: { type: 'string' }, follow: { type: 'boolean', default: true } }, required: ['feature'], additionalProperties: false },
  },
  {
    name: 'lifecycle_features',
    description: 'List the defined features (id, name, owner, state) and which ones the person follows.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

export function createMcpHandler({ app, ask }) {
  const baseUrl = appUrl(app.config.port);
  // This connection's conversation, for pending changes and confirmations made through the AI tool.
  const connectionSession = newSessionId();
  const text = (t, structured) => ({ content: [{ type: 'text', text: t }], ...(structured ? { structuredContent: structured } : {}) });

  async function callTool(name, args = {}) {
    if (name === 'lifecycle_ask') {
      if (typeof args.question !== 'string' || !args.question.trim()) return { ...text('question is required'), isError: true };
      const session = typeof args.session === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(args.session) ? args.session : connectionSession;
      const a = await ask.ask(args.question.slice(0, 2000), { via: 'ai-tools', session });
      return text(answerMarkdown(a, { baseUrl }) + (a.kind === 'change' ? `\n\n_session: ${session}_` : ''), a);
    }
    if (name === 'lifecycle_digest') {
      const d = await ask.digest({ via: 'ai-tools' });
      return text(digestMarkdown(d, { baseUrl }), d);
    }
    if (name === 'lifecycle_follow') {
      const snap = await app.refresh();
      if (!snap.features.some((f) => f.feature.id === args.feature)) {
        return { ...text(`I don't have a feature called "${args.feature}". Defined: ${snap.features.map((f) => f.feature.id).join(', ')}`), isError: true };
      }
      const follows = ask.follow(args.feature, args.follow !== false);
      return text(`${args.follow !== false ? 'Following' : 'No longer following'} ${args.feature}. You follow: ${follows.join(', ') || 'nothing'}.`, { follows });
    }
    if (name === 'lifecycle_features') {
      const snap = await app.refresh();
      const follows = ask.follows();
      const list = snap.features.map((f) => ({ id: f.feature.id, name: f.feature.name, owner: f.feature.owner, state: f.state, following: follows.includes(f.feature.id) }));
      const lines = list.map((f) => `- ${f.name} (\`${f.id}\`): ${f.state}, owner ${f.owner}${f.following ? ', following' : ''}`);
      return text(lines.join('\n') || 'No features are defined.', { features: list });
    }
    return { ...text(`Unknown tool ${name}`), isError: true };
  }

  // Returns the response object, or null for notifications.
  return async function handle(msg) {
    const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Invalid Request');
    const isNotification = msg.id === undefined;
    try {
      switch (msg.method) {
        case 'initialize': {
          const asked = msg.params?.protocolVersion;
          return reply({
            protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'lifecycle', version: '0.1.0' },
            instructions: 'LifeCycle answers questions about features from live status with evidence links, and creates, edits and deletes feature definitions through the same chat (lifecycle_ask). Relay its replies without adding facts. Nothing is saved until the person says yes: never confirm on their behalf.',
          });
        }
        case 'ping':
          return reply({});
        case 'tools/list':
          return reply({ tools: TOOLS });
        case 'tools/call':
          return reply(await callTool(msg.params?.name, msg.params?.arguments));
        default:
          return isNotification ? null : fail(-32601, `Method not found: ${msg.method}`);
      }
    } catch (err) {
      const message = redact(err.message);
      if (msg.method === 'tools/call') return reply({ content: [{ type: 'text', text: `LifeCycle couldn't answer: ${message}` }], isError: true });
      return fail(-32603, message);
    }
  };
}

export function runStdio({ app = createApp(), input = process.stdin, output = process.stdout } = {}) {
  const handle = createMcpHandler({ app, ask: createAskService({ app }) });
  const rl = readline.createInterface({ input });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
      return;
    }
    const res = await handle(msg);
    if (res) output.write(JSON.stringify(res) + '\n');
  });
  return rl;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runStdio();
