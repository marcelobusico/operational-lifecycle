# Product review rules

Read the definition as a PM and as the engineers who will do the work. Look for:

**Ambiguities**
- A `done_when` that can't be checked against a PR, issue or record: vague words
  ("works well", "mostly done", "ready", "good UX"), or no observable outcome.
- A `done_when` that bundles several outcomes owned by different people.
- An `owner` that isn't a person, @handle or named team ("TBD", "someone", "eng").
- A step name that doesn't say what the work is ("Step 2", "Misc").
- A `development` / `review` / `merge` step with no `evidence` yet. That's allowed, but say
  it will show "no linked work" until the PR or issue is added.

**Contradictions**
- Step order that contradicts the `done_when` texts (e.g. "Release" before "Development", or a
  `done_when` that requires a later step to have happened).
- A `done_when` that contradicts the evidence type (e.g. "merged to main" but the evidence is an
  issue, not a PR).
- `target_date` earlier than a dependency's `target_date` (read the dependency's file).
- `depends_on` that contradicts the text (e.g. a step mentions needing the rewards API but
  `rewards` isn't in `depends_on`, or a dependency is listed that nothing in the steps needs).
- `services` / `flags` that the steps never mention, or steps that clearly touch a service
  that isn't listed.
- Two steps with the same responsibility or overlapping `done_when`.

**Never allowed**
- Any token, password or credential anywhere in the file. The validator catches common GitHub
  token formats; also flag anything that looks secret.
