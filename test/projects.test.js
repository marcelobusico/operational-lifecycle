import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDefinitions } from '../src/definitions.js';
import { computeStatuses } from '../src/status.js';
import { projectStatuses } from '../src/projects.js';

const project = (id, extra = '') => ({ path: `projects/${id}.yaml`, text: `id: ${id}\nname: ${id} name\n${extra}` });
const feature = (id, { proj, deps = [], pr } = {}) => ({
  path: `features/${id}.yaml`,
  text: `id: ${id}\nname: ${id} name\nowner: team\n${proj ? `project: ${proj}\n` : ''}depends_on: [${deps.join(', ')}]\nsteps:${pr
    ? `\n  - { id: dev, name: Dev, owner: dev-owner, done_when: merged, evidence: [{ source: github, type: pr, repo: o/r, number: ${pr} }] }` : ' []'}\n`,
});
const read = (states) => async (e) => ({ ...e, link: `https://github.com/o/r/pull/${e.number}`, state: states[e.number], readAt: new Date().toISOString() });

async function run(files, states = {}) {
  const { features, projects, invalid, invalidIds } = parseDefinitions(files);
  const statuses = await computeStatuses({ features, projects, invalidIds, read: read(states) });
  return { invalid, statuses, projects: Object.fromEntries(projectStatuses(projects, statuses).map((p) => [p.project.id ?? 'none', p])) };
}

test('features are grouped by project with a rolled-up state', async () => {
  const { projects, statuses } = await run([
    project('rewards-project'), project('location-project'),
    feature('rewards', { proj: 'rewards-project', pr: 1 }),
    feature('redeem', { proj: 'rewards-project', deps: ['rewards'], pr: 2 }),
    feature('capture', { proj: 'location-project', pr: 3 }),
  ], { 1: 'in_progress', 2: 'in_progress', 3: 'done' });
  assert.deepEqual(projects['rewards-project'].features.sort(), ['redeem', 'rewards']);
  assert.equal(projects['rewards-project'].state, 'blocked');
  assert.equal(projects['rewards-project'].counts.blocked, 1);
  assert.equal(projects['rewards-project'].blockers[0].owner, 'dev-owner');
  assert.equal(projects['location-project'].state, 'done');
  assert.equal(projects.none, undefined, 'no "No project" group when every feature has one');
  assert.deepEqual(statuses.find((s) => s.feature.id === 'redeem').project, { id: 'rewards-project', name: 'rewards-project name' });
});

test('dependencies across projects are listed on both projects', async () => {
  const { projects } = await run([
    project('platform'), project('rewards-project'),
    feature('api', { proj: 'platform', pr: 1 }),
    feature('rewards', { proj: 'rewards-project', deps: ['api'], pr: 2 }),
  ], { 1: 'done', 2: 'in_progress' });
  assert.deepEqual(projects['rewards-project'].depends_on_outside, [{ id: 'api', project: 'platform' }]);
  assert.deepEqual(projects.platform.depended_on_from_outside, [{ id: 'rewards', project: 'rewards-project' }]);
});

test('features without a project, or with an unknown one, go to "No project"; unknown is a warning', async () => {
  const { projects, statuses } = await run([project('p'), feature('loose'), feature('typo', { proj: 'nope' })]);
  assert.deepEqual(projects.none.features.sort(), ['loose', 'typo']);
  assert.equal(projects.none.project.name, 'No project');
  assert.equal(projects.p.state, 'not_started', 'empty project shows the empty state');
  const typo = statuses.find((s) => s.feature.id === 'typo');
  assert.equal(typo.warnings[0].kind, 'unknown_project');
  assert.match(typo.warnings[0].message, /"nope"/);
});

test('an invalid project file is reported with file and field; features still display', async () => {
  const { invalid, statuses } = await run([{ path: 'projects/bad.yaml', text: 'id: bad\n' }, feature('f', { proj: 'bad' })]);
  assert.deepEqual(invalid, [{ file: 'projects/bad.yaml', field: 'name', message: 'is required' }]);
  assert.equal(statuses.length, 1);
});

test('a project can have its own target date; a malformed one is reported', async () => {
  const { projects, invalid } = await run([project('p', 'target_date: 2027-03-31\n'), project('q'), project('bad', 'target_date: next spring\n'), feature('f', { proj: 'p' })]);
  assert.equal(projects.p.project.target_date, '2027-03-31');
  assert.equal(projects.q.project.target_date, null);
  assert.deepEqual(invalid, [{ file: 'projects/bad.yaml', field: 'target_date', message: 'must be a date as YYYY-MM-DD' }]);
});
