# SPDX-License-Identifier: GPL-3.0-or-later
"""Spektrafilm colour LUT bridge and Photo All creative effects.

Normal rendering uses Pillow's compiled 3D LUT filter, with no spectral runtime
in the UI service. `--setup` prepares the isolated official reference engine;
`--bake` runs under its Python 3.13 environment and records every asset's source.
Grain and halation below are Photo All effects, not Spektrafilm's physical model.
"""
from functools import lru_cache
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import numpy as np
from PIL import Image, ImageChops, ImageFilter

ROOT = Path(__file__).resolve().parent
LUTS = ROOT / 'engines' / 'film-luts'
RUNTIME = ROOT / 'engines' / 'film-runtime' / 'Scripts' / 'python.exe'
REVISION = '3bb2c2d2801ff68b92019cf1dbcbb133d60832bc'
SOURCE = 'https://github.com/andreavolpato/spektrafilm'
ATTRIBUTION = 'Film colour powered by spektrafilm by Andrea Volpato; profiles and LUTs CC BY-SA 4.0.'
STOCKS = {
    'kodak_portra_160': ('Kodak Portra 160', '人像负片', 'kodak_portra_endura'),
    'kodak_portra_400': ('Kodak Portra 400', '人像负片', 'kodak_portra_endura'),
    'kodak_portra_800': ('Kodak Portra 800', '人像负片', 'kodak_portra_endura'),
    'kodak_portra_800_push1': ('Kodak Portra 800 +1', '增感负片', 'kodak_portra_endura'),
    'kodak_portra_800_push2': ('Kodak Portra 800 +2', '增感负片', 'kodak_portra_endura'),
    'kodak_gold_200': ('Kodak Gold 200', '日常负片', 'kodak_portra_endura'),
    'kodak_ektar_100': ('Kodak Ektar 100', '风光负片', 'kodak_portra_endura'),
    'kodak_ultramax_400': ('Kodak Ultramax 400', '日常负片', 'kodak_portra_endura'),
    'fujifilm_c200': ('Fujifilm C200', '日常负片', 'fujifilm_crystal_archive_typeii'),
    'fujifilm_pro_400h': ('Fujifilm Pro 400H', '人像负片', 'fujifilm_crystal_archive_typeii'),
    'fujifilm_xtra_400': ('Fujifilm X-TRA 400', '日常负片', 'fujifilm_crystal_archive_typeii'),
    'kodak_vision3_50d': ('Kodak Vision3 50D', '电影负片', 'kodak_2383'),
    'kodak_vision3_250d': ('Kodak Vision3 250D', '电影负片', 'kodak_2383'),
    'kodak_vision3_200t': ('Kodak Vision3 200T', '电影负片', 'kodak_2383'),
    'kodak_vision3_500t': ('Kodak Vision3 500T', '电影负片', 'kodak_2383'),
    'kodak_verita_200d': ('Kodak Verita 200D', '日光负片', 'kodak_portra_endura'),
}
CREATIVE = {
    'cinema': ('电影叙事', 1.16, .78, -.02, .015),
    'soft': ('柔光人像', .88, .87, .05, .025),
    'matte': ('哑光日常', .90, .75, .02, .065),
    'teal_orange': ('青橙映像', 1.13, 1.10, .04, .01),
    'vintage': ('褪色记忆', .91, .68, .10, .05),
    'highkey': ('明亮空气', .85, .82, .01, .07),
    'night': ('蓝调夜色', 1.21, .86, -.12, .005),
    'autumn': ('秋日琥珀', 1.08, .93, .14, .015),
    'forest': ('森林绿意', 1.05, .88, -.035, .02),
    'rose': ('玫瑰微光', .96, .85, .06, .035),
    'sepia': ('棕褐旧照', 1.04, 0, .0, .02),
    'cyanotype': ('蓝晒印相', 1.15, 0, .0, .01),
}


def stock_ready(stock):
    if stock not in STOCKS or not (LUTS / (stock + '.npy')).is_file():
        return False
    try:
        metadata = json.loads((LUTS / (stock + '.json')).read_text(encoding='utf-8'))
        return metadata.get('revision') == REVISION and metadata.get('resolution', 0) >= 33
    except (OSError, ValueError):
        return False


