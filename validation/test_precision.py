"""Precision contracts: source samples survive decoding, grading and lossless export."""
from io import BytesIO
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image, ImageCms

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'product'))
sys.path.insert(0, str(ROOT / 'product/engines/precision-packages'))
import png
import tifffile


class PrecisionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT / 'validation')
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        ramp = np.arange(4096, dtype=np.uint16) * 16
        self.samples = np.stack([ramp, np.roll(ramp, 113), 65535-ramp], axis=-1)[None]

    def pixels(self):
        import pixels
        return pixels

    def png_source(self, array):
        path = self.folder / 'source.png'
        with path.open('wb') as stream:
            png.Writer(array.shape[1], array.shape[0], greyscale=False,
                       alpha=array.shape[2] == 4, bitdepth=16).write(
                           stream, (row.reshape(-1) for row in array))
        return path

    def test_rgb16_png_noop_exact(self):
        p = self.pixels()
        source = self.png_source(self.samples)
        output = BytesIO()
        p.write(output, p.render(source, {}), 'png16')
        output.seek(0)
        _, _, rows, info = png.Reader(file=output).asRGB()
        self.assertEqual(info['bitdepth'], 16)
        np.testing.assert_array_equal(np.vstack(list(rows)), self.samples.reshape(1, -1))

    def test_rgb16_tiff_noop_exact_and_profile(self):
        p = self.pixels()
        source = self.folder / 'source.tif'
        tifffile.imwrite(source, self.samples, photometric='rgb')
        target = self.folder / 'export.tif'
        p.write(target, p.render(source, {}), 'tiff16')
        np.testing.assert_array_equal(tifffile.imread(target), self.samples)
        with tifffile.TiffFile(target) as t:
            self.assertEqual(t.pages[0].bitspersample, 16)
            self.assertIn(34675, t.pages[0].tags)

    def test_edited_ramp_retains_more_than_256_levels(self):
        p = self.pixels()
        output = p.render(self.png_source(self.samples), {'exposure': -.3, 'contrast': 1.1})
        self.assertEqual(output.dtype, np.float32)
        self.assertGreater(len(np.unique(np.rint(output[..., 0]*65535))), 3000)

    def test_alpha_and_orientation_keep_source_precision(self):
        p = self.pixels()
        rgba = np.concatenate([self.samples, self.samples[..., :1]], axis=-1)
        source = self.png_source(rgba)
        np.testing.assert_array_equal(np.rint(p.render(source, {}, preserve_alpha=True)*65535).astype('uint16'), rgba)
        opaque = p.render(source, {})
        expected = rgba[..., :3]/65535*(rgba[..., 3:]/65535) + 1-rgba[..., 3:]/65535
        np.testing.assert_allclose(opaque, expected, atol=2e-7)
        tiff = self.folder / 'oriented.tif'
        tifffile.imwrite(tiff, rgba[:, :7], photometric='rgb', extrasamples=['unassalpha'],
                         extratags=[(274, 'H', 1, 6, False)])
        oriented = p.read(tiff, preserve_alpha=True)
        np.testing.assert_array_equal(np.rint(oriented*65535).astype('uint16'), np.rot90(rgba[:, :7], 3))

    def test_float_resize_retains_gradient_precision(self):
        p = self.pixels()
        array = self.samples.astype(np.float32)/65535
        result = p.resize(array, (3072, 3))
        self.assertEqual(result.shape, (3, 3072, 3))
        self.assertEqual(result.dtype, np.float32)
        self.assertGreater(len(np.unique(result[..., 0])), 1000)
        self.assertEqual(p.to_image(result).mode, 'RGB')

    def test_float_resize_preserves_cutout_colour_at_alpha_overshoot(self):
        p = self.pixels()
        source = np.zeros((24, 24, 4), np.float32)
        source[4:20, 4:20] = (.53731, .22341, .17317, 1)
        result = p.resize(source, (61, 61))
        visible = result[..., 3] > .01
        expected = np.broadcast_to(source[10, 10, :3], (visible.sum(), 3))
        np.testing.assert_allclose(result[..., :3][visible], expected, atol=2e-6)

    def test_official_lut_interpolation_preserves_precision_and_axis_order(self):
        p = self.pixels()
        import film
        source = self.png_source(self.samples)
        output = p.render(source, {'film_stock': 'kodak_portra_400'})
        self.assertGreater(len(np.unique(np.rint(output[..., 0]*65535))), 1000)
        table = np.load(film.LUTS / 'kodak_portra_400.npy')
        for rgb in [(1, 0, 0), (0, 1, 0), (0, 0, 1)]:
            np.testing.assert_allclose(p.apply_lut(np.array([[rgb]], np.float32), table)[0, 0],
                                       table[rgb[2]*32, rgb[1]*32, rgb[0]*32], atol=1e-7)

    def test_grain_halation_and_creative_styles_are_float_deterministic(self):
        p = self.pixels()
        source = self.png_source(self.samples)
        recipe = {'style': 'cinema', 'film_stock': 'kodak_portra_400', 'film_grain': .3, 'film_halation': .4}
        a, b = p.render(source, recipe), p.render(source, recipe)
        np.testing.assert_array_equal(a, b)
        self.assertEqual(a.dtype, np.float32)
        self.assertGreater(len(np.unique(a[..., 0])), 1000)

    def test_bad_icc_fails_explicitly(self):
        p = self.pixels()
        source = self.folder / 'bad.tif'
        tifffile.imwrite(source, self.samples, photometric='rgb', extratags=[(34675, 'B', 7, b'invalid', False)])
        with self.assertRaisesRegex(ValueError, 'ICC'):
            p.read(source)

    def test_valid_rgb_icc_uses_float_transform(self):
        p = self.pixels()
        source = self.folder / 'profile.tif'
        profile = bytearray(ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes())
        profile[48:52] = b'TEST'  # Different metadata forces an actual LCMS transform.
        profile = bytes(profile)
        tifffile.imwrite(source, self.samples, photometric='rgb', extratags=[(34675, 'B', len(profile), profile, False)])
        output = p.read(source)
        self.assertGreater(len(np.unique(output[..., 0])), 3000)
        np.testing.assert_allclose(output, self.samples.astype(np.float32)/65535, atol=3e-5)

    def test_exported_rgba16_deflate_tiff_roundtrips(self):
        p = self.pixels()
        rgba = np.concatenate([self.samples, self.samples[..., :1]], axis=-1)
        path = self.folder / 'alpha.tif'
        p.write(path, rgba.astype(np.float32)/65535, 'tiff16')
        with tifffile.TiffFile(path) as source:
            self.assertEqual(source.pages[0].compression, 32946)
            self.assertEqual(int(source.pages[0].extrasamples[0]), 2)
        np.testing.assert_array_equal(np.rint(p.read(path, preserve_alpha=True)*65535).astype('uint16'), rgba)

    def test_tiff_stream_export(self):
        p = self.pixels()
        stream = BytesIO()
        p.write(stream, self.samples.astype(np.float32)/65535, 'tiff16')
        stream.seek(0)
        np.testing.assert_array_equal(tifffile.imread(stream), self.samples)

    def test_lzw_compressed_rgb16_tiff_preserves_source_samples(self):
        p = self.pixels()
        source = self.folder/'lzw.tif'
        tifffile.imwrite(source, self.samples, photometric='rgb', compression='lzw')
        result = p.read(source)
        np.testing.assert_array_equal(np.rint(result*65535).astype(np.uint16), self.samples)

    def test_all_exif_orientation_transforms(self):
        p = self.pixels()
        samples = np.arange(18, dtype=np.uint16).reshape(2, 3, 3)*3000
        expected = {1: samples, 2: samples[:, ::-1], 3: samples[::-1, ::-1], 4: samples[::-1],
                    5: samples.transpose(1, 0, 2), 6: np.rot90(samples, 3),
                    7: samples.transpose(1, 0, 2)[::-1, ::-1], 8: np.rot90(samples)}
        for orientation in range(1, 9):
            path = self.folder / f'orientation-{orientation}.tif'
            tifffile.imwrite(path, samples, photometric='rgb', extratags=[(274, 'H', 1, orientation, False)])
            np.testing.assert_array_equal(np.rint(p.read(path)*65535).astype('uint16'), expected[orientation])

    def test_native_raw_is_developed_as_sixteen_bit(self):
        p = self.pixels()
        import engine
        source = ROOT / 'validation/inputs/D7000.NEF'
        if not source.is_file() or not engine.raw_executable():
            self.skipTest('Native RAW engine/fixture unavailable')
        import hashlib
        before = hashlib.sha256(source.read_bytes()).digest()
        with patch.object(engine, 'RAW_CACHE', self.folder / 'raw-cache'):
            result = p.render(source, {'raw_exposure': .3}, max_size=(320, 240))
            developed = list((self.folder / 'raw-cache').glob('*.tif'))
            self.assertEqual(len(developed), 1)
            with tifffile.TiffFile(developed[0]) as raw:
                self.assertEqual(raw.pages[0].bitspersample, 16)
        self.assertEqual(result.dtype, np.float32)
        self.assertGreater(len(np.unique(result[..., 0])), 256)
        self.assertLessEqual(result.shape[0], 240)
        self.assertLessEqual(result.shape[1], 320)
        self.assertEqual(hashlib.sha256(source.read_bytes()).digest(), before)

    def test_eight_bit_lossless_formats_and_explicit_jpeg(self):
        p = self.pixels()
        rgba = np.array([[[0, 128, 255, 255], [31, 64, 200, 128]]], np.uint8)
        for name in ['png8', 'webp_lossless']:
            output = BytesIO()
            p.write(output, rgba.astype(np.float32)/255, name)
            output.seek(0)
            np.testing.assert_array_equal(np.asarray(Image.open(output).convert('RGBA')), rgba)
        output = BytesIO()
        p.write(output, rgba.astype(np.float32)/255, 'jpeg')
        output.seek(0)
        self.assertEqual(Image.open(output).format, 'JPEG')
        with self.assertRaises(ValueError):
            p.write(BytesIO(), rgba.astype(np.float32)/255, 'lossless_jpeg')


if __name__ == '__main__':
    unittest.main(verbosity=2)
