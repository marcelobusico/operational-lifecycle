// Prints a feature's status in the shared format, read live (no server needed).
// Usage: npm run status -- <feature-id>      (no id: the whole roadmap)
import { createApp } from '../app.js';

const id = process.argv[2];
const snap = await createApp().refresh();
if (!id) {
  console.log(JSON.stringify(snap, null, 2));
} else {
  const status = snap.features.find((f) => f.feature.id === id);
  if (!status) {
    console.error(`No valid feature "${id}". Defined: ${snap.features.map((f) => f.feature.id).join(', ') || 'none'}`);
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(status, null, 2));
  }
}
