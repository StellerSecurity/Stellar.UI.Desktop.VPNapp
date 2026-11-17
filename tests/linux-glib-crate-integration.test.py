"""Offline integration boundary tests; no package code or compiler execution."""
import ast
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('glib_crate_probe', ROOT / 'scripts/linux-glib-crate-integration.py')
PROBE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROBE)


def archive(path='sample-1.0.0/src/lib.rs', symbolic=False):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as tar:
        member = tarfile.TarInfo(path)
        if symbolic:
            member.type, member.linkname = tarfile.SYMTYPE, '/etc/passwd'
            tar.addfile(member)
        else:
            data = b'// synthetic source\n'
            member.size = len(data)
            tar.addfile(member, io.BytesIO(data))
    return buffer.getvalue()


class CrateIntegrationBoundaryTests(unittest.TestCase):
    def test_archive_and_member_hashes_bind_every_staged_file(self):
        raw = archive()
        row = dict(name='sample', version='1.0.0', checksum=hashlib.sha256(raw).hexdigest(), archive_bytes=len(raw))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'source'
            files = PROBE.stage_archive(raw, row, root)
            for name, expected in files.items():
                self.assertEqual(hashlib.sha256((root / name).read_bytes()).hexdigest(), expected)
            manifest = json.loads((root / '.cargo-checksum.json').read_text())
            self.assertEqual(manifest['package'], row['checksum'])

    def test_modified_archive_fails_before_materialization(self):
        raw = archive()
        row = dict(name='sample', version='1.0.0', checksum=hashlib.sha256(raw).hexdigest(), archive_bytes=len(raw))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'source'
            with self.assertRaises(ValueError):
                PROBE.stage_archive(raw + b'changed', row, root)
            self.assertFalse(root.exists())

    def test_escaping_and_link_members_remain_rejected(self):
        for path, symbolic in [('sample-1.0.0/../outside', False), ('sample-1.0.0/link', True)]:
            raw = archive(path, symbolic)
            row = dict(name='sample', version='1.0.0', checksum=hashlib.sha256(raw).hexdigest(), archive_bytes=len(raw))
            with self.subTest(path=path), tempfile.TemporaryDirectory() as directory, self.assertRaises(ValueError):
                PROBE.stage_archive(raw, row, Path(directory) / 'source')

    def test_unreviewed_lock_entry_or_checksum_is_rejected(self):
        plan = dict(registry_packages=[dict(name='sample', version='1.0.0', checksum='a' * 64)])
        base = 'version=4\n[[package]]\nname="glib"\nversion="0.18.5"\n'
        entry = '[[package]]\nname="sample"\nversion="1.0.0"\nsource="registry+https://github.com/rust-lang/crates.io-index"\nchecksum="' + 'a' * 64 + '"\n'
        self.assertIn(('sample', '1.0.0'), PROBE.validate_lock((base + entry).encode(), plan))
        for changed in [entry.replace('sample', 'unknown'), entry.replace('a' * 64, 'b' * 64), entry.replace('registry+https://', 'git+https://')]:
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                PROBE.validate_lock((base + changed).encode(), plan)

    def test_execution_is_rejected_outside_isolated_ci(self):
        with patch.dict(PROBE.os.environ, {}, clear=True), self.assertRaisesRegex(ValueError, 'isolated Linux CI required'):
            PROBE.main()

    def test_workflow_binds_all_inputs_and_keeps_zero_permissions(self):
        workflow = (ROOT / '.github/workflows/linux-glib-crate-integration.yml').read_text()
        tree = ast.parse('\n'.join(line[10:] for line in workflow.split('        run: |\n', 1)[1].splitlines()))
        files = next(ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign)
                     and any(isinstance(target, ast.Name) and target.id == 'files' for target in node.targets))
        self.assertEqual(len(files), 6)
        for name, (expected, _) in files.items():
            self.assertEqual(hashlib.sha256((ROOT / name).read_bytes()).hexdigest(), expected)
        self.assertIn('permissions: {}', workflow)
        self.assertNotIn('uses:', workflow)
        self.assertNotIn('secrets.', workflow)


if __name__ == '__main__':
    unittest.main()
