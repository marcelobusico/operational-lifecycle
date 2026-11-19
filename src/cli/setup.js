// Interactive first-run setup, in plain language: the shared repo and GitHub access, then optional
// extras (branch, feature flags (Statsig by default, or Flagsmith), AI provider, owner names, app store access, Slack release channels, Jira). Re-runnable: current answers are the defaults.
// Writes ~/.lifecycle/config.json and ~/.lifecycle/credentials.json (mode 600). Nothing is
// written inside this folder or the shared repo.
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig, saveConfig, saveCredentials, paths, homeDir, githubToken, githubAccess, ghConfigDir, ghWorksAtLogin, flagsmithKey, statsigKey, aiKey, storeCredentials, findGhCli, findCli } from '../config.js';
import { normalizeSiteUrl } from '../sources/jira.js';
import { createAppStoreConnector, ACCESS_NEEDED } from '../stores/app-store.js';
import { createStatsigConnection, wrongKeyMessage, statsigKeyKind, CONSOLE_KEYS_URL } from '../sources/statsig.js';
import { TEAM_FILE, FLAG_PLATFORMS, FLAG_PLATFORM_NAME, parseTeam, teamFlagPlatform, chosenFlagPlatform, FALLBACK_FLAG_PLATFORM } from '../team.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
// In a real terminal readline redraws "prompt + typed text" on every keystroke, so each question is
// set as readline's prompt (a plain write would be wiped, leaving only readline's default "> ").
// While muted (secrets) only the prompt is redrawn, never what is typed or pasted.
let muted = false;
rl._writeToOutput = (s) => {
  if (!muted) return rl.output.write(s);
  const prompt = rl.getPrompt();
  if (prompt && s.startsWith(prompt)) rl.output.write(prompt);
};

// Lines are queued so answers piped in all at once are not lost.
const lines = [];
const waiting = [];
rl.on('line', (line) => (waiting.length ? waiting.shift()(line) : lines.push(line)));
// Once input has ended (answers piped in), every further question takes its default.
let closed = false;
rl.on('close', () => { closed = true; waiting.splice(0).forEach((resolve) => resolve('')); });
const nextLine = () => (lines.length ? Promise.resolve(lines.shift()) : new Promise((r) => waiting.push(r)));

// Prints all but the last line of the question, and makes the last line readline's prompt.
function showPrompt(text) {
  if (closed) { process.stdout.write(`${text}\n`); return; }
  const parts = text.split('\n');
  const last = parts.pop();
  if (parts.length) rl.output.write(`${parts.join('\n')}\n`);
  rl.setPrompt(last);
  rl.prompt(true);
}

async function ask(question, fallback = '') {
  const suffix = fallback ? ` [${fallback}]` : '';
  showPrompt(`${question}${suffix}: `);
  return (await nextLine()).trim() || fallback;
}

async function askSecret(question) {
  muted = true;
  showPrompt(`${question}: `);
  const answer = await nextLine();
  muted = false;
  rl.output.write('\n');
  return answer.trim();
}

// The GitHub CLI's full path when it is installed and signed in, else null. The full path is saved
// because LifeCycle runs at login with a minimal PATH that may not include where gh lives.
const GH_ENV_ONLY = [
  '   ! gh works in this Terminal only through GITHUB_TOKEN (or GH_TOKEN). LifeCycle runs at login without',
  '     your Terminal\'s environment, so it would have no GitHub access. Give gh its own login, then run setup again:',
  '       env -u GITHUB_TOKEN -u GH_TOKEN gh auth login',
  '     Or type n below and paste a token instead.',
];

function hasSavedGithubAccess() {
  try {
    const c = JSON.parse(fs.readFileSync(paths.credentials(), 'utf8'));
    return Boolean(c?.github?.token || c?.github?.useGhCli);
  } catch {
    return false;
  }
}

function ghCliPath() {
  const gh = findGhCli();
  if (!gh) return null;
  try {
    execFileSync(gh, ['auth', 'token'], { stdio: 'ignore' });
    return gh;
  } catch {
    return null;
  }
}

