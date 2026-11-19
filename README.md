# LifeCycle

<a href="https://taller.ai/chiron"><picture><source media="(prefers-color-scheme: dark)" srcset="public/brand/chiron-white.svg"><img src="public/brand/chiron.svg" alt="Chiron" height="18"></picture></a><br>
<sub>Built with <a href="https://taller.ai/chiron">Chiron by Taller</a></sub>

A live map of every feature: its ordered steps, who owns each one, what it depends on, and what's
blocking it. LifeCycle runs on your own machine and opens in your browser. There is no hosted server.

- **Feature definitions** (owner, steps, dependencies) come from a shared GitHub repo your team
  creates (called *LifeCycle-Data* in these docs; any name works). See
  [Create your shared repo](#create-your-shared-repo-lifecycle-data).
- **Step states** are read live from GitHub (PRs and issues) every time you look, with **your
  own** credentials. Nobody types a status, so it can't go stale, and two people with the same
  access see the same thing.

## Install on a Mac (no developer tools needed)

Follow **[docs/install-mac.md](docs/install-mac.md)**: download the ZIP from GitHub, paste one line
in Terminal (`cd ~/Downloads/operational-lifecycle-main && ./install.sh`), answer two setup questions, and
LifeCycle opens in your browser. The installer brings its own private Node.js (it never touches
your PATH or an existing Node.js), starts LifeCycle when you log in, and adds a **LifeCycle** app.
Already have Node.js 20+? `LIFECYCLE_NODE=system ./install.sh` uses it and its npm instead, with
nothing downloaded ([details](docs/install-mac.md#use-your-own-nodejs-instead)).
It follows your `~/.npmrc` (company registry, proxy), and `LIFECYCLE_CA_FILE=/path/to/root.pem`
trusts a proxy's own root certificate ([details](docs/install-mac.md#company-npm-registry-or-https-proxy)).
To update, click **Check for updates** at the bottom left of the sidebar (above **Theme**): it
compares your copy with the newest commit on `main` using your saved GitHub access, lists what's
new, and updates and restarts LifeCycle after you confirm, keeping your settings. In Terminal,
`~/.lifecycle/bin/lifecycle update` does the same. Uninstall: `~/.lifecycle/bin/lifecycle uninstall`.
A developer copy (a git working copy run with `npm start`) gets the check too, but never updates
itself: it shows the command to pull the changes (`git pull origin main && npm install`).

## Install for developers

You need [Node.js](https://nodejs.org) 20 or newer (`node -v` to check) and git.

```bash
git clone https://github.com/marcelobusico/operational-lifecycle.git
cd operational-lifecycle
npm install
```

## Create your shared repo (LifeCycle-Data)

LifeCycle has no hosted backend: your team's feature definitions live in a GitHub repo you create
(private is fine). These docs call it *LifeCycle-Data*; the name is up to you. Everyone who uses
LifeCycle needs read access to it, and write access to edit features, teams or register changes
from the app.

```
features/<id>.yaml        # one feature: owner, steps (each with done_when and evidence), depends_on, flags, services
projects/<id>.yaml        # a group of features
services/<id>.yaml        # where a service is deployed (repo + QA/production environments)
teams/<id>.yaml           # a team and what it owns (docs/teams-format.md)
apps/<id>.yaml            # optional: mobile apps, their store ids and Slack release channel
changes/<id>.yaml         # registered changes (written by LifeCycle)
store-snapshots/          # app-store / Slack release reads (written by LifeCycle)
flag-snapshots/           # flag reads, for teammates without a flag key (written by LifeCycle)
jira-snapshots/           # Jira ticket reads, for teammates who don't read Jira (written by LifeCycle)
team.yaml                 # optional: team-wide settings, e.g. flag_platform: statsig
```

A step's evidence is what LifeCycle reads to tell whether it is done: GitHub pull requests
(merged with CI passing), GitHub issues (closed as completed) and Jira tickets (status category
Done, or status Done or Closed):

```yaml
evidence:
  - { source: github, type: pr, repo: org/app, number: 12 }
  - { source: github, type: issue, repo: org/app, number: 40 }
  - { source: jira, type: ticket, key: ABC-123 }
```

Jira is read through Claude Code, signed in to Atlassian's MCP server
(`claude mcp add --transport http atlassian https://mcp.atlassian.com/v2/mcp`, then `/mcp` to sign
in), on one person's machine (`lifecycle setup --extras` → Jira). That LifeCycle shares what it reads
in `jira-snapshots/`, so nobody else needs Jira access. `lifecycle jira-check [ABC-123 …]` shows how
tickets are read, without saving anything.

The accepted fields are documented next to the parser in `src/definitions.js`. Check a folder
before pushing with `npm run validate -- <folder>`.

## Set up your credentials and the shared repo

```bash
npm run setup
```

(`~/.lifecycle/bin/lifecycle setup` if you used the Mac installer.) It asks two questions in plain
language, then offers optional extras:

1. **The shared repo**: your team's LifeCycle-Data repo as `owner/name` (a GitHub link works too).
   There is no default: every team creates its own.
2. **GitHub access**, one of:
   - `gh`: reuse your [GitHub CLI](https://cli.github.com) login, offered when `gh` is signed in.
   - a token: setup opens a pre-filled [classic token page](https://github.com/settings/tokens/new?description=LifeCycle%20on%20my%20Mac&scopes=repo)
     (`repo` scope). Fine-grained tokens only reach repos owned by the token's owner, so they can't
     read a private LifeCycle-Data you were invited to as a collaborator. Input is hidden; a token
     GitHub rejects can be re-pasted (three tries).

Optional extras (answer `y`, or run `npm run setup -- --extras` later):

- **Branch** of the shared repo (default `main`).
- **Flag platform**: your team's platform is offered first and is the default (Statsig unless your
  team's `team.yaml` in LifeCycle-Data says otherwise, see [Feature flags: Statsig by default](#feature-flags-statsig-by-default)).
  Press Return to use it, or type the other one. Setup then asks only what that platform needs.
  - **Statsig**:
    paste a **Console API key**, the one that starts with `console-`. Create it at
    https://console.statsig.com/api_keys: **Settings → Keys & Environments → Console API Keys → Generate
    New Key** (read-only is enough; LifeCycle never writes). A **Server Secret key (`secret-…`) or Client
    SDK key (`client-…`) does not work**: Statsig's MCP server answers them with a 403 "only accepts an
    active CONSOLE key". Setup recognizes them and says so in plain words before saving anything. It
    checks the key live and ends with **"✓ Connected to Statsig: N feature gates readable"**, then asks
    which Statsig environments are QA and production (default `staging` and `production`). LifeCycle
    reads Statsig's own MCP server (`https://api.statsig.com/v3/mcp`).
  - **Flagsmith**: paste an **Organisation API key** (Flagsmith → Organisation settings → API Keys;
    view-only is enough), pick the project and confirm the names of its QA and production environments.

  Input is hidden. Keys are saved only in `~/.lifecycle/credentials.json` (mode 600) and are
  redacted from logs, warnings and the browser. Without a key, features that use flags show
  "status unavailable" and Home says which platform's key is missing and how to add it.
- **AI provider** for Ask & digest (`claude` by default) and its key, input hidden.
- **Your owner names** (e.g. `@yourhandle, Catalog team`), so your digest knows which features are yours.

Re-running setup shows your current answers as defaults and keeps your saved access unless you
choose to change it.

If you skip the extras, setup still tells you which flag platform you'll read (your team's) and the
command to add its key.

Setup then checks the connection and tells you if the credentials can't see the shared repo.

Your answers are saved **only on your machine**, in `~/.lifecycle/`:

| File                              | Holds                                                  |
|-----------------------------------|--------------------------------------------------------|
| `~/.lifecycle/config.json`        | shared repo, branch, port, which sources are enabled, your flag platform if you picked one |
| `~/.lifecycle/notices.json`       | one-time notices you dismissed (e.g. "flags are now read from Statsig") |
| `~/.lifecycle/credentials.json`   | your GitHub token (or "use gh") and Flagsmith or Statsig API key, readable only by you (mode 600) |
| `~/.lifecycle/cache/`             | last definitions read, last successful read per PR/issue, deploy record and flag; the last flag state seen (to spot a switch-off) |
| `~/.lifecycle/logs/source-reads.log` | one line per source read (see [Logs](#logs))        |
| `~/.lifecycle/history/`, `digest-state.json`, `follows.json` | your questions, answers, digests and followed features |
| `~/.lifecycle/logs/ask.log`       | one line per question or digest: feature, outcome, provider |

Nothing is ever written to this folder or to the shared repo. LifeCycle only reads the sources.

## Run

```bash
npm start
```

Open **http://lifecycle.localhost:4317** (`*.localhost` always means your own Mac; http://localhost:4317 works too). Press **Refresh** (or reload) to read everything live again.

- **Projects** (home): one card per project with its rolled-up state, how many features are
  blocked or done, and who to push. Features are grouped by the `project` in their definition.
- **Roadmap** (inside a project, or all features): every feature with its state (*done*, *flowing*, *blocked*, *status unavailable*,
  *not started*), owner, current step, and what blocks it with **who to push**. Below it, the
  dependency map.
- **Done vs. turned on** (on each feature page, under **Path to users**): the feature's *last
  mile*: is it actually available to users, and if not, why? States: *not done yet*, *done but not deployed* (naming the service and environment),
  *done but not turned on* (naming the flag), *in experiment – <name>* (groups, shares, what each gets), *partly rolled out – N%*, *fully on* (or *fully on ·
  no flags*), *switched off* (with when and, if Flagsmith records it, who) and *status unavailable*.
  Below each: the version of each service in QA and production, each flag in QA and production,
  version mismatches, unknown flags, and links to the evidence (PR, GitHub Actions run, deploy
  record, flag setting).
- **Feature page** (click a feature): its steps in order, each with owner, the team's
  *done when*, its state and links to the PRs or issues it came from; what's blocking it and
  who to push; what it depends on and what depends on it.

## Ask & digest

Ask LifeCycle how a feature is going, in the app (**Ask & digest**), from your own AI tools, or in the
terminal:

- *How is redeem rewards going?* · *What's blocking X?* · *Is X available to users?* · *Who do I push on X?*
- *create a feature called …* · *move the target date of X to …* · *delete X*: the same chat changes
  feature definitions, after you confirm (see *Adding or changing a feature*).

Every answer is built only from the live status, the registered changes and the alert list, and
every statement links to its evidence (PR, issue, GitHub Actions run, deploy record, flag setting,
registered change, alert). Blockers come with who to push and a suggested message. If the data
doesn't answer it, or the feature isn't defined, it says so; if a name fits several features, it
asks which one; if a source can't be read, it says which part is out of date and when it was last
read.

**Your digest** is produced each time you open LifeCycle: per feature you own or follow, what moved,
what's blocked, what's at risk of missing its date, and what changed in flags, deploys, registered
changes and alerts since your last digest. Follow features from their page. Your owner names
(`me.owners`, asked by `npm run setup`) decide which features count as yours.

**AI provider**: set in `~/.lifecycle/config.json` (`ai.provider`): `claude` (default, an Anthropic
API key), `claude-code` (your Claude Code login, no API key: `claude -p` with no tools or connectors),
any `openai-compatible` endpoint, a local `command`, or `none`. `npm run setup` asks for it; a key is
saved only in `~/.lifecycle/credentials.json`. Switching provider needs no code change. A rejected key
(HTTP 401) is reported as such, with the fix.

**From your AI tools** (Claude Code, Claude Desktop, any MCP client), same answers as the app:

```bash
claude mcp add lifecycle -- node /path/to/LifeCycle/src/mcp.js
```

Tools: `lifecycle_ask` (also creates, edits and deletes features: see *Adding or changing a
feature*), `lifecycle_digest`, `lifecycle_follow`, `lifecycle_features`. In the
terminal: `npm run ask -- "How is redeem rewards going?"` or `npm run ask -- --digest`.

Questions, answers and digests stay on your machine (`~/.lifecycle/history/`, `digest-state.json`,
`follows.json`) and each one is logged in `~/.lifecycle/logs/ask.log` with the feature and outcome,
without tokens. Formats, registered changes (`changes/*.yaml` in LifeCycle-Data) and the alert list:
[docs/ask-format.md](docs/ask-format.md).

## Where "done vs. turned on" is read from

- **Development done**: the PRs linked in the feature's steps are merged and the GitHub Actions
  runs on their merge commits passed.
- **Deployed**: GitHub Deployments. Each service in a feature's `services:` needs a
  `services/<id>.yaml` in LifeCycle-Data naming its repo (and, if they aren't `qa` and
  `production`, its GitHub environment names). A deploy job records a deployment like this:

  ```bash
  id=$(gh api repos/<owner>/<repo>/deployments -f ref=v0.2.0 -f environment=production \
        -F auto_merge=false -f 'required_contexts[]' -f payload='{"version":"0.2.0"}' --jq .id)
  gh api repos/<owner>/<repo>/deployments/$id/statuses -f state=success
  ```

  The latest deployment whose latest status is `success` is what runs in that environment.
- **Turned on**: your team's flag platform (`team.yaml` in LifeCycle-Data), unless you picked
  another one (see below).
  - **Flagsmith**: flag names in a feature's `flags:` must match the Flagsmith feature names. A
    percentage rollout is a segment override whose segment has a "% Split" rule.
  - **Statsig**, over Statsig's MCP server: flag names are feature gate ids (or names). A gate whose
    kill switch is off is off everywhere. Otherwise its rules apply in order to the Statsig
    environment mapped to QA or production (`sources.statsig.environments`; a rule with no
    environments applies to all). The first rule for everyone decides: 100% is on, 1–99% is
    "partly rolled out – N%". Targeted rules before it make it "on only for some segments". When and
    who come from the gate's last modification; a change made with an API key shows as "a Console API key", never the key fragment Statsig records. The link opens the gate in the Statsig console.
- **Released** (features with mobile apps, `apps:` in the definition and `apps/<id>.yaml` in
  LifeCycle-Data): the version and rollout % in the stores. Read, in this order, from App Store
  Connect (when this machine has its API key; Google Play isn't connected yet), from the app's Slack
  release channel, or from the team snapshot. The Slack channel is where a bot or people announce
  versions cut, reviews, releases, rollout % and halts:

  ```yaml
  # LifeCycle-Data/apps/<id>.yaml
  release_channel:
    slack: "#mobile-releases"                      # or the channel id
    hint: "iOS messages mention the App Store"     # optional
  ```

  Create and edit apps (stores, repo, Slack channel and hint) on the **Apps** page in the sidebar:
  each save is a commit of `apps/<id>.yaml` as you, keeping comments; an app is deleted only once no
  feature lists it.

  It is read through Claude Code with Slack connected (the Slack plugin), on one person's machine
  (`lifecycle setup --extras` → Slack). Claude only extracts; LifeCycle keeps a version or % only
  when it is written in the cited message. `lifecycle slack-check [--days 14] [--app <id>]` shows
  what is understood, without saving anything.
- **Experiments** (always Statsig, over the same MCP connection and key): list them under
  `experiments:` in the feature definition, with what the feature does in each group
  (`- id: <experiment id>` and `groups: { Control: …, A: … }`). While one runs in production the
  feature shows **In experiment – <name>** with every group (control and variants), its share, what
  it gets and how users are assigned; start, end and share changes appear on its timeline. A
  Statsig key is needed even when flags come from Flagsmith. Details:
  [docs/status-format.md](docs/status-format.md), "Experiments (Statsig)".

## One person reads, the team sees it (team snapshots)

Not everyone needs every key. The person who has a flag key, App Store key, Slack or Jira in
Claude Code (the *publisher*) turns them on in `lifecycle setup --extras`. Their LifeCycle commits
what it reads to the shared repo (`flag-snapshots/`, `store-snapshots/`, `jira-snapshots/`): when
something changed, or at least every 6 hours while it runs. Everyone else (*readers*) only needs
access to the shared repo: where they can't read a source themselves, they see the snapshot, always
marked **from team snapshot** with when it was read. A reader who has a key gets the live value.

- Snapshots hold states, versions, percentages, ticket statuses and links: never credentials or
  message text.
- They are written only through GitHub, by someone who can write to the shared repo. A LifeCycle
  that reads definitions from a local folder or clone (`LIFECYCLE_DATA_PATH`) never writes them.
- Claude Code runs locked down for Slack and Jira, because what it reads is written by other people:
  no shell, file or web tools, only the read tools LifeCycle approves, connector write tools refused,
  whatever your own Claude settings allow. After a failed read it waits `intervalMinutes` (30)
  before trying again, and the snapshot is shown meanwhile.

Details: [docs/status-format.md](docs/status-format.md).

## Feature flags: Statsig by default

The team's flag platform is set **once**, in the shared repo, so everyone inherits it:

```yaml
# LifeCycle-Data/team.yaml
flag_platform: statsig     # or flagsmith
```

Which platform your LifeCycle reads, strongest first:

1. `LIFECYCLE_FLAG_PLATFORM=statsig|flagsmith` in the environment (not saved).
2. A platform you **typed** in `npm run setup -- --extras` (saved as `flagPlatformSource: "chosen"`).
   Configs from before this setting that have a Flagsmith project set count as having chosen
   Flagsmith, and keep it.
3. Otherwise, the team's `team.yaml` (Statsig when the file is missing). Pressing Return at the
   platform question follows the team, including later changes to `team.yaml`.

A local config that only pointed at Flagsmith because nothing was ever chosen (older installs saved
`flagPlatform: "flagsmith"` without a project) moves to the team's platform on the next Refresh.
Home then shows a one-time notice, **"Feature flags are now read from Statsig"**, until you click
**Got it**.

**To switch platform**, run `npm run setup -- --extras` and type `statsig` or `flagsmith` at the
platform question. Switching is a local setting: no feature definition or code changes.

### Flag warnings on Home and how to fix them

With the platform set up and reachable, Home shows **no** flag warning. Otherwise one banner names
the configured platform (never the other one), says what's wrong and gives the fix:

| Banner | Fix |
|--------|-----|
| **No Statsig key is set up on this machine** | Create a Console API key (`console-…`) at https://console.statsig.com/api_keys, then `npm run setup -- --extras` and paste it. |
| **Wrong kind of Statsig key** | The saved key is a Server Secret (`secret-…`) or Client SDK (`client-…`) key. Create a **Console** API key as above and run setup again. |
| **Statsig refused your key** | The Console key was revoked, expired or is for another project. Create a new one and run setup again. |
| **Statsig can't be reached** (with the last successful read time) | Nothing to change: check your connection; LifeCycle tries again on the next Refresh. |
| **No Flagsmith project is chosen** / **Flagsmith environment not found** (Flagsmith teams only) | `npm run setup -- --extras` and pick the project or fix the QA/production environment names. |

### GitHub access problems on a new Mac

LifeCycle runs at login, **without your Terminal's environment**. Its GitHub access is, in order:
`LIFECYCLE_GITHUB_TOKEN` / `GITHUB_TOKEN` (only when started from a Terminal that has them), the token
saved by setup, or the GitHub CLI's login (`gh auth token`). It is read again while LifeCycle runs, so
fixing it needs no restart (within 30 seconds).

| Message | Fix |
|---------|-----|
| **No GitHub access works for LifeCycle right now (gh said: no oauth token found for github.com)** | gh works in your Terminal only through `GITHUB_TOKEN`. Give gh its own login: `env -u GITHUB_TOKEN gh auth login`, or paste a token with `lifecycle setup`. Setup warns about this case. |
| **… isn't authorized for this organization's single sign-on** | Open the link in the message to authorize the token (for gh: `gh auth refresh -h github.com`). |
| **Your GitHub credentials (…) can't read …** | Check the repo name (`dataRepo` in `~/.lifecycle/config.json`) and that this GitHub account was invited to it. |
| **Claude Code couldn't read … / a command was not found** (AI review, Slack, Jira) | LifeCycle at login has a short PATH. Run `lifecycle setup` (or `setup --extras`) once from your Terminal: it saves Claude Code's full path and your Terminal's PATH, so Claude Code and any sign-in helper it runs (an `apiKeyHelper`, `aws`, `gcloud`…) are found. |
| **This copy of LifeCycle (…) is a download or clone, not your installed LifeCycle** | Run the installed command, `~/.lifecycle/bin/lifecycle`, not `bin/lifecycle` in the folder you downloaded. |

Cards on Home never show a bare "Status unavailable": they say which source couldn't be read (or
which definition is missing, e.g. no `services/<id>.yaml`) and when it was last read.

## Adding or changing a feature

Feature definitions live in LifeCycle-Data (layout: [Create your shared repo](#create-your-shared-repo-lifecycle-data)). There are
two ways to change them, and both go through the same validation and AI product review.

**From LifeCycle** (product managers and anyone with write access to LifeCycle-Data): on a feature
page press **Edit feature**, or **New feature** on the *Roadmap* or on a project's page (which puts
it in that project). **New project** (under the project list in the sidebar) creates `projects/<id>.yaml`
the same way; on its page, **Edit project** renames it (or changes its owner and description; the id stays) and
**Delete project** removes it once no feature is in it. You can change the
name, owner, description, project, target date, steps (each step's owner, team and "done when", plus adding, removing
and reordering steps), dependencies, services and flags.

- **Review changes** shows what will change against the current version, the validation errors
  next to the field at fault, and the AI product review. The review uses the
  `lifecycle-feature-review` rules and the AI provider set up for Ask & digest. Contradictions
  block publishing and ambiguities are suggestions. Without an AI provider the review is reported
  as not run, and a valid definition can still be published.
- **Publish** commits `features/<id>.yaml` straight to LifeCycle-Data `main` with your GitHub
  credentials (no pull request), so the repo history shows who changed what and when. Only the
  fields you changed are touched: a step's evidence and comments are kept.
  Every teammate sees the edit on their next refresh.
- If someone else saved the same feature after you opened it, nothing is overwritten. You're told
  who changed it, your edit is kept on your machine, and **Apply my edit to the latest version**
  re-applies your changed fields on top of theirs.
- If the repo can't be reached, the edit is kept on your machine as *not published yet* and
  published on a later refresh.
- Without write access to LifeCycle-Data you can view everything, and the feature page says why
  you can't edit.
- Deleting a feature that others depend on lists those features before anything is deleted.
- Editing never changes status: status is always read live from the source systems.

**From the chat** (the **Ask LifeCycle** button at the bottom right of every page opens it as a side panel, or `lifecycle_ask` from your own AI tools; same engine, same
rules): say what you want in plain words and the chat proposes it, you confirm, and it is saved
through the same publish path as the form.

- *create a feature called Bonus points on reviews, owned by @ana, depends on redeem rewards*: the
  feature keeps exactly that name and the id derived from it is shown first. The chat asks one
  question at a time for what a valid definition still needs (owner, a first step with its owner
  and "done when") and suggests values where it can (project, services, flags, a target date from
  what it depends on).
- Edits: *move the target date of X to 2027-02-15*, *set the owner of step development of X to
  @bo*, *rename X to …*, *set the description / project of X to …*, *add step QA to X, owned by
  @qa, done when signed off*, *remove step …*, *add / remove dependency, service or flag …*,
  *add ramp condition … to X*, *attach PR #12 in owner/repo to step development of X*.
- Before anything is saved you see the full definition (new feature) or a before/after of only what
  changes, with validation problems named by field and the AI product review. Nothing is
  committed until you say **yes** (or press **Save**); **no** leaves the repo unchanged.
- *delete X*: if other features depend on it, the chat lists them and asks a second time.
- If the name is taken or very close to an existing feature, the chat asks whether you meant it.
- Commits say where they came from: `Edit feature x: target date (by @ana from the LifeCycle chat)`.
  Your GitHub identity is the author; no role is recorded. Conflicts, *not saved yet* when the repo
  can't be reached, and read-only access work exactly as with the form.
- Asking to *mark a step as done* or *update the status* gets the explanation that status is read
  live, and an offer to attach a PR or issue to the step, add a ramp condition, or register a
  change. The chat never changes flags, tickets, deploys or PRs.

**By hand**: add or edit `features/<id>.yaml`, run `npm run validate -- <file>`, then open a PR to
LifeCycle-Data. After it merges, everyone sees
it on their next refresh.

## Status for other tools

```bash
npm run status -- <feature-id>      # live status as JSON, no server needed
curl http://localhost:4317/api/features/<feature-id>/status
curl http://localhost:4317/api/roadmap
curl http://localhost:4317/api/projects/<project-id>/status
curl http://localhost:4317/api/last-mile                    # last mile of every feature
curl http://localhost:4317/api/features/<feature-id>/last-mile
```

The format (steps, owners, blockers, evidence links, last read time) is documented in
[docs/status-format.md](docs/status-format.md).

## When something can't be read

| Situation | What you see |
|-----------|--------------|
| GitHub down, offline, or `sources.github.enabled: false` in `config.json` | affected steps show **status unavailable** with the last successful read time; they are never shown as done or blocked |
| Shared repo unreachable | the last definitions read, with **"Definitions last synced at <time>"** |
| Your credentials can't see a repo | a message naming the repo and the missing access |
| A broken definition file | the file and the field at fault; all other features still display |
| A PR/issue number that doesn't exist | status unavailable, with "*repo* has no pull request #N" |
| Flagsmith, Statsig or GitHub deploy records unreachable | the feature shows **status unavailable** with the last successful read time; never on or off |
| Your Flagsmith or Statsig key, or GitHub credentials, can't read a project, gates, environment or repo | a message naming the source (Flagsmith / Statsig / GitHub) and the missing access; for flags, one Home banner naming the configured platform and the fix (see [Flag warnings](#flag-warnings-on-home-and-how-to-fix-them)) |
| A flag in a definition that the flag platform doesn't have | an **unknown flag** warning naming it (users can't get it, so it counts as off) |
| A service with no `services/<id>.yaml` | an **unknown service** warning; the feature's last mile and its Home card say "Status unavailable · No services/<id>.yaml defines where <id> is deployed". `npm run validate -- <LifeCycle-Data folder>` lists these. |

## Alerts and registered changes

The **Alerts** page lists, for every defined feature, the changes your teammates **registered**
and **delay warnings** (open steps vs. days left before the target date). Each alert names the
feature, what changed, its source, the features that depend on it, and links to evidence. Filter by
source. Alerts
about features you own or depend on, new since you last looked, show as **New** when you open or
refresh LifeCycle.

**Register a change** (Alerts → Register a change): what will change, which features it affects,
planned (with a date) or done, and why. You see who will be notified before publishing. Publishing
commits `changes/<id>.yaml` straight to LifeCycle-Data `main` (your GitHub credentials need write
access); planned changes can be edited or cancelled the same way. If the
repo can't be reached, the change is kept on your machine as *not published yet* and published on a
later refresh. A registered change never changes a feature's status. Formats, matching, conflicts
and the API: [docs/alerts-format.md](docs/alerts-format.md).

## Teams and what they own

Teams are defined once in LifeCycle-Data (`teams/<id>.yaml`): a fixed id, a name, and what the team
owns (repos, ticket sources, services, apps, feature flags). Create, rename, edit and delete them on
the **Teams** page (in the sidebar) or by asking the chat ("create a team called Wishlist that owns the acme-wishlist
repo and the redeem_rewards flag"): the chat shows a preview and saves only when you confirm, as a
commit under your GitHub user. Every feature page shows **Teams it depends on**, each
with its reason and a link (a step's team, the owner of a service, repo, ticket source, flag or app
it touches, or a team of a feature it depends on, followed through to the end). Ask "which teams do I
depend on for <feature>?" for the same list. The Teams page also lists ownership conflicts, things
features use that no team owns, unknown team names and suggested teams from names already in
LifeCycle-Data. Format, rules and API:
[docs/teams-format.md](docs/teams-format.md).

## Logs

Every source read is appended to `~/.lifecycle/logs/source-reads.log` as one JSON line with time,
source (`github`, `github-actions`, `github-deployments`, `flagsmith`, `alerts`), feature, step, target and
outcome (`ok`, `unreachable`, `no_access`, `not_found`, `unknown_flag`).
Alerts, publishes and failures go to `~/.lifecycle/logs/alerts.log` (event, feature, source).
Tokens and credentials are redacted before anything is written. To check:

```bash
grep -rE 'gh[pousr]_|github_pat_|ser\.|Api-Key|sk-ant-' ~/.lifecycle/logs ~/.lifecycle/history   # should print nothing
```

## Settings

Environment variables override `config.json` (handy for testing): `LIFECYCLE_HOME`,
`LIFECYCLE_GITHUB_TOKEN`, `LIFECYCLE_DATA_REPO`, `LIFECYCLE_DATA_PATH` (read definitions from a
local LifeCycle-Data clone instead of GitHub: every refresh runs `git pull --ff-only` of the configured
branch first, reads the files at the clone's commit, and the page says so; edits made in LifeCycle become
local commits, never pushed, and team snapshots are never written; a folder that is not a git clone is read as it is on disk), `LIFECYCLE_PORT`, `LIFECYCLE_GITHUB_ENABLED=false`,
`LIFECYCLE_FLAGSMITH_API_KEY`, `LIFECYCLE_FLAGSMITH_PROJECT`, `LIFECYCLE_FLAGSMITH_API`,
`LIFECYCLE_FLAGSMITH_ENABLED=false`, `LIFECYCLE_FLAG_PLATFORM=statsig|flagsmith`, `LIFECYCLE_STATSIG_API_KEY`,
`LIFECYCLE_STATSIG_MCP_URL`, `LIFECYCLE_STATSIG_ENABLED=false`, `LIFECYCLE_APP_STORE_ENABLED=false`, `LIFECYCLE_SLACK_ENABLED=true|false`,
`LIFECYCLE_JIRA_ENABLED=true|false`, `LIFECYCLE_ALERTS_SOURCE`, `LIFECYCLE_AI_PROVIDER`, `LIFECYCLE_AI_MODEL`,
`LIFECYCLE_AI_API_URL`, `LIFECYCLE_AI_API_KEY` / `ANTHROPIC_API_KEY`, `LIFECYCLE_ME` (comma-separated owner names),
`LIFECYCLE_GITHUB_USER`
(your GitHub user for registered changes when GitHub can't tell).

## Development

```bash
npm test     # unit + end-to-end tests against a fake GitHub (no network, no real credentials)
```

Code map: `src/definitions.js` (read + validate definitions), `src/sources/` (evidence sources;
GitHub and Jira, registered in `src/sources/index.js`), `src/status.js` (states and blockers),
`src/graph.js` (cycles, unknown dependencies), `src/lastmile/` (done vs. turned on: GitHub Actions and
deployments, Flagsmith / Statsig, app stores and Slack release channels, last-mile state rules), `src/changes.js` (registered changes, alert list),
`src/ask/` (feature resolution, statements with evidence, AI providers, digest, local history),
`src/mcp.js` (AI-tools entry point), `src/server.js` (API + UI), `public/` (browser UI).

## Credits

Built with [Chiron by Taller](https://taller.ai/chiron).
