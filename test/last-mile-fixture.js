// One fake world for the last-mile acceptance scenarios: a fake GitHub (PRs, GitHub Actions,
// deployments), a fake Flagsmith and a fake Statsig MCP server holding equivalent flag settings,
// with one feature per scenario. Used by the tests. No
// network, no real credentials. configFor('statsig') is the same world read from Statsig.
import { startFakeGithub } from './fake-github.js';
import { startFakeFlagsmith } from './fake-flagsmith.js';
import { startFakeStatsig } from './fake-statsig.js';
import { DEFAULTS } from '../src/config.js';

export const DATA = 'team/LifeCycle-Data';
export const CATALOG = 'team/catalog';
export const WISHLIST = 'team/wishlist';

const feature = (id, name, { services = ['catalog-api'], flags = [], pr }) => [
  `id: ${id}`, `name: ${name}`, 'owner: Catalog team', `services: [${services.join(', ')}]`, `flags: [${flags.join(', ')}]`,
  'steps:',
  `  - { id: development, name: Development, owner: "@dev", done_when: merged with CI passing, evidence: [{ source: github, type: pr, repo: ${pr.repo || CATALOG}, number: ${pr.number} }] }`,
].join('\n') + '\n';

export async function startWorld() {
  const gh = await startFakeGithub();
  const fs = await startFakeFlagsmith();
  const st = await startFakeStatsig();
  for (const r of [DATA, CATALOG, WISHLIST]) gh.state.readable.add(r);
  gh.state.files.set(DATA, new Map([
    ['services/catalog-api.yaml', `id: catalog-api\nname: Catalog API\nrepo: ${CATALOG}\n`],
    ['services/wishlist-api.yaml', `id: wishlist-api\nname: Wishlist API\nrepo: ${WISHLIST}\n`],
    ['features/rewards.yaml', feature('rewards', 'Rewards points', { flags: ['rewards_enabled'], pr: { number: 1 } })],
    ['features/redeem-rewards.yaml', feature('redeem-rewards', 'Redeem rewards', { flags: ['redeem_rewards'], pr: { number: 2 } })],
    ['features/referral-bonus.yaml', feature('referral-bonus', 'Referral bonus', { flags: ['referral_bonus'], pr: { number: 3 } })],
    ['features/wishlist-share.yaml', feature('wishlist-share', 'Wishlist share', { services: ['wishlist-api'], pr: { number: 4, repo: WISHLIST } })],
    ['features/reading-history.yaml', feature('reading-history', 'Reading history', { pr: { number: 5 } })],
    ['features/loyalty-tiers.yaml', feature('loyalty-tiers', 'Loyalty tiers', { flags: ['ghost_flag'], pr: { number: 6 } })],
    ['features/reader-redesign.yaml', feature('reader-redesign', 'Reader redesign', { flags: ['new_reader'], pr: { number: 7 } })],
  ]));

  const merged = (repo, n, sha) => {
    gh.state.prs.set(`${repo}#${n}`, { title: `PR ${n}`, state: 'closed', merged_at: '2026-11-01T12:00:00Z', merge_commit_sha: sha, head: { sha: `head${n}` } });
    gh.state.runs.set(`${repo}@${sha}`, [{ name: 'CI', status: 'completed', conclusion: 'success', html_url: `https://github.com/${repo}/actions/runs/${n}00` }]);
  };
  merged(CATALOG, 1, 'aaa1'); merged(CATALOG, 2, 'aaa2'); merged(CATALOG, 3, 'aaa3'); merged(CATALOG, 5, 'aaa5'); merged(CATALOG, 6, 'aaa6');
  merged(WISHLIST, 4, 'bbb4');
  gh.state.prs.set(`${CATALOG}#7`, { title: 'PR 7', state: 'open', merged_at: null, head: { sha: 'head7' } });

  const payShas = ['aaa1', 'aaa2', 'aaa3', 'aaa5', 'aaa6'];
  gh.state.deploy(CATALOG, 'qa', { sha: 'rr-0.3.0', version: '0.3.0', includes: payShas, at: '2026-11-02T09:00:00Z' });
  gh.state.deploy(CATALOG, 'production', { sha: 'rr-0.3.0', version: '0.3.0', includes: payShas, at: '2026-11-02T15:00:00Z' });
  gh.state.deploy(WISHLIST, 'qa', { sha: 'wal-1.1.0', version: '1.1.0', includes: ['bbb4'], at: '2026-11-02T10:00:00Z' });
  gh.state.deploy(WISHLIST, 'production', { sha: 'wal-1.0.0', version: '1.0.0', includes: [], at: '2026-10-20T10:00:00Z' });

  // The same setting in both platforms: Flagsmith environments QA/Production are Statsig's
  // staging/production; a Flagsmith % segment is a Statsig public rule at that %.
  const STATSIG_ENV = { QA: 'staging', Production: 'production' };
  const setFlag = (env, name, opts) => { fs.state.set(env, name, opts); st.state.set(STATSIG_ENV[env], name, opts); };
  setFlag('QA', 'rewards_enabled', { enabled: true, at: '2026-11-02T09:30:00Z' });
  setFlag('Production', 'rewards_enabled', { enabled: false, at: '2026-11-01T08:00:00Z' });
  setFlag('QA', 'redeem_rewards', { enabled: true, at: '2026-11-02T09:30:00Z' });
  setFlag('Production', 'redeem_rewards', { enabled: false, rollout: 25, at: '2026-11-02T16:00:00Z' });
  setFlag('QA', 'referral_bonus', { enabled: true, at: '2026-11-02T09:30:00Z' });
  setFlag('Production', 'referral_bonus', { enabled: true, at: '2026-11-02T16:00:00Z' });
  setFlag('QA', 'new_reader', { enabled: false, at: '2026-11-02T09:30:00Z' });
  setFlag('Production', 'new_reader', { enabled: false, at: '2026-11-02T09:30:00Z' });

  const config = {
    ...DEFAULTS,
    dataRepo: DATA,
    sources: {
      github: { enabled: true, apiUrl: gh.url },
      flagsmith: { ...DEFAULTS.sources.flagsmith, apiUrl: fs.url, projectId: fs.projectId },
    },
  };
  const configFor = (platform) => (platform === 'statsig'
    ? { ...config, flagPlatform: 'statsig', sources: { ...config.sources, statsig: { ...DEFAULTS.sources.statsig, mcpUrl: st.url } } }
    : config);
  return { gh, fs, st, config, configFor, setFlag, close: async () => { await gh.close(); await fs.close(); await st.close(); } };
}
