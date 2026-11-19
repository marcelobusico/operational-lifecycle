// Last-mile state of one feature, from what was read: development (PRs + GitHub Actions),
// deploys per service and environment, flags per environment and experiments. Pure logic, no I/O.
//
// Order of the rules (production is what users get; QA is shown and compared):
//  1. no services and no flags listed          → not_tracked
//  2. any read failed (source down, no access)  → unavailable  (never on or off)
//  3. development not done                      → in_development
//  4. a service doesn't run it in production    → done_not_deployed        (names service + environment)
//  5. a flag is off or unknown in production    → switched_off if it was on before, else deployed_flag_off
//  6. an experiment runs in production          → in_experiment (names it; groups, shares, what each gets)
//  7. no flags                                  → fully_on, labeled "no flags"
//  8. a flag is partly rolled out in production → partly_rolled_out (percentage)
//  9. otherwise                                 → fully_on
// Mobile apps (between 4 and 5): per app and platform whose store is connected, the version that
// first includes the feature must be released to everyone; otherwise, worst first:
//  rollout_halted, store_rejected, not_in_app_version, in_store_review, waiting_for_release,
//  app_partly_released ("Released in 3.4.0 to 20% of iOS users"). A platform whose store isn't
//  connected shows "store not connected" and is never guessed; with no connected store at all the
//  state is store_not_connected. A store read that failed or an unknown app is rule 2.
// An experiment that isn't running (not started, ended, not in production) doesn't change the state:
// once it ends, the flags decide again. An unknown experiment is a warning, like an unknown flag.

export const ENVIRONMENTS = ['qa', 'production'];
export const ENV_LABEL = { qa: 'QA', production: 'production' };

const LABELS = {
  not_tracked: 'No services or flags listed',
  unavailable: 'Status unavailable',
  in_development: 'Not done yet',
  done_not_deployed: 'Done but not deployed',
  deployed_flag_off: 'Done but not turned on',
  switched_off: 'Switched off',
  fully_on: 'Fully on',
  in_experiment: 'In experiment',
  not_in_app_version: 'Not yet in an app version',
  in_store_review: 'In review',
  waiting_for_release: 'Waiting for release',
  store_rejected: 'Rejected in store review',
  rollout_halted: 'Rollout halted',
  app_partly_released: 'Partly released',
  store_not_connected: 'Store not connected',
};

// The context doc's vocabulary, for people who think in those terms.
const CONTEXT_STATE = {
  done_not_deployed: 'not_in_qa',
  deployed_flag_off: 'in_production_not_rolled_out',
  partly_rolled_out: 'in_production_not_rolled_out',
  in_experiment: 'in_production_not_rolled_out',
  fully_on: 'rolled_out',
  switched_off: 'switched_off',
  app_partly_released: 'in_production_not_rolled_out',
  rollout_halted: 'in_production_not_rolled_out',
};

const STORE_SOURCE = { app_store: 'the App Store', google_play: 'Google Play' };
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

// One platform's store state in words, e.g. "released in 3.4.0 to 20% of iOS users".
// Where an app release cell was read, for text: the store, or the app's Slack release channel, and
// when it is the team snapshot, from when ("App Store", "Slack #mobile-releases, team snapshot from 2026-11-10 09:30 UTC").
export function storeSource(c) {
  const where = c.via === 'slack' ? `Slack ${c.release_channel}` : c.store_name;
  return c.from_snapshot && c.snapshot_read_at ? `${where}, team snapshot from ${c.snapshot_read_at.slice(0, 16).replace('T', ' ')} UTC` : where;
}

