# decision

A choice made and the reasoning behind it — the path taken over the alternatives.

## Refresh Data stays available to read-only users

What: The "Refresh Data" button (live read of every source) is enabled for everyone, including people with read-only access to LifeCycle-Data and local-data-folder users; only saving flag/store/Jira snapshots to the shared repo requires write access (canWrite) · Why: pull request, GitHub Actions and deploy results are cached only on each machine and never shared through the repo, so gating the live read on write access would freeze read-only users' status at their first launch · Where: src/app.js (canWrite), public/index.html (#refresh-data), test/refresh-buttons.test.js · Learned: gate the publish step, not the read, when part of the data has no shared fallback
