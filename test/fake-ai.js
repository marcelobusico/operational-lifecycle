// Stand-ins for the AI providers: the Anthropic Messages API (claude) and an OpenAI-compatible
// /chat/completions endpoint. They read the question like a model would (here with LifeCycle's own
// rules) and record every request, so tests can see which provider answered.
import http from 'node:http';
import { extractMention } from '../src/ask/resolve.js';
import { ruleIntent } from '../src/ask/answer.js';

// Feature definition review: no findings, unless the test set state.reviewFindings (a list, or a
// function of the prompt returning one or null) or the definition says "CONTRADICTION", a marker
// tests can put in a done_when.
function reply(system, user, state) {
  if (system.includes('review a LifeCycle feature definition')) {
    const set = typeof state.reviewFindings === 'function' ? state.reviewFindings(user) : state.reviewFindings;
    if (set) return { findings: set };
    const m = user.match(/^\s*(?:- )?.*done_when: .*CONTRADICTION.*$/m);
    return { findings: m ? [{ kind: 'contradiction', field: 'steps[0].done_when', message: 'The done_when contradicts the step order.', suggestion: 'Reword it.' }] : [] };
  }
  // Import from links: the test sets state.importReply (a function of the prompt, or a value).
  if (system.includes('turn plans written in Jira')) {
    state.importPrompts.push(user);
    const r = typeof state.importReply === 'function' ? state.importReply(user) : state.importReply;
    return r || { items: [] };
  }
  if (system.includes('route questions')) {
    const question = user.split('Question: ').pop().trim();
    return { intent: ruleIntent(question), mention: extractMention(question) };
  }
  // Lead: cite the first statement, without adding any fact.
  const first = user.match(/\[(f\d+)\]/);
  return { text: 'Here is where it stands, from LifeCycle.', cites: first ? [first[1]] : [] };
}

export function startFakeAi(kind) {
  const state = { requests: [], down: false, reviewFindings: null, importReply: null, importPrompts: [], cutOff: false };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      state.requests.push({ url: req.url, auth: req.headers.authorization || req.headers['x-api-key'] || null, body });
      if (state.down) {
        res.writeHead(503, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'down' } }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      // state.cutOff: the answer stops halfway, at the length limit.
      const text = (out) => (state.cutOff ? JSON.stringify(out).slice(0, 20) : JSON.stringify(out));
      if (kind === 'claude') {
        const out = reply(body.system, body.messages[0].content, state);
        return res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model, stop_reason: state.cutOff ? 'max_tokens' : 'end_turn',
          content: [{ type: 'text', text: text(out) }], usage: { input_tokens: 1, output_tokens: 1 } }));
      }
      const out = reply(body.messages[0].content, body.messages[1].content, state);
      return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text(out) }, finish_reason: state.cutOff ? 'length' : 'stop' }] }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    state,
    url: `http://127.0.0.1:${server.address().port}${kind === 'claude' ? '' : '/v1'}`,
    close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }),
  })));
}
