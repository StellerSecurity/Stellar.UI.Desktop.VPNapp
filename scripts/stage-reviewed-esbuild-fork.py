"""Reconstruct the reviewed source-only esbuild candidate; never run its API."""
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import tarfile

ARCHIVE_SHA = 'eb8ef756f8299d16d5c8b35678606d715ba29923f500db7b37c181310eed40a5'
EXPECTED = {
    'LICENSE': 'b40ec5baec7bb34fa5b1c09521fa3cd52d5fad7adafed74932a2010d3612a681',
    'binary-review.json': '6e3b77348fd273ec25b783187fc4d0c92ce2392eb334a0f95b4bbff0fd615f93',
    'stellar-patch.json': '67c0da9a3f17b0a5bfae58918a04264db0ba167e8ff8786fab177aa10f5a240c',
    'package.json': 'e5fc4c4c3e6ec0f59df33a2187fcfc43042685e5224903356208fac4d9be1711',
    'lib/main.d.ts': '161c8e0690c46021506e32fda85956d785b70f309ae97011fd27374c065cac9b',
    'lib/main.js': '6e139ce946f944cc1915b1560b355b877cad093f0a139be07178b85d78854c65',
    'lib/reviewed-binary.cjs': 'f5c8a3aa6b92772a5d1d21eebf2e5796fc27571c12df252e12bd751cb5238ce7',
}
REPLACEMENT = b'''// lib/npm/node-platform.ts \xe2\x80\x94 reviewed local binary only
var ESBUILD_BINARY_PATH = process.env.ESBUILD_BINARY_PATH;
function generateBinPath() {
  return { binPath: require("./reviewed-binary.cjs")(), isWASM: false };
}

'''


def stage(archive_bytes, assets, destination):
    if len(archive_bytes) > 4 * 1024**2 or hashlib.sha256(archive_bytes).hexdigest() != ARCHIVE_SHA:
        raise ValueError('reviewed upstream JS archive identity mismatch')
    destination = Path(destination)
    if destination.exists() or destination.is_symlink():
        raise ValueError('fresh source-fork destination required')
    upstream = {}
    with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode='r:gz') as archive:
        total = 0
        for member in archive:
            path = PurePosixPath(member.name)
            if (not member.isfile() or path.is_absolute() or '..' in path.parts or '\\' in member.name
                    or member.name in upstream or not 0 <= member.size <= 4 * 1024**2):
                raise ValueError('uncontained upstream source member')
            total += member.size
            if total > 8 * 1024**2 or len(upstream) >= 100:
                raise ValueError('upstream source inventory bounds')
            raw = archive.extractfile(member).read(4 * 1024**2 + 1)
            if len(raw) != member.size:
                raise ValueError('upstream source framing')
            upstream[member.name] = raw
    original = upstream['package/lib/main.js']
    start, end = b'// lib/npm/node-platform.ts\n', b'// lib/npm/node.ts\n'
    if original.count(start) != 1:
        raise ValueError('upstream binary-discovery section ambiguity')
    prefix, section = original.split(start)
    if section.count(end) != 1:
        raise ValueError('upstream binary-discovery end ambiguity')
    _, suffix = section.split(end)
    result = {
        'lib/main.js': prefix + REPLACEMENT + end + suffix,
        'lib/main.d.ts': upstream['package/lib/main.d.ts'],
        'LICENSE': upstream['package/LICENSE.md'],
    }
    for relative, asset in (
        ('package.json', 'package-template.json'),
        ('binary-review.json', 'binary-review.json'),
        ('stellar-patch.json', 'stellar-patch.json'),
        ('lib/reviewed-binary.cjs', 'reviewed-esbuild-binary.cjs'),
    ):
        path = Path(assets) / asset
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 256 * 1024:
            raise ValueError('regular reviewed first-party asset required')
        result[relative] = path.read_bytes()
    manifest = json.loads(result['package.json'])
    if ((manifest.get('name'), manifest.get('version')) != ('esbuild', '0.28.1-stellar.1')
            or not manifest.get('private') or any(key in manifest for key in ('scripts', 'bin', 'dependencies', 'optionalDependencies'))):
        raise ValueError('source fork execution or dependency metadata changed')
    if set(result) != set(EXPECTED) or any(hashlib.sha256(value).hexdigest() != EXPECTED[name] for name, value in result.items()):
        raise ValueError('reviewed source fork bytes drift')
    destination.mkdir(parents=True)
    for name, raw in result.items():
        path = destination / name
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('xb') as stream:
            stream.write(raw)
    return dict(files_sha256=dict(EXPECTED), upstream_archive_sha256=ARCHIVE_SHA,
                npm_advisory_identity=['npm', 'esbuild', '0.28.1'],
                native_advisory_identities=[['Go', 'stdlib', '1.26.11'], ['Go', 'golang.org/x/sys', '0.44.0']],
                native_binaries_in_package=0, lifecycle_scripts=0, target_executed=False,
                scanner_integration_complete=False, release_approved=False)
