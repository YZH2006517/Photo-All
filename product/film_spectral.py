# SPDX-License-Identifier: GPL-3.0-or-later
"""Recipe schema and float-array bridge to the isolated Spektrafilm runtime."""
import atexit
import contextlib
import hashlib
from collections import OrderedDict
from dataclasses import replace
import json
import math
import mmap
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import zipfile

import numpy as np

ROOT = Path(__file__).resolve().parent
# The embedded worker uses an isolated ._pth and does not add the script's
# directory automatically. Resolve Photo All's companion modules beside it.
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
MAX_ENLARGED_PIXELS = 32_000_000
PYTHONS = (ROOT/'engines/spectral-python/python.exe', ROOT/'engines/film-runtime/Scripts/python.exe')
SLIDES = {
    'fujifilm_provia_100f': 'Fujifilm Provia 100F',
    'fujifilm_velvia_100': 'Fujifilm Velvia 100',
    'kodak_ektachrome_100': 'Kodak Ektachrome 100',
    'kodak_kodachrome_64': 'Kodak Kodachrome 64',
}
PAPERS = {
    'kodak_portra_endura': 'Kodak Professional Portra Endura',
    'kodak_supra_endura': 'Kodak Professional Supra Endura',
    'kodak_ultra_endura': 'Kodak Professional Ultra Endura',
    'kodak_endura_premier': 'Kodak Professional Endura Premier',
    'kodak_ektacolor_edge': 'Kodak Ektacolor Edge',
    'fujifilm_crystal_archive_typeii': 'Fujifilm Crystal Archive Type II',
    'kodak_2383': 'Kodak Vision 2383',
    'kodak_2393': 'Kodak Vision Premier 2393',
}
LIGHTS = {'': '随片种', 'D50': 'D50 · 5000 K', 'D55': 'D55 · 5500 K',
          'D65': 'D65 · 6500 K', 'A': 'A · 钨丝灯', 'BB3200': '3200 K · 黑体'}


def slider(key, label, low, high, step, default, unit=''):
    return dict(key=key, label=label, min=low, max=high, step=step, default=default, unit=unit)


def choice(key, label, options, default):
    return dict(key=key, label=label, options=options, default=default)


GROUPS = {
    '胶片': [
        choice('process', '输出工艺', {'auto':'随片种', 'print':'相纸冲印', 'scan':'直接扫描', 'negative':'实拍负片冲印'}, 'auto'),
        choice('enlarge', '印片放大倍率', {'1':'原始尺寸', '2':'2×', '4':'4×'}, '1'),
        *(slider('negative_base_'+c, '片基参考'+label, 0, 1, .01, 0, '%')
          for c,label in [('r','红'),('g','绿'),('b','蓝')]),
        slider('film_ev', '胶片曝光', -4, 4, .1, 0, 'EV'),
        slider('film_gamma', '胶片伽马', .5, 2, .01, 1),
        slider('film_fast', '胶片快速层', .5, 2, .01, 1),
        slider('film_slow', '胶片慢速层', .5, 2, .01, 1),
        slider('film_exhaustion', '胶片显影耗竭', 0, 1, .01, 0),
        slider('film_base', '片基密度', 0, 2, .01, 1),
        slider('film_format', '片幅', 8, 120, .1, 35, 'mm'),
    ],
    '冲印': [
        choice('paper', '相纸', {'':'随片种', **PAPERS}, ''),
        slider('paper_ev', '相纸曝光', -4, 4, .1, 0, 'EV'),
        slider('paper_gamma', '相纸伽马', .5, 2, .01, 1),
        slider('paper_fast', '相纸快速层', .5, 2, .01, 1),
        slider('paper_slow', '相纸慢速层', .5, 2, .01, 1),
        slider('paper_exhaustion', '相纸显影耗竭', 0, 1, .01, 0),
        slider('paper_base', '纸基密度', 0, 2, .01, 1),
        slider('glare', '纸面杂散光', 0, 1, .01, 0, '%'),
    ],
    '放大机滤色': [
        choice('neutral', '滤色基准', {'auto':'自动中和', 'manual':'手动 CC'}, 'auto'),
        slider('filter_c', '青色滤片', 0, 170, 1, 0, 'CC'),
        slider('filter_m', '品红滤片', 0, 170, 1, 65, 'CC'),
        slider('filter_y', '黄色滤片', 0, 170, 1, 55, 'CC'),
        slider('tune_m', '品红微调', -50, 50, .5, 0, 'CC'),
        slider('tune_y', '黄色微调', -50, 50, .5, 0, 'CC'),
    ],
    '预闪': [
        choice('preflash', '相纸预闪', {'off':'关', 'on':'开'}, 'off'),
        slider('preflash_ev', '预闪曝光', -16, -2, .1, -10, 'EV'),
        slider('preflash_m', '预闪品红', -50, 50, .5, 0, 'CC'),
        slider('preflash_y', '预闪黄色', -50, 50, .5, 0, 'CC'),
    ],
    '耦合剂': [
        choice('couplers', 'DIR 抑制', {'off':'关', 'on':'开'}, 'on'),
        slider('coupler_amount', '耦合剂用量', 0, 2, .01, 1),
        slider('coupler_same', '同层抑制', 0, 2, .01, 1),
        slider('coupler_inter', '层间抑制', 0, 2, .01, 1),
        *(slider('lang_'+c, 'Langmuir '+label, 0, 2, .01, 0)
          for c,label in [('r','红'),('g','绿'),('b','蓝')]),
        slider('coupler_radius', '扩散半径', 0, 120, 1, 20, 'µm'),
        slider('coupler_tail', '扩散尾部', 0, 400, 1, 200, 'µm'),
        slider('coupler_weight', '尾部权重', 0, 1, .01, .06),
    ],
    '光晕': [
        choice('halation', '乳剂散射和背反射', {'off':'关', 'on':'开'}, 'off'),
        slider('halo_amount', '背反射强度', 0, 3, .01, 1),
        slider('halo_radius', '背反射半径倍率', .25, 3, .01, 1),
        slider('halo_radius_um', '自定背反射半径', 0, 200, 1, 0, 'µm'),
        slider('halo_midtones', '中间调保护', 0, 1, .01, 0, '%'),
        slider('scatter_amount', '乳剂散射强度', 0, 3, .01, 1),
        slider('scatter_radius', '乳剂散射半径倍率', .25, 3, .01, 1),
        slider('highlight_boost', '高光增强', 0, 4, .1, 0, 'EV'),
        slider('boost_range', '增强范围', .05, 1, .01, .3),
        slider('protect_ev', '亮部保护', 0, 8, .1, 4, 'EV'),
        slider('bounces', '反射次数', 1, 8, 1, 3),
        slider('bounce_decay', '反射衰减', 0, .95, .01, .5),
        *(slider('halo_'+c, label+'通道倍率', 0, 3, .01, 1)
          for c,label in [('r','红'),('g','绿'),('b','蓝')]),
    ],
    '颗粒': [
        choice('grain', '乳剂颗粒', {'off':'关', 'on':'开'}, 'off'),
        choice('grain_layers', '模拟子层', {'off':'关', 'on':'开'}, 'on'),
        slider('grain_area', '颗粒面积', .01, 3.2, .01, .2, 'µm²'),
        slider('grain_uniform', '颗粒均匀度倍率', .5, 1.03, .001, 1),
        slider('grain_blur', '颗粒模糊', 0, 2, .01, .65, 'px'),
        slider('grain_cloud', '染料云扩散', 0, 8, .1, 1, 'µm'),
        *(slider('grain_'+c, label+'通道粒径倍率', .25, 3, .01, 1)
          for c,label in [('r','红'),('g','绿'),('b','蓝')]),
    ],
    '光源': [
        choice('scene_light', '场景白点', {'':'sRGB · D65', **{k:v for k,v in LIGHTS.items() if k}}, ''),
        choice('film_light', '胶片参考光源', LIGHTS, ''),
        choice('enlarger_light', '放大机光源', {'':'卤素灯 + KG3', 'TH-KG3-L':'卤素灯 + KG3 + 镜头', **{k:v for k,v in LIGHTS.items() if k}}, ''),
        choice('scan_light', '扫描／观察光源', LIGHTS, ''),
        *(choice(key+'_mode', label+'模式', {'preset':'预设', 'kelvin':'自定义色温'}, 'preset')
          for key,label in [('scene','场景'),('film','胶片'),('scan','扫描')]),
        slider('scene_kelvin', '场景色温', 2000, 10000, 50, 6500, 'K'),
        slider('film_kelvin', '胶片色温', 2000, 10000, 50, 5500, 'K'),
        slider('scan_kelvin', '扫描色温', 2000, 10000, 50, 5000, 'K'),
    ],
}
CONTROLS = {c['key']: c for group in GROUPS.values() for c in group}


