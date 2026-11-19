// Team-wide settings, defined once in the shared feature repo (LifeCycle-Data/team.yaml) so every
// person's LifeCycle inherits them. Today: the default flag platform.
//
//   flag_platform: statsig     # or flagsmith
//
// Which flag platform a person's LifeCycle reads (resolveFlagPlatform), strongest first:
//   1. LIFECYCLE_FLAG_PLATFORM in the environment
//   2. a deliberate choice in `npm run setup` (flagPlatformSource: 'chosen' in ~/.lifecycle/config.json)
//      Configs from before this field: 'statsig' was only ever saved by choosing it, and 'flagsmith'
//      (or no flagPlatform at all) counts as chosen only when a Flagsmith project is set.
//   3. the team default from team.yaml (flagPlatformSource: 'team', or nothing chosen at all)
// A config that silently defaulted to Flagsmith is moved to the team default once, with a notice
// (migrateSavedFlagPlatform in src/config.js).
import { parse } from 'yaml';

export const TEAM_FILE = 'team.yaml';
export const FLAG_PLATFORMS = ['statsig', 'flagsmith'];
export const FLAG_PLATFORM_NAME = { statsig: 'Statsig', flagsmith: 'Flagsmith' };
// Only used when the shared repo has no team.yaml (or it was never readable on this machine).
export const FALLBACK_FLAG_PLATFORM = 'statsig';

// { team: { flag_platform }, errors: [{ file, field, message }] }
export function parseTeam(text, file = TEAM_FILE) {
  let doc;
  try {
    doc = parse(text) ?? {};
  } catch (err) {
    return { team: {}, errors: [{ file, field: '(file)', message: `is not valid YAML: ${err.message.split('\n')[0]}` }] };
  }
  if (typeof doc !== 'object' || Array.isArray(doc)) return { team: {}, errors: [{ file, field: '(file)', message: 'must be a mapping of settings' }] };
  const team = {};
  const errors = [];
  if (doc.flag_platform !== undefined) {
    const v = String(doc.flag_platform).trim().toLowerCase();
    if (FLAG_PLATFORMS.includes(v)) team.flag_platform = v;
    else errors.push({ file, field: 'flag_platform', message: `must be one of ${FLAG_PLATFORMS.join(', ')} (got "${doc.flag_platform}")` });
  }
  return { team, errors };
}

export const teamFlagPlatform = (team) => team?.flag_platform || FALLBACK_FLAG_PLATFORM;

// Whether a saved config made a deliberate flag platform choice, and which.
// null = nothing chosen (follow the team default).
export function chosenFlagPlatform(config) {
  const p = config?.flagPlatform;
  if (config?.flagPlatformSource === 'env' || config?.flagPlatformSource === 'chosen') return FLAG_PLATFORMS.includes(p) ? p : null;
  if (config?.flagPlatformSource === 'team') return null;
  // Configs from before flagPlatformSource existed.
  if (p === 'statsig') return 'statsig';
  // Flagsmith with a project set (setup only asks for the project after a working key), including
  // configs from before the flag platform setting existed (no flagPlatform at all).
  if ((p === 'flagsmith' || !p) && config?.sources?.flagsmith?.projectId) return 'flagsmith';
  return null;
}

// { platform, from: 'env' | 'chosen' | 'team', team_default }
export function resolveFlagPlatform(config, team) {
  const teamDefault = teamFlagPlatform(team);
  const chosen = chosenFlagPlatform(config);
  if (chosen) return { platform: chosen, from: config.flagPlatformSource === 'env' ? 'env' : 'chosen', team_default: teamDefault };
  return { platform: teamDefault, from: 'team', team_default: teamDefault };
}
