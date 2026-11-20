// The two refresh buttons: "Refresh View" re-reads the shared repo only; "Refresh Data" reads every
// source live. Refresh Data is for everyone (pull request, GitHub Actions and deploy results live
// only on each machine), but only people with write access to LifeCycle-Data save flag, store and
// Jira snapshots there. Read-only people and local-data-folder users never try to write.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startWorld, DATA, CATALOG } from './last-mile-fixture.js';
import { createApp } from '../src/app.js';
import { DEFAULTS } from '../src/config.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT_DIRS = ['flag-snapshots/', 'store-snapshots/', 'jira-snapshots/'];
const TICKET = { key: 'BOOK-1', summary: 'Ticket', status: 'In Review', status_category: 'In Progress', assignee: null, created: '2026-10-01T10:00:00Z', updated: '2026-11-10T10:00:00Z', resolved: null, url: 'https://acme.atlassian.net/browse/BOOK-1' };
const jiraRun = async (cfg, prompt) => {
  const keys = prompt.match(/^Tickets: (.*)$/m)[1].split(', ');
  return JSON.stringify({ site_url: 'https://acme.atlassian.net', tickets: keys.filter((k) => k === TICKET.key).map(() => TICKET), missing: keys.filter((k) => k !== TICKET.key) });
};

// --- labels ----------------------------------------------------------------------------------------

function filesUnder(dir, exts) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return filesUnder(p, exts);
    return exts.some((x) => e.name.endsWith(x)) ? [p] : [];
  });
}

test('the toolbar shows one "Refresh View" and one "Refresh Data" button, each with its tooltip', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const button = (id) => html.match(new RegExp(`<button id="${id}"[^>]*>[\\s\\S]*?</button>`))[0];
  assert.match(button('refresh'), /title="Re-reads the shared repo only\. The status from the sources stays as last read; press Refresh Data to read them again\."/);
  assert.match(button('refresh'), /<span class="lbl">Refresh View<\/span>/);
  assert.match(button('refresh-data'), /title="Reads PRs, deploys, flags, stores, Slack and Jira live \(Slack and Jira through Claude, which uses tokens\)\."/);
  assert.match(button('refresh-data'), /<span class="lbl">Refresh Data<\/span>/);
  assert.equal(html.match(/>Refresh View</g).length, 1);
  assert.equal(html.match(/>Refresh Data</g).length, 1);
  for (const id of ['refresh', 'refresh-data']) assert.doesNotMatch(button(id), /\bdisabled\b/, `${id} doesn't start disabled`);
});

