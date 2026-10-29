"""Album boundaries, visual indexing and real composition pixels."""
import sys
import tempfile
import unittest
from pathlib import Path
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'product'))
import engine


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.catalog = engine.Catalog(self.root / 'library.sqlite')
        self.addCleanup(self.catalog.close)

    def photo(self, name, color):
        path = self.root / name
        Image.new('RGB', (80, 60), color).save(path)
        return path

    def test_album_membership_survives_regroup_and_shared_import(self):
        self.assertTrue(hasattr(self.catalog, 'create_album'), 'Persistent albums are missing')
        a = self.catalog.create_album('暖色旅行')
        b = self.catalog.create_album('精选备份')
        path = self.photo('photo.png', 'coral')
        self.catalog.import_files([path], album_id=a['id'])
        self.catalog.import_files([path], album_id=b['id'])
        self.catalog.regroup()
        self.assertEqual(len(self.catalog.photos()), 1)
        self.assertEqual(set(self.catalog.photos()[0]['album_ids']), {a['id'], b['id']})
        other = engine.Catalog(self.root / 'library.sqlite')
        try:
            self.assertEqual([x['count'] for x in other.albums()], [1, 1])
        finally:
            other.close()

    def test_invalid_album_import_does_not_create_orphan_photos(self):
        self.assertTrue(hasattr(self.catalog, 'create_album'), 'Persistent albums are missing')
        with self.assertRaises(ValueError):
            self.catalog.import_files([self.photo('one.png', 'red')], album_id=999)
        self.assertEqual(self.catalog.photos(), [])

    def test_legacy_library_migrates_once_without_changing_recipe(self):
        self.catalog.import_files([self.photo('legacy.png','blue')])
        self.catalog.edit([self.catalog.photos()[0]['id']],recipe={'style':'warm'},decision='keep')
        self.catalog.db.executescript('DROP TABLE albums; DROP TABLE album_photos; ALTER TABLE photos DROP COLUMN features;')
        other=engine.Catalog(self.root/'library.sqlite')
        try:
            self.assertEqual(len(other.albums()),1)
            self.assertEqual(other.albums()[0]['name'],'已有照片')
            self.assertEqual(other.photos()[0]['recipe']['style'],'warm')
            self.assertEqual(other.photos()[0]['decision'],'keep')
            other.create_album('空图集')
        finally: other.close()
        restarted=engine.Catalog(self.root/'library.sqlite')
        try: self.assertEqual(len(restarted.albums()),2)
        finally: restarted.close()

    def test_legacy_import_without_album_still_appears_on_home(self):
        self.catalog.import_files([self.photo('legacy.png','blue')])
        self.assertEqual(sum(a['count'] for a in self.catalog.albums()),1)

    def test_visual_features_are_original_based_and_separate_brightness(self):
        self.catalog.import_files([self.photo('red.png', '#ed4c39'), self.photo('blue.png', '#397bea'),
                                   self.photo('dark.png', '#101010'), self.photo('light.png', '#eeeeee')])
        rows = {p['name']: p for p in self.catalog.photos()}
        self.assertIn('features', rows['red.png'], 'Visual index is missing')
        self.assertEqual(rows['red.png']['features']['color'], 'red')
        self.assertEqual(rows['blue.png']['features']['tone'], 'cool')
        self.assertEqual(rows['dark.png']['features']['brightness'], 'dark')
        self.assertEqual(rows['light.png']['features']['brightness'], 'bright')
        before = rows['red.png']['features']
        self.catalog.edit([rows['red.png']['id']], recipe={'style': 'mono'})
        self.assertEqual(self.catalog.photos()[0]['features'], before)

    def test_composite_blend_alpha_order_and_snapshot(self):
        self.assertTrue(__import__('importlib').util.find_spec('workflow'), 'Composition engine is missing')
        import workflow
        self.catalog.import_files([self.photo('red.png', '#ff0000'), self.photo('blue.png', '#0000ff')])
        photos = self.catalog.photos()
        layers = [dict(photo_id=p['id'], opacity=1, blend='normal', visible=True,
                       x=0, y=0, scale=1, rotation=0, recipe={}) for p in photos]
        doc = dict(name='测试', width=80, height=60, layers=layers)
        image = workflow.render_composite(doc, photos)
        self.assertEqual(image.getpixel((40, 30)), (0, 0, 255, 255))
        doc['layers'][1]['opacity'] = .5
        pixel = workflow.render_composite(doc, photos).getpixel((40, 30))
        self.assertTrue(abs(pixel[0] - 128) <= 1 and abs(pixel[2] - 128) <= 1)
        doc['layers'][1].update(opacity=1, blend='multiply')
        self.assertEqual(workflow.render_composite(doc, photos).getpixel((40, 30)), (0, 0, 0, 255))
        saved = self.catalog.save_composite(doc)
        self.assertEqual(self.catalog.composites()[0]['id'], saved['id'])
        self.assertEqual(self.catalog.composites()[0]['layers'][1]['blend'], 'multiply')

    def test_composite_validates_before_allocation_and_preserves_transparency(self):
        self.assertTrue(__import__('importlib').util.find_spec('workflow'), 'Composition engine is missing')
        import workflow
        with self.assertRaises(ValueError):
            workflow.render_composite(dict(width=999999, height=999999, layers=[]), [])
        image = workflow.render_composite(dict(width=80, height=60, layers=[]), [])
        self.assertEqual(image.getpixel((1, 1)), (0, 0, 0, 0))

    def test_translucent_source_has_no_white_matte_contamination(self):
        import workflow
        path=self.root/'alpha.png'
        Image.new('RGBA',(80,60),(255,0,0,128)).save(path)
        self.catalog.import_files([path])
        photo=self.catalog.photos()[0]
        doc=dict(width=80,height=60,layers=[dict(photo_id=photo['id'])])
        self.assertEqual(workflow.render_composite(doc,[photo]).getpixel((40,30)),(255,0,0,128))

    def test_composite_preserves_exact_sixteen_bit_source_samples(self):
        import workflow, pixels, numpy as np, tifffile
        self.assertTrue(hasattr(workflow, 'render_composite_pixels'), 'Float composition renderer is missing')
        ramp = np.arange(8192, dtype=np.uint16).reshape(16, 512)*8
        samples = np.stack((ramp, 65535-ramp, np.roll(ramp, 17, axis=1)), axis=-1)
        path = self.root/'ramp.tif'
        tifffile.imwrite(path, samples, photometric='rgb')
        photos = [dict(id=1, path=str(path))]
        document = dict(width=512, height=16, layers=[dict(photo_id=1)])
        output = workflow.render_composite_pixels(document, photos)
        self.assertEqual(output.dtype, np.float32)
        self.assertGreater(len(np.unique(output[..., 0])), 256)
        np.testing.assert_array_equal(np.rint(output[..., :3]*65535).astype(np.uint16), samples)
        exported = self.root/'composition.tif'
        pixels.write(exported, output, 'tiff16')
        np.testing.assert_array_equal(tifffile.imread(exported)[..., :3], samples)

    def test_float_blend_modes_follow_w3c_source_over(self):
        import workflow, pixels, numpy as np
        self.assertTrue(hasattr(workflow, 'render_composite_pixels'), 'Float composition renderer is missing')
        back = np.array([.23341, .60573, .81429, .60121], np.float32)
        front = np.array([.75327, .31517, .40491, .42351], np.float32)
        paths = [self.root/'back.tif', self.root/'front.tif']
        for path, sample in zip(paths, (back, front)):
            pixels.write(path, np.broadcast_to(sample, (16, 16, 4)), 'tiff16')
        # Use the actually encoded source samples as the independent reference.
        back, front = (np.rint(a*65535).astype(np.float64)/65535 for a in (back, front))
        photos = [dict(id=i+1, path=str(path)) for i, path in enumerate(paths)]
        b, f, ba, fa = back[:3], front[:3], back[3], front[3]*.7317
        blends = {'normal': f, 'multiply': b*f, 'screen': b+f-b*f,
                  'overlay': np.where(b <= .5, 2*b*f, 1-2*(1-b)*(1-f)),
                  'darken': np.minimum(b, f), 'lighten': np.maximum(b, f)}
        alpha = fa+ba*(1-fa)
        for mode, blend in blends.items():
            doc = dict(width=16, height=16, layers=[dict(photo_id=1),
                       dict(photo_id=2, opacity=.7317, blend=mode)])
            result = workflow.render_composite_pixels(doc, photos)[8, 8]
            expected = np.r_[(f*fa*(1-ba)+blend*fa*ba+b*ba*(1-fa))/alpha, alpha]
            np.testing.assert_allclose(result, expected, atol=3e-7)

    def test_rotated_transparent_colour_has_no_white_or_hidden_colour_fringe(self):
        import workflow, pixels, numpy as np
        self.assertTrue(hasattr(workflow, 'render_composite_pixels'), 'Float composition renderer is missing')
        sample = np.zeros((32, 32, 4), np.float32)
        sample[..., :3] = (0, 1, 1)  # Saturated hidden colour must not leak through affine filtering.
        sample[6:26, 6:26] = (.83731, .12341, .07317, .67351)
        path = self.root/'transparent.tif'
        pixels.write(path, sample, 'tiff16')
        photos = [dict(id=1, path=str(path))]
        doc = dict(width=64, height=64, layers=[dict(photo_id=1, rotation=27, scale=.71, x=2.3, y=-1.2)])
        result = workflow.render_composite_pixels(doc, photos)
        visible = result[..., 3] > .01
        expected = np.rint(sample[10, 10, :3]*65535)/65535
        np.testing.assert_allclose(result[..., :3][visible], np.broadcast_to(expected, (visible.sum(), 3)), atol=2e-6)
        self.assertTrue(np.any((result[..., 3] > .01) & (result[..., 3] < .6)))

    def test_affine_alpha_overshoot_does_not_change_constant_foreground_colour(self):
        import workflow, pixels, numpy as np
        sample = np.zeros((32, 32, 4), np.float32)
        sample[6:26, 6:26] = (.53731, .22341, .17317, 1)
        path = self.root/'opaque-cutout.tif'
        pixels.write(path, sample, 'tiff16')
        photos = [dict(id=1, path=str(path))]
        doc = dict(width=64, height=64, layers=[dict(photo_id=1, rotation=27, scale=.71, x=2.3, y=-1.2)])
        result = workflow.render_composite_pixels(doc, photos)
        visible = result[..., 3] > .01
        expected = np.rint(sample[10, 10, :3]*65535)/65535
        np.testing.assert_allclose(result[..., :3][visible], np.broadcast_to(expected, (visible.sum(), 3)), atol=2e-6)

    def test_batch_style_keeps_individual_exposure_and_undo_is_atomic(self):
        self.catalog.import_files([self.photo('a.png', 'coral'), self.photo('b.png', 'blue')])
        a,b=self.catalog.photos()
        self.catalog.edit([a['id']], recipe={'exposure': .7})
        self.catalog.edit([a['id'],b['id']], recipe_patch={'style':'film'})
        rows=self.catalog.photos()
        self.assertEqual(rows[0]['recipe']['exposure'],.7)
        self.assertEqual(rows[1]['recipe']['exposure'],0)
        self.assertTrue(all(p['recipe']['style']=='film' for p in rows))
        self.catalog.undo()
        self.assertTrue(all(p['recipe']['style']=='natural' for p in self.catalog.photos()))

    def test_undo_redo_survive_restart_and_new_edits_clear_redo(self):
        self.catalog.import_files([self.photo('undo.png','coral')]);identity=self.catalog.photos()[0]['id']
        self.catalog.edit([identity],recipe_patch={'style':'warm'})
        self.catalog.edit([identity],decision='keep')
        self.catalog.undo()
        self.assertTrue(hasattr(self.catalog,'redo'),'Persistent redo is missing')
        self.assertEqual(self.catalog.history_state(),{'undo':1,'redo':1})
        other=engine.Catalog(self.root/'library.sqlite')
        try:
            self.assertTrue(other.redo());self.assertEqual(other.photos()[0]['decision'],'keep')
            other.undo();other.undo();self.assertEqual(other.photos()[0]['recipe']['style'],'natural')
            other.redo();self.assertEqual(other.photos()[0]['recipe']['style'],'warm')
            other.edit([identity],recipe_patch={'style':'mono'})
            self.assertFalse(other.redo())
            self.assertEqual(other.photos()[0]['recipe']['style'],'mono')
        finally:other.close()

    def test_noop_edit_does_not_create_an_undo_step_or_clear_redo(self):
        self.catalog.import_files([self.photo('noop.png','coral')]);identity=self.catalog.photos()[0]['id']
        self.catalog.edit([identity],recipe_patch={'style':'warm'});self.catalog.undo()
        self.assertTrue(hasattr(self.catalog,'history_state'),'History availability is missing')
        self.catalog.edit([identity],recipe_patch={'style':'natural'})
        self.assertEqual(self.catalog.history_state(),{'undo':0,'redo':1})

    def test_simultaneous_undo_requests_restore_two_distinct_steps(self):
        from concurrent.futures import ThreadPoolExecutor
        import threading
        self.catalog.import_files([self.photo('concurrent.png','coral')]);identity=self.catalog.photos()[0]['id']
        self.catalog.edit([identity],recipe_patch={'style':'warm'});self.catalog.edit([identity],decision='keep')
        barrier=threading.Barrier(2)
        def undo():
            other=engine.Catalog(self.root/'library.sqlite')
            try:barrier.wait(timeout=5);return other.undo()
            finally:other.close()
        with ThreadPoolExecutor(2) as executor:self.assertEqual(list(executor.map(lambda _:undo(),range(2))),[True,True])
        self.assertEqual(self.catalog.photos()[0]['recipe']['style'],'natural')
        self.assertEqual(self.catalog.history_state(),{'undo':0,'redo':2})

    def test_local_model_recognizes_pixels_under_a_neutral_filename(self):
        import workflow
        fixture=Path(__file__).parent/'inputs'/'recognition-fixture.jpg'
        if not workflow.recognition_status()['ready'] or not fixture.exists():
            self.skipTest('Optional local model and public fixture are not installed')
        result=workflow.classify(Image.open(fixture))
        self.assertEqual(result['label'],'animal')
        self.assertGreater(result['score'],.5)
        self.assertEqual(result['revision'],workflow.MODEL_REVISION)


class ContrastFeatures(unittest.TestCase):
    def test_perceptual_contrast_is_measured_and_distinguishes_flat_from_edges(self):
        from PIL import Image
        import workflow
        flat = Image.new('RGB', (128,128), '#808080')
        split = Image.new('RGB', (128,128), 'black')
        split.paste('white', (64,0,128,128))
        self.assertLess(workflow.visual_features(flat)['contrast'], .001)
        self.assertGreater(workflow.visual_features(split)['contrast'], .4)


if __name__ == '__main__':
    unittest.main(verbosity=2)

