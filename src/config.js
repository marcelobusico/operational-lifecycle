// Local configuration and credentials. Everything here lives in the person's own
// LifeCycle home (~/.lifecycle by default), outside any repository.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chosenFlagPlatform } from './team.js';

export const DEFAULTS = {
  // The shared feature repo (owner/name) on GitHub. Every team creates its own; there is no default,
  // so `npm run setup` asks for it (or set LIFECYCLE_DATA_REPO).
  dataRepo: null,
  dataBranch: 'main',
  // Optional: read definitions from a local folder instead of GitHub (useful offline or while
  // drafting a definition). Leave null to read from dataRepo.
  dataPath: null,
  port: 4317,
  // Where LifeCycle reads feature flags: 'statsig' or 'flagsmith'. null = the team default,
  // set once in the shared repo (LifeCycle-Data/team.yaml, see src/team.js). A person can still pick
  // their own in `npm run setup` (flagPlatformSource: 'chosen') or with LIFECYCLE_FLAG_PLATFORM;
  // everything downstream works the same either way.
  flagPlatform: null,
  // 'chosen' (picked in setup) | 'team' (follows team.yaml) | null (nothing chosen: team default).
  flagPlatformSource: null,
  sources: {
    github: { enabled: true, apiUrl: 'https://api.github.com' },
    // Flag console for the last-mile check (done vs. turned on). projectId and the API key are set per person
    // by `npm run setup`; environment names map LifeCycle's QA/production to Flagsmith's.
    flagsmith: {
      enabled: true,
      apiUrl: 'https://api.flagsmith.com/api/v1',
      appUrl: 'https://app.flagsmith.com',
      projectId: null,
      environments: { qa: 'QA', production: 'Production' },
    },
    // Statsig, read over Statsig's own MCP server with the person's Console API key (credentials.json).
    // environments maps LifeCycle's QA/production to Statsig environment names.
    statsig: {
      enabled: true,
      mcpUrl: 'https://api.statsig.com/v3/mcp',
      consoleUrl: 'https://console.statsig.com',
      environments: { qa: 'staging', production: 'production' },
      timeoutMs: 15000,
    },
    // App stores (src/stores/): one entry per store LifeCycle can read. Credentials live in
    // credentials.json (appStore: issuerId, keyId, privateKey), never here. App Store Connect has no
    // official MCP server (checked 2026-11-05), so it's read through its official REST API behind the
    // same tool-style connection; set mcpUrl to read it from an MCP server offering the same tools instead.
    appStore: {
      enabled: true,
      apiUrl: 'https://api.appstoreconnect.apple.com',
      consoleUrl: 'https://appstoreconnect.apple.com',
      mcpUrl: null,
      timeoutMs: 15000,
    },
    // App releases read from a Slack channel (src/stores/slack-releases.js), for apps whose
    // apps/<app>.yaml names a release_channel. LifeCycle has no Slack app of its own: it asks Claude
    // Code (`command`), signed in to Slack on this machine, to read the channel with read-only tools
    // (`tools`, the only ones it may use) and return the release events. Off unless this machine is
    // the one that reads Slack; everyone else sees the result in store-snapshots/.
    slack: {
      enabled: false,
      command: ['claude', '-p'],
      tools: ['mcp__plugin_slack_slack__slack_read_channel', 'mcp__plugin_slack_slack__slack_read_thread', 'mcp__plugin_slack_slack__slack_search_channels'],
      intervalMinutes: 30, // read the channel at most this often; refreshes in between reuse the last read
      lookbackDays: 90,    // how far back the first read goes
      timeoutMs: 300000,
    },
    // Jira tickets as step evidence (src/sources/jira.js), read the same way: through Claude Code
    // signed in to Atlassian's MCP server (https://mcp.atlassian.com/v2/mcp, added to Claude Code as
    // "atlassian"), with only the read-only tools below. Off unless this machine is the one that
    // reads Jira; everyone else sees the result in jira-snapshots/.
    jira: {
      enabled: false,
      command: ['claude', '-p'],
      tools: ['mcp__atlassian__getAccessibleAtlassianResources', 'mcp__atlassian__getJiraIssue', 'mcp__atlassian__searchJiraIssuesUsingJql'],
      siteUrl: null,       // e.g. https://your-site.atlassian.net when your account sees several sites
      intervalMinutes: 30,
      timeoutMs: 300000,
    },
  },
  // The alert list (lifecycle.alerts/v1) from the alerts work: a local file path or an http(s) URL.
  alerts: { source: null },
  // Import from links (src/import, docs/import-format.md): how much one analysis reads per source.
  // Anything beyond a cap is skipped and the result says what was left out.
  import: { maxStoriesPerEpic: 25, maxPrsPerRepo: 20, maxIssuesPerRepo: 20, maxDocsPerRepo: 10, maxCharsPerSource: 20000 },
  // Delay warnings: a feature is warned when days left < open steps x daysPerStep.
  delay: { daysPerStep: 3 },
  // Ask & digest. provider: claude (default) | openai-compatible | command | none. The provider's
  // key lives in credentials.json, never here. See docs/ask-format.md.
  ai: {
    provider: 'claude',
    model: null,       // null = the provider's default (claude: claude-opus-5-5)
    apiUrl: null,      // null = the provider's default; openai-compatible needs it (e.g. http://localhost:11434/v1)
    command: null,     // provider "command": a local CLI that reads the prompt on stdin, e.g. ["claude", "-p"]
    timeoutMs: 30000,
  },
  // Who you are, for "features I own" in the digest: the owner names you answer to in definitions
  // (a GitHub handle like "@example-dev" and/or a team like "Catalog team").
  me: { owners: [], github: null },
  // The PATH of the Terminal where setup last ran. LifeCycle at login has a short PATH, so it adds
  // these folders after its own: Claude Code, a sign-in helper it runs, gh and git are found as in Terminal.
  toolPath: null,
  // Days before a target date when a feature that isn't fully on counts as at risk.
  atRiskDays: 14,
};

