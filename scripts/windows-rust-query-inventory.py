"""Read public, preinstalled Rust CodeQL query-pack metadata only."""
import hashlib
import json
import os
from pathlib import Path
import re
import time

base = Path('C:/hostedtoolcache/windows/CodeQL/2.27.4/x64/codeql/qlpacks/codeql')
queue = ['rust-queries', 'rust-all']
seen, packages, missing = set(), [], []
started = time.monotonic()
bytes_read = 0
file_count = 0
while queue:
    name = queue.pop(0)
    if name in seen:
        continue
    if not re.fullmatch('[a-z0-9-]{1,64}', name) or len(seen) >= 64:
        raise ValueError('query pack closure bounds')
    seen.add(name)
    package = base / name
    if not package.is_dir() or package.is_symlink():
        missing.append(name)
        continue
    for version in sorted(package.iterdir()):
        if not version.is_dir() or version.is_symlink():
            continue
        manifest_path = version / 'qlpack.yml'
        if not manifest_path.is_file() or manifest_path.is_symlink() or manifest_path.stat().st_size > 65536:
            raise ValueError('query pack manifest bounds')
        manifest = manifest_path.read_text(encoding='utf-8')
        metadata = {'name': name, 'version_directory': version.name, 'manifest': manifest, 'files': [], 'opaque_files': [], 'packing_metadata': {}}
        dependencies = False
        for line in manifest.splitlines():
            if line == 'dependencies:':
                dependencies = True
            elif dependencies and line and not line[0].isspace():
                dependencies = False
            elif dependencies and line.strip():
                match = re.fullmatch(r'  codeql/([a-z0-9-]+): .+', line)
                if not match:
                    raise ValueError('unrecognized query dependency metadata')
                queue.append(match.group(1))
        for directory, dirs, names in os.walk(version, followlinks=False):
            for subdir in dirs:
                if (Path(directory) / subdir).is_symlink():
                    raise ValueError('query package directory symlink')
            for filename in sorted(names):
                path = Path(directory) / filename
                if path.suffix.casefold() == '.md':
                    continue
                if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(version.resolve()):
                    raise ValueError('query package source path containment')
                size = path.stat().st_size
                if size > 8 * 1024**2 or bytes_read + size > 128 * 1024**2 or file_count >= 12000 or time.monotonic() - started > 90:
                    raise ValueError('query package static read budget')
                raw = path.read_bytes()
                bytes_read += len(raw)
                file_count += 1
                if filename in ('.packinfo', 'codeql-pack.lock.yml', 'qlpack.lock.yml', 'codeql-pack.release.yml') and len(raw) <= 16384:
                    metadata['packing_metadata'][path.relative_to(version).as_posix()] = raw.decode('utf-8')
                row = dict(path=path.relative_to(version).as_posix(), bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest(), git_blob_sha1=hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest())
                try:
                    raw.decode('utf-8')
                    text = path.suffix in ('.ql', '.qll', '.qls', '.yml', '.yaml', '.json', '.dbscheme', '.stats', '.csv', '.txt', '.properties') or filename in ('LICENSE', 'NOTICE')
                except UnicodeDecodeError:
                    text = False
                metadata['files' if text else 'opaque_files'].append(row)
        packages.append(metadata)
rust = Path('C:/Users/runneradmin/.rustup/toolchains/stable-x86_64-pc-windows-msvc')
sysroot_files = []
for relative in ('lib/rustlib/src/rust/library/Cargo.toml', 'lib/rustlib/src/rust/library/core/src/lib.rs',
                 'lib/rustlib/src/rust/library/alloc/src/lib.rs', 'lib/rustlib/src/rust/library/std/src/lib.rs'):
    path = rust / relative
    row = dict(path=relative, exists=path.is_file(), symlink=path.is_symlink())
    if path.is_file() and not path.is_symlink():
        if path.stat().st_size > 4 * 1024**2:
            raise ValueError('sysroot source metadata byte bounds')
        raw = path.read_bytes()
        row.update(bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())
    sysroot_files.append(row)
print(json.dumps(dict(sysroot_source_files=sysroot_files, packages=packages, missing=missing, files_hashed=file_count, bytes_hashed=bytes_read,
                      source_review_complete=False, query_executed=False, sdk_executed=False,
                      downloaded=False, signing=False, private_credentials_read=False), separators=(',', ':')))
