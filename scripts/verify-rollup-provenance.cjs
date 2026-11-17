'use strict';

// Public provenance only. No target code, signing API, credentials or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const localRequire = createRequire(path.join(__dirname, 'npm/package.json'));
const { Updater } = localRequire('tuf-js');
const { DownloadHTTPError } = localRequire('tuf-js/dist/error.js');
const { bundleFromJSON } = localRequire('@sigstore/bundle');
const { TrustedRoot } = localRequire('@sigstore/protobuf-specs');
const { Verifier, toTrustMaterial, toSignedEntity } = localRequire('@sigstore/verify');

const ORIGIN = 'https://tuf-repo-cdn.sigstore.dev';
const SAN = 'https://github.com/rollup/rollup/.github/workflows/build-and-tests.yml@refs/tags/v4.65.1';
const ISSUER = 'https://token.actions.githubusercontent.com';
const SHA512 = '05ef71d299c54bdd70b40b25cf47f1dc79cb6ea42e578105d972de9b08f3f011aa2e332bc3db42ceeeef22e5a0a63084b0c42032d6751485872715fde59c0193';
const COMMIT = '7879c65994dd591d287b177b8d0b88d7d76c2a49';

function statementPolicy(statement, expectedDigest = SHA512) {
  assert.equal(statement._type, 'https://in-toto.io/Statement/v1');
  assert.equal(statement.predicateType, 'https://slsa.dev/provenance/v1');
  assert.equal(statement.subject.length, 1);
  assert.equal(statement.subject[0].name, 'pkg:npm/%40rollup/wasm-node@4.65.1');
  assert.equal(statement.subject[0].digest.sha512, expectedDigest);
  const build = statement.predicate.buildDefinition;
  const workflow = build.externalParameters.workflow;
  assert.equal(workflow.repository, 'https://github.com/rollup/rollup');
  assert.equal(workflow.ref, 'refs/tags/v4.65.1');
  assert.equal(workflow.path, '.github/workflows/build-and-tests.yml');
  assert.equal(build.internalParameters.github.repository_id, '35640229');
  assert.equal(build.internalParameters.github.repository_owner_id, '12554859');
  assert.equal(statement.predicate.runDetails.builder.id, 'https://github.com/actions/runner/github-hosted');
  assert.ok(build.resolvedDependencies.some(entry => entry.digest?.gitCommit === COMMIT));
}

