"""Real upstream acceleration regressions; run with the spectral Python runtime."""
from pathlib import Path
import sys,threading,unittest
from unittest.mock import patch
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'product'))
import film_spectral as film


class SpectralAccelerationTests(unittest.TestCase):
    def test_planar_coupler_blur_preserves_upstream_kernel_and_endpoints(self):
        from spektrafilm.model.couplers import compute_exposure_correction_dir_couplers
        self.assertTrue(hasattr(film, 'coupler_correction'), 'Missing allocation-bounded coupler correction')
        rng = np.random.default_rng(341)
        raw = rng.normal(0, 1, (71, 109, 3))
        density = rng.uniform(0, 2, raw.shape)
        matrix = rng.uniform(0, .1, (3, 3))
        for sigma, weight, shift, positive in ((1.2,0.,0.,False),(7.,.06,0.,False),(3.,1.,.2,True)):
            args = (raw, density, np.array([2.,2.3,2.5]), matrix, sigma, 12., weight, shift, positive)
            expected = compute_exposure_correction_dir_couplers(*args)
            result = film.coupler_correction(compute_exposure_correction_dir_couplers, *args)
            np.testing.assert_allclose(result, expected, atol=3e-12)

    def test_export_mode_is_thread_local_and_restored(self):
        self.assertTrue(hasattr(film,'calculation_mode'),'Missing explicit exact-export context')
        self.assertEqual(film.calculation_quality(),'accelerated')
        seen=[]
        with film.calculation_mode('exact'):
            thread=threading.Thread(target=lambda:seen.append(film.calculation_quality()));thread.start();thread.join()
            self.assertEqual(film.calculation_quality(),'exact')
        self.assertEqual(seen,['accelerated']);self.assertEqual(film.calculation_quality(),'accelerated')
        with self.assertRaises(ValueError):
            with film.calculation_mode('unknown'):pass

    def test_pointwise_cache_handles_outside_values_and_invalidation(self):
        self.assertTrue(hasattr(film,'bounded_lut'),'Missing bounded pointwise cache')
        film._color_luts.clear();calls=[]
        def square(x):calls.append(x.size);return x*x
        x=np.array([[[.1,.5,.9],[-2.,.25,3.]]],np.float64)
        a=film.bounded_lut(x,square,'regression',np.zeros(3),np.ones(3),steps=33)
        np.testing.assert_allclose(a,x*x,atol=.002)
        before=len(calls)
        film.bounded_lut(x[:,:1],square,'regression',np.zeros(3),np.ones(3),steps=33)
        self.assertEqual(len(calls),before,'Cached in-range pixels must not rebake')
        film.bounded_lut(x[:,:1],square,'changed-config',np.zeros(3),np.ones(3),steps=33)
        self.assertGreater(len(calls),before)
        for i in range(14):film.bounded_lut(x[:,:1],square,('bounded',i),np.zeros(3),np.ones(3),steps=5)
        self.assertLessEqual(len(film._color_luts),8)

    def sample(self):
        random=np.random.default_rng(18)
        return random.uniform(.025,.95,(40,64,3)).astype(np.float32)

    def test_real_modes_preserve_shape_and_parameter_changes(self):
        self.assertIn('quality',__import__('inspect').signature(film.simulate_array).parameters,'Missing fast/exact dispatch')
        rgb=self.sample();config={'stock':'kodak_gold_200','grain':'off','halation':'off'}
        exact=film.simulate_array(rgb,config,'kodak_portra_endura',quality='exact')
        fast=film.simulate_array(rgb,config,'kodak_portra_endura',quality='accelerated')
        self.assertEqual(fast.shape,rgb.shape);self.assertTrue(np.isfinite(fast).all())
        self.assertLess(float(np.quantile(np.abs(exact-fast),.99)),.04)
        changed=film.simulate_array(rgb,{**config,'paper_ev':1},'kodak_portra_endura',quality='accelerated')
        self.assertGreater(float(np.abs(fast-changed).mean()),.005)
        again=film.simulate_array(rgb,config,'kodak_portra_endura',quality='accelerated')
        np.testing.assert_allclose(again,fast,atol=1e-6)

    def test_exact_bypasses_approximate_pointwise_caches(self):
        self.assertTrue(hasattr(film,'bounded_lut'),'Exact bypass requires a distinct fast path')
        with patch.object(film,'bounded_lut',side_effect=AssertionError('Exact path used an approximate LUT')):
            result=film.simulate_array(self.sample(),{'stock':'kodak_gold_200'},'kodak_portra_endura',quality='exact')
        self.assertTrue(np.isfinite(result).all())

    def test_preview_reprints_same_negative_and_invalidates_on_film_or_pixels(self):
        rgb = self.sample()
        config = {'stock':'kodak_gold_200'}
        def render(pixels, changes, preview=True):
            return film.simulate_array(pixels, {**config, **changes}, 'kodak_portra_endura', preview=preview)
        render(rgb, {})
        pipeline = film._pipelines['accelerated']
        first = pipeline._preview_negative[1]
        for changes in ({'paper_ev':1}, {'paper':'kodak_2383'}, {'preflash':'on','tune_m':8}):
            result = render(rgb, changes)
            self.assertIs(first, pipeline._preview_negative[1])
            np.testing.assert_allclose(result, render(rgb, changes, False), atol=2e-6)
        render(rgb, {'film_ev':1})
        self.assertIsNot(first, pipeline._preview_negative[1])
        second = pipeline._preview_negative[1]
        render(rgb * .9, {'film_ev':1})
        self.assertIsNot(second, pipeline._preview_negative[1])

    def test_fast_keeps_spatial_grain_and_halation_enabled(self):
        self.assertIn('quality',__import__('inspect').signature(film.simulate_array).parameters)
        rgb=np.full((96,128,3),.12,np.float32);rgb[40:55,50:75]=1
        config={'stock':'kodak_gold_200','grain':'off','halation':'off'}
        plain=film.simulate_array(rgb,config,'kodak_portra_endura',quality='accelerated')
        grain=film.simulate_array(rgb,{**config,'grain':'on','grain_area':.5},'kodak_portra_endura',quality='accelerated')
        halo=film.simulate_array(rgb,{**config,'halation':'on','halo_amount':2,'halo_radius':2},'kodak_portra_endura',quality='accelerated')
        self.assertGreater(float(np.abs(grain-plain).mean()),1e-5)
        self.assertGreater(float(np.abs(halo-plain).mean()),1e-5)

if __name__=='__main__':unittest.main(verbosity=2)
