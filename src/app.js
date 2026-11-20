// One refresh = read the definitions, then compute statuses from every step's evidence.
// Two kinds (nothing runs on a timer; a person asks for each):
// - refresh() ("Refresh View") reads only the shared repo and reuses what the sources said at the last live read
//   (saved in the cache folder), so it never calls GitHub PRs, deploys, flags, stores or Claude.
// - refresh({ live: true }) ("Refresh Data") reads every source live and saves what they said.
// The very first refresh on a machine (nothing saved yet) reads live.
import fs from 'node:fs';
import path from 'node:path';
import { paths, writeJson, loadConfig, githubToken, liveGithubToken, githubAccess, flagsmithKey, statsigKey, storeCredentials as readStoreCredentials, appUrl, migrateSavedFlagPlatform, readNotices } from './config.js';
import { resolveFlagPlatform, chosenFlagPlatform, teamFlagPlatform, FLAG_PLATFORM_NAME } from './team.js';
import { createGithubClient } from './sources/github-client.js';
import { createEvidenceReader } from './sources/index.js';
import { fetchDefinitionFiles, parseDefinitions } from './definitions.js';
import { computeStatuses } from './status.js';
import { projectStatuses } from './projects.js';
import { createLastMile } from './lastmile/index.js';
import { commitSnapshots } from './stores/snapshots.js';
import { commitFlagSnapshots } from './lastmile/flag-snapshots.js';
import { readAlerts, changeLink, definitionLink } from './changes.js';
import { buildSources, featureLink } from './trace.js';
import { rampVerdict } from './ramp/verdict.js';
import { createPublisher, listOutbox } from './alerts/publish.js';
import { buildAlertList, markSeen } from './alerts/inbox.js';
import { createFeaturePublisher, listFeatureOutbox } from './features/publish.js';
import { buildTeamRegistry, teamsSummary } from './teams/registry.js';
import { teamDependencies } from './teams/dependencies.js';
import { createTeamPublisher } from './teams/publish.js';
import { commitJiraSnapshots } from './sources/jira-snapshots.js';

// What the last live read said beyond the evidence (src/sources keeps that): the last mile per
// feature and the flag source's health, and when that read was.
const sourcesFile = () => path.join(paths.cacheDir(), 'sources-read.json');
function loadSourcesRead() {
  try {
    const c = JSON.parse(fs.readFileSync(sourcesFile(), 'utf8'));
    return c && typeof c.read_at === 'string' ? c : null;
  } catch { return null; }
}

// The feature-edit access message, in team words.
export const teamReadOnly = (reason) => String(reason || 'You have read-only access to the shared repo.').replace(/feature data/g, 'teams').replace(/edit features/g, 'manage teams');

// One-time notices not yet dismissed, in plain words (shown on Home until "Got it").
export function pendingNotices() {
  const out = [];
  const sw = readNotices().flagPlatformSwitched;
  if (sw && !sw.seen) {
    const to = FLAG_PLATFORM_NAME[sw.to] || sw.to;
    const from = FLAG_PLATFORM_NAME[sw.from] || sw.from;
    out.push({ id: 'flagPlatformSwitched', at: sw.at, title: `Feature flags are now read from ${to}`,
      message: `${to} is your team's flag platform (set once in the shared repo, team.yaml). Your setup had never picked one, so LifeCycle was reading ${from}. Nothing else changes. To keep ${from} instead, run \`npm run setup -- --extras\` and choose ${sw.from}.` });
  }
  return out;
}

