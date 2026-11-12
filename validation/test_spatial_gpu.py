"""Real GPU spatial contracts. Run in the spectral Python runtime."""
from pathlib import Path
import sys, unittest
import numpy as np
from unittest.mock import patch
import tempfile
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'product'))


class SpatialGPUTests(unittest.TestCase):
    def test_setup_math_matches_upstream_without_first_use_jit(self):
        import film_spectral as film
        from spektrafilm.utils.fast_interp_lut import prepare_lut_pchip_3d,apply_lut_cubic_2d
        self.assertTrue(hasattr(film,'prepare_pchip'),'Missing compile-free setup')
        rng=np.random.default_rng(923)
        for size in (2,5,17):
            table=rng.uniform(-2,3,(size,size,size,3))
            with __import__('warnings').catch_warnings():
                __import__('warnings').simplefilter('ignore')
                expected=prepare_lut_pchip_3d(table)
            for actual,reference in zip(film.prepare_pchip(table),expected):
                np.testing.assert_allclose(actual,reference,atol=2e-14)
        table=rng.uniform(-1,2,(17,17,3));image=rng.uniform(-.2,1.2,(39,47,2))
        np.testing.assert_allclose(film.calibration_cubic(None,table,image),apply_lut_cubic_2d(table,image),atol=2e-14)

    def test_measured_profile_shoulder_keeps_gpu_particle_path(self):
        import film_spectral as film
        from types import SimpleNamespace
        from spektrafilm.model.grain import apply_grain
        axis=np.linspace(0,3,256)[:,None]*np.ones((1,3))
        axis[-3:-1]-=.03  # Measured shoulder reversals must not force CPU draws.
        layers=np.repeat((np.linspace(0,1,256)[:,None]*np.ones((1,3)))[:,None,:],3,axis=1)
        grain=SimpleNamespace(active=True,sublayers_active=True,density_min=(.03,.06,.04),
            particle_area_um2=.35,particle_scale=(1,.8,3),particle_scale_layers=(3,1,.3),
            uniformity=(.98,.98,.98),blur_dye_clouds_um=0.,micro_structure=(.1,0),blur=0.)
        source=np.full((170,230,3),.8)
        for positive in (False,True):
            curves=axis[::-1].copy() if positive else axis
            layer=layers[::-1].copy() if positive else layers
            def forbidden(*args,**kwargs):self.fail('Reverted to full CPU grain')
            actual=film.accelerated_grain(forbidden,source,5.,grain,curves,layer,'positive' if positive else 'negative')
            expected=apply_grain(source.copy(),5.,grain,curves,layer,'positive' if positive else 'negative',use_fast_stats=True)
            # Independent random fields: compare means within six standard errors.
            error=6*np.sqrt(np.max(actual.var(axis=(0,1))+expected.var(axis=(0,1)))/(source.shape[0]*source.shape[1]))
            np.testing.assert_allclose(actual.mean(axis=(0,1)),expected.mean(axis=(0,1)),atol=max(.001,error))
            np.testing.assert_allclose(actual.var(axis=(0,1)),expected.var(axis=(0,1)),rtol=.1,atol=1e-5)
            np.testing.assert_array_equal(source,np.full(source.shape,.8))

    def test_spatial_fallback_does_not_disable_other_gpu_stages(self):
        import film_spectral as film
        from types import SimpleNamespace
        source=np.arange(15,dtype=float).reshape(3,5)
        def original(x,sigma,truncate):return x+sigma+truncate
        unavailable=SimpleNamespace(gaussian=lambda *args:(_ for _ in ()).throw(ValueError('budget')))
        with patch('film_gpu.device',return_value=unavailable),patch('film_gpu.disable') as disable:
            np.testing.assert_array_equal(film.accelerated_gaussian(original,source,2.,3.),source+5)
            disable.assert_not_called()

    def test_prepared_cache_survives_worker_restart_and_rejects_damage(self):
        import film_spectral as film
        self.assertTrue(hasattr(film,'_lut_disk_root'),'Missing restart-safe setup cache')
        with tempfile.TemporaryDirectory() as directory,patch.object(film,'_lut_disk_root',return_value=Path(directory)):
            calls=[]
            def compute(x):calls.append(1);return x*x
            data=np.full((3,4,3),.25)
            film._color_luts.clear()
            expected=film.bounded_lut(data,compute,'disk-cache-regression',np.zeros(3),np.ones(3),steps=9)
            self.assertTrue(calls)
            film._color_luts.clear();calls.clear()
            np.testing.assert_array_equal(film.bounded_lut(data,compute,'disk-cache-regression',np.zeros(3),np.ones(3),steps=9),expected)
            self.assertFalse(calls,'New worker recomputed identical setup')
            for path in Path(directory).glob('*.npz'):path.write_bytes(b'broken')
            film._color_luts.clear()
            film.bounded_lut(data,compute,'disk-cache-regression',np.zeros(3),np.ones(3),steps=9)
            self.assertTrue(calls,'Damaged cache must rebuild')
            calls.clear();film._color_luts.clear()
            film.bounded_lut(data,compute,'different-setup',np.zeros(3),np.ones(3),steps=9)
            self.assertTrue(calls,'Changed setup must not reuse old data')
        film._color_luts.clear()

    def test_gaussian_preserves_reference_edges_and_large_sigma(self):
        from film_gpu import Vulkan
        from spektrafilm.utils.fast_gaussian_filter import fast_gaussian_filter
        rng=np.random.default_rng(729)
        with Vulkan() as gpu:
            self.assertTrue(hasattr(gpu,'gaussian'),'Missing reusable spatial GPU filter')
            for shape in ((1,17),(19,1),(73,109)):
                for sigma in (.08,.65,2.9,3.,15.,80.):
                    image=rng.uniform(0,2,shape)
                    np.testing.assert_allclose(gpu.gaussian(image,sigma),fast_gaussian_filter(image,sigma),atol=5e-6)
            for sigma in (.65,3.,200.):
                np.testing.assert_allclose(gpu.gaussian(np.ones((127,193)),sigma),1,atol=3e-6)

    def test_colour_transform_matches_colour_science(self):
        from film_gpu import Vulkan
        import colour
        from spektrafilm.model.illuminants import standard_illuminant
        rng=np.random.default_rng(231)
        image=rng.uniform(0,1.5,(83,109,3))
        image[0,:3]=[[0,.04045,.0031308],[1,1,1],[-.01,.5,.9]]
        srgb=colour.RGB_COLOURSPACES['sRGB']
        for light in ('BB3200','D55','D65'):
            xy=colour.XYZ_to_xy(colour.sd_to_XYZ(standard_illuminant(light,True)))
            xyz=colour.RGB_to_XYZ(image,srgb,apply_cctf_decoding=True)
            expected=np.maximum(0,colour.XYZ_to_RGB(xyz,srgb,illuminant=xy,apply_cctf_encoding=True))
            matrix=colour.XYZ_to_RGB(colour.RGB_to_XYZ(np.eye(3),srgb),srgb,illuminant=xy)
            with Vulkan() as gpu:
                self.assertTrue(hasattr(gpu,'colour_transform'),'Missing native colour transform')
                # HDR cancellation near black stays below half a 16-bit step.
                np.testing.assert_allclose(gpu.colour_transform(image,matrix),expected,atol=6e-6)

    def test_grain_uses_same_particle_distribution_and_tiled_seed(self):
        from film_gpu import Vulkan
        rng=np.random.default_rng(271)
        with Vulkan() as gpu:
            self.assertTrue(hasattr(gpu,'grain_layer'),'Missing independent GPU particle sampler')
            axis=np.linspace(0,3,64)[:,None]*np.ones((1,3))
            curve=axis.copy()
            for density, particles in ((.02,3.),(.4,12.),(1.5,150.),(2.9,3000.)):
                image=np.full((400,500,3),density,np.float32)
                result=gpu.grain_layer(image,axis,curve,np.zeros(3),np.full(3,3.),
                                       np.full(3,particles),np.full(3,.98),seed=123)
                expected_variance=density*(3/particles)*(1-density/3*.98*(1-1e-6))
                np.testing.assert_allclose(result.mean(axis=(0,1)),density,atol=max(.002,5*np.sqrt(expected_variance/200000)))
                np.testing.assert_allclose(result.var(axis=(0,1)),expected_variance,rtol=.09,atol=1e-5)
                np.testing.assert_array_equal(result,gpu.grain_layer(image,axis,curve,np.zeros(3),np.full(3,3.),
                                             np.full(3,particles),np.full(3,.98),seed=123))
            image=rng.uniform(0,3,(131,277,3))
            full=gpu.grain_layer(image,axis,curve,np.zeros(3),np.full(3,3.),np.full(3,100.),np.full(3,.98),seed=19)
            gpu.tile=777
            tiled=gpu.grain_layer(image,axis,curve,np.zeros(3),np.full(3,3.),np.full(3,100.),np.full(3,.98),seed=19)
            np.testing.assert_array_equal(tiled,full)

if __name__=='__main__':unittest.main(verbosity=2)
