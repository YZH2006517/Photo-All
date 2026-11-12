"""Release gates for licensed open-filter assets, without staging the full runtime."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('package_windows', ROOT / 'product/package_windows.py')
package_windows = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package_windows)


class SpectralCompactionTests(unittest.TestCase):
    def test_compaction_preserves_math_assets_and_metadata(self):
        self.assertTrue(hasattr(package_windows,'compact_spectral_runtime'), 'Missing curated runtime compaction')
        with tempfile.TemporaryDirectory(dir=ROOT/'validation') as folder:
            root = Path(folder)
            files = {
                'Lib/json/__init__.py': b'VALUE=3',
                'Lib/site-packages/numba/core.py': b'keep',
                'Lib/site-packages/numba/support.c': b'build-only',
                'Lib/site-packages/numpy/types.pyi': b'typing-only',
                'Lib/site-packages/matplotlib/mpl-data/matplotlibrc': b'keep',
                'Lib/site-packages/matplotlib/mpl-data/fonts/ttf/example.ttf': b'plot-only'*100,
                'Lib/site-packages/fontTools/ttLib/__init__.py': b'plot-only',
                'Lib/site-packages/fonttools-1.dist-info/licenses/LICENSE': b'keep license',
                'Lib/site-packages/spektrafilm/data/profile.npy': b'keep science',
            }
            for name, data in files.items():
                target=root/name; target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
            result = package_windows.compact_spectral_runtime(root)
            with zipfile.ZipFile(root/'python313.zip') as archive:
                self.assertEqual(archive.read('json/__init__.py'),b'VALUE=3')
            for name in files:
                if 'keep' in files[name].decode() and 'Lib/json/' not in name:
                    self.assertTrue((root/name).is_file(),name)
            self.assertFalse((root/'Lib/site-packages/fontTools').exists())
            self.assertFalse((root/'Lib/site-packages/numba/support.c').exists())
            self.assertGreater(result['removed_bytes'],0)


class OpenFilterPackagingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=ROOT / 'validation')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.assets = self.root / 'engines/open-filters'
        self.assets.mkdir(parents=True)
        self.downloads = self.root / 'downloads'
        archive = self.downloads / 'open-filters/RawTherapee-HaldCLUT.zip'
        archive.parent.mkdir(parents=True)
        with zipfile.ZipFile(archive, 'w') as bundle:
            bundle.writestr('HaldCLUT/README.txt', 'Original attribution')
            bundle.writestr('HaldCLUT/example.png', b'original-lookup-samples')
        lut = b'converted-float32-table'
        (self.assets / 'example.npy').write_bytes(lut)
        self.manifest = {'revision': 'pinned test revision',
                         'archive_url': 'https://example.test/HaldCLUT.zip',
                         'archive_sha256': package_windows.sha256(archive),
                         'items': {'example': {'sha256': hashlib.sha256(lut).hexdigest()}}}
        data = json.dumps(self.manifest)
        (self.root / 'open-filters-manifest.json').write_text(data, encoding='utf-8')
        (self.assets / 'manifest.json').write_text(data, encoding='utf-8')
        for name in ['UPSTREAM-README.txt', 'LICENSE-CC-BY-SA-4.0.txt', 'CHANGES.txt']:
            (self.assets / name).write_text(name, encoding='utf-8')
        (self.root / 'open_filters.py').write_text('# conversion implementation', encoding='utf-8')
        (self.root / 'LICENSE').write_text('GPL-3.0-or-later license text', encoding='utf-8')

    def test_valid_assets_are_required_for_the_release(self):
        package_windows.verify_open_filters(self.root)
        (self.assets / 'example.npy').write_bytes(b'different-table')
        with self.assertRaisesRegex(RuntimeError, 'example'):
            package_windows.verify_open_filters(self.root)

    def test_missing_attribution_and_stale_catalog_are_rejected(self):
        (self.assets / 'CHANGES.txt').unlink()
        with self.assertRaisesRegex(RuntimeError, 'CHANGES'):
            package_windows.verify_open_filters(self.root)
        (self.assets / 'CHANGES.txt').write_text('adaptation notice', encoding='utf-8')
        (self.assets / 'manifest.json').write_text('{}', encoding='utf-8')
        with self.assertRaisesRegex(RuntimeError, 'manifest'):
            package_windows.verify_open_filters(self.root)

    def test_original_archive_is_preserved_in_separate_source_bundle(self):
        with patch.object(package_windows, 'ROOT', self.root), patch.object(package_windows, 'DOWNLOADS', self.downloads):
            result = package_windows.open_filter_sources()
        with zipfile.ZipFile(result) as bundle:
            self.assertEqual(bundle.read('open-filters-manifest.json'), (self.root / 'open-filters-manifest.json').read_bytes())
            original = bundle.read('RawTherapee-HaldCLUT.zip')
            self.assertEqual(hashlib.sha256(original).hexdigest(), self.manifest['archive_sha256'])
            self.assertIn('LICENSE-CC-BY-SA-4.0.txt', bundle.namelist())
            self.assertIn('open_filters.py', bundle.namelist())
            self.assertIn('LICENSE', bundle.namelist())
        archive = self.downloads / 'open-filters/RawTherapee-HaldCLUT.zip'
        archive.write_bytes(b'upstream content changed')
        with patch.object(package_windows, 'ROOT', self.root), patch.object(package_windows, 'DOWNLOADS', self.downloads):
            with self.assertRaisesRegex(RuntimeError, 'checksum'):
                package_windows.open_filter_sources()


if __name__ == '__main__':
    unittest.main()
