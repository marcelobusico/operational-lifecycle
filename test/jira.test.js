// Jira tickets as step evidence, read through Claude Code (Atlassian's MCP server). Claude is
// replaced by a function returning what it would. Checked: done = status category Done, or status
// Done / Closed in any case; one Claude run per refresh for all tickets; only asked-for tickets kept;
// the publisher commits jira-snapshots/; teammates without Jira see them, marked as such; the dry
// run commits nothing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startWorld, DATA, CATALOG } from './last-mile-fixture.js';
import { createApp } from '../src/app.js';
import { DEFAULTS } from '../src/config.js';
import { validateTickets, ticketState, jiraPrompt, normalizeSiteUrl } from '../src/sources/jira.js';
import { validateDefinition } from '../src/definitions.js';
import { jiraCheck } from '../src/cli/jira-check.js';

const SITE = 'https://acme.atlassian.net';
const TICKETS = {
  'BOOK-101': { key: 'BOOK-101', summary: 'Reading list API', status: 'Done', status_category: 'Done', assignee: 'Ana', created: '2026-10-01T10:00:00Z', updated: '2026-10-20T10:00:00Z', resolved: '2026-10-20T10:00:00Z', url: `${SITE}/browse/BOOK-101` },
  'BOOK-102': { key: 'BOOK-102', summary: 'Reading list UI', status: 'In Review', status_category: 'In Progress', assignee: 'Bea', created: '2026-10-05T10:00:00Z', updated: '2026-11-10T10:00:00Z', resolved: null, url: `${SITE}/browse/BOOK-102` },
  'OPS-7': { key: 'OPS-7', summary: 'Release sign-off', status: 'CLOSED', status_category: null, assignee: null, created: '2026-10-02T10:00:00Z', updated: '2026-10-21T10:00:00Z', resolved: null, url: `${SITE}/browse/OPS-7` },
};
// What Claude returns for the keys in the prompt: the tickets it knows, the rest as missing.
function fakeClaude(tickets = TICKETS, calls = []) {
  return async (cfg, prompt) => {
    const keys = prompt.match(/^Tickets: (.*)$/m)[1].split(', ');
    calls.push({ keys, tools: cfg.tools });
    return JSON.stringify({ site_url: SITE, tickets: keys.filter((k) => tickets[k]).map((k) => tickets[k]), missing: keys.filter((k) => !tickets[k]) });
  };
}

test('done means status category Done, or status Done / Closed in any case', () => {
  const st = (status, status_category = null) => ticketState({ status, status_category }).state;
  assert.equal(st('Done', 'done'), 'done');
  assert.equal(st('Shipped', 'done'), 'done');
  assert.equal(st('Closed'), 'done');
  assert.equal(st('CLOSED'), 'done');
  assert.equal(st('done', 'to_do'), 'done');
  assert.equal(st('In Review', 'in_progress'), 'in_progress');
  assert.equal(st('To Do', 'to_do'), 'not_done');
  assert.equal(st('Closed for now'), 'not_done', 'only the exact names count');
});

test('only the tickets asked for are kept, with a status; links stay on the Jira site', () => {
  const answer = { site_url: SITE, tickets: [
    { ...TICKETS['BOOK-101'] },
    { ...TICKETS['BOOK-102'], url: 'https://evil.example/browse/BOOK-102' },
    { key: 'SECRET-1', status: 'Done' },
    { key: 'OPS-7', status: '' },
  ], missing: ['OPS-9', 'NOT-ASKED-1'] };
  const v = validateTickets(answer, ['BOOK-101', 'BOOK-102', 'OPS-7', 'OPS-9']);
  assert.deepEqual([...v.tickets.keys()], ['BOOK-101', 'BOOK-102']);
  assert.equal(v.tickets.get('BOOK-101').status_category, 'done');
  assert.equal(v.tickets.get('BOOK-102').status_category, 'in_progress');
  assert.equal(v.tickets.get('BOOK-102').url, `${SITE}/browse/BOOK-102`, 'an off-site link is replaced by the site\'s');
  assert.deepEqual([...v.missing], ['OPS-9']);
  assert.deepEqual(v.dropped.map((d) => d.reason), ['"SECRET-1" wasn\'t asked for', 'OPS-7 has no status']);
  // A site that isn't Atlassian's is not trusted unless configured.
  assert.equal(validateTickets({ site_url: 'https://evil.example', tickets: [{ key: 'A-1', status: 'Done', url: 'https://evil.example/browse/A-1' }] }, ['A-1']).tickets.get('A-1').url, null);
  assert.equal(validateTickets({ tickets: [{ key: 'A-1', status: 'Done', url: 'https://jira.acme.com/browse/A-1' }] }, ['A-1'], { siteUrl: 'https://jira.acme.com' }).tickets.get('A-1').url, 'https://jira.acme.com/browse/A-1');
});

