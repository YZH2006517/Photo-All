"""Focused checks for rotation coverage, RAW proxy separation and import cancel."""
from pathlib import Path
import hashlib
import json
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'product'))
import engine
import pixels


class WorkspaceUpdateTests(unittest.TestCase):
    def test_unnamed_albums_receive_unique_default_names(self):
        with tempfile.TemporaryDirectory(dir=ROOT / 'validation/artifacts') as directory:
            catalog = engine.Catalog(Path(directory) / 'library.sqlite')
            try:
                first = catalog.create_album('')
                second = catalog.create_album('   ')
                self.assertEqual(first['name'], '未命名图集')
                self.assertEqual(second['name'], '未命名图集 2')
                catalog.trash_album(first['id'])
                self.assertEqual(catalog.create_album('')['name'], '未命名图集 3')
                self.assertEqual(catalog.create_album('  旅行  ')['name'], '旅行')
                with self.assertRaises(ValueError):
                    catalog.create_album('x' * 81)
            finally:
                catalog.close()

    def test_filter_stack_export_keeps_16bit_and_layer_metadata(self):
        with tempfile.TemporaryDirectory(dir=ROOT / 'validation/artifacts') as folder:
            folder=Path(folder);path=folder/'ramp.png'
            ramp=np.linspace(.1,.8,2048,dtype=np.float32)
            source=np.stack([ramp,ramp*.8,ramp*.6],axis=-1)[None,...]
            pixels.write(path,source,'png16')
            layers=[{'uid':'first','kind':'style','id':'warm','strength':.4,'enabled':True},
                    {'uid':'second','kind':'style','id':'mono','strength':.2,'enabled':True}]
            recipe=engine.validate_recipe({'filter_stack':json.dumps(layers)})
            photo={'path':str(path),'name':path.name,'digest':hashlib.sha256(path.read_bytes()).hexdigest(),'recipe':recipe}
            target=engine.export_photo(photo,folder/'out',size=0,format='png')
            with target.open('rb') as stream:
                _,_,rows,info=pixels.png.Reader(file=stream).asRGB()
                values=np.vstack(list(rows))
            self.assertEqual(info['bitdepth'],16);self.assertGreater(len(np.unique(values)),256)
            metadata=json.loads(target.with_suffix('.recipe.json').read_text(encoding='utf-8'))
            self.assertEqual([layer['id'] for layer in metadata['filter_stack']],['warm','mono'])
            self.assertEqual(photo['digest'],hashlib.sha256(path.read_bytes()).hexdigest())

    def test_filter_stack_order_strength_and_disabled_layers(self):
        def layer(uid, name, strength=1, enabled=True):
            return {'uid':uid,'kind':'style','id':name,'strength':strength,'enabled':enabled}
        source = np.full((24,32,3), [.3,.45,.62], np.float32)
        with tempfile.TemporaryDirectory(dir=ROOT / 'validation/artifacts') as folder:
            path=Path(folder)/'source.png';pixels.write(path,source,'png16')
            def render(layers): return pixels.render(path,{'filter_stack':json.dumps(layers)})
            plain=render([]);full=render([layer('a','warm')]);half=render([layer('a','warm',.5)])
            self.assertGreater(float(np.max(abs(full-plain))), .005)
            np.testing.assert_allclose(half,(plain+full)*.5,atol=1e-6)
            np.testing.assert_array_equal(plain,render([layer('a','warm',1,False)]))
            first=render([layer('a','warm'),layer('b','mono')])
            second=render([layer('b','mono'),layer('a','warm')])
            self.assertGreater(float(np.max(abs(first-second))), .005)
            self.assertEqual(second.dtype,np.float32)

    def test_filter_stack_validation_and_batch_append_undo(self):
        with self.assertRaises(ValueError): engine.validate_recipe({'filter_stack':'[{"kind":"lut","id":"../../x"}]'})
        with self.assertRaises(ValueError): engine.validate_recipe({'filter_stack':json.dumps([{'uid':'same','kind':'style','id':'warm'}]*2)})
        with self.assertRaises(ValueError): engine.validate_recipe({'filter_stack':json.dumps([{'kind':'style','id':'warm','strength':2}])})
        with tempfile.TemporaryDirectory(dir=ROOT / 'validation/artifacts') as folder:
            folder=Path(folder);source=folder/'source.png';second=folder/'second.png';Image.new('RGB',(100,80),'#48735e').save(source);Image.new('RGB',(100,80),'#7a638e').save(second)
            catalog=engine.Catalog(folder/'catalog.sqlite')
            try:
                album=catalog.create_album('layers');catalog.import_files([source,second],album_id=album['id']);identities=[photo['id'] for photo in catalog.photos()]
                catalog.edit(identities,recipe={'style':'warm'})
                catalog.edit(identities,filter_append={'uid':'new','kind':'style','id':'mono','strength':.6})
                layers=engine.filter_layers(catalog.photos()[0]['recipe'])
                self.assertEqual([layer['id'] for layer in layers],['warm','mono'])
                catalog.undo();self.assertTrue(all(photo['recipe']['style']=='warm' for photo in catalog.photos()))
                catalog.redo();self.assertTrue(all(len(engine.filter_layers(photo['recipe']))==2 for photo in catalog.photos()))
            finally:catalog.close()

    def test_purge_trash_removes_only_album_records_and_blocks_restore(self):
        with tempfile.TemporaryDirectory(dir=ROOT / 'validation/artifacts') as folder:
            folder = Path(folder)
            source = folder / 'original.jpg'
            Image.new('RGB', (120, 80), '#789965').save(source)
            digest = hashlib.sha256(source.read_bytes()).hexdigest()
            catalog = engine.Catalog(folder / 'catalog.sqlite')
            try:
                one, two = catalog.create_album('delete'), catalog.create_album('keep')
                catalog.import_files([source], album_id=one['id'])
                catalog.import_files([source], album_id=two['id'])
                catalog.trash_album(one['id'])
                self.assertTrue(catalog.purge_album(one['id']))
                self.assertEqual(catalog.trash_albums(), [])
                self.assertEqual(catalog.photos()[0]['album_ids'], [two['id']])
                with self.assertRaises(ValueError): catalog.restore_album(one['id'])
                self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), digest)
                self.assertGreater(catalog.create_album('new')['id'], two['id'])
            finally: catalog.close()

    def test_purge_rejects_an_active_album(self):
        with tempfile.TemporaryDirectory(dir=ROOT / 'validation/artifacts') as folder:
            catalog = engine.Catalog(Path(folder) / 'catalog.sqlite')
            try:
                album = catalog.create_album('active')
                with self.assertRaises(ValueError): catalog.purge_album(album['id'])
                self.assertEqual(len(catalog.albums()), 1)
            finally: catalog.close()

    def test_straighten_has_no_transparent_corners_and_keeps_precision(self):
        for width, height in [(300, 180), (180, 300), (240, 240)]:
            source = np.full((height, width, 3), .421234, np.float32)
            for angle in [-45, -13.4, .1, 12, 45]:
                result = pixels._geometry(source, engine.validate_recipe({'straighten': angle}))
                self.assertEqual(result.shape, (height, width, 4))
                self.assertGreater(float(result[..., 3].min()), .999)
                np.testing.assert_allclose(result[..., :3], source, atol=1e-5)
                self.assertEqual(result.dtype, np.float32)

    def test_quarter_turn_is_exact_without_resampling(self):
        source = np.arange(300*180*3, dtype=np.float32).reshape(180, 300, 3)
        result = pixels._geometry(source, engine.validate_recipe({'quarter_turns': 1}))
        np.testing.assert_array_equal(result, np.rot90(source, -1))

    def test_geometry_maps_rotated_corners_inside_source(self):
        for width, height in [(300, 180), (180, 300)]:
            for angle in [-45, -13, 13, 45]:
                for x, y in [(0, 0), (0, 1), (1, 0), (1, 1)]:
                    u, v = engine.geometry_to_source(x, y, width, height, {'straighten': angle})
                    self.assertTrue(0 <= u <= 1 and 0 <= v <= 1)

    def test_raw_embedded_proxy_does_not_develop_or_modify_original(self):
        for name, expected in [('D7000.NEF', (4928, 3264)), ('EOS_5D_Mark_II.CR2', (5616, 3744))]:
            path = ROOT / 'validation/inputs' / name
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            with patch.object(engine, 'develop_raw', side_effect=AssertionError('Full RAW decode during quick import')):
                image, native, _ = engine.analysis_image(path)
            self.assertLessEqual(max(image.size), 640)
            self.assertGreater(native[0]*native[1], image.width*image.height)
            self.assertEqual(native, expected)
            self.assertEqual(digest, hashlib.sha256(path.read_bytes()).hexdigest())

    def test_raster_analysis_keeps_native_dimensions(self):
        with tempfile.TemporaryDirectory(dir=ROOT / 'validation/artifacts') as folder:
            path = Path(folder) / 'photo.jpg'
            Image.new('RGB', (2400, 1600), '#1f785e').save(path)
            info = engine.analyze(path)
            self.assertEqual((info['width'], info['height']), (2400, 1600))
            self.assertEqual(info['digest'], hashlib.sha256(path.read_bytes()).hexdigest())

    def test_cancel_keeps_committed_photos(self):
        with tempfile.TemporaryDirectory(dir=ROOT / 'validation/artifacts') as folder:
            folder = Path(folder)
            paths = [folder / f'{i}.jpg' for i in range(4)]
            for path in paths: Image.new('RGB', (160, 100), '#58926b').save(path)
            catalog = engine.Catalog(folder / 'catalog.sqlite')
            try:
                album = catalog.create_album('cancel')
                token = engine.CancellationToken()
                def progress(done, total):
                    if done == 1: token.cancel()
                catalog.import_files(paths, progress, album['id'], token)
                self.assertEqual(len(catalog.photos()), 1)
                self.assertEqual(len(catalog.import_files(paths, album_id=album['id'])[0]), 3)
                self.assertEqual(len(catalog.photos()), 4)
            finally: catalog.close()


if __name__ == '__main__': unittest.main()
