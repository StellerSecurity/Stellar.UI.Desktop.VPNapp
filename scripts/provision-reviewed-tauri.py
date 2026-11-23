#!/usr/bin/env python3
"""Provision one exact reviewed Tauri CLI runtime without package hooks."""
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / 'vendor' / 'tauri-cli-reviewed' / 'runtime-manifest.json'
MAX_ARCHIVE_BYTES = 64 * 1024 * 1024


def host_target():
    system = platform.system().lower()
    machine = platform.machine().lower()
    arch = {'aarch64': 'arm64', 'amd64': 'x64', 'x86_64': 'x64', 'i386': 'ia32', 'i686': 'ia32'}.get(machine, machine)
    if system == 'darwin':
        return f'darwin-{arch}'
    if system == 'windows':
        return f'win32-{arch}'
    if system == 'linux':
        libc = 'musl' if platform.libc_ver()[0].lower() == 'musl' else 'gnu'
        return f'linux-{arch}-{libc}'
    raise SystemExit('No reviewed Tauri CLI runtime exists for this host.')


def digest(name, data):
    return hashlib.new(name, data).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--target', default=host_target())
    parser.add_argument('--approve-reviewed-download', action='store_true')
    args = parser.parse_args()
    if not args.approve_reviewed_download:
        raise SystemExit('Review runtime-manifest.json, then pass --approve-reviewed-download explicitly.')

    manifest = json.loads(MANIFEST.read_text())
    approved = manifest['targets'].get(args.target)
    if approved is None or manifest['package_version'] != '2.12.4':
        raise SystemExit('Target is not present in the reviewed Tauri CLI manifest.')
    if not approved['url'].startswith('https://registry.npmjs.org/@tauri-apps/cli-'):
        raise SystemExit('Unexpected runtime origin.')

    request = urllib.request.Request(approved['url'], headers={'User-Agent': 'stellar-reviewed-tauri-provisioner/1'})
    with urllib.request.urlopen(request, timeout=30) as response:
        declared = int(response.headers.get('Content-Length', '0'))
        if declared <= 0 or declared > MAX_ARCHIVE_BYTES:
            raise SystemExit('Runtime archive size is missing or outside the approved bound.')
        archive = response.read(MAX_ARCHIVE_BYTES + 1)
    if len(archive) != declared or len(archive) > MAX_ARCHIVE_BYTES:
        raise SystemExit('Runtime archive length changed.')
    if digest('sha256', archive) != approved['archive_sha256']:
        raise SystemExit('Runtime archive SHA-256 mismatch.')
    expected_sha512 = base64.b64decode(approved['integrity'].removeprefix('sha512-'), validate=True).hex()
    if digest('sha512', archive) != expected_sha512:
        raise SystemExit('Runtime archive registry integrity mismatch.')

    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as bundle:
        members = [member for member in bundle.getmembers() if member.name == approved['member']]
        if len(members) != 1 or not members[0].isfile() or members[0].size != approved['bytes']:
            raise SystemExit('Reviewed runtime member is missing or changed.')
        stream = bundle.extractfile(members[0])
        runtime = stream.read(approved['bytes'] + 1) if stream else b''
    if len(runtime) != approved['bytes'] or digest('sha256', runtime) != approved['sha256']:
        raise SystemExit('Reviewed runtime member hash mismatch.')

    destination = ROOT / '.stellar-build-tools' / 'tauri' / approved['filename']
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as staged:
        staged.write(runtime)
        staged_path = Path(staged.name)
    os.replace(staged_path, destination)
    print(f'Provisioned reviewed Tauri CLI {manifest["package_version"]} for {args.target}.')


if __name__ == '__main__':
    main()
