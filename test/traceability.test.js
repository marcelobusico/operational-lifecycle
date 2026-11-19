// Traceability: every status LifeCycle shows links to the exact item it was read from, or says
// there is none, and shows when it was last read. Runs the real app on the sample data (test/fixtures/sample-data)
// against a fake GitHub, a fake Flagsmith and a fake Statsig (for the sample experiment) shaped like
// the sample environment. No network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGithub } from './fake-github.js';
import { startFakeFlagsmith } from './fake-flagsmith.js';
import { startFakeStatsig } from './fake-statsig.js';
import { createApp } from '../src/app.js';
import { createServer } from '../src/server.js';
import { createAskService } from '../src/ask/service.js';
import { answerMarkdown } from '../src/ask/render.js';
import { DEFAULTS } from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE = path.join(ROOT, 'test', 'fixtures', 'sample-data');
const REPO = 'acme-org/acme-monolith';
const RUN = (n) => `https://github.com/${REPO}/actions/runs/${n}`;
let gh, fsm, st, config;

before(async () => {
  process.env.LIFECYCLE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-trace-'));
  gh = await startFakeGithub();
  fsm = await startFakeFlagsmith();
  st = await startFakeStatsig();
  // The experiment planted in the team's Statsig project for redeem-rewards.
  st.state.experiment('redeem_rewards_groups', { groups: [{ name: 'Control', size: 50, description: 'Card only' },
    { name: 'A', size: 25, description: 'Redeem points' }, { name: 'B', size: 25, description: 'Redeem points, 10% bonus' }] });
  gh.state.readable.add(REPO);
  // The sample environment: PR #2 and #3 merged with CI passing, #4 merged with its Release run
  // failing, #17 the open (draft) release PR. Production runs #2 (deployed by a pipeline run), QA runs #3
  // (a hand-made record, no run).
  const merged = (n, sha, conclusion = 'success') => {
    gh.state.prs.set(`${REPO}#${n}`, { title: `PR ${n}`, state: 'closed', merged_at: '2026-11-01T12:00:00Z', merge_commit_sha: sha, head: { sha: `head${n}` } });
    gh.state.runs.set(`${REPO}@${sha}`, [{ name: conclusion === 'success' ? 'CI' : 'Release', status: 'completed', conclusion, html_url: RUN(n * 100) }]);
  };
  merged(2, 'sha2'); merged(3, 'sha3'); merged(4, 'sha4', 'failure');
  gh.state.prs.set(`${REPO}#17`, { title: 'chore: release 0.2.2', state: 'open', draft: true, merged_at: null, head: { sha: 'head17' } });
  gh.state.deploy(REPO, 'production', { sha: 'sha2', version: '0.2.0', includes: ['sha2'], log_url: `${RUN(999)}/job/1` });
  gh.state.deploy(REPO, 'qa', { sha: 'sha3', version: '0.1.0', includes: ['sha2', 'sha3'] });
  for (const env of ['QA', 'Production']) {
    fsm.state.set(env, 'rewards_enabled', { enabled: env === 'QA' });
    fsm.state.set(env, 'referral_bonus', { enabled: false });
  }
  fsm.state.set('QA', 'redeem_rewards', { enabled: true });
  fsm.state.set('Production', 'redeem_rewards', { enabled: false, rollout: 25 });
  config = {
    ...DEFAULTS, dataPath: SAMPLE,
    sources: { github: { enabled: true, apiUrl: gh.url }, flagsmith: { ...DEFAULTS.sources.flagsmith, apiUrl: fsm.url, projectId: fsm.projectId },
      statsig: { ...DEFAULTS.sources.statsig, mcpUrl: st.url } },
  };
});
after(async () => { await gh.close(); await fsm.close(); await st.close(); });

const appWith = (over = {}) => createApp({ config: { ...config, ...over, sources: { ...config.sources, ...(over.sources || {}) } }, token: gh.token, flagsmithApiKey: fsm.apiKey, statsigApiKey: st.apiKey });

