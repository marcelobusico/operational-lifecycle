# architecture

How the system is put together — layers, boundaries, and how data flows.

## Import review and approve

What: An import proposal becomes an editable review saved in `~/.lifecycle/import-review.json` (`lifecycle.import-review/v1`, one per machine); `src/import/approve.js` compiles it into the same drafts as the New feature form (create drafts, update drafts on existing features for steps under `existing:<id>` or duplicate `merge`, project drafts), and `src/import/review-store.js` approves by calling `featurePublisher.submit(..., via: 'import')` per file: projects, then creates in dependency order, then updates. New projects go through the feature outbox as `op: 'create-project'` entries · Why: Approve must reuse the existing publish path (one commit per feature as the person, conflict check, outbox), and the analysis jobs live only in memory, so edits need their own persisted copy to survive a reload or restart · Where: src/import/approve.js, src/import/review-store.js, src/features/publish.js, /api/import/review* in src/server.js · Learned: failed (non-queued) submits are discarded from the outbox because the review keeps the edit; a retry would otherwise publish a stale copy