export function storeLabel(c) {
  const v = c.version;
  switch (c.state) {
    case 'released':
      if (c.rollout_state === 'halted') return `rollout halted: ${v} ${c.store_word ? `${c.store_word} ` : ''}at ${c.rollout_percentage ?? '?'}% of ${c.platform_label} users`;
      if (c.rollout_state === 'gradual') return `released in ${v} to ${c.rollout_percentage ?? '?'}% of ${c.platform_label} users`;
      return `fully released in ${v}`;
    case 'in_review': return `in version ${v}, in review`;
    case 'approved_waiting': return `in version ${v}, approved, waiting for release`;
    case 'rejected': return `in version ${v}, rejected in review`;
    case 'preparing': return `in version ${v}, not submitted for review yet`;
    case 'removed': return `version ${v} removed from the store`;
    case 'not_in_version': return c.first_version ? `not yet in an app version (${c.first_version} isn't in ${c.store_name} yet)` : 'not yet in an app version';
    case 'not_connected': return 'store not connected';
    case 'unknown_app': return 'unknown app';
    case 'no_access': return 'no access';
    default: return 'status unavailable';
  }
}
// Platform state → feature state, worst first.
const PLATFORM_RANK = [
  ['rollout_halted', (c) => c.state === 'released' && c.rollout_state === 'halted'],
  ['store_rejected', (c) => c.state === 'rejected'],
  ['not_in_app_version', (c) => c.state === 'not_in_version' || c.state === 'removed'],
  ['in_store_review', (c) => c.state === 'in_review'],
  ['waiting_for_release', (c) => c.state === 'approved_waiting' || c.state === 'preparing'],
  ['app_partly_released', (c) => c.state === 'released' && c.rollout_state === 'gradual'],
];

// How messages name the place flags live. Flagsmith keeps the original "flag console" wording.
export const FLAG_CONSOLE = { flagsmith: 'the flag console', statsig: 'Statsig' };
export const FLAG_PLATFORM_NAME = { flagsmith: 'the flag console (Flagsmith)', statsig: 'Statsig' };
// The short name in evidence labels, e.g. "rewards_enabled in production (Statsig)".
export const flagLinkLabel = (platform) => (platform === 'statsig' ? 'Statsig' : 'flag console');
export const flagPlace = (platform) => FLAG_CONSOLE[platform] || FLAG_CONSOLE.flagsmith;

const FAILED = new Set(['unavailable', 'no_access']);
const shareList = (groups) => groups.map((g) => `${g.name}${g.control ? ' (control)' : ''} ${g.share ?? '?'}%`).join(', ');
const ofUsers = (g) => (g.share_of_users !== null && g.share_of_users !== undefined && g.share_of_users !== g.share ? ` (${g.share_of_users}% of users)` : '');
const time = (iso) => (iso ? new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : null);

