"""Open filter provenance, Hald axis order, precision and saved recipe contracts."""
from pathlib import Path
import sys, tempfile, unittest, hashlib
import numpy as np
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'product'))
import engine, pixels, film

class OpenFilterTests(unittest.TestCase):
    def test_hald_axis_and_16bit_samples_preserved(self):
        import open_filters
        axis=np.linspace(0,65535,4,dtype=np.uint16)
        b,g,r=np.meshgrid(axis,axis,axis,indexing='ij')
        hald=np.stack([b,r,g],axis=-1).reshape(8,8,3)
        table=open_filters.hald_table(hald)
        samples=np.array([[[.183721,.517341,.833371],[1,0,0],[0,1,0],[0,0,1]]],np.float32)
        np.testing.assert_allclose(pixels.apply_lut(samples,table),samples[...,[2,0,1]],atol=2e-5)
        self.assertEqual(table.dtype,np.float32)

    def test_invalid_hald_is_rejected(self):
        import open_filters
        for data in [np.zeros((8,9,3),np.uint8),np.zeros((10,10,3),np.uint8),np.zeros((8,8,4),np.uint8)]:
            with self.assertRaises(ValueError):open_filters.hald_table(data)

    def test_grayscale_hald_png_expands_three_output_channels(self):
        import open_filters,png
        from io import BytesIO
        stream=BytesIO()
        samples=np.arange(64,dtype=np.uint8).reshape(8,8)
        png.Writer(8,8,greyscale=True).write(stream,samples)
        table,bits=open_filters.decode_hald(stream.getvalue())
        self.assertEqual(table.shape,(4,4,4,3));self.assertEqual(bits,8)
        np.testing.assert_array_equal(table[...,0],table[...,1])
        np.testing.assert_array_equal(table[...,1],table[...,2])

    def test_catalog_has_actual_unique_licensed_assets(self):
        import open_filters
        catalog=open_filters.catalog()
        self.assertGreaterEqual(catalog['count'],100)
        self.assertEqual(catalog['count'],len(catalog['items']))
        hashes=set(); responses=set()
        samples=np.random.default_rng(884).random((16,16,3),dtype=np.float32)
        for identity,entry in catalog['items'].items():
            self.assertTrue(entry['ready'],identity)
            self.assertTrue(entry['license']);self.assertTrue(entry['source'].startswith('https://'))
            table=open_filters.load_table(identity)
            digest=hashlib.sha256(table.tobytes()).hexdigest()
            self.assertNotIn(digest,hashes);hashes.add(digest)
            response=pixels.apply_lut(samples,table)
            self.assertGreater(float(np.abs(response-samples).max()),.002)
            responses.add(hashlib.sha256(np.rint(response*65535).astype(np.uint16).tobytes()).hexdigest())
        self.assertEqual(len(responses),catalog['count'])
        self.assertLessEqual(open_filters._load_table.cache_info().currsize,6)

    def test_recipe_persistence_undo_strength_and_float_export(self):
        import open_filters
        identity=next(iter(open_filters.catalog()['items']))
        with tempfile.TemporaryDirectory(dir=ROOT/'validation') as folder:
            folder=Path(folder);path=folder/'source.tif'
            ramp=np.linspace(.1,.8,4096,dtype=np.float32)
            data=np.stack([ramp,ramp*.8+.1,ramp*.5+.2],axis=-1)[None]
            pixels.write(path,data,'tiff16');original=path.read_bytes()
            base=engine.render_pixels(path,{})
            bypass=engine.render_pixels(path,{'filter_id':identity,'filter_strength':0})
            np.testing.assert_array_equal(base,bypass)
            graded=engine.render_pixels(path,{'filter_id':identity})
            expected=pixels.apply_lut(base,open_filters.load_table(identity))
            np.testing.assert_allclose(graded,expected,atol=1e-7)
            half=engine.render_pixels(path,{'filter_id':identity,'filter_strength':.5})
            np.testing.assert_allclose(half,base+(graded-base)*.5,atol=1e-7)
            self.assertEqual(graded.dtype,np.float32)
            self.assertGreater(len(np.unique(graded[...,0])),1000)
            for fmt in ['png16','tiff16']:
                target=folder/('out.'+('png' if fmt=='png16' else 'tif'))
                pixels.write(target,graded,fmt)
                np.testing.assert_allclose(pixels.read(target),graded,atol=1/65535)
            catalog=engine.Catalog(folder/'library.sqlite')
            try:
                catalog.import_files([path]);photo=catalog.photos()[0]['id']
                catalog.edit([photo],recipe_patch={'filter_id':identity,'filter_strength':.73})
                self.assertEqual(catalog.photos()[0]['recipe']['filter_id'],identity)
                catalog.undo();self.assertEqual(catalog.photos()[0]['recipe']['filter_id'],'none')
                catalog.redo();self.assertEqual(catalog.photos()[0]['recipe']['filter_strength'],.73)
            finally:catalog.close()
            self.assertEqual(original,path.read_bytes())

    def test_unknown_filter_and_invalid_strength_rejected(self):
        for patch in [{'filter_id':'invented'},{'filter_strength':float('nan')},{'filter_strength':-1},{'filter_strength':2}]:
            with self.subTest(patch=patch),self.assertRaises(ValueError):engine.validate_recipe(patch)

    def test_export_and_composite_share_float_filter_and_provenance(self):
        import open_filters,workflow,json
        identity='rt_kodak_portra_400_2'
        with tempfile.TemporaryDirectory(dir=ROOT/'validation') as folder:
            folder=Path(folder);source=folder/'colour.tif'
            values=np.random.default_rng(6).random((24,48,3),dtype=np.float32)
            pixels.write(source,values,'tiff16')
            catalog=engine.Catalog(folder/'library.sqlite')
            try:
                catalog.import_files([source]);photo=catalog.photos()[0]
                recipe=engine.validate_recipe({'filter_id':identity,'filter_strength':.81,'style':'cinema','film_stock':'kodak_portra_400'})
                catalog.edit([photo['id']],recipe_patch=recipe);photo=catalog.photos()[0]
                expected=engine.render_pixels(source,recipe)
                for fmt in ['png','tiff']:
                    target=engine.export_photo(photo,folder/'export',size=0,format=fmt)
                    np.testing.assert_allclose(pixels.read(target),expected,atol=1/65535)
                    metadata=json.loads(target.with_suffix('.recipe.json').read_text(encoding='utf-8'))
                    self.assertEqual(metadata['open_filter']['id'],identity)
                    self.assertEqual(metadata['open_filter']['sha256'],open_filters.manifest()['items'][identity]['sha256'])
                composite=workflow.render_composite_pixels({'width':48,'height':24,'layers':[{'photo_id':photo['id'],'recipe':recipe}]},[photo])
                np.testing.assert_allclose(composite[...,:3],expected,atol=1e-7)
            finally:catalog.close()

if __name__=='__main__':unittest.main(verbosity=2)
