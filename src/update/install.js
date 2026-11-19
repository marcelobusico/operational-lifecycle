// What this copy of LifeCycle is and which `main` commit it runs.
//   installed: the Mac install (~/.lifecycle/app, made by install.sh). The app can upgrade it.
//   developer: a git working copy run with `npm start`. Checked only: the app never overwrites it.
//   manual:    any other folder (e.g. an unzipped copy run by hand). Checked only.
// The installed commit comes from installed-commit.json, written by install.sh and by every upgrade
// (a GitHub ZIP knows its commit through .lifecycle-source, see .gitattributes). A working copy asks git.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homeDir } from '../config.js';

export const APP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RECORD = 'installed-commit.json';
export const SOURCE_REPO = () => process.env.LIFECYCLE_SOURCE_REPO || 'marcelobusico/operational-lifecycle';
export const SOURCE_BRANCH = 'main';
const SHA = /^[0-9a-f]{40}$/;

const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };

export function installKind({ appRoot = APP_ROOT, home = homeDir() } = {}) {
  if (fs.existsSync(path.join(appRoot, '.git'))) return 'developer';
  const app = real(path.join(home, 'app'));
  return app && app === real(appRoot) ? 'installed' : 'manual';
}

export function readRecord(appRoot = APP_ROOT) {
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(appRoot, RECORD), 'utf8'));
    return SHA.test(rec.commit) ? { commit: rec.commit, date: rec.date || null } : null;
  } catch {
    return null;
  }
}

function gitHead(appRoot) {
  try {
    const out = execFileSync('git', ['-C', appRoot, 'log', '-1', '--format=%H %cI'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
    const [commit, date] = out.split(' ');
    return SHA.test(commit) ? { commit, date: date || null } : null;
  } catch {
    return null;
  }
}

// { kind, commit, date } — commit and date are null when this copy doesn't say.
export function installInfo({ appRoot = APP_ROOT, home = homeDir() } = {}) {
  const kind = installKind({ appRoot, home });
  const at = kind === 'developer' ? gitHead(appRoot) : readRecord(appRoot);
  return { kind, commit: at?.commit || null, date: at?.date || null };
}

export function writeRecord(dir, { commit, date }) {
  fs.writeFileSync(path.join(dir, RECORD), JSON.stringify({ commit, date, installed_at: new Date().toISOString() }, null, 2) + '\n');
}
