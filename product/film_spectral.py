# SPDX-License-Identifier: GPL-3.0-or-later
"""Recipe schema and float-array bridge to the isolated Spektrafilm runtime."""
import atexit
import contextlib
from dataclasses import replace
import json
import math
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading

import numpy as np

ROOT = Path(__file__).resolve().parent
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
    return dict(ready=interpreter() is not None, groups=GROUPS, stocks=profiles)


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
    from spektrafilm.utils.fast_gaussian_filter import fast_exponential_filter, fast_gaussian_filter

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
        weight = params.diffusion_tail_weight
        correction = ((1-weight)*fast_gaussian_filter(correction, params.diffusion_size_um/pixel_size)
                      + weight*fast_exponential_filter(correction, params.diffusion_tail_um/pixel_size))
    return interpolate_exposure_to_density(log_raw-correction, corrected_curves, exposures, gamma_factor)


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


def simulate_array(rgb, config, paper):
    from spektrafilm.model import develop
    from spektrafilm.runtime.stages import filming
    from spektrafilm.runtime.pipeline import SimulationPipeline
    from spektrafilm.runtime.process import photo_params
    from spektrafilm.runtime.params_builder import digest_params
    from spektrafilm.utils.morph_curves import PrintCurvesMorphParams
    from spektrafilm.model.illuminants import standard_illuminant
    from spektrafilm.model.color_filters import color_enlarger
    import colour

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
        srgb = colour.RGB_COLOURSPACES['sRGB']
        xyz = colour.RGB_to_XYZ(rgb, srgb, apply_cctf_decoding=True)
        rgb = np.maximum(0, colour.XYZ_to_RGB(xyz, srgb, illuminant=source_xy, apply_cctf_encoding=True))
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
    pipeline = SimulationPipeline(p)
    pipeline._lut_service.spectral_compute_enlarger = spectral_blocks
    pipeline._lut_service.spectral_compute_scanner = spectral_blocks
    if negative_input:
        from film_negative import BASE_KEYS, scan_to_density

        density = scan_to_density(rgb, pipeline.film, tuple(values[key] for key in BASE_KEYS))
        density = pipeline._resize_service.crop_and_rescale(density)
        return np.asarray(pipeline.process(density, inject='cmy_film'), dtype=np.float32)
    coefficients = np.array([values['lang_'+c] for c in 'rgb'])
    with contextlib.ExitStack() as stack:
        if couplers.active and np.any(coefficients):
            stack.enter_context(replace_stage(develop, 'apply_density_correction_dir_couplers',
                                               density_with_langmuir, coefficients=coefficients))
        if h.active and values['halo_midtones']:
            stack.enter_context(replace_stage(filming, 'apply_halation_um',
                                               protected_halation, protection=values['halo_midtones']))
        return np.asarray(pipeline.process(rgb), dtype=np.float32)


_lock = threading.Lock()
_process = None
_responses = None


def stop_worker():
    global _process
    if _process is not None:
        process, _process = _process, None
        process.kill()
        process.wait()
        process.stdin.close()
        process.stdout.close()


atexit.register(stop_worker)


def start_worker(python):
    global _process, _responses
    cache = Path(os.environ.get('LOCALAPPDATA', tempfile.gettempdir()))/'PhotoAll'/'spectral-cache'
    cache.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, 'MPLBACKEND':'Agg', 'NUMBA_CACHE_DIR':str(cache),
           'MPLCONFIGDIR':str(cache), 'NUMBA_NUM_THREADS':str(min(4, os.cpu_count() or 1)),
           'OPENBLAS_NUM_THREADS':'2'}
    process = _process = subprocess.Popen([str(python), '-B', str(Path(__file__)), '--worker'],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        encoding='utf-8', env=env, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    responses = _responses = queue.Queue()

    def read():
        try:
            for line in process.stdout:
                responses.put(line)
        finally:
            responses.put('')

    threading.Thread(target=read, daemon=True).start()


def render(rgb, recipe, stocks):
    python = interpreter()
    if python is None:
        raise RuntimeError('光谱引擎未安装，请重新安装完整 Photo All Studio')
    config = json.loads(recipe['film_advanced'])
    scale = enlargement(recipe)
    height, width = rgb.shape[:2]
    if scale > 1 and height * width * scale * scale > MAX_ENLARGED_PIXELS:
        raise ValueError('印片放大超过 3200 万像素，请降低倍率或选择较小的导出尺寸')
    paper = stocks.get(config['stock'], ('', '', 'kodak_portra_endura'))[2]
    with _lock, tempfile.TemporaryDirectory(prefix='photo-all-spectral-') as directory:
        root = Path(directory)
        np.save(root/'input.npy', np.ascontiguousarray(rgb, dtype=np.float32), allow_pickle=False)
        if _process is None or _process.poll() is not None:
            stop_worker()
            start_worker(python)
        try:
            _process.stdin.write(json.dumps({'dir':str(root), 'config':config, 'paper':paper})+'\n')
            _process.stdin.flush()
            status = json.loads(_responses.get(timeout=300))
        except (OSError, ValueError, queue.Empty) as exc:
            stop_worker()
            raise RuntimeError('光谱引擎处理超时或意外退出') from exc
        if not status.get('ok'):
            raise ValueError('光谱成像失败：' + status['error'])
        result = np.load(root/'output.npy', allow_pickle=False)
        if result.shape != (height*scale, width*scale, 3) or not np.isfinite(result).all():
            raise ValueError('光谱引擎返回了无效像素')
        return result


if __name__ == '__main__' and '--worker' in sys.argv:
    for line in sys.stdin:
        try:
            request = json.loads(line)
            folder = Path(request['dir'])
            with contextlib.redirect_stdout(sys.stderr):
                result = simulate_array(np.load(folder/'input.npy', allow_pickle=False),
                                        request['config'], request['paper'])
            np.save(folder/'output.npy', result, allow_pickle=False)
            print('{"ok": true}', flush=True)
        except Exception as exc:
            print(json.dumps({'error':str(exc)}), flush=True)
