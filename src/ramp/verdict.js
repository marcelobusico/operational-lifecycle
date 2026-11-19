// "Ready to ramp?": one verdict per feature, combining everything LifeCycle already reads (steps,
// dependencies, last mile, registered changes, alerts) plus the feature's own ramp conditions.
// Pure logic, no I/O: computed on every refresh from the snapshot, so it changes when the sources
// change and nobody edits anything.
//
//   ready      every check passed (checks that can't apply are listed as "not checked")
//   not_ready  at least one check failed; every reason names its owner and links its evidence
//   cant_tell  nothing failed, but a source a check relies on couldn't be read; names the source
//              and when it was last read. Never "ready" while a source is unavailable.
//
// Ramping means turning the feature's own flag up, so its flag being off or partly rolled out is
// not a reason. A flag that was switched off after being on, an unknown flag, or a dependency
// that isn't done and fully on for users is.

import { FLAG_PLATFORM_NAME, flagLinkLabel, flagPlace } from '../lastmile/state.js';
import { evidenceLabel } from '../evidence.js';

const flagSource = (lm) => FLAG_PLATFORM_NAME[lm?.flag_platform] || FLAG_PLATFORM_NAME.flagsmith;

export const RAMP_LABEL = { ready: 'Ready to ramp', not_ready: 'Not ready to ramp', cant_tell: "Can't tell if it's ready to ramp" };
const ENV = { qa: 'QA', production: 'production' };
const FAILED = new Set(['unavailable', 'no_access']);
const when = (iso) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : 'never');
const evLabel = evidenceLabel;
const linksOf = (evidence) => (evidence || []).filter((e) => e.link).map((e) => ({ label: e.label || evLabel(e), link: e.link }));
const oldest = (times) => (times.includes(null) || times.includes(undefined) ? null : [...times].sort()[0] ?? null);
// What a check is about, for the one-line summary ("Not checked: experiments and variants; alerts").
const TOPIC = { steps: 'steps', dependencies: 'dependencies', development: 'development', deploys: 'deploys', versions: 'versions',
  flags: 'flags', store: 'app store releases', experiments: 'experiments and variants', changes: 'planned changes', alerts: 'alerts' };
const isResolved = (a) => Boolean(a.resolved || a.resolved_at || a.state === 'resolved');