// input: { feature, development, services, flags, readAt }
//  development: { state: done|not_done|unavailable|no_access, message, prs: [...] }
//  services: [{ id, repo, unknown?, environments: { qa: cell, production: cell } }]
//    cell: { state: ok|unavailable|no_access, deployed, version, contains_feature, ... }
//  flags: [{ key, unknown?, environments: { qa: cell, production: cell } }]
//    cell: { state: on|off|partial|unavailable|no_access|missing_environment, rollout_percentage, was_on_before, ... }
//  flagPlatform: 'flagsmith' | 'statsig', where the flags were read (only changes wording)
//  experiments: [{ id, unknown?, environments: { qa: cell, production: cell } }]
//    cell: { state: running|not_running|not_started|ended|unknown|unavailable|no_access, name, groups, assignment, link, ... }
export function lastMileState({ feature, development, services, flags, experiments = [], apps = [], flagPlatform = 'flagsmith' }) {
  const reasons = [];
  const flagConsole = FLAG_CONSOLE[flagPlatform] || FLAG_CONSOLE.flagsmith;
  const warnings = [];

  for (const s of services) {
    if (s.unknown) warnings.push({ kind: 'unknown_service', service: s.id, message: `Unknown service "${s.id}": no services/${s.id}.yaml in the shared repo says where it is deployed.` });
    const qa = s.environments.qa;
    const prod = s.environments.production;
    if (qa?.deployed && prod?.deployed && (qa.version !== prod.version || (qa.sha && prod.sha && qa.sha !== prod.sha))) {
      const same = qa.version === prod.version;
      warnings.push({ kind: 'version_mismatch', service: s.id, qa: qa.version, production: prod.version,
        message: same
          ? `${s.id}: QA and production both say ${qa.version}, but run different builds (${qa.sha.slice(0, 7)} vs ${prod.sha.slice(0, 7)}).`
          : `${s.id}: QA runs ${qa.version}, production runs ${prod.version}.` });
    }
  }
  for (const f of flags) {
    if (f.unknown) warnings.push({ kind: 'unknown_flag', flag: f.key, message: `Unknown flag "${f.key}": it is listed in the feature definition but doesn't exist in ${flagConsole}.` });
  }
  // Apps: unknown apps and store ids, release tags that don't back the written version, platforms that disagree.
  for (const a of apps) {
    if (a.unknown) warnings.push({ kind: 'unknown_app', app: a.id, message: `Unknown app "${a.id}": no apps/${a.id}.yaml in the shared repo says what it is or where it's published.` });
    for (const p of a.missing_platforms || []) warnings.push({ kind: 'app_platform', app: a.id, platform: p, message: `${a.id}: a first version is written for ${p}, but apps/${a.id}.yaml has no ${p} platform.` });
    const cells = Object.values(a.platforms || {});
    const tagIssues = new Map(); // one warning per distinct problem, naming the platforms it affects
    for (const c of cells) {
      if (c.state === 'unknown_app') warnings.push({ kind: 'unknown_app', app: a.id, platform: c.platform, message: c.message });
      if (c.tag_check && ['no_tag', 'contradicts'].includes(c.tag_check.state)) {
        const t = tagIssues.get(c.tag_check.message) || { platforms: [], link: c.tag_check.link || null };
        t.platforms.push(c.platform_label);
        tagIssues.set(c.tag_check.message, t);
      }
    }
    for (const [message, t] of tagIssues) warnings.push({ kind: 'app_version_tag', app: a.id, link: t.link, message: `${a.name} (${t.platforms.join(', ')}): ${message}` });
    // Platforms disagree when the feature stands differently on them (not just different version numbers).
    const read = cells.filter((c) => c.connected && !['unavailable', 'no_access', 'unknown_app'].includes(c.state));
    const words = new Set(read.map((c) => `${c.state}:${c.state === 'released' ? c.rollout_state : ''}:${c.state === 'released' && c.rollout_state !== 'complete' ? c.rollout_percentage : ''}`));
    if (read.length > 1 && words.size > 1) {
      warnings.push({ kind: 'platform_mismatch', app: a.id,
        message: `${a.name}: the platforms differ: ${read.map((c) => `${c.platform_label} ${storeLabel(c)}`).join('; ')}.` });
    }
  }
  for (const x of experiments) {
    if (x.unknown) warnings.push({ kind: 'unknown_experiment', experiment: x.id, message: `Unknown experiment "${x.id}": it is listed in the feature definition but doesn't exist in Statsig.` });
  }

  let storeOut = null;   // per platform: what each store says (set once apps are checked)
  const storeNotes = []; // platforms whose store isn't connected: said, never guessed
  const result = (state, extra = {}) => {
    const label = state === 'partly_rolled_out'
      ? `Partly rolled out – ${extra.rollout_percentage ?? '?'}%`
      : state === 'in_experiment' ? `In experiment – ${extra.experiment.name}`
      : extra.store_label ? extra.store_label
      : state === 'fully_on' && apps.length && !services.length && !flags.length ? 'Fully released'
      : LABELS[state] + (state === 'fully_on' && !flags.length ? ' · no flags' : '');
    return {
      state,
      label,
      context_state: CONTEXT_STATE[state] || null,
      done_but_not_turned_on: ['done_not_deployed', 'deployed_flag_off', 'switched_off'].includes(state),
      flags_mode: flags.length ? 'flags' : 'no_flags',
      rollout_percentage: null,
      switched_off: null,
      // in_experiment: { id, name, environment, groups, assignment, link } of the experiment running in production.
      experiment: null,
      // Apps: the platform cells that decided the state (app, platform, state, version, rollout %).
      store: storeOut,
      store_notes: storeNotes,
      reasons,
      summary: '',
      warnings,
      ...extra,
    };
  };

  // 1. Nothing to check.
  if (!services.length && !flags.length && !experiments.length && !apps.length) {
    return result('not_tracked', { summary: `${feature.name} lists no services, apps or flags, so there is nothing to check after development. Add them to ${feature.file}.` });
  }

  // 2. Any failed read: say so, never guess on/off.
  const failures = [];
  if (FAILED.has(development.state)) failures.push({ source: 'github', what: 'development (GitHub Actions)', message: development.message });
  for (const s of services) {
    if (s.unknown) failures.push({ source: 'definitions', what: `service ${s.id}`, message: `No services/${s.id}.yaml defines where ${s.id} is deployed.` });
    for (const env of ENVIRONMENTS) {
      const c = s.environments[env];
      if (c && FAILED.has(c.state)) failures.push({ source: 'github', what: `${s.id} deploys in ${ENV_LABEL[env]}`, message: c.message });
    }
  }
  for (const f of flags) {
    for (const env of ENVIRONMENTS) {
      const c = f.environments[env];
      if (c && (FAILED.has(c.state) || c.state === 'missing_environment')) failures.push({ source: flagPlatform, what: `flag ${f.key} in ${ENV_LABEL[env]}`, message: c.message });
    }
  }
  for (const x of experiments) {
    for (const env of ENVIRONMENTS) {
      const c = x.environments[env];
      if (c && FAILED.has(c.state)) failures.push({ source: 'statsig', what: `experiment ${x.id} in ${ENV_LABEL[env]}`, message: c.message });
    }
  }
  for (const a of apps) {
    if (a.unknown) failures.push({ source: 'definitions', what: `app ${a.id}`, message: `No apps/${a.id}.yaml defines the app ${a.id}.` });
    for (const c of Object.values(a.platforms || {})) {
      if (FAILED.has(c.state)) failures.push({ source: c.store, what: `${a.name} ${c.platform_label}`, message: c.message });
      if (c.state === 'unknown_app') failures.push({ source: c.store, what: `${a.name} ${c.platform_label}`, message: `${c.message} (unknown app)` });
    }
  }
  if (failures.length) {
    // One line per distinct problem, listing everything it affects (a missing key hits every flag).
    const grouped = new Map();
    for (const x of failures) {
      const key = `${x.source}|${x.message}`;
      if (!grouped.has(key)) grouped.set(key, { source: x.source, message: x.message, what: [] });
      grouped.get(key).what.push(x.what);
    }
    for (const g of grouped.values()) reasons.push({ kind: 'unavailable', source: g.source, message: `${g.what.join(', ')}: ${g.message}` });
    const sources = [...new Set(failures.map((x) => ({ github: 'GitHub', ...FLAG_PLATFORM_NAME, ...STORE_SOURCE, definitions: 'the shared repo' }[x.source])))];
    return result('unavailable', { summary: `Status unavailable: ${sources.join(' and ')} couldn't be read, so LifeCycle can't tell whether users have ${feature.name}.` });
  }

  // 3. Development.
  if (development.state !== 'done') {
    reasons.push({ kind: 'development', message: development.message });
    return result('in_development', { summary: `Not done yet: ${development.message}` });
  }

  // 4. Deployed to production?
  for (const s of services) {
    const prod = s.environments.production;
    const qa = s.environments.qa;
    const inQa = qa.deployed && qa.contains_feature !== false;
    if (!prod.deployed) {
      reasons.push({ kind: 'service', service: s.id, environment: 'production',
        message: `${s.id} isn't deployed to production${inQa ? ` (QA runs ${qa.version})` : qa.deployed ? ` (and QA runs ${qa.version}, which doesn't include it)` : ' (nor to QA)'}.` });
    } else if (prod.contains_feature === false) {
      reasons.push({ kind: 'service', service: s.id, environment: 'production',
        message: `${s.id} ${prod.version} in production doesn't include this work${inQa ? ` yet; QA runs ${qa.version}, which does` : ''}.` });
    }
  }
  if (reasons.length) {
    const notInQa = services.some((s) => !(s.environments.qa.deployed && s.environments.qa.contains_feature !== false));
    return result('done_not_deployed', {
      context_state: notInQa ? 'not_in_qa' : 'in_qa_not_in_production',
      summary: `Done but not deployed: ${reasons.map((r) => r.message).join(' ')}`,
    });
  }

  // 4b. Mobile apps: the version that first includes it must be out to everyone on every connected store.
  if (apps.length) {
    const cells = apps.flatMap((a) => Object.values(a.platforms).map((c) => ({ ...c, app: a })));
    const connected = cells.filter((c) => c.connected);
    const notConnected = cells.filter((c) => !c.connected);
    const store = cells.map((c) => ({ app: c.app.id, platform: c.platform, store: c.store, state: c.state, label: storeLabel(c), version: c.version ?? null,
      rollout_state: c.rollout_state ?? null, rollout_percentage: c.rollout_percentage ?? null, link: c.link || null, read_at: c.read_at || null }));
    storeOut = store;
    for (const c of notConnected) storeNotes.push({ kind: 'store', app: c.app.id, platform: c.platform, store: c.store, state: 'not_connected', message: `${c.app.name} ${c.platform_label}: ${c.store_name} isn't connected, so its release isn't known.` });
    if (!connected.length && !services.length && !flags.length) {
      reasons.push(...storeNotes);
      return result('store_not_connected', { summary: `Store not connected: ${storeNotes.map((r) => r.message).join(' ')}` });
    }
    for (const [state, match] of PLATFORM_RANK) {
      const hit = connected.filter(match);
      if (!hit.length) continue;
      for (const c of hit) reasons.push({ kind: 'store', app: c.app.id, platform: c.platform, store: c.store, state: c.state, version: c.version ?? null,
        rollout_percentage: c.rollout_percentage ?? null, link: c.link || null, message: `${c.app.name} ${c.platform_label}: ${storeLabel(c)} (${storeSource(c)}).` });
      const label = state === 'app_partly_released' ? cap(hit.map(storeLabel).join('; '))
        : state === 'rollout_halted' ? `Rollout halted – ${hit.map((c) => `${c.platform_label} ${c.version} at ${c.rollout_percentage ?? '?'}%`).join(', ')}`
          : ['in_store_review', 'waiting_for_release', 'store_rejected'].includes(state) ? `${LABELS[state]} – ${hit.map((c) => `${c.platform_label} ${c.version}`).join(', ')}`
            : LABELS[state];
      return result(state, { store_label: label, rollout_percentage: state === 'app_partly_released' || state === 'rollout_halted' ? Math.min(...hit.map((c) => c.rollout_percentage ?? 0)) : null,
        summary: `${label}: ${[...reasons, ...storeNotes].map((r) => r.message).join(' ')}` });
    }
  }

  // 5–9. Flags and experiments in production.
  const prodFlag = (f) => f.environments.production;
  const off = flags.filter((f) => f.unknown || prodFlag(f).state === 'off');
  if (off.length) {
    const switched = off.filter((f) => !f.unknown && prodFlag(f).was_on_before)
      .map((f) => ({ flag: f.key, environment: 'production', changed_at: prodFlag(f).changed_at || null, changed_by: prodFlag(f).changed_by || null, link: prodFlag(f).link }));
    for (const f of off) {
      const c = prodFlag(f);
      reasons.push({ kind: 'flag', flag: f.key, environment: 'production', message: f.unknown
        ? `Flag ${f.key} doesn't exist in ${flagConsole} (unknown flag), so users can't get it.`
        : c.was_on_before
          ? `Flag ${f.key} was switched off in production${c.changed_at ? ` on ${time(c.changed_at)}` : ''}${c.changed_by ? ` by ${c.changed_by}` : ''}.`
          : `Flag ${f.key} is off in production.` });
    }
    if (switched.length) {
      const s = switched[0];
      return result('switched_off', { switched_off: s,
        summary: `Switched off: ${reasons.map((r) => r.message).join(' ')}${s.changed_by ? '' : ` Who changed it isn't recorded by ${flagConsole}.`}` });
    }
    const where = services.length ? 'deployed to production' : `released in the app (${(storeOut || []).filter((c) => c.state === 'released').map((c) => `${c.platform === 'ios' ? 'iOS' : 'Android'} ${c.version}`).join(', ')})`;
    return result('deployed_flag_off', { summary: `Done but not turned on: ${where}, but ${reasons.map((r) => r.message.replace(/\.$/, '').replace(/^Flag /, 'flag ')).join('; ')}.` });
  }
  // An experiment running in production: users deliberately get different behavior per group.
  const running = experiments.filter((x) => !x.unknown && x.environments.production?.state === 'running');
  if (running.length) {
    for (const x of running) {
      const c = x.environments.production;
      const gets = c.groups.map((g) => `${g.name}${g.control ? ' (control)' : ''} ${g.share ?? '?'}%${ofUsers(g)}: ${g.gets ? g.gets.replace(/\.$/, '') : 'not described in the definition'}`).join('; ');
      reasons.push({ kind: 'experiment', experiment: x.id, environment: 'production',
        message: `Experiment ${c.name} is running in production with ${c.groups.length} groups (${shareList(c.groups)}). ${gets}.${c.assignment?.allocation !== null && c.assignment?.allocation !== undefined && c.assignment.allocation < 100 ? ` Only ${c.assignment.allocation}% of eligible users are in it; the rest get the default.` : ''}` });
    }
    const c = running[0].environments.production;
    return result('in_experiment', {
      experiment: { id: running[0].id, name: c.name, environment: 'production', groups: c.groups, assignment: c.assignment, link: c.link },
      summary: `In experiment: ${reasons.map((r) => r.message).join(' ')}`,
    });
  }
  // No flags: deploys alone decide.
  const released = apps.length ? ` ${apps.map((a) => Object.values(a.platforms).filter((c) => c.connected).map((c) => `${a.name} ${c.platform_label} ${storeLabel(c)}`).join(', ')).filter(Boolean).join('; ')}.` : '';
  if (!flags.length) {
    const notes = storeNotes.length ? ` ${storeNotes.map((r) => r.message).join(' ')}` : '';
    if (!services.length) return result('fully_on', { summary: `Fully released:${released}${notes} This feature uses no flags.` });
    return result('fully_on', { summary: `Fully on: deployed to production (${services.map((s) => `${s.id} ${s.environments.production.version}`).join(', ')}).${released} This feature uses no flags.` });
  }
  const partial = flags.filter((f) => prodFlag(f).state === 'partial');
  if (partial.length) {
    const pcts = partial.map((f) => prodFlag(f).rollout_percentage).filter((p) => p !== null && p !== undefined);
    const pct = pcts.length ? Math.min(...pcts) : null;
    for (const f of partial) {
      const c = prodFlag(f);
      reasons.push({ kind: 'flag', flag: f.key, environment: 'production', message: c.rollout_percentage !== null && c.rollout_percentage !== undefined
        ? `Flag ${f.key} is on for ${c.rollout_percentage}% of users in production.`
        : `Flag ${f.key} is on only for some segments (${(c.segments || []).map((x) => x.name).join(', ')}) in production.` });
    }
    return result('partly_rolled_out', { rollout_percentage: pct, summary: `Partly rolled out: ${reasons.map((r) => r.message).join(' ')}` });
  }
  return result('fully_on', { summary: `Fully on: deployed to production and ${flags.map((f) => f.key).join(', ')} ${flags.length === 1 ? 'is' : 'are'} on for everyone.` });
}