test('the prompt lists the tickets and asks only to read', () => {
  const p = jiraPrompt({ keys: ['BOOK-101', 'OPS-7'] });
  assert.match(p, /^Tickets: BOOK-101, OPS-7$/m);
  assert.match(p, /key in \(BOOK-101, OPS-7\)/);
  assert.match(p, /only to read\. Never create, edit, transition, assign or comment/);
  assert.match(DEFAULTS.sources.jira.tools.join(','), /^mcp__atlassian__getAccessibleAtlassianResources,mcp__atlassian__getJiraIssue,mcp__atlassian__searchJiraIssuesUsingJql$/);
});

test('feature definitions accept Jira tickets as step evidence', () => {
  const def = (ev) => `id: f\nname: F\nowner: me\nsteps:\n  - { id: s, name: S, owner: me, done_when: done, evidence: [${ev}] }\n`;
  assert.deepEqual(validateDefinition('features/f.yaml', def('{ source: jira, type: ticket, key: BOOK-101 }')).feature.steps[0].evidence, [{ source: 'jira', type: 'ticket', key: 'BOOK-101' }]);
  assert.match(validateDefinition('features/f.yaml', def('{ source: jira, type: ticket, key: book-1 }')).errors[0].message, /Jira ticket key like ABC-123/);
  assert.match(validateDefinition('features/f.yaml', def('{ source: jira, type: issue, key: BOOK-1 }')).errors[0].message, /must be one of: ticket/);
  assert.match(validateDefinition('features/f.yaml', def('{ source: jira, type: ticket }')).errors[0].field, /key/);
});

// --- end to end ------------------------------------------------------------------------------------

let w, home;
before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-jira-'));
  process.env.LIFECYCLE_HOME = home;
  w = await startWorld();
  w.gh.state.writable.add(DATA);
  w.gh.state.files.get(DATA).set('features/reading-list.yaml', [
    'id: reading-list', 'name: Reading list', 'owner: Catalog team', 'services: []', 'flags: []', 'steps:',
    `  - { id: development, name: Development, owner: "@dev", done_when: merged, evidence: [{ source: github, type: pr, repo: ${CATALOG}, number: 1 }, { source: jira, type: ticket, key: BOOK-101 }] }`,
    '  - { id: ui, name: UI, owner: "@ui", done_when: ticket done, evidence: [{ source: jira, type: ticket, key: BOOK-102 }] }',
    'ramp_conditions:',
    '  - { id: signoff, name: Release sign-off, owner: "@ops", done_when: closed, evidence: [{ source: jira, type: ticket, key: OPS-7 }] }',
  ].join('\n') + '\n');
});
after(async () => { await w.close(); fs.rmSync(home, { recursive: true, force: true }); });

const jiraOn = (extra = {}) => ({ ...w.config, ai: { provider: 'none' }, sources: { ...w.config.sources, jira: { ...DEFAULTS.sources.jira, enabled: true, ...extra } } });
const feature = (snap) => snap.features.find((f) => f.feature.id === 'reading-list');
const ev = (snap, step, key) => feature(snap).steps.find((s) => s.id === step).evidence.find((e) => e.key === key);

