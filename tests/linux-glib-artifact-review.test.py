"""Offline checks for Debian framing and the isolated review boundary."""
import ast
import hashlib
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def ar(entries):
    raw = bytearray(b'!<arch>\n')
    for name, data in entries:
        raw.extend((name + '/').ljust(16).encode() + b'0'.ljust(12) + b'0'.ljust(6) + b'0'.ljust(6)
                   + b'100644'.ljust(8) + str(len(data)).ljust(10).encode() + b'`\n' + data)
        if len(data) % 2:
            raw.extend(b'\n')
    return bytes(raw)


class GlibArtifactReviewTests(unittest.TestCase):
    def setUp(self):
        self.reader = load('glib_debian_reader', 'download-glib-native-review.py')

    def test_exact_debian_envelope_is_read_as_data(self):
        data = ar([('debian-binary', b'2.0\n'), ('control.tar.zst', b'fixture'), ('data.tar.zst', b'data')])
        result = self.reader.ar_members(data)
        self.assertEqual(result['control.tar.zst'], b'fixture')

    def test_unknown_or_duplicate_members_are_rejected(self):
        for entries in [[('debian-binary', b'2.0\n'), ('script.sh', b'echo unsafe')],
                        [('debian-binary', b'2.0\n'), ('debian-binary', b'2.0\n')]]:
            with self.subTest(entries=entries), self.assertRaises(ValueError):
                self.reader.ar_members(ar(entries))

    def test_truncated_headers_members_or_padding_are_rejected(self):
        complete = ar([('debian-binary', b'2.0\n'), ('data.tar.zst', b'odd')])
        for offset in [1, 10, len(complete) - 1, len(complete) - 3]:
            with self.subTest(offset=offset), self.assertRaises(ValueError):
                self.reader.ar_members(complete[:offset])

    def test_wrong_debian_version_is_rejected(self):
        with self.assertRaises(ValueError):
            self.reader.ar_members(ar([('debian-binary', b'3.0\n')]))

    def test_native_review_does_not_run_outside_ci(self):
        module = load('glib_native_review', 'linux-glib-artifact-review.py')
        with patch.dict(module.os.environ, {}, clear=True), patch.object(module, 'fetch', side_effect=AssertionError('network')):
            with self.assertRaisesRegex(ValueError, 'isolated Linux CI required'):
                module.main()

    def test_ci_workflow_source_pins_match(self):
        source = (ROOT / '.github/workflows/linux-glib-artifact-review.yml').read_text()
        code = '\n'.join(line[10:] for line in source.split('        run: |\n', 1)[1].splitlines())
        tree = ast.parse(code)
        files = next(ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign)
                     and any(isinstance(target, ast.Name) and target.id == 'files' for target in node.targets))
        self.assertEqual(len(files), 2)
        for name, expected in files.items():
            self.assertEqual(hashlib.sha256((ROOT / name).read_bytes()).hexdigest(), expected)
        self.assertIn('permissions: {}', source)
        self.assertNotIn('uses:', source)


if __name__ == '__main__':
    unittest.main()
