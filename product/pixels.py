# SPDX-License-Identifier: GPL-3.0-or-later
"""Float32, encoded-sRGB photo pipeline; quantize only at the output boundary.

PNG/TIFF are decoded at their source precision. RGB ICC transforms use LCMS
float samples, and never route 16-bit RGB through Pillow's 8-bit RGB mode.
Lossless export refers to the encoded output samples, not a reversible edit.
"""
from __future__ import annotations

import ctypes
from functools import lru_cache
import hashlib
import json
import math
from io import BytesIO
from pathlib import Path
import os
import sys

import numpy as np
from PIL import Image, ImageCms

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / 'engines' / 'precision-packages'))
import png
import tifffile

SRGB = ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()
TILE = 65536


def _orient(array, orientation):
    if orientation == 2: return array[:, ::-1]
    if orientation == 3: return array[::-1, ::-1]
    if orientation == 4: return array[::-1]
    if orientation == 5: return array.transpose(1, 0, 2)
    if orientation == 6: return np.rot90(array, 3)
    if orientation == 7: return array.transpose(1, 0, 2)[::-1, ::-1]
    if orientation == 8: return np.rot90(array)
    return array


@lru_cache(maxsize=1)
def _lcms():
    candidates = list((ROOT / 'engines').glob('*/*/liblcms2-2.dll'))
    try:
        if os.name == 'nt' and candidates:
            with os.add_dll_directory(str(candidates[-1].parent)):
                lib = ctypes.CDLL(str(candidates[-1]))
        else:
            from ctypes.util import find_library
            name = find_library('lcms2')
            if not name: raise OSError('LCMS2 unavailable')
            lib = ctypes.CDLL(name)
    except OSError as exc:
        raise ValueError('ICC 高精度转换需要 LittleCMS 2；未进行 8-bit 降级') from exc
    definitions = {
        'cmsOpenProfileFromMem': ([ctypes.c_void_p, ctypes.c_uint32], ctypes.c_void_p),
        'cmsCreate_sRGBProfile': ([], ctypes.c_void_p),
        'cmsGetColorSpace': ([ctypes.c_void_p], ctypes.c_uint32),
        'cmsCreateTransform': ([ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p,
                                ctypes.c_uint32, ctypes.c_uint32, ctypes.c_uint32], ctypes.c_void_p),
        'cmsDoTransform': ([ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32], None),
        'cmsDeleteTransform': ([ctypes.c_void_p], None),
        'cmsCloseProfile': ([ctypes.c_void_p], ctypes.c_int),
    }
    for name, (arguments, result) in definitions.items():
        function = getattr(lib, name)
        function.argtypes, function.restype = arguments, result
    return lib


def _convert_icc(array, profile, grayscale=False):
    if not profile or profile == SRGB:
        return array
    lib = _lcms()
    memory = ctypes.create_string_buffer(profile)
    source = lib.cmsOpenProfileFromMem(memory, len(profile))
    if not source:
        raise ValueError('无法读取此图片的 ICC 色彩配置')
    destination = transform = None
    try:
        signature = lib.cmsGetColorSpace(source)
        expected = 0x47524159 if grayscale else 0x52474220  # GRAY / RGB
        if signature != expected:
            raise ValueError('ICC 色彩空间与图片通道不一致；未进行 8-bit 降级')
        # Use the exact published output profile; different LCMS builds may
        # generate slightly different rounded sRGB matrices/TRCs.
        destination_memory = ctypes.create_string_buffer(SRGB)
        destination = lib.cmsOpenProfileFromMem(destination_memory, len(SRGB))
        rgb_float = (1 << 22) | (4 << 16) | (3 << 3) | 4
        gray_float = (1 << 22) | (3 << 16) | (1 << 3) | 4
        transform = lib.cmsCreateTransform(source, gray_float if grayscale else rgb_float,
                                          destination, rgb_float, 1, 0x2000)
        if not transform:
            raise ValueError('无法创建 ICC 高精度色彩转换')
        flat = array.reshape(-1, array.shape[-1])
        for start in range(0, len(flat), TILE):
            end = start + TILE
            samples = np.ascontiguousarray(flat[start:end, :1 if grayscale else 3])
            converted = np.empty((len(samples), 3), np.float32)
            lib.cmsDoTransform(transform, samples.ctypes.data, converted.ctypes.data, len(samples))
            flat[start:end, :3] = converted
        return np.clip(array, 0, 1, out=array)
    finally:
        if transform: lib.cmsDeleteTransform(transform)
        if destination: lib.cmsCloseProfile(destination)
        lib.cmsCloseProfile(source)


