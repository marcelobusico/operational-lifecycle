# Shared feature status format (`lifecycle.feature-status/v1`)

This is what LifeCycle returns for one feature. The map shows exactly this data. Other tools (AI
tools, the "done vs. turned on" work, scripts) should read it instead of re-deriving
status.

## How to get it

| Way                       | Command / URL                                                  |
|---------------------------|----------------------------------------------------------------|
| Local API (app running)   | `GET http://localhost:4317/api/features/<feature-id>/status`   |
| Whole roadmap             | `GET http://localhost:4317/api/roadmap`                        |
| One project               | `GET http://localhost:4317/api/projects/<project-id>/status` (`none` = features with no project) |
| Without the app running   | `npm run status -- <feature-id>` (no id: the whole roadmap)    |
| Last mile only, all       | `GET http://localhost:4317/api/last-mile`                       |
| Last mile only, one       | `GET http://localhost:4317/api/features/<feature-id>/last-mile` |

Every request reads the sources live with the caller's own credentials. Nothing is published, so
two people with the same access get the same states. Only `read_at` and the read times differ.

## Fields

```jsonc
{
  "schema": "lifecycle.feature-status/v1",
  "feature": {
    "id": "redeem-rewards", "name": "Redeem rewards", "owner": "Mobile team",
    "description": "Readers redeem their reading points in the reader.", // or null
    "target_date": "2027-01-31",            // or null
    "file": "features/redeem-rewards.yaml", // where it is defined in LifeCycle-Data
    "services": ["catalog-api"], "flags": ["redeem_rewards"],
    "experiments": ["redeem_rewards_groups"] // Statsig experiment ids from the definition (`experiments:`)
  },
  "project": { "id": "redeem-rewards", "name": "Redeem rewards" }, // null if the feature has none; name null if the id isn't defined
  "state": "blocked",       // done | flowing | blocked | unavailable | not_started (see below)
  "summary": "Redeem rewards depends on Rewards points; \"Development\" isn't done: PR #4 …",
  "current_step": "development",            // first step that isn't done, or null when all are
  "steps": [                                // in the order of the definition
    {
      "id": "development", "name": "Development (catalog team)", "owner": "@example-dev",
      "team": "Rewards team",              // optional `team` from the definition, or null
      "done_when": "The rewards points endpoint is merged to main with unit tests.",
      "state": "in_progress", // done | in_progress | not_started | unavailable | no_access
      "linked_work": true,    // false: the step has no PR/issue yet (empty state)
      "message": null,        // why, when state is unavailable or no_access
      "last_successful_read_at": "2026-11-03T20:28:40.980Z", // null if never read or no linked work
      "unavailable_since": null, // unavailable: when its reads first started failing
      "evidence": [
        {
          "source": "github", "type": "pr", "repo": "acme-org/acme-monolith", "number": 4,
          "link": "https://github.com/acme-org/acme-monolith/pull/4",
          "title": "Rewards points endpoint",
          "state": "in_progress", // done | in_progress | not_done | unavailable | no_access
          "detail": "open PR, not merged",
          "message": null,
          "last_successful_read_at": "2026-11-03T20:28:40.980Z"
        }
      ]
    }
  ],
  "blockers": [
    {
      "kind": "dependency",   // dependency | circular_dependency | unknown_dependency | invalid_dependency
      "feature": "rewards", "feature_name": "Rewards points",  // what is blocking
      "step": "development", "step_name": "Development (catalog team)",
      "owner": "@example-dev",  // who to push
      "why": "Redeem rewards depends on Rewards points; \"Development (catalog team)\" isn't done: PR #4 in … is open PR, not merged",
      "evidence": [{ "link": "https://github.com/…/pull/4", "label": "PR #4 in …", "state": "in_progress" }],
      "via": ["reader"]     // only when passed through a chain: the features in between
    }
  ],
  "depends_on":     [{ "id": "rewards", "name": "Rewards points", "state": "flowing" }],   // name null if undefined
  "depended_on_by": [{ "id": "reader", "name": "Reader", "state": "blocked" }],
  "warnings": [{ "kind": "unknown_dependency", "ids": ["ghost"], "message": "unknown dependency \"ghost\": …" }],
  // kinds: circular_dependency | unknown_dependency | invalid_dependency | unknown_project
  "access_problems": [{ "step": "development", "message": "Your GitHub credentials can't read pull request #4 in …" }],
  "last_mile": { /* is it deployed and turned on? see "Last mile" below; null only if it couldn't be computed */ },
  "sources": [ /* where every status above was read from: see "Sources" below */ ],
  "share_link": "http://lifecycle.localhost:4317/#/feature/redeem-rewards", // this feature's view, the same on any teammate's LifeCycle
  "ramp_conditions": [ /* the feature's own ramp conditions, same shape as steps; [] when it has none */ ],
  "ramp": { /* ready to ramp? see "Ready to ramp" below */ },
  "read_at": "2026-11-03T20:28:40.980Z",                 // when this status was computed
  "last_successful_read_at": "2026-11-03T20:28:40.980Z", // oldest successful read behind it
  "definitions": {
    "source": "github:acme-org/LifeCycle-Data@main",
    "synced_at": "2026-11-03T20:28:40.100Z",
    "stale": false,           // true: shared repo unreachable, these are the last definitions read
    "error": null             // { kind, source, message } when stale
  }
}
```

