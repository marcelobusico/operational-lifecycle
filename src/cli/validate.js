// Checks feature definition files against the format, before they're published to the shared
// repo. Usage: npm run validate -- <file-or-folder> [...]
// With a folder (e.g. a LifeCycle-Data checkout) it also checks dependencies and projects across files.
import fs from 'node:fs';
import path from 'node:path';
import { parseDefinitions } from '../definitions.js';
import { dependencyIssues } from '../graph.js';

const args = process.argv.slice(2);
if (!args.length) {
  console.error('Usage: npm run validate -- <feature.yaml | LifeCycle-Data folder> [...]');
  process.exit(2);
}

const files = [];
for (const arg of args) {
  if (!fs.statSync(arg).isDirectory()) {
    const parent = path.basename(path.dirname(path.resolve(arg)));
    const sub = ['projects', 'services', 'teams', 'apps', 'changes'].includes(parent) ? parent : 'features';
    files.push({ path: `${sub}/${path.basename(arg)}`, text: fs.readFileSync(arg, 'utf8') });
    continue;
  }
  // A LifeCycle-Data checkout (projects/ + services/ + apps/ + features/ + changes/) or a folder of feature files.
  for (const n of ['team.yaml', 'team.yml']) {
    if (fs.existsSync(path.join(arg, n))) files.push({ path: n, text: fs.readFileSync(path.join(arg, n), 'utf8') });
  }
  const subs = ['projects', 'services', 'teams', 'apps', 'features', 'changes'].filter((s) => fs.existsSync(path.join(arg, s)));
  for (const sub of subs.length ? subs : ['.']) {
    const dir = path.join(arg, sub);
    for (const n of fs.readdirSync(dir).filter((x) => /\.ya?ml$/.test(x)).sort()) {
      files.push({ path: `${sub === '.' ? 'features' : sub}/${n}`, text: fs.readFileSync(path.join(dir, n), 'utf8') });
    }
  }
}

const { features, projects, services, teams, apps, changes, team, invalid, invalidIds } = parseDefinitions(files);
for (const e of invalid) console.log(`✗ ${e.file}: ${e.field} ${e.message}`);
if (files.some((f) => /^team\.ya?ml$/.test(f.path)) && !invalid.some((e) => /^team\.ya?ml$/.test(e.file))) {
  console.log(`✓ team.yaml: flag platform ${team.flag_platform || '(not set: statsig)'}`);
}
for (const p of projects) console.log(`✓ ${p.file}: project ${p.id}`);
for (const t of teams) console.log(`✓ ${t.file}: team ${t.id} "${t.name}" (owns ${Object.entries(t.owns).filter(([, v]) => v.length).map(([k, v]) => `${v.length} ${k}`).join(', ') || 'nothing yet'})`);
for (const s of services) console.log(`✓ ${s.file}: service ${s.id} (${s.repo}; qa=${s.environments.qa}, production=${s.environments.production})`);
for (const a of apps) console.log(`✓ ${a.file}: app ${a.id} (${a.repo}; ${Object.entries(a.platforms).map(([p, x]) => `${p}=${x.store}:${x.store_id}`).join(', ')})`);
for (const f of features) console.log(`✓ ${f.file}: ${f.id} (${f.steps.length} steps${f.project ? `, project ${f.project}` : ''})`);
for (const c of changes) console.log(`✓ ${c.file}: ${c.state === 'done' ? '' : `${c.state} `}${c.kind} change for ${c.features.join(', ')} by ${c.registered_by}`);
if (files.length > 1 && changes.length) {
  const known = new Set([...features.map((f) => f.id), ...invalidIds]);
  for (const c of changes) for (const f of c.features) if (!known.has(f)) console.log(`! ${c.id}: registered change for unknown feature "${f}"`);
}

const crossFeature = files.length > 1;
const issues = crossFeature ? dependencyIssues(features, invalidIds) : new Map();
for (const [id, list] of issues) for (const i of list) console.log(`! ${id}: ${i.message}`);
if (crossFeature && projects.length) {
  const known = new Set(projects.map((p) => p.id));
  for (const f of features) if (f.project && !known.has(f.project)) console.log(`! ${f.id}: unknown project "${f.project}": no file projects/${f.project}.yaml is defined`);
}

// Even with no services/ folder at all: a listed service nobody defines shows "status unavailable".
if (crossFeature) {
  const known = new Set(services.map((s) => s.id));
  for (const f of features) for (const s of f.services) if (!known.has(s)) console.log(`! ${f.id}: unknown service "${s}": no file services/${s}.yaml is defined`);
  const knownApps = new Map(apps.map((a) => [a.id, a]));
  for (const f of features) for (const a of f.apps || []) {
    const def = knownApps.get(a.id);
    if (!def) { console.log(`! ${f.id}: unknown app "${a.id}": no file apps/${a.id}.yaml is defined`); continue; }
    for (const p of Object.keys(a.firstVersion)) if (!def.platforms[p]) console.log(`! ${f.id}: app ${a.id} has no ${p} platform in apps/${a.id}.yaml`);
  }
}

process.exitCode = invalid.length ? 1 : 0;
