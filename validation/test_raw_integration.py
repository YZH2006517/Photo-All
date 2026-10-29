"""Opt-in integration: requires official engine and CC0 samples in validation/inputs."""
from pathlib import Path
import hashlib
import json
import sys
import time
import unittest

from PIL import Image, ImageStat

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent / 'product'))
import engine


class RawIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not engine.raw_executable():
            raise unittest.SkipTest('RawTherapee is not installed')
        cls.samples = [ROOT / 'inputs' / name for name in ('D7000.NEF', 'EOS_5D_Mark_II.CR2')]
        if not all(path.is_file() for path in cls.samples):
            raise unittest.SkipTest('Verified CC0 RAW fixtures are not installed')
        cls.output = ROOT / 'artifacts' / ('raw-' + time.strftime('%Y%m%d-%H%M%S'))
        cls.output.mkdir(parents=True)
        engine.RAW_CACHE = cls.output / 'cache'
        cls.hashes = {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in cls.samples}
        cls.results = []

    @classmethod
    def tearDownClass(cls):
        for path, digest in cls.hashes.items():
            assert hashlib.sha256(path.read_bytes()).hexdigest() == digest, 'Original RAW was modified'
        (cls.output / 'report.json').write_text(json.dumps(cls.results, indent=2), encoding='utf-8')

    def test_two_camera_preview_and_exposure(self):
        for path in self.samples:
            start = time.monotonic()
            base = engine.render_image(path, {}, (900, 700))
            bright = engine.render_image(path, {'raw_exposure': 1}, (900, 700))
            self.assertLessEqual(base.width, 900)
            self.assertLessEqual(base.height, 700)
            self.assertGreater(ImageStat.Stat(bright).mean[0], ImageStat.Stat(base).mean[0])
            base.save(self.output / (path.stem + '-preview.jpg'))
            self.results.append({'camera': path.name, 'preview': base.size,
                                 'exposure_changes_pixels': True, 'seconds': round(time.monotonic() - start, 2)})

    def test_native_export_preserves_16bit_and_original(self):
        path = self.samples[0]
        output = engine.export_raw_tiff({'path': str(path), 'recipe': {'raw_wb': 'custom', 'raw_temperature': 5000,
                                        'raw_denoise': 15, 'raw_sharpen': 50}}, self.output)
        with Image.open(output) as image:
            self.assertEqual(tuple(image.tag_v2[258]), (16, 16, 16))
            self.assertGreater(image.width, 4000)
            self.assertTrue(image.info.get('icc_profile'))
            self.results.append({'file': output.name, 'bits_per_sample': list(image.tag_v2[258]), 'size': image.size})
        self.assertTrue(output.with_suffix('.pp3').is_file())
        self.assertFalse(path.with_suffix(path.suffix + '.pp3').exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
