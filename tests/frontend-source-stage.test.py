"""Only contained, bounded, reviewed frontend sources may enter the test view."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import re
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('frontend_probe', ROOT / 'scripts/probe-reviewed-frontend.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def archive(name, raw=b'owned fixture', link=None):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w:gz') as output:
        item = tarfile.TarInfo(name)
        if link is not None:
            item.type, item.linkname = tarfile.SYMTYPE, link
        else:
            item.size = len(raw)
        output.addfile(item, None if link is not None else io.BytesIO(raw))
    return stream.getvalue()


class StageTests(unittest.TestCase):
    def test_firstparty_relative_imports_have_frozen_inputs(self):
        plan = json.loads((ROOT / 'native/codeql/frontend-build-plan.json').read_text())
        names = set(plan['application_files'])
        for name in sorted(names):
            if not name.endswith(('.ts', '.tsx')):
                continue
            source = (ROOT / name).read_text()
            for imported in re.findall(r'(?:from\s*|import\s*)[\'\"](\.[^\'\"]+)[\'\"]', source):
                target = ((ROOT / name).parent / imported.split('?', 1)[0]).resolve().relative_to(ROOT).as_posix()
                candidates = {target, target + '.ts', target + '.tsx', target + '/index.ts', target + '/index.tsx'}
                self.assertTrue(candidates & names, name + ': ' + imported)

    def test_exact_regular_file_and_input_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = probe.stage(archive('package/lib/index.js'), root, 'package')
            self.assertEqual(result, {str(root / 'lib/index.js'): hashlib.sha256(b'owned fixture').hexdigest()})

    def test_types_registry_prefix_is_explicit(self):
        with tempfile.TemporaryDirectory() as directory:
            result = probe.stage(archive('react/index.d.ts'), Path(directory), 'react')
            self.assertEqual(len(result), 1)

    def test_traversal_absolute_wrong_prefix_and_links_rejected(self):
        for name, link in [('package/../../outside', None), ('/package/a', None),
                           ('other/a', None), ('package/link', '/outside')]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                with self.assertRaisesRegex(ValueError, 'uncontained'):
                    probe.stage(archive(name, link=link), Path(directory), 'package')

    def test_no_existing_member_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            probe.stage(archive('package/a'), root, 'package')
            with self.assertRaises(FileExistsError):
                probe.stage(archive('package/a', b'changed'), root, 'package')
            self.assertEqual((root / 'a').read_bytes(), b'owned fixture')


if __name__ == '__main__':
    unittest.main()
