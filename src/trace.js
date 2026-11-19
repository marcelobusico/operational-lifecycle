// Where every status a feature shows was read from (docs/status-format.md, "Sources"). One entry
// per status kind and item: developed (each step's PRs/issues, and the GitHub Actions run per PR),
// deployed (deploy record or pipeline run per service and environment), flag (the flag in the flag
// console per environment), experiment (the experiment in Statsig per environment), store (the app
// version in the store console per app and platform, with its release tag), blocked (the
// blocking PR, issue or feature) and delay warning (the open steps it is based on).
//
// Each entry has either specific links (never a repo or tool home page or a list page) or a
// `no_source_item` note saying why there is nothing to link to, plus when it was last read. When
// the source can't be read it says since when, and keeps the last known link. The browser view and
// the AI-tool answers both show these entries, so a status can be checked and shared the same way.
// Pure logic: built from a finished feature status.
import { evidenceLabel } from './evidence.js';
const UNKNOWN = new Set(['unavailable', 'no_access']);
const ENV = { qa: 'QA', production: 'Production' };
const evLabel = evidenceLabel;
const oldest = (times) => (times.includes(null) || !times.length ? null : [...times].sort()[0]);
const earliest = (times) => [...times].filter(Boolean).sort()[0] || null;

export const featureLink = (baseUrl, id) => `${baseUrl}/#/feature/${encodeURIComponent(id)}`;

function entry({ kind, key, label, state, links = [], note = null, readAt = null, unavailable = false, since = null, message = null, source, fromSnapshot = false }) {
  const list = links.filter((l) => l && l.url);
  return {
    kind, key, label, state, source,
    links: list,
    // Said instead of linking somewhere generic when no specific item exists.
    no_source_item: list.length ? null : note || 'No specific source item.',
    read_at: readAt,
    unavailable,
    unavailable_since: unavailable ? since : null,
    message,
    // Not read live: the team snapshot in the shared repo (read_at is when the snapshot was read).
    ...(fromSnapshot ? { from_snapshot: true } : {}),
  };
}