def catalog():
    return {'engine': 'spektrafilm 0.3.4', 'mode': 'sRGB 33³ LUT', 'revision': REVISION,
            'attribution': ATTRIBUTION, 'source': SOURCE,
            'stocks': {key: {'label': value[0], 'family': value[1], 'paper': value[2], 'ready': stock_ready(key)}
                       for key, value in STOCKS.items()}}


@lru_cache(maxsize=6)
def load_lut(stock, modified):
    table = np.load(LUTS / (stock + '.npy'), allow_pickle=False)
    if table.shape != (33, 33, 33, 3) or not np.isfinite(table).all():
        raise ValueError('胶片 LUT 无效，请重新准备胶片资源')
    # Both the upstream builder and Pillow use R-fastest, then G, then B.
    return ImageFilter.Color3DLUT(33, table.reshape(-1).tolist(), channels=3, target_mode='RGB')


def apply_film(image, recipe):
    stock, strength = recipe['film_stock'], float(recipe['film_strength'])
    if stock == 'none' or strength == 0:
        return image
    if not stock_ready(stock):
        raise ValueError('胶片资源未就绪，请运行 python film.py --setup')
    path = LUTS / (stock + '.npy')
    output = image.filter(load_lut(stock, path.stat().st_mtime_ns))
    halation, grain = float(recipe['film_halation']), float(recipe['film_grain'])
    if halation:
        highlights = image.convert('L').point([max(0, round((v - 180) / 75 * 255 * halation)) for v in range(256)])
        highlights = highlights.filter(ImageFilter.GaussianBlur(max(image.size) / 1600 * 6))
        glow = Image.new('RGB', image.size, '#bd4822')
        output = Image.composite(ImageChops.screen(output, glow), output, highlights)
    if grain:
        width = max(1,round(1600 * image.width / max(image.size)))
        height = max(1,round(1600 * image.height / max(image.size)))
        field = grain_field(stock,width,height).point([round(128+(v-128)*grain) for v in range(256)])
        field = field.resize(image.size, Image.Resampling.BILINEAR)
        output = ImageChops.add(output, field.convert('RGB'), offset=-128)
    return Image.blend(image, output, strength) if strength != 1 else output


@lru_cache(maxsize=4)
def grain_field(stock,width,height):
    seed = int(hashlib.sha256(stock.encode()).hexdigest()[:8],16)
    noise = np.random.default_rng(seed).normal(128,13,(height,width))
    return Image.fromarray(np.clip(noise,0,255).astype(np.uint8))


@lru_cache(maxsize=12)
def creative_lut(style):
    _, contrast, saturation, temperature, lift = CREATIVE[style]
    def grade(r, g, b):
        y = .2126*r + .7152*g + .0722*b
        if style == 'sepia':
            r, g, b = y*1.10+.04, y*.91+.025, y*.69+.01
        elif style == 'cyanotype':
            r, g, b = y*.54, y*.78+.035, y*.90+.09
        else:
            r, g, b = (y+(c-y)*saturation for c in (r,g,b))
            r *= 1+temperature
            b *= 1-temperature
            if style in {'cinema','teal_orange'}:
                b += (1-y)*.045;g += (1-y)*.022;r += y*.025
            elif style == 'forest':g += .025*(1-y)
            elif style == 'rose':r += .03;b += .015;g -= .012
        return tuple(max(0,min(1,(c-.5)*contrast+.5+lift)) for c in (r,g,b))
    return ImageFilter.Color3DLUT.generate(17, grade)


def apply_creative(image, style):
    return image.filter(creative_lut(style)) if style in CREATIVE else image


