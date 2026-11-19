// Last-mile reads for one refresh: development (PRs + GitHub Actions), deploy records per service and
// environment (GitHub Deployments), flags per environment (Flagsmith or Statsig, as the person
// chose in config.flagPlatform; both answer the same readProject/readFlag contract) and the
// experiments the feature takes part in (always Statsig, over the same shared connection). Each distinct read happens
// once per refresh and is logged once per feature that uses it. Failed reads never become a state:
// they come back as unavailable / no_access with the last successful read time.
import fs from 'node:fs';
import path from 'node:path';
import { paths, writeJson, DEFAULTS } from '../config.js';
import { logSourceRead } from '../log.js';
import { SourceError } from '../sources/github-client.js';
import { createLastMileGithub } from './github.js';
import { createFlagsmithClient, createFlagsmithSource } from './flagsmith.js';
import { createStatsigSource } from './statsig.js';
import { createStatsigConnection } from '../sources/statsig.js';
import { createExperimentSource } from './experiments.js';
import { snapshotEnvironment } from './flag-snapshots.js';
import { lastMileState, storeLabel, ENVIRONMENTS, ENV_LABEL } from './state.js';
import { createStores, featureRelease, compareVersions, STORE_NAME, PLATFORM_LABEL } from '../stores/index.js';
import { createSlackReleaseReader } from '../stores/slack-releases.js';

const PLATFORM_NAME = { statsig: 'Statsig', flagsmith: 'Flagsmith' };

const cacheFile = () => path.join(paths.cacheDir(), 'last-mile.json');

function loadCache() {
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    return { reads: c.reads || {}, flags: c.flags || {}, failing: c.failing || {}, links: c.links || {}, experiments: c.experiments || {}, stores: c.stores || {} };
  } catch {
    return { reads: {}, flags: {}, failing: {}, links: {}, experiments: {}, stores: {} };
  }
}