// The address people open. *.localhost always means this Mac (browsers and macOS resolve it to
// 127.0.0.1 with no setup and no admin password), so the link reads as LifeCycle's own.
export const APP_HOST = 'lifecycle.localhost';
export function appUrl(port = loadConfig().port) {
  return `http://${APP_HOST}:${port}`;
}

export function homeDir() {
  return process.env.LIFECYCLE_HOME || path.join(os.homedir(), '.lifecycle');
}

export const paths = {
  config: () => path.join(homeDir(), 'config.json'),
  credentials: () => path.join(homeDir(), 'credentials.json'),
  cacheDir: () => path.join(homeDir(), 'cache'),
  logFile: () => path.join(homeDir(), 'logs', 'source-reads.log'),
  askLog: () => path.join(homeDir(), 'logs', 'ask.log'),
  historyDir: () => path.join(homeDir(), 'history'),
  follows: () => path.join(homeDir(), 'follows.json'),
  digestState: () => path.join(homeDir(), 'digest-state.json'),
  alertsLog: () => path.join(homeDir(), 'logs', 'alerts.log'),
  alertsSeen: () => path.join(homeDir(), 'alerts-seen.json'),
  outboxDir: () => path.join(homeDir(), 'outbox'),
  notices: () => path.join(homeDir(), 'notices.json'),
  // Update check and upgrade (src/update/): one log line per check or upgrade, and the upgrade's work folder.
  updateLog: () => path.join(homeDir(), 'logs', 'updates.log'),
  updateDir: () => path.join(homeDir(), 'update'),
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`Could not read ${file}: ${err.message}`);
  }
}

export function writeJson(file, value, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', mode ? { mode } : undefined);
  if (mode) fs.chmodSync(file, mode);
}

