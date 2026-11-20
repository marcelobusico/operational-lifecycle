// Publishing team edits made in LifeCycle (the Teams page or the chat): commits to the shared repo's
// main branch with the person's own GitHub credentials, through the same file operations, identity
// and access check as feature edits (src/features/publish.js). Nothing is overwritten silently: an
// edit carries a hash of the team file as it was opened, and every write carries the file's sha.
//
// Deleting a team that owns things or is referenced lists all of it first (outcome needs_decision).
// The person then either hands it over to another team (its ownership moves to that team and every
// reference is rewritten to that team's id), or leaves it without an owner, which needs a second
// confirmation (confirm_unowned). One commit per file touched, the team file itself last.
import { parseDocument } from 'yaml';
import { SourceError } from '../sources/github-client.js';
import { logAlertEvent } from '../alerts/log.js';
import { textHash } from '../features/publish.js';
import { buildTeamFile, toTeamDraft } from './edit.js';
import { buildTeamRegistry, ticketText, KIND_LABEL } from './registry.js';

// A reference field ("owner", "steps[2].team") as a YAML path.
const fieldPath = (field) => field.split('.').flatMap((p) => { const m = p.match(/^(\w+)\[(\d+)\]$/); return m ? [m[1], Number(m[2])] : [p]; });
// Fields that may be removed when a team is left without an owner; the rest are required by the format.
const OPTIONAL_REF = (where) => where.type === 'service' || where.type === 'app' || where.type === 'project' || /^steps\[\d+\]\.team$/.test(where.field);

export function ownedItems(team) {
  const o = team.owns;
  return [...o.repos.map((k) => ({ kind: 'repo', key: k })), ...o.tickets.map((t) => ({ kind: 'tickets', key: t.label ? `label:${t.label}` : `repo:${t.repo}`, ticket: t })),
    ...o.services.map((k) => ({ kind: 'service', key: k })), ...o.apps.map((k) => ({ kind: 'app', key: k })), ...o.flags.map((k) => ({ kind: 'flag', key: k }))]
    .map((x) => ({ ...x, text: x.kind === 'tickets' ? ticketText(x.ticket) : `${KIND_LABEL[x.kind]} ${x.key}` }));
}

