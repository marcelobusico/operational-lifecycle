// Turns one feature's live status (lifecycle.feature-status/v1 with last_mile), its registered
// changes and its alerts into numbered statements. Each statement says one thing and carries the
// evidence it came from (PR, issue, GitHub Actions run, deploy record, flag setting, registered
// change, alert, definition file). Answers and digests are made only of these statements, so
// nothing in them can be invented. Freshness statements say which part is out of date and when it
// was last read; they are about the data, not the feature.
import { definitionLink } from '../changes.js';
import { groupsText, assignmentText } from '../lastmile/experiments.js';
import { storeSource } from '../lastmile/state.js';
import { evidenceLabel } from '../evidence.js';

export const STATE_LABEL = {
  done: 'done', flowing: 'flowing', blocked: 'blocked', unavailable: 'status unavailable', not_started: 'not started',
};
const STEP_LABEL = { done: 'done', in_progress: 'in progress', not_started: 'not started', unavailable: 'status unavailable', no_access: 'no access' };
const ENV = { qa: 'QA', production: 'production' };

export function when(iso) {
  if (!iso) return 'never';
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

const evLabel = evidenceLabel;
const stepEvidence = (s) => s.evidence.filter((e) => e.link).map((e) => ({ label: evLabel(e), link: e.link }));
const AT_RISK_DAYS = 14;

function daysUntil(date, now) {
  return Math.ceil((Date.parse(`${date}T23:59:59Z`) - now) / 86400000);
}

// Is the feature at risk of missing its target date? Only when it has one and isn't fully
// available to users yet (or, without last-mile tracking, isn't done).
export function dateRisk(status, { now = Date.now(), days = AT_RISK_DAYS } = {}) {
  const target = status.feature.target_date;
  if (!target) return null;
  const lm = status.last_mile;
  const delivered = lm && lm.state !== 'not_tracked' ? ['fully_on'].includes(lm.state) : status.state === 'done';
  if (delivered) return null;
  const left = daysUntil(target, now);
  if (left > days) return null;
  const blocked = status.state === 'blocked';
  return { target, days_left: left, overdue: left < 0, blocked };
}

// Suggested message to send whoever can unblock it.
function pushMessage(owner, featureName, what) {
  const hi = owner && owner.startsWith('@') ? `Hi ${owner}` : `Hi ${owner || 'team'}`;
  return `${hi}, ${featureName} is waiting on ${what}. Is there an ETA, or anything you need from us to move it?`;
}

// The links and read times of status.sources (src/trace.js), the same ones the browser view shows.
const srcEvidence = (t) => (t ? t.links.map((l) => ({ label: l.label, link: l.url })) : []);
const srcFreshness = (list) => {
  const ts = list.filter(Boolean);
  if (!ts.length) return {};
  const bad = ts.filter((t) => t.unavailable);
  const times = ts.map((t) => t.read_at ?? null);
  return {
    read_at: times.includes(null) ? null : times.sort()[0],
    unavailable_since: bad.map((t) => t.unavailable_since).filter(Boolean).sort()[0] || null,
    ...(ts.every((t) => !t.links.length) ? { no_source_item: ts.map((t) => t.no_source_item).join(' ') } : {}),
  };
};

export function buildFacts({ status, snap, config, now = Date.now() }) {
  const facts = [];
  const sources = status.sources || [];
  const src = (key) => sources.find((t) => t.key === key);
  // A statement backed by status.sources entries: their links, and when they were last read. With
  // no specific item it says so (no_source_item) instead of linking somewhere generic.
  const add = (section, text, evidence = [], extra = {}, from = []) => {
    const fact = { id: `f${facts.length + 1}`, section, text, ...srcFreshness(from), ...extra, evidence: evidence.filter((e) => e && e.link) };
    if (fact.evidence.length) delete fact.no_source_item;
    facts.push(fact);
    return fact;
  };
  const f = status.feature;
  const defEvidence = { label: `definition ${f.file}`, link: definitionLink(config, f.file) };
  const allStepEvidence = status.steps.flatMap(stepEvidence);

  // Overall state, backed by the steps' PRs/issues (or the definition when nothing is linked).
  const stateText = {
    done: 'All steps and dependencies are done.',
    flowing: status.summary,
    blocked: `Blocked by ${[...new Set(status.blockers.map((b) => b.feature_name || b.feature || b.kind.replace(/_/g, ' ')))].join(', ')}.`,
    unavailable: status.summary,
    not_started: status.summary,
  }[status.state] || status.summary;
  const blockerEvidence = status.blockers.flatMap((b) => (b.evidence || []).map((e) => ({ label: e.label, link: e.link })));
  const overallEvidence = status.state === 'blocked' ? [...blockerEvidence, defEvidence] : allStepEvidence.length ? allStepEvidence : [defEvidence];
  const overall = add('overall', `Overall: ${STATE_LABEL[status.state] || status.state}. ${stateText}`, overallEvidence, { state: status.state });

  for (const s of status.steps) {
    // The step's PRs/issues and the GitHub Actions run on each PR, as in the browser view.
    const from = [src(`step:${s.id}`), ...s.evidence.filter((e) => e.type === 'pr').map((e) => src(`actions:${e.repo}#${e.number}`))];
    const ev = [...stepEvidence(s), ...from.slice(1).flatMap(srcEvidence)];
    add('steps', `Step "${s.name}" (${s.owner}): ${STEP_LABEL[s.state] || s.state}${s.linked_work ? '' : ', no linked PR or issue yet'}.`,
      ev.length ? ev : [defEvidence], { step: s.id, current: s.id === status.current_step }, from);
  }

  // Map blockers (dependencies, cycles, unknown ids): who to push and what to send.
  const blockers = [];
  for (const [i, b] of status.blockers.entries()) {
    const from = src(`blocker:${i}`);
    const ev = from ? srcEvidence(from) : (b.evidence || []).map((e) => ({ label: e.label, link: e.link }));
    const what = b.step_name ? `"${b.step_name}" of ${b.feature_name}` : b.feature_name || 'its dependency list being fixed';
    const push = { owner: b.owner || f.owner, message: pushMessage(b.owner || f.owner, f.name, what) };
    blockers.push(add('blockers', `${b.why}. Push: ${push.owner}.`, ev.length ? ev : [defEvidence], { blocker: b.kind, push }, [from]));
  }

  // Last mile: is it available to users, and what keeps it from them.
  const lm = status.last_mile;
  if (lm && lm.state !== 'not_tracked') {
    const evAll = (lm.evidence || []).map((e) => ({ label: e.label, link: e.link }));
    add('last_mile', `Available to users: ${lm.label}. ${lm.summary}`, evAll, { last_mile: lm.state });
    for (const fl of lm.flags || []) {
      for (const env of ['qa', 'production']) {
        const c = fl.environments[env];
        if (fl.unknown) {
          if (env === 'production') add('last_mile', `Flag ${fl.key} doesn't exist in ${lm.flag_platform === 'statsig' ? 'Statsig' : 'the flag console'}, so users can't get it.`, [defEvidence]);
          continue;
        }
        const from = src(`flag:${fl.key}:${env}`);
        const flagEvidence = (t) => srcEvidence(t).map((e) => ({ ...e, label: `${fl.key} in ${ENV[env]} (${lm.flag_platform === 'statsig' ? 'Statsig' : 'flag console'})` }));
        if (!['on', 'off', 'partial'].includes(c.state)) {
          // Never on or off: unavailable, with the last known flag link when there is one.
          add('last_mile', `Status unavailable for flag ${fl.key} in ${ENV[env]}${c.unavailable_since ? ` (source unavailable since ${when(c.unavailable_since)})` : ''}: not shown as on or off.`,
            flagEvidence(from), { flag: fl.key, env, flag_state: c.state }, [from]);
          continue;
        }
        const v = c.state === 'partial' ? `on for ${c.rollout_percentage ?? '?'}% of users` : c.state;
        add('last_mile', `Flag ${fl.key} in ${ENV[env]}: ${v}${c.changed_at ? ` (changed ${when(c.changed_at)}${c.changed_by ? ` by ${c.changed_by}` : ''})` : ''}.`,
          flagEvidence(from), { flag: fl.key, env, flag_state: c.state }, [from]);
      }
    }
    // Experiments: groups, each one's share and what the feature does in it, citing the experiment
    // in Statsig (the same link and read time as the browser's "Experiment" source).
    for (const x of lm.experiments || []) {
      if (x.unknown) {
        add('last_mile', `Experiment ${x.id} doesn't exist in Statsig (unknown experiment): it is listed in the feature definition, but there is nothing to read.`, [defEvidence], { experiment: x.id, experiment_state: 'unknown' }, [src(`experiment:${x.id}:production`)]);
        continue;
      }
      for (const env of ['production', 'qa']) {
        const c = x.environments[env];
        // QA is only said when it differs from production (Statsig keeps one status per experiment).
        if (env === 'qa' && c.state === x.environments.production.state) continue;
        const from = src(`experiment:${x.id}:${env}`);
        const name = x.name || x.id;
        const extra = { experiment: x.id, env, experiment_state: c.state };
        if (['unavailable', 'no_access'].includes(c.state)) {
          add('last_mile', `Status unavailable for experiment ${name} in ${ENV[env]}${c.unavailable_since ? ` (source unavailable since ${when(c.unavailable_since)})` : ''}: not shown as running or not. Last successful read: ${when(c.last_successful_read_at)}.`,
            srcEvidence(from), extra, [from]);
          continue;
        }
        const how = assignmentText(c.assignment);
        const text = {
          running: `Experiment ${name} is running in ${ENV[env]}${c.started_at ? ` (since ${when(c.started_at)})` : ''} with ${c.groups.length} groups: ${groupsText(c.groups)}.${how ? ` How users are assigned: ${how}.` : ''}`,
          not_running: `Experiment ${name} is running in Statsig but not in ${ENV[env]}${c.reason ? `: ${c.reason}` : ''}.`,
          not_started: `Experiment ${name} hasn't started in Statsig yet (status ${c.statsig_status}).`,
          ended: `Experiment ${name} has ended${c.ended_at ? ` (${when(c.ended_at)})` : ''}${c.launched_group ? `; group ${c.launched_group} was shipped` : ''}. Users now get what the flags say.`,
        }[c.state] || `Experiment ${name} in ${ENV[env]}: ${c.state}.`;
        add('last_mile', text, srcEvidence(from), extra, [from]);
      }
    }
    // App stores: per app and platform, the version that first includes it and where it stands in
    // the store (review state, rollout %), citing the store console (the browser's "Store" source).
    for (const a of lm.apps || []) {
      if (a.unknown) { add('last_mile', `App ${a.id} isn't defined (no apps/${a.id}.yaml), so its store release can't be read.`, [defEvidence], { app: a.id, store_state: 'unknown' }); continue; }
      for (const c of Object.values(a.platforms || {})) {
        const from = src(`store:${a.id}:${c.platform}`);
        const extra = { app: a.id, platform: c.platform, store: c.store, store_state: c.state, version: c.version ?? null, rollout_percentage: c.rollout_percentage ?? null };
        const first = c.first_version ? `first ships in ${a.name} ${c.first_version}` : 'has no first app version written';
        if (['unavailable', 'no_access'].includes(c.state)) {
          add('last_mile', `Status unavailable for ${a.name} on ${c.platform_label}: ${c.store_name} couldn't be read${c.unavailable_since ? ` (since ${when(c.unavailable_since)})` : ''}, so it is not shown as released. Last read: ${when(c.last_successful_read_at)}.`,
            srcEvidence(from), extra, [from]);
          continue;
        }
        const text = c.state === 'not_connected' ? `${a.name} on ${c.platform_label}: ${c.store_name} isn't connected to LifeCycle yet, so its release isn't known (not guessed). The feature ${first}.`
          : c.state === 'unknown_app' ? `${a.name} on ${c.platform_label}: ${c.message} (unknown app).`
            : `${a.name} on ${c.platform_label} (${storeSource(c)}): the feature ${first}; ${c.label}${c.state === 'released' && c.rollout_state === 'gradual' && c.phased_day ? ` (day ${c.phased_day} of Apple's 7-day phased release)` : ''}.${c.tag_check?.state === 'ok' ? ` Release tag ${c.tag_check.tag} confirms the version.` : c.tag_check?.message ? ` ${c.tag_check.message}` : ''}`;
        add('last_mile', text, srcEvidence(from).length ? srcEvidence(from) : [defEvidence], extra, [from]);
      }
    }
    for (const w of (lm.warnings || []).filter((w) => w.kind === 'platform_mismatch')) add('last_mile', w.message, evAll.filter((e) => /App Store|Google Play/.test(e.label)), { app: w.app, store_state: 'mismatch' });
    for (const s of lm.services || []) {
      for (const env of ['qa', 'production']) {
        const c = s.environments[env];
        const from = src(`deploy:${s.id}:${env}`);
        if (c.state !== 'ok') {
          add('last_mile', `Deploy status unavailable for ${s.id} in ${ENV[env]}${c.unavailable_since ? ` (source unavailable since ${when(c.unavailable_since)})` : ''}.`,
            srcEvidence(from), { service: s.id, env, version: null }, [from]);
          continue;
        }
        const text = c.deployed
          ? `${s.id} in ${ENV[env]} runs ${c.version || c.ref || c.sha?.slice(0, 7)}${c.deployed_at ? `, deployed ${when(c.deployed_at)}` : ''}${c.contains_feature === false ? ', which does not include this feature yet' : ''}.`
          : `${s.id} has no successful deploy in ${ENV[env]}.`;
        add('last_mile', text, srcEvidence(from), { service: s.id, env, version: c.version || null }, [from]);
      }
    }
    // What keeps finished work from users is a blocker too: who to push and what to send.
    if (['done_not_deployed', 'deployed_flag_off', 'switched_off'].includes(lm.state)) {
      for (const r of lm.reasons || []) {
        if (r.kind !== 'flag' && r.kind !== 'service') continue;
        const svcOwner = r.kind === 'service' ? (snap.services || []).find((x) => x.id === r.service)?.owner : null;
        const owner = svcOwner || f.owner;
        const ev = r.kind === 'flag'
          ? lm.flags.filter((x) => x.key === r.flag).map((x) => ({ label: `${x.key} in ${ENV[r.environment] || r.environment} (${lm.flag_platform === 'statsig' ? 'Statsig' : 'flag console'})`, link: x.environments[r.environment]?.link }))
          : lm.services.filter((x) => x.id === r.service).map((x) => ({ label: `deploy record: ${x.id} in ${ENV[r.environment] || r.environment}`, link: x.environments[r.environment]?.link }));
        const what = r.kind === 'flag' ? `flag ${r.flag} being turned on in ${ENV[r.environment] || r.environment}` : `${r.service} being deployed to ${ENV[r.environment] || r.environment}`;
        const push = { owner, message: pushMessage(owner, f.name, what) };
        blockers.push(add('blockers', `${r.message} It's done but users can't get it. Push: ${owner}.`, ev.length ? ev : evAll, { blocker: `last_mile_${r.kind}`, push }));
      }
    }
    // An app release that keeps it from users (in review, rejected, halted, gradual, not in a version): push the app's owner.
    if (['in_store_review', 'waiting_for_release', 'store_rejected', 'rollout_halted', 'not_in_app_version', 'app_partly_released'].includes(lm.state)) {
      for (const r of (lm.reasons || []).filter((x) => x.kind === 'store')) {
        const a = (lm.apps || []).find((x) => x.id === r.app);
        const owner = a?.owner || f.owner;
        const c = a?.platforms?.[r.platform];
        const ev = c?.link ? [{ label: `${a.name} ${c.platform_label} (${storeSource(c)})`, link: c.link }] : evAll;
        const what = { in_review: `${a?.name} ${r.version} passing ${c?.store_name} review`, rejected: `${a?.name} ${r.version} being resubmitted after its ${c?.store_name} rejection`,
          released: c?.rollout_state === 'halted' ? `the ${a?.name} ${r.version} rollout being resumed in ${c?.store_name}` : `the ${a?.name} ${r.version} rollout reaching 100% in ${c?.store_name}` }[r.state]
          || `${a?.name} ${r.version || c?.first_version || ''} being released in ${c?.store_name}`.replace('  ', ' ');
        const push = { owner, message: pushMessage(owner, f.name, what) };
        blockers.push(add('blockers', `${r.message} Push: ${owner}.`, ev, { blocker: 'last_mile_store', push }));
      }
    }
  } else if (lm && lm.state === 'not_tracked') {
    add('last_mile', 'Availability to users isn\'t tracked: the definition lists no services, apps or flags.', [defEvidence], { last_mile: 'not_tracked' });
  }

  // Ready to ramp? The same `ramp` block the browser shows (src/ramp/verdict.js), one statement per
  // reason and per unreadable source, so the chat answer and the feature page can't disagree.
  const ramp = status.ramp;
  if (ramp) {
    const reasonEv = [...new Map(ramp.reasons.flatMap((r) => r.evidence).map((e) => [e.link, e])).values()];
    add('ramp', ramp.summary, reasonEv.length ? reasonEv : [defEvidence], { ramp_verdict: ramp.verdict });
    for (const r of ramp.reasons) add('ramp', `Not ready: ${r.message} Owner: ${r.owner}.`, r.evidence.length ? r.evidence : [defEvidence], { ramp_reason: r.check, owner: r.owner });
    for (const u of ramp.unavailable) {
      add('ramp', `Can't tell ${u.what}: ${u.source} couldn't be read${u.message ? ` (${u.message.replace(/\.$/, '')})` : ''}. Last successful read: ${when(u.last_successful_read_at)}.`, [defEvidence], { ramp_unavailable: u.source });
    }
    const label = { passed: 'passed', failed: 'failed', unavailable: "can't tell", not_checked: 'not checked' };
    add('ramp', `Checked: ${ramp.checks.map((c) => `${c.name} (${label[c.state]})`).join('; ')}.`, [defEvidence], { ramp_checks: true });
  }

  // Target date.
  const risk = dateRisk(status, { now, days: config.atRiskDays ?? AT_RISK_DAYS });
  if (risk) {
    add('schedule', risk.overdue
      ? `At risk: the target date ${risk.target} has passed (${-risk.days_left} days ago) and it isn't available to users yet.`
      : `At risk of missing its target date ${risk.target}: ${risk.days_left} day${risk.days_left === 1 ? '' : 's'} left and it isn't available to users yet${risk.blocked ? ', and it is blocked' : ''}.`,
    [defEvidence, ...(status.state === 'blocked' ? blockers.flatMap((b) => b.evidence) : [])], { at_risk: risk });
  } else if (f.target_date) {
    add('schedule', `Target date: ${f.target_date}.`, [defEvidence]);
  }
  // The delay warning, worked out from the open steps (linked as in the browser view).
  if (status.delay?.enabled) {
    const from = src('delay');
    add('schedule', status.delay.text, srcEvidence(from), { delay: status.delay.at_risk ? 'at_risk' : 'on_track' }, [from]);
  }

  // Registered changes and alerts for this feature.
  for (const c of (snap.changes || []).filter((x) => (x.features || [x.feature]).includes(f.id))) {
    add('changes', `Registered change (${c.kind}, ${when(c.registered_at)}, by ${c.registered_by}): ${c.state === 'cancelled' ? 'Cancelled: ' : ''}${c.summary}${c.state === 'planned' ? ` (planned for ${c.planned_for})` : ''}`,
      [{ label: `registered change ${c.id}`, link: c.evidence_link }, c.link ? { label: 'linked from the change', link: c.link } : null],
      { change: c.id, at: c.registered_at });
  }
  for (const a of (snap.alerts || []).filter((x) => (x.features || [x.feature]).includes(f.id))) {
    const ch = a.registered_change && (snap.changes || []).find((c) => c.id === a.registered_change);
    add('alerts', `Alert (${a.severity}, ${a.kind}, ${when(a.at)}): ${a.message}`,
      [{ label: `alert ${a.id}`, link: `/api/alerts/${encodeURIComponent(a.id)}` }, a.link ? { label: 'alert source', link: a.link } : null,
        ch ? { label: `registered change ${ch.id}`, link: ch.evidence_link } : null],
      { alert: a.id, at: a.at });
  }

  return { facts, overall, blockers, freshness: freshness(status, snap) };
}

// Which parts of the answer are out of date, and when each was last read successfully.
export function freshness(status, snap) {
  const out = [];
  const d = status.definitions || snap.definitions;
  if (d?.stale) {
    out.push({ source: 'shared repo', text: `Feature definitions and registered changes come from the last sync at ${when(d.synced_at)}: the shared repo couldn't be read (${d.error?.message || 'unreachable'}).`, last_successful_read_at: d.synced_at });
  }
  for (const s of status.steps) {
    if (s.state === 'unavailable' || s.state === 'no_access') {
      out.push({ source: 'github', text: `GitHub data for step "${s.name}" is unavailable: ${s.message || 'it could not be read'} Last successful read: ${when(s.last_successful_read_at)}.`, last_successful_read_at: s.last_successful_read_at });
    }
  }
  const lm = status.last_mile;
  if (lm) {
    const flagCells = (lm.flags || []).flatMap((fl) => ['qa', 'production'].map((env) => ({ fl, env, c: fl.environments[env] })));
    const badFlags = flagCells.filter((x) => ['unavailable', 'no_access'].includes(x.c.state));
    if (badFlags.length) {
      const times = badFlags.map((x) => x.c.last_successful_read_at);
      const last = times.includes(null) ? null : times.sort()[0];
      const names = [...new Set(badFlags.map((x) => x.fl.key))].join(', ');
      out.push({ source: lm.flag_platform || 'flagsmith', text: `Flag data is unavailable (${names}): ${badFlags[0].c.message || 'the flag console could not be read'} Last successful read: ${when(last)}.`, last_successful_read_at: last });
    }
    const badExp = (lm.experiments || []).filter((x) => ['unavailable', 'no_access'].includes(x.environments.production.state));
    if (badExp.length) {
      const times = badExp.map((x) => x.environments.production.last_successful_read_at);
      const last = times.includes(null) ? null : times.sort()[0];
      out.push({ source: 'statsig', text: `Experiment data is unavailable (${badExp.map((x) => x.id).join(', ')}): ${badExp[0].environments.production.message || 'Statsig could not be read'} Last successful read: ${when(last)}.`, last_successful_read_at: last });
    }
    const storeCells = (lm.apps || []).flatMap((a) => Object.values(a.platforms || {}).map((c) => ({ a, c }))).filter((x) => ['unavailable', 'no_access'].includes(x.c.state));
    if (storeCells.length) {
      const times = storeCells.map((x) => x.c.last_successful_read_at);
      const last = times.includes(null) ? null : times.sort()[0];
      out.push({ source: storeCells[0].c.store, text: `App store data is unavailable (${storeCells.map((x) => `${x.a.name} ${x.c.platform_label}`).join(', ')}): ${storeCells[0].c.message || 'the store could not be read'} Last successful read: ${when(last)}.`, last_successful_read_at: last });
    }
    const svcCells = (lm.services || []).flatMap((s) => ['qa', 'production'].map((env) => ({ s, env, c: s.environments[env] })));
    const badSvc = svcCells.filter((x) => ['unavailable', 'no_access'].includes(x.c.state));
    if (badSvc.length) {
      const times = badSvc.map((x) => x.c.last_successful_read_at);
      const last = times.includes(null) ? null : times.sort()[0];
      out.push({ source: 'github-deployments', text: `Deploy data is unavailable (${[...new Set(badSvc.map((x) => x.s.id))].join(', ')}): ${badSvc[0].c.message || 'deploy records could not be read'} Last successful read: ${when(last)}.`, last_successful_read_at: last });
    }
    const badPrs = (lm.development?.pull_requests || []).filter((p) => ['unavailable', 'no_access'].includes(p.state));
    if (badPrs.length && !status.steps.some((s) => s.state === 'unavailable' || s.state === 'no_access')) {
      const times = badPrs.map((p) => p.last_successful_read_at);
      const last = times.includes(null) ? null : times.sort()[0];
      out.push({ source: 'github-actions', text: `GitHub Actions data is unavailable: ${badPrs[0].detail || 'it could not be read'} Last successful read: ${when(last)}.`, last_successful_read_at: last });
    }
  }
  const a = snap.alerts_source;
  if (a?.configured && a.stale) {
    out.push({ source: 'alerts', text: `The alert list is out of date: ${a.error} Last successful read: ${when(a.last_successful_read_at)}.`, last_successful_read_at: a.last_successful_read_at });
  } else if (a && !a.configured) {
    out.push({ source: 'alerts', text: 'No alert list is set up (alerts.source in ~/.lifecycle/config.json), so alerts aren\'t included.', last_successful_read_at: null, info: true });
  }
  return out;
}
