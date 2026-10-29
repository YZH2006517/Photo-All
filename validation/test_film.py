"""Film recipes and actual Spektrafilm LUT pixels; no product photo data is used."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from PIL import Image, ImageChops

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'product'))
import engine


class FilmTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir=Path(__file__).parent);self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.path=self.root/'colour.jpg'
        image=Image.linear_gradient('L').resize((128,128)).convert('RGB');image.paste((210,80,45),(0,0,64,64));image.save(self.path)

    def test_film_recipe_persists_and_undo_redo_restores_it(self):
        catalog=engine.Catalog(self.root/'library.sqlite');self.addCleanup(catalog.close);catalog.import_files([self.path])
        identity=catalog.photos()[0]['id'];catalog.edit([identity],recipe_patch={'film_stock':'kodak_portra_400','film_strength':.7,'film_grain':.2})
        self.assertEqual(catalog.photos()[0]['recipe']['film_stock'],'kodak_portra_400')
        catalog.undo();self.assertEqual(catalog.photos()[0]['recipe']['film_stock'],'none')
        catalog.redo();self.assertEqual(catalog.photos()[0]['recipe']['film_strength'],.7)

    def test_invalid_stock_and_nonfinite_strength_are_rejected(self):
        for patch in [{'film_stock':'invented'},{'film_strength':float('nan')},{'film_grain':2},{'film_halation':-1}]:
            with self.subTest(patch=patch),self.assertRaises(ValueError):engine.validate_recipe(patch)

    def test_real_film_changes_pixels_and_zero_strength_is_exact_bypass(self):
        self.assertIsNotNone(importlib.util.find_spec('film'),'Spektrafilm bridge is missing')
        import film
        self.assertTrue(film.stock_ready('kodak_portra_400'),'Real generated Spektrafilm LUT is missing')
        base=engine.render_image(self.path,{})
        result=engine.render_image(self.path,{'film_stock':'kodak_portra_400'})
        self.assertIsNotNone(ImageChops.difference(base,result).getbbox())
        bypass=engine.render_image(self.path,{'film_stock':'kodak_portra_400','film_strength':0})
        self.assertIsNone(ImageChops.difference(base,bypass).getbbox())

    def test_grain_and_halation_are_deterministic(self):
        self.assertIsNotNone(importlib.util.find_spec('film'),'Film effects bridge is missing')
        recipe={'film_stock':'kodak_portra_400','film_grain':.5,'film_halation':.3}
        a=engine.render_image(self.path,recipe);b=engine.render_image(self.path,recipe)
        self.assertEqual(a.tobytes(),b.tobytes())

    def test_more_creative_filters_produce_distinct_pixels(self):
        self.assertGreaterEqual(len(engine.STYLES),15)
        base=engine.render_image(self.path,{})
        outputs=[engine.render_image(self.path,{'style':style}).tobytes() for style in ['cinema','matte','sepia','cyanotype']]
        self.assertEqual(len(set(outputs)),4)
        self.assertTrue(all(p!=base.tobytes() for p in outputs))

    def test_lut_channel_order_matches_the_official_grid(self):
        import film,numpy as np
        table=np.load(film.LUTS/'kodak_portra_400.npy')
        for rgb in [(255,0,0),(0,255,0),(0,0,255),(255,255,255),(0,0,0)]:
            result=film.apply_film(Image.new('RGB',(1,1),rgb),engine.validate_recipe({'film_stock':'kodak_portra_400'})).getpixel((0,0))
            expected=table[32 if rgb[2] else 0,32 if rgb[1] else 0,32 if rgb[0] else 0]*255
            self.assertTrue(all(abs(float(a)-float(b))<=1 for a,b in zip(result,expected)),(rgb,result,expected))


if __name__=='__main__':unittest.main(verbosity=2)