export function createTeamPublisher({ featurePublisher, whoAmI }) {
  const { io } = featurePublisher;
  const registryOf = (defs) => buildTeamRegistry({ teams: defs.teamDefs, features: defs.featureDefs, services: defs.serviceDefs || [], projects: defs.projectDefs || [], apps: defs.appDefs || [] });

  // What deleting a team affects: what it owns and everything that points to it.
  function affected(team, defs) {
    const reg = registryOf(defs);
    const references = reg.referencesTo(team.id);
    return { owns: ownedItems(team), references };
  }

  // What would be written, without writing: { errors, diff, path, text, team, affected? }.
  function build({ op, id, draft }, defs) {
    const base = op === 'create' ? null : defs.teamDefs.find((t) => t.id === id);
    if (op !== 'create' && !base) return { outcome: 'not_found', errors: [], message: `No valid team "${id}" is defined in LifeCycle-Data (teams/).` };
    if (op === 'delete') return { errors: [], base, affected: affected(base, defs), path: base.file };
    let d = draft;
    // A rename keeps the id. If anything still names the team by its old name, keep that as an alias.
    if (op === 'update' && draft?.name && draft.name.trim() !== base.name) {
      const usedByName = registryOf(defs).referencesTo(base.id).some((r) => r.value === base.name);
      const aliases = Array.isArray(draft.aliases) ? draft.aliases : base.aliases;
      if (usedByName && !aliases.includes(base.name)) d = { ...draft, aliases: [...aliases, base.name] };
    }
    const built = buildTeamFile({ draft: d, mode: op, base: base ? { text: defs.files.get(base.file), team: base } : null, teams: defs.teamDefs, files: defs.files });
    return { ...built, base };
  }

  function commitMessage(op, team, diff, by, extra = '') {
    if (op === 'create') return `Add team ${team.id} (by ${by} from LifeCycle)`;
    if (op === 'delete') return `Delete team ${team.id}${extra} (by ${by} from LifeCycle)`;
    const rename = diff.find((x) => x.rename);
    const rest = [...new Set(diff.filter((x) => !x.rename).map((x) => x.label.replace(/^Owns: /, '').toLowerCase()))];
    return `${rename ? `Rename team ${team.id}: ${rename.from} → ${rename.to}` : `Edit team ${team.id}`}${rename && rest.length ? `; ${rest.join(', ')}` : !rename && rest.length ? `: ${rest.join(', ')}` : ''} (by ${by} from LifeCycle)`;
  }

  const failure = (err, what) => {
    if (!(err instanceof SourceError)) throw err;
    if (err.kind === 'conflict') return { outcome: 'conflict', message: `Not published: ${err.message} Nothing was overwritten. Reopen the team to see the latest version, then apply your change again.` };
    return { outcome: 'not_published', message: `Not published: ${/GitHub user/.test(err.message) ? '' : `${what} `}${err.message} Nothing was changed in the shared repo; try again once it can be reached.` };
  };

  // op: create | update | delete. base_hash: hash of the team file as opened (update/delete).
  // Delete only: handover_to (team id) or leave_unowned + confirm_unowned.
  async function submit({ op, id, draft, base_hash, handover_to = null, leave_unowned = false, confirm_unowned = false }, defs) {
    const built = build({ op, id, draft }, defs);
    if (built.outcome === 'not_found') return built;
    if (built.errors.length) return { outcome: 'invalid', errors: built.errors, diff: built.diff || null, message: 'Can\'t publish: fix the fields marked below.' };
    if (op === 'update' && !built.diff.length) return { outcome: 'invalid', errors: [], diff: [], message: 'Nothing to publish: no field changed.' };
    const base = built.base;
    if (base && base_hash && textHash(defs.files.get(base.file)) !== base_hash) {
      return { outcome: 'conflict', message: `Not published: team ${base.id} changed in the shared repo after you opened it. Nothing was overwritten. Reopen it to see the latest version.` };
    }
    const who = async () => {
      const by = await whoAmI();
      if (!by) throw new SourceError('unreachable', 'LifeCycle can\'t tell your GitHub user (GitHub unreachable and none saved).');
      return by;
    };
    let by = null;

    if (op !== 'delete') {
      try {
        by = await who();
        const current = await io.readCurrent(built.path);
        if (op === 'create' && current) throw new SourceError('conflict', `${built.path} was created by someone else in the meantime.`, 422);
        if (op === 'update') {
          if (!current) throw new SourceError('conflict', `team ${id} was deleted from the shared repo after you opened it.`, 404);
          if (textHash(current.text) !== textHash(defs.files.get(base.file))) throw await io.staleError(built.path, `changed team ${id}`);
        }
        await io.writeFile(built.path, built.text, { sha: current?.sha, create: op === 'create', message: commitMessage(op, built.team, built.diff, by) });
      } catch (err) {
        return { ...failure(err, 'the shared repo refused the write.'), diff: built.diff };
      }
      logAlertEvent({ event: 'team_edit_published', feature: '-', source: 'team-edit', id: built.team.id, detail: `${op} by ${by}` });
      return { outcome: 'published', op, id: built.team.id, team: { id: built.team.id, name: built.team.name }, by, diff: built.diff, path: built.path,
        message: `Committed ${built.path} to ${io.where()} as ${by}. Teammates see it on their next Refresh View.` };
    }

    // Delete: decide first what happens to what the team owns and to what points to it.
    const { owns, references } = built.affected;
    const target = handover_to ? defs.teamDefs.find((t) => t.id === handover_to) : null;
    if (handover_to && (!target || target.id === base.id)) return { outcome: 'invalid', errors: [{ field: 'handover_to', message: `"${handover_to}" is not another defined team` }], affected: built.affected, message: 'Can\'t delete: pick another defined team to hand over to.' };
    const needsDecision = owns.length || references.length;
    if (needsDecision && !target && !leave_unowned) {
      return { outcome: 'needs_decision', affected: built.affected,
        message: `${base.name} owns ${owns.length} thing${owns.length === 1 ? '' : 's'} and is referenced ${references.length} time${references.length === 1 ? '' : 's'}. Hand them over to another team, or leave them without an owner.` };
    }
    if (needsDecision && !target && !confirm_unowned) {
      return { outcome: 'confirm_unowned', affected: built.affected,
        message: `Confirm again: after deleting ${base.name}, ${owns.map((o) => o.text).join(', ') || 'nothing it owns'} will have no owner, and references to it are removed where the format allows (the rest show "unknown team" until changed).` };
    }

    const committed = [];
    const left = []; // required fields left naming the deleted team
    try {
      by = await who();
      if (target) {
        const merged = toTeamDraft(target);
        for (const k of Object.keys(merged.owns)) {
          const key = (x) => JSON.stringify(x);
          for (const x of base.owns[k]) if (!merged.owns[k].some((y) => key(y) === key(x))) merged.owns[k].push(x);
        }
        const tb = buildTeamFile({ draft: merged, mode: 'update', base: { text: defs.files.get(target.file), team: target }, teams: defs.teamDefs.filter((t) => t.id !== base.id), files: new Map([...defs.files].filter(([p]) => p !== base.file)) });
        if (tb.errors.length) return { outcome: 'invalid', errors: tb.errors, message: `Can't hand over to ${target.name}: ${tb.errors.map((e) => `${e.field} ${e.message}`).join('; ')}` };
        if (tb.diff.length) {
          const cur = await io.readCurrent(target.file);
          if (!cur || textHash(cur.text) !== textHash(defs.files.get(target.file))) throw await io.staleError(target.file, `changed team ${target.id}`);
          await io.writeFile(target.file, tb.text, { sha: cur.sha, message: `Hand over team ${base.id}'s ownership to ${target.id} (by ${by} from LifeCycle)` });
          committed.push(target.file);
        }
      }
      // References: rewritten to the new team, or removed where the format allows.
      const byFile = new Map();
      for (const r of references) { if (!byFile.has(r.file)) byFile.set(r.file, []); byFile.get(r.file).push(r); }
      for (const [file, refs] of byFile) {
        const cur = await io.readCurrent(file);
        if (!cur) continue;
        const doc = parseDocument(cur.text);
        let changed = false;
        for (const r of refs) {
          const p = fieldPath(r.field);
          if (String(doc.getIn(p) ?? '').trim() !== r.value) continue; // changed meanwhile: leave it
          if (target) { doc.setIn(p, target.id); changed = true; } else if (OPTIONAL_REF(r)) { doc.deleteIn(p); changed = true; } else left.push(r);
        }
        if (!changed) continue;
        await io.writeFile(file, doc.toString({ lineWidth: 0, flowCollectionPadding: false }), { sha: cur.sha,
          message: `${target ? `Point to team ${target.id} instead of ${base.id}` : `Remove team ${base.id}`} in ${file} (by ${by} from LifeCycle)` });
        committed.push(file);
      }
      const cur = await io.readCurrent(base.file);
      if (!cur) throw new SourceError('conflict', `team ${base.id} was already deleted from the shared repo.`, 404);
      await io.deleteFile(base.file, { sha: cur.sha, message: commitMessage('delete', base, null, by, target ? `, handed over to ${target.id}` : needsDecision ? ', leaving what it owned without an owner' : '') });
      committed.push(base.file);
    } catch (err) {
      const f = failure(err, 'part of the delete could not be written.');
      return { ...f, committed, message: `${f.message}${committed.length ? ` Already committed: ${committed.join(', ')}.` : ''}` };
    }
    logAlertEvent({ event: 'team_edit_published', feature: '-', source: 'team-edit', id: base.id, detail: `delete${target ? ` handover to ${target.id}` : ''} by ${by}` });
    return { outcome: 'published', op, id: base.id, by, committed, handed_over_to: target ? { id: target.id, name: target.name } : null,
      left_unknown: left.map((r) => ({ type: r.type, id: r.id, name: r.name, field: r.field })),
      message: `Deleted team ${base.name} as ${by}${target ? `; what it owned and every reference now point to ${target.name}` : needsDecision ? '; what it owned now has no owner' : ''}.${left.length ? ` ${left.length} required field${left.length === 1 ? '' : 's'} still name it and show "unknown team" until changed.` : ''}` };
  }

  // Preview for the form and the chat: same checks as submit, nothing written.
  function preview({ op, id, draft, handover_to = null }, defs) {
    const built = build({ op, id, draft }, defs);
    if (built.outcome === 'not_found') return { valid: false, ...built };
    if (op === 'delete') {
      const target = handover_to ? defs.teamDefs.find((t) => t.id === handover_to) : null;
      return { valid: true, errors: [], op, id, path: built.path, team: { id: built.base.id, name: built.base.name }, affected: built.affected, handover_to: target ? { id: target.id, name: target.name } : null,
        base_hash: textHash(defs.files.get(built.base.file)) };
    }
    return { valid: !built.errors.length && !(op === 'update' && !built.diff?.length), errors: built.errors, diff: built.diff || [], path: built.path || null, text: built.text || null,
      team: built.team ? { id: built.team.id, name: built.team.name } : null, base_hash: built.base ? textHash(defs.files.get(built.base.file)) : null,
      ...(op === 'update' && built.diff && !built.diff.length ? { message: 'Nothing would change.' } : {}) };
  }

  return { submit, preview, affected };
}
