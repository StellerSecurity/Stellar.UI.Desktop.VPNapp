"""Explicit-approval-only source build. No downloads, system installs or publication.

Uses the five pinned, previously statically inspected source archives and three
bounded backports. Installs only into a fresh local build prefix. Requires the
user's explicit source execution approval before invocation.
"""
import hashlib
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tarfile
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent


def build(inputs):
    if sys.platform != 'darwin' or os.uname().machine != 'arm64':
        raise ValueError('Native Apple Silicon macOS build required')
    lock = json.loads((ROOT / 'scripts/intel-source-lock.json').read_text())
    packages = [p for p in lock['artifacts'] if p['name'] != 'rust-std']
    # Verify all inputs before any extraction or third-party execution.
    for item in packages:
        archive = inputs / item['file']
        if archive.is_symlink() or not archive.is_file() or hashlib.sha256(archive.read_bytes()).hexdigest() != item['sha256']:
            raise ValueError('Source checksum mismatch: ' + item['name'])
    base = pathlib.Path('/private/tmp/stellar-runtime-source')
    base.mkdir(parents=True, exist_ok=True)
    work = pathlib.Path(tempfile.mkdtemp(prefix='arm64-macos12-', dir=base))
    prefix = work / 'prefix'
    prefix.mkdir()
    sources = {}
    for item in packages:
        with tarfile.open(inputs / item['file'], 'r:*') as archive:
            members = archive.getmembers()
            expected = item['name'] + '-' + item['version']
            if any(not m.name.startswith(expected + '/') and m.name.rstrip('/') != expected for m in members):
                raise ValueError('Unexpected source root')
            archive.extractall(work, members=members, filter='data')
        sources[item['name']] = work / expected
    spec = importlib.util.spec_from_file_location('backports', ROOT / 'scripts/review-intel-backports.py')
    patches = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(patches)
    patch_evidence = patches.review(inputs)
    for patch in patches.BACKPORTS:
        target = sources[patch['package']] / patch['file']
        target.write_text(patches.patched_text(target.read_text(), patch['replacements']))
        expected = next(r['plannedOutputSha256'] for r in patch_evidence['backports'] if r['package'] == patch['package'])
        if hashlib.sha256(target.read_bytes()).hexdigest() != expected:
            raise ValueError('Backport output mismatch')
    home, temp = work / 'home', work / 'tmp'
    home.mkdir(); temp.mkdir()
    # No inherited API/signing credentials, package-manager paths or user config.
    env = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(home), 'TMPDIR': str(temp),
           'MACOSX_DEPLOYMENT_TARGET': '12.0', 'LC_ALL': 'C', 'CC': '/usr/bin/clang',
           'CFLAGS': '-O2 -arch arm64 -mmacosx-version-min=12.0',
           'CPPFLAGS': f'-I{prefix}/include',
           'LDFLAGS': f'-arch arm64 -mmacosx-version-min=12.0 -L{prefix}/lib',
           'PKG_CONFIG': '/usr/bin/false', 'AR': '/usr/bin/ar', 'RANLIB': '/usr/bin/ranlib'}
    commands = []

    def run(directory, *args, extra=None):
        commands.append({'cwd': str(directory), 'args': list(args)})
        (work / 'commands.json').write_text(json.dumps(commands, indent=2))
        with (work / 'build.log').open('ab') as log:
            subprocess.run(['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)(deny network*)', *args],
                           cwd=directory, env={**env, **(extra or {})}, stdout=log, stderr=subprocess.STDOUT, check=True)

    openssl = sources['openssl']
    run(openssl, '/usr/bin/perl', 'Configure', 'darwin64-arm64-cc', 'shared', 'no-tests',
        '--prefix=' + str(prefix), '--openssldir=' + str(prefix / 'ssl'), '-mmacosx-version-min=12.0')
    run(openssl, '/usr/bin/make', '-j4')
    run(openssl, '/usr/bin/make', 'install_sw')
    for name in ['lzo', 'lz4', 'pkcs11-helper']:
        directory = sources[name]
        if name == 'lz4':
            run(directory / 'lib', '/usr/bin/make', '-j4', 'liblz4')
            run(directory / 'lib', '/usr/bin/make', 'install', 'PREFIX=' + str(prefix))
        else:
            options = ['--prefix=' + str(prefix), '--enable-shared', '--disable-static']
            extra = {'OPENSSL_CFLAGS': f'-I{prefix}/include', 'OPENSSL_LIBS': f'-L{prefix}/lib -lcrypto'}
            run(directory, '/bin/sh', './configure', *options, extra=extra)
            run(directory, '/usr/bin/make', '-j4')
            run(directory, '/usr/bin/make', 'install')
    options = {'OPENSSL_CFLAGS': f'-I{prefix}/include', 'OPENSSL_LIBS': f'-L{prefix}/lib -lssl -lcrypto',
               'LZO_CFLAGS': f'-I{prefix}/include', 'LZO_LIBS': f'-L{prefix}/lib -llzo2',
               'LZ4_CFLAGS': f'-I{prefix}/include', 'LZ4_LIBS': f'-L{prefix}/lib -llz4',
               'PKCS11_HELPER_CFLAGS': f'-I{prefix}/include', 'PKCS11_HELPER_LIBS': f'-L{prefix}/lib -lpkcs11-helper'}
    run(sources['openvpn'], '/bin/sh', './configure', '--prefix=' + str(prefix),
        '--disable-dco', '--disable-unit-tests', '--disable-plugin-auth-pam', '--disable-plugin-down-root', extra=options)
    run(sources['openvpn'], '/usr/bin/make', '-j4')
    runtime = work / 'openvpn-runtime'
    runtime.mkdir()
    names = ['openvpn', 'libcrypto.4.dylib', 'libssl.4.dylib', 'liblzo2.2.dylib', 'libpkcs11-helper.1.dylib', 'liblz4.1.dylib']
    for name in names:
        source = sources['openvpn'] / 'src/openvpn/openvpn' if name == 'openvpn' else prefix / 'lib' / name
        output = runtime / name
        output.write_bytes(source.read_bytes()); output.chmod(0o755)
    for name in names:
        output = runtime / name
        linked = subprocess.check_output(['/usr/bin/otool', '-L', str(output)], text=True)
        for line in linked.splitlines()[1:]:
            dependency = line.strip().split(' ')[0]
            if dependency.startswith(str(prefix) + '/'):
                library = pathlib.Path(dependency).name
                if library not in names:
                    raise ValueError('Unexpected runtime dependency: ' + library)
                run(work, '/usr/bin/install_name_tool', '-change', dependency, '@loader_path/' + library, str(output))
            elif not dependency.startswith(('/usr/lib/', '/System/Library/', '@loader_path/')):
                raise ValueError('Unexpected non-system dependency: ' + dependency)
        if name != 'openvpn':
            run(work, '/usr/bin/install_name_tool', '-id', '@loader_path/' + name, str(output))
        run(work, '/usr/bin/codesign', '--force', '--sign', '-', str(output))
    manifest = {'platform': 'darwin-arm64', 'minimumMacOS': '12.0', 'packages': packages,
                'backports': patch_evidence['backports'], 'files': [
                    {'file': name, 'sha256': hashlib.sha256((runtime / name).read_bytes()).hexdigest()} for name in names]}
    (runtime / 'runtime-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    # First-party static checker verifies actual Mach-O targets, not build flags.
    checker = "import fs from 'node:fs';import {verifyRuntime,minimumMacOS} from './scripts/macos-architecture.mjs';const d=process.argv[1];const m=verifyRuntime(d,'arm64');for(const r of m.files)r.minimumMacOS=minimumMacOS(d+'/'+r.file);fs.writeFileSync(d+'/runtime-manifest.json',JSON.stringify(m,null,2)+'\\n');"
    subprocess.run(['node', '--input-type=module', '-e', checker, str(runtime)], cwd=ROOT, check=True)
    # No VPN connection, helper installation, external test or signing-key use.
    run(work, str(runtime / 'openvpn'), '--version')
    print(runtime)


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] != '--approved-source-build':
        raise SystemExit('Usage (requires explicit approval): python3 scripts/build-arm64-runtime.py --approved-source-build INPUT_DIRECTORY')
    build(pathlib.Path(sys.argv[2]).resolve(strict=True))
