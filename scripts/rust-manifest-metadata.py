"""Read actual Cargo manifests with already reviewed tools; no build or hooks.

Only --no-deps --locked --offline metadata. No CodeQL extraction, dependency
resolution/download, package execution, application launch, signing or upload.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tempfile
import urllib.request

PIN = 'a9738f4c3e98c02edbe4b8a9e74bab3d6e53aff29936a4ec39f870c9f0b55a4d'
RUNTIME_PIN = 'c8965ee984ca699e87fead31b46c68330c645759f85bd63711c77ebe64eaf0db'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def acquire(commit, name, size, expected):
    url = 'https://raw.githubusercontent.com/StellerSecurity/Stellar.UI.Desktop.VPNapp/' + commit + '/' + name
    request = urllib.request.Request(url, headers={'Accept-Encoding': 'identity'})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=30) as response:
        if response.status != 200 or response.geturl() != url:
            raise ValueError('unexpected first-party source response')
        raw = response.read(size + 1)
    if len(raw) != size or hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError('exact first-party source bytes changed')
    return raw


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--execute-reviewed-metadata', action='store_true')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    raw = (root / 'app-metadata-inputs.json').read_bytes()
    if hashlib.sha256(raw).hexdigest() != PIN:
        raise ValueError('metadata input identity drift')
    plan = json.loads(raw)
    runtime_raw = (root / 'runtime-review.json').read_bytes()
    if hashlib.sha256(runtime_raw).hexdigest() != RUNTIME_PIN:
        raise ValueError('reviewed runtime plan drift')
    runtime = json.loads(runtime_raw)
    helper = root / 'codeql-rust-probe.py'
    if hashlib.sha256(helper.read_bytes()).hexdigest() != runtime['harness_sha256']:
        raise ValueError('first-party runtime guard drift')
    spec = importlib.util.spec_from_file_location('firstparty_runtime_guard', helper)
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)
    guard.verify_files(runtime['files'])  # Read/hash only; does not run CodeQL.
    commit = plan['source_commit']
    if not re.fullmatch('[a-f0-9]{40}', commit) or not 1 <= len(plan['files']) <= 256:
        raise ValueError('source identity/count')
    with tempfile.TemporaryDirectory(prefix='stellar-real-manifest-', dir='/tmp') as folder:
        work = Path(folder)
        source = work / 'source'
        source.mkdir()
        seen, total = set(), 0
        for row in plan['files']:
            name = row['path']
            parts = PurePosixPath(name)
            if (not re.fullmatch('[A-Za-z0-9_./-]{1,400}', name)
                    or parts.is_absolute() or '..' in parts.parts or name in seen
                    or not (name.endswith('.rs') or parts.name in ('Cargo.toml', 'Cargo.lock'))
                    or not 0 < row['bytes'] <= 2 * 1024**2):
                raise ValueError('source path/type/size')
            total += row['bytes']
            if total > 8 * 1024**2:
                raise ValueError('source byte budget')
            seen.add(name)
            value = acquire(commit, name, row['bytes'], row['sha256'])
            target = source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(value)
        for name in ('home', 'cargo', 'rustup', 'tmp'):
            (work / name).mkdir()
        rust = guard.RUST
        env = dict(PATH=rust + '/bin:/usr/bin:/bin', HOME=str(work / 'home'),
                   TMPDIR=str(work / 'tmp'), LANG='C.UTF-8', CARGO_HOME=str(work / 'cargo'),
                   CARGO_NET_OFFLINE='true', RUSTUP_HOME=str(work / 'rustup'),
                   RUSTUP_TOOLCHAIN=rust, RUSTC=rust + '/bin/rustc')
        if not args.execute_reviewed_metadata:
            print(json.dumps(dict(source_preflight_passed=True, source_files=len(seen),
                                  source_bytes=total, native_execution=False,
                                  explicit_application_metadata_approval_required=True)))
            return
        results = []
        for manifest, expected in plan['manifests'].items():
            if manifest not in seen:
                raise ValueError('unbound manifest')
            command = [rust + '/bin/cargo', 'metadata', '--format-version', '1',
                       '--no-deps', '--locked', '--offline', '--manifest-path', str(source / manifest)]
            result = subprocess.run(command, cwd=source, env=env, stdin=subprocess.DEVNULL,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
            if result.returncode or len(result.stdout) + len(result.stderr) > 2 * 1024**2:
                raise ValueError('read-only Cargo metadata failed: ' + manifest + ': ' +
                                 result.stderr.decode(errors='replace')[:1000].replace(str(work), '<temporary>'))
            names = sorted(row['name'] for row in json.loads(result.stdout)['packages'])
            if names != expected:
                raise ValueError('unexpected package membership')
            results.append(dict(manifest=manifest, packages=names, exit_code=0))
        after = {str(path.relative_to(source)) for path in source.rglob('*') if path.is_file()}
        if after != seen or any(hashlib.sha256((source / row['path']).read_bytes()).hexdigest() != row['sha256']
                                for row in plan['files']):
            raise ValueError('source or lock changed')
        print(json.dumps(dict(results=results, source_files=len(seen), source_bytes=total,
                              source_commit=commit, source_lock_unchanged=True,
                              package_or_build_script_executed=False, codeql_executed=False,
                              dependency_downloaded=False, app_launched=False,
                              semantic_coverage_certified=False)))


if __name__ == '__main__':
    main()