def _normalize(array):
    if array.dtype.kind == 'u':
        return array.astype(np.float32) / np.float32(np.iinfo(array.dtype).max)
    if array.dtype.kind == 'b':
        return array.astype(np.float32)
    if array.dtype.kind == 'f' and np.isfinite(array).all() and array.min() >= 0 and array.max() <= 1:
        return array.astype(np.float32)
    raise ValueError('不支持此像素数据范围；请先转换为 SDR 无符号整数或 0–1 浮点 TIFF')


def read(path, preserve_alpha=False):
    """Decode to oriented, straight-alpha float32 sRGB RGB/RGBA in [0, 1]."""
    path = Path(path)
    suffix = path.suffix.lower()
    icc, orientation, grayscale = None, 1, False
    if suffix in {'.tif', '.tiff'}:
        with tifffile.TiffFile(path) as source:
            page = source.pages[0]
            photometric = int(page.photometric)
            if photometric not in {0, 1, 2}:
                raise ValueError('TIFF 色彩空间不支持高精度读取；请先转为 RGB TIFF')
            try:
                array = page.asarray()
            except (ValueError, KeyError, NotImplementedError) as exc:
                raise ValueError('TIFF 压缩解码器不可用；请使用未压缩或 Deflate TIFF，未进行 8-bit 降级') from exc
            if page.planarconfig == 2 and array.ndim == 3:
                array = np.moveaxis(array, 0, -1)
            if array.ndim == 2: array = array[..., None]
            if array.ndim != 3 or array.shape[-1] not in {1, 2, 3, 4}:
                raise ValueError('不支持此 TIFF 通道布局')
            grayscale = photometric in {0, 1}
            orientation = page.tags[274].value if 274 in page.tags else 1
            icc = bytes(page.tags[34675].value) if 34675 in page.tags else None
            array = _normalize(array)
            if photometric == 0: array[..., 0] = 1-array[..., 0]
            associated = bool(page.extrasamples and int(page.extrasamples[0]) == 1)
            if associated:
                alpha = array[..., -1:]
                np.divide(array[..., :-1], alpha, out=array[..., :-1], where=alpha > 0)
                array[..., :-1][np.repeat(alpha == 0, array.shape[-1]-1, axis=-1)] = 0
    elif suffix == '.png':
        # Pillow reads metadata only here; PyPNG supplies the original samples.
        with Image.open(path) as metadata:
            icc = metadata.info.get('icc_profile')
            orientation = metadata.getexif().get(274, 1)
        with path.open('rb') as stream:
            width, height, rows, info = png.Reader(file=stream).asDirect()
            grayscale = info['greyscale']
            array = np.empty((height, width, info['planes']), np.float32)
            scale = np.float32((1 << info['bitdepth'])-1)
            for index, row in enumerate(rows):
                array[index] = np.asarray(row, dtype=np.float32).reshape(width, info['planes']) / scale
    else:
        if suffix in {'.heic', '.heif'}:
            raise ValueError('HEIC 高精度解码尚未启用；请先以 16-bit TIFF/PNG 导出')
        with Image.open(path) as source:
            if source.mode in {'CMYK', 'LAB', 'I', 'F'} or source.mode.startswith('I;16'):
                raise ValueError('此图片模式无法可靠高精度转换；请先转为 RGB TIFF/PNG')
            icc, orientation = source.info.get('icc_profile'), source.getexif().get(274, 1)
            grayscale = source.mode in {'L', 'LA', '1'}
            has_alpha = source.mode in {'RGBA', 'LA'} or 'transparency' in source.info
            array = np.asarray(source.convert('RGBA' if has_alpha else 'RGB'), dtype=np.float32) / np.float32(255)
    if grayscale and array.shape[-1] <= 2:
        channels = [array[..., :1]]*3
        if array.shape[-1] == 2: channels.append(array[..., 1:2])
        array = np.concatenate(channels, axis=-1)
    array = np.ascontiguousarray(_orient(array, orientation))
    _convert_icc(array, icc, grayscale)
    if array.shape[-1] == 4 and not preserve_alpha:
        rgb = array[..., :3].copy()
        rgb *= array[..., 3:]
        rgb += 1-array[..., 3:]
        return rgb
    return array


