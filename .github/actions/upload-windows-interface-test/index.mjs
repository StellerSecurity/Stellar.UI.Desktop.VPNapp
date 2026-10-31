// No third-party packages, shell commands, broad file globs or account secrets.
// Uses only the job's existing, short-lived artifact-service authentication.
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export function serviceOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname.endsWith('.actions.githubusercontent.com')) throw new Error('Unexpected artifact service.');
  return url.origin;
}
export function storageUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname.endsWith('.blob.core.windows.net') || !url.searchParams.has('sig')) throw new Error('Unexpected artifact storage.');
  return url.href;
}
export function backendIds(token) {
  if (typeof token !== 'string' || token.split('.').length !== 3) throw new Error('Artifact authentication unavailable.');
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  const scope = String(claims.scp).split(' ').find(x => x.startsWith('Actions.Results:'));
  const ids = scope?.split(':').slice(1);
  if (ids?.length !== 2 || !ids.every(x => /^[a-f0-9-]{36}$/i.test(x))) throw new Error('Artifact scope unavailable.');
  return { workflow_run_backend_id: ids[0], workflow_job_run_backend_id: ids[1] };
}
export async function uploadZip({ bytes, token, resultsUrl, sourceCommit, fetcher = fetch }) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.length > 268435456 || bytes.readUInt32LE(0) !== 0x04034b50 || !/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('Unexpected test artifact.');
  const origin = serviceOrigin(resultsUrl);
  const ids = backendIds(token);
  const name = 'Stellar-VPN-Windows-x64-interface-test-' + sourceCommit.slice(0, 12);
  const digest = createHash('sha256').update(bytes).digest('hex');
  async function rpc(method, body) {
    const response = await fetcher(origin + '/twirp/github.actions.results.api.v1.ArtifactService/' + method, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error('Artifact service request failed.');
    const text = await response.text();
    if (text.length > 32768) throw new Error('Unexpected artifact response.');
    return JSON.parse(text);
  }
  const created = await rpc('CreateArtifact', { ...ids, name, version: 4, expires_at: new Date(Date.now() + 7 * 86400000).toISOString() });
  if (created.ok !== true) throw new Error('Artifact creation failed.');
  const response = await fetcher(storageUrl(created.signed_upload_url), {
    method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(120000),
    headers: { 'x-ms-blob-type': 'BlockBlob', 'x-ms-version': '2023-11-03', 'Content-Type': 'application/zip' }, body: bytes
  });
  if (!response.ok) throw new Error('Artifact storage upload failed.');
  const finalized = await rpc('FinalizeArtifact', { ...ids, name, size: String(bytes.length), hash: 'sha256:' + digest });
  if (finalized.ok !== true || !/^\d+$/.test(String(finalized.artifact_id))) throw new Error('Artifact finalization failed.');
  return { name, artifactId: String(finalized.artifact_id), bytes: bytes.length, sha256: digest, releaseApproved: false };
}
async function main() {
  if (process.env.GITHUB_REPOSITORY !== 'StellerSecurity/Stellar.UI.Desktop.VPNapp') throw new Error('Unexpected repository.');
  const expected = path.resolve(process.env.RUNNER_TEMP, 'stellar-windows-interface-test.zip');
  if (path.resolve(process.env.STELLAR_WINDOWS_PREVIEW_ZIP ?? '') !== expected) throw new Error('Unexpected artifact path.');
  const stat = await lstat(expected);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 268435456) throw new Error('Unexpected artifact file.');
  const result = await uploadZip({ bytes: await readFile(expected), token: process.env.ACTIONS_RUNTIME_TOKEN,
    resultsUrl: process.env.ACTIONS_RESULTS_URL, sourceCommit: process.env.GITHUB_SHA });
  console.log(JSON.stringify(result));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Never print request errors, bearer tokens, JWT claims or signed storage URLs.
  main().catch(() => { console.error('Windows interface artifact upload failed; no credentials logged.'); process.exitCode = 1; });
}
