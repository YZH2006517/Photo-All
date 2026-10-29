"""Non-destructive high precision editing contracts, using generated photos."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'product'))
import engine
import pixels
import tifffile


class EditorEngineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT/'validation')
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)

    def source(self, array, name='source.tif'):
        path = self.folder/name
        pixels.write(path, array.astype(np.float32), 'tiff16')
        return path

    def test_editor_defaults_and_validation(self):
        recipe = engine.validate_recipe({})
        self.assertIn('crop_w', recipe)
        self.assertEqual(recipe['curve_rgb'], '[[0,0],[1,1]]')
        invalid = [{'quarter_turns': 4}, {'quarter_turns': .5}, {'flip_x': 2}, {'straighten': 46},
                   {'crop_x': .8, 'crop_w': .3}, {'crop_w': .001}, {'gamma': 0},
                   {'black_point': .7, 'white_point': .5}, {'shadows': float('nan')},
                   {'curve_rgb': '[[0,0],[0,1],[1,1]]'}, {'curve_r': '[[0.1,0],[1,1]]'},
                   {'hsl': '[{"band":8}]'}, {'retouch': '[{"type":"magic"}]'},
                   {'local_adjustments': '[{"x":2,"y":0.5,"radius":0.1}]'}]
        for patch in invalid:
            with self.subTest(patch=patch), self.assertRaises(ValueError): engine.validate_recipe(patch)

    def test_quarter_flips_crop_are_pixel_exact_and_dimensions_match(self):
        samples = np.arange(24*32*3, dtype=np.uint16).reshape(24, 32, 3)*20
        source = self.folder/'ramp.tif'
        tifffile.imwrite(source, samples, photometric='rgb')
        before = hashlib.sha256(source.read_bytes()).digest()
        recipe = dict(quarter_turns=1, flip_x=1, crop_x=.25, crop_y=.25, crop_w=.5, crop_h=.5)
        result = engine.render_pixels(source, recipe)
        expected = np.rot90(samples, -1)[:, ::-1][8:24, 6:18]
        np.testing.assert_array_equal(np.rint(result*65535).astype('uint16'), expected)
        self.assertEqual(engine.render_dimensions(dict(width=32, height=24, recipe=recipe)), (12, 16))
        self.assertEqual(hashlib.sha256(source.read_bytes()).digest(), before)

    def test_curves_levels_and_gamma_retain_sixteen_bit_gradation(self):
        ramp = np.linspace(.01, .99, 4096, dtype=np.float32)[None, :, None]
        path = self.source(np.repeat(ramp, 3, axis=-1))
        recipe = dict(curve_r='[[0,0],[0.5,0.7],[1,1]]', gamma=1.2, black_point=.01, white_point=.99)
        out = engine.render_pixels(path, recipe)
        self.assertGreater(len(np.unique(np.rint(out[..., 0]*65535))), 2000)
        self.assertGreater(out[0, 2000, 0], out[0, 2000, 1]+.1)

    def test_tonal_ranges_vibrance_tint_and_hsl_change_target_colours(self):
        samples = np.broadcast_to(np.array([[.1,.1,.1],[.5,.5,.5],[.9,.9,.9]], np.float32), (16, 3, 3)).copy()
        path = self.source(samples)
        neutral = engine.render_pixels(path, {})
        shadows = engine.render_pixels(path, {'shadows': .5})
        self.assertGreater(shadows[0, 0, 0]-neutral[0, 0, 0], shadows[0, 2, 0]-neutral[0, 2, 0])
        highlights = engine.render_pixels(path, {'highlights': -.5})
        self.assertLess(highlights[0, 2, 0], neutral[0, 2, 0])
        tinted = engine.render_pixels(path, {'tint': .6})
        self.assertGreater(tinted[0, 1, 0], tinted[0, 1, 1])
        colours = np.broadcast_to(np.array([[.7,.2,.2],[.2,.2,.7]], np.float32), (16, 2, 3)).copy()
        path = self.source(colours, 'colours.tif')
        changed = engine.render_pixels(path, {'hsl': '[{"band":0,"hue":25,"saturation":-0.5,"luminance":0.1}]'})
        base = engine.render_pixels(path, {})
        self.assertGreater(np.max(abs(changed[:, 0]-base[:, 0])), .05)
        np.testing.assert_array_equal(changed[:, 1], base[:, 1])
        vibrant = engine.render_pixels(path, {'vibrance': .7})
        self.assertGreater(vibrant[0, 0, 0]-vibrant[0, 0, 1], base[0, 0, 0]-base[0, 0, 1])

    def test_local_adjustment_is_bounded_and_source_coordinates_precede_geometry(self):
        path = self.source(np.full((80, 120, 3), .3, np.float32))
        operation = dict(x=.25, y=.5, radius=.15, exposure=1, saturation=1, feather=.5)
        base = engine.render_pixels(path, {})
        out = engine.render_pixels(path, {'local_adjustments': json.dumps([operation])})
        self.assertGreater(out[40, 30, 0], .5)
        np.testing.assert_array_equal(out[:, 70:], base[:, 70:])
        flipped = engine.render_pixels(path, {'local_adjustments': json.dumps([operation]), 'flip_x': 1})
        np.testing.assert_array_equal(flipped, out[:, ::-1])

    def test_clone_and_heal_are_bounded_feathered_patch_operations(self):
        sample = np.full((100, 100, 3), .3, np.float32)
        sample[40:60, 15:35] = (.8, .2, .1)
        sample[40:60, 65:85] = (.1, .1, .1)
        path = self.source(sample)
        operation = dict(type='clone', x=.75, y=.5, sx=.25, sy=.5, radius=.1, strength=1)
        output = engine.render_pixels(path, {'retouch': json.dumps([operation])})
        np.testing.assert_allclose(output[50, 75], sample[50, 25], atol=2e-5)
        np.testing.assert_array_equal(output[:25], engine.render_pixels(path, {})[:25])
        operation['type'] = 'heal'
        healed = engine.render_pixels(path, {'retouch': json.dumps([operation])})
        self.assertLess(np.linalg.norm(healed[50, 75]-.3), np.linalg.norm(output[50, 75]-.3))

    def test_detail_tools_and_vignette_keep_float_and_change_expected_signal(self):
        random = np.random.default_rng(19)
        sample = np.clip(.5+random.normal(0, .02, (64, 64, 3)), 0, 1).astype(np.float32)
        path = self.source(sample)
        denoised = engine.render_pixels(path, {'denoise': .8})
        self.assertLess(denoised.var(), sample.var()*.8)
        sharpened = engine.render_pixels(path, {'sharpen': 1})
        self.assertGreater(sharpened.var(), sample.var())
        vignette = engine.render_pixels(path, {'vignette': .8})
        self.assertLess(vignette[0, 0].mean(), vignette[32, 32].mean()*.8)
        detailed = engine.render_pixels(path, {'clarity': .3, 'dehaze': .2, 'whites': .2, 'blacks': -.1})
        self.assertEqual(detailed.dtype, np.float32)
        self.assertTrue(np.isfinite(detailed).all())
        self.assertGreater(np.max(abs(detailed-engine.render_pixels(path, {}))), .005)

    def test_sharpen_radius_remains_effective_in_a_small_preview(self):
        sample = np.full((80, 80, 3), .3, np.float32)
        sample[30:50, 30:50] = .6
        path = self.source(sample)
        small = engine.render_pixels(path, {'sharpen': 1, 'sharpen_radius': .3})
        large = engine.render_pixels(path, {'sharpen': 1, 'sharpen_radius': 5})
        self.assertGreater(np.max(abs(large-small)), .005)

    def test_straightening_has_no_transparent_fringe_and_coordinate_inverse(self):
        sample = np.zeros((40, 60, 4), np.float32)
        sample[..., :3] = (0, 1, 1)
        sample[5:35, 10:50] = (.6, .2, .1, 1)
        path = self.source(sample)
        recipe = dict(quarter_turns=1, flip_x=1, straighten=11, crop_x=.1, crop_y=.2, crop_w=.8, crop_h=.6)
        out = engine.render_pixels(path, recipe, preserve_alpha=True)
        visible = out[..., 3] > .01
        expected = np.rint(np.array([.6,.2,.1])*65535)/65535
        np.testing.assert_allclose(out[..., :3][visible], np.broadcast_to(expected, (visible.sum(), 3)), atol=2e-6)
        x, y = engine.geometry_to_source(.5, .5, 60, 40, recipe)
        self.assertAlmostEqual(x, .5, places=5)
        self.assertAlmostEqual(y, .5, places=5)

    def test_catalog_recipe_undo_and_render_dimensions_preserve_original(self):
        path = self.source(np.full((24, 32, 3), .4, np.float32))
        catalog = engine.Catalog(self.folder/'library.sqlite')
        self.addCleanup(catalog.close)
        catalog.import_files([path])
        identity = catalog.photos()[0]['id']
        catalog.edit([identity], recipe_patch={'quarter_turns': 1, 'crop_w': .5, 'curve_rgb': '[[0,0],[0.5,0.6],[1,1]]'})
        photo = catalog.photos()[0]
        self.assertEqual((photo['width'], photo['height']), (32, 24))
        self.assertEqual((photo['render_width'], photo['render_height']), (12, 32))
        catalog.undo()
        self.assertEqual(catalog.photos()[0]['recipe']['crop_w'], 1)

    def test_small_edge_crop_keeps_at_least_one_pixel(self):
        path = self.source(np.full((16, 16, 3), .4, np.float32))
        recipe = dict(crop_x=.99, crop_y=.99, crop_w=.01, crop_h=.01)
        output = engine.render_pixels(path, recipe)
        self.assertEqual(output.shape, (1, 1, 3))
        self.assertEqual(engine.render_dimensions(dict(width=16, height=16, recipe=recipe)), (1, 1))

    def test_geometry_inverse_matches_full_order_for_every_quarter_turn(self):
        import math
        width, height = 123, 81
        for turn in range(4):
            for flip_x, flip_y in [(0, 0), (1, 0), (0, 1), (1, 1)]:
                recipe = engine.validate_recipe(dict(quarter_turns=turn, flip_x=flip_x, flip_y=flip_y,
                    straighten=13, crop_x=.13, crop_y=.17, crop_w=.73, crop_h=.69))
                source_x, source_y = .37, .62
                u, v = source_x, source_y
                for _ in range(turn): u, v = 1-v, u
                if flip_x: u = 1-u
                if flip_y: v = 1-v
                tw, th = (height, width) if turn % 2 else (width, height)
                px, py = (u-.5)*tw, (v-.5)*th
                a = math.radians(13)
                tx = math.cos(a)*px+math.sin(a)*py+tw/2
                ty = -math.sin(a)*px+math.cos(a)*py+th/2
                left, top, right, bottom = engine.crop_bounds(tw, th, recipe)
                ox, oy = (tx-left)/(right-left), (ty-top)/(bottom-top)
                actual = engine.geometry_to_source(ox, oy, width, height, recipe)
                np.testing.assert_allclose(actual, (source_x, source_y), atol=1e-12)


if __name__ == '__main__': unittest.main(verbosity=2)