export function loadConfig() {
  const saved = readJson(paths.config()) || {};
  const config = {
    ...DEFAULTS,
    ...saved,
    sources: {
      github: { ...DEFAULTS.sources.github, ...(saved.sources?.github || {}) },
      flagsmith: {
        ...DEFAULTS.sources.flagsmith,
        ...(saved.sources?.flagsmith || {}),
        environments: { ...DEFAULTS.sources.flagsmith.environments, ...(saved.sources?.flagsmith?.environments || {}) },
      },
      statsig: {
        ...DEFAULTS.sources.statsig,
        ...(saved.sources?.statsig || {}),
        environments: { ...DEFAULTS.sources.statsig.environments, ...(saved.sources?.statsig?.environments || {}) },
      },
      appStore: { ...DEFAULTS.sources.appStore, ...(saved.sources?.appStore || {}) },
      slack: { ...DEFAULTS.sources.slack, ...(saved.sources?.slack || {}) },
      jira: { ...DEFAULTS.sources.jira, ...(saved.sources?.jira || {}) },
    },
    alerts: { ...DEFAULTS.alerts, ...(saved.alerts || {}) },
    import: { ...DEFAULTS.import, ...(saved.import || {}) },
    delay: { ...DEFAULTS.delay, ...(saved.delay || {}) },
    ai: { ...DEFAULTS.ai, ...(saved.ai || {}) },
    me: { ...DEFAULTS.me, ...(saved.me || {}) },
  };
  if (process.env.LIFECYCLE_DATA_REPO) config.dataRepo = process.env.LIFECYCLE_DATA_REPO;
  if (process.env.LIFECYCLE_DATA_PATH) config.dataPath = process.env.LIFECYCLE_DATA_PATH;
  if (process.env.LIFECYCLE_PORT) config.port = Number(process.env.LIFECYCLE_PORT);
  if (process.env.LIFECYCLE_GITHUB_API) config.sources.github.apiUrl = process.env.LIFECYCLE_GITHUB_API;
  if (process.env.LIFECYCLE_GITHUB_ENABLED === 'false') config.sources.github.enabled = false;
  if (process.env.LIFECYCLE_FLAGSMITH_API) config.sources.flagsmith.apiUrl = process.env.LIFECYCLE_FLAGSMITH_API;
  if (process.env.LIFECYCLE_FLAGSMITH_PROJECT) config.sources.flagsmith.projectId = Number(process.env.LIFECYCLE_FLAGSMITH_PROJECT);
  if (process.env.LIFECYCLE_FLAGSMITH_ENABLED === 'false') config.sources.flagsmith.enabled = false;
  if (process.env.LIFECYCLE_FLAG_PLATFORM) {
    config.flagPlatform = process.env.LIFECYCLE_FLAG_PLATFORM.trim().toLowerCase();
    config.flagPlatformSource = 'env';
  }
  if (process.env.LIFECYCLE_STATSIG_MCP_URL) config.sources.statsig.mcpUrl = process.env.LIFECYCLE_STATSIG_MCP_URL;
  if (process.env.LIFECYCLE_STATSIG_ENABLED === 'false') config.sources.statsig.enabled = false;
  if (process.env.LIFECYCLE_APP_STORE_API) config.sources.appStore.apiUrl = process.env.LIFECYCLE_APP_STORE_API;
  if (process.env.LIFECYCLE_APP_STORE_ENABLED === 'false') config.sources.appStore.enabled = false;
  if (process.env.LIFECYCLE_JIRA_ENABLED) config.sources.jira.enabled = process.env.LIFECYCLE_JIRA_ENABLED === 'true';
  if (process.env.LIFECYCLE_SLACK_ENABLED) config.sources.slack.enabled = process.env.LIFECYCLE_SLACK_ENABLED === 'true';
  if (process.env.LIFECYCLE_ALERTS_SOURCE) config.alerts.source = process.env.LIFECYCLE_ALERTS_SOURCE;
  if (process.env.LIFECYCLE_GITHUB_USER) config.me.github = process.env.LIFECYCLE_GITHUB_USER;
  if (process.env.LIFECYCLE_AI_PROVIDER) config.ai.provider = process.env.LIFECYCLE_AI_PROVIDER;
  if (process.env.LIFECYCLE_AI_MODEL) config.ai.model = process.env.LIFECYCLE_AI_MODEL;
  if (process.env.LIFECYCLE_AI_API_URL) config.ai.apiUrl = process.env.LIFECYCLE_AI_API_URL;
  if (process.env.LIFECYCLE_ME) config.me.owners = process.env.LIFECYCLE_ME.split(',').map((x) => x.trim()).filter(Boolean);
  return config;
}

// The env override is never written back: it only lasts as long as the variable is set.
export function saveConfig(config) {
  const out = { ...config };
  if (out.flagPlatformSource === 'env') {
    const saved = readJson(paths.config()) || {};
    out.flagPlatform = saved.flagPlatform ?? null;
    out.flagPlatformSource = saved.flagPlatformSource ?? null;
  }
  writeJson(paths.config(), out);
}

