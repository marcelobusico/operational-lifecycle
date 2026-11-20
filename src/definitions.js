// Project and feature definitions: read from the shared repo (or a local folder), cached for when
// the repo can't be reached, and validated file by file so one broken file never hides the others.
import path from 'node:path';
import { parse } from 'yaml';
import { looksLikeToken } from './log.js';
import { sourceTypes } from './sources/index.js';
import { validateChangeDoc } from './changes.js';
import { parseFlagSnapshot } from './lastmile/flag-snapshots.js';
import { parseTeam } from './team.js';
import { parseJiraSnapshot } from './sources/jira-snapshots.js';

const ID = /^[a-z0-9][a-z0-9-]*$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// The app stores LifeCycle knows how to name. Which ones it can read is src/stores/index.js's business.
export const STORES = ['app_store', 'google_play'];
export const JIRA_KEY = /^[A-Z][A-Z0-9_]{0,29}-[1-9]\d{0,9}$/;
export const PLATFORMS = ['ios', 'android'];
const VERSION = /^\d+(\.\d+){0,3}$/;
// Reading the files (pinned to one commit) lives in src/data-source.js.
export { fetchDefinitionFiles } from './data-source.js';

// Parses and validates every file. Returns { features, projects, services, teams, changes,
// invalid: [{ file, field, message }], invalidIds } where invalidIds are the ids of features whose
// file failed validation. An invalid file is never active work: it only shows as a problem.
export function parseDefinitions(files) {
  const features = [];
  const changes = [];
  const projects = [];
  const services = [];
  const teams = [];
  const apps = [];
  const invalid = [];
  const seenServices = new Map();
  const seenApps = new Map();
  // Team-wide settings (src/team.js): the first team.yaml/team.yml found wins.
  let team = {};
  const teamFile = files.find((f) => /^team\.ya?ml$/.test(f.path));
  if (teamFile) {
    const r = parseTeam(teamFile.text, teamFile.path);
    team = r.team;
    invalid.push(...r.errors);
  }
  for (const file of files.filter((f) => f.path.startsWith('services/'))) {
    const result = validateService(file.path, file.text);
    if (result.errors.length) {
      invalid.push(...result.errors);
      continue;
    }
    const svc = result.service;
    if (seenServices.has(svc.id)) {
      invalid.push({ file: file.path, field: 'id', message: `"${svc.id}" is already defined in ${seenServices.get(svc.id)}` });
      continue;
    }
    seenServices.set(svc.id, file.path);
    services.push(svc);
  }
  // Teams (teams/<id>.yaml): the official list of teams and what each owns. Ids, names and aliases
  // are what features, steps and services point to, so none may be used by two teams.
  const teamKeys = new Map(); // id / name / alias → team id
  for (const file of files.filter((f) => f.path.startsWith('teams/'))) {
    const result = validateTeamDefinition(file.path, file.text);
    if (result.errors.length) {
      invalid.push(...result.errors);
      continue;
    }
    const t = result.team;
    const clash = [['id', t.id], ['name', t.name], ...t.aliases.map((a) => ['aliases', a])].find(([, k]) => teamKeys.has(k) && teamKeys.get(k) !== t.id);
    if (clash) {
      invalid.push({ file: file.path, field: clash[0], message: `"${clash[1]}" is already used by team "${teamKeys.get(clash[1])}"; a team id, name or alias must point to one team only` });
      continue;
    }
    for (const k of [t.id, t.name, ...t.aliases]) teamKeys.set(k, t.id);
    teams.push(t);
  }
  for (const file of files.filter((f) => f.path.startsWith('apps/'))) {
    const result = validateApp(file.path, file.text);
    if (result.errors.length) {
      invalid.push(...result.errors);
      continue;
    }
    if (seenApps.has(result.app.id)) {
      invalid.push({ file: file.path, field: 'id', message: `"${result.app.id}" is already defined in ${seenApps.get(result.app.id)}` });
      continue;
    }
    seenApps.set(result.app.id, file.path);
    apps.push(result.app);
  }
  // Store snapshots: written by LifeCycle (src/stores/snapshots.js), not by people. A broken one is skipped.
  const storeSnapshots = files.filter((f) => f.path.startsWith('store-snapshots/')).map((f) => parseSnapshot(f.text)).filter(Boolean);
  // Flag snapshots: written by LifeCycle (src/lastmile/flag-snapshots.js), the same way.
  const flagSnapshots = files.filter((f) => f.path.startsWith('flag-snapshots/')).map((f) => parseFlagSnapshot(f.text)).filter(Boolean);
  // Jira snapshots: written by LifeCycle (src/sources/jira-snapshots.js), the same way.
  const jiraSnapshots = files.filter((f) => f.path.startsWith('jira-snapshots/')).map((f) => parseJiraSnapshot(f.text)).filter(Boolean);
  const invalidIds = new Set();
  const seen = new Map();
  const seenProjects = new Map();
  for (const file of files.filter((f) => f.path.startsWith('projects/'))) {
    const result = validateProject(file.path, file.text);
    if (result.errors.length) {
      invalid.push(...result.errors);
      continue;
    }
    const p = result.project;
    if (seenProjects.has(p.id)) {
      invalid.push({ file: file.path, field: 'id', message: `"${p.id}" is already defined in ${seenProjects.get(p.id)}` });
      continue;
    }
    seenProjects.set(p.id, file.path);
    projects.push(p);
  }
  for (const file of files.filter((f) => f.path.startsWith('features/'))) {
    const result = validateDefinition(file.path, file.text);
    if (result.errors.length) {
      invalid.push(...result.errors);
      invalidIds.add(path.basename(file.path).replace(/\.ya?ml$/, ''));
      continue;
    }
    const f = result.feature;
    if (seen.has(f.id)) {
      invalid.push({ file: file.path, field: 'id', message: `"${f.id}" is already defined in ${seen.get(f.id)}` });
      continue;
    }
    seen.set(f.id, file.path);
    features.push(f);
  }
  // Registered changes: one file each under changes/. A change naming a feature that isn't
  // defined is kept (the feature may be invalid right now) and simply never matches an answer.
  const seenChanges = new Set();
  for (const file of files.filter((f) => f.path.startsWith('changes/'))) {
    const result = validateChange(file.path, file.text);
    if (result.errors.length) {
      invalid.push(...result.errors);
      continue;
    }
    if (seenChanges.has(result.change.id)) {
      invalid.push({ file: file.path, field: 'id', message: `"${result.change.id}" is already used by another change` });
      continue;
    }
    seenChanges.add(result.change.id);
    changes.push(result.change);
  }
  changes.sort((a, b) => a.registered_at.localeCompare(b.registered_at));
  return { features, projects, services, teams, apps, storeSnapshots, flagSnapshots, jiraSnapshots, changes, team, invalid, invalidIds };
}

