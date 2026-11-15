"""Pinned, approval-gated first-party Cargo/CodeQL discovery probe.

No application inputs, registry packages, package hooks, signing or uploads.
The default mode only hashes already installed tools. Native execution requires
the exact reviewed plan as an explicit argument after user authorization.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import signal
import subprocess
import tempfile
import time
import zipfile

CODEQL = '/opt/hostedtoolcache/CodeQL/2.27.4/x64/codeql'
RUST = '/home/runner/.rustup/toolchains/stable-x86_64-unknown-linux-gnu'
JAVA = '/usr/lib/jvm/temurin-25-jdk-amd64'


def verify_files(rows):
    if not 1 <= len(rows) <= 600:
        raise ValueError('runtime inventory count')
    identities = set()
    total = 0
    for row in rows:
        root, name = row['root'], row['path']
        path = PurePosixPath(name)
        if root not in (CODEQL, RUST, JAVA) or path.is_absolute() or '..' in path.parts:
            raise ValueError('unapproved runtime path')
        if root == CODEQL and name.startswith('tools/linux64/java/'):
            raise ValueError('outdated bundled Java is not permitted')
        if (root, name) in identities:
            raise ValueError('duplicate runtime identity')
        identities.add((root, name))
        target = Path(root) / name
        if target.is_symlink() or not target.is_file() or target.stat().st_size != row['bytes']:
            raise ValueError('runtime file type/size drift: ' + name)
        total += row['bytes']
        if row['bytes'] > 512 * 1024**2 or total > 2 * 1024**3:
            raise ValueError('runtime byte budget')
        checksum = hashlib.sha256()
        with target.open('rb') as source:
            for block in iter(lambda: source.read(1024**2), b''):
                checksum.update(block)
        if checksum.hexdigest() != row['sha256']:
            raise ValueError('runtime hash drift: ' + name)
    for identity in ((CODEQL, 'codeql'), (CODEQL, 'tools/codeql.jar'),
                     (CODEQL, 'rust/tools/linux64/extractor'),
                     (RUST, 'bin/cargo'), (RUST, 'bin/rustc'), (JAVA, 'bin/java')):
        if identity not in identities:
            raise ValueError('required runtime is not pinned')
    return total


def fixture(root):
    files = {
        'Cargo.toml': '[workspace]\nmembers=["app", "core"]\nexclude=["vendor/helper", "fixtures/local-dev"]\nresolver="2"\n',
        'app/Cargo.toml': '[package]\nname="stellar-codeql-probe-app"\nversion="0.0.0"\nedition="2021"\nbuild=false\n[dependencies]\ncore_fixture={package="stellar-codeql-probe-core",path="../core"}\nhelper={package="stellar-codeql-probe-helper",path="../vendor/helper"}\n',
        'core/Cargo.toml': '[package]\nname="stellar-codeql-probe-core"\nversion="0.0.0"\nedition="2021"\nbuild=false\n',
        'vendor/helper/Cargo.toml': '[package]\nname="stellar-codeql-probe-helper"\nversion="0.0.0"\nedition="2021"\nbuild=false\n[dev-dependencies]\nprobe_dev={package="stellar-codeql-probe-dev",path="../../fixtures/local-dev"}\n',
        'fixtures/local-dev/Cargo.toml': '[package]\nname="stellar-codeql-probe-dev"\nversion="0.0.0"\nedition="2021"\nbuild=false\n',
        'app/src/lib.rs': 'pub fn retained() -> bool { core_fixture::retained() && helper::marker() }\n',
        'core/src/lib.rs': 'pub fn retained() -> bool { true }\n',
        'vendor/helper/src/lib.rs': 'pub fn marker() -> bool { true }\n',
        'fixtures/local-dev/src/lib.rs': 'pub fn marker() -> bool { true }\n',
        'Cargo.lock': 'version = 4\n\n[[package]]\nname="stellar-codeql-probe-app"\nversion="0.0.0"\ndependencies=["stellar-codeql-probe-core", "stellar-codeql-probe-helper"]\n\n[[package]]\nname="stellar-codeql-probe-core"\nversion="0.0.0"\n\n[[package]]\nname="stellar-codeql-probe-helper"\nversion="0.0.0"\n',
        'vendor/helper/Cargo.lock': 'version=4\n\n[[package]]\nname="stellar-codeql-probe-helper"\nversion="0.0.0"\ndependencies=["stellar-codeql-probe-dev"]\n\n[[package]]\nname="stellar-codeql-probe-dev"\nversion="0.0.0"\n',
        'fixtures/local-dev/Cargo.lock': 'version=4\n\n[[package]]\nname="stellar-codeql-probe-dev"\nversion="0.0.0"\n',
    }
    for name, data in files.items():
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(data)
    return {name: hashlib.sha256(data.encode()).hexdigest() for name, data in files.items()}


def run(command, cwd, env, log, seconds):
    with log.open('wb') as output:
        process = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                   stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        started = time.monotonic()
        while process.poll() is None:
            if time.monotonic() - started > seconds or log.stat().st_size > 8 * 1024**2:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
                raise ValueError('native probe time/output budget')
            time.sleep(0.1)
    if process.returncode:
        print('PROBE_FAILURE_LOG=' + log.read_text(errors='replace')[-12000:], flush=True)
        raise ValueError('probe command failed; see bounded diagnostic log')
    return dict(command=command[:3], log_sha256=hashlib.sha256(log.read_bytes()).hexdigest(),
                output_bytes=log.stat().st_size, exit_code=process.returncode)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--approved-plan-sha256')
    args = parser.parse_args()
    if args.manifest.is_symlink() or args.manifest.stat().st_size > 256 * 1024:
        raise ValueError('runtime plan size/type')
    raw = args.manifest.read_bytes()
    plan = json.loads(raw)
    if hashlib.sha256(Path(__file__).read_bytes()).hexdigest() != plan['harness_sha256']:
        raise ValueError('first-party harness drift')
    if plan['purpose'] != 'Isolated first-party Rust CodeQL workspace/library discovery probe; not application analysis or release clearance':
        raise ValueError('unexpected purpose')
    total = verify_files(plan['files'])
    if args.approved_plan_sha256 is None:
        print(json.dumps(dict(preflight_passed=True, files=len(plan['files']), bytes=total,
                              native_execution=False, explicit_execution_approval_required=True)))
        return
    if args.approved_plan_sha256 != hashlib.sha256(raw).hexdigest():
        raise ValueError('exact native-execution approval required')
    with tempfile.TemporaryDirectory(prefix='stellar-codeql-first-party-') as folder:
        work = Path(folder)
        source = work / 'source'
        source.mkdir()
        before = fixture(source)
        for name in ('home', 'cargo', 'rustup', 'tmp', 'target'):
            (work / name).mkdir()
        env = dict(PATH=RUST + '/bin:/usr/bin:/bin', HOME=str(work / 'home'),
                   LANG='C.UTF-8', TMPDIR=str(work / 'tmp'), CODEQL_DIST=CODEQL,
                   CODEQL_PLATFORM='linux64', CODEQL_JAVA_HOME=JAVA,
                   CARGO_HOME=str(work / 'cargo'), CARGO_NET_OFFLINE='true',
                   CARGO_TARGET_DIR=str(work / 'target'), RUSTUP_HOME=str(work / 'rustup'),
                   RUSTUP_TOOLCHAIN=RUST, RUSTC=RUST + '/bin/rustc', CARGO=RUST + '/bin/cargo',
                   HTTP_PROXY='http://127.0.0.1:9', HTTPS_PROXY='http://127.0.0.1:9',
                   ALL_PROXY='http://127.0.0.1:9', NO_PROXY='')
        metadata = run([RUST + '/bin/cargo', 'metadata', '--format-version', '1', '--no-deps',
                        '--locked', '--offline'], source, env, work / 'metadata.log', 30)
        extraction = run([CODEQL + '/codeql', 'database', 'create', str(work / 'database'),
                          '--language=rust', '--build-mode=none', '--source-root=' + str(source),
                          '--threads=2', '--ram=3072'], source, env, work / 'extractor.log', 300)
        diagnostic = (work / 'extractor.log').read_text(errors='replace')
        if any(message in diagnostic.lower() for message in
               ('unable to load manifest', 'failed to load manifest', 'no manifest found')):
            raise ValueError('synthetic manifest discovery incomplete')
        if any(hashlib.sha256((source / name).read_bytes()).hexdigest() != value
               for name, value in before.items()):
            raise ValueError('synthetic source/lock mutated')
        source_zip = work / 'database/src.zip'
        if not source_zip.is_file() or source_zip.stat().st_size > 128 * 1024**2:
            raise ValueError('source archive unavailable or oversized')
        expected = {name: digest for name, digest in before.items() if name.endswith('.rs')}
        observed = {}
        with zipfile.ZipFile(source_zip) as archive:
            if len(archive.infolist()) > 10000:
                raise ValueError('source archive member budget')
            for item in archive.infolist():
                for name, digest in expected.items():
                    if item.filename == name or item.filename.endswith('/source/' + name):
                        if name in observed or item.file_size > 8192:
                            raise ValueError('duplicate/oversized synthetic source')
                        actual = hashlib.sha256(archive.read(item)).hexdigest()
                        if actual != digest:
                            raise ValueError('source archive mismatch')
                        observed[name] = actual
        if observed != expected:
            raise ValueError('not all synthetic Rust files were extracted')
        # No query/SARIF upload and no assertion of complete application coverage.
        print(json.dumps(dict(metadata=metadata, extraction=extraction,
                              source_files=len(before), first_party_only=True,
                              synthetic_rust_sources_verified=len(observed),
                              manifest_diagnostics=[line.replace(str(work), '<probe>')[:500]
                                                    for line in diagnostic.splitlines() if 'manifest' in line.lower()][:30],
                              application_analyzed=False, release_clearance=False,
                              credentials_passed=False, installed=False, uploaded=False)))


if __name__ == '__main__':
    main()