def interpreter():
    return next((path for path in PYTHONS if path.is_file()), None)


def catalog(stocks):
    profiles = {key: dict(label=label, family=('电影负片' if family == '电影负片'
                     else '增感负片' if family == '增感负片' else '彩色负片'), paper=paper)
                for key, (label, family, paper) in stocks.items()}
    profiles.update({key: dict(label=label, family='反转片', paper='') for key,label in SLIDES.items()})
    return dict(ready=interpreter() is not None, groups=GROUPS, stocks=profiles,
                renderers={'interactive':_interactive_worker.renderer, 'native':_native_worker.renderer})


def validate(value, stocks):
    if value == '':
        return ''
    if not isinstance(value, str) or len(value) > 8192:
        raise ValueError('光谱胶片配方格式无效')
    config = json.loads(value)
    if not isinstance(config, dict) or not isinstance(config.get('stock'), str) or config['stock'] not in {*stocks, *SLIDES}:
        raise ValueError('未知光谱胶片型号')
    if config.get('process') == 'negative' and config['stock'] in SLIDES:
        raise ValueError('实拍负片冲印需要选择负片型号')
    result = {'stock': config['stock']}
    for key, value in config.items():
        if key == 'stock':
            continue
        field = CONTROLS.get(key)
        if not field:
            raise ValueError('未知光谱胶片参数')
        if 'options' in field:
            if not isinstance(value, str) or value not in field['options']:
                raise ValueError('未知光谱胶片选项')
        elif type(value) not in (float, int) or not math.isfinite(value) or not field['min'] <= value <= field['max']:
            raise ValueError(f"{field['label']}超出范围")
        elif key.startswith('negative_base_') and 0 < value < .01:
            raise ValueError('片基参考必须为 0（自动）或至少 1%')
        if value != field['default']:
            result[key] = value
    return json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def enlargement(recipe):
    return int(json.loads(recipe.get('film_advanced') or '{}').get('enlarge', '1'))


def density_with_langmuir(original, density, log_raw, pixel_size, exposures,
                          curves, params, profile_type, gamma_factor=1.0, *, coefficients):
    from spektrafilm.model.couplers import compute_dir_couplers_matrix
    from spektrafilm.model.density_curves import interpolate_exposure_to_density

    if not params.active:
        return original(density, log_raw, pixel_size, exposures, curves, params,
                        profile_type, gamma_factor)
    maximum = np.nanmax(curves, axis=0)
    matrix = compute_dir_couplers_matrix(params) * params.amount

    def inhibition(dyes):
        silver = np.maximum(0, maximum-dyes if profile_type == 'positive' else dyes)
        return (silver / (1 + silver*coefficients)) @ matrix

    curve_exposures = exposures[:, None] - inhibition(curves)
    corrected_curves = np.column_stack([
        np.interp(exposures, np.maximum.accumulate(curve_exposures[:, c]), curves[:, c])
        for c in range(3)])
    correction = inhibition(density)
    if params.diffusion_size_um > 0:
        correction = coupler_diffusion(correction, params.diffusion_size_um/pixel_size,
                                       params.diffusion_tail_um/pixel_size, params.diffusion_tail_weight)
    return interpolate_exposure_to_density(log_raw-correction, corrected_curves, exposures, gamma_factor)


def coupler_diffusion(correction, sigma, tail, weight):
    """Same upstream Gaussian mixture, converting each colour plane only once."""
    from spektrafilm.utils.fast_gaussian_filter import fast_gaussian_filter, fast_exponential_filter
    for channel in range(3):
        plane = np.ascontiguousarray(correction[..., channel])
        blurred = (1-weight)*fast_gaussian_filter(plane, sigma) if weight != 1 else None
        if weight:
            extended = weight*fast_exponential_filter(plane, tail)
            blurred = extended if blurred is None else blurred+extended
        correction[..., channel] = blurred
    return correction


def coupler_correction(original, log_raw, density_cmy, density_max, dir_couplers_matrix,
                       diffusion_size_pixel, diffusion_tail_size_pixel=0.,
                       diffusion_exp_tail_weight=0., high_exposure_couplers_shift=0., positive=False):
    silver = density_max-density_cmy if positive else density_cmy
    if high_exposure_couplers_shift:
        silver = silver+high_exposure_couplers_shift*silver**2
    correction = silver @ dir_couplers_matrix
    if diffusion_size_pixel > 0:
        correction = coupler_diffusion(correction, diffusion_size_pixel,
                                       diffusion_tail_size_pixel, diffusion_exp_tail_weight)
    return log_raw-correction


def accelerated_gaussian(original,image,sigma,truncate=3.):
    from film_gpu import device,disable
    gpu=device()
    if gpu is not None and np.ndim(image) in (2,3):
        try:
            if image.ndim==2:return gpu.gaussian(image,float(sigma),truncate)
            sigmas=np.broadcast_to(np.asarray(sigma),(image.shape[2],))
            result=np.empty_like(image)
            for channel in range(image.shape[2]):
                result[...,channel]=gpu.gaussian(image[...,channel],float(sigmas[channel]),truncate)
            return result
        except ValueError:
            pass  # Capacity/FP64 limits keep the existing CPU spatial path.
        except (OSError,RuntimeError) as exc:
            print(f'Photo All spatial GPU fallback: {exc}',file=sys.stderr)
            disable()
    return original(image,sigma,truncate)


