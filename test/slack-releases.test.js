// App releases from a Slack release channel, read through Claude Code. Every message here is made
// up, in the styles a release bot and people use. Claude is replaced by a function (or a fake
// `claude` script) that returns what it would: the messages it read and the events it found.
// Checked: only values written in a message are kept; LifeCycle works the state out itself; the
// publisher's LifeCycle commits it as a store snapshot (no message text); teammates without Slack
// see that snapshot, marked as such; and the dry run commits nothing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMobileWorld } from './mobile-fixture.js';
import { DATA } from './last-mile-fixture.js';
import { createApp } from '../src/app.js';
import { DEFAULTS } from '../src/config.js';
import { validateEvents, foldEvents, slackPrompt, createSlackReleaseReader } from '../src/stores/slack-releases.js';
import { slackCheck } from '../src/cli/slack-check.js';

const CHANNEL = '#mobile-releases';
const APP = { id: 'acme-mobile', name: 'Acme', platforms: { ios: {}, android: {} }, releaseChannel: { slack: CHANNEL, hint: 'iOS messages mention the App Store' } };
const T0 = Math.floor(Date.now() / 1000) - 10 * 86400;
const ts = (n) => `${T0 + n * 3600}.000100`;
const link = (n) => `https://acme.slack.com/archives/C0RELEASE/p${T0 + n * 3600}000100`;

// What the channel holds (made up), and the events Claude would return for it, including one it made up.
const MESSAGES = [
  { ts: ts(1), text: ':rocket: Release *3.4.0* cut for iOS and Android (build 812)' },
  { ts: ts(2), text: 'Acme iOS 3.4.0 submitted to App Store review' },
  { ts: ts(3), text: '3.4.0 got approved by Apple :tada: releasing tomorrow' },
  { ts: ts(4), text: 'Acme iOS v3.4.0 phased release started: 1% of users' },
  { ts: ts(5), text: 'Android 3.4.0 staged rollout at 10%' },
  { ts: ts(6), thread_ts: ts(5), text: 'bumped to 50% :chart_with_upwards_trend:' },
  { ts: ts(7), text: 'iOS rollout now at 20 percent, crash-free 99.9%' },
  { ts: ts(8), text: 'Android 3.4.0 rollout halted at 50% (crash spike on Pixel 6), investigating' },
  { ts: ts(9), text: 'anyone up for lunch?' },
].map((m) => ({ thread_ts: null, permalink: link(Number((Number(m.ts) - T0) / 3600 | 0)), ...m }));
const ev = (n, platform, kind, version, rollout_percentage = null) => ({ ts: ts(n), app: 'acme-mobile', platform, kind, version, rollout_percentage });
const EVENTS = [
  ev(1, 'ios', 'cut', '3.4.0'), ev(1, 'android', 'cut', '3.4.0'),
  ev(2, 'ios', 'submitted', '3.4.0'),
  ev(3, 'ios', 'approved', '3.4.0'),
  ev(4, 'ios', 'released', '3.4.0', 1),
  ev(5, 'android', 'rollout', '3.4.0', 10),
  ev(6, 'android', 'rollout', '3.4.0', 50), // version from the thread's first message
  ev(7, 'ios', 'rollout', null, 20),        // no version: the newest released one
  ev(8, 'android', 'halted', '3.4.0', 50),
  ev(7, 'ios', 'released', '3.9.9', 99.9),  // made up: neither value fits the message → dropped
];
const answer = (messages = MESSAGES, events = EVENTS) => JSON.stringify({ channel_found: true, messages, events });

