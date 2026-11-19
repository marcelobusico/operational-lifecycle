// Local web server: the browser UI plus the status API. Listens on 127.0.0.1 only, because
// it reads with the person's own credentials.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { appUrl, markNoticeSeen, loadConfig, withToolPath } from './config.js';
import { redact } from './log.js';
import { createAskService } from './ask/service.js';
import { personalView, markSeen, SOURCES } from './alerts/inbox.js';
import { listOutbox } from './alerts/publish.js';
import { buildFeatureFile, toDraft, dependentsOf } from './features/edit.js';
import { reviewDefinition } from './features/review.js';
import { textHash, listFeatureOutbox } from './features/publish.js';
import { checkForUpdate } from './update/check.js';
import { createUpdater } from './update/upgrade.js';
import { installInfo } from './update/install.js';
import { publishProject, deleteProject, updateProject } from './projects/create.js';
import { createAppDefinition, updateAppDefinition, deleteAppDefinition } from './apps/edit.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body, null, 2));
}

// Reads a small JSON body. Writes only come from LifeCycle's own page: the body must be JSON (so a
// cross-site form can't post) and a browser Origin, when sent, must be this server.
async function readBody(req) {
  const type = req.headers['content-type'] || '';
  if (!type.startsWith('application/json')) throw Object.assign(new Error('send JSON (content-type: application/json)'), { status: 415 });
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) throw Object.assign(new Error('cross-origin requests are not allowed'), { status: 403 });
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100000) throw Object.assign(new Error('request too large'), { status: 413 });
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw Object.assign(new Error('the body is not valid JSON'), { status: 400 });
  }
}

// Upgrades replace the app's code, so they are held to more than readBody(): the request must come
// from LifeCycle's own page (a browser Origin naming this server) at a this-Mac address (so a site
// whose name points at 127.0.0.1 can't post either). Other machines can't connect at all (127.0.0.1).
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\]|([a-z0-9-]+\.)*localhost)(:\d+)?$/i;
function requireOwnPage(req) {
  const host = req.headers.host || '';
  let origin = null;
  try { origin = new URL(req.headers.origin).host; } catch { /* missing or not a URL */ }
  if (!LOCAL_HOST.test(host) || origin !== host) {
    throw Object.assign(new Error("updates can only be started from LifeCycle's own page on this Mac"), { status: 403 });
  }
}

export function createUpdateService(options = {}) {
  const updater = createUpdater(options);
  return {
    version: () => installInfo(options),
    check: () => checkForUpdate(options),
    start: () => updater.start(),
    progress: () => updater.progress(),
  };
}

const LOCAL_DEFINITION =/^(features|projects|services|teams|changes)\/[a-z0-9][a-z0-9-]*\.ya?ml$/;

