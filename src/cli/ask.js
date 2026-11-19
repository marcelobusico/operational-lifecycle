// Ask or get your digest from the terminal, with the same engine as the app and the AI tools.
// Usage: npm run ask -- "How is redeem rewards going?"     npm run ask -- --digest
import { createApp } from '../app.js';
import { appUrl } from '../config.js';
import { createAskService } from '../ask/service.js';
import { answerMarkdown, digestMarkdown } from '../ask/render.js';

const args = process.argv.slice(2);
const app = createApp();
const svc = createAskService({ app });
const baseUrl = appUrl(app.config.port);
if (args[0] === '--digest') {
  console.log(digestMarkdown(await svc.digest({ via: 'cli' }), { baseUrl }));
} else if (args.length) {
  console.log(answerMarkdown(await svc.ask(args.join(' '), { via: 'cli' }), { baseUrl }));
} else {
  console.error('Usage: npm run ask -- "How is <feature> going?"   |   npm run ask -- --digest');
  process.exitCode = 2;
}
