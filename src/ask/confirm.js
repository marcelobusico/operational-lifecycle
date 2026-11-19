// "The chat proposes, the person confirms, it's saved": the conversation state shared by every chat
// flow that changes something (feature definitions in change.js; other flows, such as teams, reuse
// it). A conversation is identified by a session id the entry point passes (the app page, or the AI
// tool's MCP connection) and is kept on this machine, so nothing is ever saved from a guess about
// what the person meant: an open action waits for an explicit yes, and a no drops it.
//
// Session: { id, action: null | { kind, op, step, ... }, focus: <feature id> | null, updated_at }.
//   step 'ask'            the chat asked one question and the next message is the answer
//   step 'confirm'        a full preview was shown; yes saves, no drops it
//   step 'confirm_again'  a second confirmation is needed (e.g. deleting what others depend on)
//   step 'fix'            the preview has problems; it can be changed, but not saved
//   step 'name'           the name is taken or very close to an existing one: which did they mean?
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { homeDir, writeJson } from '../config.js';

const SESSION_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const dir = () => path.join(homeDir(), 'chat');
const file = (id) => path.join(dir(), `${id}.json`);

export const newSessionId = () => `c-${crypto.randomBytes(6).toString('hex')}`;
export const validSession = (id) => typeof id === 'string' && SESSION_ID.test(id);

export function readSession(id) {
  if (!validSession(id)) return { id: null, action: null, focus: null };
  try {
    return JSON.parse(fs.readFileSync(file(id), 'utf8'));
  } catch {
    return { id, action: null, focus: null };
  }
}

export function saveSession(session) {
  if (!validSession(session.id)) return session;
  writeJson(file(session.id), { ...session, updated_at: new Date().toISOString() }, 0o600);
  return session;
}

// Whole-message answers to "Save it?". "yes, delete it" and "no, create it" count; "yesterday" doesn't.
const YES = /^\s*(yes|y|yep|yeah|yup|sure|ok|okay|confirm(?:ed)?|save(?: it)?|go ahead|do it|publish(?: it)?|delete it|commit(?: it)?)\b[\s\S]{0,60}$/i;
const NO = /^\s*(no|n|nope|cancel|stop|never ?mind|discard(?: it)?|don'?t|abort|decline)\b[\s\S]{0,60}$/i;
export const isYes = (text) => YES.test(text) && !NO.test(text);
export const isNo = (text) => NO.test(text);