test('the publisher reads every ticket in one Claude run, steps follow them, and snapshots are committed', async () => {
  const calls = [];
  const app = createApp({ alwaysLive: true, config: jiraOn(), token: w.gh.token, jiraRun: fakeClaude(TICKETS, calls) });
  const snap = await app.refresh({ live: true });
  assert.equal(calls.length, 1, 'one run for all tickets of the refresh');
  assert.deepEqual(calls[0].keys.sort(), ['BOOK-101', 'BOOK-102', 'OPS-7']);
  const f = feature(snap);
  assert.equal(f.steps[0].state, 'done', 'PR merged and BOOK-101 Done');
  assert.equal(f.steps[1].state, 'in_progress');
  assert.equal(f.state, 'flowing');
  const t = ev(snap, 'ui', 'BOOK-102');
  assert.equal(t.link, `${SITE}/browse/BOOK-102`);
  assert.equal(t.title, 'Reading list UI');
  assert.equal(t.detail, 'In Review');
  assert.equal(t.from_snapshot, false);
  assert.equal(f.ramp_conditions[0].state, 'done', 'OPS-7 is CLOSED');
  assert.match(f.summary, /In progress: "UI"/);
  // Snapshots in the shared repo, one per ticket.
  const files = w.gh.state.files.get(DATA);
  assert.match(files.get('jira-snapshots/BOOK-102.yaml'), /status: In Review/);
  assert.match(files.get('jira-snapshots/BOOK-102.yaml'), /^# Written by LifeCycle from a Jira read/);
  assert.ok(files.get('jira-snapshots/OPS-7.yaml'));
  assert.deepEqual(snap.jira_snapshots.failed, []);
  // Within the interval: no new run, and nothing new committed.
  const commits = w.gh.state.commits.length;
  await createApp({ alwaysLive: true, config: jiraOn(), token: w.gh.token, jiraRun: fakeClaude(TICKETS, calls) }).refresh({ live: true });
  assert.equal(calls.length, 1);
  assert.equal(w.gh.state.commits.length, commits);
});

test('a teammate without Jira sees the tickets from the team snapshot, marked as such', async () => {
  const app = createApp({ alwaysLive: true, config: { ...w.config, ai: { provider: 'none' } }, token: w.gh.token, jiraRun: async () => assert.fail('a reader never runs Claude') });
  const snap = await app.refresh({ live: true });
  const t = ev(snap, 'ui', 'BOOK-102');
  assert.equal(t.state, 'in_progress');
  assert.equal(t.from_snapshot, true);
  assert.equal(t.detail, 'In Review (team snapshot)');
  assert.equal(t.link, `${SITE}/browse/BOOK-102`);
  assert.ok(Date.parse(t.last_successful_read_at));
  assert.equal(feature(snap).steps[0].state, 'done');
});

test('a step read from a team snapshot shows the snapshot\'s read time and says so, in its sources too', async () => {
  const snap = await createApp({ alwaysLive: true, config: { ...w.config, ai: { provider: 'none' } }, token: w.gh.token }).refresh({ live: true });
  const step = feature(snap).steps.find((s) => s.id === 'ui');
  assert.equal(step.from_snapshot, true);
  assert.equal(step.last_successful_read_at, ev(snap, 'ui', 'BOOK-102').last_successful_read_at, 'the snapshot read time, not now');
  const src = feature(snap).sources.find((t) => t.key === 'step:ui');
  assert.equal(src.source, 'jira');
  assert.equal(src.from_snapshot, true);
});

test('tickets Claude leaves out cost no extra run: one run per refresh, the rest wait for the interval', async () => {
  const calls = [];
  const onlyOne = fakeClaude({ 'BOOK-101': TICKETS['BOOK-101'] }, calls);
  const leaveOut = async (cfg, prompt) => { const a = JSON.parse(await onlyOne(cfg, prompt)); a.missing = []; return JSON.stringify(a); };
  fs.writeFileSync(path.join(home, 'cache', 'jira.json'), 'null'); // a damaged cache is started over, never a crash
  const first = await createApp({ alwaysLive: true, config: jiraOn({ intervalMinutes: 0 }), token: w.gh.token, jiraRun: leaveOut }).refresh({ live: true });
  assert.equal(calls.length, 1, 'not one more run per unanswered ticket');
  assert.equal(ev(first, 'ui', 'BOOK-102').from_snapshot, true, 'unanswered: the team snapshot');
  await createApp({ alwaysLive: true, config: jiraOn(), token: w.gh.token, jiraRun: leaveOut }).refresh({ live: true });
  assert.equal(calls.length, 1, 'within the interval, unanswered tickets are not asked again');
});

test('a Jira site typed without https:// still gives ticket links', () => {
  assert.equal(normalizeSiteUrl('acme.atlassian.net'), SITE);
  assert.equal(normalizeSiteUrl(' https://Acme.atlassian.net/jira/your-work '), SITE);
  assert.equal(normalizeSiteUrl('not a site'), null);
  assert.equal(normalizeSiteUrl('http://acme.atlassian.net'), null);
  const v = validateTickets({ tickets: [TICKETS['BOOK-102']] }, ['BOOK-102'], { siteUrl: 'acme.atlassian.net' });
  assert.equal(v.tickets.get('BOOK-102').url, `${SITE}/browse/BOOK-102`);
  assert.equal(v.site_url, SITE);
});

test('Claude failing on the publisher\'s machine: one try per refresh, then the snapshot', async () => {
  let runs = 0;
  const app = createApp({ alwaysLive: true, config: jiraOn({ intervalMinutes: 0 }), token: w.gh.token, jiraRun: async () => { runs += 1; return 'Sorry, I could not reach Atlassian.'; } });
  const snap = await app.refresh({ live: true });
  assert.equal(runs, 1);
  assert.equal(ev(snap, 'ui', 'BOOK-102').from_snapshot, true);
  assert.equal(feature(snap).steps[1].state, 'in_progress');
  // Within the interval after a failure, the next refresh doesn't wait on Claude again.
  await createApp({ alwaysLive: true, config: jiraOn({ intervalMinutes: 30 }), token: w.gh.token, jiraRun: async () => { runs += 1; return 'still no'; } }).refresh({ live: true });
  assert.equal(runs, 1);
  fs.rmSync(path.join(home, 'cache', 'jira.json'), { force: true });
});

test('a ticket Jira doesn\'t have, and one nobody has shared yet, are "unavailable" with the reason', async () => {
  const files = w.gh.state.files.get(DATA);
  const original = files.get('features/reading-list.yaml');
  files.set('features/reading-list.yaml', original.replace('key: BOOK-102', 'key: BOOK-999'));
  try {
    const live = await createApp({ alwaysLive: true, config: jiraOn({ intervalMinutes: 0 }), token: w.gh.token, jiraRun: fakeClaude() }).refresh({ live: true });
    assert.equal(feature(live).steps[1].state, 'unavailable');
    assert.match(feature(live).steps[1].message, /Jira has no ticket BOOK-999, or your Atlassian account can't see it/);
    const reader = await createApp({ alwaysLive: true, config: { ...w.config, ai: { provider: 'none' } }, token: w.gh.token }).refresh({ live: true });
    assert.equal(feature(reader).steps[1].state, 'no_access');
    assert.match(feature(reader).steps[1].message, /Jira isn't read on this machine, and nobody's LifeCycle has shared BOOK-999 yet.*lifecycle setup --extras/);
  } finally {
    files.set('features/reading-list.yaml', original);
  }
});

test('the dry run prints each ticket and whether it counts as done, and commits nothing', async () => {
  const commits = w.gh.state.commits.length;
  const lines = [];
  const code = await jiraCheck({ argv: [], config: { ...w.config }, token: w.gh.token, run: fakeClaude(), out: (l) => lines.push(l) });
  const printed = lines.join('\n');
  assert.equal(code, 0);
  assert.match(printed, /Reading 3 Jira tickets/);
  assert.match(printed, /BOOK-101 {2}✓ done {2}\(Done\) {2}Reading list API/);
  assert.match(printed, /BOOK-102 {2}… in progress {2}\(In Review\)/);
  assert.match(printed, /OPS-7 {2}✓ done {2}\(CLOSED\)/);
  assert.match(printed, /lifecycle setup --extras/);
  assert.equal(w.gh.state.commits.length, commits);
  const one = [];
  assert.equal(await jiraCheck({ argv: ['nope'], config: w.config, token: w.gh.token, run: fakeClaude(), out: (l) => one.push(l) }), 2);
  assert.match(one[0], /Not a Jira ticket key: NOPE/);
});

test('the feature editor attaches Jira tickets to a step, shows what is linked, and rejects keys that aren\'t keys', async () => {
  const { buildFeatureFile, toDraft } = await import('../src/features/edit.js');
  const text = 'id: f\nname: F\nowner: me\nsteps:\n  - id: dev\n    name: Dev\n    owner: me\n    done_when: merged\n    evidence:\n      - { source: github, type: pr, repo: org/app, number: 1 }\n';
  const feature = validateDefinition('features/f.yaml', text).feature;
  const draft = toDraft(feature);
  assert.deepEqual(draft.steps[0].linked, ['PR org/app#1']);
  const withJira = (keys) => ({ ...draft, steps: [{ ...draft.steps[0], add_evidence: keys.map((key) => ({ source: 'jira', type: 'ticket', key })) }] });
  const r = buildFeatureFile({ draft: withJira(['book-7', 'BOOK-7']), mode: 'update', base: { text, feature }, features: [feature] });
  assert.deepEqual(r.errors, []);
  assert.match(r.text, /- \{ source: github, type: pr, repo: org\/app, number: 1 \}\n\s+- \{ source: jira, type: ticket, key: BOOK-7 \}\n$/, 'appended once, in the step\'s own style');
  assert.deepEqual(r.feature.steps[0].evidence.map((e) => e.key || e.number), [1, 'BOOK-7']);
  assert.deepEqual(r.diff, [{ field: 'steps[0]', label: 'Step "Dev"', changes: [], attached: ['Jira BOOK-7'] }]);
  // Linking a ticket that is already linked changes nothing.
  const again = buildFeatureFile({ draft: { ...withJira(['BOOK-7']) }, mode: 'update', base: { text: r.text, feature: r.feature }, features: [r.feature] });
  assert.deepEqual(again.diff, []);
  const bad = buildFeatureFile({ draft: withJira(['BOOK7']), mode: 'update', base: { text, feature }, features: [feature] });
  assert.deepEqual(bad.errors.map((e) => [e.field, e.message]), [['steps[0].evidence[1].key', 'must be a Jira ticket key like ABC-123']]);
});

// Nothing is read on a timer: a plain refresh reads only the shared repo and shows what the last
// live read ("Refresh Data") said, without calling Claude or GitHub for PRs, deploys or flags.
test('Refresh View reuses the last live read; Refresh Data reads the sources again', async () => {
  const calls = [];
  const urls = [];
  const fetchImpl = (u, o) => { urls.push(String(u)); return fetch(u, o); };
  const mk = (tickets) => createApp({ config: jiraOn({ intervalMinutes: 0 }), token: w.gh.token, fetchImpl, jiraRun: fakeClaude(tickets, calls) });
  const live = await mk(TICKETS).refresh({ live: true });
  assert.equal(live.sources_read.live, true);
  assert.equal(calls.length, 1);
  const commits = w.gh.state.commits.length;

  // Jira moved on, but a plain refresh doesn't ask: same states, same read time, no commits.
  const moved = { ...TICKETS, 'BOOK-102': { ...TICKETS['BOOK-102'], status: 'Done', status_category: 'Done', resolved: '2026-11-18T10:00:00Z' } };
  urls.length = 0;
  const cached = await mk(moved).refresh();
  assert.equal(calls.length, 1, 'no Claude run');
  assert.ok(!urls.some((u) => u.includes(CATALOG)), `no reads of the code repo: ${urls.filter((u) => u.includes(CATALOG)).join(', ')}`);
  assert.deepEqual(cached.sources_read, { read_at: live.sources_read.read_at, live: false });
  assert.equal(ev(cached, 'ui', 'BOOK-102').detail, 'In Review');
  assert.equal(feature(cached).steps[1].state, feature(live).steps[1].state);
  assert.deepEqual(feature(cached).last_mile, feature(live).last_mile);
  assert.equal(w.gh.state.commits.length, commits);

  // A PR just linked to a step (never read here) is read once on a plain refresh: GitHub, no Claude.
  const resultsFile = path.join(home, 'cache', 'evidence-results.json');
  const saved = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  const prKeys = Object.keys(saved).filter((k) => !/BOOK-|OPS-/.test(k));
  assert.ok(prKeys.length, 'the feature has a PR');
  for (const k of prKeys) delete saved[k];
  fs.writeFileSync(resultsFile, JSON.stringify(saved));
  urls.length = 0;
  const linked = await mk(moved).refresh();
  assert.equal(calls.length, 1, 'still no Claude run');
  assert.ok(urls.some((u) => u.includes(CATALOG)), 'the new PR is read');
  assert.equal(feature(linked).steps[0].state, feature(live).steps[0].state);
  assert.ok(prKeys.every((k) => JSON.parse(fs.readFileSync(resultsFile, 'utf8'))[k]), 'and saved for the next plain refresh');

  // A Jira ticket never read on this machine (and with no team snapshot) waits for Refresh Data.
  const snapFile = [...w.gh.state.files.get(DATA).keys()].find((f) => f.startsWith('jira-snapshots/') && f.includes('BOOK-102'));
  assert.ok(snapFile, 'the live read above committed a team snapshot for BOOK-102');
  const snapText = w.gh.state.files.get(DATA).get(snapFile);
  w.gh.state.files.get(DATA).delete(snapFile);
  try {
    const noTicket = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
    const ticketKeys = Object.keys(noTicket).filter((k) => k.includes('BOOK-102'));
    assert.ok(ticketKeys.length, 'BOOK-102 was saved by the live read');
    for (const k of ticketKeys) delete noTicket[k];
    fs.writeFileSync(resultsFile, JSON.stringify(noTicket));
    const unread = ev(await mk(moved).refresh(), 'ui', 'BOOK-102');
    assert.equal(calls.length, 1, 'still no Claude run');
    assert.equal(unread.state, 'unavailable');
    assert.match(JSON.stringify(unread), /Not read on this machine yet\. Press Refresh Data to read it\./);
  } finally {
    w.gh.state.files.get(DATA).set(snapFile, snapText);
  }

  // Refresh Data: read again, and the new state shows.
  const again = await mk(moved).refresh({ live: true });
  assert.equal(calls.length, 2);
  assert.equal(again.sources_read.live, true);
  assert.equal(ev(again, 'ui', 'BOOK-102').detail, 'Done');
});
