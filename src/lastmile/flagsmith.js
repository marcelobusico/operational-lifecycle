// Flagsmith (the flag console) Admin API client for the last-mile check (done vs. turned on). Read-only, with the
// person's own Organisation API key. Shapes follow Flagsmith's OpenAPI spec (api/v1/swagger.json):
//   GET /environments/?project=<id>                        → environments (id, name, api_key, use_v2_feature_versioning)
//   GET /projects/<id>/features/                           → features (id, name)
//   GET /environments/<api_key>/featurestates/?feature=<id> → default state (no segment, no identity) + segment overrides
//   GET /features/feature-segments/?environment=&feature=  → which segment each override targets
//   GET /projects/<id>/segments/<id>/                      → rules; a PERCENTAGE_SPLIT condition is a % rollout
//   GET /environments/<id>/features/<id>/versions/         → v2 versioning history (was it on before?)
//   GET /projects/<id>/audit/?environments=<id>&search=<flag> → who changed it and when (if the plan records it)
// Every failure is a SourceError: unreachable | no_access | not_found, never a flag state.
import { registerSecret } from '../log.js';
import { SourceError } from '../sources/github-client.js';

const SOURCE_NAME = 'Flagsmith (flag console)';

export function createFlagsmithClient({ apiUrl, apiKey, enabled = true, fetchImpl = fetch }) {
  registerSecret(apiKey);

  async function request(route, { what = route } = {}) {
    if (!enabled) throw Object.assign(new SourceError('unreachable', `The ${SOURCE_NAME} connection is disabled in your LifeCycle config.`), { reason: 'disabled' });
    if (!apiKey) throw Object.assign(new SourceError('no_access', `No ${SOURCE_NAME} API key is set up on this machine, so LifeCycle can't read ${what}. Run \`npm run setup\` and add an Organisation API key.`), { reason: 'no_credential' });
    let res;
    try {
      res = await fetchImpl(`${apiUrl}${route}`, {
        headers: { authorization: `Api-Key ${apiKey}`, accept: 'application/json', 'user-agent': 'lifecycle-local' },
        signal: AbortSignal.timeout(10000),
      });
    } catch (err) {
      throw new SourceError('unreachable', `${SOURCE_NAME} could not be reached (${err.cause?.code || err.cause?.message || err.name}).`);
    }
    if (res.ok) {
      try {
        return await res.json();
      } catch (err) {
        throw new SourceError('unreachable', `${SOURCE_NAME}'s answer could not be read (${err.name === 'TimeoutError' ? 'timed out' : err.name}).`);
      }
    }
    if (res.status === 401) throw Object.assign(new SourceError('no_access', `${SOURCE_NAME} rejected your API key (wrong, expired or revoked), so LifeCycle can't read ${what}. Run \`npm run setup\` again.`, 401), { reason: 'rejected' });
    if (res.status === 403 || res.status === 404) throw new SourceError('no_access', `Your ${SOURCE_NAME} API key can't read ${what}.`, res.status);
    if (res.status === 429) throw new SourceError('unreachable', `${SOURCE_NAME} rate limit reached; try again in a minute.`, 429);
    throw new SourceError('unreachable', `${SOURCE_NAME} answered HTTP ${res.status}.`, res.status);
  }

  // Follows Flagsmith's { count, next, results } pagination; plain arrays pass through.
  async function all(route, opts) {
    let body = await request(route, opts);
    if (Array.isArray(body)) return body;
    const out = [...(body.results || [])];
    let pages = 0;
    while (body.next && pages++ < 20) {
      const next = new URL(body.next);
      body = await request(`${route.split('?')[0]}${next.search}`, opts);
      out.push(...(body.results || []));
    }
    return out;
  }

  return { request, all, hasKey: Boolean(apiKey) };
}

// Finds the rollout percentage in a segment's rules (nested rules allowed), or null.
export function percentageOf(segment) {
  const walk = (rules = []) => {
    for (const r of rules) {
      for (const c of r.conditions || []) {
        if (c.operator === 'PERCENTAGE_SPLIT' && c.value !== null && c.value !== '' && !isNaN(Number(c.value))) return Number(c.value);
      }
      const nested = walk(r.rules);
      if (nested !== null) return nested;
    }
    return null;
  };
  return walk(segment?.rules);
}

const authorName = (a) => (a ? ([a.first_name, a.last_name].filter(Boolean).join(' ') || a.email || null) : null);

