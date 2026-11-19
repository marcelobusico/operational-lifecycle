// Delay warnings, worked out by LifeCycle itself from the feature definition (target date) and the
// live feature status (which steps are still open). Nothing here changes a status.
//
// Rule: a feature is warned when the days left before its target date are fewer than
// open steps × `delay.daysPerStep` (default 3). Unknown steps (unreadable source) count as open,
// and are marked so. A feature with no target date gets no warnings, and says so.
export const NO_TARGET = 'no target date: delay warnings off';

const dayNumber = (d) => Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86400000);

export function daysLeft(targetDate, now = new Date()) {
  return Math.round(Date.parse(`${targetDate}T00:00:00Z`) / 86400000) - dayNumber(now);
}

export function delayInfo(status, { now = new Date(), daysPerStep = 3 } = {}) {
  const target = status.feature.target_date;
  if (!target) return { enabled: false, at_risk: false, target_date: null, text: NO_TARGET, open_steps: [] };
  const open = status.steps.filter((s) => s.state !== 'done').map((s) => ({
    id: s.id, name: s.name, owner: s.owner, state: s.state, unknown: s.state === 'unavailable' || s.state === 'no_access',
  }));
  const left = daysLeft(target, now);
  const needed = open.length * daysPerStep;
  const atRisk = open.length > 0 && left < needed;
  const stepsText = open.map((s) => `“${s.name}” (${s.owner}${s.unknown ? ', state unknown' : ''})`).join(', ');
  const when = left < 0 ? `${-left} day${left === -1 ? '' : 's'} past its target date ${target}` : `${left} day${left === 1 ? '' : 's'} before its target date ${target}`;
  return {
    enabled: true,
    at_risk: atRisk,
    target_date: target,
    days_left: left,
    days_needed: needed,
    days_per_step: daysPerStep,
    open_steps: open,
    text: !open.length
      ? `All steps are done; target date ${target}.`
      : atRisk
        ? `Delay risk: ${when}, with ${open.length} open step${open.length === 1 ? '' : 's'} (about ${needed} days of work at ${daysPerStep} per step): ${stepsText}.`
        : `On track for ${target}: ${left} days left for ${open.length} open step${open.length === 1 ? '' : 's'}.`,
  };
}