decode = read


def resize(array, size):
    """Lanczos resampling in float; RGBA resamples premultiplied colour."""
    width, height = map(int, size)
    if width < 1 or height < 1: raise ValueError('图片尺寸必须大于零')
    if array.shape[:2] == (height, width): return array.copy()
    channels = array.shape[-1]
    result = np.empty((height, width, channels), np.float32)
    for channel in range(channels):
        plane = array[..., channel]
        if channels == 4 and channel < 3: plane = plane * array[..., 3]
        result[..., channel] = np.asarray(Image.fromarray(np.ascontiguousarray(plane)).resize(
            (width, height), Image.Resampling.LANCZOS))
    if channels == 4:
        np.divide(result[..., :3], result[..., 3:], out=result[..., :3], where=result[..., 3:] > 1e-8)
        result[..., :3][np.repeat(result[..., 3:] <= 1e-8, 3, axis=-1)] = 0
    np.clip(result, 0, 1, out=result)
    return result


def to_image(array):
    """The explicit 8-bit display boundary; do not feed this into full export."""
    return Image.fromarray(np.rint(np.clip(array, 0, 1)*255).astype(np.uint8))


def apply_lut(array, table):
    """Trilinear float LUT; Spektrafilm/Pillow storage is B, G, R, channel."""
    table = np.asarray(table, dtype=np.float32)
    if table.ndim != 4 or table.shape[-1] != 3 or len(set(table.shape[:3])) != 1:
        raise ValueError('无效的 RGB LUT')
    result = np.empty_like(array, dtype=np.float32)
    source, target = array.reshape(-1, 3), result.reshape(-1, 3)
    edge = table.shape[0]-1
    for start in range(0, len(source), TILE):
        values = np.clip(source[start:start+TILE], 0, 1)*np.float32(edge)
        lower = np.minimum(values.astype(np.int32), edge-1)
        fraction = values-lower.astype(np.float32)
        output = target[start:start+TILE]
        output.fill(0)
        for r in (0, 1):
            for g in (0, 1):
                for b in (0, 1):
                    weight = (fraction[:, 0] if r else 1-fraction[:, 0])
                    weight = weight*(fraction[:, 1] if g else 1-fraction[:, 1])
                    weight = weight*(fraction[:, 2] if b else 1-fraction[:, 2])
                    output += table[lower[:, 2]+b, lower[:, 1]+g, lower[:, 0]+r]*weight[:, None]
    return result


@lru_cache(maxsize=6)
def _stock_table(stock, modified):
    import film
    table = np.load(film.LUTS / (stock+'.npy'), allow_pickle=False)
    if table.shape != (33, 33, 33, 3) or not np.isfinite(table).all():
        raise ValueError('胶片 LUT 无效')
    return table.astype(np.float32, copy=False)


def _blur_plane(plane, radius):
    # Three separable boxes approximate a Gaussian, with only monochrome buffers.
    radius = max(1, int(round(radius)))
    for _ in range(3):
        for axis in (0, 1):
            padding = [(0, 0), (0, 0)]
            padding[axis] = (radius, radius)
            padded = np.pad(plane, padding, mode='edge')
            total = np.cumsum(padded, axis=axis, dtype=np.float64)
            initial = np.zeros_like(np.take(total, [0], axis=axis))
            total = np.concatenate([initial, total], axis=axis)
            left, right = [slice(None)]*2, [slice(None)]*2
            left[axis], right[axis] = slice(None, -2*radius-1), slice(2*radius+1, None)
            plane = ((total[tuple(right)]-total[tuple(left)])/(2*radius+1)).astype(np.float32)
    return plane