// What the page must say about the version of LifeCycle-Data it shows, so it never looks like the
// latest when it isn't: { level: 'warning' | 'info', title, reason } or null for "latest from GitHub".
// The page adds the commit (linked) and the read time from the definitions block.
export function definitionsNotice(d) {
  const branch = d.branch || 'main';
  if (d.kind === 'github') {
    if (!d.stale) return null;
    return d.commit || d.read_at
      ? { level: 'warning', title: `Showing a saved copy of LifeCycle-Data, not the latest ${branch}`, reason: `The latest couldn't be read: ${d.error?.message || 'unknown error'}` }
      : { level: 'warning', title: 'LifeCycle-Data could not be read, and there is no saved copy on this Mac', reason: d.error?.message || 'unknown error' };
  }
  if (d.kind === 'local_clone') {
    if (d.stale) return { level: 'warning', title: `Showing the local clone's current commit, which may not be the latest ${branch}`, reason: `Definitions come from the local clone ${d.path}, not GitHub. ${d.error?.message || 'git pull failed'}` };
    return { level: 'info', title: 'Definitions come from a local clone, not GitHub', reason: `${d.path}, pulled from ${branch} on this refresh` };
  }
  if (d.kind === 'local_folder') {
    return { level: 'info', title: 'Definitions come from a local folder, not GitHub', reason: `${d.path} is not a git clone, so there is no commit: the files are shown as they are on disk` };
  }
  return null;
}

