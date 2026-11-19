// Teams with ownership: walks the acceptance criteria against a fake GitHub. ana can write to the shared repo (commits under her own identity); cy can only read.
// Teams are created, renamed and deleted from the chat (preview, then confirm) and from the Teams API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeGithub } from './fake-github.js';
import { createApp } from '../src/app.js';
import { createServer } from '../src/server.js';
import { createAskService } from '../src/ask/service.js';
import { parseDefinitions } from '../src/definitions.js';
import { DEFAULTS } from '../src/config.js';

const DATA = 'acme-org/LifeCycle-Data';
const MONO = 'acme-org/acme-monolith';
const ISSUES = 'acme-org/rewards-issues';
let gh, ana, cy;

async function person(name, { login }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `lifecycle-teams-${name}-`));
  const config = { ...DEFAULTS, dataRepo: DATA, me: { owners: [], github: null }, ai: { ...DEFAULTS.ai, provider: 'none' },
    sources: { github: { enabled: true, apiUrl: gh.url }, flagsmith: { ...DEFAULTS.sources.flagsmith, enabled: false } } };
  process.env.LIFECYCLE_HOME = home;
  const app = createApp({ alwaysLive: true, config, token: gh.token, flagsmithApiKey: null });
  const server = createServer(app, createAskService({ app, readConfig: () => config }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    process.env.LIFECYCLE_HOME = home;
    gh.state.login = login;
    const res = await fetch(url + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  return {
    get: (p) => call('GET', p).then((r) => r.body),
    post: (p, body = {}) => call('POST', p, body),
    put: (p, body = {}) => call('PUT', p, body),
    ask: (question) => call('POST', '/api/ask', { question }).then((r) => r.body),
    confirm: (id, body = {}) => call('POST', `/api/ask/actions/${id}/confirm`, body),
    close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }),
  };
}

const repoFile = (p) => gh.state.files.get(DATA).get(p);
const step = (id, team, evidence = '') => `  - id: ${id}\n    name: ${id[0].toUpperCase()}${id.slice(1)}\n    owner: "@dev-${id}"\n${team ? `    team: ${team}\n` : ''}    done_when: merged to main\n${evidence}`;

before(async () => {
  gh = await startFakeGithub();
  gh.state.readable.add(DATA).add(MONO).add(ISSUES);
  gh.state.writable.add(DATA);
  gh.state.readOnlyLogins.add('cy');
  gh.state.issues.set(`${ISSUES}#7`, { title: 'Rewards points store', state: 'open' });
  gh.state.files.set(DATA, new Map([
    ['services/catalog-api.yaml', `id: catalog-api\nname: Catalog API\nowner: catalog\nrepo: ${MONO}\n`],
    ['teams/catalog.yaml', 'id: catalog\nname: Catalog\naliases: [Catalog team]\nowns:\n  services: [catalog-api]\n'],
    ['teams/rewards.yaml', `id: rewards\nname: Rewards\naliases: [Rewards team]\nowns:\n  flags: [loyalty_tiers]\n  tickets:\n    - repo: ${ISSUES}\n    - label: rewards\n`],
    ['teams/growth.yaml', 'id: growth\nname: Growth\nowns:\n  flags: [loyalty_tiers]\n'],
    // A mobile app owned by a team through its own `owner:` (the app-store work's apps/ files).
    ['apps/acme-mobile.yaml', 'id: acme-mobile\nname: Acme\nowner: Rewards team\nrepo: acme-org/acme-mobile\nplatforms:\n  ios: { store: app_store, store_id: "1234567890" }\n'],
    ['features/rewards.yaml', `id: rewards\nname: Rewards points\nowner: rewards\nsteps:\n${step('points-store', 'rewards', `    evidence:\n      - { source: github, type: issue, repo: ${ISSUES}, number: 7 }\n`)}`],
    ['features/redeem-rewards.yaml', `id: redeem-rewards\nname: Redeem rewards\nowner: "@pm"\ndepends_on: [rewards]\nservices: [catalog-api]\nflags: [redeem_rewards]\napps: [acme-mobile]\nsteps:\n${step('design', 'wishlist')}${step('development', 'Rewards team')}`],
    // A typo in a step's team: "Rewards Team " is not "Rewards team".
    ['features/loyalty.yaml', `id: loyalty\nname: Loyalty tiers\nowner: "@pm"\nflags: [loyalty_tiers]\nsteps:\n${step('backend', '"Rewards Team "')}`],
  ]));
  ana = await person('ana', { login: 'ana' });
  cy = await person('cy', { login: 'cy' });
});
after(async () => { await ana.close(); await cy.close(); await gh.close(); });