def _hsl_adjust(rgb, operations):
    """Smooth circular HSL colour-band corrections on one bounded pixel tile."""
    original_rgb = rgb.copy()
    affected = np.zeros(len(rgb), dtype=bool)
    maximum, minimum = rgb.max(axis=1), rgb.min(axis=1)
    delta = maximum-minimum
    lightness = (maximum+minimum)*np.float32(.5)
    saturation = np.divide(delta, 1-np.abs(2*lightness-1), out=np.zeros_like(delta), where=delta > 1e-8)
    hue = np.zeros_like(delta)
    chromatic = delta > 1e-8
    for channel in range(3):
        mask = chromatic & (np.argmax(rgb, axis=1) == channel)
        if channel == 0: difference = rgb[:, 1]-rgb[:, 2]
        elif channel == 1: difference = rgb[:, 2]-rgb[:, 0]
        else: difference = rgb[:, 0]-rgb[:, 1]
        hue[mask] = difference[mask]/delta[mask]+channel*2
    hue = (hue/6) % 1
    original_hue = hue.copy()
    original_saturation = saturation.copy()
    centres = [0, 30, 60, 120, 180, 240, 270, 300]
    for operation in operations:
        if not any(operation[key] for key in ('hue', 'saturation', 'luminance')): continue
        distance = np.abs((original_hue*360-centres[operation['band']]+180) % 360-180)
        weight = np.clip(1-distance/45, 0, 1)
        weight = weight*weight*(3-2*weight)
        weight *= np.minimum(1, original_saturation*4)
        affected |= weight > 0
        hue += np.float32(operation['hue']/360)*weight
        adjustment = np.float32(operation['saturation'])*weight
        saturation += np.where(adjustment >= 0, (1-saturation)*adjustment, saturation*adjustment)
        adjustment = np.float32(operation['luminance'])*weight
        lightness += np.where(adjustment >= 0, (1-lightness)*adjustment, lightness*adjustment)
    hue = (hue % 1)*6
    chroma = (1-np.abs(2*lightness-1))*np.clip(saturation, 0, 1)
    secondary = chroma*(1-np.abs(hue % 2-1))
    offset = lightness-chroma/2
    sector = hue.astype(np.int32) % 6
    for channel, values in enumerate(((chroma, secondary, 0, 0, secondary, chroma),
                                     (secondary, chroma, chroma, secondary, 0, 0),
                                     (0, 0, secondary, chroma, chroma, secondary))):
        rgb[:, channel] = offset
        for index, value in enumerate(values):
            mask = sector == index
            if isinstance(value, np.ndarray): rgb[mask, channel] += value[mask]
    rgb[~affected] = original_rgb[~affected]


def _editor_tone(rgb, recipe):
    curves = {name: np.asarray(json.loads(recipe[name]), np.float32) for name in ('curve_rgb', 'curve_r', 'curve_g', 'curve_b')}
    curves = {name: curve for name, curve in curves.items() if not np.array_equal(curve, [[0, 0], [1, 1]])}
    hsl = json.loads(recipe['hsl'])
    active = curves or hsl or any(recipe[name] != default for name, default in (
        ('shadows', 0), ('highlights', 0), ('whites', 0), ('blacks', 0), ('vibrance', 0),
        ('tint', 0), ('black_point', 0), ('white_point', 1), ('gamma', 1), ('dehaze', 0)))
    if not active: return
    flat = rgb.reshape(-1, 3)
    for start in range(0, len(flat), TILE):
        tile = flat[start:start+TILE]
        luminance = tile @ np.array([.2126, .7152, .0722], np.float32)
        adjustment = np.zeros_like(luminance)
        for name, mask in [('shadows', (1-luminance)**3), ('highlights', luminance**3),
                           ('whites', np.maximum(2*luminance-1, 0)**2),
                           ('blacks', np.maximum(1-2*luminance, 0)**2)]:
            if recipe[name]: adjustment += np.float32(recipe[name]*.45)*mask
        if np.any(adjustment):
            tile += np.where(adjustment[:, None] >= 0, (1-tile)*adjustment[:, None], tile*adjustment[:, None])
        if recipe['tint']:
            tile *= np.array([1+recipe['tint']*.12, 1-recipe['tint']*.12, 1+recipe['tint']*.12], np.float32)
        if recipe['vibrance']:
            gray = (tile @ np.array([.2126, .7152, .0722], np.float32))[:, None]
            chroma = tile.max(axis=1)-tile.min(axis=1)
            tile[:] = gray+(tile-gray)*(1+np.float32(recipe['vibrance'])*(1-chroma[:, None])*.8)
        if recipe['dehaze']:
            # A conservative atmospheric-veil contrast correction, not depth estimation.
            amount = np.float32(recipe['dehaze'])
            tile[:] = (tile-.06*amount)/(1-.18*amount)
        if recipe['black_point'] or recipe['white_point'] != 1:
            tile[:] = (tile-np.float32(recipe['black_point']))/np.float32(recipe['white_point']-recipe['black_point'])
        np.clip(tile, 0, 1, out=tile)
        if recipe['gamma'] != 1: np.power(tile, np.float32(1/recipe['gamma']), out=tile)
        if 'curve_rgb' in curves:
            points = curves['curve_rgb']
            tile[:] = np.interp(tile, points[:, 0], points[:, 1]).astype(np.float32)
        for channel, name in enumerate(('curve_r', 'curve_g', 'curve_b')):
            if name in curves:
                points = curves[name]
                tile[:, channel] = np.interp(tile[:, channel], points[:, 0], points[:, 1]).astype(np.float32)
        if hsl: _hsl_adjust(tile, hsl)
        np.clip(tile, 0, 1, out=tile)


