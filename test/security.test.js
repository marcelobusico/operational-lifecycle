// Local-server and link safety: requests addressed to another host name (DNS rebinding) are refused,
// and links from an alert feed that aren't http(s) are dropped.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-security-'));
process.env.LIFECYCLE_HOME = HOME;
const { createServer } = await import('../src/server.js');
const { readAlerts } = await import('../src/changes.js');
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const update = { version: () => ({ kind: 'manual', commit: null, date: null }), check: async () => ({}), start: () => ({}), progress: () => ({}) };

function get(port, host) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/update/version', headers: { host } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the local server answers only requests addressed to 127.0.0.1 or localhost', async () => {
  const server = createServer({}, {}, update);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `lifecycle.localhost:${port}`, `[::1]:${port}`]) {
      assert.equal(await get(port, host), 200, host);
    }
    for (const host of [`attacker.example:${port}`, `localhost.attacker.example:${port}`, `127.0.0.1.nip.io:${port}`]) {
      assert.equal(await get(port, host), 403, host);
    }
  } finally {
    await new Promise((r) => { server.close(r); server.closeAllConnections(); });
  }
});

test('alert feed links that are not http(s) are dropped', async () => {
  const feed = path.join(HOME, 'alerts.json');
  const at = '2026-11-02T10:00:00Z';
  fs.writeFileSync(feed, JSON.stringify({ schema: 'lifecycle.alerts/v1', alerts: [
    { id: 'a1', feature: 'x', message: 'ok', at, link: 'https://example.com/a1' },
    { id: 'a2', feature: 'x', message: 'bad', at, link: 'javascript:alert(1)' },
    { id: 'a3', feature: 'x', message: 'bad', at, link: ' JavaScript:alert(1)' },
    { id: 'a4', feature: 'x', message: 'bad', at, link: 'data:text/html,<script>alert(1)</script>' },
  ] }));
  const { alerts } = await readAlerts({ alerts: { source: feed } });
  assert.deepEqual(alerts.map((a) => [a.id, a.link]), [['a1', 'https://example.com/a1'], ['a2', null], ['a3', null], ['a4', null]]);
});