def bake_stocks(stocks=None):
    from spektrafilm_lut_creator.builders import BundleBuilder
    from spektrafilm_lut_creator.bundles import BundleSpec
    from importlib.resources import files
    LUTS.mkdir(parents=True, exist_ok=True)
    license_path = files('spektrafilm').joinpath('data/license/SPEKTRAFILM_LICENSE.txt')
    (LUTS / 'SPEKTRAFILM_LICENSE.txt').write_text(license_path.read_text(encoding='utf-8'), encoding='utf-8')
    for stock in stocks or STOCKS:
        if stock_ready(stock):
            print('READY ' + stock, flush=True)
            continue
        label, family, paper = STOCKS[stock]
        spec = BundleSpec(film_profile=stock, print_profiles=(paper,), input_color_space='sRGB',
                          output_color_space='sRGB', resolution=33, stops_above_midgray=None)
        bundle = BundleBuilder(spec).build()
        table = bundle.luts[0][1].table.astype(np.float32)
        if table.shape != (33,33,33,3) or not np.isfinite(table).all():
            raise RuntimeError('Invalid official simulation output: ' + stock)
        temporary = LUTS / (stock + '.tmp')
        with temporary.open('wb') as stream: np.save(stream, table, allow_pickle=False)
        os.replace(temporary, LUTS / (stock + '.npy'))
        metadata = {'stock': stock, 'label': label, 'paper': paper, 'family': family,
                    'source': SOURCE, 'revision': REVISION, 'resolution': 33,
                    'input': 'sRGB encoded', 'output': 'sRGB encoded', 'stops_above_midgray': None,
                    'attribution': ATTRIBUTION, 'license': 'CC BY-SA 4.0',
                    'modified': 'Generated using official BundleBuilder; reshaped to NumPy storage by Photo All',
                    'spatial_effects': False, 'sha256': hashlib.sha256((LUTS/(stock+'.npy')).read_bytes()).hexdigest()}
        (LUTS / (stock + '.json')).write_text(json.dumps(metadata,ensure_ascii=False,indent=2),encoding='utf-8')
        print('READY ' + stock, flush=True)
    (LUTS / 'CHANGELOG.txt').write_text('Photo All: generated 33^3 sRGB-to-sRGB LUTs with official spektrafilm BundleBuilder, revision '+REVISION+'. Stored unaltered float32 colour samples as NumPy arrays. Grain and halation are not baked.\n'+ATTRIBUTION,encoding='utf-8')


def setup():
    import tarfile
    import urllib.request
    uv = shutil.which('uv')
    if not uv: raise RuntimeError('请先安装 uv：https://docs.astral.sh/uv/getting-started/installation/')
    environment = {**os.environ, 'UV_CACHE_DIR': str(ROOT/'engines/uv-cache'),
                   'UV_PYTHON_INSTALL_DIR': str(ROOT/'engines/python')}
    if not RUNTIME.is_file():
        subprocess.run([uv,'venv',str(RUNTIME.parents[1]),'--python','3.13.13','--managed-python'],env=environment,check=True)
    source_parent = ROOT/'engines/spektrafilm-source'
    sources = list(source_parent.glob('*/pyproject.toml'))
    if not sources:
        source_parent.mkdir(parents=True,exist_ok=True)
        archive = source_parent/'source.tar.gz'
        urllib.request.urlretrieve(SOURCE+'/archive/'+REVISION+'.tar.gz',archive)
        with tarfile.open(archive) as bundle: bundle.extractall(source_parent,filter='data')
        sources = list(source_parent.glob('*/pyproject.toml'))
    dependencies = ['numpy==2.5.4','scipy==1.18.1','colour-science==0.4.7','scikit-image==0.26.0',
                    'matplotlib==3.11.2','opt-einsum==3.4.0','numba==0.68.1','OpenImageIO==3.1.19.0',
                    'pyfftw==0.15.1','rawpy==0.26.1','exiv2==0.18.1','lensfunpy==1.18.0',
                    'Pillow==12.3.0','markdown==3.11.2']
    subprocess.run([uv,'pip','install','--python',str(RUNTIME),*dependencies],env=environment,check=True)
    subprocess.run([uv,'pip','install','--python',str(RUNTIME),'--no-deps',str(sources[0].parent)],env=environment,check=True)
    subprocess.run([str(RUNTIME),str(Path(__file__)),'--bake'],check=True)


if __name__ == '__main__':
    if '--setup-filters' in sys.argv:
        import open_filters
        open_filters.setup()
    elif '--setup' in sys.argv: setup()
    elif '--bake' in sys.argv: bake_stocks(sys.argv[sys.argv.index('--bake')+1:] or None)
    else: print(json.dumps(catalog(),ensure_ascii=False,indent=2))