def _editor_details(rgb, recipe):
    scale = max(rgb.shape[:2])/1600
    if recipe['denoise']:
        luminance = rgb @ np.array([.2126, .7152, .0722], np.float32)
        smooth = _blur_plane(luminance, max(1, scale))
        weight = np.exp(-((luminance-smooth)/np.float32(.06))**2)*np.float32(recipe['denoise'])
        for channel in range(3):
            smooth = _blur_plane(rgb[..., channel], max(1, scale))
            rgb[..., channel] += (smooth-rgb[..., channel])*weight
    if recipe['sharpen'] or recipe['clarity']:
        luminance = rgb @ np.array([.2126, .7152, .0722], np.float32)
        detail = np.zeros_like(luminance)
        if recipe['sharpen']:
            radius = recipe['sharpen_radius']*scale
            lower = int(math.floor(radius))
            fraction = np.float32(radius-lower)
            blurred = _blur_plane(luminance, lower) if lower else luminance.copy()
            if fraction:
                blurred += (_blur_plane(luminance, lower+1)-blurred)*fraction
            detail += (luminance-blurred)*np.float32(recipe['sharpen'])
        if recipe['clarity']:
            detail += (luminance-_blur_plane(luminance, max(1, scale*12)))*np.float32(recipe['clarity']*.8)
        for channel in range(3): rgb[..., channel] += detail
        np.clip(rgb, 0, 1, out=rgb)
    if recipe['vignette']:
        height, width = rgb.shape[:2]
        xs = ((np.arange(width, dtype=np.float32)+.5-width/2)/max(1, width/2))**2
        for top in range(0, height, 64):
            ys = ((np.arange(top, min(top+64, height), dtype=np.float32)+.5-height/2)/max(1, height/2))**2
            mask = np.clip((ys[:, None]+xs[None, :])*.5, 0, 1)**np.float32(1.4)
            rgb[top:top+64] *= np.exp2(-np.float32(recipe['vignette']*2)*mask[..., None])
        np.clip(rgb, 0, 1, out=rgb)


def _stamp_roi(shape, operation):
    height, width = shape[:2]
    radius = max(.5, operation['radius']*min(width, height))
    cx, cy = operation['x']*width, operation['y']*height
    left, right = max(0, int(math.floor(cx-radius))), min(width, int(math.ceil(cx+radius)))
    top, bottom = max(0, int(math.floor(cy-radius))), min(height, int(math.ceil(cy+radius)))
    ys, xs = np.ogrid[top:bottom, left:right]
    distance = np.sqrt((xs+.5-cx)**2+(ys+.5-cy)**2)/radius
    return (left, top, right, bottom), distance


