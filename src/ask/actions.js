// "The chat proposes, the person confirms, it's saved": a change typed in the chat is never applied
// directly. The chat answers with a proposed action (what would be written, validated, with a
// preview), kept on this machine until the person confirms or cancels it. Confirming runs the same
// publish path as the app's own forms, under the person's GitHub identity. Today the chat can manage
// teams (src/teams/chat.js); other kinds of edits can be added as further `kind`s.
import crypto from 'node:crypto';
import { ANSWER_SCHEMA } from './answer.js';
import { parseTeamCommand, commandContext } from '../teams/chat.js';
import { teamReadOnly } from '../app.js';

const TTL_MS = 30 * 60 * 1000;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function describe(op, preview, cmd) {
  const name = preview.team?.name || cmd.draft?.name || cmd.id;
  if (op === 'create') return `Create team ${name} (id ${preview.team?.id || cmd.id})`;
  if (op === 'delete') return `Delete team ${name}${preview.handover_to ? `, handing what it owns over to ${preview.handover_to.name}` : ''}`;
  const rename = preview.diff.find((d) => d.rename);
  return rename ? `Rename team ${rename.from} to ${rename.to} (id ${cmd.id} stays)` : `Edit team ${name}`;
}

export function createActions({ app }) {
  const pending = new Map();
  const sweep = () => { for (const [id, a] of pending) if (Date.now() - a.created > TTL_MS) pending.delete(id); };

  // A chat message that asks to change something → a proposed-action answer, or null if it isn't one.
  async function propose(question, { askedAt = new Date().toISOString() } = {}) {
    const base = { schema: ANSWER_SCHEMA, question, asked_at: askedAt, feature: null, intent: 'manage_team', blockers: [], sections: [], freshness: [],
      provider: { name: 'rules', model: null, used: false, note: null } };
    await app.refresh();
    const defs = await app.definitionsNow();
    const cmd = parseTeamCommand(question, commandContext({ defs, dataRepo: app.config.dataRepo }));
    if (!cmd) return null;
    if (cmd.error) return { ...base, outcome: 'clarify', lead: { text: cmd.error, cites: [], by: 'rules' } };
    const preview = app.teamPublisher.preview({ op: cmd.op, id: cmd.id, draft: cmd.draft, handover_to: cmd.handover_to }, defs);
    if (!preview.valid) {
      const why = preview.message || (preview.errors || []).map((e) => `${e.field} ${e.message}`).join('; ');
      return { ...base, outcome: 'invalid', lead: { text: `I can't do that: ${why}`, cites: [], by: 'rules' }, action: { kind: 'team', op: cmd.op, preview, can_confirm: false } };
    }
    const access = await app.featurePublisher.access();
    sweep();
    const id = crypto.randomBytes(6).toString('hex');
    const title = describe(cmd.op, preview, cmd);
    const action = { id, kind: 'team', op: cmd.op, title, team_id: cmd.id, preview, can_confirm: access.can_edit, reason: access.can_edit ? null : teamReadOnly(access.reason),
      handover_to: preview.handover_to || null };
    if (access.can_edit) pending.set(id, { created: Date.now(), cmd: { ...cmd, base_hash: preview.base_hash } });
    const affected = preview.affected;
    const lead = !access.can_edit ? `${title}: ${action.reason}`
      : cmd.op === 'delete' && affected && (affected.owns.length || affected.references.length)
        ? `${title}? It owns ${plural(affected.owns.length, 'thing')}${affected.owns.length ? ` (${affected.owns.map((o) => o.text).join(', ')})` : ''} and is referenced ${plural(affected.references.length, 'time')}. ${preview.handover_to ? `Confirm to hand all of it to ${preview.handover_to.name}.` : 'Hand them to another team or leave them without an owner.'} Nothing is saved until you confirm.`
        : `${title}? Here is what would be committed to LifeCycle-Data. Nothing is saved until you confirm.`;
    return { ...base, outcome: access.can_edit ? 'proposed_action' : 'read_only', lead: { text: lead, cites: [], by: 'rules' }, action };
  }

  // opts (delete only): handover_to, leave_unowned, confirm_unowned.
  async function confirm(id, opts = {}) {
    sweep();
    const a = pending.get(id);
    if (!a) return { outcome: 'not_found', message: 'This proposed change is no longer waiting for confirmation (already done, cancelled or expired). Ask again to get a fresh preview.' };
    const { cmd } = a;
    const r = await app.submitTeamEdit({ op: cmd.op, id: cmd.id, draft: cmd.draft, base_hash: cmd.base_hash,
      handover_to: opts.handover_to || cmd.handover_to || null, leave_unowned: opts.leave_unowned === true, confirm_unowned: opts.confirm_unowned === true });
    // Kept while a second confirmation or a hand-over choice is still needed.
    if (!['needs_decision', 'confirm_unowned'].includes(r.outcome)) pending.delete(id);
    return { action_id: id, ...r };
  }

  function cancel(id) {
    return { action_id: id, outcome: pending.delete(id) ? 'cancelled' : 'not_found', message: 'Cancelled: nothing was changed.' };
  }

  return { propose, confirm, cancel };
}
