// What a step's evidence item is called and how it is told apart, whatever system it comes from:
// GitHub (pr / issue: repo + number) or Jira (ticket: key). One place, so labels read the same in
// the UI, chat, digest, alerts and ramp verdict.
export const evidenceId = (e) => (e.source === 'jira' ? `jira:${e.key}` : `${e.source}:${e.repo}:${e.type}:${e.number}`);
export const evidenceLabel = (e) => (e.source === 'jira' ? `Jira ${e.key}` : `${e.type === 'pr' ? 'PR' : 'issue'} #${e.number} in ${e.repo}`);
// Short form for running text ("PR team/app#12", "Jira ABC-123").
export const evidenceShort = (e) => (e.source === 'jira' ? `Jira ${e.key}` : `${e.type === 'issue' ? 'issue' : 'PR'} ${e.repo}#${e.number}`);