## Overall state rules

Checked in this order:

1. **blocked**: a feature in `depends_on` is definitely not done, a circular dependency exists,
   or a `depends_on` id is unknown or has an invalid definition. Each reason is one entry in `blockers`.
2. **unavailable**: a step or a dependency could not be read (source down, connection disabled,
   no access). LifeCycle can't confirm done or blocked, so it shows neither.
3. **done**: the feature has steps and every one is done (its dependencies are done by rule 1).
4. **not_started**: no step has linked work yet, or the feature has no steps.
5. **flowing**: otherwise.

The `/api/roadmap` response is
`{ definitions, invalid_definitions: [{ file, field, message }], projects: [<project status>…], features: [<status>…] }`.

## Project status (`lifecycle.project-status/v1`)

```jsonc
{
  "schema": "lifecycle.project-status/v1",
  "project": { "id": "redeem-rewards", "name": "Redeem rewards", "owner": "Mobile team",
               "description": "…", "target_date": "2027-01-31", // null when the project sets none: the
               "file": "projects/redeem-rewards.yaml" },     // UI then shows its latest feature's date. id null = "No project"
  "state": "blocked",                  // same states as a feature, rolled up (rules below)
  "counts": { "blocked": 1, "unavailable": 0, "flowing": 1, "not_started": 0, "done": 0 },
  "features": ["redeem-rewards", "rewards"],
  "blockers": [ /* the blockers of its features, once each, plus "blocked_feature" */ ],
  "depends_on_outside": [{ "id": "catalog-api", "project": "reading-platform" }],
  "depended_on_from_outside": [],
  "feature_statuses": [ /* only in /api/projects/<id>/status: the full feature statuses */ ]
}
```

Project state: **blocked** if any feature is blocked, else **unavailable** if any is unavailable,
else **done** if every feature is done, else **not_started** if none has started (or the project
has no features yet), otherwise **flowing**.

## Last mile (`last_mile`)

Answers "is this feature actually available to users, and if not, why?". It is computed in the
same refresh as the steps, with the same person's credentials, from three live sources:

| Part         | Source                                                                 |
|--------------|------------------------------------------------------------------------|
| development  | the feature's linked PRs (GitHub) and the GitHub Actions runs on each merge commit (fallback: the PR's own runs) |
| services     | GitHub Deployments of each service's repo, per environment (`services/<id>.yaml` in LifeCycle-Data says which repo and which GitHub environment names) |
| flags        | the person's flag platform, per environment: Flagsmith, or Statsig over Statsig's MCP server (`flag_platform` says which; the shape is the same) |
| experiments  | Statsig over its MCP server (`experiment_read`), always, whichever the flag platform; the experiments the definition lists under `experiments:` |

