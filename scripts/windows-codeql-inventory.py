"""Static Windows CodeQL/JDK inventory. No SDK, application or signing executes."""
import hashlib
import json
import os
from pathlib import Path
import time

roots = [Path('C:/hostedtoolcache/windows/CodeQL/2.27.4/x64/codeql')]
java_base = Path('C:/hostedtoolcache/windows/Java_Temurin-Hotspot_jdk')
if java_base.is_dir():
    roots.extend(sorted(java_base.glob('25.0.5*/x64')))
adoptium = Path('C:/Program Files/Eclipse Adoptium')
if adoptium.is_dir():
    roots.extend(sorted(adoptium.glob('jdk-25.0.5*')))
rows, metadata, missing, total = [], {}, [], 0
started = time.monotonic()
for root in roots:
    if not root.is_dir() or root.is_symlink():
        missing.append(str(root))
        continue
    for folder, dirs, names in os.walk(root, followlinks=False):
        dirs[:] = sorted(name for name in dirs if not (Path(folder) / name).is_symlink())
        for name in sorted(names):
            path = Path(folder) / name
            if path.is_symlink() or not path.is_file():
                continue
            relative = path.relative_to(root).as_posix()
            if 'CodeQL' in str(root):
                selected = (relative in ('codeql.cmd', 'codeql.exe')
                            or relative.startswith(('rust/', 'tools/win64/', 'tools/codeql')))
                # The older bundled Java is not a proposed execution runtime.
                selected = selected and not relative.startswith('tools/win64/java/')
            else:
                selected = (relative == 'release' or relative.startswith(('bin/', 'lib/', 'conf/')))
                selected = selected and 'cacerts' not in relative and not relative.endswith(('.p12', '.jks'))
            if not selected:
                continue
            size = path.stat().st_size
            if size > 512 * 1024**2 or total + size > 2 * 1024**3 or len(rows) >= 6000 or time.monotonic() - started > 150:
                raise ValueError('Windows SDK static inventory budget')
            raw = path.read_bytes()
            total += len(raw)
            rows.append(dict(root=str(root), path=relative, bytes=len(raw),
                             sha256=hashlib.sha256(raw).hexdigest(), pe=raw.startswith(b'MZ')))
            if relative in ('codeql.cmd', 'release', 'rust/codeql-extractor.yml') and len(raw) < 65536:
                metadata[str(root / relative)] = raw.decode(errors='replace')
print(json.dumps(dict(roots=[str(x) for x in roots], missing=missing,
                      files=rows, public_metadata=metadata, bytes_hashed=total,
                      sdk_or_target_executed=False, installation=False,
                      signing=False, private_credentials_read=False), separators=(',', ':')))