// A saved config that silently defaulted to Flagsmith (or predates the flag platform setting) is
// moved to the team default once: the file then says flagPlatformSource 'team', and a one-time
// notice explains the switch. A deliberate choice is never touched. Returns the notice it raised,
// or null. teamDefault: the flag platform from LifeCycle-Data/team.yaml.
export function migrateSavedFlagPlatform(teamDefault) {
  const saved = readJson(paths.config());
  if (!saved || saved.flagPlatformSource === 'team' || chosenFlagPlatform(saved)) return null;
  const before = saved.flagPlatform || 'flagsmith'; // every config before this setting read Flagsmith
  writeJson(paths.config(), { ...saved, flagPlatform: teamDefault, flagPlatformSource: 'team' });
  if (before === teamDefault) return null;
  const notice = { from: before, to: teamDefault, at: new Date().toISOString(), seen: false };
  saveNotices({ ...readNotices(), flagPlatformSwitched: notice });
  return notice;
}

// One-time notices for this person (notices.json): { <id>: { ..., seen } }.
export function readNotices() {
  return readJson(paths.notices()) || {};
}
function saveNotices(notices) {
  writeJson(paths.notices(), notices);
}
export function markNoticeSeen(id) {
  const all = readNotices();
  if (!all[id]) return false;
  all[id] = { ...all[id], seen: true, seen_at: new Date().toISOString() };
  saveNotices(all);
  return true;
}

// Merges into the existing file, so setting up one source never drops another's credentials.
export function saveCredentials(credentials) {
  const current = readJson(paths.credentials()) || {};
  writeJson(paths.credentials(), { ...current, ...credentials }, 0o600);
}

// The Flagsmith Admin API key (an Organisation API key): environment first, then the local
// credentials file. Returns null when none is set up.
export function flagsmithKey() {
  const fromEnv = process.env.LIFECYCLE_FLAGSMITH_API_KEY;
  if (fromEnv) return fromEnv.trim();
  const creds = readJson(paths.credentials());
  return creds?.flagsmith?.apiKey?.trim() || null;
}

// The Statsig Console API key: environment first, then the local credentials file. null when none.
export function statsigKey() {
  const fromEnv = process.env.LIFECYCLE_STATSIG_API_KEY;
  if (fromEnv) return fromEnv.trim();
  return readJson(paths.credentials())?.statsig?.apiKey?.trim() || null;
}

// App store credentials, per store: { app_store: { issuerId, keyId, privateKey } }. Environment first
// (LIFECYCLE_APP_STORE_ISSUER_ID / _KEY_ID / _PRIVATE_KEY), then credentials.json. A store with no
// credentials is simply absent. Never logged, never sent to the browser or the shared repo.
export function storeCredentials() {
  const creds = readJson(paths.credentials()) || {};
  const out = {};
  const env = process.env;
  const a = env.LIFECYCLE_APP_STORE_PRIVATE_KEY
    ? { issuerId: env.LIFECYCLE_APP_STORE_ISSUER_ID, keyId: env.LIFECYCLE_APP_STORE_KEY_ID, privateKey: env.LIFECYCLE_APP_STORE_PRIVATE_KEY }
    : creds.appStore;
  if (a?.privateKey) out.app_store = { issuerId: String(a.issuerId || '').trim(), keyId: String(a.keyId || '').trim(), privateKey: String(a.privateKey).trim() };
  return out;
}


// The AI provider's key: environment first, then the local credentials file. null when none.
export function aiKey(provider) {
  const env = provider === 'claude'
    ? process.env.LIFECYCLE_AI_API_KEY || process.env.ANTHROPIC_API_KEY
    : process.env.LIFECYCLE_AI_API_KEY || (provider === 'openai-compatible' ? process.env.OPENAI_API_KEY : null);
  if (env) return env.trim();
  const creds = readJson(paths.credentials());
  return creds?.ai?.[provider]?.apiKey?.trim() || null;
}

// PATH for the tools LifeCycle runs: its own PATH first, then the saved Terminal folders not in it.
export function withToolPath(currentPath, toolPath) {
  const own = String(currentPath || '').split(path.delimiter).filter(Boolean);
  const extra = String(toolPath || '').split(path.delimiter).filter((d) => d && path.isAbsolute(d) && !own.includes(d));
  return [...own, ...new Set(extra)].join(path.delimiter);
}

// Where the GitHub CLI is: the path saved by setup, then PATH, then the usual install places
// (Homebrew on Apple Silicon and Intel, ~/.local/bin, MacPorts). LifeCycle runs at login with a
// minimal PATH, so PATH alone is not enough. null when gh is not installed.
export function findGhCli(saved) {
  return findCli('gh', saved);
}

