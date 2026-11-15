"""Read-only inventory of preinstalled CodeQL/Rust tools. Never execute targets."""
import hashlib
import json
import os
from pathlib import Path
import stat
import time

LIMIT_FILES = 12000
LIMIT_BYTES = 3 * 1024**3
started = time.monotonic()
rows = []
scanned = 0
roots = [Path('/opt/hostedtoolcache/CodeQL/2.27.4/x64/codeql'),
         Path.home() / '.rustup/toolchains/1.99.1-x86_64-unknown-linux-gnu',
         Path('/opt/hostedtoolcache/go/1.26.4/x64')]
missing = []
for root in roots:
    if not root.is_dir() or root.is_symlink():
        missing.append(str(root))
        continue
    for folder, dirs, names in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if not (Path(folder) / d).is_symlink())
        for name in sorted(names):
            path = Path(folder) / name
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode):
                continue
            if not stat.S_ISREG(info.st_mode):
                raise ValueError('unexpected tool file type')
            if time.monotonic() - started > 90 or len(rows) >= LIMIT_FILES:
                raise ValueError('static inventory budget')
            relative = str(path.relative_to(root))
            rust_tool = (root.name.startswith('1.99.1-') and
                         (relative.startswith(('bin/', 'libexec/',
                                               'lib/rustlib/x86_64-unknown-linux-gnu/lib/'))
                          or relative.startswith(('lib/librustc_', 'lib/libLLVM'))))
            go_tool = ('/go/1.26.4/' in str(root) and
                       (relative == 'VERSION' or relative.startswith(('bin/', 'pkg/tool/linux_amd64/'))))
            codeql_tool = (root.name == 'codeql' and
                           (relative == 'codeql' or relative.startswith(('rust/', 'tools/linux64/', 'tools/codeql'))))
            selected = rust_tool or go_tool or codeql_tool
            if not selected:
                continue
            if info.st_size > 512 * 1024**2 or scanned + info.st_size > LIMIT_BYTES:
                raise ValueError('static byte budget')
            digest = hashlib.sha256()
            with path.open('rb') as source:
                first = source.read(16)
                digest.update(first)
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
            scanned += info.st_size
            rows.append(dict(root=str(root), path=relative, bytes=info.st_size,
                             sha256=digest.hexdigest(), elf=first.startswith(b'\x7fELF'),
                             executable=bool(info.st_mode & 0o111)))
go_cache = Path('/opt/hostedtoolcache/go')
go_versions = sorted(p.name for p in go_cache.iterdir() if p.is_dir()) if go_cache.is_dir() else []
report = dict(schema=1, available_go_version_directories=go_versions, codeql_version_directory='2.27.4', rust_version_directory='1.99.1',
              files=rows, bytes_hashed=scanned, missing_roots=missing,
              package_code_executed=False, tool_binaries_executed=False,
              installation=False, downloads=False, private_credentials_read=False,
              scope='selected preinstalled tool files only; not full vendor/source review',
              execution_approved=False)
print(json.dumps(report, separators=(',', ':')))