async function check(apiUrl, token, route) {
  const res = await fetch(`${apiUrl}${route}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15000),
  });
  return { status: res.status, body: res.ok ? await res.json().catch(() => ({})) : {} };
}

const TOKEN_URL = 'https://github.com/settings/tokens/new?description=LifeCycle%20on%20my%20Mac&scopes=repo';
const yes = (answer) => /^y(es)?$/i.test(answer);

// "owner/name", also accepting a pasted GitHub link (https://github.com/owner/name or .git).
function normalizeRepo(input) {
  const m = String(input).trim().match(/^(?:https?:\/\/github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

async function setupRepo(config) {
  console.log('1. Shared feature repo');
  console.log(config.dataRepo
    ? '   The GitHub repo where your team keeps its list of features. Press Return to keep the one shown.'
    : '   The GitHub repo where your team keeps its list of features (owner/name). If your team has none yet, create an empty repo on GitHub first.');
  for (let tries = 0; tries < 3; tries++) {
    const repo = normalizeRepo(await ask('   Shared repo', config.dataRepo || ''));
    if (repo) { config.dataRepo = repo; return; }
    console.log('   That doesn\'t look like a GitHub repo. Type it as owner/name (e.g. your-org/LifeCycle-Data) or paste its GitHub link.');
  }
  if (config.dataRepo) console.log(`   Keeping ${config.dataRepo}.`);
  else console.log('   No shared repo set yet. Run setup again when you have one (or set LIFECYCLE_DATA_REPO).');
}

// Asks for GitHub access until GitHub accepts it (3 tries). Saves it only when it works or GitHub
// can't be reached right now; returns false when no working access was saved.
async function setupGithub(config) {
  const apiUrl = config.sources.github.apiUrl;
  console.log('\n2. GitHub access');
  console.log('   LifeCycle reads your team\'s features, issues and pull requests on GitHub as you.');
  console.log(`   Your access is saved only on this Mac (${paths.credentials()}, readable only by you).`);
  // Access that only exists in this Terminal (GITHUB_TOKEN in the shell, nothing saved) doesn't count:
  // LifeCycle at login wouldn't have it.
  const saved = githubAccess().source;
  const envOnly = githubToken() && /environment/.test(githubAccess().source || '') && !hasSavedGithubAccess();
  if (envOnly) {
    console.log(`   You are connected here through ${saved}, but only in this Terminal: LifeCycle runs at login`);
    console.log('   without it. Choose how LifeCycle connects on its own:');
  } else if (githubToken()) {
    const keep = await ask('   You are already connected to GitHub. Press Return to keep that, or type n to change it', 'y');
    if (!/^n/i.test(keep)) return verifyGithub(config, githubToken(), apiUrl);
  }
  const ghPath = ghCliPath();
  if (ghPath) {
    const atLogin = ghWorksAtLogin(ghPath);
    if (!atLogin) for (const line of GH_ENV_ONLY) console.log(line);
    const useGh = await ask(`   The GitHub command-line app (gh) is signed in on this Mac. Press Return to use it${atLogin ? '' : ' anyway'}, or type n to paste a token instead`, atLogin ? 'y' : 'n');
    if (!/^n/i.test(useGh)) {
      const dir = ghConfigDir();
      saveCredentials({ github: { useGhCli: true, ghPath, ...(dir ? { ghConfigDir: dir } : {}) } });
      return verifyGithub(config, githubToken(), apiUrl);
    }
  }
  console.log('\n   You need a GitHub token (a password just for LifeCycle). It takes about a minute:');
  console.log(`   a. Open ${TOKEN_URL}`);
  console.log('   b. Sign in to GitHub if it asks. Keep the ticked "repo" box, pick an expiration (90 days is fine),');
  console.log('      scroll down and click "Generate token".');
  console.log('   c. Copy the token (it starts with ghp_) and paste it below.');
  console.log('   ("repo" is needed because the shared repo is private; LifeCycle only reads, except when you');
  console.log('   register a change yourself.)');
  if (process.stdin.isTTY && process.platform === 'darwin') {
    const go = await ask('   Press Return to open that page in your browser (or type skip if you already have a token)', '');
    if (!/^s/i.test(go)) {
      try { execFileSync('open', [TOKEN_URL], { stdio: 'ignore' }); } catch { /* the link is printed above */ }
    }
  }
  for (let tries = 0; tries < 3; tries++) {
    const token = await askSecret('   Paste your token here and press Return (nothing shows while you paste; that is normal)');
    if (!token) {
      console.log('   Nothing was pasted. Copy the token on the GitHub page, click here and press Command-V, then Return.');
      continue;
    }
    const result = await checkGithub(config, token, apiUrl);
    if (result === 'rejected') {
      console.log('   ! GitHub did not accept that token. It may be incomplete or expired: copy it again, or make a new one.');
      continue;
    }
    saveCredentials({ github: { token } });
    return result === 'ok' || result === 'unreachable';
  }
  console.log('\nGitHub access was not saved. Run setup again when you have a token:');
  console.log(`   ${setupCommand()}`);
  return false;
}

async function verifyGithub(config, token, apiUrl) {
  if (!token) {
    console.log('   ! The saved GitHub access does not work any more (for gh: run "gh auth login"). Run setup again and choose to change it.');
    return false;
  }
  return (await checkGithub(config, token, apiUrl)) !== 'rejected';
}

// ok | no_repo | rejected | unreachable, each explained in plain words.
async function checkGithub(config, token, apiUrl) {
  const user = await check(apiUrl, token, '/user').catch(() => null);
  if (!user) {
    console.log('   ! Could not reach GitHub to check your access (no internet?). It is saved; LifeCycle will use it once you are online.');
    return 'unreachable';
  }
  if (user.status === 401) return 'rejected';
  if (user.status !== 200) {
    console.log(`   ! GitHub answered with an error (HTTP ${user.status}). Your access is saved; if LifeCycle shows "no access", run setup again.`);
    return 'unreachable';
  }
  const login = user.body.login ? ` as ${user.body.login}` : '';
  if (!config.dataRepo) {
    console.log(`   ✓ Connected to GitHub${login}. No shared repo is set yet, so LifeCycle has no features to show.`);
    return 'no_repo';
  }
  const repo = await check(apiUrl, token, `/repos/${config.dataRepo}`).catch(() => null);
  if (repo?.status === 200) {
    console.log(`   ✓ Connected to GitHub${login}. You can read ${config.dataRepo}.`);
    return 'ok';
  }
  console.log(`   ! Connected to GitHub${login}, but you can't see ${config.dataRepo} yet.`);
  console.log(`     Ask its owner to invite your GitHub user${login ? ` (${user.body.login})` : ''}, accept the invitation GitHub emails you,`);
  console.log('     then open LifeCycle again (no need to redo setup). If you are using a token, make sure "repo" was ticked.');
  return 'no_repo';
}

function setupCommand() {
  const installed = path.join(homeDir(), 'bin', 'lifecycle');
  return fs.existsSync(installed) ? `${installed} setup` : 'npm run setup';
}

// The extras only. npm needs "--" before an option meant for the script.
function extrasCommand() {
  const cmd = setupCommand();
  return cmd.startsWith('npm ') ? `${cmd} -- --extras` : `${cmd} --extras`;
}

async function main() {
  const config = loadConfig();
  const extrasOnly = process.argv.includes('--extras');
  const firstRun = !fs.existsSync(paths.config());
  console.log(firstRun
    ? 'Welcome to LifeCycle. Two questions and you are done.'
    : 'LifeCycle setup. Press Return to keep each current answer.');
  console.log(`Your answers stay on this Mac, in ${homeDir()}. Nothing is sent anywhere except GitHub, to check your access.\n`);
  // LifeCycle at login has a short PATH; it adds this Terminal's folders so Claude Code (and a sign-in
  // helper it runs), gh and git are found as here. Saved with the first answer below.
  if (process.env.PATH) config.toolPath = process.env.PATH;

  let connected = true;
  if (!extrasOnly) {
    await setupRepo(config);
    saveConfig(config);
    connected = await setupGithub(config);
  }
  const team = await readTeamDefault(config);
  const extras = extrasOnly || yes(await ask(
    `\nOptional extras: feature flags (${FLAG_PLATFORM_NAME[team.platform]}, your team's platform), AI answers, your owner names for the digest, and App Store access for mobile releases.\n`
    + 'Most people skip these now and add them later. Type y to set them up now, or press Return to skip', 'n'));
  if (extras) {
    config.dataBranch = await ask('\nBranch of the shared repo to read (Return keeps it)', config.dataBranch);
    saveConfig(config);
    await setupFlags(config, team);
    await setupAi(config);
    await setupMe(config);
    await setupAppStore(config);
    await setupSlack(config);
    await setupJira(config);
  }
  if (!extras) followTeamFlags(config, team);
  saveConfig(config);
  console.log(connected ? '\n✓ Setup is done.' : '\nSetup is saved, but GitHub access still needs fixing (see above).');
  console.log(`To change any answer later, run: ${setupCommand()}${extras ? '' : `   (or ${extrasCommand()} for the optional extras only)`}`);
  if (!connected) process.exitCode = 2;
}

// The team's default flag platform, from team.yaml in the shared repo (src/team.js). Falls back to
// Statsig when the file isn't there or can't be read right now (and says so).
async function readTeamDefault(config) {
  const where = config.dataPath ? `${config.dataPath}/${TEAM_FILE}` : `${TEAM_FILE} in ${config.dataRepo}`;
  let text = null;
  try {
    if (!config.dataPath && !config.dataRepo) {
      text = null;
    } else if (config.dataPath) {
      const file = path.join(config.dataPath, TEAM_FILE);
      text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    } else {
      const token = githubToken();
      const res = await fetch(`${config.sources.github.apiUrl}/repos/${config.dataRepo}/contents/${TEAM_FILE}?ref=${encodeURIComponent(config.dataBranch)}`, {
        headers: { accept: 'application/vnd.github.raw+json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(15000),
      });
      text = res.ok ? await res.text() : res.status === 404 ? '' : null;
    }
  } catch { text = null; }
  if (text === null) return { platform: FALLBACK_FLAG_PLATFORM, where, read: false, source: `${where} couldn't be read, so LifeCycle's default` };
  const team = parseTeam(text).team;
  return { platform: teamFlagPlatform(team), where, read: true,
    source: team.flag_platform ? where : `no flag_platform in ${where} yet, so LifeCycle's default` };
}

// Without the extras: nothing to ask, the team's platform is used unless the person chose one.
function followTeamFlags(config, team) {
  const chosen = chosenFlagPlatform(config);
  if (chosen) {
    console.log(`\nFeature flags: ${FLAG_PLATFORM_NAME[chosen]} (your own choice; your team's default is ${FLAG_PLATFORM_NAME[team.platform]}).`);
    return;
  }
  const before = config.flagPlatform;
  config.flagPlatform = team.platform;
  config.flagPlatformSource = 'team';
  console.log(`\nFeature flags: ${FLAG_PLATFORM_NAME[team.platform]}, your team's default (${team.source}).`);
  if (before && before !== team.platform) console.log(`   Your setup had never picked a flag platform, so LifeCycle was reading ${FLAG_PLATFORM_NAME[before] || before}. It now reads ${FLAG_PLATFORM_NAME[team.platform]}.`);
  const hasKey = team.platform === 'statsig' ? statsigKey() : flagsmithKey();
  if (!hasKey) console.log(`   To see flag status, add your ${FLAG_PLATFORM_NAME[team.platform]} key: ${extrasCommand()}`);
}

// Which flag platform this person's LifeCycle reads: the team's (from team.yaml) unless they
// pick another. Only this local choice changes; the last mile, chat, digest and alerts work the
// same with either. Typing a platform is a deliberate choice that a later team change won't override.
async function setupFlags(config, team) {
  const chosen = chosenFlagPlatform(config);
  const current = chosen || team.platform;
  console.log('\nFeature flags, for the "done vs. turned on" status.');
  console.log(`Your team reads flags from ${FLAG_PLATFORM_NAME[team.platform]} (${team.source}). Press Return to use ${FLAG_PLATFORM_NAME[current]}.`);
  let answer = '';
  for (let tries = 0; tries < 3; tries++) {
    showPrompt(`Flag platform (${FLAG_PLATFORMS.join(' or ')}; "-" skips) [${current}]: `);
    answer = (await nextLine()).trim().toLowerCase();
    if (!answer || answer === '-' || FLAG_PLATFORMS.includes(answer)) break;
    console.log(`"${answer}" isn't a flag platform LifeCycle reads. Type ${FLAG_PLATFORMS.join(' or ')}.`);
    answer = '';
  }
  if (answer === '-') {
    console.log('Skipped. Features that use flags will show their flags as "status unavailable" until you set this up.');
    return;
  }
  if (answer) {
    config.flagPlatform = answer;
    config.flagPlatformSource = 'chosen';
  } else {
    config.flagPlatform = current;
    config.flagPlatformSource = chosen ? 'chosen' : 'team';
  }
  saveConfig(config);
  if (config.flagPlatform === 'statsig') await setupStatsig(config);
  else await setupFlagsmith(config);
}

// Statsig, read over Statsig's own MCP server. That server only accepts a Console API key
// (console-…); a Server Secret key (secret-…) gets a 403 "only accepts an active CONSOLE key". The
// key is checked live before it is saved, stays in credentials.json (mode 600) and is never printed.
async function setupStatsig(config) {
  const st = config.sources.statsig;
  console.log('\nStatsig. LifeCycle reads your feature gates through Statsig\'s MCP server, which needs a Console API key');
  console.log(`(it starts with console-). Create one at ${CONSOLE_KEYS_URL}: Settings → Keys & Environments → Console API Keys`);
  console.log('→ Generate New Key. Read-only is enough: LifeCycle never writes to Statsig. A Server Secret key (secret-…)');
  console.log('or a Client SDK key (client-…) will not work.');
  const existing = statsigKey();
  let gates = null;
  let saved = false;
  for (let tries = 0; tries < 3 && !saved; tries++) {
    const typed = await askSecret(existing ? 'Statsig Console API key (input hidden; Enter keeps the current one, "-" skips)' : 'Statsig Console API key (input hidden; Enter skips)');
    if (typed === '-' || (!typed && !existing)) {
      console.log('Skipped. Features that use flags will show their flags as "status unavailable" until you run setup again.');
      return;
    }
    const key = typed || existing;
    if (wrongKeyMessage(key)) {
      const kind = statsigKeyKind(key) === 'secret' ? 'a Server Secret key (secret-…)' : 'a Client SDK key (client-…)';
      console.log(`! ${typed ? 'That' : 'The saved key'} is ${kind}, not a Console API key. Statsig's MCP server only accepts a Console API key (console-…).`);
      console.log(`  Create one at ${CONSOLE_KEYS_URL} (Settings → Keys & Environments → Console API Keys → Generate New Key; read-only is enough) and paste it here.`);
      continue;
    }
    try {
      gates = await createStatsigConnection({ mcpUrl: st.mcpUrl, apiKey: key, timeoutMs: st.timeoutMs }).listGates();
    } catch (err) {
      if (err.reason === 'unreachable') {
        console.log(`! ${err.message.replace(/ LifeCycle tries again.*$/, '')} The key is saved; LifeCycle will use it once Statsig answers.`);
      } else {
        console.log(`! ${err.message.replace(/ Fix: .*$/, '')} Try again with a Console API key from ${CONSOLE_KEYS_URL}.`);
        continue;
      }
    }
    if (typed) saveCredentials({ statsig: { apiKey: typed } });
    saved = true;
  }
  if (!saved) {
    console.log(`Statsig was not set up. Run ${extrasCommand()} again when you have a Console API key.`);
    return;
  }
  st.environments.qa = await ask('Statsig environment for QA', st.environments.qa);
  st.environments.production = await ask('Statsig environment for production', st.environments.production);
  saveConfig(config);
  if (gates) console.log(`✓ Connected to Statsig: ${gates.length} feature gate${gates.length === 1 ? '' : 's'} readable (QA = ${st.environments.qa}, production = ${st.environments.production}).`);
}

// Flag console (Flagsmith) for the last-mile check (done vs. turned on). Optional: without it, features that
// use flags show "status unavailable" for their flags.
async function setupFlagsmith(config) {
  const fs = config.sources.flagsmith;
  console.log('\nFlag console (Flagsmith), for the "done vs. turned on" status.');
  console.log('Create an Organisation API key in Flagsmith: Organisation settings → API Keys (read is enough).');
  const existing = flagsmithKey();
  const key = await askSecret(existing ? 'Flagsmith API key (input hidden; Enter keeps the current one, "-" skips)' : 'Flagsmith API key (input hidden; Enter skips)');
  if (key === '-' || (!key && !existing)) {
    console.log('Skipped. Features that use flags will show their flags as "status unavailable" until you run setup again.');
    return;
  }
  if (key) saveCredentials({ flagsmith: { apiKey: key } });
  fs.apiUrl = await ask('Flagsmith API URL', fs.apiUrl);
  const apiKey = flagsmithKey();
  const get = async (route) => {
    const res = await fetch(`${fs.apiUrl}${route}`, { headers: { authorization: `Api-Key ${apiKey}`, accept: 'application/json' } });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    return res.json();
  };
  let projects;
  try {
    const body = await get('/projects/');
    projects = Array.isArray(body) ? body : body.results || [];
  } catch (err) {
    console.log(err.status === 401 || err.status === 403
      ? '! Flagsmith did not accept the API key. Create an Organisation API key and run setup again.'
      : `! Flagsmith could not be reached (${err.message}).`);
    saveConfig(config);
    return;
  }
  if (!projects.length) {
    console.log('! The key works, but it can\'t see any Flagsmith project. Ask the flag console owner for access.');
    saveConfig(config);
    return;
  }
  projects.forEach((p) => console.log(`  ${p.id}  ${p.name}`));
  const fallback = String(fs.projectId || (projects.length === 1 ? projects[0].id : ''));
  fs.projectId = Number(await ask('Flagsmith project id', fallback)) || null;
  fs.environments.qa = await ask('Flagsmith environment name for QA', fs.environments.qa);
  fs.environments.production = await ask('Flagsmith environment name for production', fs.environments.production);
  saveConfig(config);
  try {
    const envBody = await get(`/environments/?project=${fs.projectId}`);
    const names = (Array.isArray(envBody) ? envBody : envBody.results || []).map((e) => e.name);
    const missing = Object.values(fs.environments).filter((n) => !names.includes(n));
    if (missing.length) console.log(`! Project ${fs.projectId} has no environment named ${missing.map((n) => `"${n}"`).join(', ')} (it has: ${names.join(', ') || 'none'}).`);
    else console.log(`✓ Connected to Flagsmith project ${fs.projectId} (${Object.values(fs.environments).join(', ')}).`);
  } catch (err) {
    console.log(`! Could not read the environments of project ${fs.projectId} (${err.message}).`);
  }
}

// Ask & digest: which AI provider answers on this machine. The key stays in credentials.json.
// Claude Code's full path as found from this Terminal (whose PATH has nvm, Homebrew…), saved so
// LifeCycle at login, with a short PATH, runs the same one. A full path the person set is kept.
function claudeCommand(current) {
  const cmd = Array.isArray(current) && current.length ? current : ['claude', '-p'];
  if (cmd[0].includes('/')) return { cmd, bin: fs.existsSync(cmd[0]) ? cmd[0] : null };
  const bin = findCli(cmd[0]);
  return { cmd: bin ? [bin, ...cmd.slice(1)] : cmd, bin };
}
function savedAiKey(provider) {
  try { return JSON.parse(fs.readFileSync(paths.credentials(), 'utf8'))?.ai?.[provider]?.apiKey?.trim() || null; } catch { return null; }
}

async function setupAi(config) {
  console.log('\nAI provider for "ask", the digest and the feature review (claude, claude-code, openai-compatible, command, none).');
  console.log('claude-code uses your Claude Code login (no API key); claude needs an Anthropic API key.');
  console.log('Answers are always built from LifeCycle\'s own data; the AI only reads the question and writes the first line.');
  const provider = await ask('Provider', config.ai.provider);
  config.ai.provider = provider;
  if (provider === 'claude') {
    // A key only in this Terminal's environment isn't seen by LifeCycle at login: offer to save it.
    const fromEnv = (process.env.LIFECYCLE_AI_API_KEY || process.env.ANTHROPIC_API_KEY || '').trim();
    const saved = savedAiKey('claude');
    let key = null;
    if (fromEnv && fromEnv !== saved && yes(await ask(`Use the ${process.env.LIFECYCLE_AI_API_KEY ? 'LIFECYCLE_AI_API_KEY' : 'ANTHROPIC_API_KEY'} set in this Terminal? LifeCycle at login doesn't see your Terminal, so it is saved for it (y/n)`, 'y'))) key = fromEnv;
    else key = await askSecret(saved ? 'Anthropic API key (input hidden; Enter keeps the saved one)' : 'Anthropic API key (input hidden; Enter skips: answers use LifeCycle\'s rules until you add one)');
    if (key) saveCredentials({ ai: { claude: { apiKey: key } } });
    config.ai.model = (await ask('Model (Enter for the default)', config.ai.model || '')) || null;
  } else if (provider === 'claude-code') {
    const { cmd, bin } = claudeCommand(config.ai.command);
    if (bin) config.ai.command = cmd;
    if (bin) console.log(`✓ Claude Code found (${bin}); LifeCycle runs that one. It answers with your Claude login, with no tools or connectors.`);
    else console.log('! Claude Code was not found. Install it and sign in (run "claude" once in Terminal); until then answers use LifeCycle\'s rules.');
    config.ai.model = (await ask('Model (Enter for Claude Code\'s default)', config.ai.model || '')) || null;
  } else if (provider === 'openai-compatible') {
    config.ai.apiUrl = await ask('Base URL (e.g. http://localhost:11434/v1)', config.ai.apiUrl || '');
    config.ai.model = await ask('Model', config.ai.model || '');
    const key = await askSecret('API key (input hidden; Enter if none)');
    if (key) saveCredentials({ ai: { 'openai-compatible': { apiKey: key } } });
  } else if (provider === 'command') {
    const cmd = await ask('Command that reads the prompt on stdin and prints JSON (e.g. claude -p)', (config.ai.command || []).join(' '));
    config.ai.command = cmd.split(' ').filter(Boolean);
  }
  saveConfig(config);
}

// App releases announced in a Slack channel, read on this Mac through Claude Code (signed in to Slack).
// Only the person who reads Slack turns this on; everyone else sees the result in LifeCycle-Data.
async function setupSlack(config) {
  const cfg = config.sources.slack;
  console.log('\nApp releases from Slack (optional). If your team announces app releases (versions cut, rollout %) in a');
  console.log('Slack channel, this Mac can read it through Claude Code, signed in to Slack, and share what it finds with the');
  console.log('team in the shared repo. One person is enough: everyone else sees the shared result.');
  cfg.enabled = yes(await ask('Read Slack release channels on this Mac? (y/n)', cfg.enabled ? 'y' : 'n'));
  if (cfg.enabled) {
    const { cmd, bin: claude } = claudeCommand(cfg.command);
    if (claude) cfg.command = cmd;
    console.log(claude ? `   ✓ Claude Code found (${claude}); LifeCycle runs that one.` : '   ! Claude Code wasn\'t found on this Mac. Install it and sign in to Slack in it (/mcp), or Slack can\'t be read.');
    console.log('   Name the channel in apps/<app>.yaml (release_channel: { slack: "#your-channel" }), then check what is read with:');
    console.log('     lifecycle slack-check');
  }
  saveConfig(config);
}

// Jira tickets as step evidence, read on this Mac through Claude Code (signed in to Atlassian).
// Only the person who reads Jira turns this on; everyone else sees the result in LifeCycle-Data.
async function setupJira(config) {
  const cfg = config.sources.jira;
  console.log('\nJira (optional). Steps can link Jira tickets ({ source: jira, type: ticket, key: ABC-123 }); a ticket counts as');
  console.log('done when its status is Done or Closed. This Mac can read them through Claude Code, signed in to Atlassian, and');
  console.log('share what it finds with the team in the shared repo. One person is enough: everyone else sees the shared result.');
  cfg.enabled = yes(await ask('Read Jira tickets on this Mac? (y/n)', cfg.enabled ? 'y' : 'n'));
  if (cfg.enabled) {
    const { cmd, bin: claude } = claudeCommand(cfg.command);
    if (claude) cfg.command = cmd;
    console.log(claude ? `   ✓ Claude Code found (${claude}); LifeCycle runs that one.` : '   ! Claude Code wasn\'t found on this Mac. Install it, add Atlassian (claude mcp add --transport http atlassian https://mcp.atlassian.com/v2/mcp) and sign in with /mcp.');
    const site = await ask('Your Jira site, if your account sees several (e.g. https://your-site.atlassian.net; Return to skip)', cfg.siteUrl || '');
    cfg.siteUrl = normalizeSiteUrl(site);
    if (site && !cfg.siteUrl) console.log(`   ! "${site}" isn't a Jira site address, so it was left out (any of your sites is used).`);
    console.log('   Check what is read with: lifecycle jira-check');
  }
  saveConfig(config);
}

// Who you are, so the digest knows which features you own.
async function setupMe(config) {
  console.log('\nYour digest covers features you own or follow. Owner names you answer to in feature definitions,');
  const owners = await ask('comma-separated (e.g. @yourhandle, Catalog team)', config.me.owners.join(', '));
  config.me.owners = owners.split(',').map((x) => x.trim()).filter(Boolean);
  saveConfig(config);
}

// App Store Connect, for the release status of features that ship in an iOS app. The API key (issuer
// id, key id and the .p8 private key's contents) goes to ~/.lifecycle/credentials.json (mode 600)
// only: never to config.json, the shared repo, the logs or the browser. Google Play isn't connected yet.
async function setupAppStore(config) {
  const existing = storeCredentials().app_store;
  console.log('\nApp Store (iOS). LifeCycle reads app versions, review state and phased-release % from App Store Connect');
  console.log(`with your own API key: ${ACCESS_NEEDED}. Create one in App Store Connect → Users and Access → Integrations →`);
  console.log('App Store Connect API, and download its .p8 file (Apple lets you download it once). Google Play isn\'t connected yet.');
  const go = await ask(existing ? 'Change your App Store Connect key? Type y to change it, or press Return to keep it' : 'Set it up now? Type y, or press Return to skip', 'n');
  if (!yes(go)) {
    if (!existing) console.log(`App Store not set up: iOS releases show "no access" with this fix. Run ${extrasCommand()} when you have a key.`);
    return;
  }
  const issuerId = await ask('Issuer ID (shown above the keys list)');
  const keyId = await ask('Key ID');
  const file = await ask('Path to the .p8 file (e.g. ~/Downloads/AuthKey_XXXX.p8)');
  let privateKey;
  try {
    privateKey = fs.readFileSync(file.replace(/^~(?=\/)/, process.env.HOME || ''), 'utf8').trim();
  } catch (err) {
    console.log(`! That file can't be read (${err.code || err.message}). Nothing was saved.`);
    return;
  }
  if (!issuerId || !keyId || !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey)) {
    console.log('! An issuer id, a key id and a .p8 private key are all needed. Nothing was saved.');
    return;
  }
  saveCredentials({ appStore: { issuerId, keyId, privateKey } });
  console.log(`✓ Saved to ${paths.credentials()} (only readable by you). Keep the downloaded .p8 somewhere safe, or delete it.`);
  // A quick read to check the key: app id 0 doesn't exist, so an accepted key answers "unknown app".
  try {
    const connector = createAppStoreConnector({ cfg: config.sources.appStore, credentials: { issuerId, keyId, privateKey } });
    await connector.readApp('0', 'ios');
    console.log('✓ App Store Connect accepted the key.');
  } catch (err) {
    console.log(`! ${err.message} The key is saved; LifeCycle will use it once App Store Connect accepts it.`);
  }
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