def accelerated_grain(original, density, pixel_size, grain, curves, layers, profile_type,
                      bypass_grain=False, use_fast_stats=False):
    """Independent GPU particle draws, one emulsion sublayer at a time."""
    if not grain.active or bypass_grain:
        return density
    from film_gpu import device, disable
    gpu = device()
    if gpu is None:
        return original(density, pixel_size, grain, curves, layers, profile_type,
                        bypass_grain=bypass_grain, use_fast_stats=use_fast_stats)
    from spektrafilm.utils.fast_gaussian_filter import fast_gaussian_filter
    from spektrafilm.model.grain import add_micro_structure
    minimum = np.asarray(grain.density_min)
    seed = int.from_bytes(os.urandom(4), 'little')
    try:
        result = np.zeros_like(density)
        if grain.sublayers_active:
            maximum = np.nanmax(layers, axis=0)
            fractions = maximum/maximum.sum(axis=0)
            for sublayer in range(3):
                low = fractions[sublayer]*minimum
                high = maximum[sublayer]+low
                particles = pixel_size**2*fractions[sublayer]/(
                    grain.particle_area_um2*np.asarray(grain.particle_scale)*grain.particle_scale_layers[sublayer])
                source, axes, layer = density, curves, layers[:,sublayer,:]
                # Some measured profiles have a slight reversal at the shoulder.
                # Preserve upstream searchsorted semantics for those profiles,
                # without falling back to nine full-frame CPU particle draws.
                if np.any(np.diff(-curves if profile_type=='positive' else curves,axis=0)<0):
                    from spektrafilm.utils.fast_interp import fast_interp
                    source = fast_interp(-density if profile_type=='positive' else density,
                                         -curves if profile_type=='positive' else curves,layer)
                    axes=layer=None
                drawn = gpu.grain_layer(source, axes, layer, low, high,
                                       particles, grain.uniformity, seed=(seed+sublayer*91771)&0xffffffff,
                                       positive=profile_type=='positive' and source is density)
                for channel in range(3):
                    sigma = grain.blur_dye_clouds_um*np.sqrt(high[channel]/particles[channel])
                    if sigma > 0:
                        drawn[...,channel] = fast_gaussian_filter(drawn[...,channel], sigma)
                result += drawn
            result = add_micro_structure(result, grain.micro_structure, pixel_size)
        else:
            high = np.nanmax(curves,axis=0)+minimum
            count = max(1,int(grain.n_sub_layers))
            particles = pixel_size**2/(grain.particle_area_um2*np.asarray(grain.particle_scale)*count)
            for sublayer in range(count):
                result += gpu.grain_layer(density,None,None,minimum,high,particles,grain.uniformity,
                                         seed=(seed+sublayer*91771)&0xffffffff)
            result /= count
        result -= minimum
        if grain.blur > (0 if grain.sublayers_active else .4):
            result = fast_gaussian_filter(result,grain.blur)
        return result
    except ValueError:
        pass  # A nonstandard profile can retain the upstream sampler.
    except (OSError,RuntimeError) as exc:
        print(f'Photo All GPU grain fallback: {exc}',file=sys.stderr)
        disable()
    return original(density,pixel_size,grain,curves,layers,profile_type,
                    bypass_grain=bypass_grain,use_fast_stats=use_fast_stats)


def adapt_scene(rgb, source_xy, quality):
    import colour
    srgb = colour.RGB_COLOURSPACES['sRGB']
    from film_gpu import device, disable
    gpu = device() if quality=='accelerated' else None
    if gpu is not None:
        matrix = colour.XYZ_to_RGB(colour.RGB_to_XYZ(np.eye(3),srgb),srgb,illuminant=source_xy)
        try:
            return gpu.colour_transform(rgb,matrix)
        except (OSError,RuntimeError) as exc:
            print(f'Photo All GPU colour fallback: {exc}',file=sys.stderr)
            disable()
    xyz = colour.RGB_to_XYZ(rgb,srgb,apply_cctf_decoding=True)
    return np.maximum(0,colour.XYZ_to_RGB(xyz,srgb,illuminant=source_xy,apply_cctf_encoding=True))


def protected_halation(original, raw, params, pixel_size, *, protection):
    if not params.active or not params.halation_amount:
        return original(raw, params, pixel_size)
    scattered = original(raw, replace(params, halation_amount=0), pixel_size)
    reflected = original(scattered, replace(params, scatter_amount=0), pixel_size)
    for start in range(0, len(raw), 64):
        rows = slice(start, start+64)
        mask = np.clip((scattered[rows].max(axis=2)-.18)/.82, 0, 1)
        weight = 1-protection*(1-mask*mask*(3-2*mask))
        reflected[rows] = scattered[rows]+(reflected[rows]-scattered[rows])*weight[..., None]
    return reflected


@contextlib.contextmanager
def replace_stage(module, name, callback, **options):
    from functools import partial

    original = getattr(module, name)
    setattr(module, name, partial(callback, original, **options))
    try:
        yield
    finally:
        setattr(module, name, original)


def morph_film_layers(profile, params):
    # The pinned upstream morph also returns the fitted sublayer parameters.
    # Rebuild all layers together so the grain simulator sees the same curves.
    from spektrafilm.utils.morph_curves import _layer_cdf, _morph_channel_params

    data = profile.data
    layers = np.empty_like(data.density_curves_layers)
    for channel in range(3):
        centres, amplitudes, sigmas, exhaustion = _morph_channel_params(
            data.density_curves_model, params, channel, profile.info.type)
        for index, (centre, amplitude, sigma, mix) in enumerate(zip(centres, amplitudes, sigmas, exhaustion)):
            layers[:, index, channel] = amplitude * _layer_cdf(
                (data.log_exposure - centre) / sigma, profile.info.type, float(mix))
    data.density_curves_layers = layers
    data.density_curves = layers.sum(axis=1)


def spectral_blocks(density, spectral_calculation, data_min, data_max, *, use_lut=False):
    # These two upstream spectral conversions are pointwise. Bound their
    # 81-band scratch arrays while leaving spatial effects on the whole image.
    block_size = 32_768
    flat = density.reshape(-1, 3)
    if len(flat) <= block_size:
        return spectral_calculation(density)
    first = spectral_calculation(flat[:block_size][None, ...])[0]
    result = np.empty(flat.shape, dtype=first.dtype)
    result[:block_size] = first
    for start in range(block_size, len(flat), block_size):
        block = flat[start:start+block_size]
        result[start:start+len(block)] = spectral_calculation(block[None, ...])[0]
    return result.reshape(density.shape)


_calculation = threading.local()
_color_luts = OrderedDict()
_pipelines = {}
_lut_engine_signature = None


def _lut_disk_root():
    return Path(os.environ.get('LOCALAPPDATA',tempfile.gettempdir()))/'PhotoAll'/'spectral-cache'/'setup-v1'


def _prepared_disk(key,steps,prepared=None):
    """Bounded, atomic, numeric-only setup cache shared by the two workers."""
    if steps>65:return None
    global _lut_engine_signature
    try:
        if _lut_engine_signature is None:
            import spektrafilm,importlib.metadata
            package=Path(spektrafilm.__file__).parent
            signature=hashlib.sha256(Path(__file__).read_bytes())
            for name in ('numpy','scipy','colour-science'):
                signature.update((name+importlib.metadata.version(name)).encode())
            for path in sorted(package.rglob('*')):
                if path.is_file() and '__pycache__' not in path.parts:
                    stat=path.stat()
                    signature.update(repr((str(path.relative_to(package)),stat.st_size,stat.st_mtime_ns)).encode())
            _lut_engine_signature=signature.digest()
        digest=hashlib.sha256(_lut_engine_signature+repr(key).encode()).hexdigest()
        root=_lut_disk_root();path=root/(digest+'.npz')
        if prepared is None:
            if not path.is_file() or path.stat().st_size>64*1024**2:return None
            with np.load(path,allow_pickle=False) as file:
                result=tuple(file[f'arr_{i}'] for i in range(6))
            for i,array in enumerate(result):
                expected=(steps if i<4 else steps-1,)*3+(3,)
                if array.shape!=expected or array.dtype!=np.float64 or not np.isfinite(array).all():return None
            # Timestamp is only cache recency; never touch the user's photos.
            path.touch()
            return result
        root.mkdir(parents=True,exist_ok=True)
        temporary=root/(digest+'.'+uuid.uuid4().hex+'.tmp')
        try:
            with temporary.open('wb') as stream:np.savez(stream,*prepared)
            os.replace(temporary,path)
        finally:
            temporary.unlink(missing_ok=True)
        entries=sorted(root.glob('*.npz'),key=lambda p:p.stat().st_mtime,reverse=True)
        total=0
        for entry in entries:
            total+=entry.stat().st_size
            if total>256*1024**2:entry.unlink(missing_ok=True)
    except (OSError,ValueError,KeyError,EOFError,ImportError,zipfile.BadZipFile):
        pass  # Disk/cache damage must never break rendering.
    return None


