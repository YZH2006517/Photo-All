"""Focused frame checks. Originals and exports stay in temporary directories."""
from pathlib import Path
import sys, tempfile, unittest, json, importlib.util
import numpy as np
from PIL import Image
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'product'))

class BorderTests(unittest.TestCase):
    def module(self):
        self.assertIsNotNone(importlib.util.find_spec('borders'),'Frame engine is not implemented')
        import borders
        return borders

    def test_styles_keep_every_source_sample_without_an_8bit_round_trip(self):
        b=self.module()
        image=np.linspace(.001,.999,400*266*3,dtype=np.float32).reshape(266,400,3)
        for style in b.STYLES:
            with self.subTest(style=style):
                config=b.validate({'style':style,'date_mode':'none','info_mode':'none'})
                output,layout=b.compose(image,config,{})
                x,y,w,h=layout['image']
                np.testing.assert_array_equal(output[y:y+h,x:x+w],image)
                self.assertEqual(output.dtype,np.float32)

    def test_portrait_film_keeps_orientation_and_all_pixels(self):
        b=self.module();image=np.random.default_rng(1).random((400,260,3),dtype=np.float32)
        output,layout=b.compose(image,b.validate({'style':'film35','date_mode':'none','info_mode':'none'}),{})
        x,y,w,h=layout['image'];np.testing.assert_array_equal(output[y:y+h,x:x+w],image)
        self.assertGreater(output.shape[0],output.shape[1])

    def test_labels_do_not_cover_a_tiny_photo(self):
        b=self.module();image=np.full((8,12,3),.34567,np.float32)
        for style in b.STYLES:
            output,layout=b.compose(image,{'style':style,'roll_name':'TEXT','signature':'NAME'},{'date':'2026.11.03'})
            x,y,w,h=layout['image'];np.testing.assert_array_equal(output[y:y+h,x:x+w],image)

    def test_text_validation_and_custom_information(self):
        b=self.module()
        config=b.validate({'style':'film35','date_mode':'custom','date_text':'2026.11.02','roll_name':'秋日散步','signature':'摄影 / 张三','info_mode':'custom','info_text':'50mm · f/2 · ISO 400'})
        lines=b.labels(config,{'date':'2000.01.01','camera':'Camera'})
        joined=' '.join(lines.values())
        for value in ['2026.11.02','秋日散步','张三','50mm']:self.assertIn(value,joined)
        for value in [{'style':'unknown'},{'width':float('nan')},{'signature':'x'*121},{'background':'red'},{'show_camera':'yes'}]:
            with self.assertRaises(ValueError):b.validate(value)

    def test_35mm_uses_physical_ks_perforation_proportions(self):
        b=self.module();metrics=b.film_metrics(600,400)
        self.assertAlmostEqual(metrics['pitch']/metrics['px_mm'],4.75)
        self.assertAlmostEqual(metrics['hole_width']/metrics['px_mm'],2.794)
        self.assertAlmostEqual(metrics['hole_height']/metrics['px_mm'],1.981)
        self.assertAlmostEqual(metrics['band']/400,(34.98-24)/48,delta=.003)

    def test_recipe_frame_export_is_16bit_and_source_is_untouched(self):
        b=self.module();import engine, pixels, tifffile
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as folder:
            root=Path(folder);source=root/'original.tif'
            source_pixels=np.arange(300*420*3,dtype=np.uint16).reshape(300,420,3)
            tifffile.imwrite(source,source_pixels,photometric='rgb')
            original=source.read_bytes()
            recipe=engine.validate_recipe({'border':json.dumps({'style':'gallery','roll_name':'旅行','date_mode':'none','info_mode':'none'})})
            photo={'id':1,'name':source.name,'path':str(source),'digest':'test','recipe':recipe,'captured':0,'time_source':'file'}
            output=engine.export_photo(photo,root/'out','recipe',0,'tiff')
            result=tifffile.imread(output)
            self.assertEqual(result.dtype,np.uint16)
            self.assertGreater(len(np.unique(result)),256)
            self.assertGreater(result.shape[0],300)
            self.assertEqual(source.read_bytes(),original)
            self.assertEqual(json.loads(output.with_suffix('.recipe.json').read_text(encoding='utf-8'))['border']['settings']['style'],'gallery')

if __name__=='__main__':unittest.main()
