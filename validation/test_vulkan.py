"""Run with the packaged spectral Python to check the real Vulkan device."""
from pathlib import Path
import sys
import unittest
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'product'))


class VulkanTests(unittest.TestCase):
    def test_shared_context_serializes_concurrent_lut_jobs(self):
        from concurrent.futures import ThreadPoolExecutor
        from film_gpu import Vulkan
        rng = np.random.default_rng(722)
        pixels = rng.uniform(0,1,(57,97,3)).astype(np.float32)
        axis = np.linspace(0,1,17,dtype=np.float32)
        grid = np.stack(np.meshgrid(axis,axis,axis,indexing='ij'),axis=-1)[...,::-1].copy()
        with Vulkan() as gpu, ThreadPoolExecutor(max_workers=4) as pool:
            futures = [pool.submit(gpu.trilinear,pixels,grid*np.float32(i/8)) for i in range(8)]
            for i, future in enumerate(futures):
                np.testing.assert_allclose(future.result(),pixels*np.float32(i/8),atol=3e-7)

    def test_tiled_trilinear_preserves_bgr_storage_and_edges(self):
        from film_gpu import Vulkan
        from pixels import apply_lut
        rng = np.random.default_rng(721)
        table = rng.uniform(0, 1, (17, 17, 17, 3)).astype(np.float32)
        pixels = rng.uniform(-.2, 1.2, (1449, 1449, 3)).astype(np.float32)
        pixels[0, :3] = [[0, 0, 0], [1, 1, 1], [.5, .25, .75]]
        from unittest.mock import patch
        with patch('film_gpu.device', return_value=None):
            expected = apply_lut(pixels, table)
        with Vulkan() as gpu:
            self.assertTrue(hasattr(gpu, 'trilinear'), 'Missing matching BGR LUT kernel')
            for _ in range(2):
                result = gpu.trilinear(pixels, table)
                np.testing.assert_allclose(result, expected, atol=8e-7)

    def test_device_and_pchip_match_reference(self):
        from film_gpu import Vulkan
        from spektrafilm.utils.fast_interp_lut import prepare_lut_pchip_3d, _apply_lut_pchip_3d_prepared
        axis = np.linspace(0, 1, 17)
        grid = np.stack(np.meshgrid(axis, axis, axis, indexing='ij'), axis=-1)
        table = grid * grid
        prepared = prepare_lut_pchip_3d(table)
        pixels = np.random.default_rng(42).uniform(0, 1, (43, 157, 3))
        pixels[0, :3] = [[0,0,0], [1,1,1], [.5,.5,.5]]
        with Vulkan() as gpu:
            self.assertTrue(gpu.device)
            result = gpu.interpolate(pixels, prepared, 'first')
            reference = _apply_lut_pchip_3d_prepared(*prepared, pixels)
            np.testing.assert_allclose(result, reference, atol=3e-6)
            result = gpu.interpolate(pixels, prepared, 'first')
            np.testing.assert_allclose(result, reference, atol=3e-6)

    def test_spectral_integral(self):
        from film_gpu import Vulkan
        random = np.random.default_rng(17)
        pixels = random.uniform(0, 2, (53, 131, 3)).astype(np.float32)
        dyes = random.uniform(0, 1, (81, 3)).astype(np.float32)
        base = random.uniform(0, .2, 81).astype(np.float32)
        weights = random.uniform(0, .1, (81, 3)).astype(np.float32)
        expected = np.log10(np.power(10., -(pixels @ dyes.T + base)) @ weights + 1e-10)
        with Vulkan() as gpu:
            result = gpu.spectral(pixels, dyes, base, weights, 'spectral')
            np.testing.assert_allclose(result, expected, atol=3e-5)

    def test_curves_and_non_unit_lut_domain(self):
        from film_gpu import Vulkan
        from spektrafilm.model.density_curves import interpolate_exposure_to_density
        from spektrafilm.utils.fast_interp_lut import prepare_lut_pchip_3d
        exposure = np.linspace(-4, 3, 256)
        curves = np.stack((np.exp(exposure/6), np.exp(exposure/5), np.exp(exposure/4)), axis=-1)
        curves[:2, 1] = np.nan
        pixels = np.random.default_rng(67).uniform(-6, 5, (50, 127, 3))
        expected = interpolate_exposure_to_density(pixels, curves, exposure, 1.2)
        axis = np.linspace(0,1,17)
        grid = np.stack(np.meshgrid(axis,axis,axis,indexing='ij'),axis=-1)
        prepared = prepare_lut_pchip_3d(grid)
        with Vulkan() as gpu:
            np.testing.assert_allclose(gpu.curves(pixels, exposure, curves, 1.2), expected, atol=2e-6)
            result = gpu.interpolate(pixels,prepared,'domain',low=(-6,-6,-6),high=(5,5,5))
            np.testing.assert_allclose(result,(pixels+6)/11,atol=2e-6)

    def test_real_pipeline_controls_and_cpu_fallback_agree(self):
        from unittest.mock import patch
        import film_gpu, film_spectral
        pixels = np.random.default_rng(19).uniform(.025,.95,(90,130,3)).astype(np.float32)
        cases = [
            {'stock':'kodak_gold_200','paper_ev':.7,'paper_gamma':1.2,'paper_fast':.8,'paper_exhaustion':.2},
            {'stock':'kodak_portra_400','neutral':'manual','filter_c':4,'filter_m':70,'filter_y':60,
             'preflash':'on','preflash_ev':-7,'preflash_m':6,'preflash_y':-3,'film_gamma':1.2,
             'lang_r':.15,'coupler_amount':.7},
            {'stock':'fujifilm_provia_100f','process':'scan','film_ev':-.5,'tune_m':4},
            {'stock':'kodak_gold_200','scene_mode':'kelvin','scene_kelvin':3200,'paper_base':1.2},
        ]
        for recipe in cases:
            with self.subTest(recipe=recipe):
                film_spectral._color_luts.clear()
                gpu = film_spectral.simulate_array(pixels,recipe,'kodak_portra_endura')
                with patch.object(film_gpu,'device',return_value=None):
                    film_spectral._color_luts.clear()
                    cpu = film_spectral.simulate_array(pixels,recipe,'kodak_portra_endura')
                self.assertTrue(np.isfinite(gpu).all())
                np.testing.assert_allclose(gpu,cpu,atol=.004)


if __name__ == '__main__':
    unittest.main(verbosity=2)
