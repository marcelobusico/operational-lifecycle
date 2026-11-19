// Which feature does a question mean? Deterministic, so every provider and every entry point
// (local app, AI tools) resolves names the same way. The AI may extract the mention from the
// question; matching it to a defined feature always happens here.

const STOP = new Set(['the', 'a', 'an', 'of', 'for', 'on', 'to', 'in', 'is', 'it', 'and', 'with', 'feature', 'features', 'project']);

// Words that are about the question, not the feature's name.
const QUESTION_WORDS = /\b(ready to ramp|ready|ramp(?:ed|ing)?|feasib\w*|doable|realistic|viable|could|would|ship|build|deliver|how('?s| is| are)?|what('?s| is| are)?|who|whom|do|does|did|i|we|should|push|ping|chase|on|going|go|doing|status|update|progress|blocking|blocked|blockers?|holding|up|available|availability|users?|customers?|live|turned|enabled|is|are|it|there|any|tell|me|about|the|please|now|today|yet|can|get)\b/gi;

export function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const stem = (w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);
export const tokens = (text) => normalize(text).split(' ').filter((w) => w && !STOP.has(w)).map(stem);

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

// 1 = same word, 0.8 = one typo away (words of 4+ letters), else 0.
function wordMatch(q, w) {
  if (q === w) return 1;
  if (q.length >= 4 && w.length >= 4 && editDistance(q, w) <= 1) return 0.8;
  return 0;
}

// Strips the question wording and returns what is left: the feature mention.
export function extractMention(question) {
  const q = String(question || '').replace(/[?!.]+\s*$/, '');
  const quoted = q.match(/["“']([^"”']{2,})["”']/);
  if (quoted) return quoted[1].trim();
  return q.replace(QUESTION_WORDS, ' ').replace(/\s+/g, ' ').trim();
}

// features: [{ id, name }]. Returns
//   { kind: 'match', feature }                     one feature clearly meant
//   { kind: 'ambiguous', mention, candidates }     several fit: ask which one (closest first)
//   { kind: 'unknown', mention, closest }          none fits
export function resolveFeature(mention, features) {
  const m = String(mention || '').trim();
  const qTokens = tokens(m);
  if (!m || !qTokens.length) return { kind: 'unknown', mention: m, closest: [] };
  const nm = normalize(m);

  // Exact id or exact name (ignoring punctuation).
  const words = new Set(m.toLowerCase().split(/[^a-z0-9-]+/));
  // A whole feature id written in the question ("redeem-rewards"), or exactly the feature's name.
  // A bare word that happens to be an id ("rewards") isn't exact: other names may contain it too.
  const exact = features.filter((f) => (f.id.includes('-') && words.has(f.id)) || normalize(f.name) === nm);
  if (exact.length === 1) return { kind: 'match', feature: exact[0] };

  const scored = features.map((f) => {
    const vocab = [...new Set([...tokens(f.name), ...tokens(f.id)])];
    // How much of the question's mention this feature's name covers.
    const hits = qTokens.map((q) => Math.max(0, ...vocab.map((w) => wordMatch(q, w))));
    const coverage = hits.reduce((a, b) => a + b, 0) / qTokens.length;
    // How much of the feature's own name the mention says (tie-breaker: "rewards" fits a
    // one-word name better than a four-word one).
    const nameWords = tokens(f.name);
    const named = nameWords.filter((w) => qTokens.some((q) => wordMatch(q, w))).length / Math.max(1, nameWords.length);
    return { feature: f, coverage, named, full: hits.every((h) => h > 0) };
  }).sort((a, b) => b.coverage - a.coverage || b.named - a.named || a.feature.name.localeCompare(b.feature.name));

  // The mention contains one feature's whole name ("budget for redeem rewards"): that one.
  const named = scored.filter((s) => s.named === 1);
  if (named.length === 1 && !scored.some((s) => s.full && s !== named[0])) return { kind: 'match', feature: named[0].feature };

  const full = scored.filter((s) => s.full);
  if (full.length === 1) return { kind: 'match', feature: full[0].feature };
  if (full.length > 1) {
    // Several names contain every word: only pick one if it is named entirely and the rest aren't.
    const complete = full.filter((s) => s.named === 1);
    if (complete.length === 1 && full.every((s) => s === complete[0] || s.named < 1)) {
      const others = full.filter((s) => s !== complete[0]);
      // "redeem rewards" names all of "Redeem rewards" and only part of the others: that's it.
      if (others.every((s) => s.named < 0.75)) return { kind: 'match', feature: complete[0].feature };
    }
    return { kind: 'ambiguous', mention: m, candidates: full.slice(0, 5).map((s) => s.feature) };
  }
  // Most of the mention fits (e.g. a typo plus a missing word): ask. Half or less: we don't have it.
  const near = scored.filter((s) => s.coverage > 0.5);
  if (near.length) return { kind: 'ambiguous', mention: m, candidates: near.slice(0, 5).map((s) => s.feature) };
  return { kind: 'unknown', mention: m, closest: scored.filter((s) => s.coverage > 0).slice(0, 3).map((s) => s.feature) };
}
