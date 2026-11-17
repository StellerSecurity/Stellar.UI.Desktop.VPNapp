"""Match installed GLib to official Ubuntu bytes, without loading GLib/GIO."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import resource
import subprocess
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parent
NODE_ARCHIVE = '5c063e46bab0fbc1c17cc445d7ff129cbdcd0471be6ed83b6ab864f8143bc864'
NODE_NATIVE = 'd931c649850ffa7155b8ceffb400dc916ef325866e509cc52ae36e33e8fbb9a9'


def fetch(url, expected, limit):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(url, timeout=30) as response:
        if response.geturl() != url:
            raise ValueError('unexpected artifact redirect')
        raw = response.read(limit + 1)
    if len(raw) > limit or hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError('reviewed artifact identity changed')
    return raw


def limits():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_CPU, (15, 15))
    resource.setrlimit(resource.RLIMIT_FSIZE, (32 * 1024**2, 32 * 1024**2))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))


def main():
    if os.uname().sysname != 'Linux' or os.environ.get('GITHUB_ACTIONS') != 'true':
        raise ValueError('isolated Linux CI required')
    spec = importlib.util.spec_from_file_location('reviewed_debian_reader', ROOT / 'download-glib-native-review.py')
    reader = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reader)
    archive = fetch('https://nodejs.org/dist/v26.13.1/node-v26.13.1-linux-x64.tar.xz', NODE_ARCHIVE, 64 * 1024**2)
    reports = []
    with tempfile.TemporaryDirectory(prefix='stellar-glib-artifact-') as directory:
        work = Path(directory)
        executable = work / 'node'
        with tarfile.open(fileobj=io.BytesIO(archive), mode='r:xz') as tar:
            member = tar.getmember('node-v26.13.1-linux-x64/bin/node')
            if not member.isfile() or member.size != 150348872:
                raise ValueError('reviewed Node member drift')
            raw = tar.extractfile(member).read(member.size + 1)
        if hashlib.sha256(raw).hexdigest() != NODE_NATIVE:
            raise ValueError('reviewed Node native drift')
        executable.write_bytes(raw)
        executable.chmod(0o700)
        fixture = "const z=require('node:zlib');let a=[],n=0;process.stdin.on('data',b=>{n+=b.length;if(n>8*1024*1024)process.exit(3);a.push(b)});process.stdin.on('end',()=>process.stdout.write(z.zstdDecompressSync(Buffer.concat(a),{maxOutputLength:32*1024*1024})));"
        for name, (expected, size) in reader.ARTIFACTS.items():
            if not name.endswith('.deb'):
                continue
            deb = fetch('https://archive.ubuntu.com/ubuntu/pool/main/g/glib2.0/' + name, expected, size)
            members = reader.ar_members(deb)
            result = dict(name=name, sha256=expected, members={})
            for member, packed in members.items():
                if member == 'debian-binary':
                    continue
                if member.endswith('.zst'):
                    process = subprocess.run([str(executable), '--permission', '--no-addons', '--disable-sigusr1',
                                              '--max-old-space-size=128', '-e', fixture], input=packed,
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=work,
                        env=dict(PATH='/usr/bin:/bin', LANG='C.UTF-8', TZ='UTC'),
                        preexec_fn=limits, timeout=30, check=True)
                    expanded = process.stdout
                    if len(expanded) > 32 * 1024**2:
                        raise ValueError('decompression output bound')
                    tar = tarfile.open(fileobj=io.BytesIO(expanded), mode='r:')
                else:
                    tar = tarfile.open(fileobj=io.BytesIO(packed), mode='r:xz')
                inventory, seen, total = [], set(), 0
                with tar:
                    for item in tar:
                        if item.isdir():
                            continue
                        relative = item.name.removeprefix('./')
                        if relative.startswith('/') or '..' in Path(relative).parts or relative in seen or len(seen) >= 5000:
                            raise ValueError('Debian tar member path')
                        seen.add(relative)
                        if item.issym() or item.islnk():
                            inventory.append(dict(path=relative, link=item.linkname, type=item.type.decode('ascii')))
                            continue
                        if not item.isfile() or not 0 <= item.size <= 8 * 1024**2:
                            raise ValueError('Debian member type/size')
                        data = tar.extractfile(item).read(item.size + 1)
                        total += len(data)
                        if len(data) != item.size or total > 32 * 1024**2:
                            raise ValueError('Debian total size')
                        row = dict(path=relative, bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
                        if relative.endswith(('/control', '/postinst', '/postrm', '/prerm', '/preinst', '/triggers')) or relative in ('control', 'postinst', 'postrm', 'prerm', 'preinst', 'triggers'):
                            if len(data) > 32768:
                                raise ValueError('maintainer metadata bound')
                            row['maintainer_metadata'] = data.decode('utf-8')
                        installed = Path('/') / relative
                        if relative.startswith('usr/lib/x86_64-linux-gnu/libglib-2.0.so.'):
                            row['installed_identity_matches'] = installed.is_file() and hashlib.sha256(installed.read_bytes()).hexdigest() == row['sha256']
                            if not row['installed_identity_matches']:
                                raise ValueError('installed GLib differs from reviewed Ubuntu artifact')
                        inventory.append(row)
                result['members'][member] = inventory
            reports.append(result)
        rust = Path('/home/runner/.rustup/toolchains/stable-x86_64-unknown-linux-gnu')
        tool_paths = [rust / 'lib/rustlib/x86_64-unknown-linux-gnu/bin/rust-lld',
                      Path('/usr/lib/gcc/x86_64-linux-gnu/13/collect2'), Path('/usr/lib/gcc/x86_64-linux-gnu/13/liblto_plugin.so')]
        tool_paths.extend(Path('/usr/lib/x86_64-linux-gnu') / name for name in
                          ('Scrt1.o', 'crti.o', 'crtn.o', 'libc.so', 'libc.so.6', 'libgcc_s.so.1', 'libpcre2-8.so.0', 'libm.so.6'))
        tools = []
        for path in tool_paths:
            if not path.exists():
                tools.append(dict(path=str(path), present=False))
                continue
            resolved = path.resolve(strict=True)
            if not resolved.is_file() or resolved.stat().st_size > 256 * 1024**2:
                raise ValueError('native linker inventory bound')
            data = resolved.read_bytes()
            tools.append(dict(path=str(path), resolved=str(resolved), present=True, bytes=len(data), sha256=hashlib.sha256(data).hexdigest(), elf=data.startswith(b'\x7fELF')))
            if len(data) <= 4096:
                tools[-1]['static_bytes_hex'] = data.hex()
        print(json.dumps(dict(artifacts=reports, linker_inventory=tools,
            node_purpose='Only hash-pinned built-in zstd decompression under Node permission restrictions.',
            glib_loaded=False, gio_loaded=False, maintainer_scripts_executed=False, installed=False,
            known_advisory='CVE-2026-86469 remains open; no GLib/GIO release clearance.', release_approved=False)))


if __name__ == '__main__':
    main()