```jsonc
"last_mile": {
  "state": "deployed_flag_off",
  // not_tracked | unavailable | in_development | done_not_deployed | deployed_flag_off
  // | in_experiment | partly_rolled_out | fully_on | switched_off   (rules below)
  "label": "Done but not turned on",        // what the view shows; "Partly rolled out – 25%", "Fully on · no flags", …
  "context_state": "in_production_not_rolled_out", // the context doc's words: not_in_qa | in_qa_not_in_production
                                            // | in_production_not_rolled_out | rolled_out | switched_off | null
  "done_but_not_turned_on": true,           // done, but users can't reach it (done_not_deployed, deployed_flag_off, switched_off)
  "flags_mode": "flags",                    // "no_flags": the state comes from deploys alone
  "rollout_percentage": null,               // partly_rolled_out: the lowest rollout among its partial flags
  "switched_off": null,                     // switched_off: { flag, environment, changed_at, changed_by, link }
  "experiment": null,                       // in_experiment: { id, name, environment, groups, assignment, link } of the one running in production
  "summary": "Done but not turned on: deployed to production, but Flag rewards_enabled is off in production.",
  "reasons": [                              // each thing keeping it from users, naming the service or flag
    { "kind": "flag", "flag": "rewards_enabled", "environment": "production", "message": "Flag rewards_enabled is off in production." }
    // kind: development | service (+ service, environment) | flag (+ flag, environment) | unavailable (+ source)
  ],
  "warnings": [
    { "kind": "version_mismatch", "service": "catalog-api", "qa": "0.3.0", "production": "0.2.0", "message": "catalog-api: QA runs 0.3.0, production runs 0.2.0." },
    { "kind": "unknown_flag", "flag": "ghost_flag", "message": "Unknown flag \"ghost_flag\": …" },
    { "kind": "unknown_service", "service": "ghost-api", "message": "Unknown service \"ghost-api\": …" }
  ],
  "development": {
    "state": "done",                        // done | not_done | unavailable | no_access
    "message": "All 1 linked PR is merged with GitHub Actions passing.",
    "pull_requests": [{ "repo": "o/r", "number": 4, "title": "…", "link": "https://github.com/o/r/pull/4", "merged": true,
      "merge_sha": "…", "actions": "success", // success | failure | pending | none | not_merged
      "actions_link": "https://github.com/o/r/actions/runs/…", "detail": "GitHub Actions passed (Release)",
      "state": "ok", "last_successful_read_at": "…" }]
  },
  "services": [{
    "id": "catalog-api", "repo": "acme-org/acme-monolith", "unknown": false,
    "environments": {
      "qa":         { "state": "ok", "github_environment": "qa", "deployed": true, "version": "0.2.0", "ref": "v0.2.0", "sha": "…",
                      "deployed_at": "…", "deployed_by": "octocat", "contains_feature": true,
                      "link": "https://github.com/…/actions/runs/…", // the pipeline run that deployed it, else the deploy record itself
                      "link_kind": "pipeline_run",           // pipeline_run | deploy_record | null (no successful deploy: no link)
                      "message": null, "last_successful_read_at": "…", "unavailable_since": null },
      "production": { /* same shape */ }
    }
    // state: ok | unavailable | no_access. deployed is null when it couldn't be read.
    // contains_feature: does the deployed commit include the feature's merge commits? null = can't tell (no merged PR in that repo).
  }],
  "flag_platform": "flagsmith",                 // flagsmith | statsig: where the flags below were read
  "flags": [{
    "key": "rewards_enabled", "unknown": false,   // unknown: listed in the definition, missing from the flag console
    "environments": {
      "qa":         { "state": "on", "rollout_percentage": 100, "segments": [], "changed_at": "…", "changed_by": "Ana Ops",
                      "was_on_before": null, "link": "https://app.flagsmith.com/project/…", "message": null, "last_successful_read_at": "…" },
      "production": { "state": "off", "rollout_percentage": 0, "was_on_before": false /* … */ }
    }
    // state: on | off | partial | unknown | unavailable | no_access | missing_environment
    // from_snapshot: true when the platform couldn't be read live and the team snapshot stands in
    // (see "Flag snapshots" below); snapshot_read_at and last_successful_read_at are then the
    // snapshot's read time, live_state why it isn't live (unavailable | no_access), message the reason.
  }],
  "experiments": [{
    "id": "redeem_rewards_groups", "name": "redeem_rewards_groups", "unknown": false, "platform": "statsig",
    "environments": {
      "production": {
        "state": "running",              // running | not_running | not_started | ended | unknown | unavailable | no_access
        "statsig_status": "active",      // Statsig's own status (setup | active | decision_made | abandoned …)
        "groups": [                      // control and each variant, in Statsig's order
          { "name": "Control", "id": "…", "control": true, "share": 50, "share_of_users": 50,
            "gets": "No rewards option", "gets_from": "definition" },  // definition | statsig (its group description) | null
          { "name": "B", "id": "…", "control": false, "share": 25, "share_of_users": 25,
            "gets": "Redeem points, 10% bonus", "gets_from": "statsig" }
        ],
        // share: % of the users in the experiment (Statsig's group size); share_of_users: allocation × share
        "assignment": { "id_type": "userID", "allocation": 100, "targeting_gate": null, "segments": [] },
        "started_at": "…", "ended_at": null, "launched_group": null, "reason": null,
        "changed_at": "…", "changed_by": "a Console API key",  // never a key fragment
        "link": "https://console.statsig.com/<project>/experiments/redeem_rewards_groups",
        "message": null, "last_successful_read_at": "…", "unavailable_since": null
      },
      "qa": { /* same shape */ }
    },
    "events": [                          // the feature's timeline entries for this experiment, oldest first
      { "kind": "experiment_started", "at": "…", "message": "Experiment … started: Control 50%, A 25%, B 25%." }
      // experiment_started | experiment_share_changed | experiment_ended
    ]
  }],
  "access_problems": [{ "source": "flagsmith" /* github | flagsmith | statsig */, "message": "Your Flagsmith (flag console) API key can't read project 7 (…)." }],
  "evidence": [{ "kind": "flag_setting", "label": "rewards_enabled in production: off", "link": "https://app.flagsmith.com/…" }],
  // kind: pull_request | github_actions | deploy_record | flag_setting | experiment
  "read_at": "…",
  "last_successful_read_at": "…"  // unavailable: oldest successful read behind it (null = never read); otherwise read_at
}
```