// A link to one specific item: a PR, issue, Actions run, commit, deploy record, flag, definition
// file or LifeCycle feature view. Never a repo or tool home page or a list of items.
function specific(url) {
  const u = new URL(url);
  if (u.hostname === 'github.com') {
    return /^\/[^/]+\/[^/]+\/(pull\/\d+(\/checks)?|issues\/\d+|actions\/runs\/\d+(\/job\/\d+)?|commit\/[0-9a-z]+|blob\/.+\.ya?ml)$/.test(u.pathname);
  }
  if (url.startsWith(gh.url) || u.hostname === 'api.github.com') return /^\/repos\/[^/]+\/[^/]+\/deployments\/\d+$/.test(u.pathname);
  if (url.startsWith(DEFAULTS.sources.flagsmith.appUrl)) return /^\/project\/\d+\/environment\/[^/]+\/features$/.test(u.pathname) && /^\d+$/.test(u.searchParams.get('feature') || '');
  if (u.hostname === 'console.statsig.com') return /^\/[^/]+\/experiments\/[\w-]+$/.test(u.pathname);
  if (u.hostname === 'lifecycle.localhost') return /^#\/feature\/[a-z0-9-]+$/.test(u.hash) || /^\/api\/definitions\/.+\.ya?ml$/.test(u.pathname);
  return false;
}

test('sample data: every status has a specific source link or an explicit "no source item" note, and a read time', async () => {
  const snap = await appWith().refresh();
  // Every sample feature.
  const active = fs.readdirSync(path.join(SAMPLE, 'features'));
  assert.equal(snap.features.length, active.length);
  const kinds = new Set();
  for (const f of snap.features) {
    assert.ok(f.sources.length, `${f.feature.id} has no sources`);
    for (const t of f.sources) {
      const where = `${f.feature.id} ${t.key}`;
      kinds.add(t.kind);
      assert.ok(t.links.length || (typeof t.no_source_item === 'string' && t.no_source_item.length > 10), `${where}: no link and no note`);
      for (const l of t.links) assert.ok(specific(l.url), `${where}: not a specific item: ${l.url}`);
      assert.ok(t.read_at, `${where}: no read time`);
    }
  }
  assert.deepEqual([...kinds].sort(), ['blocked', 'delay', 'deployed', 'developed', 'experiment', 'flag']);

  // The click-through: each kind of status opens the exact item it came from.
  const by = Object.fromEntries(snap.features.map((f) => [f.feature.id, f]));
  const src = (id, key) => by[id].sources.find((t) => t.key === key);
  assert.equal(src('ci-checks', 'step:development').links[0].url, `https://github.com/${REPO}/pull/2`);
  assert.equal(src('ci-checks', `actions:${REPO}#2`).links[0].url, RUN(200));
  assert.equal(src('versioned-releases', 'deploy:catalog-api:production').links[0].url, `${RUN(999)}/job/1`, 'pipeline run that deployed it');
  const qaId = gh.state.deployments.get(`${REPO}:qa`)[0].id;
  assert.ok(src('versioned-releases', 'deploy:catalog-api:qa').links[0].url.endsWith(`/repos/${REPO}/deployments/${qaId}`), 'the QA deploy record');
  assert.match(src('redeem-rewards', 'flag:redeem_rewards:production').links[0].url, /\/environment\/prodEnvKey456\/features\?feature=\d+$/);
  // Experiment: the feature in an experiment opens that experiment in Statsig, with its read time.
  const exp = src('redeem-rewards', 'experiment:redeem_rewards_groups:production');
  assert.equal(exp.state, 'running');
  assert.equal(exp.links[0].url, `https://console.statsig.com/${st.company}/experiments/redeem_rewards_groups`);
  assert.ok(exp.read_at);
  const blocked = by['redeem-rewards'].sources.filter((t) => t.kind === 'blocked');
  assert.ok(blocked.some((t) => t.links[0].url === `https://github.com/${REPO}/pull/17`), 'blocked opens the open release PR');
  // Nothing to link to is said, not linked generically.
  assert.match(src('loyalty-tiers', 'flag:loyalty_tiers:production').no_source_item, /doesn't exist in the flag console/);
});

test('GitHub unreachable: step statuses say "source unavailable since <time>" and keep their last known links', async () => {
  const good = await appWith().refresh();
  const before = Object.fromEntries(good.features.map((f) => [f.feature.id, f]));
  const down = await appWith({ sources: { github: { enabled: false, apiUrl: gh.url } } }).refresh();
  for (const f of down.features) {
    for (const t of f.sources.filter((x) => x.kind === 'developed' || x.kind === 'deployed')) {
      const where = `${f.feature.id} ${t.key}`;
      assert.equal(t.unavailable, true, where);
      assert.ok(t.unavailable_since, `${where}: unavailable since`);
      assert.ok(t.read_at && t.read_at < t.unavailable_since, `${where}: last successful read before it went down`);
      const was = before[f.feature.id].sources.find((x) => x.key === t.key);
      assert.deepEqual(t.links.map((l) => l.url), was.links.map((l) => l.url), `${where}: keeps the last known link`);
    }
    assert.notEqual(f.state, 'done');
    assert.notEqual(f.state, 'blocked');
  }
  // The same in the answer a person's AI tools relay.
  const ask = createAskService({ app: appWith({ sources: { github: { enabled: false, apiUrl: gh.url } } }), readConfig: () => ({ ai: { provider: 'none' } }) });
  const md = answerMarkdown(await ask.ask('How is CI checks going?', { via: 'ai-tools' }));
  assert.match(md, /source unavailable since \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
  assert.ok(md.includes(`(https://github.com/${REPO}/pull/2)`), 'keeps the PR link');
});

test('a shared feature link opens the same feature view on another teammate\'s LifeCycle', async () => {
  const start = () => new Promise((resolve) => {
    const server = createServer(appWith());
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) }));
  });
  const [a, b] = await Promise.all([start(), start()]);
  const id = 'redeem-rewards';
  const [sa, sb] = await Promise.all([a, b].map(async (lc) => (await fetch(`${lc.url}/api/features/${id}/status`)).json()));
  // Both copies run on the standard local address, so the link means the same view on either.
  assert.equal(sa.share_link, `http://lifecycle.localhost:${DEFAULTS.port}/#/feature/${id}`);
  assert.equal(sb.share_link, sa.share_link);
  const page = await fetch(b.url + new URL(sa.share_link).pathname);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<script[^>]+app\.js/);
  assert.equal(sb.state, sa.state);
  assert.deepEqual(sb.sources.map((t) => [t.key, t.state, t.links.map((l) => l.url)]), sa.sources.map((t) => [t.key, t.state, t.links.map((l) => l.url)]));
  await a.close();
  await b.close();
});

