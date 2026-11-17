"""Probe boundary tests; do not execute a compiler or GLib on this host."""
import ast
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('glib_iterator_probe', ROOT / 'scripts/linux-glib-iterator-probe.py')
PROBE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROBE)


class NativeIteratorBoundaryTests(unittest.TestCase):
    def test_slice_is_the_exact_complete_production_iterator(self):
        raw = (ROOT / 'vendor/glib-0.18.5/src/variant_iter.rs').read_bytes()
        snippet = PROBE.iterator_source(raw)
        self.assertEqual(hashlib.sha256(snippet).hexdigest(), PROBE.SNIPPET_SHA)
        self.assertIn(b'&mut p,', snippet)
        self.assertIn(b'impl<\'a> FusedIterator', snippet)

    def test_reverted_pointer_and_any_other_source_mutation_fail(self):
        raw = (ROOT / 'vendor/glib-0.18.5/src/variant_iter.rs').read_bytes()
        for changed in [raw.replace(b'&mut p,', b'&p,'), raw + b' ', b'']:
            with self.subTest(size=len(changed)), self.assertRaises(ValueError):
                PROBE.iterator_source(changed)

    def test_modified_native_file_or_symlink_is_not_executed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'input'
            path.write_bytes(b'original')
            expected = hashlib.sha256(b'original').hexdigest()
            self.assertEqual(PROBE.verified(path, expected), b'original')
            alias = Path(directory) / 'alias'
            alias.symlink_to(path)
            with self.assertRaises(ValueError):
                PROBE.verified(alias, expected)
            path.write_bytes(b'changed')
            with self.assertRaises(ValueError):
                PROBE.verified(path, expected)

    def test_probe_is_rejected_outside_ci_before_reading_inputs(self):
        with patch.dict(PROBE.os.environ, {}, clear=True):
            with self.assertRaisesRegex(ValueError, 'isolated Linux CI required'):
                PROBE.main()

    def test_plan_binds_probe_and_harness_without_clearing_release(self):
        plan = json.loads((ROOT / 'native/codeql/glib-iterator-native-plan.json').read_text())
        for key, name in [('script_sha256', 'scripts/linux-glib-iterator-probe.py'),
                          ('harness_sha256', 'native/codeql/glib-iterator-harness.rs')]:
            self.assertEqual(hashlib.sha256((ROOT / name).read_bytes()).hexdigest(), plan[key])
        self.assertEqual(len(plan['native_sha256']), 10)
        self.assertIn('CVE-2026-86469', plan['known_advisory'])

    def test_workflow_inputs_are_exact_and_secret_free(self):
        workflow = (ROOT / '.github/workflows/linux-glib-iterator-probe.yml').read_text()
        tree = ast.parse('\n'.join(line[10:] for line in workflow.split('        run: |\n', 1)[1].splitlines()))
        mapping = next(ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign)
                       and any(isinstance(target, ast.Name) and target.id == 'files' for target in node.targets))
        self.assertEqual(len(mapping), 5)
        for name, (expected, _) in mapping.items():
            self.assertEqual(hashlib.sha256((ROOT / name).read_bytes()).hexdigest(), expected)
        self.assertIn('permissions: {}', workflow)
        self.assertNotIn('uses:', workflow)
        self.assertNotIn('secrets.', workflow)


if __name__ == '__main__':
    unittest.main()
