// The last-mile world plus a mobile app: a fake App Store Connect (iOS), release tags in the app's
// repo, and mobile features. Google Play isn't connected in LifeCycle yet; fakeGooglePlay() is a
// test-only connector that plugs in through the same store layer a real one would use.
import { startWorld, DATA } from './last-mile-fixture.js';
import { startFakeAppStore } from './fake-app-store.js';

export const MOBILE = 'team/mobile';
export const IOS_ID = '1234567890';
export const ANDROID_ID = 'com.acme.app';

const mobileFeature = (id, name, { first, flags = [], pr }) => [
  `id: ${id}`, `name: ${name}`, 'owner: Mobile team', 'services: []', `flags: [${flags.join(', ')}]`,
  'apps:', '  - id: acme-mobile', `    first_version: { ios: ${first}, android: ${first} }`,
  'steps:',
  `  - { id: development, name: Development, owner: "@dev", done_when: merged with CI passing, evidence: [{ source: github, type: pr, repo: ${MOBILE}, number: ${pr} }] }`,
].join('\n') + '\n';

export async function startMobileWorld() {
  const w = await startWorld();
  const store = await startFakeAppStore();
  const { gh } = w;
  gh.state.readable.add(MOBILE);
  const files = gh.state.files.get(DATA);
  files.set('apps/acme-mobile.yaml', [
    'id: acme-mobile', 'name: Acme', 'owner: Mobile team', `repo: ${MOBILE}`, 'platforms:',
    `  ios: { store: app_store, store_id: "${IOS_ID}" }`, `  android: { store: google_play, store_id: ${ANDROID_ID} }`,
  ].join('\n') + '\n');
  files.set('apps/ghost-app.yaml', 'id: ghost-app\nname: Ghost\nrepo: team/mobile\nplatforms:\n  ios: { store: app_store, store_id: "999" }\n');
  files.set('features/mobile-rewards.yaml', mobileFeature('mobile-rewards', 'Rewards in the app', { first: '3.4.0', pr: 11 }));
  files.set('features/mobile-reader.yaml', mobileFeature('mobile-reader', 'New app reader', { first: '3.5.0', pr: 12 }));
  files.set('features/mobile-wishlist.yaml', mobileFeature('mobile-wishlist', 'Wishlist in the app', { first: '3.3.0', flags: ['rewards_enabled'], pr: 13 }));
  files.set('features/mobile-ghost.yaml', 'id: mobile-ghost\nname: Ghost app feature\nowner: Mobile team\napps:\n  - id: ghost-app\n    first_version: { ios: 1.0.0 }\nsteps:\n  - { id: development, name: Development, owner: "@dev", done_when: merged, evidence: [{ source: github, type: pr, repo: team/mobile, number: 11 }] }\n');
  files.set('features/mobile-untagged.yaml', mobileFeature('mobile-untagged', 'Untagged version', { first: '3.6.0', pr: 11 }));

  const merged = (n, sha) => {
    gh.state.prs.set(`${MOBILE}#${n}`, { title: `PR ${n}`, state: 'closed', merged_at: '2026-10-15T12:00:00Z', merge_commit_sha: sha, head: { sha: `mhead${n}` } });
    gh.state.runs.set(`${MOBILE}@${sha}`, [{ name: 'CI', status: 'completed', conclusion: 'success', html_url: `https://github.com/${MOBILE}/actions/runs/${n}00` }]);
  };
  merged(11, 'mmm11'); merged(12, 'mmm12'); merged(13, 'mmm13');
  // Release tags: 3.3.0 has PR 13; 3.4.0 adds PR 11; 3.5.0 adds PR 12.
  gh.state.tags.set(MOBILE, [{ name: 'v3.5.0', sha: 'tag350' }, { name: 'v3.4.0', sha: 'tag340' }, { name: 'v3.3.0', sha: 'tag330' }]);
  gh.state.ancestors.set('tag330', new Set(['mmm13']));
  gh.state.ancestors.set('tag340', new Set(['mmm13', 'mmm11']));
  gh.state.ancestors.set('tag350', new Set(['mmm13', 'mmm11', 'mmm12']));

  // iOS: 3.4.0 released, phased day 5 = 20%; 3.5.0 in review.
  store.state.setVersions(IOS_ID, [
    { version: '3.3.0', state: 'READY_FOR_SALE', created: '2026-10-01T10:00:00Z' },
    { version: '3.4.0', state: 'READY_FOR_SALE', phased: { state: 'ACTIVE', day: 5 }, created: '2026-10-20T10:00:00Z' },
    { version: '3.5.0', state: 'IN_REVIEW', created: '2026-11-03T10:00:00Z' },
  ]);

  const config = { ...w.config, sources: { ...w.config.sources, appStore: { enabled: true, apiUrl: store.url, consoleUrl: 'https://appstoreconnect.apple.com', mcpUrl: null, timeoutMs: 5000 } } };
  return { ...w, store, config, storeCredentials: { app_store: store.credentials }, close: async () => { await w.close(); await store.close(); } };
}

// A test-only Google Play connector holding versions in memory (the contract of src/stores/index.js).
export function fakeGooglePlay(versions) {
  const state = { versions, down: false };
  return {
    state,
    factory: () => ({
      store: 'google_play', name: 'Google Play', platforms: ['android'],
      async readApp(storeId) {
        if (storeId !== ANDROID_ID) return { unknown: true, link: 'https://play.google.com/console' };
        const link = `https://play.google.com/console/developers/app/${storeId}/tracks/production`;
        return { unknown: false, name: 'Acme', link, versions: state.versions.map((v) => ({ ...v, link })) };
      },
    }),
  };
}