export function createServer(app = createApp(), ask = createAskService({ app }), update = createUpdateService()) {
  // AI product reviews by definition text, so "Review changes" then "Publish" asks the AI once.
  const reviews = new Map();
  async function review(built, defs) {
    const key = textHash(built.text);
    if (reviews.has(key)) return reviews.get(key);
    const r = await reviewDefinition({ provider: ask.currentProvider(), text: built.text, feature: built.feature, features: defs.featureDefs });
    if (r.ran) {
      if (reviews.size > 50) reviews.delete(reviews.keys().next().value);
      reviews.set(key, r);
    }
    return r;
  }
  const TEAM_STATUS = { published: 200, not_published: 202, conflict: 409, needs_decision: 409, confirm_unowned: 409, invalid: 400, not_found: 404, read_only: 403 };
  const FEATURE_STATUS = { published: 200, queued: 202, not_published: 202, conflict: 409, has_dependents: 409, invalid: 400, not_found: 404, read_only: 403 };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      // Only requests addressed to this Mac by a local name. A page on another site whose name was
      // pointed at 127.0.0.1 (DNS rebinding) sends its own name as Host and is refused here.
      if (!LOCAL_HOST.test(req.headers.host || '')) return send(res, 403, { error: 'LifeCycle only answers on 127.0.0.1 or localhost' });
      // Check for updates / upgrade from the app (src/update/).
      if (url.pathname === '/api/update/version' && req.method === 'GET') return send(res, 200, update.version());
      if (url.pathname === '/api/update' && req.method === 'GET') return send(res, 200, await update.check());
      if (url.pathname === '/api/update/progress' && req.method === 'GET') return send(res, 200, update.progress());
      if (url.pathname === '/api/update/upgrade' && req.method === 'POST') {
        requireOwnPage(req);
        await readBody(req);
        const r = update.start();
        return send(res, r.status, r.body);
      }
      // Ask & digest: answers and digests are produced here, on this machine, and stay here.
      if (req.method === 'POST' && url.pathname === '/api/ask') {
        const body = await readBody(req);
        if (typeof body.question !== 'string' || !body.question.trim()) return send(res, 400, { error: 'question is required' });
        // session: this page's conversation, so follow-up answers and "yes" reach the right pending change.
        const session = typeof body.session === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(body.session) ? body.session : null;
        return send(res, 200, await ask.ask(body.question.slice(0, 2000), { via: 'app', session }));
      }
      // A change the chat proposed: confirm (with the delete choices) or cancel. Nothing is saved before.
      const acm = url.pathname.match(/^\/api\/ask\/actions\/([a-f0-9]+)\/(confirm|cancel)$/);
      if (req.method === 'POST' && acm) {
        const body = await readBody(req);
        const r = acm[2] === 'cancel' ? ask.cancelAction(acm[1]) : await ask.confirmAction(acm[1], { handover_to: typeof body.handover_to === 'string' ? body.handover_to : null,
          leave_unowned: body.leave_unowned === true, confirm_unowned: body.confirm_unowned === true });
        return send(res, r.outcome === 'cancelled' ? 200 : TEAM_STATUS[r.outcome] || 200, r);
      }
      if (req.method === 'POST' && url.pathname === '/api/digest') {
        await readBody(req);
        return send(res, 200, await ask.digest({ via: 'app' }));
      }
      // One-time notices (e.g. the flag platform moved to the team default): "Got it" hides it for good.
      const nm = url.pathname.match(/^\/api\/notices\/([\w-]+)\/seen$/);
      if (req.method === 'POST' && nm) {
        await readBody(req);
        return send(res, markNoticeSeen(nm[1]) ? 200 : 404, { id: nm[1], seen: true });
      }
      // Alerts and registered changes (docs/alerts-format.md).
      if (req.method === 'POST' && url.pathname === '/api/alerts/seen') {
        const body = await readBody(req);
        const snap = await app.refresh();
        const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string') : [];
        return send(res, 200, { seen: markSeen(ids, snap.alert_list) });
      }
      if (req.method === 'POST' && url.pathname === '/api/changes/preview') {
        const body = await readBody(req);
        const defs = await app.definitionsNow();
        const ids = Array.isArray(body.features) ? body.features.filter((x) => typeof x === 'string') : [];
        return send(res, 200, app.publisher.preview(defs.featureDefs, ids));
      }
      const chm = url.pathname.match(/^\/api\/changes(?:\/([a-z0-9-]+)(\/cancel)?)?$/);
      if (chm && (req.method === 'POST' || req.method === 'PUT') && !(req.method === 'POST' && chm[1] && !chm[2])) {
        const body = await readBody(req);
        await app.refresh(); // publish against the definitions and changes as they are now
        const defs = await app.definitionsNow();
        const op = !chm[1] ? 'create' : chm[2] ? 'cancel' : 'update';
        const r = await app.publisher.submit({ op, draft: op === 'cancel' ? { reason: body.reason } : body.draft, id: chm[1] || null,
          baseRevision: Number.isInteger(body.base_revision) ? body.base_revision : null }, defs);
        // Your own change is never a "new alert" for you.
        if (r.outcome === 'published') markSeen([`change:${r.change.id}@r${r.change.revision}`], { alerts: [] }, { own: true });
        const status = { published: 200, queued: 202, not_published: 202, conflict: 409, invalid: 400, not_found: 404 }[r.outcome] || 200;
        return send(res, status, r);
      }
      // Editing feature data (src/features): preview (diff, validation, AI review), then publish.
      if (req.method === 'POST' && url.pathname === '/api/features/preview') {
        const body = await readBody(req);
        const defs = await app.definitionsNow();
        const mode = body.mode === 'create' ? 'create' : 'update';
        const base = mode === 'update' ? defs.featureDefs.find((f) => f.id === body.id) : null;
        if (mode === 'update' && !base) return send(res, 404, { error: `no valid feature "${body.id}" is defined` });
        const built = buildFeatureFile({ draft: body.draft, mode, base: base ? { text: defs.files.get(base.file), feature: base } : null, features: defs.featureDefs, invalidIds: defs.invalidIds, projects: defs.projectDefs });
        const stale = Boolean(base && body.base_hash && textHash(defs.files.get(base.file)) !== body.base_hash);
        const out = { valid: !built.errors.length, errors: built.errors, diff: built.diff || [], path: built.path || null, text: built.text || null, stale,
          ...(stale ? { stale_message: 'This feature changed in the shared repo after you opened it. Publishing will be refused; reopen it to edit the latest version.' } : {}) };
        if (built.errors.length || (mode === 'update' && !built.diff.length)) return send(res, 200, { ...out, review: null });
        return send(res, 200, { ...out, review: await review(built, defs) });
      }
      const fem = url.pathname.match(/^\/api\/features(?:\/([a-z0-9-]+)(\/delete)?)?$/);
      if (fem && ((req.method === 'POST' && (!fem[1] || fem[2])) || (req.method === 'PUT' && fem[1] && !fem[2]))) {
        const body = await readBody(req);
        const access = await app.featurePublisher.access();
        if (!access.can_edit) return send(res, 403, { outcome: 'read_only', message: access.reason });
        await app.refresh(); // publish against the definitions as they are now
        const defs = await app.definitionsNow();
        const op = !fem[1] ? 'create' : fem[2] ? 'delete' : 'update';
        const r = await app.featurePublisher.submit({ op, id: fem[1] || null, draft: body.draft, base_hash: typeof body.base_hash === 'string' ? body.base_hash : null,
          confirm_dependents: body.confirm_dependents === true }, { defs, files: defs.files, review: (built) => review(built, defs) });
        if (r.outcome === 'published') await app.refresh();
        return send(res, FEATURE_STATUS[r.outcome] || 200, r);
      }
      // Team edits (src/teams/publish.js): preview, then create / update / delete with a commit under
      // the person's GitHub identity. Anyone with write access to LifeCycle-Data may manage teams.
      // Creating a project (src/projects/create.js): one commit of projects/<id>.yaml as this person.
      if (req.method === 'POST' && url.pathname === '/api/projects') {
        const body = await readBody(req);
        const access = await app.featurePublisher.access();
        if (!access.can_edit) return send(res, 403, { outcome: 'read_only', message: access.reason });
        await app.refresh(); // check the id against the projects as they are now
        const defs = await app.definitionsNow();
        const where = app.config.dataPath ? 'the local data folder' : app.config.dataRepo;
        const r = await publishProject({ draft: body.draft, projects: defs.projectDefs || [], io: app.featurePublisher.io, whoAmI: app.publisher.whoAmI, where });
        if (r.outcome === 'published') await app.refresh();
        return send(res, { published: 201, invalid: 400, conflict: 409, not_published: 503 }[r.outcome] || 200, r);
      }
      // Mobile apps (src/apps/edit.js): create, edit and delete apps/<id>.yaml, one commit each as this person.
      const appm = url.pathname.match(/^\/api\/apps(?:\/([a-z0-9][a-z0-9-]*)(\/delete)?)?$/);
      if (appm && ((req.method === 'POST' && (!appm[1] || appm[2])) || (req.method === 'PUT' && appm[1] && !appm[2]))) {
        const body = await readBody(req);
        const access = await app.featurePublisher.access();
        if (!access.can_edit) return send(res, 403, { outcome: 'read_only', message: access.reason });
        await app.refresh(); // check against the apps and features as they are now
        const defs = await app.definitionsNow();
        const where = app.config.dataPath ? 'the local data folder' : app.config.dataRepo;
        const common = { apps: defs.appDefs || [], io: app.featurePublisher.io, whoAmI: app.publisher.whoAmI, where };
        const r = !appm[1] ? await createAppDefinition({ ...common, draft: body.draft })
          : appm[2] ? await deleteAppDefinition({ ...common, id: appm[1], features: defs.featureDefs || [] })
            : await updateAppDefinition({ ...common, id: appm[1], draft: body.draft, base: body.base || null });
        if (r.outcome === 'published') await app.refresh();
        return send(res, { published: !appm[1] ? 201 : 200, unchanged: 200, invalid: 400, has_features: 409, not_found: 404, conflict: 409, not_published: 503 }[r.outcome] || 200, r);
      }
      // Editing a project (name, owner, description): one commit of projects/<id>.yaml; the id stays.
      const pedit = url.pathname.match(/^\/api\/projects\/([a-z0-9][a-z0-9-]*)$/);
      if (req.method === 'PUT' && pedit) {
        const body = await readBody(req);
        const access = await app.featurePublisher.access();
        if (!access.can_edit) return send(res, 403, { outcome: 'read_only', message: access.reason });
        const defs = await app.definitionsNow();
        const where = app.config.dataPath ? 'the local data folder' : app.config.dataRepo;
        const r = await updateProject({ id: pedit[1], draft: body.draft, base: body.base || null, projects: defs.projectDefs || [], io: app.featurePublisher.io, whoAmI: app.publisher.whoAmI, where });
        if (r.outcome === 'published') await app.refresh();
        return send(res, { published: 200, unchanged: 200, invalid: 400, not_found: 404, conflict: 409, not_published: 503 }[r.outcome] || 200, r);
      }
      // Deleting a project: one commit removing projects/<id>.yaml; refused while features are in it.
      const pdel = url.pathname.match(/^\/api\/projects\/([a-z0-9][a-z0-9-]*)\/delete$/);
      if (req.method === 'POST' && pdel) {
        const access = await app.featurePublisher.access();
        if (!access.can_edit) return send(res, 403, { outcome: 'read_only', message: access.reason });
        await app.refresh(); // check against the features as they are now
        const defs = await app.definitionsNow();
        const where = app.config.dataPath ? 'the local data folder' : app.config.dataRepo;
        const r = await deleteProject({ id: pdel[1], projects: defs.projectDefs || [], features: defs.featureDefs || [], io: app.featurePublisher.io, whoAmI: app.publisher.whoAmI, where });
        if (r.outcome === 'published') await app.refresh();
        return send(res, { published: 200, has_features: 409, not_found: 404, conflict: 409, not_published: 503 }[r.outcome] || 200, r);
      }
      if (req.method === 'POST' && url.pathname === '/api/team-definitions/preview') {
        const body = await readBody(req);
        const defs = await app.definitionsNow();
        const op = ['create', 'update', 'delete'].includes(body.op) ? body.op : 'create';
        return send(res, 200, app.teamPublisher.preview({ op, id: body.id, draft: body.draft, handover_to: body.handover_to || null }, defs));
      }
      const tem = url.pathname.match(/^\/api\/team-definitions(?:\/([a-z0-9-]+)(\/delete)?)?$/);
      if (tem && ((req.method === 'POST' && (!tem[1] || tem[2])) || (req.method === 'PUT' && tem[1] && !tem[2]))) {
        const body = await readBody(req);
        const r = await app.submitTeamEdit({ ...body, op: !tem[1] ? 'create' : tem[2] ? 'delete' : 'update', id: tem[1] || null });
        return send(res, TEAM_STATUS[r.outcome] || 200, r);
      }
      if (req.method === 'POST' && url.pathname === '/api/features-outbox/retry') {
        await readBody(req);
        await app.refresh();
        const results = await app.featurePublisher.flush(await app.definitionsNow(), { all: true });
        if (results.some((x) => x.outcome === 'published')) await app.refresh();
        return send(res, 200, { results, feature_outbox: listFeatureOutbox() });
      }
      const fom = url.pathname.match(/^\/api\/features-outbox\/([a-z0-9-]+)\/discard$/);
      if (req.method === 'POST' && fom) {
        await readBody(req);
        app.featurePublisher.discard(fom[1]);
        return send(res, 200, { feature_outbox: listFeatureOutbox() });
      }
      if (req.method === 'POST' && url.pathname === '/api/outbox/retry') {
        await readBody(req);
        await app.refresh();
        const results = await app.publisher.flush(await app.definitionsNow(), { all: true });
        return send(res, 200, { results, outbox: listOutbox() });
      }
      const om = url.pathname.match(/^\/api\/outbox\/([a-z0-9-]+)\/discard$/);
      if (req.method === 'POST' && om) {
        await readBody(req);
        app.publisher.discard(om[1]);
        return send(res, 200, { outbox: listOutbox() });
      }
      const fm = url.pathname.match(/^\/api\/follows\/([a-z0-9-]+)$/);
      if (req.method === 'PUT' && fm) {
        const body = await readBody(req);
        return send(res, 200, { follows: ask.follow(fm[1], body.follow !== false) });
      }
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
      if (url.pathname === '/api/digest/latest') return send(res, 200, { digest: ask.lastDigest() });
      if (url.pathname === '/api/follows') return send(res, 200, { follows: ask.follows(), me: ask.me() });
      if (url.pathname === '/api/ask/history') return send(res, 200, { answers: ask.history(20) });
      if (url.pathname === '/api/ask/provider') return send(res, 200, ask.provider());
      // Evidence links for registered changes and alerts, and (local data folder only) definition files.
      const cm = url.pathname.match(/^\/api\/changes\/([a-z0-9-]+)$/);
      if (cm) {
        const snap = await app.refresh();
        const change = snap.changes.find((c) => c.id === cm[1]);
        return change ? send(res, 200, change) : send(res, 404, { error: `no registered change "${cm[1]}"` });
      }
      const am = url.pathname.match(/^\/api\/alerts\/(.+)$/);
      if (am) {
        const snap = await app.refresh();
        const alert = snap.alerts.find((a) => a.id === decodeURIComponent(am[1])) || snap.alert_list.alerts.find((a) => a.id === decodeURIComponent(am[1]));
        return alert ? send(res, 200, { ...alert, alert_list: snap.alerts_source }) : send(res, 404, { error: `no alert "${decodeURIComponent(am[1])}"` });
      }
      if (url.pathname === '/api/alerts') {
        // ?cached=1: the snapshot the page just loaded from /api/roadmap, without reading everything again.
        const snap = url.searchParams.get('cached') ? await app.latest() : await app.refresh();
        const source = url.searchParams.get('source');
        if (source && !SOURCES.includes(source)) return send(res, 400, { error: `source must be one of: ${SOURCES.join(', ')}` });
        const defs = await app.definitionsNow();
        return send(res, 200, {
          ...personalView(snap.alert_list, { features: defs.featureDefs, me: app.config.me?.owners || [], follows: ask.follows(), sourceFilter: source }),
          outbox: snap.outbox,
          // Which commit of LifeCycle-Data this view shows (the same as the roadmap's for one refresh).
          definitions: snap.definitions,
          // What Ask & digest read (lifecycle.alerts/v1): the configured alert list.
          alert_feed: { schema: 'lifecycle.alerts/v1', source: snap.alerts_source, alerts: snap.alerts },
        });
      }
      if (url.pathname === '/api/changes') {
        const snap = await app.refresh();
        return send(res, 200, { changes: snap.changes, outbox: snap.outbox });
      }
      if (url.pathname === '/api/me') {
        return send(res, 200, { github: await app.publisher.whoAmI(), owners: app.config.me?.owners || [] });
      }
      const dm = url.pathname.match(/^\/api\/definitions\/(.+)$/);
      if (dm) {
        const rel = decodeURIComponent(dm[1]);
        if (!app.config.dataPath || !LOCAL_DEFINITION.test(rel)) return send(res, 404, { error: 'not found' });
        const fileOnDisk = path.join(app.config.dataPath, rel);
        if (!fs.existsSync(fileOnDisk)) return send(res, 404, { error: `no ${rel}` });
        return send(res, 200, fs.readFileSync(fileOnDisk, 'utf8'), 'text/plain; charset=utf-8');
      }
      if (url.pathname === '/api/roadmap') return send(res, 200, await app.refresh());
      // Teams defined in LifeCycle-Data (src/teams, docs/teams-format.md): the list with what each
      // owns, ownership conflicts, "no owner", unknown team names and suggested teams.
      if (url.pathname === '/api/team-definitions') {
        const snap = url.searchParams.get('cached') ? await app.latest() : await app.refresh();
        return send(res, 200, { ...snap.team_definitions, definitions: snap.definitions, access: await app.featurePublisher.access() });
      }
      const tdm = url.pathname.match(/^\/api\/team-definitions\/([a-z0-9-]+)$/);
      if (tdm) {
        const snap = await app.refresh();
        const team = snap.team_definitions.teams.find((t) => t.id === tdm[1]);
        if (!team) return send(res, 404, { error: `no team "${tdm[1]}" is defined in LifeCycle-Data (teams/)` });
        const defs = await app.definitionsNow();
        const dependents = snap.features.filter((f) => f.team_dependencies?.teams.some((t) => t.team.id === team.id))
          .map((f) => ({ id: f.feature.id, name: f.feature.name, state: f.state, reasons: f.team_dependencies.teams.find((t) => t.team.id === team.id).reasons }));
        return send(res, 200, { ...team, base_hash: textHash(defs.files.get(team.file)), dependents, access: await app.featurePublisher.access() });
      }
      // The teams a feature depends on, each with its reasons (src/teams/dependencies.js).
      const ftm = url.pathname.match(/^\/api\/features\/([a-z0-9-]+)\/teams$/);
      if (ftm) {
        const snap = await app.refresh();
        const f = snap.features.find((x) => x.feature.id === ftm[1]);
        if (!f) return send(res, 404, { error: `no feature "${ftm[1]}" is defined` });
        return send(res, 200, f.team_dependencies);
      }
      // What the edit form needs: the feature as a draft, the hash of the file as opened, whether
      // this person may edit (and why not), who depends on it, and edits of it kept on this machine.
      if (url.pathname === '/api/features-edit-access') return send(res, 200, await app.featurePublisher.access());
      const edm = url.pathname.match(/^\/api\/features\/([a-z0-9-]+)\/definition$/);
      if (edm) {
        await app.refresh();
        const defs = await app.definitionsNow();
        const f = defs.featureDefs.find((x) => x.id === edm[1]);
        if (!f) return send(res, 404, { error: `no valid feature "${edm[1]}" is defined` });
        return send(res, 200, { id: f.id, file: f.file, draft: toDraft(f), base_hash: textHash(defs.files.get(f.file)),
          dependents: dependentsOf(f.id, defs.featureDefs), access: await app.featurePublisher.access(),
          pending: listFeatureOutbox().filter((e) => e.feature_id === f.id) });
      }
      const m = url.pathname.match(/^\/api\/features\/([a-z0-9-]+)\/status$/);
      if (m) {
        const snap = await app.refresh();
        const status = snap.features.find((f) => f.feature.id === m[1]);
        if (status) return send(res, 200, status);
        const invalid = snap.invalid_definitions.filter((e) => e.file === `features/${m[1]}.yaml` || e.file === `features/${m[1]}.yml`);
        return send(res, 404, invalid.length
          ? { error: `feature "${m[1]}" has an invalid definition`, invalid_definitions: invalid }
          : { error: `no feature "${m[1]}" is defined`, definitions: snap.definitions });
      }
      // Last mile only: every feature, or one feature (same objects as status.last_mile).
      if (url.pathname === '/api/last-mile') {
        const snap = await app.refresh();
        return send(res, 200, { schema: 'lifecycle.last-mile/v1', definitions: snap.definitions,
          features: snap.features.map((f) => ({ id: f.feature.id, name: f.feature.name, services: f.feature.services, flags: f.feature.flags, last_mile: f.last_mile })) });
      }
      const lm = url.pathname.match(/^\/api\/features\/([a-z0-9-]+)\/last-mile$/);
      if (lm) {
        const f = (await app.refresh()).features.find((x) => x.feature.id === lm[1]);
        if (!f) return send(res, 404, { error: `no feature "${lm[1]}" is defined` });
        return send(res, 200, { schema: 'lifecycle.last-mile/v1', id: f.feature.id, name: f.feature.name, services: f.feature.services, flags: f.feature.flags, last_mile: f.last_mile });
      }
      const pm = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+|none)\/status$/);
      if (pm) {
        const snap = await app.refresh();
        const id = pm[1] === 'none' ? null : pm[1];
        const project = snap.projects.find((p) => p.project.id === id);
        if (!project) return send(res, 404, { error: `no project "${pm[1]}" is defined` });
        return send(res, 200, { ...project, feature_statuses: snap.features.filter((f) => project.features.includes(f.feature.id)) });
      }
      if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.join(PUBLIC, path.normalize(rel));
      if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'index.html')), TYPES['.html']);
      }
      return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
    } catch (err) {
      if (err.status) return send(res, err.status, { error: err.message });
      console.error(redact(err.stack || err.message));
      return send(res, 500, { error: redact(err.message) });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // At login LifeCycle has a short PATH: add the Terminal's folders saved by setup (src/config.js).
  const toolPath = loadConfig().toolPath;
  if (toolPath) process.env.PATH = withToolPath(process.env.PATH, toolPath);
  const app = createApp();
  const { port } = app.config;
  createServer(app, createAskService({ app }), createUpdateService({ port })).listen(port, '127.0.0.1', () => {
    console.log(`LifeCycle is running at ${appUrl(port)}`);
    console.log(`Feature definitions: ${app.config.dataPath ? `local folder ${app.config.dataPath} (pulled from ${app.config.dataBranch} on every refresh when it is a git clone)` : app.config.dataRepo ? `${app.config.dataRepo}@${app.config.dataBranch} (latest commit read on every refresh)` : 'no shared repo set up yet (run npm run setup or set LIFECYCLE_DATA_REPO)'}`);
  });
}
