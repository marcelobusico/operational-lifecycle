# Project, feature, step, task: what we call things

LifeCycle tracks work at four levels. Calling everything a "feature" makes the roadmap,
the alerts and the digest hard to read, so every screen and every definition in
LifeCycle-Data follows this rule.

| | Project | Feature | Step | Task |
|---|---|---|---|---|
| **What it is** | An initiative that groups features toward one business goal | Something a user can notice or use, complete on its own | A stage of a feature (design, development, release) | The smallest unit of technical work: a PR or issue |
| **Lasts** | Months | Weeks (1–2 sprints) | Days to weeks | Hours to days |
| **Points at** | Business outcome | User behaviour | Who does what next | Code, data or infrastructure |
| **Example** | Redeem rewards | Redeem rewards in the reader | Development (catalog team) | "Create the `catalog` table" |
| **In LifeCycle-Data** | `projects/<id>.yaml` | `features/<id>.yaml` | `steps:` inside a feature | `evidence:` (PR or issue) on a step |

## Is it a feature? Check all three

1. Would a user notice it, or be able to use it, once it's on?
2. Can it be released or turned on by itself (its own flag or deploy)?
3. Does it fit in a few weeks?

If any answer is no, it is not a feature:

- **Bigger than a few weeks, or several user-facing pieces** → a **project** with features inside.
- **A stage someone owns** (design, development, release) → a **step** of a feature.
- **A PR or issue** → a **task**, linked to a step.
- **Engineering work** (CI, release pipelines, test suites) → a task or step of the features it
  serves, not a feature of its own.

## How it is enforced

- **New feature form** (Add a feature): the rule above is shown open at the top,
  so the person writing the definition checks it before publishing.
- **Screens** count features only (for example "5 features"); a task is never counted as a feature.
- **Reviews of LifeCycle-Data changes**: a new `features/*.yaml` that fails the three checks is
  sent back with the level it belongs to (project, step or task).