// status: one lifecycle.feature-status/v1 object (with last_mile and ramp_conditions).
// statusById: every feature's status, for dependencies. services: the catalog ({ id, owner }).
// changes: registered changes with evidence_link. alerts: lifecycle.alerts/v1 alerts (the alert list).
// alertsSource: the alert list's meta. definitionLink(file).
export function rampVerdict({ status, statusById, services = [], changes = [], alerts = [], alertsSource = null, definitionLink = () => null }) {
  const f = status.feature;
  const defEv = [{ label: `definition ${f.file}`, link: definitionLink(f.file) }].filter((e) => e.link);
  const checks = [];
  const reasons = [];
  const unavailable = [];

  // Each check collects its own reasons and unavailable sources; its state follows from them.
  function check(id, name, run, { custom = false } = {}) {
    const c = { id, name, custom, state: 'passed', detail: null };
    const ctx = {
      fail(message, owner, evidence, extra = {}) {
        reasons.push({ check: id, message, owner: owner || f.owner, evidence: evidence?.length ? evidence : defEv, ...extra });
      },
      unavailable(source, what, message, lastRead) {
        unavailable.push({ check: id, source, what, message: message || null, last_successful_read_at: lastRead ?? null });
      },
      notChecked(detail) { c.state = 'not_checked'; c.detail = detail; },
      // Failed, but the reason is already listed under another check (no duplicate line).
      failedElsewhere(detail) { c.failedElsewhere = true; c.detail = detail; },
      detail(text) { c.detail = text; },
    };
    const before = { r: reasons.length, u: unavailable.length };
    run(ctx);
    if (reasons.length > before.r || c.failedElsewhere) c.state = 'failed';
    else if (unavailable.length > before.u) c.state = 'unavailable';
    delete c.failedElsewhere;
    if (c.state !== 'not_checked' && !c.detail) {
      c.detail = c.state === 'failed' ? reasons.slice(before.r).map((r) => r.message).join(' ')
        : c.state === 'unavailable' ? unavailable.slice(before.u).map((u) => `${u.what}: ${u.source} couldn't be read (last read ${when(u.last_successful_read_at)}).`).join(' ')
          : null;
    }
    checks.push(c);
  }

  const lm = status.last_mile;
  const tracked = lm && lm.state !== 'not_tracked';

  // 1. Steps.
  check('steps', 'Every step is done', (x) => {
    if (!status.steps.length) return x.notChecked('The definition has no steps.');
    for (const s of status.steps) {
      if (s.state === 'done') continue;
      if (FAILED.has(s.state)) x.unavailable('GitHub', `step "${s.name}"`, s.message, s.last_successful_read_at);
      else {
        const open = s.evidence.filter((e) => e.state !== 'done').map((e) => `${evLabel(e)} is ${e.detail || e.state}`);
        x.fail(`Step "${s.name}" isn't done${s.linked_work ? `: ${open.join('; ')}` : ' (no PR or issue linked yet)'}.`, s.owner, linksOf(s.evidence), { kind: 'step', step: s.id });
      }
    }
    if (status.steps.every((s) => s.state === 'done')) x.detail(status.steps.length === 1 ? 'Its only step is done.' : `All ${status.steps.length} steps are done.`);
  });

  // 2. Dependencies: done, and fully on for users when their availability is tracked.
  check('dependencies', 'Dependencies are done and on for users', (x) => {
    for (const b of status.blockers.filter((b) => b.kind !== 'dependency')) x.fail(`${b.why}.`, b.owner, [], { kind: 'dependency' });
    if (!status.depends_on.length) return x.detail('No dependencies.');
    for (const d of status.depends_on) {
      const dep = statusById.get(d.id);
      if (!dep) continue; // unknown ids are reported through the blockers above
      const name = dep.feature.name;
      if (dep.state === 'unavailable') {
        const times = dep.steps.filter((s) => FAILED.has(s.state)).map((s) => s.last_successful_read_at);
        x.unavailable('GitHub', `dependency ${name}`, dep.summary, oldest(times));
        continue;
      }
      if (dep.state !== 'done') {
        const via = status.blockers.filter((b) => b.kind === 'dependency' && (b.feature === d.id || b.via?.[0] === d.id));
        if (via.length) for (const b of via) x.fail(`Dependency ${name} isn't done: ${b.why}.`, b.owner, linksOf(b.evidence), { kind: 'dependency', dependency: d.id });
        else x.fail(`Dependency ${name} isn't done (${dep.summary})`, dep.feature.owner, linksOf(dep.steps.flatMap((s) => s.evidence)), { kind: 'dependency', dependency: d.id });
        continue;
      }
      const dl = dep.last_mile;
      if (!dl || dl.state === 'not_tracked' || dl.state === 'fully_on') continue;
      if (dl.state === 'unavailable') {
        x.unavailable(sourceOfLastMile(dl), `dependency ${name}`, dl.summary, dl.last_successful_read_at);
        continue;
      }
      const ev = (dl.evidence || []).filter((e) => ['flag_setting', 'deploy_record'].includes(e.kind)).map((e) => ({ label: `${name}: ${e.label}`, link: e.link }));
      if (dl.state === 'switched_off') {
        const s = dl.switched_off;
        x.fail(`Dependency ${name} was switched off: flag ${s.flag} in production${s.changed_at ? ` on ${when(s.changed_at)}` : ''}${s.changed_by ? ` by ${s.changed_by}` : ''}.`,
          s.changed_by || dep.feature.owner, s.link ? [{ label: `${s.flag} in production (${flagLinkLabel(dl.flag_platform)})`, link: s.link }] : ev, { kind: 'dependency', dependency: d.id });
      } else {
        x.fail(`Dependency ${name} isn't fully on for users: ${dl.label}. ${dl.summary}`, dep.feature.owner, ev, { kind: 'dependency', dependency: d.id });
      }
    }
  });

  // 3–5. Development, deploys, versions: from the last mile.
  check('development', 'Development merged with GitHub Actions passing', (x) => {
    if (!tracked) return x.notChecked(lm ? 'The definition lists no services, apps or flags.' : 'Not read.');
    const dev = lm.development;
    for (const p of dev.pull_requests) {
      const step = status.steps.find((s) => s.evidence.some((e) => e.repo === p.repo && e.number === p.number));
      const owner = step?.owner;
      if (p.state === 'ok' && p.actions !== 'success' && step && step.state !== 'done') {
        x.failedElsewhere(`PR #${p.number} in ${p.repo}: ${p.detail || 'not merged'} (see step "${step.name}").`);
        continue;
      }
      if (FAILED.has(p.state)) x.unavailable('GitHub Actions', `PR #${p.number} in ${p.repo}`, p.detail, p.last_successful_read_at);
      else if (p.actions !== 'success') x.fail(`PR #${p.number} in ${p.repo}: ${p.detail || 'not merged with Actions passing'}.`, owner, [{ label: `PR #${p.number} in ${p.repo}`, link: p.link }, p.actions_link ? { label: `GitHub Actions for PR #${p.number}`, link: p.actions_link } : null].filter(Boolean), { kind: 'development' });
    }
    if (!dev.pull_requests.length) x.fail(dev.message, f.owner, [], { kind: 'development' });
    if (dev.state === 'done') x.detail(dev.message);
  });

  const svcOwner = (id) => services.find((s) => s.id === id)?.owner || f.owner;
  check('deploys', 'Deployed to production on every service', (x) => {
    if (!tracked) return x.notChecked(lm ? 'The definition lists no services, apps or flags.' : 'Not read.');
    if (!lm.services.length) return x.notChecked('The definition lists no services.');
    for (const s of lm.services) {
      const c = s.environments.production;
      if (s.unknown) { x.fail(`Unknown service ${s.id}: no services/${s.id}.yaml says where it is deployed.`, f.owner, [], { kind: 'service', service: s.id }); continue; }
      const link = c.link ? [{ label: `deploy record: ${s.id} in production`, link: c.link }] : [];
      if (FAILED.has(c.state)) x.unavailable('GitHub Deployments', `${s.id} in production`, c.message, c.last_successful_read_at);
      else if (!c.deployed) x.fail(`${s.id} isn't deployed to production.`, svcOwner(s.id), link, { kind: 'service', service: s.id, environment: 'production' });
      else if (c.contains_feature === false) x.fail(`${s.id} ${c.version || ''} in production doesn't include this work.`.replace('  ', ' '), svcOwner(s.id), link, { kind: 'service', service: s.id, environment: 'production' });
    }
    const ok = lm.services.filter((s) => s.environments.production.deployed && s.environments.production.contains_feature !== false);
    if (ok.length === lm.services.length) x.detail(`In production: ${ok.map((s) => `${s.id} ${s.environments.production.version || s.environments.production.sha?.slice(0, 7) || ''}`.trim()).join(', ')}.`);
  });

  check('versions', 'Production runs the build tested in QA', (x) => {
    if (!tracked || !lm.services.length) return x.notChecked(tracked ? 'The definition lists no services.' : lm ? 'The definition lists no services, apps or flags.' : 'Not read.');
    for (const s of lm.services) {
      const cells = ['qa', 'production'].map((e) => s.environments[e]);
      if (cells.some((c) => FAILED.has(c.state))) {
        const bad = cells.filter((c) => FAILED.has(c.state));
        x.unavailable('GitHub Deployments', `${s.id} versions`, bad[0].message, oldest(bad.map((c) => c.last_successful_read_at)));
      }
    }
    for (const w of (lm.warnings || []).filter((w) => w.kind === 'version_mismatch')) {
      const s = lm.services.find((y) => y.id === w.service);
      x.fail(w.message, svcOwner(w.service), ['qa', 'production'].map((e) => ({ label: `deploy record: ${w.service} in ${ENV[e]}`, link: s?.environments[e].link })).filter((e) => e.link), { kind: 'version_mismatch', service: w.service });
    }
  });

  // 5b. App stores: the app version that first includes the feature is released to everyone, on
  // every platform whose store is connected. Still in review, going out gradually, halted, rejected
  // or not in a version yet → not ready, naming the store state. A store that couldn't be read →
  // can't tell. A platform whose store isn't connected is listed as not checked, never guessed.
  // Only for features that ship in an app: a backend-only feature keeps its usual list of checks.
  if (lm?.apps?.length) check('store', 'App release is out to everyone in the stores', (x) => {
    const apps = lm.apps;
    const notConnected = [];
    const ok = [];
    for (const a of apps) {
      const owner = a.owner || f.owner;
      if (a.unknown) { x.fail(`Unknown app ${a.id}: no apps/${a.id}.yaml defines it.`, f.owner, [], { kind: 'store', app: a.id }); continue; }
      for (const c of Object.values(a.platforms)) {
        const where = `${a.name} ${c.platform_label}`;
        const ev = c.link ? [{ label: `${where} in ${c.store_name}`, link: c.link }] : [];
        const extra = { kind: 'store', app: a.id, platform: c.platform, store: c.store, store_state: c.state };
        if (c.state === 'not_connected') { notConnected.push(`${where} (${c.store_name} not connected)`); continue; }
        if (FAILED.has(c.state)) { x.unavailable(c.store_name, where, c.message, c.last_successful_read_at); continue; }
        if (c.state === 'unknown_app') { x.fail(`${where}: ${c.message}`, owner, ev, extra); continue; }
        if (c.state === 'released' && c.rollout_state === 'complete') { ok.push(`${where}: ${c.label}`); continue; }
        const why = c.state === 'released' && c.rollout_state === 'halted' ? `the ${c.version} rollout is halted in ${c.store_name} at ${c.rollout_percentage ?? '?'}% of users${c.store_word ? ` (${c.store_word})` : ''}`
          : c.state === 'released' ? `${c.version} is still going out gradually in ${c.store_name}: ${c.rollout_percentage ?? '?'}% of users${c.phased_day ? ` (day ${c.phased_day} of Apple's 7-day phased release)` : ''}`
            : c.state === 'in_review' ? `${c.version} is in ${c.store_name} review`
              : c.state === 'rejected' ? `${c.version} was rejected in ${c.store_name} review`
                : c.state === 'approved_waiting' ? `${c.version} is approved in ${c.store_name} but not released yet`
                  : c.state === 'preparing' ? `${c.version} isn't submitted to ${c.store_name} review yet`
                    : `it isn't in an app version in ${c.store_name} yet${c.first_version ? ` (${c.first_version} isn't there)` : ' (no first version written in the definition)'}`;
        x.fail(`${where}: ${why}.`, owner, ev, extra);
      }
    }
    if (notConnected.length && !reasons.some((r) => r.check === 'store') && !unavailable.some((u) => u.check === 'store')) {
      x.detail(`${ok.length ? `${ok.join('; ')}. ` : ''}Not checked: ${notConnected.join(', ')}.`);
    } else if (ok.length && !reasons.some((r) => r.check === 'store') && !unavailable.some((u) => u.check === 'store')) x.detail(`${ok.join('; ')}.`);
  });

  // 6. Flags: they exist, can be read, and weren't switched off after being on.
  check('flags', 'Flags exist and weren\'t switched off', (x) => {
    if (!tracked) return x.notChecked(lm ? 'The definition lists no services, apps or flags.' : 'Not read.');
    if (!lm.flags.length) return x.detail('This feature uses no flags.');
    for (const fl of lm.flags) {
      if (fl.unknown) { x.fail(`Flag ${fl.key} doesn't exist in ${flagPlace(lm.flag_platform)}.`, f.owner, [], { kind: 'flag', flag: fl.key }); continue; }
      const bad = ['qa', 'production'].map((e) => [e, fl.environments[e]]).filter(([, c]) => FAILED.has(c.state) || c.state === 'missing_environment');
      if (bad.length) { x.unavailable(flagSource(lm), `flag ${fl.key}`, bad[0][1].message, oldest(bad.map(([, c]) => c.last_successful_read_at))); continue; }
      const c = fl.environments.production;
      if (c.state === 'off' && c.was_on_before) {
        x.fail(`Flag ${fl.key} was switched off in production${c.changed_at ? ` on ${when(c.changed_at)}` : ''}${c.changed_by ? ` by ${c.changed_by}` : ''}.`,
          c.changed_by || f.owner, c.link ? [{ label: `${fl.key} in production (${flagLinkLabel(lm.flag_platform)})`, link: c.link }] : [], { kind: 'flag', flag: fl.key, environment: 'production' });
      }
    }
    if (!reasons.some((r) => r.check === 'flags') && !unavailable.some((u) => u.check === 'flags')) {
      x.detail(lm.flags.map((fl) => {
        const c = fl.environments.production;
        return `${fl.key} in production: ${c.state === 'partial' ? `${c.rollout_percentage ?? '?'}%` : c.state}${c.from_snapshot ? ` (team snapshot, read ${when(c.snapshot_read_at)})` : ''}`;
      }).join(', ') + '.');
    }
  });

  // 7. Experiments (read from Statsig): any experiment still running means not ready to ramp, since
  // users are deliberately getting different behavior per group until it ends.
  check('experiments', 'No experiment or variant still running', (x) => {
    if (!tracked) return x.notChecked(lm ? 'The definition lists no services, apps or flags.' : 'Not read.');
    const list = lm.experiments || [];
    if (!list.length) return x.detail('The definition lists no experiments.');
    for (const e of list) {
      const name = e.name || e.id;
      if (e.unknown) { x.fail(`Experiment ${e.id} doesn't exist in Statsig (unknown experiment).`, f.owner, [], { kind: 'experiment', experiment: e.id }); continue; }
      const cells = ['production', 'qa'].map((env) => [env, e.environments[env]]);
      const bad = cells.filter(([, c]) => FAILED.has(c.state));
      if (bad.length) { x.unavailable('Statsig', `experiment ${name}`, bad[0][1].message, oldest(bad.map(([, c]) => c.last_successful_read_at))); continue; }
      for (const [env, c] of cells.filter(([, c]) => c.state === 'running')) {
        x.fail(`Experiment ${name} is still running in ${ENV[env]} (${c.groups.map((g) => `${g.name} ${g.share ?? '?'}%`).join(', ')}).`, f.owner,
          c.link ? [{ label: `experiment ${name} (Statsig)`, link: c.link }] : [], { kind: 'experiment', experiment: e.id, environment: env });
        break; // one line per experiment: production if it runs there, else QA
      }
    }
    if (!reasons.some((r) => r.check === 'experiments') && !unavailable.some((u) => u.check === 'experiments')) {
      x.detail(list.map((e) => `${e.name || e.id}: ${String(e.environments.production.state).replace(/_/g, ' ')}`).join(', ') + '.');
    }
  });

  // 8. Planned changes registered against it.
  check('changes', 'No planned change against it', (x) => {
    const d = status.definitions;
    if (d?.stale) x.unavailable('the shared repo', 'registered changes', d.error?.message, d.synced_at);
    for (const c of changes.filter((c) => c.state === 'planned' && (c.features || [c.feature]).includes(f.id))) {
      x.fail(`Planned change for ${c.planned_for}: ${c.summary}`, c.registered_by,
        [{ label: `registered change ${c.id}`, link: c.evidence_link }, c.link ? { label: 'linked from the change', link: c.link } : null].filter((e) => e && e.link), { kind: 'change', change: c.id });
    }
  });

  // 9. Open alerts (an alert stays open until it is marked resolved).
  check('alerts', 'No open alert against it', (x) => {
    const listOn = alertsSource?.configured;
    if (!listOn) return x.notChecked('No alert list is set up.');
    if (listOn && alertsSource.stale) x.unavailable('the alert list', 'alerts', alertsSource.error, alertsSource.last_successful_read_at);
    for (const a of alerts.filter((a) => (a.features || [a.feature]).includes(f.id) && !isResolved(a))) {
      x.fail(`Open alert (${a.severity || 'warning'}, ${a.kind}, ${when(a.at)}): ${a.message}`, a.by || f.owner,
        [{ label: `alert ${a.id}`, link: `/api/alerts/${encodeURIComponent(a.id)}` }, a.link ? { label: 'alert source', link: a.link } : null].filter(Boolean), { kind: 'alert', alert: a.id });
    }
  });

  // 10. The feature's own conditions (ramp_conditions in its definition).
  for (const rc of status.ramp_conditions || []) {
    check(`condition:${rc.id}`, rc.name, (x) => {
      if (rc.state === 'done') return x.detail(`Done: ${rc.done_when}`);
      if (FAILED.has(rc.state)) return x.unavailable('GitHub', `condition "${rc.name}"`, rc.message, rc.last_successful_read_at);
      x.fail(`Condition "${rc.name}" isn't met: ${rc.done_when.replace(/\.?$/, '.')}${rc.linked_work ? '' : ' No PR or issue is linked yet.'}`, rc.owner, linksOf(rc.evidence), { kind: 'condition', condition: rc.id });
    }, { custom: true });
  }

  const verdict = reasons.length ? 'not_ready' : unavailable.length ? 'cant_tell' : 'ready';
  const notChecked = checks.filter((c) => c.state === 'not_checked');
  const sources = [...new Map(unavailable.map((u) => [u.source, u])).values()];
  const summary = {
    ready: `Ready to ramp: all ${checks.length - notChecked.length} checks passed.${notChecked.length ? ` Not checked: ${notChecked.map((c) => TOPIC[c.id] || c.name).join('; ')}.` : ''}`,
    not_ready: `Not ready to ramp: ${reasons.length} reason${reasons.length === 1 ? '' : 's'}.${unavailable.length ? ` Also couldn't read ${sources.map((u) => u.source).join(', ')}.` : ''}`,
    cant_tell: `Can't tell: ${sources.map((u) => `${u.source} couldn't be read (last read ${when(oldest(unavailable.filter((y) => y.source === u.source).map((y) => y.last_successful_read_at)))})`).join('; ')}.`,
  }[verdict];
  return { verdict, label: RAMP_LABEL[verdict], summary, reasons, unavailable, checks, read_at: status.read_at };
}

function sourceOfLastMile(lm) {
  const failed = (c) => FAILED.has(c.state) || c.state === 'missing_environment';
  const names = [];
  if ((lm.development?.pull_requests || []).some(failed)) names.push('GitHub Actions');
  if ((lm.services || []).some((s) => s.unknown || Object.values(s.environments).some(failed))) names.push('GitHub Deployments');
  if ((lm.flags || []).some((f) => Object.values(f.environments).some(failed))) names.push(flagSource(lm));
  for (const a of lm.apps || []) for (const c of Object.values(a.platforms || {})) if (failed(c) && !names.includes(c.store_name)) names.push(c.store_name);
  return names.join(' and ') || 'GitHub';
}