def _local_adjustments(rgb, operations):
    for operation in operations:
        (left, top, right, bottom), distance = _stamp_roi(rgb.shape, operation)
        target = rgb[top:bottom, left:right]
        feather = operation['feather']
        if feather:
            weight = np.clip((1-distance)/feather, 0, 1)
            weight = weight*weight*(3-2*weight)
        else: weight = (distance <= 1).astype(np.float32)
        candidate = target*np.float32(2**operation['exposure'])
        if operation['saturation'] != 1:
            gray = (candidate @ np.array([.2126, .7152, .0722], np.float32))[..., None]
            candidate = gray+(candidate-gray)*np.float32(operation['saturation'])
        np.clip(candidate, 0, 1, out=candidate)
        target += (candidate-target)*weight.astype(np.float32)[..., None]


def _retouch(rgb, operations):
    """Feathered clone / colour-matched patch repair; no generated content."""
    height, width = rgb.shape[:2]
    for operation in operations:
        if not operation['strength']: continue
        (left, top, right, bottom), distance = _stamp_roi(rgb.shape, operation)
        yy, xx = np.mgrid[top:bottom, left:right]
        sx = xx.astype(np.float32)+np.float32((operation['sx']-operation['x'])*width)
        sy = yy.astype(np.float32)+np.float32((operation['sy']-operation['y'])*height)
        valid = (sx >= 0) & (sx <= width-1) & (sy >= 0) & (sy <= height-1)
        sx, sy = np.clip(sx, 0, width-1), np.clip(sy, 0, height-1)
        x0, y0 = sx.astype(np.int32), sy.astype(np.int32)
        x1, y1 = np.minimum(x0+1, width-1), np.minimum(y0+1, height-1)
        fx, fy = (sx-x0).astype(np.float32)[..., None], (sy-y0).astype(np.float32)[..., None]
        # Independent sampled patch makes overlapping clone source/target stable.
        patch = ((rgb[y0, x0]*(1-fx)+rgb[y0, x1]*fx)*(1-fy)+
                 (rgb[y1, x0]*(1-fx)+rgb[y1, x1]*fx)*fy)
        target = rgb[top:bottom, left:right]
        if operation['type'] == 'heal':
            # Compare actual surrounding rings, rather than the blemish centre.
            radius = operation['radius']*min(width, height)
            def ring_mean(cx, cy):
                outer = max(2, radius*1.6)
                xlo, xhi = max(0, int(cx-outer)), min(width, int(math.ceil(cx+outer)))
                ylo, yhi = max(0, int(cy-outer)), min(height, int(math.ceil(cy+outer)))
                ys, xs = np.ogrid[ylo:yhi, xlo:xhi]
                dist = (xs+.5-cx)**2+(ys+.5-cy)**2
                ring = (dist >= radius**2) & (dist <= outer**2)
                region = rgb[ylo:yhi, xlo:xhi]
                return region[ring].mean(axis=0) if np.any(ring) else region.reshape(-1, 3).mean(axis=0)
            target_mean = ring_mean(operation['x']*width, operation['y']*height)
            source_mean = ring_mean(operation['sx']*width, operation['sy']*height)
            patch += target_mean-source_mean
            # Remove the residual low-frequency colour difference of the patch
            # itself while keeping its texture relative to its surroundings.
            disc = (distance < .75) & valid
            if np.any(disc): patch += (target_mean-patch[disc].mean(axis=0))*np.float32(.8)
            np.clip(patch, 0, 1, out=patch)
        weight = np.clip((1-distance)/.3, 0, 1)
        weight = (weight*weight*(3-2*weight)*operation['strength']*valid).astype(np.float32)
        target += (patch-target)*weight[..., None]


def _geometry(array, recipe):
    import engine
    if recipe['quarter_turns']: array = np.rot90(array, -recipe['quarter_turns'])
    if recipe['flip_x']: array = array[:, ::-1]
    if recipe['flip_y']: array = array[::-1]
    if recipe['straighten']:
        height, width = array.shape[:2]
        angle = math.radians(recipe['straighten'])
        c, s = math.cos(angle), math.sin(angle)
        cx, cy = width/2, height/2
        matrix = (c, -s, cx-c*cx+s*cy, s, c, cy-s*cx-c*cy)
        transformed = np.empty((height, width, 4), np.float32)
        alpha = array[..., 3] if array.shape[-1] == 4 else None
        for channel in range(4):
            plane = (alpha if alpha is not None else np.ones((height, width), np.float32)) if channel == 3 else array[..., channel]
            if channel < 3 and alpha is not None: plane = plane*alpha
            transformed[..., channel] = np.asarray(Image.fromarray(np.ascontiguousarray(plane)).transform(
                (width, height), Image.Transform.AFFINE, matrix, Image.Resampling.BICUBIC, fillcolor=0))
        alpha = transformed[..., 3:]
        np.divide(transformed[..., :3], alpha, out=transformed[..., :3], where=alpha > 1e-8)
        transformed[..., :3][np.repeat(alpha <= 1e-8, 3, axis=-1)] = 0
        np.clip(transformed, 0, 1, out=transformed)
        array = transformed
    left, top, right, bottom = engine.crop_bounds(array.shape[1], array.shape[0], recipe)
    return np.ascontiguousarray(array[top:bottom, left:right])