test('a read-only person is told why they can\'t manage teams, from the chat and from the Teams page', async () => {
  const a = await cy.ask('create a team called Wishlist that owns the acme-wishlist repo');
  assert.equal(a.outcome, 'read_only');
  assert.equal(a.action.can_confirm, false);
  assert.match(a.lead.text, /read-only access to acme-org\/LifeCycle-Data.*manage teams/);
  const r = await cy.post('/api/team-definitions', { draft: { id: 'wishlist', name: 'Wishlist' } });
  assert.equal(r.status, 403);
  assert.match(r.body.message, /read-only/);
  assert.equal(repoFile('teams/wishlist.yaml'), undefined);
});

test('"create a team called Wishlist that owns the acme-wishlist repo and the redeem_rewards flag": a preview, then a commit by that person', async () => {
  const a = await ana.ask('create a team called Wishlist that owns the acme-wishlist repo and the redeem_rewards flag');
  assert.equal(a.outcome, 'proposed_action');
  assert.equal(a.action.op, 'create');
  assert.match(a.lead.text, /Nothing is saved until you confirm/);
  assert.equal(repoFile('teams/wishlist.yaml'), undefined, 'nothing is written before confirming');
  assert.match(a.action.preview.text, /acme-org\/acme-wishlist/);

  const r = await ana.confirm(a.action.id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.outcome, 'published');
  const commit = gh.state.commits.find((c) => c.path === 'teams/wishlist.yaml');
  assert.equal(commit.by, 'ana');
  assert.equal(commit.op, 'create');
  assert.match(commit.message, /^Add team wishlist \(by @ana from LifeCycle\)$/);
  const team = parseDefinitions([{ path: 'teams/wishlist.yaml', text: repoFile('teams/wishlist.yaml') }]).teams[0];
  assert.deepEqual({ id: team.id, name: team.name, repos: team.owns.repos, flags: team.owns.flags },
    { id: 'wishlist', name: 'Wishlist', repos: ['acme-org/acme-wishlist'], flags: ['redeem_rewards'] });
  // Confirming twice does nothing.
  assert.equal((await ana.confirm(a.action.id)).body.outcome, 'not_found');
});

test('renaming the team through the chat keeps its id, and the features that reference it show the new name', async () => {
  const a = await ana.ask('rename team wishlist to Digital Wishlist');
  assert.equal(a.outcome, 'proposed_action');
  assert.match(a.action.title, /id wishlist stays/);
  assert.equal((await ana.confirm(a.action.id)).body.outcome, 'published');
  assert.match(repoFile('teams/wishlist.yaml'), /^id: wishlist\nname: Digital Wishlist\n/);
  assert.match(gh.state.commits.at(-1).message, /^Rename team wishlist: Wishlist → Digital Wishlist \(by @ana from LifeCycle\)$/);
  const deps = await ana.get('/api/features/redeem-rewards/teams');
  const wishlist = deps.teams.find((t) => t.team.id === 'wishlist');
  assert.equal(wishlist.team.name, 'Digital Wishlist');
  assert.ok(wishlist.reasons.some((r) => r.kind === 'step' && r.step === 'design'));
});

