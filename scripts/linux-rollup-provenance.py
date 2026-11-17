"""Verify public provenance using reviewed tools, with target execution denied."""
import hashlib
import importlib.util
import io
import json
import os
import sys
from pathlib import Path
import tempfile
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parent


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def main():
    if sys.argv[1:] not in ([], ['--probe-parser']):
        raise ValueError('fixed analysis scope only')
    probe_parser = sys.argv[1:] == ['--probe-parser']
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
        package = runtime.download('https://registry.npmjs.org/@rollup/wasm-node/-/wasm-node-4.65.1.tgz',
                                   '8fd2e64dfeaa6334a683ce198e4b6487df44c63f02f3b7843339300b3e5f459a', 4 * 1024**2)
        if hashlib.sha512(package).hexdigest() != '05ef71d299c54bdd70b40b25cf47f1dc79cb6ea42e578105d972de9b08f3f011aa2e332bc3db42ceeeef22e5a0a63084b0c42032d6751485872715fde59c0193':
            raise ValueError('attested archive digest drift')
        with tarfile.open(fileobj=io.BytesIO(package), mode='r:gz') as archive:
            members = archive.getmembers()
            matching = [m for m in members if m.name == 'package/dist/wasm-node/bindings_wasm_bg.wasm']
            if len(members) != 29 or len(matching) != 1 or not matching[0].isfile() or matching[0].size != 588077:
                raise ValueError('reviewed WASM archive member drift')
            wasm = archive.extractfile(matching[0]).read(588078)
        if hashlib.sha256(wasm).hexdigest() != '7099c59e9da5c0d690356ba986bf02a89dd21b35e578684758ecbdac4aca0c8d':
            raise ValueError('reviewed WASM content drift')
        (work / 'reviewed.wasm').write_bytes(wasm)
        (work / 'verify.cjs').write_bytes((ROOT / 'verify-rollup-provenance.cjs').read_bytes())
        env = dict(PATH='/usr/bin:/bin', TMPDIR=str(work / 'tmp'), LANG='C.UTF-8', TZ='UTC')
        command = [str(executable), '--permission', '--allow-fs-read=' + str(work),
                   '--allow-fs-write=' + str(work), '--no-addons', '--disable-sigusr1',
                   '--max-old-space-size=256', str(work / 'verify.cjs')]
        result = json.loads(runtime.run(command, work, env, 45))
        if result.get('verified') is not True or result.get('negative_controls') != 5:
            raise ValueError('incomplete provenance verification')
        result['provenance_target_code_executed'] = result.pop('target_code_executed')
        result['target_code_executed'] = False
        if probe_parser:
            identities = json.loads((ROOT / 'rollup-parser-probe-file-identity.json').read_text())
            expected_names = {'dist/wasm-node/bindings_wasm.js', 'dist/wasm-node/bindings_wasm_bg.wasm',
                              'dist/native.js', 'dist/parseAst.js', 'dist/shared/parseAst.js'}
            if set(identities) != expected_names:
                raise ValueError('fixed synthetic parser source scope')
            with tarfile.open(fileobj=io.BytesIO(package), mode='r:gz') as archive:
                for name, identity in identities.items():
                    member = archive.getmember('package/' + name)
                    if not member.isfile() or member.size != identity['bytes']:
                        raise ValueError('fixed parser source member drift')
                    content = archive.extractfile(member).read(1024 * 1024)
                    if hashlib.sha256(content).hexdigest() != identity['sha256']:
                        raise ValueError('fixed parser source content drift')
                    destination = work / 'rollup' / name
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(content)
            (work / 'parser-probe.cjs').write_bytes((ROOT / 'rollup-wasm-parser-probe.cjs').read_bytes())
            command = [str(executable), '--permission', '--allow-fs-read=' + str(work),
                       '--no-addons', '--disable-sigusr1', '--max-old-space-size=128',
                       '--wasm-max-mem-pages=64', str(work / 'parser-probe.cjs')]
            parser_result = json.loads(runtime.run(command, work, env, 30))
            if parser_result.get('assertions') != 16 or not parser_result.get('oversize_memory_growth_rejected'):
                raise ValueError('incomplete bounded parser regressions')
            for name, identity in identities.items():
                runtime.verified(work / 'rollup' / name, identity['sha256'])
            result['scoped_parser_regressions'] = parser_result
            result['target_code_executed'] = True
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
