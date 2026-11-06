"""Preview performance regressions; real pixels, isolated catalog, no source writes."""
from pathlib import Path
import json
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.request import Request, urlopen
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'product'))
import engine
import service
from PIL import Image


class EditorPerformanceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir=ROOT/'validation')
        self.addCleanup(self.temp.cleanup)
        self.server=service.create_server(Path(self.temp.name)/'data','test-secret',0)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        threading.Thread(target=self.server.serve_forever,daemon=True).start()
        self.path=Path(self.temp.name)/'input.png'
        Image.new('RGB',(128,80),'coral').save(self.path)
        self.catalog=engine.Catalog(self.server.data_dir/'library.sqlite')
        self.addCleanup(self.catalog.close)
        self.catalog.import_files([self.path])
        self.photo=self.catalog.photos()[0]

    def call(self,route,body):
        request=Request(f'http://127.0.0.1:{self.server.server_port}/api'+route,
                        data=json.dumps(body).encode(),headers={'Authorization':'Bearer test-secret'})
        with urlopen(request,timeout=20) as response:return response.read()

    def test_changing_border_reuses_float_photo_stage_but_new_color_and_source_invalidate(self):
        recipe=engine.validate_recipe({'exposure':.2})
        def read(style):
            return self.call('/border-preview',{'id':self.photo['id'],'recipe':{**recipe,'border':json.dumps({'style':style})}})
        with patch.object(engine,'render_pixels',wraps=engine.render_pixels) as render:
            first=read('film35');second=read('negative');again=read('film35')
            self.assertNotEqual(first,second)
            self.assertEqual(first,again)
            self.assertEqual(render.call_count,1,'Changing frame reran photo grading')
            recipe['exposure']=.4
            read('film35')
            self.assertEqual(render.call_count,2)
            Image.new('RGB',(128,80),'blue').save(self.path)
            read('film35')
            self.assertEqual(render.call_count,3)

    def test_border_only_edit_reuses_native_pixel_cache(self):
        photo={**self.photo,'recipe':engine.validate_recipe({'exposure':.2})}
        with patch.object(engine,'render_image',wraps=engine.render_image) as render:
            first=self.server.preview(photo,0,False,'source')
            photo['recipe']['border']=json.dumps({'style':'film35'})
            second=self.server.preview(photo,0,False,'source')
            self.assertEqual(first,second)
            self.assertEqual(render.call_count,1,'Export-only border invalidated native pixels')

    def test_preview_context_stops_obsolete_spectral_work_without_affecting_export(self):
        import film_spectral
        current=True
        with film_spectral.preview_task(lambda:current):
            current=False
            with self.assertRaises(film_spectral.PreviewSuperseded):film_spectral.check_preview()
        film_spectral.check_preview()

    def test_new_editor_generation_invalidates_old_and_cannot_be_replaced_by_late_request(self):
        first=self.server.editor_generation('one-editor',3)
        self.assertTrue(first())
        latest=self.server.editor_generation('one-editor',5)
        late=self.server.editor_generation('one-editor',4)
        self.assertFalse(first());self.assertFalse(late());self.assertTrue(latest())

    def test_screen_decode_cache_is_shared_across_color_changes_but_never_used_for_export(self):
        import pixels
        import numpy as np
        with patch.object(pixels,'read',wraps=pixels.read) as decode:
            first=engine.render_pixels(self.path,{'exposure':.2},(640,640),preview=True)
            second=engine.render_pixels(self.path,{'exposure':.5},(640,640),preview=True)
            again=engine.render_pixels(self.path,{'exposure':.2},(640,640),preview=True)
            self.assertEqual(decode.call_count,1,'Every screen adjustment decoded the large source again')
            np.testing.assert_array_equal(first,again)
            self.assertFalse(np.array_equal(first,second))
            exported=engine.render_pixels(self.path,{'exposure':.2},(640,640))
            self.assertEqual(decode.call_count,2)
            np.testing.assert_array_equal(first,exported)

    def test_interactive_endpoint_has_native_refinement_and_rejects_stale_recipe(self):
        from io import BytesIO
        from urllib.error import HTTPError
        body={'id':self.photo['id'],'recipe':{'exposure':.3},'preview_session':'editor','generation':2}
        native=self.call('/editor-preview',{**body,'size':0})
        with Image.open(BytesIO(native)) as image:self.assertEqual(image.size,(128,80))
        self.call('/editor-preview',{**body,'generation':3,'cancel':True})
        with self.assertRaises(HTTPError) as error:self.call('/editor-preview',{**body,'size':640})
        self.assertEqual(error.exception.code,409)

    def test_editor_preview_matches_existing_rgba_display_flattening(self):
        from io import BytesIO
        import numpy as np
        Image.new('RGBA',(128,80),(50,100,150,100)).save(self.path)
        data=self.call('/editor-preview',{'id':self.photo['id'],'recipe':{'exposure':.2},
                       'preview_session':'rgba-editor','generation':0,'size':0})
        expected=engine.render_image(self.path,{'exposure':.2},preview=True)
        with Image.open(BytesIO(data)) as actual:
            self.assertEqual(actual.mode,expected.mode)
            np.testing.assert_array_equal(np.asarray(actual),np.asarray(expected))

    def test_tight_crop_quick_stage_bounds_input_but_native_keeps_every_source_pixel(self):
        from io import BytesIO
        import film_spectral
        Image.new('RGB',(2000,1200),'coral').save(self.path)
        sizes=[]
        def spectral(rgb,recipe,stocks,**kwargs):
            sizes.append(rgb.shape[:2])
            return rgb
        body={'id':self.photo['id'],'recipe':{'crop_w':.1,'crop_h':.1,
              'film_advanced':json.dumps({'stock':'kodak_gold_200'})},
              'preview_session':'crop-editor','generation':0}
        with patch.object(film_spectral,'render',side_effect=spectral):
            self.call('/editor-preview',{**body,'size':640})
            self.assertLessEqual(max(sizes[0]),640,'Small crop sent a full source to the quick worker')
            native=self.call('/editor-preview',{**body,'size':0})
            self.assertEqual(sizes[-1],(1200,2000))
            with Image.open(BytesIO(native)) as image:self.assertEqual(image.size,(200,120))


if __name__=='__main__':unittest.main()