// Where a command-line tool is: `saved`, then PATH, then the usual install places (Claude Code's
// own installer uses ~/.local/bin and ~/.claude/local; npm installs go under nvm, Volta…). null when
// it isn't found.
export function findCli(name, saved = null) {
  const home = os.homedir();
  // Tools installed with npm under a Node version manager (nvm, newest version first), Volta, a
  // user npm prefix or Bun: not on the short PATH LifeCycle has at login.
  let nvm = [];
  try {
    const base = path.join(home, '.nvm', 'versions', 'node');
    nvm = fs.readdirSync(base).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map((v) => path.join(base, v, 'bin'));
  } catch { /* no nvm */ }
  const dirs = [...(process.env.PATH || '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin',
    path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), '/opt/local/bin',
    ...nvm, path.join(home, '.volta', 'bin'), path.join(home, '.npm-global', 'bin'), path.join(home, '.bun', 'bin')];
  for (const candidate of [saved, ...dirs.filter(Boolean).map((d) => path.join(d, name))]) {
    if (!candidate) continue;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* not here */ }
  }
  return null;
}

// Resolves the GitHub token: environment first, then the local credentials file, which either
// holds a token or asks to reuse the GitHub CLI's login. Returns null when none is set up.
// githubAccess() then says where it came from, and why none works, for messages.
let lastAccess = { source: null, problem: 'no GitHub access is set up (run setup)' };
export const githubAccess = () => lastAccess;
export function githubToken() {
  const found = (token, source, problem = null) => { lastAccess = { source, problem: token ? null : problem }; return token || null; };
  if (process.env.LIFECYCLE_GITHUB_TOKEN) return found(process.env.LIFECYCLE_GITHUB_TOKEN.trim(), 'LIFECYCLE_GITHUB_TOKEN from the environment');
  if (process.env.GITHUB_TOKEN) return found(process.env.GITHUB_TOKEN.trim(), 'GITHUB_TOKEN from the environment');
  const creds = readJson(paths.credentials());
  if (creds?.github?.token) return found(creds.github.token.trim(), 'the token saved by setup');
  if (creds?.github?.useGhCli) {
    const source = 'the GitHub CLI (gh) login';
    const gh = findGhCli(creds.github.ghPath);
    if (!gh) return found(null, source, 'gh is not installed where LifeCycle looks');
    try {
      // GH_CONFIG_DIR saved by setup: LifeCycle runs at login without the shell's environment.
      const env = creds.github.ghConfigDir ? { ...process.env, GH_CONFIG_DIR: creds.github.ghConfigDir } : process.env;
      const out = execFileSync(gh, ['auth', 'token'], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      return found(out, source, 'gh printed no token');
    } catch (err) {
      const said = String(err.stderr || err.message || '').trim().split('\n').filter(Boolean).pop() || 'gh auth token failed';
      return found(null, source, `gh said: ${said}`);
    }
  }
  return found(null, null, 'no GitHub access is set up (run setup)');
}

// gh's config folder when the shell moves it (GH_CONFIG_DIR, XDG_CONFIG_HOME), saved for LifeCycle
// at login, which doesn't have the shell's environment.
export const ghConfigDir = () => process.env.GH_CONFIG_DIR || (process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, 'gh') : null);

// True when gh gives a token the way LifeCycle runs at login: no GITHUB_TOKEN / GH_TOKEN and a minimal
// PATH, only HOME (and the saved config folder).
export function ghWorksAtLogin(gh, configDir = ghConfigDir(), run = execFileSync) {
  try {
    const env = { HOME: process.env.HOME, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ...(configDir ? { GH_CONFIG_DIR: configDir } : {}) };
    return Boolean(String(run(gh, ['auth', 'token'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim());
  } catch {
    return false;
  }
}
// For a long-running LifeCycle: the token, read again every 5 minutes, and every 30 seconds while
// none works (e.g. gh was logged in after LifeCycle started), so fixing access needs no restart.
export function liveGithubToken(now = Date.now) {
  let value = null;
  let at = null; // when it was last read
  return () => {
    if (at === null || now() - at > (value ? 300000 : 30000)) { value = githubToken(); at = now(); }
    return value;
  };
}