### Last-mile state rules

Production is what users get; QA is shown, compared, and used to say "not in QA". Checked in order:

1. **not_tracked**: the definition lists no `services`, no `apps` and no `flags`.
2. **unavailable** ("status unavailable"): any read for this feature failed (GitHub or the flag
   platform down, connection disabled, no access, unknown service, environment missing in Flagsmith). The feature
   is **never** shown as on or off then; `last_successful_read_at` says when it last read fine and
   `access_problems` names the source and the missing access.
3. **in_development** ("not done yet"): a linked PR isn't merged, its GitHub Actions didn't pass, or
   no PR is linked.
4. **done_not_deployed**: a service has no successful deployment to production, or the deployed
   version doesn't include the feature's merge commit. `reasons` names the service and environment.
4b. **Mobile apps** (features with `apps:`): per app and platform whose store is connected, the
   version that first includes the feature must be released to everyone. Otherwise, worst first:
   **rollout_halted** ("Rollout halted – iOS 3.4.0 at 20%"), **store_rejected**,
   **not_in_app_version**, **in_store_review** ("In review – iOS 3.5.0"), **waiting_for_release**
   (approved or not submitted yet), **app_partly_released** ("Released in 3.4.0 to 20% of iOS
   users"). A platform whose store isn't connected is listed in `store_notes` ("store not
   connected") and never guessed; with no connected store at all the state is
   **store_not_connected**. A failed store read or an unknown store id is rule 2. Once every
   connected platform is fully released, flags decide as below (fully released + flag off = "done
   but not turned on"); with no services and no flags the label is "Fully released".
5. **switched_off** / **deployed_flag_off** ("done but not turned on"): a flag is off (or unknown)
   in production. It is *switched off* when there is evidence it was on before (Flagsmith's version
   history, or this machine saw it on at an earlier refresh), with when and, if the platform records
   it, who (Flagsmith's audit log on plans that have it; Statsig's last modifier of the gate).
6. **in_experiment** ("In experiment – <name>"): an experiment the feature lists is running in
   production. Users deliberately get different behavior per group, so it is never shown as
   "partly rolled out": `reasons` and `summary` give every group, its share and what the feature
   does in it. Once the experiment ends (or isn't running), the flags decide again.
7. **fully_on · no flags**: the feature uses no flags; deploys alone decide.
8. **partly_rolled_out**: a flag is on only for a percentage (a Flagsmith segment override with a
   "% Split" rule; a Statsig rule for everyone passing 1–99%) or for some segments.
9. **fully_on**: deployed to production and every flag on for everyone.

An experiment that can't be read makes the feature **unavailable** (rule 2), like a flag; one that
doesn't exist in Statsig adds an `unknown_experiment` warning.

### Flag snapshots

So a teammate without a flag platform key still sees flag status, LifeCycle shares what it read.

- **Written:** after each refresh, every flag read live in every environment is committed to
  LifeCycle-Data `flag-snapshots/<flag>.yaml` (src/lastmile/flag-snapshots.js): per environment
  the state, rollout %, segment names and shares, when and by whom it last changed, and the link;
  or `unknown: true` when the flag doesn't exist on the platform. Never a key or a rule's
  conditions. A file is committed when something changed or the last one is over 6 hours old,
  and only by someone with write access to LifeCycle-Data (read-only people never try). A
  refresh's result is in the snapshot's `flag_snapshots: { committed, failed }`.
- **Read:** when a flag can't be read live (no key, a refused key, the platform down), its cells
  come from the snapshot with `from_snapshot: true` and the snapshot's read time, and the verdict
  is worked out from them as from a live read. A live read always wins when it works. A flag with
  no snapshot stays `unavailable`.
- **Flag source:** `flag_source.state` is `snapshot` when every flag that couldn't be read live came
  from a snapshot (`snapshot_read_at`: the oldest one used); otherwise `problem` as before.
- **Sources and ramp:** the flag's source entry has `from_snapshot: true`, and the ramp flag check
  says "team snapshot, read <time>".

### When the sources are read (`sources_read`)

Nothing is read on a timer. Every snapshot has `sources_read: { read_at, live }`:

- **Refresh** (`GET /api/roadmap`, and every other read of the snapshot) reads the shared repo
  only. Step evidence, the last mile, flag source health and the alert list are what the last live
  read said (`live: false`, `read_at` = that read). A Jira team snapshot newer than this machine's
  last read is used. A GitHub PR or issue added since then (for example just linked to a step) is
  read once (one API call, no Claude); a new Jira ticket shows `unavailable` with "Not read on this
  machine yet. Press Refresh data to read it." A feature added since then has no last mile until
  the next Refresh data. No team snapshots are written.
- **Refresh data** (`POST /api/refresh-data`) reads every source live (`live: true`) and saves what
  they said in `~/.lifecycle/cache/` for the plain refreshes after it. Jira and Slack still keep
  their own `intervalMinutes`, so Claude isn't asked again within it.
- The first refresh on a machine (nothing saved yet) reads live. `lifecycle status` always does.

### Experiments (Statsig)

- **Where they are named:** `experiments:` in the feature definition, each an experiment id with
  what the feature does in each group, written by the team (a bare id is allowed):

  ```yaml
  experiments:
    - id: redeem_rewards_groups
      groups:
        Control: No rewards option in the reader
        A: Can redeem rewards in the reader
  ```

  Group names match Statsig's (case and spacing ignored). A group not described there shows
  Statsig's own group description, marked "from Statsig"; otherwise "not described in the definition".
- **Per environment:** Statsig keeps one status per experiment, so it shows the same in QA and
  production, unless the experiment has a targeting gate: that gate's rules in the environment
  decide whether anyone is eligible there (`not_running`, with `reason`). `assignment.segments` names
  the gate's segments.
- **Timeline:** started (Statsig's start time), ended (end/decision time, with the shipped group),
  and a group's share of users changing. Statsig refuses to change group sizes once an experiment
  has started, so while it runs shares move through the allocation; LifeCycle compares each read
  with the last one this machine saw. The feature page's Timeline lists these entries next to
  registered changes.

### Mobile apps (app stores)

- **Where they are named:** `apps:` in the feature definition, each an app id from
  LifeCycle-Data's `apps/<id>.yaml` with the version that first includes the feature per platform
  (`first_version: { ios: 3.4.0, android: 3.4.0 }`). The app file says where each platform is
  published (`store: app_store | google_play`, `store_id`).
- **`last_mile.apps[]`:** `{ id, name, repo, owner, unknown, platforms: { ios, android } }`; each
  platform: `state` (`not_in_version | preparing | in_review | approved_waiting | rejected |
  released | removed | not_connected | unknown_app | unavailable | no_access`), `label` (the words
  the UI, chat and digest use), `first_version`, `version`, `rollout_state` (`gradual | complete |
  halted`), `rollout_percentage`, `phased_day` (Apple's phased release day 1–7), `store_state` (the
  store's own word), `latest` (the store's newest version), `tag_check` (`ok | no_tag | contradicts
  | unavailable`, with the release tag link), `link` (the version in the store console),
  `last_successful_read_at`, `snapshot_read_at` (the last snapshot committed to LifeCycle-Data),
  `events` (timeline: `store_rollout_halted`, `store_rollout_resumed`, `store_rejected`), `via`
  (`store | slack`: where it was read), `release_channel` (when `via` is `slack`), `from_snapshot`
  (true: not read here, the team snapshot; `live_state` says why).
- **Read in order:** the store itself; else the app's Slack release channel, on the machine that
  reads Slack (below); else the team snapshot in `store-snapshots/`, marked `from_snapshot` with its
  read time. With none of them: `unavailable` / `no_access`, or `not_connected`. Never guessed.
- **Stores:** read per store through `src/stores/` (one connector each). Connected now: App Store
  (App Store Connect API, phased release 1, 2, 5, 10, 20, 50, 100% over 7 days; a paused phased
  release is "rollout halted"). Google Play isn't connected yet.
- **Warnings:** `unknown_app`, `app_version_tag` (no release tag for the written version, or the tag
  contradicts the merged PRs), `platform_mismatch` (e.g. released on Android, in review on iOS),
  `app_platform`.
- **Snapshots:** each store (or Slack) read is committed to LifeCycle-Data `store-snapshots/<app>-<platform>.yaml`
  when it changed or the last one is over 6 hours old (src/stores/snapshots.js); one read from
  Slack says `via: slack` and the channel, never message text. A refresh's result is in the
  snapshot's `store_snapshots: { committed, failed }`.
- **Slack release channels:** for teams that announce releases in Slack (a bot and people: version
  cut, review, released, rollout %, halted). In `apps/<id>.yaml`:

  ```yaml
  release_channel:
    slack: "#mobile-releases"   # or the channel id, e.g. C0123ABCD
    hint: "iOS messages mention the App Store"   # optional, how to tell apps or platforms apart
  ```

  LifeCycle has no Slack app: one person's LifeCycle (`sources.slack.enabled`, set with
  `lifecycle setup --extras`) asks Claude Code, signed in to Slack on that machine, to read the
  channel with only the read-only tools in `sources.slack.tools` (read channel, read thread, search
  channels), at most every `intervalMinutes` (30), going back `lookbackDays` (90) the first time
  (src/stores/slack-releases.js). Claude returns the messages and the events it found; LifeCycle
  keeps an event only when its version and percentage are written in that message (the version may
  come from the thread's first message), drops anything else, and works the state out itself. Only
  the events are kept on that machine, never message text. Everyone else gets the result from the
  snapshot. `lifecycle slack-check [--days 14] [--app <id>]` shows what is understood and dropped,
  and the resulting state, without saving or committing anything.

  Claude is locked down for these reads (Slack and Jira, src/claude-run.js), because what it reads
  is written by other people: no built-in tools but ToolSearch (no shell, files or web),
  `--permission-mode dontAsk` (anything not approved is refused, whatever the person's own Claude
  settings allow), only the read tools approved, and the connectors' known write tools refused.
  After a failed read, LifeCycle waits `intervalMinutes` before asking Claude again and uses the
  team snapshot meanwhile. A store read shared by someone with store access wins over a Slack read
  while it is kept up to date (less than 12 hours old).

  Snapshots (flag, store and Jira) are written only through GitHub, by someone who can write to the
  shared repo; a LifeCycle reading a local data folder or clone never writes them.
- **Ramp:** features with apps get a `store` check ("App release is out to everyone in the
  stores"): in review, gradual, halted, rejected or not in a version → not ready, naming it.

`GET /api/last-mile` returns `{ schema: "lifecycle.last-mile/v1", definitions, features: [{ id, name, services, flags, last_mile }] }`.

## Sources (`sources`)

Every status LifeCycle shows for a feature, with the exact item it was read from and when. The
browser view (feature page, "Where each status comes from" and each row of "Path to users") and the
answers from your own AI tools (`lifecycle_ask`) show exactly these links, so a status can be
checked or shared the same way from either.

```jsonc
"sources": [{
  "kind": "deployed",        // developed | deployed | flag | experiment | blocked | delay
  "key": "deploy:catalog-api:qa",
  // developed: step:<step id> (its PRs/issues) and actions:<repo>#<n> (GitHub Actions run per PR)
  // deployed: deploy:<service>:<qa|production> · flag: flag:<key>:<qa|production>
  // experiment: experiment:<id>:<qa|production>
  // blocked: blocker:<index in blockers> · delay
  "label": "catalog-api in QA",
  "state": "deployed",       // the status shown, in its kind's words
  "source": "github-deployments", // github | github-actions | github-deployments | flagsmith | statsig | definitions | lifecycle
  "links": [{ "label": "deploy record: catalog-api in QA (0.1.0)", "url": "https://api.github.com/repos/…/deployments/1234567" }],
  "no_source_item": null,    // when links is empty: why there is no specific item (never a generic link instead)
  "read_at": "…",            // last successful read of this status (null: never read)
  "unavailable": false,
  "unavailable_since": null, // unavailable: when its source first failed; links then keep the last known item
  "message": null
}]
```

Rules:

- A link always points to one specific item: a PR or issue, a GitHub Actions run (or the commit
  whose runs decided it), the pipeline run that deployed a version or else the GitHub deploy record
  itself (GitHub has no web page per deployment, so it is the record's API URL), the flag in the
  flag console for that environment (or the gate in Statsig), the blocking PR/issue, the blocking feature's LifeCycle view or
  the definition file at fault. Never a repo or tool home page, and never a list such as an
  environment's deployments.
- No specific item (no successful deploy, flag missing in the flag console, step with no linked
  work): `links` is empty and
  `no_source_item` says so.
- Source can't be read: `unavailable` is true, `unavailable_since` says since when (reads that
  started failing are remembered on this machine until the next good read), `read_at` is the last
  successful read, and `links` keep the last known item when there is one.
- Experiment (`experiment:<id>:<qa|production>`): links the experiment's page in Statsig (its
  permalink; one page for every environment), with its read time. An unknown experiment has no link
  and says it doesn't exist in Statsig; when Statsig can't be read it shows "source unavailable
  since <time>" and keeps the last known experiment link.
- Delay warnings link the open steps they are worked out from (plus the definition with the target
  date).

## Ready to ramp (`ramp`)

One verdict per feature, computed on every refresh from the rest of the status (steps,
dependencies, last mile), registered changes, alerts and the feature's own `ramp_conditions`. The
browser, the chat (`lifecycle_ask`: "Is X ready to ramp?") and `npm run status` all show this block.

```jsonc
"ramp": {
  "verdict": "not_ready",                  // ready | not_ready | cant_tell
  "label": "Not ready to ramp",
  "summary": "Not ready to ramp: 2 reasons.",
  "reasons": [{                            // every failed check, one line each
    "check": "deploys", "kind": "service", // kind: step | dependency | development | service | version_mismatch | flag | change | alert | condition
    "message": "wishlist-api isn't deployed to production.",
    "owner": "Wishlist team",                // who to push: step/condition owner, service owner, dependency's blocker, change author…
    "evidence": [{ "label": "deploy record: wishlist-api in production", "link": "https://github.com/…/actions/runs/…" }],
    "service": "wishlist-api", "environment": "production"
  }],
  "unavailable": [{                        // sources a check relies on that couldn't be read
    "check": "deploys", "source": "GitHub Deployments", "what": "catalog-api in production",
    "message": "…", "last_successful_read_at": "…"   // null = never read
  }],
  "checks": [{                             // everything checked, so a person sees what was checked
    "id": "deploys", "name": "Deployed to production on every service", "custom": false,
    "state": "passed",                     // passed | failed | unavailable | not_checked
    "detail": "In production: catalog-api 0.3.0."
  }],
  "read_at": "…"
}
```

**Verdict rules.** Any failed check → `not_ready` (even if another source is down: what is known is
already enough). Otherwise any unavailable source → `cant_tell`, naming the source and its last
successful read; the verdict is never `ready` while a source a check relies on is unavailable.
Otherwise `ready`. A `not_checked` check (nothing to check, or not read yet) doesn't block and is
listed in the summary.

**Checks**, in order:

| id | Passes when | Fails with |
|----|-------------|------------|
| `steps` | every step is done | each open step, its owner and its PR/issue |
| `dependencies` | every dependency is done and, when its availability is tracked, fully on for users | the blocking step and who to push; a dependency switched off (flag, when, who) or not deployed / not turned on / partly rolled out |
| `development` | linked PRs merged with GitHub Actions passing | each PR that isn't |
| `deploys` | every listed service runs a build with this work in production | the service and environment, with the deploy record |
| `versions` | each service runs the same build in QA and production | the mismatch, with both deploy records |
| `flags` | every flag exists in the flag console and wasn't switched off in production after being on | the flag, when and who switched it off |
| `experiments` | no experiment the definition lists is running (in production, else QA); passes with "lists no experiments" when there are none | the running experiment and its groups' shares, linking it in Statsig; an unknown experiment. Statsig unreadable → `unavailable` |
| `changes` | no **planned** registered change names the feature | the change, its date and author, linking the change file |
| `alerts` | no open alert (from the alert list) names the feature; an alert is open until it carries `resolved: true`, `resolved_at` or `state: resolved` | the alert, linking it |
| `condition:<id>` | that ramp condition's PRs/issues are done | the condition, its owner and its evidence |

The feature's own flag being off or partly rolled out never fails a check: that is what ramping
changes. An alert list that isn't set up makes `alerts` `not_checked`; one
that is set up but can't be read makes it `unavailable`.

**Feature-specific conditions** are added to the definition, in the same shape as steps:

```yaml
ramp_conditions:
  - id: qa-signoff
    name: QA sign-off
    owner: "@qa-lead"
    done_when: QA closes the sign-off issue for this release.
    evidence:
      - { source: github, type: issue, repo: org/repo, number: 42 }
```

## Jira tickets as evidence

`{ source: jira, type: ticket, key: ABC-123 }` in a step's (or ramp condition's) `evidence`. In
`steps[].evidence[]` a ticket has `key` (no `repo` / `number`), `title` (its summary), `state`
(`done` when the status category is Done or the status is Done or Closed, any case; `in_progress`
when the category is In Progress; else `not_done`), `detail` (the Jira status), `link`
(`https://<site>.atlassian.net/browse/ABC-123`), `opened_at` / `closed_at`, and `from_snapshot`.

- **Read** (src/sources/jira.js) only on the machine with `sources.jira.enabled`: Claude Code, signed
  in to Atlassian's MCP server (v2, added as `atlassian`), may use only
  `getAccessibleAtlassianResources`, `getJiraIssue` and `searchJiraIssuesUsingJql`. All of a
  refresh's tickets are read in one run (50 per run at most), at most every `intervalMinutes` (30).
  Only tickets that were asked for and have a status are kept; links are kept only on the configured
  `siteUrl` or on `*.atlassian.net`. A ticket Jira says it doesn't have is `unavailable` with the
  reason. A failed run is tried once per refresh.
- **Shared** in `jira-snapshots/<KEY>.yaml` (src/sources/jira-snapshots.js): summary, status,
  category, assignee, created / resolved, link and read time, committed when one of them changed or
  the last one is over 6 hours old, by someone with write access. A refresh's result is in
  `jira_snapshots: { committed, failed }`.
- **Everyone else** (and that machine when the run fails) uses the snapshot: `from_snapshot: true`,
  `detail: "<status> (team snapshot)"`, read time = the snapshot's. With no snapshot the step is
  `no_access`, saying how to turn Jira on.

## Timeline

`timeline: { start, finished }`: `start` is when the earliest linked PR or issue was opened,
`finished` when the last one was merged or closed, only once the feature is `done`. Both are
ISO times or null. The roadmap draws each feature as a bar from `start` to its `target_date`.

