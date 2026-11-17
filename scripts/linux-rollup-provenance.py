"""Verify public provenance using reviewed tools, with target execution denied."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parent


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def main():
    if os.uname().sysname != 'Linux' or os.uname().machine != 'x86_64' or os.environ.get('GITHUB_ACTIONS') != 'true':
        raise ValueError('reviewed ephemeral CI Linux only')
    runtime = module('reviewed_runtime', 'linux-npm-backport-probe.py')
    patcher = module('reviewed_patcher', 'patch-reviewed-npm-tool.py')
    metadata = module('public_metadata', 'prepare-sigstore-public-metadata.py')
    npm = runtime.download('https://registry.npmjs.org/npm/-/npm-11.21.2.tgz', runtime.NPM_SHA, 8 * 1024**2)
    node = runtime.download('https://nodejs.org/dist/v26.13.1/node-v26.13.1-linux-x64.tar.xz', runtime.NODE_ARCHIVE_SHA, 64 * 1024**2)
    with tempfile.TemporaryDirectory(prefix='stellar-public-verification-', dir=ROOT) as folder:
        work = Path(folder).resolve()
        (work / 'tmp').mkdir()
        records, patches, executable = runtime.materialize_runtime(work, npm, node, patcher)
        seed = json.loads((work / 'npm/node_modules/@sigstore/tuf/seeds.json').read_text())[metadata.ORIGIN]
        public = metadata.prepare(seed)
        (work / 'public-tuf.json').write_text(json.dumps(public))
        url = 'https://registry.npmjs.org/-/npm/v1/attestations/@rollup%2fwasm-node@4.65.1'
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), runtime.NoRedirect())
        with opener.open(url, timeout=30) as response:
            raw = response.read(256 * 1024 + 1)
            if response.geturl() != url or len(raw) > 256 * 1024:
                raise ValueError('public attestation bounds/origin')
        parsed = json.loads(raw)
        if set(parsed) != {'attestations'} or len(parsed['attestations']) != 2:
            raise ValueError('public attestation envelope drift')
        (work / 'attestations.json').write_bytes(raw)
        (work / 'verify.cjs').write_bytes((ROOT / 'verify-rollup-provenance.cjs').read_bytes())
        env = dict(PATH='/usr/bin:/bin', TMPDIR=str(work / 'tmp'), LANG='C.UTF-8', TZ='UTC')
        command = [str(executable), '--permission', '--allow-fs-read=' + str(work),
                   '--allow-fs-write=' + str(work), '--no-addons', '--disable-sigusr1',
                   '--max-old-space-size=256', str(work / 'verify.cjs')]
        result = json.loads(runtime.run(command, work, env, 45))
        if result.get('verified') is not True or result.get('negative_controls') != 5:
            raise ValueError('incomplete provenance verification')
        for relative, digest in records.items():
            runtime.verified(work / 'npm' / relative, digest)
        result.update(tool_source_files_unchanged=len(records),
                      node_sha256=runtime.NODE_SHA, npm_sha256=runtime.NPM_SHA,
                      attestation_response_sha256=hashlib.sha256(raw).hexdigest(),
                      package_installation=False, lifecycle_hooks_executed=False,
                      secrets_configured=False, app_changed=False)
        print(json.dumps(result))


if __name__ == '__main__':
    main()
