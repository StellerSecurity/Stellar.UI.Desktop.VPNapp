"""Copy an independently reproduced six-target bundle without executing it."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tempfile

ROOT = Path(__file__).resolve().parents[1]

def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('duplicate runtime manifest key')
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs)

def verified_bundle(source):
    source = Path(source)
    if source.is_symlink() or not source.is_dir() or source.resolve() != source:
        raise ValueError('absolute regular runtime directory required')
    review = strict_json((ROOT / 'vendor/esbuild-reviewed/binary-review.json').read_bytes())
    manifest_path = source / 'runtime-manifest.json'
    if manifest_path.is_symlink() or not manifest_path.is_file() or manifest_path.stat().st_size > 16384:
        raise ValueError('regular bounded runtime manifest required')
    manifest = strict_json(manifest_path.read_bytes())
    if (set(manifest) != {'schema', 'targets', 'source_built', 'independently_reproduced', 'published', 'release_approved'}
            or type(manifest['schema']) is not int or manifest['schema'] != 1
            or any(manifest[k] is not True for k in ('source_built', 'independently_reproduced'))
            or any(manifest[k] is not False for k in ('published', 'release_approved'))):
        raise ValueError('independently reproduced unpublished runtime bundle required')
    mapped = {key.replace('win32-', 'windows-').replace('-x64', '-amd64').replace('-', '/', 1): value
              for key, value in review['targets'].items()}
    if not isinstance(manifest['targets'], dict) or set(manifest['targets']) != set(mapped):
        raise ValueError('exact six-target runtime manifest required')
    payload = {'runtime-manifest.json': manifest_path.read_bytes()}
    for target, expected in mapped.items():
        filename = 'esbuild-' + target.replace('/', '-') + ('.exe' if target.startswith('windows/') else '')
        row = manifest['targets'][target]
        if (not isinstance(row, dict) or set(row) != {'filename', 'bytes', 'sha256'}
                or row['filename'] != filename or type(row['bytes']) is not int
                or row['bytes'] != expected['bytes'] or row['sha256'] != expected['sha256']):
            raise ValueError('runtime target metadata drift')
        item = source / filename
        if item.is_symlink() or not item.is_file() or item.stat().st_size != expected['bytes']:
            raise ValueError('regular exact runtime file required')
        raw = item.read_bytes()
        if len(raw) != expected['bytes'] or hashlib.sha256(raw).hexdigest() != expected['sha256']:
            raise ValueError('runtime content drift')
        payload[filename] = raw
    legal = {'LICENSE-Go': '911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad',
             'LICENSE-esbuild': 'b40ec5baec7bb34fa5b1c09521fa3cd52d5fad7adafed74932a2010d3612a681',
             'LICENSE-x-sys': '911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad'}
    for name, expected in legal.items():
        item = source / name
        if item.is_symlink() or not item.is_file() or item.stat().st_size > 16384:
            raise ValueError('exact runtime license required')
        raw = item.read_bytes()
        if hashlib.sha256(raw).hexdigest() != expected:
            raise ValueError('runtime license drift')
        payload[name] = raw
    if {item.name for item in source.iterdir()} != set(payload):
        raise ValueError('unexpected runtime bundle member')
    return payload

def provision(source, destination):
    payload = verified_bundle(source)
    destination = Path(destination)
    if (not destination.is_absolute() or destination.exists() or destination.is_symlink()
            or not destination.parent.is_dir() or destination.parent.resolve() != destination.parent):
        raise ValueError('fresh absolute owned destination required')
    with tempfile.TemporaryDirectory(prefix='.esbuild-verified-', dir=destination.parent) as folder:
        stage = Path(folder) / 'bundle'
        stage.mkdir(mode=0o700)
        for name, raw in payload.items():
            target = stage / name
            with target.open('xb') as stream:
                stream.write(raw)
            target.chmod(0o500 if name.startswith('esbuild-') else 0o400)
        verified_bundle(stage.resolve())
        # Never replace an existing user build directory, even if created while
        # verification was in progress. Copying never executes any target.
        shutil.copytree(stage, destination)
    return dict(files=len(payload), targets=6, executed=False, published=False)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--destination', type=Path, default=ROOT / '.stellar-build-tools' / 'esbuild')
    args = parser.parse_args()
    if args.destination == ROOT / '.stellar-build-tools' / 'esbuild' and not args.destination.parent.exists():
        verified_bundle(args.source)
        args.destination.parent.mkdir(mode=0o700)
    print(json.dumps(provision(args.source, args.destination)))

if __name__ == '__main__':
    main()