test('"redeem rewards" lists every team it relies on, each with a reason linking to what is behind it', async () => {
  const deps = await ana.get('/api/features/redeem-rewards/teams');
  const byTeam = Object.fromEntries(deps.teams.map((t) => [t.team.id, t]));
  assert.deepEqual(Object.keys(byTeam).sort(), ['catalog', 'rewards', 'wishlist']);
  const has = (team, pred, what) => assert.ok(byTeam[team].reasons.some(pred), `${team}: ${what} (${JSON.stringify(byTeam[team].reasons)})`);
  // Checked against the feature's definition: steps design (wishlist) and development ("Rewards team"),
  // service catalog-api (Catalog), flag redeem_rewards (Wishlist), dependency rewards (Rewards).
  has('wishlist', (r) => r.kind === 'step' && r.step === 'design' && r.link === '/#/feature/redeem-rewards', 'does step Design');
  has('wishlist', (r) => r.kind === 'flag' && /redeem_rewards/.test(r.text) && r.link, 'owns the flag');
  has('rewards', (r) => r.kind === 'step' && r.step === 'development', 'does step Development (named by its alias)');
  has('rewards', (r) => r.kind === 'app' && /acme-mobile/.test(r.text) && r.link === `https://github.com/${DATA}/blob/main/apps/acme-mobile.yaml`, 'owns the app it ships in');
  has('catalog', (r) => r.kind === 'service' && r.link === `https://github.com/${DATA}/blob/main/services/catalog-api.yaml`, 'owns service catalog-api, linked to its definition');
  has('rewards', (r) => r.kind === 'dependency' && r.reason_kind === 'owner' && r.link === '/#/feature/rewards' && r.via[0].id === 'rewards', 'owns the dependency Rewards points');
  has('rewards', (r) => r.kind === 'dependency' && r.reason_kind === 'tickets' && r.inner_link === `https://github.com/${ISSUES}/issues/7`, 'owns the tickets the dependency links');
  assert.ok(byTeam.wishlist.direct && byTeam.catalog.direct && byTeam.rewards.direct);
  for (const t of deps.teams) for (const r of t.reasons) assert.ok(r.link, `every reason has a link: ${r.text}`);
  // The repo the service deploys from has no owner: listed, not invented.
  assert.ok(deps.no_owner.some((n) => n.kind === 'repo' && n.key === MONO));
  // The feature page carries the same view.
  const status = await ana.get('/api/features/redeem-rewards/status');
  assert.deepEqual(status.team_dependencies, deps);
});

test('the chat answer to "which teams do I depend on for redeem rewards?" matches that view', async () => {
  const a = await ana.ask('which teams do I depend on for redeem rewards?');
  assert.equal(a.intent, 'teams');
  assert.equal(a.feature.id, 'redeem-rewards');
  const view = await ana.get('/api/features/redeem-rewards/teams');
  assert.deepEqual(a.team_dependencies, view);
  const statements = a.sections.find((s) => s.id === 'teams').statements;
  assert.deepEqual(statements.map((s) => s.team), view.teams.map((t) => t.team.id));
  for (const [i, t] of view.teams.entries()) {
    for (const r of t.reasons) {
      assert.ok(statements[i].text.includes(r.text), `the answer gives the reason "${r.text}"`);
      assert.ok(statements[i].evidence.some((e) => e.link === r.link), `and links ${r.link}`);
    }
  }
  assert.equal(a.lead.text, view.summary);
});

test('a step naming "Rewards Team " (different spelling) shows an unknown team warning, and every other feature still displays', async () => {
  const roadmap = await ana.get('/api/roadmap');
  assert.deepEqual(roadmap.features.map((f) => f.feature.id).sort(), ['loyalty', 'redeem-rewards', 'rewards']);
  const loyalty = roadmap.features.find((f) => f.feature.id === 'loyalty');
  assert.equal(loyalty.team_warnings.length, 1);
  assert.equal(loyalty.team_warnings[0].kind, 'unknown_team');
  assert.match(loyalty.team_warnings[0].message, /Unknown team "Rewards Team"/);
  assert.equal(roadmap.features.find((f) => f.feature.id === 'rewards').team_warnings.length, 0);
  const defs = await ana.get('/api/team-definitions');
  assert.ok(defs.unknown_teams.some((u) => u.name === 'Rewards Team'));
  // Existing free-text names are offered as suggested teams (here: as an alias of an existing team).
  assert.ok(defs.suggestions.some((s) => s.name === 'Rewards Team' && s.add_alias_to.id === 'rewards'));
});

