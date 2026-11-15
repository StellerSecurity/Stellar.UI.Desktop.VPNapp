"""Read exact already reviewed loader bytes; never load/execute the target DLLs."""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

URL = 'https://static.crates.io/crates/webview2-com-sys/webview2-com-sys-0.39.1.crate'
SHA = 'b3a07132775117d6065853d9d1178157b8c90e228de47129d6bce2c7edebedfb'
FILES = {
    'x86': (121448, '161dc6673084a31f64670ace8e61cb0e1b55af815b6c7c8217a0cdd8503454e2'),
    'x64': (160880, '86545b66cdb0603bc26b626fb9ad610cb6e71f28d468f5ea66df23b03dda96d5'),
    'arm64': (146536, 'a0de1844933a10c898f833771a85f0ab9a0e3c745d4715f63d2d9730f9416025'),
}


def selected_members(raw):
    if len(raw) > 8 * 1024**2 or hashlib.sha256(raw).hexdigest() != SHA:
        raise ValueError('exact reviewed crate required')
    selected, seen, total = {}, set(), 0
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as archive:
        for member in archive:
            total += member.size
            if member.name in seen or len(seen) > 128 or total > 64 * 1024**2:
                raise ValueError('loader archive bounds')
            seen.add(member.name)
            for arch, (size, checksum) in FILES.items():
                if member.name != 'webview2-com-sys-0.39.1/' + arch + '/WebView2Loader.dll':
                    continue
                if not member.isfile() or member.size != size:
                    raise ValueError('exact regular loader member required')
                data = archive.extractfile(member).read(size + 1)
                if hashlib.sha256(data).hexdigest() != checksum:
                    raise ValueError('loader checksum changed')
                selected[arch] = data
    if set(selected) != set(FILES):
        raise ValueError('incomplete loader inventory')
    return selected


def main():
    if sys.platform != 'win32':
        raise ValueError('Windows trust-provider diagnostic required')
    with urllib.request.urlopen(URL, timeout=30) as response:
        raw = response.read(8 * 1024**2 + 1)
        if response.geturl() != URL:
            raise ValueError('loader archive redirect rejected')
    selected = selected_members(raw)
    with tempfile.TemporaryDirectory(prefix='stellar-loader-trust-') as folder:
        root = Path(folder)
        for arch, data in selected.items():
            (root / (arch + '.dll')).write_bytes(data)
        helper = Path(__file__).with_name('windows-webview-signature.ps1')
        command = ['C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', '-NoProfile', '-NonInteractive',
                   '-File', str(helper), '-Directory', str(root)]
        result = subprocess.run(command, check=True, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=180)
        if len(result.stdout) > 128 * 1024 or result.stderr:
            raise ValueError('loader trust diagnostic output bounds')
        report = json.loads(result.stdout.decode('utf-8-sig'))
        print(json.dumps(dict(archive_sha256=SHA, trust_diagnostic=report,
                              target_executed=False, installed=False, released=False)))


if __name__ == '__main__':
    main()