export function validateChange(file, text) {
  return validateChangeDoc(readDoc(file, text, 'registered change'), file);
}

// Parses YAML and returns the mapping plus field helpers that record errors with the field name.
function readDoc(file, text, kind) {
  const errors = [];
  const fail = (field, message) => errors.push({ file, field, message });
  let doc;
  try {
    doc = parse(text);
  } catch (err) {
    const first = err.message.split('\n')[0].replace(/:$/, '');
    const hint = /reserved character [@`]/.test(first) ? ' (put values that start with @ in quotes, e.g. owner: "@handle")' : '';
    fail('(file)', `not valid YAML: ${first}${hint}`);
    return { errors };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    fail('(file)', `must be a YAML mapping with the ${kind} fields`);
    return { errors };
  }

  scanForTokens(doc, '', fail);

  const str = (obj, key, field, required = true) => {
    const v = obj[key];
    if (v === undefined || v === null || v === '') {
      if (required) fail(field, 'is required');
      return undefined;
    }
    if (typeof v !== 'string' && typeof v !== 'number') return fail(field, 'must be text');
    return String(v).trim();
  };
  const list = (key) => {
    const v = doc[key];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
      fail(key, 'must be a list of text values');
      return [];
    }
    return v;
  };
  const idField = (key, field, required) => {
    const v = str(doc, key, field, required);
    if (v !== undefined && !ID.test(v)) fail(field, 'must use lowercase letters, digits and dashes');
    return v;
  };

  const id = idField('id', 'id', true);
  const expected = path.basename(file).replace(/\.ya?ml$/, '');
  if (id !== undefined && ID.test(id) && id !== expected) fail('id', `"${id}" must match the file name "${expected}"`);
  return { doc, errors, fail, str, list, idField, id };
}

export function validateProject(file, text) {
  const r = readDoc(file, text, 'project');
  if (!r.doc) return { errors: r.errors };
  const name = r.str(r.doc, 'name', 'name');
  const owner = r.str(r.doc, 'owner', 'owner', false) || null;
  const description = r.str(r.doc, 'description', 'description', false) || null;
  // Optional: when the project as a whole is due. Without it, LifeCycle shows its latest feature's target date.
  let targetDate = r.doc.target_date ?? null;
  if (targetDate instanceof Date) targetDate = targetDate.toISOString().slice(0, 10);
  if (targetDate !== null && (typeof targetDate !== 'string' || !DATE.test(targetDate) || isNaN(Date.parse(targetDate)))) {
    r.fail('target_date', 'must be a date as YYYY-MM-DD');
  }
  if (r.errors.length) return { errors: r.errors };
  return { errors: [], project: { id: r.id, name, owner, description, target_date: targetDate, file } };
}

// A service a feature can touch: which repo deploys it, and the names of its GitHub deployment
// environments for QA and production (defaults: "qa" and "production").
export function validateService(file, text) {
  const r = readDoc(file, text, 'service');
  if (!r.doc) return { errors: r.errors };
  const name = r.str(r.doc, 'name', 'name', false) || r.id;
  const owner = r.str(r.doc, 'owner', 'owner', false) || null;
  const repo = r.str(r.doc, 'repo', 'repo');
  if (repo && !REPO.test(repo)) r.fail('repo', 'must be owner/name');
  const environments = { qa: 'qa', production: 'production' };
  const envs = r.doc.environments;
  if (envs !== undefined && envs !== null) {
    if (typeof envs !== 'object' || Array.isArray(envs)) r.fail('environments', 'must be a mapping with qa and/or production');
    else {
      for (const key of Object.keys(envs)) {
        if (!(key in environments)) r.fail(`environments.${key}`, 'only qa and production are supported');
      }
      for (const key of Object.keys(environments)) {
        const v = r.str(envs, key, `environments.${key}`, false);
        if (v) environments[key] = v;
      }
    }
  }
  if (r.errors.length) return { errors: r.errors };
  return { errors: [], service: { id: r.id, name, owner, repo, environments, file } };
}

// A team (teams/<id>.yaml): a fixed id, the name people chose, and what it owns. Team files hold
// teams only: never a person's name, email, GitHub handle or a credential, so only the fields below
// are accepted and any value that looks like an email or an @handle is refused, naming the field.
//   id: wishlist
//   name: Wishlist
//   description: Wishlists and saved books.
//   aliases: [Wishlist team]          # other spellings already used in features (exact match)
//   owns:
//     repos: [acme-org/acme-wishlist]
//     tickets:
//       - repo: acme-org/acme-wishlist   # every issue in that repo
//       - label: wishlist                           # issues with this label (optionally `repo:` too)
//     services: [wishlist-api]
//     apps: [acme-ios]
//     flags: [redeem_rewards]
export const TEAM_FIELDS = ['id', 'name', 'description', 'aliases', 'owns'];
export const TEAM_OWNS = ['repos', 'tickets', 'services', 'apps', 'flags'];
const EMAIL = /[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/i;
const HANDLE = /(^|\s)@[a-z0-9][a-z0-9-]*/i;
const NO_PEOPLE = 'team files never hold people\'s names, emails or credentials';

export function validateTeamDefinition(file, text) {
  const r = readDoc(file, text, 'team');
  if (!r.doc) return { errors: r.errors };
  const { doc, fail, str } = r;
  // People data first: refuse it by field, whatever the field is called.
  const scanPeople = (value, at) => {
    if (typeof value === 'string') {
      if (EMAIL.test(value)) fail(at, `looks like an email address; ${NO_PEOPLE}`);
      else if (HANDLE.test(value)) fail(at, `looks like a person's GitHub handle; ${NO_PEOPLE}`);
    } else if (Array.isArray(value)) value.forEach((v, i) => scanPeople(v, `${at}[${i}]`));
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) scanPeople(v, `${at}.${k}`);
  };
  for (const [k, v] of Object.entries(doc)) {
    if (!TEAM_FIELDS.includes(k)) fail(k, `is not a team field (only ${TEAM_FIELDS.join(', ')}); ${NO_PEOPLE}`);
    scanPeople(v, k);
  }
  const name = str(doc, 'name', 'name');
  const description = str(doc, 'description', 'description', false) || null;
  const textList = (obj, key, at) => {
    const v = obj?.[key];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim())) return fail(at, 'must be a list of text values'), [];
    return [...new Set(v.map((x) => x.trim()))];
  };
  const aliases = textList(doc, 'aliases', 'aliases').filter((a) => a !== name && a !== r.id);
  const owns = { repos: [], tickets: [], services: [], apps: [], flags: [] };
  const o = doc.owns;
  if (o !== undefined && o !== null) {
    if (typeof o !== 'object' || Array.isArray(o)) fail('owns', `must be a mapping with any of: ${TEAM_OWNS.join(', ')}`);
    else {
      for (const k of Object.keys(o)) if (!TEAM_OWNS.includes(k)) fail(`owns.${k}`, `is not something a team owns here (only ${TEAM_OWNS.join(', ')})`);
      owns.repos = textList(o, 'repos', 'owns.repos');
      owns.repos.forEach((x, i) => { if (!REPO.test(x)) fail(`owns.repos[${i}]`, 'must be owner/name'); });
      owns.services = textList(o, 'services', 'owns.services');
      owns.services.forEach((x, i) => { if (!ID.test(x)) fail(`owns.services[${i}]`, 'must be a service id (lowercase letters, digits and dashes)'); });
      owns.apps = textList(o, 'apps', 'owns.apps');
      owns.flags = textList(o, 'flags', 'owns.flags');
      // A ticket source: a whole repo's issues ({ repo }) or a label ({ label }, optionally in one repo).
      const t = o.tickets;
      if (t !== undefined && t !== null) {
        if (!Array.isArray(t)) fail('owns.tickets', 'must be a list of ticket sources ({ repo: owner/name } or { label: name })');
        else t.forEach((x, i) => {
          const at = `owns.tickets[${i}]`;
          if (!x || typeof x !== 'object' || Array.isArray(x)) return fail(at, 'must be { repo: owner/name } (all its issues) or { label: name } (issues with that label)');
          for (const k of Object.keys(x)) if (!['repo', 'label'].includes(k)) fail(`${at}.${k}`, 'is not a ticket source field (only repo and label)');
          const repo = str(x, 'repo', `${at}.repo`, false) || null;
          const label = str(x, 'label', `${at}.label`, false) || null;
          if (!repo && !label) return fail(at, 'needs a repo (all its issues) or a label');
          if (repo && !REPO.test(repo)) fail(`${at}.repo`, 'must be owner/name');
          if (!owns.tickets.some((y) => y.repo === repo && y.label === label)) owns.tickets.push({ repo, label });
        });
      }
    }
  }
  if (r.errors.length) return { errors: r.errors };
  return { errors: [], team: { id: r.id, name, description, aliases, owns, file } };
}