test('only events whose values are written in the cited message are kept', () => {
  const { kept, dropped } = validateEvents({ messages: MESSAGES, events: EVENTS, apps: [APP] });
  assert.equal(kept.length, 9);
  assert.deepEqual(dropped.map((d) => d.reason), ['version 3.9.9 is not written in the message']);
  assert.equal(kept.find((e) => e.ts === ts(6)).version, '3.4.0', 'version from the thread\'s first message');
  assert.equal(kept.find((e) => e.ts === ts(4)).version, '3.4.0', '"v3.4.0" counts as 3.4.0');
  assert.equal(kept[0].link, link(1));
  const bad = (e, messages = MESSAGES) => validateEvents({ messages, events: [e], apps: [APP] }).dropped[0]?.reason;
  assert.match(bad(ev(5, 'android', 'rollout', '3.4.0', 25)), /25% is not written/);
  assert.match(bad(ev(5, 'android', 'rollout', '3.4', 10)), /version 3\.4 is not written/, '3.4 is not 3.4.0');
  assert.match(bad(ev(5, 'android', 'rollout', '13.4.0', 10)), /version 13\.4\.0 is not written/);
  assert.match(bad({ ...ev(5, 'android', 'rollout', '3.4.0', 10), ts: '1.0' }), /not returned/);
  assert.match(bad({ ...ev(5, 'android', 'rollout', '3.4.0', 10), app: 'other-app' }), /unknown app/);
  assert.match(bad(ev(5, 'web', 'rollout', '3.4.0', 10)), /no web platform/);
  assert.match(bad(ev(5, 'android', 'launched', '3.4.0', 10)), /unknown kind/);
  assert.match(bad(ev(5, 'android', 'rollout', '3.4.0', null)), /needs a percentage/);
  assert.match(bad(ev(1, 'ios', 'cut', null)), /needs a version/);
  assert.match(bad(ev(5, 'android', 'rollout', '3.4.0', 150)), /not a percentage/);
  // A link that isn't a Slack link is not kept.
  assert.equal(validateEvents({ messages: [{ ...MESSAGES[4], permalink: 'javascript:alert(1)' }], events: [ev(5, 'android', 'rollout', '3.4.0', 10)], apps: [APP] }).kept[0].link, null);
});

test('LifeCycle works the release state out of the events, newest version first', () => {
  const { kept } = validateEvents({ messages: MESSAGES, events: EVENTS, apps: [APP] });
  const ios = foldEvents(kept, 'acme-mobile', 'ios');
  assert.deepEqual(ios.map((v) => [v.version, v.state, v.rollout]), [['3.4.0', 'released', { state: 'gradual', percentage: 20 }]]);
  assert.equal(ios[0].link, link(7));
  const android = foldEvents(kept, 'acme-mobile', 'android');
  assert.deepEqual(android.map((v) => [v.version, v.state, v.rollout]), [['3.4.0', 'released', { state: 'halted', percentage: 50, store_word: 'halted' }]]);
  // A newer version cut while 3.4.0 is out; then 3.4.0 resumed and finished.
  const more = [...kept, { ts: ts(10), at: '', app: 'acme-mobile', platform: 'android', kind: 'cut', version: '3.5.0', rollout_percentage: null, link: null },
    { ts: ts(11), at: '', app: 'acme-mobile', platform: 'android', kind: 'resumed', version: '3.4.0', rollout_percentage: null, link: null },
    { ts: ts(12), at: '', app: 'acme-mobile', platform: 'android', kind: 'rollout', version: '3.4.0', rollout_percentage: 100, link: null }];
  assert.deepEqual(foldEvents(more, 'acme-mobile', 'android').map((v) => [v.version, v.state, v.rollout?.state ?? null, v.rollout?.percentage ?? null]),
    [['3.5.0', 'preparing', null, null], ['3.4.0', 'released', 'complete', 100]]);
});

