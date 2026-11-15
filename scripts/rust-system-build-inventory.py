"""Read public installed build-package metadata and tool bytes; execute none."""
import hashlib
import json
from pathlib import Path

PACKAGES = {
    'gcc', 'gcc-13', 'g++', 'g++-13', 'binutils', 'binutils-x86-64-linux-gnu',
    'libc6-dev', 'libgcc-13-dev', 'libstdc++-13-dev', 'pkgconf', 'pkg-config',
    'libpkgconf3', 'make', 'cmake', 'ninja-build', 'libgtk-3-dev',
    'libwebkit2gtk-4.1-dev', 'libsoup-3.0-dev', 'libdbus-1-dev',
    'libjavascriptcoregtk-4.1-dev', 'libgdk-pixbuf-2.0-dev', 'libglib2.0-dev',
    'libcairo2-dev', 'libpango1.0-dev', 'libayatana-appindicator3-dev', 'libxdo-dev',
}
FIELDS = {'Package', 'Version', 'Architecture', 'Status', 'Source', 'Maintainer', 'Homepage'}
status = Path('/var/lib/dpkg/status')
if status.stat().st_size > 16 * 1024**2:
    raise ValueError('system package metadata budget')
packages = []
for block in status.read_text().split('\n\n'):
    row = {}
    for line in block.splitlines():
        key, sep, value = line.partition(': ')
        if sep and key in FIELDS:
            row[key] = value
    if row.get('Package') in PACKAGES:
        packages.append(row)
tools = []
for name in ('cc', 'c++', 'gcc', 'g++', 'ld', 'as', 'pkg-config', 'pkgconf', 'make', 'cmake', 'ninja'):
    path = Path('/usr/bin') / name
    if not path.exists():
        continue
    resolved = path.resolve()
    if not resolved.is_file() or resolved.stat().st_size > 64 * 1024**2:
        raise ValueError('system tool byte/type budget')
    tools.append(dict(path=str(path), resolved=str(resolved), bytes=resolved.stat().st_size,
                      sha256=hashlib.sha256(resolved.read_bytes()).hexdigest()))
pc_files = []
for folder in ('/usr/lib/x86_64-linux-gnu/pkgconfig', '/usr/share/pkgconfig'):
    for name in ('gtk+-3.0.pc', 'webkit2gtk-4.1.pc', 'libsoup-3.0.pc', 'dbus-1.pc', 'javascriptcoregtk-4.1.pc', 'glib-2.0.pc'):
        path = Path(folder) / name
        if path.is_file() and not path.is_symlink():
            raw = path.read_bytes()
            if len(raw) > 32768:
                raise ValueError('build metadata file budget')
            pc_files.append(dict(path=str(path), sha256=hashlib.sha256(raw).hexdigest(), text=raw.decode()))
print(json.dumps(dict(packages=packages, tools=tools, pc_files=pc_files,
                      installed=False, tool_or_package_executed=False,
                      private_credentials_read=False, execution_approval=False), separators=(',', ':')))
