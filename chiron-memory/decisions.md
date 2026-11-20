# decision

A choice made and the reasoning behind it — the path taken over the alternatives.

## Refresh Data stays available to read-only users

What: The "Refresh Data" button (live read of every source) is enabled for everyone, including people with read-only access to LifeCycle-Data and local-data-folder users; only saving flag/store/Jira snapshots to the shared repo requires write access (canWrite) · Why: pull request, GitHub Actions and deploy results are cached only on each machine and never shared through the repo, so gating the live read on write access would freeze read-only users' status at their first launch · Where: src/app.js (canWrite), public/index.html (#refresh-data), test/refresh-buttons.test.js · Learned: gate the publish step, not the read, when part of the data has no shared fallback

## Import from links never trusts the AI's ids: evidence and links must come from what was read

What: The import proposal (src/import/analyze.js normalizeProposal) keeps an item's evidence only if that Jira ticket / GitHub PR or issue was actually read in this analysis (and Jira keys match JIRA_KEY), source_links only from the S-ids of documents sent, and parents only at the right level; reads are read-only (githubRead forces GET, Jira via runClaude lockdown) · Why: the proposal feeds publishing to LifeCycle-Data later, so an invented PR number or ticket key would become false evidence on a step · Where: src/import/analyze.js, src/import/read-jira.js, src/app.js (githubRead), docs/import-format.md, test/import.test.js · Learned: a new import source plugs in by returning {docs, evidence}; the AI only sees those, so validation stays in one place