test('two teams claiming the same flag show an ownership conflict naming both', async () => {
  const defs = await ana.get('/api/team-definitions');
  const c = defs.conflicts.find((x) => x.kind === 'flag' && x.key === 'loyalty_tiers');
  assert.ok(c, JSON.stringify(defs.conflicts));
  assert.deepEqual(c.teams.map((t) => t.name).sort(), ['Growth', 'Rewards']);
  assert.match(c.message, /flag loyalty_tiers is claimed by (Growth and Rewards|Rewards and Growth)/);
  const deps = await ana.get('/api/features/loyalty/teams');
  assert.ok(deps.conflicts.some((x) => x.key === 'loyalty_tiers'));
});

test('a team file with a person\'s email is rejected by the validator, which names the field', async () => {
  const { invalid, teams } = parseDefinitions([{ path: 'teams/ops.yaml', text: 'id: ops\nname: Ops\ndescription: Questions to ana.perez@example.com\n' }]);
  assert.equal(teams.length, 0);
  assert.deepEqual(invalid.map((e) => e.field), ['description']);
  assert.match(invalid[0].message, /email address; team files never hold people's names, emails or credentials/);
  const people = parseDefinitions([{ path: 'teams/ops.yaml', text: 'id: ops\nname: Ops\nlead: Bruno\nowns:\n  repos: ["@bruno"]\n' }]).invalid;
  assert.deepEqual(people.map((e) => e.field).sort(), ['lead', 'owns.repos[0]', 'owns.repos[0]'].sort());
  // Through the Teams API the same rule refuses the save and names the field.
  const r = await ana.post('/api/team-definitions', { draft: { id: 'ops', name: 'Ops', description: 'ana.perez@example.com' } });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body.errors.map((e) => e.field), ['description']);
  assert.equal(repoFile('teams/ops.yaml'), undefined);
});

test('deleting a team that owns a service lists it, asks to hand it over or confirm, and the service then shows "no owner"', async () => {
  const a = await ana.ask('delete team catalog');
  assert.equal(a.outcome, 'proposed_action');
  assert.ok(a.action.preview.affected.owns.some((o) => o.kind === 'service' && o.key === 'catalog-api'));
  let r = await ana.confirm(a.action.id);
  assert.equal(r.body.outcome, 'needs_decision');
  assert.match(r.body.message, /Hand them over to another team, or leave them without an owner/);
  assert.ok(r.body.affected.references.some((x) => x.type === 'service' && x.id === 'catalog-api'));
  assert.ok(repoFile('teams/catalog.yaml'), 'nothing deleted yet');
  r = await ana.confirm(a.action.id, { leave_unowned: true });
  assert.equal(r.body.outcome, 'confirm_unowned');
  assert.match(r.body.message, /service catalog-api will have no owner/);
  assert.ok(repoFile('teams/catalog.yaml'), 'still nothing deleted before the second confirmation');
  r = await ana.confirm(a.action.id, { leave_unowned: true, confirm_unowned: true });
  assert.equal(r.body.outcome, 'published', JSON.stringify(r.body));
  assert.equal(repoFile('teams/catalog.yaml'), undefined);
  assert.doesNotMatch(repoFile('services/catalog-api.yaml'), /owner:/);
  assert.ok(gh.state.commits.filter((c) => c.by === 'ana').some((c) => c.op === 'delete' && c.path === 'teams/catalog.yaml'));
  const defs = await ana.get('/api/team-definitions');
  assert.ok(defs.no_owner.some((n) => n.kind === 'service' && n.key === 'catalog-api'), JSON.stringify(defs.no_owner));
});

test('handing a deleted team over moves what it owns and every reference to the other team\'s id', async () => {
  const r = await ana.post('/api/team-definitions/growth/delete', { handover_to: 'rewards' });
  assert.equal(r.body.outcome, 'published', JSON.stringify(r.body));
  assert.equal(repoFile('teams/growth.yaml'), undefined);
  assert.match(repoFile('teams/rewards.yaml'), /flags: \[loyalty_tiers\]/);
  const defs = await ana.get('/api/team-definitions');
  assert.ok(!defs.conflicts.some((c) => c.key === 'loyalty_tiers'), 'the conflict is gone once one team owns the flag');
});