def calculation_quality():
    return getattr(_calculation, 'quality', 'accelerated')


@contextlib.contextmanager
def calculation_mode(quality):
    if quality not in {'accelerated', 'exact'}:
        raise ValueError('光谱计算模式无效')
    previous = calculation_quality()
    _calculation.quality = quality
    try:
        yield
    finally:
        _calculation.quality = previous


def prepare_pchip(table):
    """Vectorized uniform-grid PCHIP setup; no first-use compiler on UI work."""
    table=np.ascontiguousarray(table,np.float64)
    size=len(table)
    slopes=[]
    for axis in range(3):
        values=np.moveaxis(table,axis,0)
        delta=np.diff(values,axis=0)
        slope=np.zeros_like(values)
        if size==2:slope[:]=delta[0]
        elif size>2:
            before,after=delta[:-1],delta[1:]
            valid=(before*after)>0
            np.divide(2*before*after,before+after,out=slope[1:-1],where=valid)
            for index,a,b in ((0,delta[0],delta[1]),(-1,delta[-1],delta[-2])):
                end=(3*a-b)*.5
                slope[index]=np.where(end*a<=0,0,np.where((a*b<0)&(np.abs(end)>np.abs(3*a)),3*a,end))
        slopes.append(np.ascontiguousarray(np.moveaxis(slope,0,axis)))
    lower=table[:-1,:-1,:-1].copy();upper=lower.copy()
    for i in range(2):
        for j in range(2):
            for k in range(2):
                corner=table[i:i+size-1,j:j+size-1,k:k+size-1]
                np.minimum(lower,corner,out=lower);np.maximum(upper,corner,out=upper)
    return (table,*slopes,lower,upper)


def calibration_cubic(original,table,image):
    """Float64 Mitchell–Netravali interpolation for small setup grids."""
    size=len(table)
    if size<2:return np.broadcast_to(table[0,0],(*image.shape[:-1],table.shape[-1])).copy()
    coordinates=np.clip(np.asarray(image)*float(size-1),0,size-1)
    base=np.minimum(np.floor(coordinates).astype(np.int64),size-2)
    fraction=coordinates-base
    def weights(x):
        x=np.abs(x)
        return np.where(x<1,((7*x-12)*x*x+16/3)/6,
                        np.where(x<2,(((-7/3*x+12)*x-20)*x+32/3)/6,0))
    wx=[weights(fraction[...,0]+1-i) for i in range(4)]
    wy=[weights(fraction[...,1]+1-i) for i in range(4)]
    result=np.zeros((*image.shape[:-1],table.shape[-1]),np.float64)
    total=np.zeros(image.shape[:-1],np.float64)
    for i in range(4):
        x=np.abs(base[...,0]-1+i);x=np.where(x>=size,2*(size-1)-x,x)
        for j in range(4):
            y=np.abs(base[...,1]-1+j);y=np.where(y>=size,2*(size-1)-y,y)
            weight=wx[i]*wy[j]
            result+=table[x,y]*weight[...,None];total+=weight
    return result/total[...,None]


def calibration_curves(original,image,axes,values):
    if image.size>12288:return original(image,axes,values)
    result=np.empty_like(image)
    for channel in range(3):
        axis=axes if axes.ndim==1 else axes[:,channel]
        x=image[...,channel]
        at=np.clip(np.searchsorted(axis,x,side='right')-1,0,len(axis)-2)
        delta=axis[at+1]-axis[at]
        t=np.divide(x-axis[at],delta,out=np.zeros_like(x),where=delta!=0)
        v=values[:,channel]
        result[...,channel]=np.where(x<=axis[0],v[0],np.where(x>=axis[-1],v[-1],v[at]+t*(v[at+1]-v[at])))
    return result


@contextlib.contextmanager
def calibration_setup(enabled):
    with contextlib.ExitStack() as stack:
        if enabled:
            from spektrafilm.utils import spectral_upsampling
            from spektrafilm.model import density_curves
            stack.enter_context(replace_stage(spectral_upsampling,'apply_lut_cubic_2d',calibration_cubic))
            stack.enter_context(replace_stage(density_curves,'fast_interp',calibration_curves))
        yield


