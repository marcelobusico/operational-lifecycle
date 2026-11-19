# Teams with ownership (`lifecycle.teams/v1`, `lifecycle.team-dependencies/v1`)

LifeCycle-Data is the official list of teams and what each one owns. A team is one file,
`teams/<id>.yaml`, with a fixed id, the name people chose, an optional description, optional
aliases and what it owns. The format, as teams write it, is below.
Code: `src/teams/` (registry, dependencies, edit, publish, chat), validation in
`src/definitions.js` (`validateTeamDefinition`).

## Rules

- **Only team data.** The validator accepts `id`, `name`, `description`, `aliases` and `owns`
  (`repos`, `tickets`, `services`, `apps`, `flags`), and nothing else. Any other field (`members`,
  `lead`…), any value that looks like an email or an `@handle`, and anything that looks like a token
  is refused, naming the field.
- **Ticket sources** are `{ repo: owner/name }` (every issue in that repo) or `{ label: name }`
  (issues with that label, optionally `repo:` too). LifeCycle doesn't read issue labels, so only the
  repo form links a step's issue to a team; label sources count for ownership and conflicts.
- **One team per key.** An id, name or alias may belong to one team only (the second file is
  reported as invalid).
- **References.** A feature's `owner`, a step's `team` (and a step `owner` that names a team), a
  service's `owner` and a project's `owner` resolve to a team by **exact** id, name or alias (after
  trimming). A step `team` that resolves to nothing, or an owner that reads like a team ("… team",
  "… squad") and resolves to nothing, is an **unknown team** warning (`team_warnings` on the
  feature); the rest keeps displaying.
- **Claims.** A team claims what it lists under `owns`; a service's `owner:` and a mobile app's
  `owner:` (`apps/<id>.yaml`) naming a team are claims on that service or app too. Two teams claiming the same thing is an **ownership conflict** naming both.
  Services, repos (service repos and evidence repos), flags and apps used by active features that no
  team claims are listed as **no owner**.
- **Suggestions.** Free-text team names used by active features (unknown teams) are offered as
  suggested teams (`Rewards team` → id `rewards`, name `Rewards`, alias `Rewards team`, plus the
  services whose `owner` is that name), or as an alias of an existing team with that id.

## Teams a feature depends on

`teamDependencies` (`src/teams/dependencies.js`) gives, for a feature, each team with
its reasons; the feature page, `GET /api/features/<id>/teams` and the chat answer
to "which teams do I depend on for X?" all use it, so they always agree. Reasons (`kind`):

| kind | the team… | link |
|---|---|---|
| `owner` | is the feature's owner | the feature |
| `step` | is a step's `team` (or names a step's owner) | the feature |
| `service` | owns a service the feature lists | the service definition |
| `repo` | owns a repo the feature touches (its services' repos, its evidence repos) | the repo |
| `tickets` | owns the issues of a repo a step links an issue in | the issue |
| `flag` | owns a flag the feature lists (`flags:`) | the feature |
| `app` | owns an app the feature ships in (`apps:`, by app id) | the app definition |
| `dependency` | has any reason above on a feature this one depends on, followed through to the end (`via` is the path, `reason_kind` the inner reason) | the dependency |

The view also lists the feature's unknown team names, the conflicts and "no owner" items among what
it touches, and dependency ids that aren't defined.

## Editing

- `POST /api/team-definitions/preview` `{ op, id?, draft, handover_to? }` → diff, file text,
  validation (nothing written).
- `POST /api/team-definitions` `{ draft }`, `PUT /api/team-definitions/<id>` `{ draft, base_hash }`,
  `POST /api/team-definitions/<id>/delete` `{ handover_to? | leave_unowned, confirm_unowned }`.
- Same access check, identity and file operations as feature edits: anyone with write access to
  LifeCycle-Data; read-only users get `read_only` with the reason. Commits go to `main` as
  `Add team wishlist (by @ana from LifeCycle)`, `Rename team wishlist: Wishlist → Reading wishlist (…)`.
  Unlike feature edits there is no local outbox: when the repo can't be reached nothing is written.
- **Rename** keeps the id. If something still names the team by its old name, the old name is
  added to `aliases` so it keeps resolving.
- **Delete** of a team that owns something or is referenced answers `needs_decision` with
  `affected: { owns, references }`. With `handover_to` its ownership is merged into that team and
  every reference is rewritten to that team's id. With `leave_unowned` it answers `confirm_unowned`
  first; with `confirm_unowned` too, optional references (service/project `owner`, step `team`) are
  removed and required ones (feature/step `owner`) are left, showing "unknown team" until changed.
  One commit per file, the team file last.

## From the chat

A team command typed in Ask (`src/teams/chat.js`) never writes directly: the answer has
`outcome: proposed_action` and an `action` with the preview. `POST /api/ask/actions/<id>/confirm`
(with the delete choices) publishes it through the same path; `…/cancel` drops it. Actions are kept
in memory for 30 minutes. Understood commands:

- `create a team called Wishlist that owns the acme-wishlist repo and the redeem_rewards flag`
  (a bare repo name gets the owner most repos in LifeCycle-Data use)
- `rename team wishlist to Reading wishlist`, `describe team wishlist as …`
- `team wishlist now owns the catalog-api service`, `add the wishlist-ios app to team wishlist`,
  `remove the redeem_rewards flag from team wishlist`, `issues labelled wishlist`, `tickets of <repo>`
- `delete team catalog`, `delete team catalog and hand it over to platform`