test('the experiment: the same Statsig link and read time in the browser view and in the AI-tool answer, kept when Statsig is down', async () => {
  const app = appWith();
  const snap = await app.refresh();
  const src = snap.features.find((f) => f.feature.id === 'redeem-rewards').sources.find((t) => t.key === 'experiment:redeem_rewards_groups:production');
  const link = `https://console.statsig.com/${st.company}/experiments/redeem_rewards_groups`;
  assert.deepEqual(src.links.map((l) => l.url), [link]);
  const ask = createAskService({ app, readConfig: () => ({ ai: { provider: 'none' } }) });
  const md = answerMarkdown(await ask.ask('Is redeem rewards available to users?', { via: 'ai-tools' }));
  assert.ok(md.includes(`(${link})`), 'the answer links the experiment');
  assert.match(md, /Experiment redeem_rewards_groups is running in production .*Control \(control\) 50%: No rewards option/);
  st.state.down = true;
  try {
    const down = (await app.refresh()).features.find((f) => f.feature.id === 'redeem-rewards').sources.find((t) => t.key === src.key);
    assert.ok(down.unavailable && down.unavailable_since, 'source unavailable since <time>');
    assert.ok(down.read_at >= src.read_at && down.read_at <= down.unavailable_since, 'last successful read, before it went down');
    assert.deepEqual(down.links.map((l) => l.url), [link], 'keeps the last known experiment link');
    const mdDown = answerMarkdown(await ask.ask('Is redeem rewards available to users?', { via: 'ai-tools' }));
    assert.match(mdDown, /experiment redeem_rewards_groups in production \(source unavailable since \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\)/i);
    assert.ok(mdDown.includes(`(${link})`));
  } finally {
    st.state.down = false;
  }
});

test('reading a local data folder that is not a git clone writes nothing into it (no snapshots)', () => {
  for (const dir of ['flag-snapshots', 'store-snapshots']) assert.ok(!fs.existsSync(path.join(SAMPLE, dir)), `${dir}/ written into the sample data`);
});
