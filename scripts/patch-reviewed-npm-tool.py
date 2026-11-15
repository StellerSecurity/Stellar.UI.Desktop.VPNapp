"""Prepare exact upstream security backports as data; never execute npm or Node."""
import hashlib
import io
import json
from pathlib import Path
import tarfile

ROOT = Path(__file__).resolve().parent
INPUTS = {
    'node_modules/glob/dist/commonjs/walker.js': '1138ced9d5429681a1740af32d13391a38184a3376d1d9d56eea64b7a43274a1',
    'node_modules/glob/dist/esm/walker.js': '3e15af549ecc74d8691982d571168fd4b0e38b494c2cbb3edcfb8f97d4036ac6',
    'node_modules/minimatch/dist/commonjs/index.js': 'd224f71f20d7c206fcc5b7e9f747324c7698345a0b2c28d717dd9cf698306783',
    'node_modules/minimatch/dist/esm/index.js': '59821ec2ce0d3df968292036e5c831ad322b33e9c33a949ecbc9dfe125d165be',
}


def replace_exact(text, old, new, count=1):
    if text.count(old) != count:
        raise ValueError('security backport anchor drift')
    return text.replace(old, new)


def patch(relative, data):
    if relative not in INPUTS or hashlib.sha256(data).hexdigest() != INPUTS[relative]:
        raise ValueError('security backport source identity drift')
    text = data.decode('utf-8')
    if '/glob/' in relative:
        text = replace_exact(text, '    onResume(fn) {\n        if (this.signal?.aborted)\n            return;\n',
                             '    onResume(fn) {\n')
        text = replace_exact(text, 'if (this.signal?.aborted)\n            cb();',
                             'if (this.signal?.aborted)\n            return cb();', 4)
    else:
        text = replace_exact(text, '    firstPhasePreProcess(globParts) {\n',
                             '    firstPhasePreProcess(globParts) {\n        const { braceExpandMax = 100_000 } = this.options;\n')
        text = replace_exact(text, "                        p2 === '..') {",
                             "                        p2 === '..' ||\n                        globParts.length >= braceExpandMax) {")
        text = replace_exact(text, '    secondPhasePreProcess(globParts) {\n',
                             '    secondPhasePreProcess(globParts) {\n        if (globParts.length > 1000) return globParts;\n')
    return text.encode('utf-8')


def main():
    reviewed = json.loads((ROOT / 'npm-11.21.2-static-result.json').read_bytes())
    raw = (ROOT / 'npm-static-review-data/npm-11.21.2.tgz').read_bytes()
    if hashlib.sha256(raw).hexdigest() != reviewed['archive_sha256']:
        raise ValueError('reviewed npm archive changed')
    rows = []
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as archive:
        for relative, expected in INPUTS.items():
            member = archive.getmember('package/' + relative)
            if not member.isfile() or member.size > 256 * 1024:
                raise ValueError('regular bounded security-backport input required')
            original = archive.extractfile(member).read()
            patched = patch(relative, original)
            rows.append(dict(path=relative, original_sha256=expected,
                             patched_sha256=hashlib.sha256(patched).hexdigest(),
                             original_bytes=len(original), patched_bytes=len(patched)))
    result = dict(schema=1, original_npm_archive_sha256=reviewed['archive_sha256'], files=rows,
                  npm_version='11.21.2', tool_fork='stellar-fixed-input-tool.1',
                  upstream_security_commits={
                      'glob': '4682e8c9babee1b385202ede36389634e12076d7',
                      'minimatch': '77a0f5c4b80bdc641c3c930a1d9edf5ad2db57f8'},
                  advisory_ids_retained=['GHSA-3g3m-2fjr-6pw4', 'GHSA-g3hv-75wg-m249'],
                  scope='Four distributed JS files only. Equivalent upstream security changes, preserving the older API. No version-based advisory suppression.',
                  source_maps_unchanged=True, patched_runtime_validation_pending=True,
                  extracted_to_disk=False, npm_executed=False, execution_approved=False,
                  release_approved=False)
    (ROOT / 'npm-11.21.2-tool-backport-static-result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(dict(files=len(rows), prepared_as_data_only=True, execution_approved=False)))


if __name__ == '__main__':
    main()