def bounded_lut(data, calculation, identity, low, high, *, steps=65):
    """Cache pointwise maps only; evaluate out-of-domain samples directly."""
    from spektrafilm.utils.lut import _create_lut_3d
    from spektrafilm.utils.fast_interp_lut import prepare_lut_pchip_3d, _apply_lut_pchip_3d_prepared

    low, high = np.asarray(low, dtype=np.float64), np.asarray(high, dtype=np.float64)
    key = (identity, tuple(low), tuple(high), steps)
    prepared = _color_luts.pop(key, None)
    if prepared is None:
        prepared=_prepared_disk(key,steps)
        if prepared is None:
            table = np.ascontiguousarray(_create_lut_3d(calculation, low, high, steps), dtype=np.float64)
            prepared = prepare_pchip(table)
            _prepared_disk(key,steps,prepared)
    _color_luts[key] = prepared
    while len(_color_luts) > 8 or sum(a.nbytes for entry in _color_luts.values() for a in entry) > 384*1024**2:
        _color_luts.popitem(last=False)
    from film_gpu import device, disable
    gpu = device() if data.size >= 12_288 else None
    if gpu is not None and steps <= 65:
        try:
            result = gpu.interpolate(data, prepared, key, low, high)
            outside = np.any((data < low) | (data > high), axis=-1)
            if np.any(outside):
                result[outside] = calculation(np.asarray(data[outside])[None, ...])[0]
            return result
        except (OSError, RuntimeError) as exc:
            print(f'Photo All Vulkan fallback: {exc}', file=sys.stderr)
            disable()
    result = np.empty(data.shape, dtype=np.float64)
    rows = max(1, 262144 // max(1, data.shape[1]))
    for start in range(0, data.shape[0], rows):
        values = np.asarray(data[start:start+rows], dtype=np.float64)
        block = result[start:start+rows]
        block[:] = _apply_lut_pchip_3d_prepared(*prepared, np.clip((values-low)/(high-low), 0, 1))
        outside = np.any((values < low) | (values > high), axis=-1)
        if np.any(outside):
            block[outside] = calculation(values[outside][None, ...])[0]
    return result


def accelerated_gamut(original, rgb, spec, *, output_color_space=None):
    if np.size(rgb) < 1_500_000 or spec.algorithm == 'off':
        return original(rgb, spec, output_color_space=output_color_space)
    # Signed, nonlinear coordinates retain much finer samples around black.
    encoded = np.arcsinh(np.asarray(rgb, dtype=np.float64)*32)
    def compute(grid):
        def compress_block(block):
            return original(np.sinh(block)/32, spec, output_color_space=output_color_space)
        return spectral_blocks(grid, compress_block, None, None)
    return bounded_lut(encoded, compute, ('gamut', repr(spec), output_color_space),
                       np.full(3, np.arcsinh(-32.)), np.full(3, np.arcsinh(512.)), steps=129)


def accelerated_pipeline(params, identity, quality):
    from spektrafilm.runtime.pipeline import SimulationPipeline

    fast = quality == 'accelerated'
    params.settings.use_enlarger_lut = fast
    params.settings.use_scanner_lut = fast
    params.settings.lut_resolution = 33
    if fast:
        params.settings.use_fast_stats = True
    pipeline = _pipelines.get(quality)
    with calibration_setup(fast):
        if pipeline is None:
            pipeline = SimulationPipeline(params)
            _pipelines[quality] = pipeline
        else:
            pipeline.update(params)
    service = pipeline._lut_service
    if not fast:
        service.spectral_compute_enlarger = spectral_blocks
        service.spectral_compute_scanner = spectral_blocks
        return pipeline
    install_gpu_spectral(pipeline)
    # Bounds and profile curves can change even if a handful of probe colors
    # happen to match. Rebuild the upstream tables after any recipe change.
    if getattr(pipeline, '_photo_all_identity', None) != identity:
        service.enlarger_lut_memory = service.scanner_lut_memory = None
        pipeline._photo_all_identity = identity
    filming = pipeline._filming_stage
    original_input = filming._rgb_to_film_raw
    input_identity = (json.loads(identity)[0], params.film.info.reference_illuminant)
    def input_map(rgb, **options):
        def compute(grid):
            with calibration_setup(True):return original_input(grid,**options)
        return bounded_lut(rgb, compute,
            ('film-input', input_identity, tuple(sorted(options.items()))), np.zeros(3), np.ones(3))
    filming._rgb_to_film_raw = input_map
    scanning = pipeline._scanning_stage
    original_scan = scanning.scan
    def scan(density):
        spatial = (not pipeline.io.scan_film and pipeline.print_render.glare.active)
        if spatial or pipeline.scanner.lens_blur or any(pipeline.scanner.unsharp_mask):
            return original_scan(density)
        profile = pipeline.film if pipeline.io.scan_film else pipeline.print
        low = (-np.asarray(pipeline.film_render.grain.density_min) if pipeline.io.scan_film
               else np.nanmin(profile.data.density_curves, axis=0))
        high = np.nanmax(profile.data.density_curves, axis=0)
        padding = np.maximum(high-low, .01)*.025
        def compute(grid):
            return scanning._apply_cctf_encoding(scanning._density_to_rgb(grid, use_lut=True))
        # The final scanner transform depends on the active dyes, viewing light
        # and the calibrated black/white endpoints. A new exposure alone need
        # not invalidate a table if those inputs are identical.
        from spektrafilm.model.illuminants import standard_illuminant
        reference = pipeline._color_reference_service
        scan_key = ('scanner-output', pipeline.io.scan_film,
                    profile.data.channel_density.tobytes(), profile.data.base_density.tobytes(),
                    np.asarray(standard_illuminant(profile.info.viewing_illuminant)).tobytes(),
                    tuple(np.asarray(v).tobytes() if v is not None else None for v in
                          (reference._y_black, reference._y_white, reference._black_level, reference._white_level)),
                    reference._black_correction, reference._white_correction,
                    pipeline.io.output_color_space, pipeline.io.output_cctf_encoding,
                    repr(pipeline.io.output_gamut_compress))
        return bounded_lut(density, compute, scan_key, low-padding, high+padding)
    scanning.scan = scan
    pipeline._topology = pipeline._build_topology()
    if pipeline._photo_all_print is not None and not pipeline.io.scan_film:
        from spektrafilm.runtime.topology import Node
        position = next(i for i, node in enumerate(pipeline._topology) if node.label == 'printing.expose')
        pipeline._topology[position:position+2] = [
            Node(('cmy_film',), ('cmy_print',), pipeline._photo_all_print, 'printing.gpu_expose_develop')]
    return pipeline


def install_gpu_spectral(pipeline):
    """Move the two wavelength integrals to Photo All's own GPU kernel."""
    from film_gpu import device, disable
    pipeline._photo_all_print = None
    gpu = device()
    if gpu is None:
        return
    from spektrafilm.config import STANDARD_OBSERVER_CMFS
    from spektrafilm.model.illuminants import standard_illuminant
    printing = pipeline._printing_stage
    original_print = printing._film_cmy_to_print_log_raw
    def print_spectrum(density):
        if density.size < 12_288:
            return original_print(density)
        light = standard_illuminant(pipeline.enlarger.illuminant)
        sensitivity = np.nan_to_num(10 ** pipeline.print.data.log_sensitivity)
        illumination = pipeline._enlarger_service.enlarger_filtered_illuminant(light)
        gain = printing._compute_exposure_factor_midgray(sensitivity, illumination)
        weights = np.asarray(illumination)[:, None] * sensitivity * np.asarray(gain).reshape(1, -1)
        offset = printing._compute_raw_preflash(light, sensitivity)
        try:
            return gpu.spectral(density, pipeline.film.data.channel_density,
                                pipeline.film.data.base_density, weights, 'printing', offset)
        except (OSError, RuntimeError) as exc:
            print(f'Photo All Vulkan fallback: {exc}', file=sys.stderr)
            disable()
            return original_print(density)
    printing._film_cmy_to_print_log_raw = print_spectrum
    original_expose, original_develop = printing.expose, printing.develop
    def print_combined(density):
        if density.size < 12_288 or pipeline.enlarger.diffusion_filter.active:
            return original_develop(original_expose(density))
        # Establish the same scalar black/white calibration using a tiny
        # reference. Fuse wavelength integration, exposure and paper development
        # in one dispatch instead of transferring two full intermediate frames.
        original_expose(density[:1, :1])
        light = standard_illuminant(pipeline.enlarger.illuminant)
        sensitivity = np.nan_to_num(10 ** pipeline.print.data.log_sensitivity)
        illumination = pipeline._enlarger_service.enlarger_filtered_illuminant(light)
        gain = printing._compute_exposure_factor_midgray(sensitivity, illumination)
        exposure = pipeline.enlarger.print_exposure * pipeline._color_reference_service.black_white_printing_exposure_correction()
        weights = np.asarray(illumination)[:, None] * sensitivity * np.asarray(gain * exposure).reshape(1, -1)
        offset = printing._compute_raw_preflash(light, sensitivity) * exposure
        from spektrafilm.utils.morph_curves import apply_print_curves_morph
        curves = apply_print_curves_morph(pipeline.print.data.log_exposure, pipeline.print.data.density_curves_model,
                                        pipeline.print_render.density_curves_morph, profile_type=pipeline.print.info.type)
        try:
            return gpu.spectral(density, pipeline.film.data.channel_density, pipeline.film.data.base_density,
                                weights, 'printing-developed', offset,
                                curves=(pipeline.print.data.log_exposure, curves, 1.))
        except (OSError, RuntimeError) as exc:
            print(f'Photo All Vulkan fallback: {exc}', file=sys.stderr)
            disable()
            return original_develop(original_expose(density))
    pipeline._photo_all_print = print_combined
    # The GPU evaluates wavelengths directly. Retain ordinary pointwise
    # references for tiny calibration grids and unsupported GPU hardware.
    pipeline._lut_service.spectral_compute_enlarger = spectral_blocks
    scanning = pipeline._scanning_stage
    original_scan = scanning.cmy_to_log_xyz
    def scan_spectrum(density):
        if density.size < 12_288:
            return original_scan(density)
        profile = pipeline.film if pipeline.io.scan_film else pipeline.print
        light = np.asarray(standard_illuminant(profile.info.viewing_illuminant))
        weights = light[:, None] * STANDARD_OBSERVER_CMFS.values / np.sum(light * STANDARD_OBSERVER_CMFS[:, 1])
        try:
            return gpu.spectral(density, profile.data.channel_density,
                                profile.data.base_density, weights, 'scanning')
        except (OSError, RuntimeError) as exc:
            print(f'Photo All Vulkan fallback: {exc}', file=sys.stderr)
            disable()
            return original_scan(density)
    scanning.cmy_to_log_xyz = scan_spectrum
    pipeline._color_reference_service.cmy_to_log_xyz = scan_spectrum
    pipeline._lut_service.spectral_compute_scanner = spectral_blocks


def illuminant_choice(values, role):
    if values[role+'_mode'] != 'kelvin':
        return values[role+'_light']
    import colour

    temperature = values[role+'_kelvin']
    if temperature < 4000:
        return f'BB{temperature:g}'
    name = f'Photo All CIE D {temperature:g}'
    if name not in colour.SDS_ILLUMINANTS:
        xy = colour.temperature.CCT_to_xy_CIE_D(temperature)
        colour.SDS_ILLUMINANTS[name] = colour.sd_CIE_illuminant_D_series(xy)
    return name


# Only these controls sit downstream of a developed negative. Unknown future
# controls automatically invalidate it until their dependencies are known.
_print_only = {field['key'] for group in ('冲印', '放大机滤色', '预闪') for field in GROUPS[group]}
_print_only.update(('enlarger_light', 'scan_light', 'scan_mode', 'scan_kelvin'))


def reprint_preview(pipeline, rgb, values):
    image = np.ascontiguousarray(rgb)
    key = (image.shape, image.dtype.str, hashlib.blake2b(memoryview(image), digest_size=16).digest(),
           tuple(sorted((k, v) for k, v in values.items() if k not in _print_only)))
    cached = getattr(pipeline, '_preview_negative', None)
    if cached is None or cached[0] != key:
        density = pipeline.process(image, collect='cmy_film')
        stored = density.astype(np.float32) if density.nbytes > 48*1024**2 else density
        pipeline._preview_negative = (key, stored, pipeline._resize_service.pixel_size_um)
    else:
        _, density, pipeline._resize_service.pixel_size_um = cached
    return pipeline.process(density, inject='cmy_film')


def simulate_array(rgb, config, paper, *, quality='accelerated', preview=False):
    from spektrafilm.model import develop
    from spektrafilm.runtime.stages import filming
    from spektrafilm.runtime.process import photo_params
    from spektrafilm.runtime.params_builder import digest_params
    from spektrafilm.utils.morph_curves import PrintCurvesMorphParams
    from spektrafilm.model.illuminants import standard_illuminant
    from spektrafilm.model.color_filters import color_enlarger
    import colour

    if quality not in {'accelerated', 'exact'}:
        raise ValueError('光谱计算模式无效')

    values = {key: field['default'] for key,field in CONTROLS.items()}
    values.update(config)
    negative_input = values['process'] == 'negative'
    scene_light = illuminant_choice(values, 'scene')
    film_light = illuminant_choice(values, 'film')
    scan_light = illuminant_choice(values, 'scan')
    p = photo_params(config['stock'], values['paper'] or paper)
    p.io.input_color_space = 'sRGB'
    p.io.input_cctf_decoding = True
    p.io.scan_film = values['process'] == 'scan' or (values['process'] == 'auto' and config['stock'] in SLIDES)
    p.io.upscale_factor = int(values['enlarge'])
    p.camera.auto_exposure = False
    p.camera.exposure_compensation_ev = 0 if negative_input else values['film_ev']
    p.camera.film_format_mm = values['film_format']
    p.scanner.unsharp_mask = (0., 0.)
    if film_light and not negative_input:
        p.film.info.reference_illuminant = film_light
    if scan_light:
        p.film.info.viewing_illuminant = p.print.info.viewing_illuminant = scan_light
    if values['enlarger_light']:
        p.enlarger.illuminant = values['enlarger_light']
    if scene_light and scene_light != 'D65' and not negative_input:
        source_xy = colour.XYZ_to_xy(colour.sd_to_XYZ(standard_illuminant(scene_light, True)))
        rgb = adapt_scene(rgb, source_xy, quality)
    p = digest_params(p)
    f, e = p.film_render, p.enlarger
    f.density_curve_gamma = 1 if negative_input else values['film_gamma']
    if not negative_input and (values['film_fast'] != 1 or values['film_slow'] != 1 or values['film_exhaustion']):
        morph_film_layers(p.film, PrintCurvesMorphParams(
            gamma_factor_fast=values['film_fast'], gamma_factor_slow=values['film_slow'],
            developer_exhaustion=values['film_exhaustion']))
    p.film.data.base_density = p.film.data.base_density * values['film_base']
    p.print.data.base_density = p.print.data.base_density * values['paper_base']
    e.print_exposure = 2 ** values['paper_ev']
    if values['neutral'] == 'manual':
        e.c_filter_neutral, e.m_filter_neutral, e.y_filter_neutral = (
            values['filter_c'], values['filter_m'], values['filter_y'])
    e.m_filter_shift, e.y_filter_shift = values['tune_m'], values['tune_y']
    if p.io.scan_film and config['stock'] in SLIDES:
        scan_cc = np.array([0., values['tune_m'], values['tune_y']])
        if values['neutral'] == 'manual':
            scan_cc += [values['filter_c'], values['filter_m'], values['filter_y']]
        if np.any(scan_cc):
            filtered = standard_illuminant(p.film.info.viewing_illuminant, True)
            filtered.values = color_enlarger(filtered.values, scan_cc)
            name = 'Photo All filtered slide scanner'
            colour.SDS_ILLUMINANTS[name] = filtered
            p.film.info.viewing_illuminant = name
    e.preflash_exposure = 2 ** values['preflash_ev'] if values['preflash'] == 'on' else 0
    e.preflash_m_filter_shift, e.preflash_y_filter_shift = values['preflash_m'], values['preflash_y']
    p.print_render.density_curves_morph = PrintCurvesMorphParams(
        gamma_factor=values['paper_gamma'], gamma_factor_fast=values['paper_fast'],
        gamma_factor_slow=values['paper_slow'], developer_exhaustion=values['paper_exhaustion'])
    p.print_render.glare.active = values['glare'] > 0
    p.print_render.glare.percent = values['glare'] * 100
    couplers = f.dir_couplers
    couplers.active = values['couplers'] == 'on'
    couplers.amount, couplers.inhibition_samelayer, couplers.inhibition_interlayer = (
        values['coupler_amount'], values['coupler_same'], values['coupler_inter'])
    couplers.diffusion_size_um, couplers.diffusion_tail_um, couplers.diffusion_tail_weight = (
        values['coupler_radius'], values['coupler_tail'], values['coupler_weight'])
    h = f.halation
    h.active = values['halation'] == 'on'
    h.halation_amount, h.halation_spatial_scale = values['halo_amount'], values['halo_radius']
    if values['halo_radius_um']:
        radii = np.asarray(h.halation_first_sigma_um)
        h.halation_first_sigma_um = tuple(radii * values['halo_radius_um'] / max(radii.max(), 1))
    h.scatter_amount, h.scatter_spatial_scale = values['scatter_amount'], values['scatter_radius']
    h.boost_ev, h.boost_range, h.protect_ev = values['highlight_boost'], values['boost_range'], values['protect_ev']
    h.halation_n_bounces, h.halation_bounce_decay = int(values['bounces']), values['bounce_decay']
    h.halation_strength = tuple(level * values['halo_'+c] for level,c in zip(h.halation_strength, 'rgb'))
    g = f.grain
    g.active = values['grain'] == 'on'
    g.sublayers_active = values['grain_layers'] == 'on'
    g.particle_area_um2, g.blur, g.blur_dye_clouds_um = values['grain_area'], values['grain_blur'], values['grain_cloud']
    g.uniformity = tuple(min(.999, level * values['grain_uniform']) for level in g.uniformity)
    g.particle_scale = tuple(level * values['grain_'+c] for level,c in zip(g.particle_scale, 'rgb'))
    identity = json.dumps([config['stock'], paper, values], sort_keys=True)
    pipeline = accelerated_pipeline(p, identity, quality)
    if negative_input:
        from film_negative import BASE_KEYS, scan_to_density

        density = scan_to_density(rgb, pipeline.film, tuple(values[key] for key in BASE_KEYS))
        density = pipeline._resize_service.crop_and_rescale(density)
        return np.asarray(pipeline.process(density, inject='cmy_film'), dtype=np.float32)
    coefficients = np.array([values['lang_'+c] for c in 'rgb'])
    with contextlib.ExitStack() as stack:
        if quality == 'accelerated':
            import importlib
            from spektrafilm.runtime.stages import scanning
            from spektrafilm.model import couplers as coupler_model
            for module_name in ('spektrafilm.utils.fast_gaussian_filter','spektrafilm.model.grain',
                                'spektrafilm.model.diffusion','spektrafilm.model.couplers'):
                module=importlib.import_module(module_name)
                if hasattr(module,'fast_gaussian_filter'):
                    stack.enter_context(replace_stage(module,'fast_gaussian_filter',accelerated_gaussian))
            stack.enter_context(replace_stage(scanning, 'compress_rgb', accelerated_gamut))
            stack.enter_context(replace_stage(coupler_model, 'compute_exposure_correction_dir_couplers',
                                              coupler_correction))
            stack.enter_context(replace_stage(develop, 'apply_grain', accelerated_grain))
        if couplers.active and np.any(coefficients):
            stack.enter_context(replace_stage(develop, 'apply_density_correction_dir_couplers',
                                               density_with_langmuir, coefficients=coefficients))
        if h.active and values['halo_midtones']:
            stack.enter_context(replace_stage(filming, 'apply_halation_um',
                                               protected_halation, protection=values['halo_midtones']))
        # Bound the single negative kept by each worker (float64 RGB).
        from film_gpu import device
        gpu = device() if quality == 'accelerated' else None
        budget = min(384*1024**2, gpu.memory//32) if gpu else 48*1024**2
        negative_bytes = rgb.size * 4 * p.io.upscale_factor**2
        if preview and quality == 'accelerated' and not p.io.scan_film and negative_bytes <= budget:
            return np.asarray(reprint_preview(pipeline, rgb, values), dtype=np.float32)
        return np.asarray(pipeline.process(rgb), dtype=np.float32)


_preview = threading.local()


class PreviewSuperseded(Exception):
    pass


@contextlib.contextmanager
def preview_task(current):
    previous = getattr(_preview, 'current', None)
    _preview.current = current
    try:
        check_preview()
        yield
    finally:
        _preview.current = previous


def check_preview():
    current = getattr(_preview, 'current', None)
    if current is not None and not current():
        raise PreviewSuperseded('预览已被新的调整替代')


class SpectralWorker:
    def __init__(self, interactive=False):
        self.interactive = interactive
        self.lock = threading.Lock()
        self.process = None
        self.responses = None
        self.renderer = None

    def stop(self):
        self.renderer = None
        if self.process is not None:
            process, self.process = self.process, None
            if process.poll() is None: process.kill()
            process.wait()
            process.stdin.close()
            process.stdout.close()

    def start(self, python):
        cache = Path(os.environ.get('LOCALAPPDATA', tempfile.gettempdir()))/'PhotoAll'/'spectral-cache'
        cache.mkdir(parents=True, exist_ok=True)
        env = {**os.environ, 'MPLBACKEND':'Agg', 'NUMBA_CACHE_DIR':str(cache),
               'MPLCONFIGDIR':str(cache), 'NUMBA_NUM_THREADS':str(min(4, os.cpu_count() or 1)),
               'OPENBLAS_NUM_THREADS':'2'}
        args = [str(python), '-B', str(Path(__file__)), '--worker', '--warmup']
        if self.interactive:
            args.append('--interactive')
        process = self.process = subprocess.Popen(args,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            encoding='utf-8', env=env, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        responses = self.responses = queue.Queue()
        def read():
            try:
                for line in process.stdout: responses.put(line)
            finally: responses.put('')
        threading.Thread(target=read, daemon=True).start()

    def call(self, python, root, config, paper, quality='accelerated', *, preview=False, shared=None):
        check_preview()
        if self.process is None or self.process.poll() is not None:
            self.stop()
            self.start(python)
        cancellation=None
        if shared and preview:
            cancellation=mmap.mmap(-1,4,tagname=shared['name']+'_cancel')
        try:
            self.process.stdin.write(json.dumps({'dir':str(root), 'config':config, 'paper':paper,
                                                'quality':quality, 'preview':preview, 'shared':shared})+'\n')
            self.process.stdin.flush()
            deadline = time.monotonic() + 300
            while True:
                if not self.interactive:
                    try: check_preview()
                    except PreviewSuperseded:
                        if cancellation is None:
                            self.stop()
                            raise
                        cancellation[0]=1
                try:
                    status = json.loads(self.responses.get(timeout=.05))
                    break
                except queue.Empty:
                    if time.monotonic() >= deadline: raise
        except (OSError, ValueError, queue.Empty) as exc:
            self.stop()
            raise RuntimeError('光谱引擎处理超时或意外退出') from exc
        finally:
            if cancellation is not None:cancellation.close()
        check_preview()
        if not status.get('ok'): raise ValueError('光谱成像失败：' + status['error'])
        self.renderer = status.get('renderer')


_native_worker = SpectralWorker()
_interactive_worker = SpectralWorker(interactive=True)


def prepare_preview():
    python = interpreter()
    if python is None:
        return
    for worker in (_interactive_worker, _native_worker):
        if not worker.lock.acquire(blocking=False):
            continue
        try:
            if worker.process is None or worker.process.poll() is not None:
                worker.stop()
                worker.start(python)
        finally:
            worker.lock.release()


def stop_worker():
    _native_worker.stop()
    _interactive_worker.stop()


atexit.register(stop_worker)


class RenderCache:
    """Separate bounded native/draft pools; every caller owns writable pixels."""
    def __init__(self, native_bytes=384*1024**2, small_bytes=24*1024**2):
        self.limits = (small_bytes, native_bytes)
        self.pools = (OrderedDict(), OrderedDict())
        self.lock = threading.Lock()

    @property
    def bytes(self):
        with self.lock:
            return sum(image.nbytes for pool in self.pools for image in pool.values())

    def clear(self):
        with self.lock:
            for pool in self.pools:
                pool.clear()

    def get(self, key):
        with self.lock:
            for pool in self.pools:
                image = pool.pop(key, None)
                if image is not None:
                    pool[key] = image
                    break
        return image.copy() if image is not None else None

    def put(self, key, image):
        slot = 0 if image.nbytes <= self.limits[0] else 1
        if image.nbytes > self.limits[slot]:
            return
        stored = image.copy()
        stored.setflags(write=False)
        with self.lock:
            pool = self.pools[slot]
            pool[key] = stored
            while len(pool) > 8 or sum(item.nbytes for item in pool.values()) > self.limits[slot]:
                pool.popitem(last=False)


_render_cache = RenderCache()


class SharedFrame:
    """One request's float32 input/output pages shared across Python versions."""
    def __init__(self, shape, scale=1, *, name=None):
        shape = tuple(shape)
        if (len(shape) != 3 or shape[-1] != 3
                or any(type(value) is not int or value <= 0 for value in shape)
                or scale not in (1, 2, 4)):
            raise ValueError('Invalid shared spectral frame')
        output = (shape[0]*scale, shape[1]*scale, 3)
        offset = math.prod(shape)*4
        size = offset+math.prod(output)*4
        name = name or 'PhotoAllFilm_'+uuid.uuid4().hex
        self.mapping = mmap.mmap(-1, size, tagname=name)
        self.cancellation=None
        try:
            self.cancellation=mmap.mmap(-1,4,tagname=name+'_cancel')
            self.input = np.ndarray(shape, np.float32, buffer=self.mapping)
            self.output = np.ndarray(output, np.float32, buffer=self.mapping, offset=offset)
        except Exception:
            self.mapping.close()
            if self.cancellation is not None:self.cancellation.close()
            raise
        self.metadata = {'name':name, 'shape':shape, 'output_shape':output, 'bytes':size}

    def __enter__(self):
        return self

    def cancelled(self):
        return self.cancellation[0]!=0

    def __exit__(self, *args):
        self.input = self.output = None
        self.mapping.close()
        self.cancellation.close()


def render(rgb, recipe, stocks, *, preview=False):
    python = interpreter()
    if python is None:
        raise RuntimeError('光谱引擎未安装，请重新安装完整 Photo All Studio')
    config = json.loads(recipe['film_advanced'])
    scale = enlargement(recipe)
    height, width = rgb.shape[:2]
    if scale > 1 and height * width * scale * scale > MAX_ENLARGED_PIXELS:
        raise ValueError('印片放大超过 3200 万像素，请降低倍率或选择较小的导出尺寸')
    paper = stocks.get(config['stock'], ('', '', 'kodak_portra_endura'))[2]
    worker = _interactive_worker if preview and max(height, width) <= 768 else _native_worker
    quality = calculation_quality()
    image = np.ascontiguousarray(rgb, dtype=np.float32)
    key = (image.shape, hashlib.blake2b(memoryview(image), digest_size=16).digest(),
           json.dumps(config, sort_keys=True, separators=(',', ':')), paper, quality)
    check_preview()
    cached = _render_cache.get(key) if quality == 'accelerated' else None
    if cached is not None:
        check_preview()
        return cached
    while not worker.lock.acquire(timeout=.05):
        check_preview()
    try:
        check_preview()
        cached = _render_cache.get(key) if quality == 'accelerated' else None
        if cached is not None:
            check_preview()
            return cached
        frame = None
        if os.name == 'nt':
            try:
                frame = SharedFrame(image.shape, scale)
            except (OSError, MemoryError):
                pass  # A constrained Windows commit limit can use disk instead.
        if frame is not None:
            with frame:
                frame.input[:] = image
                worker.call(python, None, config, paper, quality, preview=preview, shared=frame.metadata)
                result = frame.output.copy()
        else:
            with tempfile.TemporaryDirectory(prefix='photo-all-spectral-') as directory:
                root = Path(directory)
                np.save(root/'input.npy', image, allow_pickle=False)
                worker.call(python, root, config, paper, quality, preview=preview)
                result = np.load(root/'output.npy', allow_pickle=False)
        if result.shape != (height*scale, width*scale, 3) or not np.isfinite(result).all():
            raise ValueError('光谱引擎返回了无效像素')
        check_preview()
        if quality == 'accelerated':
            _render_cache.put(key, result)
        return result
    finally:
        worker.lock.release()


if __name__ == '__main__' and '--worker' in sys.argv:
    if '--warmup' in sys.argv or '--interactive' in sys.argv:
        # Start loading scientific libraries while the user browses stocks.
        with contextlib.redirect_stdout(sys.stderr):
            from spektrafilm.runtime.process import photo_params
            from spektrafilm.runtime.pipeline import SimulationPipeline
            from film_gpu import device
            device()
            if '--interactive' not in sys.argv:
                # Native and draft use separate processes. Prime native-only
                # filter dispatch/calibration while the user browses stocks,
                # rather than charging those first-use costs to a 24 MP frame.
                gpu=device()
                if gpu is not None:
                    try:gpu.gaussian(np.zeros((16,16),np.float32),5.)
                    except ValueError:pass
                    except (OSError,RuntimeError) as exc:
                        from film_gpu import disable
                        print(f'Photo All spatial warmup fallback: {exc}',file=sys.stderr)
                        disable()
                else:
                    from spektrafilm.utils.fast_gaussian_filter import fast_gaussian_filter
                    fast_gaussian_filter(np.zeros((16,16), np.float64), 5.)
                # Do not bake an unrelated default stock here. The interactive
                # worker prepares the user's actual stock and shares its setup
                # cache with native; competing default bakes delay first paint.
    for line in sys.stdin:
        try:
            request = json.loads(line)
            with contextlib.redirect_stdout(sys.stderr):
                options = dict(quality=request.get('quality', 'accelerated'), preview=request.get('preview', False))
                if shared := request.get('shared'):
                    scale = int(request['config'].get('enlarge', 1))
                    with SharedFrame(shared['shape'], scale, name=shared['name']) as frame:
                        if frame.metadata['bytes'] != shared['bytes']:
                            raise ValueError('Shared spectral frame size mismatch')
                        from film_gpu import work_task
                        with preview_task(lambda:not frame.cancelled()),work_task(check_preview):
                            result = simulate_array(frame.input, request['config'], request['paper'], **options)
                        if result.shape != frame.output.shape:
                            raise ValueError('Spectral output dimensions changed')
                        frame.output[:] = result
                else:
                    folder = Path(request['dir'])
                    result = simulate_array(np.load(folder/'input.npy', allow_pickle=False),
                                            request['config'], request['paper'], **options)
                    np.save(folder/'output.npy', result, allow_pickle=False)
                del result
            from film_gpu import device
            gpu = device() if request.get('quality', 'accelerated') == 'accelerated' else None
            print(json.dumps({'ok':True, 'renderer':{'backend':'vulkan' if gpu else 'cpu',
                              'device':gpu.device if gpu else None}}), flush=True)
        except Exception as exc:
            print(json.dumps({'error':str(exc)}), flush=True)