async function main() {
  const map = JSON.parse(fs.readFileSync(path.join(__dirname, 'public-tuf.json')));
  const seeds = localRequire('@sigstore/tuf/seeds.json');
  const root = path.join(__dirname, 'verification-cache');
  fs.mkdirSync(root);
  const metadataDir = path.join(root, 'metadata');
  const targetDir = path.join(root, 'targets');
  fs.mkdirSync(metadataDir);
  fs.mkdirSync(targetDir);
  fs.writeFileSync(path.join(metadataDir, 'root.json'), Buffer.from(seeds[ORIGIN]['root.json'], 'base64'));
  const seen = new Set();
  const fetcher = {
    async downloadBytes(url, maxLength) {
      assert.ok(url.startsWith(ORIGIN + '/'));
      assert.ok(Object.hasOwn(map.responses, url), 'unprefetched metadata rejected');
      const record = map.responses[url];
      seen.add(url);
      if (record.status === 404) throw new DownloadHTTPError('prefetched public 404', 404);
      assert.equal(record.status, 200);
      const data = Buffer.from(record.bytes_base64, 'base64');
      assert.ok(data.length <= maxLength && data.length <= 1024 * 1024);
      assert.equal(crypto.createHash('sha256').update(data).digest('hex'), record.sha256);
      return data;
    },
    async downloadFile(url, maxLength, handler) {
      const data = await this.downloadBytes(url, maxLength);
      const filename = path.join(root, 'transport-target');
      fs.writeFileSync(filename, data, { flag: 'wx' });
      try { return await handler(filename); } finally { fs.unlinkSync(filename); }
    },
  };
  // SDK default signature thresholds and expiry/rollback checks remain intact.
  const updater = new Updater({ metadataDir, targetDir, metadataBaseUrl: ORIGIN,
    targetBaseUrl: ORIGIN + '/targets', fetcher });
  const info = await updater.getTargetInfo('trusted_root.json');
  assert.ok(info);
  const target = await updater.downloadTarget(info);
  const originalTimestamp = map.responses[ORIGIN + '/timestamp.json'];
  const tamperedTimestamp = JSON.parse(Buffer.from(originalTimestamp.bytes_base64, 'base64'));
  assert.ok(tamperedTimestamp.signatures.length > 0);
  for (const signature of tamperedTimestamp.signatures) signature.sig = '00'.repeat(64);
  const tamperedBytes = Buffer.from(JSON.stringify(tamperedTimestamp));
  map.responses[ORIGIN + '/timestamp.json'] = { status: 200,
    bytes_base64: tamperedBytes.toString('base64'),
    sha256: crypto.createHash('sha256').update(tamperedBytes).digest('hex') };
  const rejectedDir = path.join(root, 'tampered-metadata');
  fs.mkdirSync(rejectedDir);
  fs.writeFileSync(path.join(rejectedDir, 'root.json'), Buffer.from(seeds[ORIGIN]['root.json'], 'base64'));
  try {
    const negativeUpdater = new Updater({ metadataDir: rejectedDir, targetDir,
      metadataBaseUrl: ORIGIN, targetBaseUrl: ORIGIN + '/targets', fetcher });
    await assert.rejects(negativeUpdater.getTargetInfo('trusted_root.json'), /signature|signed|threshold/i);
  } finally {
    map.responses[ORIGIN + '/timestamp.json'] = originalTimestamp;
  }
  const trust = toTrustMaterial(TrustedRoot.fromJSON(JSON.parse(fs.readFileSync(target))));
  const verifier = new Verifier(trust);
  assert.equal(verifier.options.ctlogThreshold, 1);
  assert.equal(verifier.options.tlogThreshold, 1);
  assert.equal(verifier.options.timestampThreshold, 1);
  const attestations = JSON.parse(fs.readFileSync(path.join(__dirname, 'attestations.json')));
  const candidates = attestations.attestations.filter(a => a.predicateType === 'https://slsa.dev/provenance/v1');
  assert.equal(candidates.length, 1);
  const raw = candidates[0].bundle;
  const policy = { subjectAlternativeName: SAN, extensions: { issuer: ISSUER } };
  const entity = toSignedEntity(bundleFromJSON(raw));
  verifier.verify(entity, policy);
  const statement = JSON.parse(Buffer.from(raw.dsseEnvelope.payload, 'base64'));
  statementPolicy(statement);
  assert.throws(() => verifier.verify(entity, { ...policy, subjectAlternativeName: SAN + '-wrong' }));
  assert.throws(() => verifier.verify(entity, { ...policy, extensions: { issuer: ISSUER + '-wrong' } }));
  const altered = JSON.parse(JSON.stringify(raw));
  altered.dsseEnvelope.payload = Buffer.from('{}').toString('base64');
  assert.throws(() => verifier.verify(toSignedEntity(bundleFromJSON(altered)), policy));
  assert.throws(() => statementPolicy(statement, '0'.repeat(128)));
  assert.throws(() => verifier.verify(entity, { ...policy, oids: { '1.3.6.1.4.1.57264.1.1': ISSUER + '-wrong' } }));
  const wasm = fs.readFileSync(path.join(__dirname, 'reviewed.wasm'));
  assert.equal(wasm.length, 588077);
  assert.equal(crypto.createHash('sha256').update(wasm).digest('hex'),
    '7099c59e9da5c0d690356ba986bf02a89dd21b35e578684758ecbdac4aca0c8d');
  // Engine validation checks types and control flow. Never instantiate, compile
  // a Module, create imports, or call any target export in this analysis phase.
  assert.equal(WebAssembly.validate(wasm), true);
  assert.equal(WebAssembly.validate(wasm.subarray(0, wasm.length - 1)), false);
  console.log(JSON.stringify({ verified: true, artifact_sha512: SHA512, release_commit: COMMIT,
    identity: SAN, issuer: ISSUER, public_metadata_responses: seen.size,
    default_ctlog_tlog_timestamp_thresholds: [1, 1, 1], negative_controls: 6,
    tampered_tuf_signature_rejected: true,
    wasm_type_validation: true, truncated_wasm_rejected: true,
    network_allowed: false, target_code_executed: false, signing_invoked: false,
    native_semantic_review_complete: false, release_approved: false }));
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
