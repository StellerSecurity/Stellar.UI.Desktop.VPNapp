"""Read installed Linux GLib/test-tool metadata; execute no inventoried tool."""
import hashlib
import json
from pathlib import Path
import time


def main():
    status = Path('/var/lib/dpkg/status')
    if not status.is_file() or status.stat().st_size > 16 * 1024**2:
        raise ValueError('bounded Debian package metadata required')
    packages = []
    prefixes = ('gcc', 'g++', 'binutils', 'pkgconf', 'pkg-config', 'libglib2.0',
                'libgtk-3', 'libwebkit2gtk-4.1', 'libjavascriptcoregtk-4.1')
    for record in status.read_text().split('\n\n'):
        fields = {}
        for line in record.splitlines():
            if line and not line[0].isspace() and ': ' in line:
                key, value = line.split(': ', 1)
                fields[key] = value
        name = fields.get('Package', '')
        if name.startswith(prefixes):
            packages.append({key: fields.get(key) for key in
                             ('Package', 'Version', 'Architecture', 'Status', 'Source', 'Maintainer')})
    candidates = [Path('/usr/bin') / name for name in ('cc', 'gcc', 'g++', 'ld', 'ar', 'pkg-config', 'pkgconf')]
    library = Path('/usr/lib/x86_64-linux-gnu')
    candidates.extend(library / name for name in ('libglib-2.0.so.0', 'libgobject-2.0.so.0',
                       'libgio-2.0.so.0', 'libgtk-3.so.0', 'libwebkit2gtk-4.1.so.0',
                       'libjavascriptcoregtk-4.1.so.0'))
    candidates.extend(library / 'pkgconfig' / name for name in
                      ('glib-2.0.pc', 'gobject-2.0.pc', 'gio-2.0.pc', 'gtk+-3.0.pc', 'webkit2gtk-4.1.pc'))
    rows, total = [], 0
    started = time.monotonic()
    for path in candidates:
        if not path.exists():
            rows.append(dict(path=str(path), present=False))
            continue
        target = path.resolve(strict=True)
        if (not target.is_file() or not any(target.is_relative_to(base) for base in
                (Path('/usr/bin'), Path('/usr/lib'), Path('/lib')))
                or target.stat().st_size > 128 * 1024**2 or time.monotonic() - started > 60):
            raise ValueError('native static input path/size/time bound')
        raw = target.read_bytes()
        total += len(raw)
        if total > 256 * 1024**2:
            raise ValueError('native static aggregate size bound')
        row = dict(path=str(path), resolved=str(target), present=True, bytes=len(raw),
                   sha256=hashlib.sha256(raw).hexdigest(), elf=raw.startswith(b'\x7fELF'))
        if path.suffix == '.pc':
            if len(raw) > 16384:
                raise ValueError('pkg-config metadata bound')
            row['public_package_metadata'] = raw.decode('utf-8')
        rows.append(row)
    print(json.dumps(dict(packages=packages, files=rows, target_tools_executed=False,
                          installed_or_downloaded=False, native_execution_approved=False,
                          release_approved=False)))


if __name__ == '__main__':
    main()
