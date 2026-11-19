# Alerts: registered changes and delay warnings

LifeCycle tells people about changes to the features they own or depend on: changes **registered**
by teammates (flag, service, contract or decision changes), and **delay warnings** LifeCycle works
out itself. Everything runs in each person's own LifeCycle;
there is no central server. The **Alerts** page (`#/alerts`) shows the list.

| Source       | Comes from                                                     | `source` |
|--------------|----------------------------------------------------------------|----------|
| Registered   | `changes/<id>.yaml` in LifeCycle-Data, read with the definitions | `registered` |
| Delay warning| the feature definition (target date) + the live feature status | `lifecycle` |

A registered change or an alert is an announcement: **it never changes a feature's status**.

## Matching

A registered change matches the features it names. Every feature that depends on a named feature
(directly or through others, `depends_on`) is affected too, as a **dependent**.

## Registered changes (`changes/<id>.yaml` in LifeCycle-Data, format v2)

Registered from **Alerts → Register a change**. The form asks what will change (flag, service,
contract or decision, its name, and the change), which features it affects (chosen from the defined
features), whether it is planned (with a date) or already done, and why. Before publishing it shows
who will be notified: the owners (feature owner and step owners) of the affected features and of
every feature that depends on them.

```yaml
id: 2026-11-04-switch-off-rewards-flag-3f9a1c   # generated; equals the file name
what: { type: flag, name: rewards_enabled }     # required: flag | service | contract | decision
change: Switch off the rewards flag in production   # required
features: [rewards]                             # required: affected feature ids
state: planned                                  # planned | done | cancelled
planned_for: 2026-11-10                         # required when planned
reason: Incident follow-up                      # required
registered_by: "@example-user"               # the author's GitHub user (from GitHub, GET /user)
registered_at: 2026-11-04T10:00:00Z
updated_at: …                                   # on updates / cancellations
updated_by: "@example-dev"
revision: 1                                     # +1 on every update or cancellation
link: https://…                                 # optional evidence link
```

Only these fields are accepted (plus the earlier v1 fields `feature`, `kind`, `summary`, still
read): no names, emails, notes or credentials, and no value that looks like a token.

### Publishing

- **Direct commit** to `main` of LifeCycle-Data (GitHub contents API, with the person's own GitHub
  credentials, which need write access). No pull request, no review step. With
  `LIFECYCLE_DATA_PATH`, the file is written to that folder instead.
- **Missing what, which feature or why**: not published; the answer (HTTP 400) lists each error
  with its form field (`what`, `features`, `reason`, `planned_for`, `link`).
- **Two people at once**: each new change is its own file with a random suffix, so both land. An
  update or cancellation carries the `revision` it was based on; if the file moved on (or GitHub
  answers 409/422), nothing is written, the person is told who published which revision, and
  their edit stays in the outbox (`conflict`).
- **Repo unreachable**: the change is kept in `~/.lifecycle/outbox/<id>.json` and the person is
  told "Not published yet …". Every refresh retries it (also **Retry now** on the Alerts page).
  Nothing is dropped; the person can discard it explicitly.

### Who gets an alert, and when

When a person opens or refreshes LifeCycle, each alert about a feature they **own** (their names in
`me.owners` match the feature owner or a step owner), that **depends** on what changed, or that they
**follow**, and that they haven't seen, is shown as **new** (badge, banner, "New" tag), then marked
seen in `~/.lifecycle/alerts-seen.json`. One registered-change revision is one alert
(`change:<id>@r<revision>`), so an update or cancellation reaches the same people again, and a
refresh or retry never repeats it. Your own changes are never "new" for you. People whose
LifeCycle isn't open aren't notified any other way; they see it next time they open it.

Each registered change also appears on the **timeline** of every feature it
affects or that depends on it (feature page).

## Delay warnings

Worked out by LifeCycle from the target date in the feature definition and the live status of its
steps. A feature is warned when

    days left before target_date  <  open steps × delay.daysPerStep   (default 3, ~/.lifecycle/config.json)

The warning names each open step and its owner (a step whose source can't be read counts as open,
marked "state unknown"). It shows on the feature page and in the alert list (`delay:<feature>:<date>`,
one per target date). A feature with no `target_date` shows **"no target date: delay warnings off"**.

## API

| Call | What |
|------|------|
| `GET /api/alerts[?source=registered\|lifecycle][&cached=1]` | `lifecycle.alert-list/v1`: `alerts` (with `mine`, `new`), `delay` per feature, `outbox`, and `alert_feed` (what Ask & digest read, `lifecycle.alerts/v1`) |
| `POST /api/alerts/seen` `{ ids }` | mark alerts seen |
| `POST /api/changes/preview` `{ features }` | who will be notified |
| `POST /api/changes` `{ draft }` | register and publish |
| `PUT /api/changes/<id>` `{ draft, base_revision }` | update a change |
| `POST /api/changes/<id>/cancel` `{ reason?, base_revision }` | cancel it |
| `GET /api/changes` | registered changes + outbox |
| `POST /api/outbox/retry`, `POST /api/outbox/<id>/discard` | retry / discard what's waiting |

Outcomes: `published` (200), `queued` / `not_published` (202), `conflict` (409), `invalid` (400).

## Local log

`~/.lifecycle/logs/alerts.log`, one JSON line per event with `feature` and `source`: `alert` (shown
to this person as new), `publish`, `publish_failed`, `publish_conflict`, `outbox_discarded`.
Lines pass through the token redactor; no token is ever written.