def render(path, recipe, max_size=None, preserve_alpha=False):
    """Decode/develop then grade in float32; never writes the original file."""
    import engine
    import film
    recipe = engine.validate_recipe(recipe)
    if Path(path).suffix.lower() in engine.RAW:
        # A cropped view needs enough native samples inside the crop. Asking
        # the decoder for the final display size before cropping would blur it.
        minimum_crop=min(recipe['crop_w'],recipe['crop_h'])
        decode_size=tuple(int(np.ceil(value/minimum_crop)) for value in max_size) if max_size else None
        path = engine.develop_raw(path, recipe, preview_size=decode_size, output_16bit=True)
    # Geometry must filter the original transparency before the final flatten.
    array = read(path, preserve_alpha=True)
    if max_size:
        output_width,output_height=engine.render_dimensions({'width':array.shape[1],'height':array.shape[0],'recipe':recipe})
        factor = min(1, max_size[0]/output_width, max_size[1]/output_height)
        if factor < 1: array = resize(array, (max(1, round(array.shape[1]*factor)), max(1, round(array.shape[0]*factor))))
    alpha = array[..., 3:].copy() if array.shape[-1] == 4 else None
    rgb = np.ascontiguousarray(array[..., :3])
    style = recipe['style']
    exposure, contrast, saturation = recipe['exposure'], recipe['contrast'], recipe['saturation']
    temperature = recipe['temperature'] + {'warm': .18, 'cool': -.15, 'film': .08}.get(style, 0)
    # Luminance mean is a scalar; each working colour buffer is at most TILE pixels.
    mean = None
    if contrast != 1:
        total, count = 0., 0
        for chunk in np.array_split(rgb.reshape(-1, 3), max(1, (rgb.size//3+TILE-1)//TILE)):
            total += float((np.clip(chunk*np.float32(2**exposure), 0, 1) @ np.array([.299, .587, .114], np.float32)).sum(dtype=np.float64))
            count += len(chunk)
        mean = np.float32(total/count)
    flat = rgb.reshape(-1, 3)
    for start in range(0, len(flat), TILE):
        chunk = flat[start:start+TILE]
        if exposure: np.clip(chunk*np.float32(2**exposure), 0, 1, out=chunk)
        if contrast != 1: np.clip((chunk-mean)*np.float32(contrast)+mean, 0, 1, out=chunk)
        if saturation != 1:
            gray = (chunk @ np.array([.299, .587, .114], np.float32))[:, None]
            np.clip(gray+(chunk-gray)*np.float32(saturation), 0, 1, out=chunk)
        if temperature:
            chunk[:, 0] *= np.float32(1+temperature*.18)
            chunk[:, 2] *= np.float32(1-temperature*.18)
            np.clip(chunk, 0, 1, out=chunk)
        if style == 'film':
            gray = (chunk @ np.array([.299, .587, .114], np.float32))[:, None]
            chunk[:] = (gray+(chunk-gray)*np.float32(.82))*np.float32(.9)+np.float32(14/255)
        elif style == 'mono':
            chunk[:] = (chunk @ np.array([.299, .587, .114], np.float32))[:, None]
    if style in film.CREATIVE:
        creative = film.creative_lut(style)
        rgb = apply_lut(rgb, np.asarray(creative.table, np.float32).reshape(17, 17, 17, 3))
    stock, strength = recipe['film_stock'], recipe['film_strength']
    if stock != 'none' and strength:
        if not film.stock_ready(stock): raise ValueError('胶片资源未就绪，请运行 python film.py --setup')
        table = _stock_table(stock, (film.LUTS/(stock+'.npy')).stat().st_mtime_ns)
        graded = apply_lut(rgb, table)
        if recipe['film_halation']:
            highlights = np.maximum((rgb @ np.array([.299, .587, .114], np.float32)-np.float32(180/255))/np.float32(75/255), 0)
            mask = _blur_plane(highlights, max(rgb.shape[:2])/1600*3.5)*np.float32(recipe['film_halation'])
            for channel, glow in enumerate((189/255, 72/255, 34/255)):
                graded[..., channel] += (1-graded[..., channel])*np.float32(glow)*mask
        if recipe['film_grain']:
            height, width = rgb.shape[:2]
            scale = min(1, 1600/max(width, height))
            seed = int(hashlib.sha256(stock.encode()).hexdigest()[:8], 16)
            noise = np.random.default_rng(seed).normal(0, 13/255, (max(1, round(height*scale)), max(1, round(width*scale)))).astype(np.float32)
            if noise.shape != (height, width):
                noise = np.asarray(Image.fromarray(noise).resize((width, height), Image.Resampling.BILINEAR))
            graded += noise[..., None]*np.float32(recipe['film_grain'])
            np.clip(graded, 0, 1, out=graded)
        if strength != 1:
            for start in range(0, rgb.shape[0], 64):
                graded[start:start+64] = rgb[start:start+64]+(graded[start:start+64]-rgb[start:start+64])*np.float32(strength)
        rgb = graded
    np.clip(rgb, 0, 1, out=rgb)
    _editor_tone(rgb, recipe)
    _editor_details(rgb, recipe)
    _local_adjustments(rgb, json.loads(recipe['local_adjustments']))
    _retouch(rgb, json.loads(recipe['retouch']))
    result = _geometry(np.concatenate([rgb, alpha], axis=-1) if alpha is not None else rgb, recipe)
    if result.shape[-1] == 4 and not preserve_alpha:
        return result[..., :3]*result[..., 3:]+1-result[..., 3:]
    return result


class _SRGBWriter(png.Writer):
    def write_preamble(self, outfile):
        super().write_preamble(outfile)
        png.write_chunk(outfile, b'sRGB', b'\x01')


def write(target, array, format):
    """Write explicit png16/tiff16/png8/webp_lossless/jpeg; JPEG is lossy.

    TIFF uses lossless Deflate. PNG/WebP preserve output samples; 8-bit formats
    necessarily quantize a higher-precision source. RGBA JPEG flattens on white.
    The caller reserves output paths and manages atomic replacement/sidecars.
    """
    if format not in {'png16', 'tiff16', 'png8', 'webp_lossless', 'jpeg'}:
        raise ValueError('未知导出格式')
    if array.ndim != 3 or array.shape[-1] not in {3, 4} or not np.isfinite(array).all():
        raise ValueError('导出需要有限 RGB/RGBA 像素')
    if format == 'png16':
        writer = _SRGBWriter(array.shape[1], array.shape[0], greyscale=False,
                            alpha=array.shape[-1] == 4, bitdepth=16, compression=6)
        rows = (np.rint(np.clip(row, 0, 1)*65535).astype(np.uint16).reshape(-1) for row in array)
        if hasattr(target, 'write'): writer.write(target, rows)
        else:
            with Path(target).open('wb') as stream: writer.write(stream, rows)
    elif format == 'tiff16':
        samples = np.rint(np.clip(array, 0, 1)*65535).astype(np.uint16)
        tifffile.imwrite(target, samples, photometric='rgb', compression='deflate',
                         extrasamples=['unassalpha'] if array.shape[-1] == 4 else None,
                         metadata=None, extratags=[(34675, 'B', len(SRGB), SRGB, False)])
    else:
        if format == 'jpeg' and array.shape[-1] == 4:
            array = array[..., :3]*array[..., 3:]+1-array[..., 3:]
        image = to_image(array)
        options = {'icc_profile': SRGB}
        if format == 'webp_lossless': options.update(lossless=True, exact=True, method=6)
        if format == 'jpeg': options.update(quality=95, subsampling=0)
        image.save(target, format={'png8': 'PNG', 'webp_lossless': 'WEBP', 'jpeg': 'JPEG'}[format], **options)
