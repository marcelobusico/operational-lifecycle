# Ask & digest: formats, sources and privacy

"Ask the path": a person asks how a feature is going and gets an answer with evidence, plus a
digest of what changed since they last looked. Both run on the person's own machine, inside their
copy of LifeCycle, with their own credentials and their own AI provider.

## What answers are built from

Only these, from the same refresh as the map and the last mile (done vs. turned on); the sources are as of the last **Refresh data**:

| Input                     | Where it comes from                                                         |
|---------------------------|-----------------------------------------------------------------------------|
| Feature status            | `lifecycle.feature-status/v1` with `last_mile` ([status-format.md](status-format.md)) |
| Registered changes        | `changes/<id>.yaml` in LifeCycle-Data (below)                               |
| Alerts                    | the alert list, `lifecycle.alerts/v1` (below), from `alerts.source` in the local config |

The engine turns them into numbered **statements**. Each one says one thing and carries the evidence
it came from (PR, issue, GitHub Actions run, deploy record, flag setting, registered change, alert,
or the feature's definition file). An answer is a lead sentence plus the statements that fit the
question. The AI provider never writes a statement: it only

1. reads the question (which intent, which words name the feature), and
2. writes the lead sentence, citing statement ids. A lead that cites nothing, cites an unknown
   statement, or contains a number or date its cited statements don't contain is dropped, and
   LifeCycle's own lead is shown instead.

Which feature is meant is always decided by LifeCycle (`src/ask/resolve.js`), the same way for every
provider: an exact name or a full hyphenated id matches; a name that fits several features gets a
clarifying question listing the closest matches; a name that fits none gets "I don't have a feature
called …" and the list of defined features. A question the data can't answer (budget, design…)
gets "LifeCycle's data doesn't answer that", never a guessed status.

When a source can't be read, the answer lists it under **Out of date** with the time of the last
successful read: the shared repo ("definitions from the last sync at …"), GitHub per step, the
flag console ("Flag data is unavailable … Last successful read: …"), deploy records, GitHub
Actions, the alert list. Nothing unreadable is ever shown as on, off, done or blocked.

## Registered changes (`changes/<id>.yaml` in LifeCycle-Data)

The alerts work now owns this format: **v2** (`what`, `change`, `features`, `state`, `reason`, …) is
documented in [alerts-format.md](alerts-format.md). The earlier v1 below is still read. Answers and
digests list a change under every feature in `features`, and say when it is planned or cancelled.

```yaml
id: 2026-11-03-redeem-rewards-needs-0-2-1   # required; equals the file name
feature: redeem-rewards                # required; a feature id
kind: dependency                              # flag | dependency | schedule | scope | deploy | other
summary: Redeem rewards now waits on release 0.2.1 before going to 100%.
registered_by: "@example-user"
registered_at: 2026-11-03T18:30:00Z           # date-time
link: https://github.com/…/pull/7             # optional
```

`npm run validate -- <LifeCycle-Data folder>` checks them. The evidence link of a registered change
is its file in the shared repo (or `/api/changes/<id>` when definitions come from a local folder).

## Alert list (`lifecycle.alerts/v1`)

Set `"alerts": { "source": "<file path or http(s) URL>" }` in `~/.lifecycle/config.json` (or
`LIFECYCLE_ALERTS_SOURCE`). The last good copy is cached in `~/.lifecycle/cache/alerts.json`.

```jsonc
{
  "schema": "lifecycle.alerts/v1",
  "alerts": [{
    "id": "alert-2026-11-03-redeem-rewards-dependency",   // required
    "feature": "redeem-rewards",                     // required
    "kind": "dependency",                                   // flag | dependency | schedule | …
    "severity": "warning",                                  // info | warning | critical
    "message": "New dependency: Redeem rewards waits on release 0.2.1.",  // required
    "at": "2026-11-03T18:31:00Z",                           // required
    "link": "https://…",                                    // optional
    "registered_change": "2026-11-03-redeem-rewards-needs-0-2-1"  // optional
  }]
}
```

`GET /api/alerts` (its `alert_feed`) and `GET /api/alerts/<id>` show what LifeCycle read.

## Answer (`lifecycle.answer/v1`)

```jsonc
{
  "schema": "lifecycle.answer/v1",
  "question": "How is redeem rewards going?",
  "asked_at": "…",
  "outcome": "answered",       // answered | clarify | unknown_feature | no_data | not_supported (initiatives: also unknown_project; PRD requests: not_allowed)
  "intent": "status",          // status | blockers | availability | ramp | push | teams | other
  "feature": { "id": "redeem-rewards", "name": "…", "owner": "…" },   // null unless resolved
  "provider": { "name": "claude", "model": "claude-opus-5-5", "used": true, "note": null },
  "lead": { "text": "…", "cites": ["f1", "f3"], "by": "claude" },
  "sections": [{ "id": "blockers", "title": "Blockers · who to push", "statements": [
    { "id": "f2", "section": "blockers", "text": "… Push: @example-user.",
      "evidence": [{ "label": "PR #7 in …", "link": "https://github.com/…/pull/7" }],
      "push": { "owner": "@example-user", "message": "Hi @example-user, …" } }
  ]}],
  // sections: overall | blockers | last_mile | schedule | changes | alerts | steps | ramp (which ones depends on the intent)
  "blockers": [{ "statement": "f2", "owner": "@example-user", "message": "Hi …" }],
  "freshness": [{ "source": "flagsmith", "text": "Flag data is unavailable (…). Last successful read: …", "last_successful_read_at": "…" }],
  "candidates": [ /* clarify: closest features */ ],
  "defined_features": [ /* unknown_feature: every defined feature */ ]
}
```

**Ready to ramp?** ("Is X ready to ramp?", "Can we ramp X?") answers with the `ramp` section only,
built from the same `ramp` block the feature page shows ([status-format.md](status-format.md#ready-to-ramp-ramp)):
the verdict and summary, one statement per reason (with its owner and evidence), one per source that
couldn't be read (with its last successful read) and one listing every check and its result. The
lead says the verdict, how many reasons, and who to push.

### No PRDs from Ask (`outcome: "not_allowed"`, `intent: "prd"`)

Ask never creates a PRD (product requirements document), in the app, the AI tools or the CLI. A
request to create, write, draft or generate one ("Write a PRD for the Redeem rewards initiative")
is refused with "I can't create a PRD here…", before the create/edit flow or the AI provider is
involved: nothing is written to LifeCycle-Data or anywhere else. It is kept in the local history and
logged like any other question.

### Initiative answers (`scope: "project"` / `"projects"`)

An **initiative** is a LifeCycle project (`projects/<id>.yaml` in LifeCycle-Data); answers keep the
word "project" and treat "initiative" as a synonym. Statements come from the same rollup as
`GET /api/projects/<id>/status` (`src/projects.js`) and its features' live statuses
(`src/ask/projects.js`), with the same evidence and "never guess" rules as feature answers.

Which questions are about an initiative is decided by LifeCycle's rules (`src/ask/project-answer.js`),
the same for every provider and entry point:

- "initiative" / "project" in the question: the name is matched against the projects (an exact name
  or id, or one fitting clearly). Several fit: `outcome: "clarify"` listing them. None fits:
  `outcome: "unknown_project"`, "I couldn't find that initiative (…)" with the closest matches (or,
  with none close, every defined initiative) in `closest` / `defined_projects`.
- Without those words, only an exact project name counts. If that name is also a feature,
  `outcome: "clarify"` with `candidates: [{ kind: "feature", ask }, { kind: "project", ask }]`;
  `ask` is the same question pointed at one of them (`the feature "X"` / `the project "X"`).
  The word "feature" in the question always means a feature question.
- "features without an initiative" (or "no project"): the "No project" group (`project.id: null`).
- Across initiatives ("which initiatives are blocked?", "what's flowing?", "give me a status of all
  initiatives"): `scope: "projects"`, `intent: "list"`, `filter` (a state or null) and one `projects`
  statement per matching initiative: its state and a one-line reason. When none matches, the lead
  says so and the `all_projects` section lists every initiative's state.

```jsonc
{
  "schema": "lifecycle.answer/v1", "scope": "project", "outcome": "answered",
  "intent": "status",             // status | blockers | progress | availability | schedule | other
  "feature": null,
  "project": { "id": "redeem-rewards", "name": "Redeem rewards", "owner": "Mobile team" },  // id null = features without an initiative
  "project_state": { "state": "blocked", "rollup_state": "blocked",
                     "counts": { "blocked": 2, "unavailable": 0, "flowing": 1, "not_started": 0, "done": 0 }, "features": 3 },
  "lead": { "text": "Redeem rewards is blocked: 2 blocked, 1 flowing.", "cites": ["f1"], "by": "rules" },
  "sections": [ /* overall | blockers | remaining | unavailable | schedule | last_mile | outside, by intent */ ],
  "blockers": [{ "statement": "f2", "owner": "@releaser", "message": "Hi @releaser, …" }],
  "freshness": [ /* as for features, deduplicated across the initiative's features */ ]
}
```

| Section       | Statements                                                                                       |
|---------------|--------------------------------------------------------------------------------------------------|
| `overall`     | Combined state and how many features are in each state (`state`, `rollup_state`, `counts`); links the project status endpoint, the project view and its definition. An initiative with no features: "not started, no features yet". |
| `blockers`    | One per distinct blocker (the same blocker on two features appears once, naming both): what blocks them, the blocking PR/issue, who to push (`push`, `blocked_features`). |
| `remaining`   | "N of M features aren't done yet", then each feature not done with its current step and owner, linking the step's PR/issue and the feature view. |
| `unavailable` | A feature whose source can't be read: since when it last read fine, what can't be read, missing access. It is never counted as done or on. |
| `schedule`    | Only when features have target dates: the features putting the initiative at risk (`at_risk`), then each feature's date. |
| `last_mile`   | "In users' hands: N of M tracked features fully on", then each feature done but not turned on, not deployed, partly rolled out, in an experiment or held up in an app store, linking the flag setting, deploy record or store. |
| `outside`     | Dependencies on, or from, features in another initiative, linking that feature and its project. |

`project_state.state` is the rollup's state, except that an initiative the rollup calls done is
shown as `unavailable` ("can't be confirmed done") when a source behind one of its features can't
be read. The lead only uses numbers, names and dates from the statements it cites; an AI-written
lead goes through the same `checkLead` as for features.

A blocker is anything keeping the feature from users: a dependency that isn't done (push the owner of
its pending step), a broken dependency list (push the feature owner), or, once development is done,
a service not deployed or a flag off (push the service owner, else the feature owner).

## Digest (`lifecycle.digest/v1`)

Produced when the person opens LifeCycle (`POST /api/digest`), or from their AI tools. It covers the
features they **own** (their names in `me.owners` match the feature owner or a step owner) or
**follow** (`~/.lifecycle/follows.json`, toggled on a feature page or with `lifecycle_follow`).

Changes are found by comparing with the compact copy saved at the last digest
(`~/.lifecycle/digest-state.json`): state moves, PRs merged / issues closed, step changes, new and
cleared blockers, newly at risk of missing the target date (within `atRiskDays`, default 14, and not
fully on), flag changes per environment, deployed versions, registered changes and alerts not seen
before. A part that can't be read now is never reported as a change. The first digest (and a
feature new to someone's digest) shows where things stand plus the last 7 days of changes and
alerts. With nothing new: `outcome: "no_changes"` and "No changes since your last digest (…)".

```jsonc
{ "schema": "lifecycle.digest/v1", "produced_at": "…", "since": "…",
  "outcome": "changes",   // first | changes | no_changes | nothing_followed
  "headline": "1 of your 2 features changed since …",
  "features": [{ "id": "…", "name": "…", "relation": "owner", "state": "blocked", "last_mile": "…",
    "items": [{ "kind": "flag", "label": "Flag", "text": "rewards_enabled in production: off → on (…).",
                "evidence": [{ "label": "…", "link": "…" }] }] }],
  // kinds: now | new_in_digest | moved | blocked | blocked_new | unblocked | at_risk | at_risk_new | flag | experiment | deploy | change | alert
  // experiment: started, ended or a group's share of users changed, with the experiment's groups, shares and what each gets
  "following": [{ "id": "…", "name": "…", "relation": "following" }],
  // Initiatives holding any of the person's features: where each stands (first time), or what changed.
  "projects": [{ "id": "redeem-rewards", "name": "Redeem rewards", "state": "flowing",
    "items": [{ "kind": "project_moved", "label": "Combined state", "text": "Redeem rewards: blocked → flowing.", "evidence": [ /* project status, project view, … */ ] },
              { "kind": "feature_moved", "label": "Feature", "text": "Split catalog: blocked → flowing.", "evidence": [ /* feature view, its PRs/issues */ ] }] }],
  // project kinds: now | project_moved | feature_moved | feature_added. An unreadable state is never a change.
  "projects_headline": "1 initiative changed since …",
  "freshness": [ /* as in answers */ ] }
```

## AI provider

`~/.lifecycle/config.json` → `ai`:

| `provider`          | Needs                                                                      |
|---------------------|----------------------------------------------------------------------------|
| `claude` (default)  | an Anthropic API key: `ANTHROPIC_API_KEY`, or `npm run setup` (saved in `credentials.json`). Model `claude-opus-5-5` unless `ai.model` is set. Requests opt into Anthropic's server-side refusal fallback. |
| `openai-compatible` | `ai.apiUrl` (e.g. `http://localhost:11434/v1`), `ai.model`, optional key (`LIFECYCLE_AI_API_KEY` / `OPENAI_API_KEY` / setup) |
| `command`           | `ai.command`, a local CLI that reads the prompt on stdin and prints JSON, e.g. `["claude", "-p"]` |
| `none`              | nothing: LifeCycle's rules read the question and write the lead            |

The config is re-read on every question, so switching provider needs no restart and no code change.
If the provider can't be reached or has no key, the answer still comes from the data, with a note.

## Where it runs and what is kept

| Entry point     | How                                                                 |
|-----------------|---------------------------------------------------------------------|
| Local app       | **Ask & digest** page; digest card on Projects; `POST /api/ask`, `POST /api/digest` |
| Your AI tools   | `npm run mcp` (MCP server over stdio): `lifecycle_ask` (questions, and creating/editing/deleting features with an optional `session`), `lifecycle_digest`, `lifecycle_follow`, `lifecycle_features` |
| Terminal        | `npm run ask -- "How is X going?"`, `npm run ask -- --digest`       |

All three call the same service (`src/ask/service.js`), so they give the same answers. Everything
stays in `~/.lifecycle/` (mode 600): `history/asks.jsonl`, `history/digests.jsonl`,
`digest-state.json`, `follows.json`, and `logs/ask.log` (one line per question or digest: time,
entry point, feature, intent, outcome, provider). Tokens are redacted before anything is written.
Nothing is written to the shared repo or to this repo.

## Changing definitions from the chat (`lifecycle.chat-change/v1`)

A message that asks to create, edit, delete or promote a feature (or to "mark a step done") is
answered by `src/ask/change.js` instead of the question engine, in the app (`POST /api/ask` with
`session`) and in `lifecycle_ask` alike. The reply:

```js
{
  schema: 'lifecycle.chat-change/v1', kind: 'change', session, question, asked_at,
  outcome,      // ask_field | preview | invalid | no_change | confirm_again | saved | not_saved_yet | conflict
                // | declined | read_only | name_taken | name_close | status_is_live | clarify | unknown_feature | nothing_to_confirm
  text,         // the message in plain words (also in lead.text)
  feature,      // { id, name } or null
  ask,          // the one open question: { field, label, text, suggestion } (ask_field)
  proposal,     // the pending change: { op: create|update|delete, id, name, path, text (new feature YAML), diff, errors: [{ field, message }],
                //   review, dependents, suggestions: [{ field, value, why }], stale }
  can_confirm,  // true only for a valid preview: the next "yes" in the same session saves it
  offers,       // what the person can say next (status_is_live)
  result,       // the publish result once saved / kept locally
}
```

The conversation (`session`) is kept in `~/.lifecycle/chat/<session>.json` with at most one open
action, so a follow-up answer or "yes" reaches the change it belongs to. The app sends one per
page; an MCP connection has its own unless the tool passes `session`.