// status: a lifecycle.feature-status/v1 with last_mile and delay attached.
// definitionLink(file) -> link to a definition file; baseUrl: this LifeCycle's URL.
export function buildSources(status, { definitionLink = () => null, baseUrl }) {
  const out = [];
  const synced = status.definitions?.synced_at || status.read_at;
  const def = { label: `definition ${status.feature.file}`, url: definitionLink(status.feature.file) };

  // Developed: each step, from its PRs and issues.
  for (const s of status.steps) {
    const bad = UNKNOWN.has(s.state);
    out.push(entry({
      kind: 'developed', key: `step:${s.id}`, label: `Step "${s.name}"`, state: s.state,
      source: s.evidence.length && s.evidence.every((e) => e.source === 'jira') ? 'jira' : 'github', fromSnapshot: Boolean(s.from_snapshot),
      links: s.evidence.map((e) => ({ label: evLabel(e), url: e.link })),
      note: s.linked_work ? null : 'No linked PR or issue yet in the definition.',
      readAt: s.linked_work ? (bad ? s.last_successful_read_at : s.last_successful_read_at || status.read_at) : synced,
      unavailable: bad, since: s.unavailable_since ?? null, message: s.message,
    }));
  }

  const lm = status.last_mile;
  if (lm && lm.state !== 'not_tracked') {
    // Developed, last mile: the GitHub Actions run on each merged PR.
    for (const p of lm.development.pull_requests) {
      const bad = UNKNOWN.has(p.state);
      const runLabel = p.actions === 'not_merged' || p.actions === 'none' ? `PR #${p.number} in ${p.repo}` : `GitHub Actions for PR #${p.number}`;
      out.push(entry({
        kind: 'developed', key: `actions:${p.repo}#${p.number}`, label: `GitHub Actions for PR #${p.number} in ${p.repo}`,
        state: bad ? p.state : p.actions || p.state, source: 'github-actions',
        links: [{ label: runLabel, url: p.actions_link || (bad ? p.link : null) }],
        note: 'No GitHub Actions run is known for this PR.',
        readAt: p.last_successful_read_at, unavailable: bad, since: p.unavailable_since ?? null, message: bad ? p.detail : null,
      }));
    }
    // Deployed: per service and environment.
    for (const svc of lm.services) {
      for (const env of Object.keys(ENV)) {
        const c = svc.environments[env];
        const bad = UNKNOWN.has(c.state) || (svc.unknown && c.state === 'unavailable');
        const label = `${svc.id} in ${ENV[env]}`;
        const link = c.link ? { label: c.link_kind === 'pipeline_run' ? `pipeline run: ${label}` : `deploy record: ${label}${c.version ? ` (${c.version})` : ''}`, url: c.link } : null;
        out.push(entry({
          kind: 'deployed', key: `deploy:${svc.id}:${env}`, label,
          state: bad ? c.state : c.deployed ? (c.contains_feature === false ? 'deployed_without_feature' : 'deployed') : 'not_deployed',
          source: 'github-deployments', links: [link],
          note: svc.unknown ? `No services/${svc.id}.yaml is defined, so there is no deploy record to read.`
            : bad ? 'No deploy record has been read yet.'
              : `No successful deploy record of ${svc.repo} in ${ENV[env]}.`,
          readAt: c.last_successful_read_at, unavailable: bad, since: c.unavailable_since ?? null, message: c.message,
        }));
      }
    }
    // Flag: per flag and environment, in the person's flag platform (Flagsmith or Statsig).
    const platform = lm.flag_platform === 'statsig' ? 'statsig' : 'flagsmith';
    const where = platform === 'statsig' ? 'Statsig' : 'the flag console';
    for (const fl of lm.flags) {
      for (const env of Object.keys(ENV)) {
        const c = fl.environments[env];
        const bad = UNKNOWN.has(c.state);
        const label = `${fl.key} in ${ENV[env]}`;
        out.push(entry({
          kind: 'flag', key: `flag:${fl.key}:${env}`, label: `${fl.key} in ${ENV[env]}`, state: fl.unknown ? 'unknown_flag' : c.state, source: platform,
          links: [c.link ? { label: `${label} (${platform === 'statsig' ? 'Statsig' : 'flag console'})`, url: c.link } : null],
          note: fl.unknown ? `Flag ${fl.key} doesn't exist in ${where}.`
            : c.state === 'missing_environment' ? c.message
              : bad ? `${where[0].toUpperCase()}${where.slice(1)} has not been read successfully yet, so there is no known flag to link to.` : null,
          readAt: fl.unknown ? fl.snapshot_read_at ?? lm.read_at : c.last_successful_read_at ?? null, unavailable: bad, since: c.unavailable_since ?? null, message: c.message,
          fromSnapshot: Boolean(c.from_snapshot || fl.from_snapshot),
        }));
      }
    }
  }

  // Experiment: per experiment and environment, the experiment's page in Statsig (one page for every
  // environment: Statsig keeps one status per experiment).
  if (lm && lm.state !== 'not_tracked') {
    for (const x of lm.experiments || []) {
      for (const env of Object.keys(ENV)) {
        const c = x.environments[env];
        const bad = UNKNOWN.has(c.state);
        const label = `${x.name || x.id} in ${ENV[env]}`;
        out.push(entry({
          kind: 'experiment', key: `experiment:${x.id}:${env}`, label, state: x.unknown ? 'unknown_experiment' : c.state, source: 'statsig',
          links: [c.link ? { label: `experiment ${x.name || x.id} (Statsig)`, url: c.link } : null],
          note: x.unknown ? `Experiment ${x.id} doesn't exist in Statsig.`
            : bad ? 'Statsig has not been read successfully yet, so there is no known experiment to link to.' : null,
          readAt: c.last_successful_read_at ?? null, unavailable: bad, since: c.unavailable_since ?? null, message: c.message,
        }));
      }
    }
  }

  // Store: per app and platform, the version in the store's console (App Store Connect, Play Console)
  // plus the release tag that backs the written first version. Unavailable keeps the last known link.
  if (lm && lm.state !== 'not_tracked') {
    for (const a of lm.apps || []) {
      for (const c of Object.values(a.platforms || {})) {
        const bad = UNKNOWN.has(c.state);
        out.push(entry({
          kind: 'store', key: `store:${a.id}:${c.platform}`, label: `${a.name} ${c.platform_label}`, state: c.state, source: c.via === 'slack' ? 'slack' : c.store,
          links: [c.link ? { label: `${a.name} ${c.platform_label}${c.version ? ` ${c.version}` : ''} (${c.via === 'slack' ? `Slack ${c.release_channel}` : c.store_name})`, url: c.link } : null,
            c.tag_check?.link ? { label: `release tag ${c.tag_check.tag} (${a.repo})`, url: c.tag_check.link } : null],
          note: a.unknown ? `No apps/${a.id}.yaml defines the app ${a.id}.`
            : c.state === 'not_connected' ? `${c.store_name} isn't connected to LifeCycle yet, so there is no store item to link to.`
              : bad ? `${c.store_name} has not been read successfully yet, so there is no known version to link to.` : null,
          readAt: c.last_successful_read_at ?? null, unavailable: bad, since: c.unavailable_since ?? null, message: c.message || c.label,
          fromSnapshot: Boolean(c.from_snapshot),
        }));
      }
    }
  }

  // Blocked: the PR or issue that blocks it, else the blocking feature or the definition at fault.
  status.blockers.forEach((b, i) => {
    let links = (b.evidence || []).map((e) => ({ label: e.label, url: e.link }));
    let note = null;
    if (!links.length && b.kind === 'dependency' && b.feature) links = [{ label: `blocking feature ${b.feature_name || b.feature}`, url: featureLink(baseUrl, b.feature) }];
    if (!links.length) {
      links = [def];
      note = 'The block comes from the feature definition itself.';
    }
    out.push(entry({
      kind: 'blocked', key: `blocker:${i}`, label: b.feature_name ? `by ${b.feature_name}` : b.kind.replace(/_/g, ' '),
      state: 'blocked', source: (b.evidence || []).length ? 'github' : 'definitions', links, note,
      // A dependency only blocks when its pending step was read in this refresh.
      readAt: (b.evidence || []).length ? status.read_at : synced, message: b.why,
    }));
  });

  // Delay warning: the open steps it is worked out from.
  const d = status.delay;
  if (d?.enabled) {
    const open = status.steps.filter((s) => s.state !== 'done');
    const links = open.flatMap((s) => s.evidence.map((e) => ({ label: `open step "${s.name}": ${evLabel(e)}`, url: e.link })));
    const bad = open.filter((s) => UNKNOWN.has(s.state));
    out.push(entry({
      kind: 'delay', key: 'delay', label: d.at_risk ? 'at risk' : 'on track', state: d.at_risk ? 'at_risk' : 'on_track', source: 'lifecycle',
      links: links.length ? [...links, def] : [],
      note: !open.length ? 'No open steps: every step is done.' : 'Its open steps have no linked PR or issue yet.',
      readAt: open.length ? oldest(open.map((s) => (s.linked_work ? s.last_successful_read_at ?? null : synced))) : synced,
      unavailable: bad.length > 0, since: earliest(bad.map((s) => s.unavailable_since)), message: d.text,
    }));
  }

  return out;
}
