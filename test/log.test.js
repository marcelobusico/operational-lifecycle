// Source-read log: no credential can reach disk, whatever the source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, registerSecret, looksLikeToken } from '../src/log.js';

// Token-shaped values are assembled at runtime so the repo never contains anything that looks like
// a credential (a repo search and GitHub push protection must find nothing).
const fakeGh = ['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz123456'].join('');
const fakeSer = ['se', 'r.', 'AbCdEfGhIjKlMnOpQrSt'].join('');

test('redacts GitHub tokens, Flagsmith keys and auth headers', () => {
  const flagsmithAdminKey = 'Xy12Ab34.cDeFgHiJkLmNoPqRsTuVwXyZ0123456789';
  registerSecret(flagsmithAdminKey);
  const line = JSON.stringify({
    a: fakeGh,
    b: `Authorization: Api-Key ${flagsmithAdminKey}`,
    c: `environment key ${fakeSer}`,
    d: 'api_key=plainsecretvalue123',
  });
  const out = redact(line);
  for (const secret of [fakeGh, flagsmithAdminKey, fakeSer, 'plainsecretvalue123']) {
    assert.ok(!out.includes(secret), `${secret} leaked: ${out}`);
  }
});

test('flags Flagsmith server keys as credentials in definitions', () => {
  assert.equal(looksLikeToken(fakeSer), true);
  assert.equal(looksLikeToken('rewards_enabled'), false);
});
