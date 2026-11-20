# Import from links: the import proposal

**Import from links** (the button on the *Roadmap*, `#/import`) reads plans that already exist in Jira
and GitHub and proposes what LifeCycle should track: projects, features inside them, steps inside
features, and tasks linked to steps. This document is the contract between the screen that produces
a proposal and the work that edits and publishes it.

**The analysis writes nothing.** It reads Jira through Claude Code with read-only tools (the
Atlassian connector's write tools are refused), reads GitHub with GET requests only, and keeps the
proposal in memory on this machine. Only **Approve** in the review (below) writes, and only to
LifeCycle-Data; nothing is ever written to Jira or GitHub repositories other than LifeCycle-Data.

## Links it reads

| Pasted | Kind | What is read |
|---|---|---|
| `https://<site>.atlassian.net/browse/ABC-123` (or `*.jira.com`), a board link with `?selectedIssue=ABC-123`, or `ABC-123` in capitals (lowercase `utf-8` or `covid-19` in pasted notes are not keys) | `jira` | The ticket, on the site of the pasted link; a bare key is read on the site in `sources.jira.siteUrl`, else on the only site pasted. An epic is read with the issues under it (`parent = KEY OR "Epic Link" = KEY`). |
| `https://github.com/owner/repo` or `github.com/owner/repo` (a bare `owner/repo` is not taken, so words like CI/CD in pasted notes aren't read as repositories) | `github_repo` | README, the Markdown/text files in `docs/`, and the most recently updated PRs and issues (open and closed). **Source code is never read.** |
| `https://github.com/owner/repo/pull/12` | `github_pr` | That PR and its description. |
| `https://github.com/owner/repo/issues/7` | `github_issue` | That issue and its description. |
| `https://github.com/owner/repo/blob/<ref>/<path>` | `github_file` | That one file at that ref (e.g. a plan committed to the repo). A branch name with slashes works: the possible ref/path splits are tried, shortest ref first, until one is a file. |
| `https://<site>.atlassian.net/wiki/…` | `confluence` | Nothing yet: shown as *not read yet*. |
| anything else | `unrecognized` | Nothing: shown with the reason, never dropped silently. |

Links can be pasted one per line, separated by spaces or commas, or inside text: Markdown links
(`[Epic](https://…)`, parentheses inside the URL included) give their URL, and punctuation around a
link is not part of it. GitHub links are read three at a time, so a long paste doesn't trip GitHub's
rate limit. If the AI's answer is cut off at the provider's length limit, the analysis fails with that
reason and suggests fewer links.

At most 50 links per analysis; past that, one entry says how many more were not taken. Jira is read on any machine with Claude Code signed in to Atlassian,
whether or not `sources.jira.enabled` is on; if that run fails, every Jira link shows as failed with the fix.

## Caps

Reads are capped per source; whatever a cap leaves out is listed in that source's `left_out`.
Change them in `~/.lifecycle/config.json`:

```json
"import": { "maxStoriesPerEpic": 25, "maxPrsPerRepo": 20, "maxIssuesPerRepo": 20, "maxDocsPerRepo": 10, "maxCharsPerSource": 20000 }
```

A PR's or issue's description in a repository's list is cut at 2,000 characters, and one analysis
sends the AI at most 300,000 characters (documents beyond that are listed in `left_out`).

## AI provider

The analysis uses the provider set up for Ask & digest (`ai.provider`, [ask-format.md](ask-format.md)):
`claude`, `claude-code`, `openai-compatible` or `command`. With `"none"`, the screen explains how to set
one up, and nothing is read or proposed. The AI decides each item's level with the rule in
[terminology.md](terminology.md) (never by Jira issue type) and says why in `level_reason`.
Claude gets room for a 20,000-token answer. An `openai-compatible` provider gets an output limit only
when `ai.maxOutputTokens` is set, since models differ (some cap lower, reasoning models refuse
`max_tokens`); otherwise the model's own limit applies.

## Shape (`lifecycle.import-proposal/v1`)

```
{
  "schema": "lifecycle.import-proposal/v1",
  "analyzed_at": "2026-11-20T12:00:00.000Z",
  "provider": { "name": "claude", "model": "…" | null },
  "sources": [{
    "input": "what was pasted", "kind": "jira | github_repo | github_pr | github_issue | github_file | confluence | unrecognized",
    "label": "Jira epic RWD-1: Redeem rewards (3 issues under it read)", "url": "https://…" | null,
    "status": "read | failed | unrecognized | unsupported", "reason": "why not read" | null,
    "left_out": ["38 more issues under BIG-1 not read (limit 25 per epic)"]
  }],
  "items": [{
    "ref": "f1",                       // unique within the proposal
    "level": "project | feature | step | task",
    "name": "Redeem rewards", "description": "…",
    "parent": "p1" | null,             // feature → project, step → feature, task → step
    "owner": "@handle or team" | null, // only when a source names one
    "done_when": "…" | null,           // steps only
    "evidence": [                      // steps and tasks only; only tickets/PRs/issues that were read
      { "source": "jira", "type": "ticket", "key": "RWD-2" },
      { "source": "github", "type": "pr" | "issue", "repo": "owner/repo", "number": 12 }
    ],
    "source_links": ["https://…/browse/RWD-1"], // where the item comes from
    "level_reason": "Fails check 1: users never notice CI, so it is a task of the features it serves.",
    "possible_duplicate": { "id": "wishlist", "name": "Wishlist", "kind": "feature" | "project" } | null
  }]
}
```

What the AI returns is checked before it is shown: unknown levels and empty names are dropped,
parents must exist at the right level, evidence and source links must be ones that were actually read
and sent to the AI (nothing invented; a PR or ticket whose text was left out for the size limit can't
be linked either), and Jira keys must be valid keys (`ABC-123`). A feature or project whose whole name
matches an existing one (ignoring case, punctuation, little words and spacing; or its id; or nearly
all words shared) is marked `possible_duplicate`, naming it. A name that only mentions an existing
one ("Search inside checkout history" next to "Checkout") is not. Duplicates are checked against the features
and projects LifeCycle last read from the shared repo; if it hasn't read them yet, the proposal says
so (`duplicates_checked: false`, `duplicates_note`) instead of starting a full read.

## API: analysis (local only)

- `POST /api/import/links {text}` → `{links, ai}`: what each link is, before anything is read.
- `GET /api/import/ai` → `{available, provider, message}`.
- `POST /api/import/analyze {text}` → 202 `{outcome: "started", id}`; 409 `running` (one at a time);
  503 `no_ai`; 400 `no_links`.
- `GET /api/import/analyze/<id>` → `{state: running|done|failed, phase: reading|analyzing|done|failed, sources, proposal, message}`.
  Analyses are kept in memory (the last five) while LifeCycle runs. 404 `{reason: replaced|unknown, message}`:
  `replaced` when newer analyses took its place, `unknown` otherwise (e.g. LifeCycle restarted).

## Review and approve (`lifecycle.import-review/v1`)

**Review and approve…** under a finished proposal turns it into an editable review, saved in
`~/.lifecycle/import-review.json` (one per machine) as it is edited, so leaving the screen, a reload or
a LifeCycle restart keeps the edits. Starting a review of another analysis while one has unpublished
edits asks first (409 `has_review`).

Each item is the proposal item plus what the person can change: `level`, `parent`, `name`, `id`
(projects and features: the file name), `description`, `owner`, `team` (steps), `target_date` and
`depends_on` (features), `done_when` (steps), `evidence` (steps and tasks), `included` (excluded items
stay in the review, unpublished) and `duplicate_choice` (`skip`, `create` or `merge`; an item marked
`possible_duplicate` is blocked until the person chooses). `source_links`, `level_reason`,
`original_level` and `possible_duplicate` are read-only.

- `parent`: another item's `ref`, or `existing:<id>`: a defined project (for a feature) or a defined
  feature (for a step, which adds the step to that feature). A feature's project is its parent.
- `depends_on`: defined feature ids, or `ref:<ref>` for another proposed feature.
- Changing the level re-parents the item: a feature turned into a step of another feature becomes one
  of its steps (one file, not two). Children of an excluded or skipped item are not imported either.
- A task is a PR, issue or ticket linked to a step (docs/terminology.md): its evidence goes on its step.
- `merge` on a feature adds its steps and their evidence to the existing feature (one edit of that
  file, no new file); on a project, its features go into the existing project.

**Check** compiles the review into the drafts the New feature form sends (`src/import/approve.js`) and
runs the same validation and AI product review (`src/features/review.js`) on each, against the defined
features and projects plus the proposed ones. Each item gets `check: {state, errors, findings, reason,
review_note, review_ran}`; `state` is `ready`, `invalid` (an error, shown on its field), `blocked` (an
AI contradiction), `excluded` or `skipped`. Ambiguities are shown as suggestions and don't block. A
step or task is ready when the feature it lands in is. Without a reachable AI provider the review is
reported as not run and valid items are ready. `plan` lists the files Approve would write.

**Approve** (write access to LifeCycle-Data only; otherwise 403 `read_only` with the reason) refreshes
the definitions, checks again, then publishes the ready items through the feature publisher
(`src/features/publish.js`): new projects first, then new features in dependency order, then additions
to existing features; one commit per file under the person's GitHub identity ("from LifeCycle import"),
with the conflict check. When the shared repo can't be reached they wait in the local outbox (projects
too) and publish on a later refresh, in order. Each item gets `published: {kind, op, id, queued, at}`
or, when it failed, `result: {outcome, message, errors}` and stays in the review to fix and approve
again. `last_approval.results` lists each file with its outcome and a link to its page.

## API: review (local only)

- `GET /api/import/review` → `{review, fresh, ready, busy, access}`; `fresh` is false after an edit
  since the last check; `ready` counts the files Approve would write.
- `POST /api/import/review {analysis_id, replace?}` → starts a review of a finished analysis.
- `PUT /api/import/review {revision, edits: [{ref, ...fields}]}` → saves edits (409 when another window
  saved a newer revision).
- `POST /api/import/review/check`, `POST /api/import/review/approve` (→ `results`), `POST /api/import/review/discard`.

## Adding a source type

A reader turns one link into `{status, reason, label, url, docs: [{origin, title, text, evidence?}], evidence, left_out}`
(`src/import/read-*.js`). A doc that is the text of a ticket, PR or issue names it in `evidence`
(`jira:ABC-1`, `pr:owner/repo#12`, `issue:owner/repo#7`); only those whose doc was sent may be
linked. The analysis only sees `docs` (plain text with its origin link) and `evidence`, so a new
source (e.g. Confluence) plugs in without changing the proposal.

Caps and the Jira site are read from `~/.lifecycle/config.json` at the start of each analysis, so a
change applies to the next Analyze without restarting LifeCycle.