// storeCredentials: per-store credentials (src/config.js storeCredentials()). storeConnectors: extra
// store connectors by store id (src/stores/index.js), used to plug in a store not built in yet.
// slackRun / jiraRun: replace the Claude Code calls that read Slack release channels and Jira (tests).
export function createApp({ config = loadConfig(), token, flagsmithApiKey = flagsmithKey(), statsigApiKey = statsigKey(), storeCredentials = readStoreCredentials(), storeConnectors = {}, fetchImpl, slackRun, jiraRun, alwaysLive = false } = {}) {
  let inFlight = null;
  let queued = null;
  let lastSnap = null;
  let published = null; // the latest commit LifeCycle itself made in the shared repo (feature, team, change edit)
  let lastDefs = null; // { featureDefs, projects, services, changes, invalidIds, files } from the latest refresh, for publishing
  // The token is read again while the app runs (src/config.js liveGithubToken); tests pass a fixed one.
  const githubTokenNow = token !== undefined ? () => token : liveGithubToken();
  const client = createGithubClient({
    apiUrl: config.sources.github.apiUrl,
    enabled: config.sources.github.enabled,
    token: githubTokenNow,
    access: token !== undefined ? null : githubAccess,
    fetchImpl,
  });
  // Every commit LifeCycle makes to the shared repo goes through here, so the next definitions read
  // can insist on including it even if GitHub still answers with the previous head for a moment.
  const dataContents = `/repos/${config.dataRepo}/contents/`;
  const github = {
    ...client,
    async request(route, opts = {}) {
      const res = await client.request(route, opts);
      if (opts.method && opts.method !== 'GET' && route.startsWith(dataContents) && res?.commit?.sha) published = res.commit.sha;
      return res;
    },
  };
  const publisher = createPublisher({ config, github });
  // Feature edits made in LifeCycle (src/features): committed with the same identity as changes.
  const featurePublisher = createFeaturePublisher({ config, github, whoAmI: publisher.whoAmI });
  // Team edits (src/teams): the same files, identity and access check as feature edits.
  const teamPublisher = createTeamPublisher({ featurePublisher, whoAmI: publisher.whoAmI });

  async function readDefinitions() {
    const defs = await fetchDefinitionFiles(config, github, { atLeast: published });
    return { defs, parsed: parseDefinitions(defs.files) };
  }

  async function refreshOnce({ live = false } = {}) {
    const saved = live ? null : loadSourcesRead();
    if (!saved) live = true; // nothing read on this machine yet: read the sources once
    let { defs, parsed } = await readDefinitions();
    // Changes waiting to be published (the repo was unreachable): try them first, so a teammate's
    // copy and this one see them as soon as the repo is back.
    if (!defs.stale && listOutbox().some((e) => e.state === 'pending')) {
      const results = await publisher.flush({ featureDefs: parsed.features, changes: parsed.changes });
      const published = results.filter((r) => r.outcome === 'published');
      if (published.length) {
        markSeen(published.map((r) => `change:${r.change.id}@r${r.change.revision}`), { alerts: [] }, { own: true });
        ({ defs, parsed } = await readDefinitions());
      }
    }
    // Feature edits waiting for the shared repo, the same way.
    if (!defs.stale && listFeatureOutbox().some((e) => e.state === 'pending')) {
      const results = await featurePublisher.flush({ featureDefs: parsed.features, invalidIds: parsed.invalidIds });
      if (results.some((r) => r.outcome === 'published')) ({ defs, parsed } = await readDefinitions());
    }
    const { features, projects, services, teams, apps, storeSnapshots, flagSnapshots, jiraSnapshots, changes, invalid, invalidIds } = parsed;
    lastDefs = { featureDefs: features, teamDefs: teams, serviceDefs: services, projectDefs: projects, appDefs: apps, changes, invalidIds,
      files: new Map(defs.files.map((f) => [f.path, f.text])) };
    // Teams defined in LifeCycle-Data and what they own (src/teams): the official list of teams.
    const teamRegistry = buildTeamRegistry({ teams, features, services, projects, apps, config });
    const allDefs = new Map(features.map((f) => [f.id, f]));
    const teamDepsOf = (f) => teamDependencies(teamRegistry, f, { featuresById: allDefs, config });
    // Which version of LifeCycle-Data this snapshot shows: one commit, where it came from and when it
    // was read, and (when it isn't the latest) why. Every view of this snapshot reports the same one.
    const definitions = {
      source: config.dataPath ? `local:${config.dataPath}` : `github:${config.dataRepo}@${config.dataBranch}`,
      kind: defs.kind,
      repo: defs.repo,
      branch: defs.branch,
      path: defs.path,
      commit: defs.commit?.sha || null,
      commit_short: defs.commit?.short || null,
      commit_url: defs.commit?.url || null,
      read_at: defs.readAt,
      synced_at: defs.readAt,
      stale: defs.stale,
      fallback: defs.fallback,
      error: defs.error || null,
    };
    definitions.notice = definitionsNotice(definitions);
    // Which flag platform to read: the person's own choice, else the team default from team.yaml.
    // A config that silently defaulted to Flagsmith moves to the team default once, with a notice.
    // Only once the shared repo has been read at least once, so an offline first start never guesses.
    if (defs.readAt && !chosenFlagPlatform(config)) {
      migrateSavedFlagPlatform(teamFlagPlatform(parsed.team));
      config.flagPlatformSource = 'team';
    }
    const flagPlatform = resolveFlagPlatform(config, parsed.team);
    const reader = createEvidenceReader({ config, tokens: { github: githubTokenNow }, fetchImpl, jiraSnapshots, jiraRun, live });
    await reader.prefetch(features);
    const statuses = await computeStatuses({ features, projects, invalidIds, read: reader.read, definitions });
    reader.save();
    // The teams each feature depends on (with reasons) and its "unknown team" warnings.
    for (const s of statuses) {
      const def = allDefs.get(s.feature.id);
      s.team_dependencies = def ? teamDepsOf(def) : null;
      s.team_warnings = teamRegistry.warningsFor(s.feature.id);
    }
    // Last mile: is the work deployed and turned on? Read live with the same credentials on a live
    // refresh; otherwise what the last live read saved (a feature added since has none yet).
    const lastMileRun = createLastMile({ config: { ...config, flagPlatform: flagPlatform.platform }, githubClient: github, flagsmithKey: flagsmithApiKey, statsigKey: statsigApiKey, storeCredentials, storeConnectors, fetchImpl, slackRun });
    let lastMile, flagSource, sourcesReadAt;
    if (live) {
      lastMile = await lastMileRun.compute(features, services, apps, storeSnapshots, flagSnapshots);
      flagSource = lastMileRun.flagSource();
      sourcesReadAt = new Date().toISOString();
      try { writeJson(sourcesFile(), { read_at: sourcesReadAt, flag_source: flagSource, last_mile: Object.fromEntries(lastMile) }); } catch (err) { console.error(`lifecycle: could not save the source reads: ${err.message}`); }
    } else {
      lastMile = new Map(Object.entries(saved.last_mile || {}));
      flagSource = saved.flag_source || null;
      sourcesReadAt = saved.read_at;
    }
    for (const s of statuses) s.last_mile = lastMile.get(s.feature.id) || null;
    // Commit what the stores said to LifeCycle-Data (store-snapshots/), when it changed or is old.
    // Never blocks the refresh: a failed write is logged and shown as a count.
    // Snapshots are written only through GitHub, by someone who can write to the shared repo. A local
    // data folder is never written to: a plain folder is a copy nobody else reads, and commits in a
    // local clone would never be pushed (and would stop the clone from pulling).
    let writeAccess = null;
    const canWrite = async () => { writeAccess ??= !config.dataPath && Boolean((await featurePublisher.access()).can_edit); return writeAccess; };
    // Team snapshots come only from live reads, so a refresh that reads nothing writes nothing.
    const snapshotResults = defs.stale || !live ? [] : await commitSnapshots({ config, github, reads: lastMileRun.storeReads(), existing: storeSnapshots, canWrite });
    // Commit what the flag platform said to LifeCycle-Data (flag-snapshots/), so teammates without a
    // key see it, and the Jira tickets read here (jira-snapshots/) the same way. Only from live reads.
    const jiraSnapshotResults = defs.stale || !live ? [] : await commitJiraSnapshots({ config, github, reads: reader.jiraReads(), existing: jiraSnapshots, canWrite });
    const flagSnapshotResults = defs.stale || !live ? [] : await commitFlagSnapshots({ config, github, reads: lastMileRun.flagReads(), existing: flagSnapshots, canWrite });
    // Registered changes (shared repo, with the definitions) and the alert list (alerts work).
    const alerts = await readAlerts(config, { fetchImpl, live });
    const link = (c) => changeLink(config, c);
    const alertList = buildAlertList({ features, statuses, changes, changeLink: link, config });
    for (const s of statuses) s.delay = alertList.delay[s.feature.id];
    // Where each status was read from, and a link to this feature's view to share (src/trace.js).
    const base = appUrl(config.port);
    const defLink = (file) => { const l = definitionLink(config, file); return l && l.startsWith('/') ? `${base}${l}` : l; };
    for (const s of statuses) {
      s.share_link = featureLink(base, s.feature.id);
      s.sources = buildSources(s, { definitionLink: defLink, baseUrl: base });
    }
    // Ready to ramp? One verdict per feature from everything above (src/ramp/verdict.js).
    const changesWithLinks = changes.map((c) => ({ ...c, evidence_link: changeLink(config, c) }));
    // Ask & digest read alerts in lifecycle.alerts/v1: the configured alert list.
    const allAlerts = alerts.alerts;
    const statusById = new Map(statuses.map((s) => [s.feature.id, s]));
    for (const s of statuses) {
      s.ramp = rampVerdict({ status: s, statusById, services, changes: changesWithLinks, alerts: allAlerts,
        alertsSource: alerts.meta, definitionLink: (file) => definitionLink(config, file) });
    }
    return {
      definitions,
      invalid_definitions: invalid,
      // Where flags are read from and why (src/team.js), plus the flag source's health for Home.
      flag_platform: { ...flagPlatform, name: FLAG_PLATFORM_NAME[flagPlatform.platform] },
      flag_source: flagSource,
      // When the sources (PRs, deploys, flags, stores, Slack, Jira) were last read live, and whether this refresh did.
      sources_read: { read_at: sourcesReadAt, live },
      store_snapshots: { committed: snapshotResults.filter((r) => r.outcome === 'committed').map((r) => r.file), failed: snapshotResults.filter((r) => r.outcome === 'failed') },
      jira_snapshots: { committed: jiraSnapshotResults.filter((r) => r.outcome === 'committed').map((r) => r.file), failed: jiraSnapshotResults.filter((r) => r.outcome === 'failed') },
      flag_snapshots: { committed: flagSnapshotResults.filter((r) => r.outcome === 'committed').map((r) => r.file), failed: flagSnapshotResults.filter((r) => r.outcome === 'failed') },
      notices: pendingNotices(),
      projects: projectStatuses(projects, statuses),
      features: statuses,
      services: services.map((s) => ({ id: s.id, name: s.name, owner: s.owner, repo: s.repo })),
      // Mobile apps (apps/*.yaml): never their store credentials, only where they're published.
      apps: apps.map((a) => ({ id: a.id, name: a.name, owner: a.owner, repo: a.repo, platforms: a.platforms, release_tag: a.releaseTag,
        release_channel: a.releaseChannel, file: a.file, features: features.filter((f) => (f.apps || []).some((x) => x.id === a.id)).map((f) => f.id) })),
      changes: changesWithLinks,
      alerts: allAlerts,
      alerts_source: alerts.meta,
      alert_list: alertList,
      outbox: listOutbox(),
      // Feature edits kept on this machine (not published yet, or refused because of a conflict).
      feature_outbox: listFeatureOutbox(),
      // Teams defined in LifeCycle-Data (teams/): what each owns, ownership conflicts, things used
      // by features that no team owns, unknown team names and suggested teams (docs/teams-format.md).
      team_definitions: teamsSummary(teamRegistry),
    };
  }

  // Every refresh reads LifeCycle-Data again. A refresh asked for while another is running never gets
  // that one (it may have read before a push the person is waiting for): it waits for a new read that
  // starts once the running one ends. Everyone asking during the same run shares that next read.
  // The queued read is live when anyone waiting for it asked for live data.
  let queuedLive = false;
  function start(live) {
    inFlight = refreshOnce({ live }).then((snap) => { lastSnap = snap; return snap; }).finally(() => { inFlight = null; });
    return inFlight;
  }
  // alwaysLive: every refresh reads the sources (one-shot tools like `lifecycle status`, and tests).
  function refresh({ live = alwaysLive } = {}) {
    if (!inFlight) return start(live);
    queuedLive ||= live;
    if (!queued) {
      queued = inFlight.catch(() => {}).then(() => { const l = queuedLive; queuedLive = false; queued = null; return start(l); });
    }
    return queued;
  }

  // The definitions publishing works against: the latest refresh's, else a fresh read.
  async function definitionsNow() {
    if (!lastDefs) await refresh();
    return lastDefs;
  }

  // The latest refresh's snapshot (or a new refresh if there is none yet).
  const latest = async () => lastSnap || refresh();

  // One path for team edits, from the Teams page and from the chat's confirmed actions. Anyone with
  // write access to LifeCycle-Data may manage teams; read-only users are told why not.
  async function submitTeamEdit({ op, id, draft, base_hash, handover_to, leave_unowned, confirm_unowned }) {
    const access = await featurePublisher.access();
    if (!access.can_edit) return { outcome: 'read_only', message: teamReadOnly(access.reason) };
    await refresh(); // publish against the definitions as they are now
    const r = await teamPublisher.submit({ op, id, draft, base_hash: typeof base_hash === 'string' ? base_hash : null, handover_to: handover_to || null,
      leave_unowned: leave_unowned === true, confirm_unowned: confirm_unowned === true }, await definitionsNow());
    if (r.outcome === 'published') await refresh();
    return r;
  }

  // Read-only GitHub access for Import from links (src/import): every call is a GET, whatever is asked.
  const githubRead = (route, opts = {}) => client.request(route, { accept: opts.accept, what: opts.what, method: 'GET' });

  return { refresh, latest, config, publisher, featurePublisher, teamPublisher, submitTeamEdit, definitionsNow, githubRead, jiraRun };
}
