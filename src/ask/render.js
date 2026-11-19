// Markdown for answers and digests, used by the AI-tools entry point (MCP) and the CLI. The
// browser renders the same JSON with the same structure. Relative links (/api/…) are made
// absolute against the local app's URL so they open from any tool.

const abs = (link, baseUrl) => (link && link.startsWith('/') ? `${baseUrl}${link}` : link);
const evidence = (list, baseUrl) => list.map((e) => `[${e.label}](${abs(e.link, baseUrl)})`).join(', ');

// When the statement's source was last read, or since when it is unavailable.
const utc = (iso) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
function readNote(f) {
  if (f.unavailable_since) return ` · source unavailable since ${utc(f.unavailable_since)}${f.read_at ? `, last read ${utc(f.read_at)}` : ''}`;
  return f.read_at ? ` · read ${utc(f.read_at)}` : '';
}

function providerLine(p) {
  if (!p) return '';
  const who = p.used ? `${p.name}${p.model ? ` (${p.model})` : ''}` : 'LifeCycle rules';
  return `_Answered with ${who}. Built only from LifeCycle's live status, registered changes and alerts._${p.note ? `\n_${p.note}_` : ''}`;
}

const shown = (v) => (Array.isArray(v) ? (v.length ? v.join(', ') : '—') : v || '—');

// A chat reply about changing a definition (src/ask/change.js): the message, then the pending change —
// the full definition for a new feature, or a before/after of only what changes — and what to say.
export function changeMarkdown(c) {
  const out = [c.text];
  const p = c.proposal;
  if (p?.text && c.outcome === 'preview') out.push(`**Proposed definition** (\`${p.path}\`)\n\n\`\`\`yaml\n${p.text.trim()}\n\`\`\``);
  if (p?.op !== 'create' && p?.diff?.length && ['preview', 'invalid'].includes(c.outcome)) {
    out.push(`**Before → after** (\`${p.path}\`)\n${p.diff.map((d) => {
      if (d.added_step) return `- ${d.label}: added (owner ${d.to.owner || '—'}, done when ${d.to.done_when || '—'})`;
      if (d.removed_step) return `- ${d.label}: removed`;
      if (d.changes || d.attached) return `- ${d.label}: ${[...(d.changes || []).map((x) => `${x.key} ${shown(x.from)} → ${shown(x.to)}`), ...(d.attached || []).map((x) => `attach ${x}`)].join('; ')}`;
      if (d.added || d.removed) return `- ${d.label}: ${[...(d.added || []).map((x) => `+${x}`), ...(d.removed || []).map((x) => `−${x}`)].join(', ')}`;
      return `- ${d.label}: ${shown(d.from)} → ${shown(d.to)}`;
    }).join('\n')}`);
  }
  if (p?.dependents?.length) out.push(`**Depends on it**\n${p.dependents.map((d) => `- ${d.name} (\`${d.id}\`, owner ${d.owner})`).join('\n')}`);
  if (p?.errors?.length) out.push(`**Problems**\n${p.errors.map((e) => `- \`${e.field}\`: ${e.message}`).join('\n')}`);
  if (p?.review?.findings?.length) out.push(`**AI product review**\n${p.review.findings.map((f) => `- ${f.kind} · \`${f.field}\`: ${f.message}${f.suggestion ? ` (${f.suggestion})` : ''}`).join('\n')}`);
  if (c.offers?.length) out.push(`**What I can do**\n${c.offers.map((o) => `- "${o}"`).join('\n')}`);
  if (c.candidates?.length && c.outcome !== 'preview') out.push(c.candidates.map((f) => `- ${f.name} (\`${f.id}\`)`).join('\n'));
  if (c.can_confirm) out.push('_Nothing is saved until the person says yes. Relay this and wait for their answer; never confirm on their behalf._');
  return out.join('\n\n');
}

export function answerMarkdown(a, { baseUrl = 'http://lifecycle.localhost:4317' } = {}) {
  if (a.kind === 'change') return changeMarkdown(a);
  const out = [];
  if (a.feature) out.push(`**${a.feature.name}** (\`${a.feature.id}\`)`);
  if (a.project) out.push(`**${a.project.name}** (project${a.project.id ? ` \`${a.project.id}\`` : ''})`);
  out.push(a.lead.text + (a.lead.cites?.length ? ` [${a.lead.cites.join(', ')}]` : ''));
  if (a.outcome === 'unknown_feature') {
    if (a.closest?.length) out.push(`Closest names: ${a.closest.map((f) => `${f.name} (\`${f.id}\`)`).join('; ')}.`);
    out.push(`Defined features:\n${a.defined_features.map((f) => `- ${f.name} (\`${f.id}\`)`).join('\n') || '- none'}`);
  }
  if (a.outcome === 'unknown_project' && a.defined_projects?.length) out.push(`Defined projects (initiatives):\n${a.defined_projects.map((p) => `- ${p.name} (\`${p.id}\`)`).join('\n')}`);
  if (a.outcome === 'clarify') out.push(a.candidates.map((f) => `- ${f.kind ? `${f.kind} ` : ''}${f.name} (\`${f.id}\`)${f.ask ? `: ask "${f.ask}"` : ''}`).join('\n'));
  for (const s of a.sections || []) {
    out.push(`**${s.title}**\n${s.statements.map((f) => {
      const push = a.blockers?.find((b) => b.statement === f.id);
      return `- [${f.id}] ${f.text}${f.info ? '' : ` — ${evidence(f.evidence, baseUrl) || (f.no_source_item ? `_no source item: ${f.no_source_item}_` : '_no evidence link_')}${readNote(f)}`}${push ? `\n  - Suggested message to ${push.owner}: "${push.message}"` : ''}`;
    }).join('\n')}`);
  }
  const stale = (a.freshness || []).filter((x) => !x.info);
  if (stale.length) out.push(`**Out of date**\n${stale.map((x) => `- ⚠ ${x.text}`).join('\n')}`);
  out.push(providerLine(a.provider));
  return out.filter(Boolean).join('\n\n');
}

export function digestMarkdown(d, { baseUrl = 'http://lifecycle.localhost:4317' } = {}) {
  const out = [`**Your LifeCycle digest** · ${d.since ? `since ${d.since.slice(0, 16).replace('T', ' ')} UTC` : 'first digest'}`];
  out.push(d.headline);
  for (const f of d.features) {
    if (!f.items.length) continue;
    out.push(`**${f.name}** (\`${f.id}\`, ${f.relation})\n${f.items.map((i) => `- ${i.label}: ${i.text} — ${evidence(i.evidence, baseUrl) || '_no evidence link_'}`).join('\n')}`);
  }
  if (d.projects?.length) {
    out.push(`**Initiatives** · ${d.projects_headline}`);
    for (const p of d.projects) out.push(`**${p.name}** (project, ${p.state.replace(/_/g, ' ')})\n${p.items.map((i) => `- ${i.label}: ${i.text} — ${evidence(i.evidence, baseUrl) || '_no evidence link_'}`).join('\n')}`);
  }
  const stale = (d.freshness || []).filter((x) => !x.info);
  if (stale.length) out.push(`**Out of date**\n${stale.map((x) => `- ⚠ ${x.text}`).join('\n')}`);
  return out.join('\n\n');
}