test('no UI source or user-facing doc still says "Refresh data" or names a bare "Refresh" button', () => {
  const files = [
    ...filesUnder(path.join(ROOT, 'public'), ['.html', '.js', '.css']),
    ...filesUnder(path.join(ROOT, 'src'), ['.js']),
    ...filesUnder(path.join(ROOT, 'docs'), ['.md']),
    path.join(ROOT, 'README.md'),
  ];
  const bad = [];
  for (const f of files) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      // "Refresh" capitalised as a name, not followed by View or Data (e.g. "press Refresh.").
      // An instruction to "refresh" in lower case ("and refresh.", "next refresh.") must name the button.
      const instruction = /\b(press|and|then|or|next) refresh\b(?! (view|data)\b)/i;
      // Code comments are for developers, not users: leave them out of that check.
      const text = /^\s*(\/\/|\*)/.test(line) ? '' : line.replace(/\/\*.*?\*\/|<!--.*?-->|\s\/\/\s.*$/g, '');
      if (/Refresh data/.test(line) || /\bRefresh\b(?! (View|Data)\b)/.test(line) || instruction.test(text)) bad.push(`${path.relative(ROOT, f)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(bad, []);
});

// --- who can press Refresh Data ---------------------------------------------------------------------

let w, home;
before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-refresh-buttons-'));
  process.env.LIFECYCLE_HOME = home;
  w = await startWorld();
  w.gh.state.writable.add(DATA);
  w.gh.state.files.get(DATA).set('features/ticketed.yaml', [
    'id: ticketed', 'name: Ticketed', 'owner: Catalog team', 'services: []', 'flags: []', 'steps:',
    `  - { id: development, name: Development, owner: "@dev", done_when: ticket done, evidence: [{ source: jira, type: ticket, key: ${TICKET.key} }] }`,
  ].join('\n') + '\n');
});
after(async () => { await w.close(); fs.rmSync(home, { recursive: true, force: true }); });

const configWith = (extra = {}) => {
  const c = w.configFor('statsig');
  return { ...c, ai: { provider: 'none' }, sources: { ...c.sources, jira: { ...DEFAULTS.sources.jira, enabled: true, intervalMinutes: 0 } }, ...extra };
};
const app = (extra) => createApp({ config: configWith(extra), token: w.gh.token, statsigApiKey: w.st.apiKey, jiraRun });
const step = (snap, id) => snap.features.find((f) => f.feature.id === id).steps[0];
const snapshotCommits = (from) => w.gh.state.commits.slice(from).filter((c) => SNAPSHOT_DIRS.some((d) => c.path.startsWith(d)));

test('a read-only person can press Refresh Data: sources are read live, nothing is written to the shared repo', async () => {
  w.gh.state.readOnlyLogins.add('cy');
  const login = w.gh.state.login;
  w.gh.state.login = 'cy';
  const pr7 = w.gh.state.prs.get(`${CATALOG}#7`);
  const from = w.gh.state.commits.length;
  try {
    const first = await app().refresh({ live: true });
    assert.equal(first.sources_read.live, true);
    assert.notEqual(step(first, 'reader-redesign').state, 'done', 'PR 7 is open');

    // PR 7 merges: Refresh View doesn't see it (no live read), Refresh Data does.
    w.gh.state.prs.set(`${CATALOG}#7`, { ...pr7, state: 'closed', merged_at: '2026-11-18T12:00:00Z', merge_commit_sha: 'aaa7' });
    w.gh.state.runs.set(`${CATALOG}@aaa7`, [{ name: 'CI', status: 'completed', conclusion: 'success', html_url: 'https://github.com/x/actions/runs/700' }]);
    const view = await app().refresh();
    assert.equal(view.sources_read.live, false);
    assert.equal(step(view, 'reader-redesign').state, step(first, 'reader-redesign').state);
    const again = await app().refresh({ live: true });
    assert.equal(again.sources_read.live, true);
    assert.ok(Date.parse(again.sources_read.read_at) >= Date.parse(first.sources_read.read_at));
    assert.equal(step(again, 'reader-redesign').state, 'done', 'the merge shows after Refresh Data');
    assert.equal(step(again, 'ticketed').evidence[0].detail, 'In Review', 'Jira was read live too');

    assert.deepEqual(again.flag_snapshots, { committed: [], failed: [] });
    assert.deepEqual(snapshotCommits(from), [], 'no flag, store or Jira snapshot commits from a read-only person');
  } finally {
    w.gh.state.login = login;
    w.gh.state.readOnlyLogins.delete('cy');
    w.gh.state.prs.set(`${CATALOG}#7`, pr7);
    w.gh.state.runs.delete(`${CATALOG}@aaa7`);
  }
});

test('a person with write access still commits flag and Jira snapshots on Refresh Data', async () => {
  const from = w.gh.state.commits.length;
  const snap = await app().refresh({ live: true });
  assert.equal(snap.sources_read.live, true);
  assert.ok(snap.flag_snapshots.committed.length > 0);
  assert.ok(snap.jira_snapshots.committed.length > 0);
  const paths = snapshotCommits(from).map((c) => c.path);
  assert.ok(paths.some((p) => p.startsWith('flag-snapshots/')));
  assert.ok(paths.some((p) => p.startsWith('jira-snapshots/')));
});

test('a local data folder: Refresh Data reads live and writes nothing to the folder or to GitHub', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-refresh-folder-'));
  for (const [p, text] of w.gh.state.files.get(DATA)) {
    if (SNAPSHOT_DIRS.some((d) => p.startsWith(d))) continue;
    fs.mkdirSync(path.join(dir, path.dirname(p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), text);
  }
  const listing = () => filesUnder(dir, ['']).map((f) => [path.relative(dir, f), fs.readFileSync(f, 'utf8')]).sort();
  const before = listing();
  const from = w.gh.state.commits.length;
  try {
    const snap = await app({ dataPath: dir }).refresh({ live: true });
    assert.equal(snap.sources_read.live, true);
    assert.equal(step(snap, 'ticketed').evidence[0].detail, 'In Review');
    assert.deepEqual(w.gh.state.commits.slice(from), [], 'nothing committed to GitHub');
    assert.deepEqual(listing(), before, 'the folder is untouched');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
