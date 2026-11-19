// Local log of every alert, publish and failure: one JSON line with event, feature and source.
// Lines pass through redact(), so no token ever reaches the disk.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../config.js';
import { redact } from '../log.js';

// entry: { event, feature, source, id?, detail? }
export function logAlertEvent(entry) {
  const line = redact(JSON.stringify({ at: new Date().toISOString(), ...entry }));
  try {
    const file = paths.alertsLog();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, line + '\n', { mode: 0o600 });
  } catch (err) {
    console.error(`lifecycle: could not write the alerts log: ${err.message}`);
  }
}