// slackRun: replaces the Claude Code call that reads Slack (tests).
export function createLastMile({ config, githubClient, flagsmithKey, statsigKey = null, storeCredentials = {}, storeConnectors = {}, fetchImpl, slackRun }) {
  const gh = createLastMileGithub(githubClient);
  // App releases from Slack release channels: only on the machine that reads Slack (sources.slack.enabled).
  const slackCfg = { ...DEFAULTS.sources.slack, ...(config.sources?.slack || {}) };
  const slack = slackCfg.enabled ? createSlackReleaseReader({ cfg: slackCfg, ...(slackRun ? { run: slackRun } : {}),
    log: (x) => logSourceRead({ source: 'slack', feature: '*', target: 'release channel', ...x }) }) : null;
  // App stores, one connector per store (src/stores/index.js); a store without one is "not connected".
  const stores = createStores({ config, credentials: storeCredentials, fetchImpl, connectors: storeConnectors });
  // Configs built without a flag console section (older config files, tests) get the defaults.
  const fsCfg = { ...DEFAULTS.sources.flagsmith, ...(config.sources?.flagsmith || {}) };
  const stCfg = { ...DEFAULTS.sources.statsig, ...(config.sources?.statsig || {}) };
  stCfg.environments = { ...DEFAULTS.sources.statsig.environments, ...(config.sources?.statsig?.environments || {}) };
  const platform = config.flagPlatform === 'statsig' ? 'statsig' : 'flagsmith';
  // One Statsig connection for flags (when Statsig is the flag platform) and experiments.
  const statsig = createStatsigConnection({ mcpUrl: stCfg.mcpUrl, apiKey: statsigKey, enabled: stCfg.enabled, timeoutMs: stCfg.timeoutMs, fetchImpl });
  const experimentSource = createExperimentSource({ connection: statsig, consoleUrl: stCfg.consoleUrl });
  const flagSource = platform === 'statsig'
    ? createStatsigSource({
      connection: statsig,
      consoleUrl: stCfg.consoleUrl,
      environmentNames: stCfg.environments,
    })
    : createFlagsmithSource({
      client: createFlagsmithClient({ apiUrl: fsCfg.apiUrl, apiKey: flagsmithKey, enabled: fsCfg.enabled, fetchImpl }),
      projectId: fsCfg.projectId,
      appUrl: fsCfg.appUrl,
      environmentNames: fsCfg.environments,
    });
  const projectLabel = platform === 'statsig' ? 'feature gates' : `project ${fsCfg.projectId}`;

  // Computes the last_mile block for every feature. services: the validated service catalog.
  // apps: the app catalog (apps/*.yaml). snapshots: committed store snapshots (store-snapshots/*.yaml).
  // flagSnapshots: committed flag snapshots (flag-snapshots/*.yaml), used when a flag can't be read live.
  async function compute(features, services, apps = [], snapshots = [], flagSnapshots = []) {
    storeReads = new Map();
    flagReads = new Map();
    // Flag cells that couldn't be read live, and how many of them a team snapshot stood in for.
    const flagFallback = { failed: 0, covered: 0, oldest: null };
    const cache = loadCache();
    const readAt = new Date().toISOString();
    flagStatus = { state: 'not_used' };
    // The flag source's health for this refresh: the first problem wins over a good read.
    const noteFlags = (r, extra = {}) => {
      if (flagStatus.state === 'problem') return;
      flagStatus = r.ok ? { state: 'ok', read_at: readAt }
        : { state: 'problem', reason: r.reason, message: r.message, last_successful_read_at: r.last_successful_read_at ?? null, unavailable_since: r.unavailable_since ?? null, ...extra };
    };
    const shared = new Map();
    const once = (key, fn) => {
      if (!shared.has(key)) shared.set(key, fn().then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })));
      return shared.get(key);
    };

    // Runs a shared read, logs it for this feature and records the last successful read time.
    async function read(key, { source, feature, target }, fn) {
      const r = await once(key, fn);
      if (r.ok) {
        cache.reads[key] = readAt;
        delete cache.failing[key];
        logSourceRead({ source, feature, target, outcome: 'ok' });
        return { ok: true, value: r.value };
      }
      if (!(r.error instanceof SourceError)) throw r.error;
      logSourceRead({ source, feature, target, outcome: r.error.kind, status: r.error.status, detail: r.error.message });
      // "Unavailable since": when this read first failed after its last success.
      if (!cache.failing[key]) cache.failing[key] = readAt;
      return {
        ok: false,
        state: r.error.kind === 'no_access' ? 'no_access' : 'unavailable',
        reason: r.error.reason || (r.error.kind === 'no_access' ? 'no_access' : 'unreachable'),
        message: r.error.message,
        last_successful_read_at: cache.reads[key] || null,
        unavailable_since: cache.failing[key],
      };
    }
    // The last item each status was read from, kept so a failed read still links to it.
    const remember = (key, link) => { if (link) cache.links[key] = link; else delete cache.links[key]; };
    const known = (key) => cache.links[key] || null;

    const catalog = new Map(services.map((s) => [s.id, s]));
    const appCatalog = new Map(apps.map((a) => [a.id, a]));
    const snapshotOf = (app, plat) => snapshots.find((x) => x.app === app && x.platform === plat) || null;
    // A live flag read failed: the team's committed snapshot of that flag and environment stands in,
    // marked as such with its read time. null when there is no snapshot for it.
    const flagSnapshotOf = (key) => flagSnapshots.find((x) => x.flag === key && x.platform === platform) || null;
    const flagFromSnapshot = (key, env, failure) => {
      flagFallback.failed += 1;
      const snap = flagSnapshotOf(key);
      const c = snap?.environments[env];
      if (!c) return null;
      flagFallback.covered += 1;
      if (!flagFallback.oldest || snap.read_at < flagFallback.oldest) flagFallback.oldest = snap.read_at;
      return { ...c, link: c.link || known(`link:flag:${env}:${key}`), from_snapshot: true, snapshot_read_at: snap.read_at,
        live_state: failure.state, message: failure.message, unavailable_since: failure.unavailable_since ?? null };
    };
    const out = new Map();

    await Promise.all(features.map(async (f) => {
      const ctx = (source, target) => ({ source, feature: f.id, target });

      // Development: every linked PR merged, with GitHub Actions passing on its merge commit.
      const prRefs = f.steps.flatMap((s) => s.evidence).filter((e) => e.source === 'github' && e.type === 'pr');
      const prs = await Promise.all(prRefs.map(async (e) => {
        const key = `actions:${e.repo}#${e.number}`;
        const r = await read(key, ctx('github-actions', `${e.repo}#${e.number}`), () => gh.readPrActions(e));
        if (r.ok) remember(`link:${key}`, r.value.actions_link);
        return r.ok ? { ...r.value, state: 'ok' } : { repo: e.repo, number: e.number, link: `https://github.com/${e.repo}/pull/${e.number}`, actions_link: known(`link:${key}`), ...r };
      }));
      const development = developmentState(prs);

      // Deploys per service and environment, and whether each deployed commit includes the feature.
      const mergedByRepo = new Map();
      for (const p of prs) if (p.merge_sha) mergedByRepo.set(p.repo, [...(mergedByRepo.get(p.repo) || []), p.merge_sha]);
      const svc = await Promise.all(f.services.map(async (id) => {
        const def = catalog.get(id);
        if (!def) return { id, repo: null, unknown: true, environments: Object.fromEntries(ENVIRONMENTS.map((env) => [env, { state: 'unavailable', deployed: false, message: `no services/${id}.yaml` }])) };
        const environments = {};
        await Promise.all(ENVIRONMENTS.map(async (env) => {
          const ghEnv = def.environments[env];
          const key = `deploy:${def.repo}:${ghEnv}`;
          const r = await read(key, ctx('github-deployments', `${def.repo} → ${ghEnv}`), () => gh.readDeployment({ repo: def.repo, environment: ghEnv }));
          if (!r.ok) {
            const last = cache.links[`link:${key}`];
            environments[env] = { ...r, github_environment: ghEnv, link: last?.url || null, link_kind: last?.kind || null };
            return;
          }
          const d = r.value;
          remember(`link:${key}`, d.link ? { url: d.link, kind: d.link_kind } : null);
          const cell = { state: 'ok', github_environment: ghEnv, ...d, contains_feature: null };
          const commits = mergedByRepo.get(def.repo) || [];
          if (d.deployed && commits.length) {
            const checks = await Promise.all(commits.map((c) => read(`contains:${def.repo}:${c}:${d.sha}`, ctx('github-deployments', `${def.repo} ${d.version} includes ${c.slice(0, 7)}?`), () => gh.contains({ repo: def.repo, commit: c, head: d.sha }))));
            const failed = checks.find((x) => !x.ok);
            if (failed) Object.assign(cell, { state: failed.state, message: failed.message, last_successful_read_at: failed.last_successful_read_at, unavailable_since: failed.unavailable_since });
            else cell.contains_feature = checks.every((x) => x.value);
          }
          environments[env] = cell;
        }));
        return { id, name: def.name, repo: def.repo, environments };
      }));

      // Flags per environment.
      let flags = [];
      if (f.flags.length) {
        const project = await read(`${platform}:project`, ctx(platform, projectLabel), () => flagSource.readProject());
        noteFlags(project);
        flags = await Promise.all(f.flags.map(async (key) => {
          if (!project.ok) {
            const cell = { state: project.state, message: project.message, last_successful_read_at: project.last_successful_read_at, unavailable_since: project.unavailable_since };
            // The team snapshot says the flag doesn't exist on the platform: an unknown flag, as a live read would say.
            const known404 = flagSnapshotOf(key);
            if (known404?.unknown) {
              flagFallback.failed += 1; flagFallback.covered += 1;
              if (!flagFallback.oldest || known404.read_at < flagFallback.oldest) flagFallback.oldest = known404.read_at;
              return { key, unknown: true, from_snapshot: true, snapshot_read_at: known404.read_at, environments: Object.fromEntries(ENVIRONMENTS.map((env) => [env, { state: 'unknown' }])) };
            }
            return { key, unknown: false, environments: Object.fromEntries(ENVIRONMENTS.map((env) => [env, flagFromSnapshot(key, env, cell) || { ...cell, link: known(`link:flag:${env}:${key}`) }])) };
          }
          const flag = project.value.flags.get(key);
          if (!flag) {
            logSourceRead({ source: platform, feature: f.id, target: `flag ${key}`, outcome: 'unknown_flag' });
            flagReads.set(key, { platform, flag: key, unknown: true, read_at: readAt });
            return { key, unknown: true, environments: Object.fromEntries(ENVIRONMENTS.map((env) => [env, { state: 'unknown' }])) };
          }
          const environments = {};
          await Promise.all(ENVIRONMENTS.map(async (env) => {
            const e = project.value.envs[env];
            if (e.missing) {
              const message = `The ${PLATFORM_NAME[platform]} project has no environment named "${e.name}" (it has: ${project.value.names.join(', ')}). Fix the environment names with \`npm run setup -- --extras\`.`;
              environments[env] = { state: 'missing_environment', message };
              flagFallback.failed += 1; // a setup problem: no snapshot stands in for it
              noteFlags({ ok: false, reason: 'missing_environment', message, last_successful_read_at: cache.reads[`${platform}:project`] || null });
              return;
            }
            const r = await read(`flag:${e.id}:${key}`, ctx(platform, `flag ${key} in ${e.name}`), () => flagSource.readFlag({ env: e, flag }));
            if (!r.ok) noteFlags(r);
            if (!r.ok) {
              environments[env] = flagFromSnapshot(key, env, r) || { ...r, link: known(`link:flag:${env}:${key}`) };
              return;
            }
            remember(`link:flag:${env}:${key}`, r.value.link);
            // Was it on before? The platform's version history if it keeps one, else what this machine saw last.
            const seenKey = `${e.id}:${key}`;
            const seen = cache.flags[seenKey];
            const wasOn = r.value.was_on_before === true || (r.value.state === 'off' && seen && seen.state !== 'off');
            const cell = { state: r.value.state, rollout_percentage: r.value.rollout_percentage, segments: r.value.segments,
              changed_at: r.value.changed_at, changed_by: r.value.changed_by, was_on_before: r.value.state === 'off' ? Boolean(wasOn) : null,
              link: r.value.link, platform_environment: e.name };
            // Remember when it was last seen on, so a later switch-off is reported as such.
            if (r.value.state !== 'off') cache.flags[seenKey] = { state: r.value.state, at: readAt };
            environments[env] = cell;
          }));
          // Read live in every environment: what the team snapshot of this flag would hold.
          if (ENVIRONMENTS.every((env) => ['on', 'off', 'partial'].includes(environments[env]?.state) && !environments[env].from_snapshot)) {
            flagReads.set(key, { platform, flag: key, read_at: readAt,
              environments: Object.fromEntries(ENVIRONMENTS.map((env) => [env, snapshotEnvironment(environments[env])])) });
          }
          return { key, unknown: false, environments };
        }));
      }

      // Experiments: one Statsig read each, shown per environment (src/lastmile/experiments.js).
      const experiments = await Promise.all((f.experiments || []).map(async (def) => {
        const key = `experiment:${def.id}`;
        const r = await read(key, ctx('statsig', `experiment ${def.id}`), () => experimentSource.readExperiment(def.id));
        if (!r.ok) {
          const cell = { state: r.state, message: r.message, last_successful_read_at: r.last_successful_read_at, unavailable_since: r.unavailable_since, link: known(`link:${key}`) };
          return { id: def.id, unknown: false, environments: Object.fromEntries(ENVIRONMENTS.map((env) => [env, { ...cell }])), events: experimentEvents(cache, def.id) };
        }
        if (r.value.unknown) {
          logSourceRead({ source: 'statsig', feature: f.id, target: `experiment ${def.id}`, outcome: 'unknown_experiment' });
          return { id: def.id, unknown: true, environments: Object.fromEntries(ENVIRONMENTS.map((env) => [env, { state: 'unknown' }])), events: [] };
        }
        const environments = Object.fromEntries(ENVIRONMENTS.map((env) => [env, experimentSource.cell(r.value, stCfg.environments[env], def.groups)]));
        remember(`link:${key}`, environments.production.link);
        return { id: def.id, unknown: false, environments, events: noteExperiment(cache, def.id, environments.production, readAt) };
      }));

      // Apps: per app and platform, where the version that first includes the feature stands in the store.
      const appCells = await Promise.all((f.apps || []).map((ref) => readFeatureApp({ f, ref, appCatalog, snapshotOf, read, cache, readAt, prs, ctx })));

      const verdict = lastMileState({ feature: f, development, services: svc, flags, experiments, apps: appCells, flagPlatform: platform });
      out.set(f.id, assemble(f, verdict, development, svc, flags, experiments, appCells, readAt, platform));
    }));

    // Every flag that couldn't be read live came from the team's snapshot: the flag source is then
    // "snapshot" (not a problem), with the reason it isn't live and the oldest snapshot read time.
    if (flagStatus.state === 'problem' && flagFallback.failed && flagFallback.covered === flagFallback.failed) {
      flagStatus = { ...flagStatus, state: 'snapshot', snapshot_read_at: flagFallback.oldest };
    }
    try {
      writeJson(cacheFile(), cache);
    } catch (err) {
      console.error(`lifecycle: could not save last-mile read times: ${err.message}`);
    }
    return out;
  }

  // How the flag source answered at the latest compute(): { platform, name, state: ok | not_used |
  // problem | snapshot (couldn't be read live, every flag shown from the team snapshot), reason (no_credential | wrong_key_type | rejected | no_access | missing_project |
  // missing_environment | unreachable | disabled), message (with the fix), last_successful_read_at }.
  let flagStatus = { state: 'not_used' };
  const flagSourceStatus = () => ({ platform, name: PLATFORM_NAME[platform], ...flagStatus });

  // One feature's app: per platform the app defines, where the feature's first version stands. Read
  // from, in order: the store itself; the app's Slack release channel (when this machine reads Slack);
  // the team snapshot in LifeCycle-Data (store-snapshots/), marked as such. Never guessed.
  async function readFeatureApp({ f, ref, appCatalog, snapshotOf, read, cache, readAt, prs, ctx }) {
    const def = appCatalog.get(ref.id);
    if (!def) return { id: ref.id, name: ref.id, repo: null, owner: null, unknown: true, platforms: {}, missing_platforms: Object.keys(ref.firstVersion) };
    const platforms = {};
    await Promise.all(Object.entries(def.platforms).map(async ([plat, where]) => {
      const first = ref.firstVersion[plat] || null;
      const base = { platform: plat, platform_label: PLATFORM_LABEL[plat], store: where.store, store_name: STORE_NAME[where.store] || where.store, store_id: where.store_id, first_version: first };
      const tagCheck = first ? await checkReleaseTag({ def, version: first, prs, read, ctx }) : { state: 'not_checked', message: null };
      const connector = stores.connector(where.store);
      const key = `store:${where.store}:${where.store_id}:${plat}`;
      const snap = snapshotOf(def.id, plat);
      const channel = def.releaseChannel?.slack || null;

      // A store's (or the Slack channel's) answer as this feature's cell. from: the snapshot it came from, if any.
      const releaseCell = (value, { via, from = null, failure = null }) => {
        const rel = featureRelease(value, first);
        const cell = { ...base, connected: true, state: rel.state, version: rel.version, missing_version: rel.missing_version || null,
          rollout_state: rel.rollout?.state || null, rollout_percentage: rel.rollout?.percentage ?? null, phased_day: rel.rollout?.day ?? null,
          store_word: rel.rollout?.store_word || null, store_state: rel.store_state, latest: rel.latest, link: rel.link, read_at: from ? from.read_at : readAt,
          tag_check: tagCheck, via, release_channel: via === 'slack' ? (from?.release_channel || channel) : null };
        if (from) {
          return Object.assign(cell, { from_snapshot: true, snapshot_read_at: from.read_at, live_state: failure?.state || 'not_connected',
            message: failure?.message || `${base.store_name} isn't read on this machine, so this is the team snapshot.`, unavailable_since: failure?.unavailable_since ?? null });
        }
        const linkKey = via === 'slack' ? `link:slack:${def.id}:${plat}` : `link:${key}`;
        if (rel.link) cache.links[linkKey] = rel.latest?.link || rel.link;
        cell.events = noteStore(cache, `${f.id}:${def.id}:${plat}`, cell, readAt);
        // What the store (or channel) says about the app itself (its latest version), for the committed snapshot.
        // A channel with no announcement of this app (none within lookbackDays) says nothing worth sharing.
        if (!(via === 'slack' && !value.versions?.length)) storeReads.set(`${def.id}-${plat}`, { app: def.id, platform: plat, store: where.store, store_id: where.store_id,
          version: rel.latest?.version || null, state: rel.latest?.state || null, store_state: rel.latest?.store_state || null,
          released_version: rel.live?.version || null, rollout_state: rel.live?.rollout?.state || null, rollout_percentage: rel.live?.rollout?.percentage ?? null,
          link: rel.latest?.link || value.link || null, via, release_channel: cell.release_channel, read_at: readAt });
        return cell;
      };

      // 1. The store itself.
      let failure = null;
      if (connector) {
        const r = await read(key, ctx(where.store, `${def.id} ${PLATFORM_LABEL[plat]} (${base.store_name} ${where.store_id})`), () => connector.readApp(where.store_id, plat));
        if (r.ok && r.value.unknown) {
          logSourceRead({ source: where.store, feature: f.id, target: `${def.id} ${plat} ${where.store_id}`, outcome: 'unknown_app' });
          platforms[plat] = { ...base, connected: true, state: 'unknown_app', tag_check: tagCheck, link: r.value.link, read_at: readAt,
            message: `${base.store_name} has no app with the identifier ${where.store_id} (apps/${def.id}.yaml, platforms.${plat}.store_id).` };
          return;
        }
        if (r.ok) { platforms[plat] = releaseCell(r.value, { via: 'store' }); return; }
        failure = r;
      }
      // 2. The app's Slack release channel, when this machine is the one that reads Slack.
      if (channel && slack) {
        const onChannel = [...appCatalog.values()].filter((a) => a.releaseChannel?.slack === channel);
        const r = await read(`slack:${channel}:${def.id}:${plat}`, ctx('slack', `${def.id} ${PLATFORM_LABEL[plat]} (Slack ${channel})`), () => slack.readApp(def, plat, onChannel));
        // No announcement of this app in the channel's lookback: the team snapshot (if any) knows more.
        if (r.ok && (r.value.versions.length || !snap)) { platforms[plat] = releaseCell(r.value, { via: 'slack' }); return; }
        failure = r.ok ? { state: 'no_announcement', message: `The Slack channel ${channel} has no announcement of this app in the last ${slackCfg.lookbackDays} days, so this is the team snapshot.` } : r;
      }
      // 3. The team snapshot, marked as such with its read time.
      if (snap) { platforms[plat] = releaseCell(snapshotRead(snap), { via: snap.via || 'store', from: snap, failure }); return; }
      if (!failure) {
        platforms[plat] = { ...base, connected: false, state: 'not_connected', tag_check: tagCheck,
          message: `${base.store_name} isn't connected to LifeCycle yet${channel ? ` and nobody's LifeCycle has read the Slack channel ${channel} yet` : ''}, so the ${PLATFORM_LABEL[plat]} release isn't read (not guessed).` };
        return;
      }
      platforms[plat] = { ...base, connected: true, state: failure.state, reason: failure.reason, message: failure.message, tag_check: tagCheck,
        link: cache.links[`link:${key}`] || null, last_successful_read_at: failure.last_successful_read_at, snapshot_read_at: null,
        unavailable_since: failure.unavailable_since, last_known: null };
    }));
    const missing = Object.keys(ref.firstVersion).filter((p) => !def.platforms[p]);
    // iOS first, then Android, whatever order the reads finished in.
    const ordered = Object.fromEntries(['ios', 'android'].filter((p) => platforms[p]).map((p) => [p, platforms[p]]));
    return { id: def.id, name: def.name, repo: def.repo, owner: def.owner, unknown: false, platforms: ordered, missing_platforms: missing };
  }

  // Is the written first version backed by a release tag in the app's repo, and does that tag
  // (and not the one before it) include the feature's merged PRs in that repo?
  async function checkReleaseTag({ def, version, prs, read, ctx }) {
    const r = await read(`tags:${def.repo}`, ctx('github', `release tags of ${def.repo}`), () => gh.readTags({ repo: def.repo }));
    if (!r.ok) return { state: 'unavailable', message: `The release tags of ${def.repo} couldn't be read: ${r.message}` };
    const names = def.releaseTag ? [def.releaseTag.replace('{version}', version)] : [`v${version}`, version];
    const tag = r.value.find((t) => names.includes(t.name));
    if (!tag) return { state: 'no_tag', message: `No release tag ${names[0]} in ${def.repo}, so the written first version ${version} can't be confirmed.` };
    const commits = prs.filter((p) => p.repo === def.repo && p.merge_sha).map((p) => ({ sha: p.merge_sha, number: p.number }));
    if (!commits.length) return { state: 'ok', tag: tag.name, link: tag.link, message: null };
    const inTag = await Promise.all(commits.map((c) => read(`contains:${def.repo}:${c.sha}:${tag.sha}`, ctx('github', `${tag.name} includes ${c.sha.slice(0, 7)}?`), () => gh.contains({ repo: def.repo, commit: c.sha, head: tag.sha }))));
    if (inTag.some((x) => !x.ok)) return { state: 'unavailable', tag: tag.name, link: tag.link, message: inTag.find((x) => !x.ok).message };
    const missing = commits.filter((_, i) => !inTag[i].value);
    if (missing.length) return { state: 'contradicts', tag: tag.name, link: tag.link,
      message: `The release tag ${tag.name} doesn't include ${missing.map((c) => `PR #${c.number}`).join(', ')}, so the feature can't first ship in ${version}.` };
    // The tag before it: if it already has every PR, the feature shipped earlier than written.
    const toVersion = (n) => (def.releaseTag ? n.replace(def.releaseTag.split('{version}')[0], '') : n.replace(/^v/, ''));
    const earlier = r.value.filter((t) => /^\d+(\.\d+)*$/.test(toVersion(t.name)) && compareVersions(toVersion(t.name), version) < 0)
      .sort((a, b) => compareVersions(toVersion(b.name), toVersion(a.name)))[0];
    if (earlier) {
      const prev = await Promise.all(commits.map((c) => read(`contains:${def.repo}:${c.sha}:${earlier.sha}`, ctx('github', `${earlier.name} includes ${c.sha.slice(0, 7)}?`), () => gh.contains({ repo: def.repo, commit: c.sha, head: earlier.sha }))));
      if (prev.every((x) => x.ok && x.value)) return { state: 'contradicts', tag: tag.name, link: earlier.link,
        message: `The release tag ${earlier.name} already includes the feature's PRs, so it first shipped in ${toVersion(earlier.name)}, not ${version} as written.` };
    }
    return { state: 'ok', tag: tag.name, link: tag.link, message: null };
  }

  // The store reads of the latest compute(), one per app and platform, for the committed snapshots.
  let storeReads = new Map();
  const storeReadsOf = () => [...storeReads.values()];
  // The flags read live in every environment at the latest compute(), for the committed flag snapshots.
  let flagReads = new Map();
  const flagReadsOf = () => [...flagReads.values()];

  return { compute, flagSource: flagSourceStatus, storeReads: storeReadsOf, flagReads: flagReadsOf };
}

// A committed store snapshot as a store's answer (newest version first), so a teammate who can't
// read the store (or the Slack channel) works the feature's release out the same way.
export function snapshotRead(snap) {
  const versions = [];
  const live = snap.released_version ? { version: snap.released_version, state: 'released', store_state: null,
    rollout: { state: snap.rollout_state || 'complete', percentage: snap.rollout_percentage ?? null }, link: snap.link || null } : null;
  if (snap.version && snap.version !== snap.released_version) {
    versions.push({ version: snap.version, state: snap.state || 'unknown', store_state: snap.store_state || null, rollout: null, link: snap.link || null });
  }
  if (live) versions.push({ ...live, store_state: snap.version === snap.released_version ? snap.store_state || null : null });
  versions.sort((a, b) => compareVersions(b.version, a.version));
  return { unknown: false, link: snap.link || null, versions };
}

// Store timeline: a rollout halting (or resuming) and a review rejection, worked out by comparing
// each read with the last one this machine saw. Kept in the last-mile cache, at most 50 per feature, app and platform.
export function noteStore(cache, key, cell, readAt) {
  const prev = cache.stores[key];
  const events = prev?.events ? [...prev.events] : [];
  const where = `${cell.platform_label} ${cell.version || ''}`.trim();
  const add = (kind, message) => { if (!events.some((e) => e.kind === kind && e.version === cell.version)) events.push({ kind, at: readAt, version: cell.version, platform: cell.platform, source: cell.store, link: cell.link, message }); };
  if (cell.rollout_state === 'halted' && prev?.rollout_state !== 'halted') {
    add('store_rollout_halted', `${cell.store_name}: the ${where} rollout was ${cell.store_word || 'halted'} at ${cell.rollout_percentage ?? '?'}% of users.`);
  }
  if (prev?.rollout_state === 'halted' && cell.state === 'released' && cell.rollout_state !== 'halted') {
    events.push({ kind: 'store_rollout_resumed', at: readAt, version: cell.version, platform: cell.platform, source: cell.store, link: cell.link,
      message: `${cell.store_name}: the ${where} rollout resumed (${cell.rollout_percentage ?? '?'}% of users).` });
  }
  if (cell.state === 'rejected' && prev?.state !== 'rejected') {
    add('store_rejected', `${cell.store_name}: ${where} was rejected in review (${cell.store_state}).`);
  }
  cache.stores[key] = { state: cell.state, rollout_state: cell.rollout_state, version: cell.version, at: readAt, events: events.slice(-50) };
  return cache.stores[key].events;
}

// Experiment timeline (start, end, a group's share changing), worked out by comparing each read with
// the last one this machine saw (Statsig keeps no change history we can read), plus the start and end
// times Statsig records. Kept in the last-mile cache, newest last, at most 50 per experiment.
export function noteExperiment(cache, id, cell, readAt) {
  const prev = cache.experiments[id];
  const events = prev?.events ? [...prev.events] : [];
  // One start and one end per time; share changes are kept each time they differ.
  const add = (e) => { if (!events.some((x) => x.kind === e.kind && x.at === e.at && (e.kind !== 'experiment_share_changed' || x.message === e.message))) events.push(e); };
  const shares = Object.fromEntries(cell.groups.map((g) => [g.name, g.share]));
  const running = cell.state === 'running';
  const wasRunning = prev ? prev.state === 'running' : false;
  const name = cell.name;
  const by = cell.changed_by ? ` by ${cell.changed_by}` : '';
  if ((running || cell.state === 'ended') && cell.started_at) {
    add({ kind: 'experiment_started', at: cell.started_at, message: `Experiment ${name} started: ${cell.groups.map((g) => `${g.name} ${g.share ?? '?'}%`).join(', ')}.` });
  } else if (running && !wasRunning) {
    add({ kind: 'experiment_started', at: readAt, message: `Experiment ${name} is running (first seen ${readAt.slice(0, 16).replace('T', ' ')} UTC).` });
  }
  const allocation = cell.assignment?.allocation ?? null;
  if (prev && running && prev.allocation !== undefined && prev.allocation !== null && allocation !== null && prev.allocation !== allocation) {
    add({ kind: 'experiment_share_changed', at: cell.changed_at || readAt,
      message: `Experiment ${name}: ${prev.allocation}% → ${allocation}% of eligible users in it, so ${cell.groups.map((g) => `${g.name} ${g.share_of_users ?? '?'}%`).join(', ')} of users${by}.` });
  }
  if (prev && running && prev.shares) {
    const changed = cell.groups.filter((g) => prev.shares[g.name] !== undefined && prev.shares[g.name] !== g.share);
    if (changed.length) {
      add({ kind: 'experiment_share_changed', at: cell.changed_at || readAt,
        message: `Experiment ${name}: ${changed.map((g) => `${g.name} ${prev.shares[g.name]}% → ${g.share}%`).join(', ')}${by}.` });
    }
  }
  if (cell.state === 'ended' && (wasRunning || cell.ended_at)) {
    add({ kind: 'experiment_ended', at: cell.ended_at || readAt,
      message: `Experiment ${name} ended${cell.launched_group ? `: ${cell.launched_group} was shipped` : ' with no group shipped'}${by}.` });
  } else if (prev && wasRunning && !running && cell.state !== 'ended') {
    add({ kind: 'experiment_ended', at: cell.changed_at || readAt, message: `Experiment ${name} is no longer running in production (${cell.state.replace(/_/g, ' ')}).` });
  }
  events.sort((a, b) => a.at.localeCompare(b.at));
  cache.experiments[id] = { state: cell.state, shares, allocation, at: readAt, events: events.slice(-50) };
  return cache.experiments[id].events;
}
const experimentEvents = (cache, id) => cache.experiments[id]?.events || [];

function developmentState(prs) {
  if (!prs.length) return { state: 'not_done', message: 'No pull requests are linked in the feature definition, so development can\'t be confirmed done.', prs };
  const failed = prs.filter((p) => p.state !== 'ok');
  if (failed.some((p) => p.state === 'no_access')) return { state: 'no_access', message: failed.map((p) => p.message).join(' '), prs };
  if (failed.length) return { state: 'unavailable', message: failed.map((p) => p.message).join(' '), prs };
  const pending = prs.filter((p) => p.actions !== 'success');
  if (pending.length) return { state: 'not_done', message: pending.map((p) => `PR #${p.number} in ${p.repo}: ${p.detail}.`).join(' '), prs };
  return { state: 'done', message: `All ${prs.length} linked PR${prs.length === 1 ? ' is' : 's are'} merged with GitHub Actions passing.`, prs };
}

// Builds the last_mile block of the shared status format (docs/status-format.md).
function assemble(f, verdict, development, services, flags, experiments, apps, readAt, platform) {
  const evidence = [];
  for (const p of development.prs) {
    evidence.push({ kind: 'pull_request', label: `PR #${p.number} in ${p.repo}`, link: p.link });
    if (p.actions_link) evidence.push({ kind: 'github_actions', label: `GitHub Actions for PR #${p.number}: ${p.actions}`, link: p.actions_link });
  }
  for (const s of services) for (const env of ENVIRONMENTS) {
    const c = s.environments[env];
    if (c.link) evidence.push({ kind: 'deploy_record', label: `${s.id} in ${ENV_LABEL[env]}${c.version ? `: ${c.version}` : ''}`, link: c.link });
  }
  for (const fl of flags) for (const env of ENVIRONMENTS) {
    const c = fl.environments[env];
    if (c.link) evidence.push({ kind: 'flag_setting', label: `${fl.key} in ${ENV_LABEL[env]}: ${c.state === 'partial' ? `${c.rollout_percentage ?? '?'}%` : c.state}`, link: c.link });
  }

  for (const x of experiments) {
    const c = x.environments.production;
    if (c.link) evidence.push({ kind: 'experiment', label: `experiment ${x.id}: ${c.state === 'running' ? c.groups.map((g) => `${g.name} ${g.share ?? '?'}%`).join(', ') : (c.state || '').replace(/_/g, ' ')}`, link: c.link });
  }

  for (const a of apps) for (const c of Object.values(a.platforms)) {
    if (c.link && c.connected) evidence.push({ kind: 'store_release', label: `${a.name} ${c.platform_label} in ${c.store_name}: ${storeLabel(c)}${c.via === 'slack' ? ` (from Slack ${c.release_channel})` : ''}${c.from_snapshot ? ' (team snapshot)' : ''}`, link: c.link });
    if (c.tag_check?.link && !evidence.some((e) => e.link === c.tag_check.link)) evidence.push({ kind: 'release_tag', label: `release tag ${c.tag_check.tag} in ${a.repo}`, link: c.tag_check.link });
  }

  const cells = [...apps.flatMap((a) => Object.values(a.platforms)), ...services.flatMap((s) => ENVIRONMENTS.map((e) => s.environments[e])), ...flags.flatMap((x) => ENVIRONMENTS.map((e) => x.environments[e])),
    ...experiments.flatMap((x) => ENVIRONMENTS.map((e) => x.environments[e])), ...development.prs];
  const failedTimes = cells.filter((c) => c.state === 'unavailable' || c.state === 'no_access').map((c) => c.last_successful_read_at ?? null);
  const accessProblems = [];
  const addAccess = (source, message) => { if (!accessProblems.some((a) => a.message === message)) accessProblems.push({ source, message }); };
  for (const p of development.prs) if (p.state === 'no_access') addAccess('github', p.message);
  for (const s of services) for (const env of ENVIRONMENTS) if (s.environments[env].state === 'no_access') addAccess('github', s.environments[env].message);
  for (const fl of flags) for (const env of ENVIRONMENTS) if (fl.environments[env].state === 'no_access') addAccess(platform, fl.environments[env].message);
  for (const x of experiments) for (const env of ENVIRONMENTS) if (x.environments[env].state === 'no_access') addAccess('statsig', x.environments[env].message);
  for (const a of apps) for (const c of Object.values(a.platforms)) if (c.state === 'no_access') addAccess(c.store, c.message);

  return {
    ...verdict,
    // Where the flags below were read: 'flagsmith' or 'statsig' (the person's choice). Same shape either way.
    flag_platform: platform,
    development: {
      state: development.state,
      message: development.message,
      pull_requests: development.prs.map((p) => ({ repo: p.repo, number: p.number, title: p.title || null, link: p.link, merged: p.merged ?? null,
        merge_sha: p.merge_sha || null, actions: p.actions || null, actions_link: p.actions_link || null, detail: p.detail || p.message || null,
        state: p.state, last_successful_read_at: p.state === 'ok' ? readAt : p.last_successful_read_at ?? null, unavailable_since: p.unavailable_since ?? null })),
    },
    services: services.map((s) => ({
      id: s.id, repo: s.repo, unknown: Boolean(s.unknown),
      environments: Object.fromEntries(ENVIRONMENTS.map((env) => {
        const c = s.environments[env];
        return [env, { state: c.state, github_environment: c.github_environment || null, deployed: c.state === 'ok' ? c.deployed : null,
          version: c.version ?? null, ref: c.ref ?? null, sha: c.sha ?? null, deployed_at: c.deployed_at ?? null, deployed_by: c.deployed_by ?? null,
          contains_feature: c.contains_feature ?? null, link: c.link || null, link_kind: c.link ? c.link_kind || 'deploy_record' : null, message: c.message || null,
          last_successful_read_at: c.state === 'ok' ? readAt : c.last_successful_read_at ?? null, unavailable_since: c.state === 'ok' ? null : c.unavailable_since ?? null }];
      })),
    })),
    flags: flags.map((fl) => ({
      key: fl.key, unknown: fl.unknown, ...(fl.from_snapshot ? { from_snapshot: true, snapshot_read_at: fl.snapshot_read_at } : {}),
      environments: Object.fromEntries(ENVIRONMENTS.map((env) => {
        const c = fl.environments[env];
        const ok = ['on', 'off', 'partial'].includes(c.state);
        // From a snapshot: the state is the snapshot's, read when the snapshot was; the message says why it isn't live.
        const snap = Boolean(c.from_snapshot);
        return [env, { state: c.state, rollout_percentage: ok ? c.rollout_percentage ?? null : null, segments: c.segments || [],
          changed_at: c.changed_at ?? null, changed_by: c.changed_by ?? null, was_on_before: c.was_on_before ?? null,
          link: c.link || null, message: c.message || null,
          last_successful_read_at: snap ? c.snapshot_read_at : ok ? readAt : c.last_successful_read_at ?? null,
          unavailable_since: snap || !ok ? c.unavailable_since ?? null : null,
          from_snapshot: snap, snapshot_read_at: snap ? c.snapshot_read_at : null, live_state: snap ? c.live_state : null }];
      })),
    })),
    // Experiments the feature takes part in, always read from Statsig. state per environment:
    // running | not_running | not_started | ended | unknown | unavailable | no_access.
    experiments: experiments.map((x) => ({
      id: x.id, unknown: x.unknown, platform: 'statsig',
      name: x.environments.production.name || x.id,
      environments: Object.fromEntries(ENVIRONMENTS.map((env) => {
        const c = x.environments[env];
        const ok = !['unavailable', 'no_access', 'unknown'].includes(c.state);
        return [env, { state: c.state, statsig_status: c.statsig_status ?? null, groups: c.groups || [], assignment: c.assignment || null,
          started_at: c.started_at ?? null, ended_at: c.ended_at ?? null, launched_group: c.launched_group ?? null, reason: c.reason || null,
          changed_at: c.changed_at ?? null, changed_by: c.changed_by ?? null, link: c.link || null, message: c.message || null,
          last_successful_read_at: ok || c.state === 'unknown' ? readAt : c.last_successful_read_at ?? null, unavailable_since: ok || c.state === 'unknown' ? null : c.unavailable_since ?? null }];
      })),
      // Timeline: started, ended, a group's share changed (oldest first).
      events: x.events || [],
    })),
    // Mobile apps the feature ships in, per platform (src/stores). state per platform:
    // not_in_version | preparing | in_review | approved_waiting | rejected | released | removed |
    // not_connected | unknown_app | unavailable | no_access. Released cells carry rollout_state
    // (gradual | complete | halted) and rollout_percentage.
    apps: apps.map((a) => ({
      id: a.id, name: a.name, repo: a.repo, owner: a.owner, unknown: a.unknown,
      platforms: Object.fromEntries(Object.entries(a.platforms).map(([p, c]) => [p, {
        platform: p, platform_label: c.platform_label, store: c.store, store_name: c.store_name, store_id: c.store_id, connected: c.connected,
        state: c.state, label: storeLabel(c), first_version: c.first_version, version: c.version ?? null, missing_version: c.missing_version ?? null,
        rollout_state: c.rollout_state ?? null, rollout_percentage: c.rollout_percentage ?? null, phased_day: c.phased_day ?? null, store_word: c.store_word ?? null,
        store_state: c.store_state ?? null, latest: c.latest ?? null, tag_check: c.tag_check || null, link: c.link || null, message: c.message || null,
        last_successful_read_at: c.read_at ?? c.last_successful_read_at ?? null, snapshot_read_at: c.snapshot_read_at ?? null,
        unavailable_since: c.unavailable_since ?? null, last_known: c.last_known ?? null, events: c.events || [],
        // Where the state was read: the store, or the app's Slack release channel (via: store | slack).
        // from_snapshot: not read here, the team snapshot (live_state: why not).
        via: c.via ?? null, release_channel: c.release_channel ?? null,
        from_snapshot: Boolean(c.from_snapshot), live_state: c.from_snapshot ? c.live_state : null,
      }])),
    })),
    access_problems: accessProblems,
    evidence,
    read_at: readAt,
    // When the state is unavailable: the oldest successful read behind it (null if never read).
    last_successful_read_at: failedTimes.length ? (failedTimes.includes(null) ? null : failedTimes.sort()[0]) : readAt,
  };
}