test('the prompt names the channel, the apps and their hints, and asks only to read', () => {
  const p = slackPrompt({ channel: CHANNEL, apps: [APP], oldestTs: ts(0), threadsSinceTs: ts(0) });
  assert.match(p, /Channel: #mobile-releases/);
  assert.match(p, /- acme-mobile: Acme \(ios, android\)\. iOS messages mention the App Store/);
  assert.match(p, /only to read\. Never post, react or change anything/);
  assert.match(p, /Never guess: use null/);
});

let home;
before(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-slack-')); process.env.LIFECYCLE_HOME = home; });
after(() => fs.rmSync(home, { recursive: true, force: true }));

test('the reader runs Claude with only the read-only Slack tools, outside any project, and keeps no message text', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'));
  const script = path.join(dir, 'claude');
  const record = path.join(dir, 'record.json');
  fs.writeFileSync(path.join(dir, 'answer.json'), answer());
  fs.writeFileSync(script, `#!${process.execPath}\nconst fs = require('fs');\nlet input = '';\nprocess.stdin.on('data', (d) => { input += d; });\nprocess.stdin.on('end', () => {\n  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), input }));\n  process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(dir, 'answer.json'))}, 'utf8'));\n});\n`);
  fs.chmodSync(script, 0o755);
  try {
    let clock = Date.now();
    const reader = createSlackReleaseReader({ cfg: { ...DEFAULTS.sources.slack, enabled: true, command: [script, '-p'] }, now: () => clock });
    const r = await reader.read(CHANNEL, [APP]);
    assert.equal(r.events.length, 9);
    const rec = JSON.parse(fs.readFileSync(record, 'utf8'));
    // Locked down: no built-in tool but ToolSearch, nothing unapproved, the read tools approved, write tools refused.
    assert.deepEqual(rec.args.slice(0, 7), ['-p', '--tools', 'ToolSearch', '--permission-mode', 'dontAsk', '--allowedTools', 'mcp__plugin_slack_slack__slack_read_channel,mcp__plugin_slack_slack__slack_read_thread,mcp__plugin_slack_slack__slack_search_channels']);
    assert.equal(rec.args[7], '--disallowedTools');
    assert.match(rec.args[8], /mcp__plugin_slack_slack__slack_send_message(,|$)/);
    assert.equal(fs.realpathSync(rec.cwd), fs.realpathSync(path.join(home, 'cache')));
    assert.match(rec.input, /Channel: #mobile-releases/);
    // Saved: events and the last message seen, never message text.
    const saved = fs.readFileSync(path.join(home, 'cache', 'slack-releases.json'), 'utf8');
    assert.ok(!saved.includes('crash spike') && !saved.includes('lunch'), 'no message text kept');
    assert.equal((fs.statSync(path.join(home, 'cache', 'slack-releases.json')).mode & 0o777).toString(8), '600');
    // Within the interval: no new run. After it: one run, from the last message seen.
    fs.rmSync(record);
    assert.equal((await reader.read(CHANNEL, [APP])).cached, true);
    assert.ok(!fs.existsSync(record));
    clock += 31 * 60000;
    fs.writeFileSync(path.join(dir, 'answer.json'), answer([], []));
    const again = await reader.read(CHANNEL, [APP]);
    assert.equal(again.events.length, 9, 'earlier events are kept');
    assert.match(JSON.parse(fs.readFileSync(record, 'utf8')).input, new RegExp(`after Slack timestamp ${ts(9).split('.')[0]}`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.join(home, 'cache', 'slack-releases.json'), { force: true });
  }
});

test('Claude missing, a channel it can\'t read, or an answer that isn\'t JSON: an error with the fix, never a state', async () => {
  const cfg = { ...DEFAULTS.sources.slack, enabled: true };
  const fresh = () => fs.rmSync(path.join(home, 'cache', 'slack-releases.json'), { force: true });
  try {
    fresh();
    const missing = createSlackReleaseReader({ cfg: { ...cfg, command: ['claude-not-installed-here', '-p'] } });
    await assert.rejects(missing.read(CHANNEL, [APP]), (e) => e.kind === 'unreachable' && /isn't installed on this machine/.test(e.message));
    fresh();
    const notFound = createSlackReleaseReader({ cfg, run: async () => JSON.stringify({ channel_found: false, messages: [], events: [] }) });
    await assert.rejects(notFound.read(CHANNEL, [APP]), (e) => e.kind === 'no_access' && /couldn't find or read the Slack channel #mobile-releases/.test(e.message));
    for (const bad of ['I could not access Slack, sorry.', 'null', '[1]', JSON.stringify({ messages: 'x', events: {} })]) {
      fresh();
      const r = createSlackReleaseReader({ cfg, run: async () => bad });
      if (bad.startsWith('{')) assert.deepEqual((await r.read(CHANNEL, [APP])).events, [], 'odd shapes read as nothing, never a crash');
      else await assert.rejects(r.read(CHANNEL, [APP]), (e) => e.kind === 'unreachable' && /wasn't the JSON/.test(e.message));
    }
    // After a failure, the next refreshes within the interval don't wait on Claude again.
    fresh();
    let runs = 0;
    const flaky = createSlackReleaseReader({ cfg, run: async () => { runs += 1; return 'nope'; } });
    await assert.rejects(flaky.read(CHANNEL, [APP]));
    await assert.rejects(flaky.read(CHANNEL, [APP]), (e) => /tries again 30 minutes after that failure/.test(e.message));
    assert.equal(runs, 1);
  } finally {
    fresh();
  }
});

test('a timestamp that is not a real Slack one, or in the future, is ignored and never hides later messages', async () => {
  const fresh = () => fs.rmSync(path.join(home, 'cache', 'slack-releases.json'), { force: true });
  fresh();
  try {
    let clock = Date.now();
    let reply = answer([...MESSAGES, { ts: '9999999999.000000', text: 'from the future 9.9.9' }, { ts: 'abc', text: 'odd 1.2.3' }],
      [...EVENTS, { ts: 'abc', app: 'acme-mobile', platform: 'ios', kind: 'cut', version: '1.2.3' }, { ts: '9999999999.000000', app: 'acme-mobile', platform: 'ios', kind: 'cut', version: '9.9.9' }]);
    let prompt = '';
    const r = createSlackReleaseReader({ cfg: { ...DEFAULTS.sources.slack, enabled: true }, now: () => clock, run: async (_cfg, p) => { prompt = p; return reply; } });
    const first = await r.read(CHANNEL, [APP]);
    assert.equal(first.events.length, 9, 'the odd and future ones are dropped');
    clock += 31 * 60000;
    reply = answer([], []);
    await r.read(CHANNEL, [APP]);
    assert.match(prompt, new RegExp(`after Slack timestamp ${ts(9).split('.')[0]}`), 'the next read starts after the newest real message');
    // A new app on the channel: read again from the lookback, so its past releases are found.
    clock += 31 * 60000;
    await r.read(CHANNEL, [APP, { id: 'acme-tv', name: 'Acme TV', platforms: { android: {} }, releaseChannel: { slack: CHANNEL } }]);
    assert.ok(!prompt.includes(`after Slack timestamp ${ts(9)}`), 'from the lookback again');
  } finally {
    fresh();
  }
});

// --- end to end ------------------------------------------------------------------------------------

test('publisher reads Slack and commits snapshots; a teammate without Slack or store access sees them, marked as the team snapshot', async () => {
  const w = await startMobileWorld();
  try {
    w.gh.state.writable.add(DATA);
    const files = w.gh.state.files.get(DATA);
    files.set('apps/acme-mobile.yaml', `${files.get('apps/acme-mobile.yaml')}release_channel:\n  slack: "${CHANNEL}"\n  hint: iOS messages mention the App Store\n`);
    const config = { ...w.config, ai: { provider: 'none' } };
    let runs = 0;
    const slackRun = async () => { runs += 1; return answer(); };

    // The publisher: Slack on, no App Store key.
    const publisher = createApp({ alwaysLive: true, config: { ...config, sources: { ...config.sources, slack: { ...DEFAULTS.sources.slack, enabled: true } } }, token: w.gh.token, storeCredentials: {}, slackRun });
    const snap = await publisher.refresh({ live: true });
    const lm = snap.features.find((f) => f.feature.id === 'mobile-rewards').last_mile;
    const { ios, android } = lm.apps[0].platforms;
    assert.equal(ios.label, 'released in 3.4.0 to 20% of iOS users');
    assert.equal(ios.via, 'slack');
    assert.equal(ios.release_channel, CHANNEL);
    assert.equal(ios.link, link(7));
    assert.equal(ios.from_snapshot, false);
    assert.match(android.label, /halted/);
    assert.equal(android.via, 'slack');
    assert.equal(runs, 1, 'one Claude run for the whole channel');
    // The source names Slack and links the message.
    const src = snap.features.find((f) => f.feature.id === 'mobile-rewards').sources.find((t) => t.key === 'store:acme-mobile:ios');
    assert.equal(src.source, 'slack');
    assert.match(src.links[0].label, /Slack #mobile-releases/);
    // Committed as store snapshots, from Slack, without message text.
    const text = files.get('store-snapshots/acme-mobile-ios.yaml');
    assert.match(text, /^# Written by LifeCycle from the Slack channel #mobile-releases\./);
    assert.match(text, /via: slack/);
    assert.match(text, /rollout_percentage: 20/);
    assert.ok(files.get('store-snapshots/acme-mobile-android.yaml'));
    const repo = [...files.values()].join('\n');
    assert.ok(!/crash spike|lunch|phased release started/.test(repo), 'no message text in the shared repo');

    // A teammate: no Slack, no store key.
    const reader = createApp({ alwaysLive: true, config, token: w.gh.token, storeCredentials: {}, slackRun: async () => assert.fail('a reader never runs Claude') });
    const theirs = await reader.refresh({ live: true });
    const f = theirs.features.find((x) => x.feature.id === 'mobile-rewards');
    const c = f.last_mile.apps[0].platforms.ios;
    assert.equal(c.label, 'released in 3.4.0 to 20% of iOS users');
    assert.equal(c.from_snapshot, true);
    assert.equal(c.via, 'slack');
    assert.equal(c.live_state, 'no_access');
    assert.equal(f.last_mile.state, 'rollout_halted', 'Android is halted at 50%, from the snapshot too');
    assert.equal(f.sources.find((t) => t.key === 'store:acme-mobile:ios').from_snapshot, true);

    // Slack failing on the publisher's machine: the snapshot stands in, with the reason.
    const broken = createApp({ alwaysLive: true, config: { ...config, sources: { ...config.sources, slack: { ...DEFAULTS.sources.slack, enabled: true, intervalMinutes: 0 } } }, token: w.gh.token, storeCredentials: {},
      slackRun: async () => 'not json' });
    const b = (await broken.refresh({ live: true })).features.find((x) => x.feature.id === 'mobile-rewards').last_mile.apps[0].platforms.ios;
    assert.equal(b.from_snapshot, true);
    assert.match(b.message, /wasn't the JSON/);

    // The dry run: prints what it understood and dropped, commits nothing.
    const commits = w.gh.state.commits.length;
    const lines = [];
    const code = await slackCheck({ argv: ['--days', '14'], config, token: w.gh.token, run: async () => answer(), out: (l) => lines.push(l) });
    const printed = lines.join('\n');
    assert.equal(code, 0);
    assert.match(printed, /#mobile-releases: the last 14 days/);
    assert.match(printed, /acme-mobile iOS {2}rollout 20%/);
    assert.match(printed, /Dropped.*\n.*version 3\.9\.9 is not written in the message/);
    assert.match(printed, /acme-mobile iOS: users get 3\.4\.0 \(20%\)/);
    assert.match(printed, /acme-mobile Android: users get 3\.4\.0 \(halted at 50%\)/);
    assert.match(printed, /lifecycle setup --extras/);
    assert.equal(w.gh.state.commits.length, commits, 'the dry run commits nothing');
  } finally {
    await w.close();
  }
});

test('an app definition with a malformed release channel is reported, not used', async () => {
  const { validateApp } = await import('../src/definitions.js');
  const base = 'id: a\nname: A\nrepo: o/r\nplatforms:\n  ios: { store: app_store, store_id: "1" }\n';
  assert.deepEqual(validateApp('apps/a.yaml', `${base}release_channel:\n  slack: "#mobile-releases"\n`).app.releaseChannel, { slack: '#mobile-releases', hint: null });
  assert.deepEqual(validateApp('apps/a.yaml', `${base}release_channel:\n  slack: C0123ABCD\n`).app.releaseChannel, { slack: 'C0123ABCD', hint: null });
  assert.match(validateApp('apps/a.yaml', `${base}release_channel:\n  slack: "mobile releases"\n`).errors[0].message, /channel name like "#mobile-releases"/);
  assert.match(validateApp('apps/a.yaml', `${base}release_channel: "#x"\n`).errors[0].message, /must be a mapping/);
});

test('a bare number is never a version: "halted at 3%" can\'t become version 3', () => {
  const messages = [{ ts: ts(1), text: 'Acme iOS 4.1.0 halted at 3% rollout' }];
  const { kept, dropped } = validateEvents({ messages, apps: [APP], events: [
    { ts: ts(1), app: 'acme-mobile', platform: 'ios', kind: 'released', version: '3' },
    { ts: ts(1), app: 'acme-mobile', platform: 'constructor', kind: 'halted', version: '4.1.0' },
    { ts: ts(1), app: 'acme-mobile', platform: 'ios', kind: 'halted', version: '4.1.0', rollout_percentage: 3 },
  ] });
  assert.equal(kept.length, 1);
  assert.deepEqual(dropped.map((d) => d.reason), ['"3" is not a version', 'acme-mobile has no constructor platform']);
});

test('store snapshots: a Slack read never replaces a recent store read, and read-only people write nothing', async () => {
  const { commitSnapshots, SNAPSHOT_MAX_AGE_MS } = await import('../src/stores/snapshots.js');
  const now = Date.now();
  const writes = [];
  const github = { request: async (url, opts = {}) => { if (opts.method === 'PUT') writes.push(url); else { const e = new Error('nf'); e.status = 404; throw e; } } };
  const config = { dataRepo: 'acme/LifeCycle-Data', dataBranch: 'main' };
  const fromSlack = { app: 'acme-mobile', platform: 'ios', store: 'app_store', store_id: '1', version: '3.4.0', state: 'released', released_version: '3.4.0', rollout_state: 'gradual', rollout_percentage: 20, via: 'slack', read_at: new Date(now).toISOString() };
  const storeSnap = { ...fromSlack, rollout_percentage: 50, via: 'store', read_at: new Date(now - SNAPSHOT_MAX_AGE_MS).toISOString() };
  let r = await commitSnapshots({ config, github, reads: [fromSlack], existing: [storeSnap], now });
  assert.equal(r[0].outcome, 'unchanged', 'the store read (from someone with store access) stands');
  const oldStore = { ...storeSnap, read_at: new Date(now - 3 * SNAPSHOT_MAX_AGE_MS).toISOString() };
  r = await commitSnapshots({ config, github, reads: [fromSlack], existing: [oldStore], now, canWrite: async () => false });
  assert.equal(r[0].outcome, 'read_only');
  assert.equal(writes.length, 0, 'no write tried without write access');
  r = await commitSnapshots({ config, github, reads: [fromSlack], existing: [oldStore], now });
  assert.equal(r[0].outcome, 'committed', 'once nobody keeps the store read up to date, Slack takes over');
});
