import test from 'node:test';
import assert from 'node:assert/strict';
import { backendIds, serviceOrigin, storageUrl, uploadZip } from '../.github/actions/upload-windows-interface-test/index.mjs';
const ids = { workflow_run_backend_id: '11111111-1111-1111-1111-111111111111', workflow_job_run_backend_id: '22222222-2222-2222-2222-222222222222' };
const token = 'fake.' + Buffer.from(JSON.stringify({scp: 'Actions.Results:' + Object.values(ids).join(':')})).toString('base64url') + '.fake';
test('first-party uploader restricts authentication and storage destinations', () => {
  assert.deepEqual(backendIds(token), ids);
  for (const url of ['http://results.actions.githubusercontent.com', 'https://actions.githubusercontent.com.evil.test', 'https://user:pass@results.actions.githubusercontent.com', 'https://results.actions.githubusercontent.com:444']) assert.throws(() => serviceOrigin(url));
  for (const url of ['https://example.test/a?sig=x', 'http://test.blob.core.windows.net/a?sig=x', 'https://test.blob.core.windows.net/a']) assert.throws(() => storageUrl(url));
  assert.throws(() => backendIds('fake.invalid.fake'));
});
test('uploads only the supplied zip, never sends the runtime token to blob storage, and finalizes its digest', async () => {
  const calls = [];
  const bytes = Buffer.alloc(32); bytes.writeUInt32LE(0x04034b50);
  const response = value => ({ok: true, text: async () => JSON.stringify(value)});
  const result = await uploadZip({bytes, token, sourceCommit: 'a'.repeat(40), resultsUrl: 'https://results.actions.githubusercontent.com', fetcher: async (url, request) => {
    calls.push({url, ...request});
    if (url.endsWith('CreateArtifact')) return response({ok:true, signed_upload_url:'https://test.blob.core.windows.net/test?sig=fake'});
    if (url.endsWith('FinalizeArtifact')) return response({ok:true, artifact_id:'123'});
    return response({});
  }});
  assert.equal(calls.length, 3);
  assert.equal(calls[0].headers.Authorization, 'Bearer ' + token);
  assert.equal(calls[1].headers.Authorization, undefined);
  assert.equal(calls[1].body, bytes);
  assert.equal(JSON.parse(calls[2].body).hash, 'sha256:' + result.sha256);
  assert.equal(result.releaseApproved, false);
  assert(!JSON.stringify(result).includes(token));
  assert(calls.every(x => x.redirect === 'error'));
});