// A mobile app a feature can ship in: the repo it's built from (release tags), its platforms and
// where each is published (store + the store's own identifier for it), and optionally its owner team.
//   id: acme-mobile
//   name: Acme
//   owner: Mobile team            # optional
//   repo: owner/acme-mobile
//   release_tag: "v{version}"     # optional; how release tags are named (default v{version} or {version})
//   platforms:
//     ios: { store: app_store, store_id: "1234567890" }      # App Store Connect Apple ID of the app
//     android: { store: google_play, store_id: com.acme.app }  # Google Play package name
export function validateApp(file, text) {
  const r = readDoc(file, text, 'app');
  if (!r.doc) return { errors: r.errors };
  const name = r.str(r.doc, 'name', 'name');
  const owner = r.str(r.doc, 'owner', 'owner', false) || null;
  const repo = r.str(r.doc, 'repo', 'repo');
  if (repo && !REPO.test(repo)) r.fail('repo', 'must be owner/name');
  const releaseTag = r.str(r.doc, 'release_tag', 'release_tag', false) || null;
  if (releaseTag && !releaseTag.includes('{version}')) r.fail('release_tag', 'must contain {version}, e.g. "v{version}"');
  const platforms = {};
  const p = r.doc.platforms;
  if (!p || typeof p !== 'object' || Array.isArray(p)) r.fail('platforms', `is required: a mapping with ${PLATFORMS.join(' and/or ')}`);
  else {
    for (const key of Object.keys(p)) {
      if (!PLATFORMS.includes(key)) { r.fail(`platforms.${key}`, `only ${PLATFORMS.join(' and ')} are supported`); continue; }
      const v = p[key];
      if (!v || typeof v !== 'object' || Array.isArray(v)) { r.fail(`platforms.${key}`, 'must be a mapping with store and store_id'); continue; }
      const store = r.str(v, 'store', `platforms.${key}.store`);
      if (store && !STORES.includes(store)) r.fail(`platforms.${key}.store`, `must be one of: ${STORES.join(', ')}`);
      const storeId = r.str(v, 'store_id', `platforms.${key}.store_id`);
      platforms[key] = { store, store_id: storeId };
    }
    if (!Object.keys(p).length) r.fail('platforms', `must list at least one of ${PLATFORMS.join(', ')}`);
  }
  // Optional: a Slack channel where releases are announced (src/stores/slack-releases.js), with a
  // hint for reading it ("iOS messages say 'App Store'"). Used when the store itself can't be read.
  let releaseChannel = null;
  const rc = r.doc.release_channel;
  if (rc !== undefined && rc !== null) {
    if (typeof rc !== 'object' || Array.isArray(rc)) r.fail('release_channel', 'must be a mapping with slack (a channel like "#mobile-releases" or its id)');
    else {
      const slack = r.str(rc, 'slack', 'release_channel.slack');
      if (slack && !/^(#[a-z0-9][a-z0-9._-]{0,79}|[CG][A-Z0-9]{6,})$/.test(slack)) r.fail('release_channel.slack', 'must be a channel name like "#mobile-releases" or a channel id like C0123ABCD');
      const hint = rc.hint === undefined || rc.hint === null ? null : String(rc.hint).trim();
      if (hint && hint.length > 500) r.fail('release_channel.hint', 'must be at most 500 characters');
      releaseChannel = { slack, hint: hint || null };
    }
  }
  if (r.errors.length) return { errors: r.errors };
  return { errors: [], app: { id: r.id, name, owner, repo, releaseTag, platforms, releaseChannel, file } };
}

// A committed store snapshot (store-snapshots/<app>-<platform>.yaml). null when unreadable.
function parseSnapshot(text) {
  try {
    const d = parse(text);
    if (!d || typeof d !== 'object' || !d.app || !d.platform || !d.read_at) return null;
    return { ...d, read_at: d.read_at instanceof Date ? d.read_at.toISOString() : String(d.read_at) };
  } catch {
    return null;
  }
}

export function validateDefinition(file, text) {
  const r = readDoc(file, text, 'feature');
  if (!r.doc) return { errors: r.errors };
  const { doc, errors, fail, str, list, id } = r;
  const name = str(doc, 'name', 'name');
  const owner = str(doc, 'owner', 'owner');
  // Optional free text: what the feature delivers, in a line or two.
  const description = str(doc, 'description', 'description', false) || null;
  const project = r.idField('project', 'project', false) || null;
  let targetDate = doc.target_date ?? null;
  if (targetDate instanceof Date) targetDate = targetDate.toISOString().slice(0, 10);
  if (targetDate !== null && (typeof targetDate !== 'string' || !DATE.test(targetDate) || isNaN(Date.parse(targetDate)))) {
    fail('target_date', 'must be a date as YYYY-MM-DD');
  }
  const dependsOn = list('depends_on');
  if (id && dependsOn.includes(id)) fail('depends_on', 'a feature cannot depend on itself');
  const services = list('services');
  const flags = list('flags');
  const experiments = readExperiments(doc, fail, str);
  const apps = readApps(doc, fail, str);

  // Steps, and the feature's own ramp conditions (same shape: a condition is met when its linked
  // PRs/issues are done, exactly like a step).
  const readSteps = (key, required) => {
    const out = [];
    const v = doc[key];
    if (v === undefined || v === null) {
      if (required) fail(key, 'is required (use [] if there are no steps yet)');
      return out;
    }
    if (!Array.isArray(v)) return fail(key, 'must be a list'), out;
    const ids = new Set();
    v.forEach((s, i) => {
      const at = `${key}[${i}]`;
      if (!s || typeof s !== 'object' || Array.isArray(s)) return fail(at, 'must be a mapping');
      const stepId = str(s, 'id', `${at}.id`);
      if (stepId && ids.has(stepId)) fail(`${at}.id`, `"${stepId}" is used by another ${key === 'steps' ? 'step' : 'condition'}`);
      ids.add(stepId);
      const step = {
        id: stepId,
        name: str(s, 'name', `${at}.name`),
        owner: str(s, 'owner', `${at}.owner`),
        // The team doing this step, as named in our definitions (teams/). Optional.
        team: str(s, 'team', `${at}.team`, false) || null,
        doneWhen: str(s, 'done_when', `${at}.done_when`),
        evidence: [],
      };
      if (s.evidence !== undefined && s.evidence !== null) {
        if (!Array.isArray(s.evidence)) fail(`${at}.evidence`, 'must be a list');
        else s.evidence.forEach((e, j) => {
          const eat = `${at}.evidence[${j}]`;
          if (!e || typeof e !== 'object') return fail(eat, 'must be a mapping');
          const source = str(e, 'source', `${eat}.source`);
          const types = sourceTypes(source);
          if (source && !types) return fail(`${eat}.source`, `"${source}" is not a supported source`);
          const type = str(e, 'type', `${eat}.type`);
          if (type && types && !types.includes(type)) fail(`${eat}.type`, `must be one of: ${types.join(', ')}`);
          // A Jira ticket: { source: jira, type: ticket, key: ABC-123 }.
          if (source === 'jira') {
            const key = str(e, 'key', `${eat}.key`);
            if (key && !JIRA_KEY.test(key)) return fail(`${eat}.key`, 'must be a Jira ticket key like ABC-123');
            if (key) step.evidence.push({ source, type, key });
            return;
          }
          const repo = str(e, 'repo', `${eat}.repo`);
          if (repo && !REPO.test(repo)) fail(`${eat}.repo`, 'must be owner/name');
          if (e.number === undefined || e.number === null) fail(`${eat}.number`, 'is required');
          else if (!Number.isInteger(e.number) || e.number < 1) fail(`${eat}.number`, 'must be a positive whole number');
          step.evidence.push({ source, type, repo, number: e.number });
        });
      }
      out.push(step);
    });
    return out;
  };
  const steps = readSteps('steps', true);
  // Optional: conditions this feature must meet before it is ramped (e.g. "QA sign-off").
  const rampConditions = readSteps('ramp_conditions', false);


  if (errors.length) return { errors, project };
  return { errors, feature: { id, name, owner, description, project, targetDate, dependsOn, services, flags, experiments, apps, steps, rampConditions, file } };
}

// The experiments a feature takes part in (Statsig experiment ids), each with what the feature does
// in each group, written by the team: the definition is where that behavior lives, so
// LifeCycle shows what the team described instead of inferring it. Group names match Statsig's
// group names (case and spacing don't matter). A bare id is allowed: groups then show Statsig's own
// group descriptions, marked as coming from Statsig.
//   experiments:
//     - id: redeem_rewards_test
//       groups:
//         Control: No rewards option in the reader
//         Rewards: Can redeem rewards in the reader
function readExperiments(doc, fail, str) {
  const v = doc.experiments;
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return fail('experiments', 'must be a list of experiments (id, and what the feature does in each group)'), [];
  const out = [];
  v.forEach((x, i) => {
    const at = `experiments[${i}]`;
    if (typeof x === 'string') {
      if (!x.trim()) return fail(at, 'must be an experiment id');
      return out.push({ id: x.trim(), groups: {} });
    }
    if (!x || typeof x !== 'object' || Array.isArray(x)) return fail(at, 'must be an experiment id or a mapping with id and groups');
    for (const k of Object.keys(x)) if (!['id', 'groups'].includes(k)) fail(`${at}.${k}`, 'is not an experiment field (only id and groups)');
    const id = str(x, 'id', `${at}.id`);
    const groups = {};
    if (x.groups !== undefined && x.groups !== null) {
      if (typeof x.groups !== 'object' || Array.isArray(x.groups)) fail(`${at}.groups`, 'must map each group name to what the feature does in it');
      else for (const [name, text] of Object.entries(x.groups)) {
        if (typeof text !== 'string' || !text.trim()) fail(`${at}.groups.${name}`, 'must say what the feature does in this group');
        else groups[name] = text.trim();
      }
    }
    if (id && out.some((e) => e.id === id)) fail(`${at}.id`, `"${id}" is listed twice`);
    else if (id) out.push({ id, groups });
  });
  return out;
}

// The apps a feature ships in, each with the app version that first includes it, per platform
// (checked against the app repo's release tags). A bare id means the version isn't written yet.
//   apps:
//     - id: acme-mobile
//       first_version: { ios: 3.4.0, android: 3.4.0 }
function readApps(doc, fail, str) {
  const v = doc.apps;
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return fail('apps', 'must be a list of apps (id, and first_version per platform)'), [];
  const out = [];
  v.forEach((x, i) => {
    const at = `apps[${i}]`;
    if (typeof x === 'string') {
      if (!x.trim()) return fail(at, 'must be an app id');
      if (out.some((a) => a.id === x.trim())) return fail(at, `"${x.trim()}" is listed twice`);
      return out.push({ id: x.trim(), firstVersion: {} });
    }
    if (!x || typeof x !== 'object' || Array.isArray(x)) return fail(at, 'must be an app id or a mapping with id and first_version');
    for (const k of Object.keys(x)) if (!['id', 'first_version'].includes(k)) fail(`${at}.${k}`, 'is not an app field (only id and first_version)');
    const id = str(x, 'id', `${at}.id`);
    if (id && !ID.test(id)) fail(`${at}.id`, 'must use lowercase letters, digits and dashes');
    const firstVersion = {};
    const fv = x.first_version;
    if (fv !== undefined && fv !== null) {
      if (typeof fv !== 'object' || Array.isArray(fv)) fail(`${at}.first_version`, `must map ${PLATFORMS.join('/')} to a version, e.g. { ios: 3.4.0 }`);
      else for (const [plat, ver] of Object.entries(fv)) {
        if (!PLATFORMS.includes(plat)) { fail(`${at}.first_version.${plat}`, `only ${PLATFORMS.join(' and ')} are supported`); continue; }
        const s = ver === null || ver === undefined ? '' : String(ver).trim();
        if (!VERSION.test(s)) fail(`${at}.first_version.${plat}`, 'must be a version like 3.4.0 (quote it if it looks like a number, e.g. "3.4")');
        else firstVersion[plat] = s;
      }
    }
    if (id && out.some((a) => a.id === id)) fail(`${at}.id`, `"${id}" is listed twice`);
    else if (id) out.push({ id, firstVersion });
  });
  return out;
}

function scanForTokens(value, at, fail) {
  if (typeof value === 'string') {
    if (looksLikeToken(value)) fail(at || '(file)', 'looks like a token or credential; never put credentials in the shared repo');
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => scanForTokens(v, `${at}[${i}]`, fail));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) scanForTokens(v, at ? `${at}.${k}` : k, fail);
  }
}