export function createFlagsmithSource({ client, projectId, appUrl, environmentNames }) {
  const projectWhat = `project ${projectId} (needs an Organisation API key with view access to that project)`;

  // One project read per refresh: which Flagsmith environments are QA/production, and flag name → id.
  async function readProject() {
    if (client.hasKey === false) throw Object.assign(new SourceError('no_access', `No ${SOURCE_NAME} API key is set up on this machine, so LifeCycle can't read the flags. Run \`npm run setup\` and add an Organisation API key.`), { reason: 'no_credential' });
    if (!projectId) throw Object.assign(new SourceError('no_access', `No ${SOURCE_NAME} project is chosen on this machine. Run \`npm run setup\` to pick one.`), { reason: 'missing_project' });
    const [environments, features] = await Promise.all([
      client.all(`/environments/?project=${projectId}`, { what: `the environments of ${projectWhat}` }),
      client.all(`/projects/${projectId}/features/?page_size=100`, { what: `the flags of ${projectWhat}` }),
    ]);
    const envs = {};
    for (const [key, name] of Object.entries(environmentNames)) {
      const env = environments.find((e) => e.name === name);
      envs[key] = env ? { id: env.id, name: env.name, apiKey: env.api_key, v2: Boolean(env.use_v2_feature_versioning) } : { missing: true, name };
    }
    const flags = new Map(features.filter((f) => !f.is_archived).map((f) => [f.name, { id: f.id, name: f.name }]));
    return { envs, flags, names: environments.map((e) => e.name) };
  }

  // State of one flag in one environment: on | off | partial (rollout_percentage), plus when the
  // current setting took effect, who changed it (if Flagsmith records it) and whether it was on before.
  async function readFlag({ env, flag }) {
    const what = `flag "${flag.name}" in ${env.name} (needs view access to the ${env.name} environment)`;
    const states = await client.all(`/environments/${env.apiKey}/featurestates/?feature=${flag.id}`, { what });
    const live = states.filter((s) => !s.deleted_at && (!s.live_from || Date.parse(s.live_from) <= Date.now()));
    const defaults = live.filter((s) => s.feature_segment === null && !s.identity && !s.identifier);
    // With v2 versioning several versions can be listed; the live one is the latest that took effect.
    const byTime = (s) => Date.parse(s.live_from || s.updated_at || s.created_at || 0);
    const current = defaults.sort((a, b) => byTime(b) - byTime(a))[0];
    if (!current) throw new SourceError('unreachable', `${SOURCE_NAME} returned no environment setting for "${flag.name}" in ${env.name}.`);

    let state = current.enabled ? 'on' : 'off';
    let rollout = current.enabled ? 100 : 0;
    const segments = [];
    const overrides = live.filter((s) => s.feature_segment !== null && s.enabled);
    if (!current.enabled && overrides.length) {
      const featureSegments = await client.all(`/features/feature-segments/?environment=${env.id}&feature=${flag.id}`, { what });
      const percents = [];
      for (const o of overrides) {
        const fseg = featureSegments.find((x) => x.id === o.feature_segment);
        if (!fseg) continue;
        const segment = await client.request(`/projects/${projectId}/segments/${fseg.segment}/`, { what: `segment "${fseg.segment_name || fseg.segment}" in ${projectWhat}` });
        const pct = percentageOf(segment);
        segments.push({ name: segment.name || fseg.segment_name, percentage: pct });
        if (pct !== null) percents.push(pct);
      }
      if (segments.length) {
        state = 'partial';
        rollout = percents.length ? Math.min(100, Math.max(...percents)) : null;
        if (rollout === 100) state = 'on';
      }
    }

    const changedAt = current.live_from || current.updated_at || null;
    const [history, audit] = await Promise.all([previousVersionEnabled(env, flag), lastAuditEntry(env, flag)]);
    return {
      state,
      rollout_percentage: rollout,
      segments,
      changed_at: audit?.created_date && (!changedAt || Date.parse(audit.created_date) >= Date.parse(changedAt) - 60000) ? audit.created_date : changedAt,
      changed_by: audit ? authorName(audit.author) : null,
      // true/false when Flagsmith keeps versions (v2), null when it doesn't record the previous value.
      was_on_before: history,
      link: `${appUrl}/project/${projectId}/environment/${env.apiKey}/features?feature=${flag.id}`,
    };
  }

  // v2 versioning keeps every published version: read the one before the live one.
  async function previousVersionEnabled(env, flag) {
    if (!env.v2) return null;
    try {
      const versions = (await client.all(`/environments/${env.id}/features/${flag.id}/versions/?page_size=10`, { what: 'flag versions' }))
        .filter((v) => v.published)
        .sort((a, b) => Date.parse(b.live_from || b.created_at) - Date.parse(a.live_from || a.created_at));
      if (versions.length < 2) return false;
      const prev = await client.all(`/environments/${env.id}/features/${flag.id}/versions/${versions[1].uuid}/featurestates/`, { what: 'flag versions' });
      return prev.some((s) => s.feature_segment === null && !s.identity && s.enabled);
    } catch {
      return null;
    }
  }

  // The audit log names who changed a flag. Not every Flagsmith plan exposes it: then who is unknown.
  async function lastAuditEntry(env, flag) {
    try {
      const body = await client.request(`/projects/${projectId}/audit/?environments=${env.id}&search=${encodeURIComponent(flag.name)}&page_size=10`, { what: 'the audit log' });
      const entries = (body.results || body || []).filter((e) => ['FEATURE_STATE', 'EF_VERSION'].includes(e.related_object_type) && String(e.log || '').includes(flag.name));
      return entries.sort((a, b) => Date.parse(b.created_date) - Date.parse(a.created_date))[0] || null;
    } catch {
      return null;
    }
  }

  return { readProject, readFlag, sourceName: SOURCE_NAME };
}
