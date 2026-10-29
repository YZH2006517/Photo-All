# SPDX-License-Identifier: GPL-3.0-or-later
"""Photo All processing and catalog. Original files are never written.

Sections: decoding/color → analysis → recipes/rendering → catalog → export.
Edits use float32 SDR RGB; screen conversion is the final 8-bit boundary.
"""
from __future__ import annotations

from datetime import datetime
from contextlib import contextmanager
import hashlib
from io import BytesIO
import json
import math
import os
from pathlib import Path
import sqlite3
import shutil
import subprocess
import tempfile
import threading
import time

from PIL import Image, ImageCms, ImageEnhance, ImageFilter, ImageOps, ImageStat
import film

RASTER = {'.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.bmp'}
RAW = {'.dng', '.nef', '.arw', '.cr2', '.cr3', '.raf', '.rw2', '.orf', '.pef'}
SUPPORTED = RASTER | RAW | {'.heic', '.heif'}
STYLES = {'natural': '自然', 'warm': '暖调日记', 'cool': '清透冷调', 'film': '柔和胶片', 'mono': '经典黑白'}
STYLES.update({key: value[0] for key, value in film.CREATIVE.items()})
TEMPLATES = {'plain': '原比例', 'frame': '方形留白', 'portrait': '竖版留白'}
DEFAULT_RECIPE = {'style': 'natural', 'exposure': 0, 'contrast': 1, 'saturation': 1, 'temperature': 0}
RAW_DEFAULTS = {'raw_exposure': 0, 'raw_wb': 'camera', 'raw_temperature': 6500,
                'raw_tint': 1, 'raw_highlights': 0, 'raw_denoise': 0, 'raw_sharpen': 0}
DEFAULT_RECIPE.update(RAW_DEFAULTS)
DEFAULT_RECIPE.update(film_stock='none', film_strength=1, film_grain=0, film_halation=0)
IDENTITY_CURVE = '[[0,0],[1,1]]'
EDITOR_RANGES = {
    'straighten': (-45, 45), 'crop_x': (0, 1), 'crop_y': (0, 1),
    'crop_w': (.01, 1), 'crop_h': (.01, 1),
    **{key: (-1, 1) for key in ('shadows', 'highlights', 'whites', 'blacks', 'vibrance',
                               'tint', 'clarity', 'dehaze', 'vignette')},
    'black_point': (0, .9), 'white_point': (.1, 1), 'gamma': (.2, 5),
    'sharpen': (0, 2), 'sharpen_radius': (.3, 5), 'denoise': (0, 1),
}
DEFAULT_RECIPE.update(quarter_turns=0, flip_x=0, flip_y=0, straighten=0,
    crop_x=0, crop_y=0, crop_w=1, crop_h=1, shadows=0, highlights=0, whites=0,
    blacks=0, vibrance=0, tint=0, black_point=0, white_point=1, gamma=1,
    clarity=0, dehaze=0, sharpen=0, sharpen_radius=1, denoise=0, vignette=0,
    curve_rgb=IDENTITY_CURVE, curve_r=IDENTITY_CURVE, curve_g=IDENTITY_CURVE,
    curve_b=IDENTITY_CURVE, hsl='[]', retouch='[]', local_adjustments='[]')
RAW_CACHE = Path(__file__).parent / 'data' / 'raw-cache'
RAW_LOCK = threading.Lock()  # One decoder at a time avoids multiple full-size RAW buffers.
SRGB = ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()
EXPORT_CONTEXT = threading.local()


class ExportCancelled(Exception):
    """A requested cancellation, rather than an export failure."""


class CancellationToken:
    def __init__(self):
        self.event = threading.Event()

    def cancel(self):
        self.event.set()

    def check(self):
        if self.event.is_set():
            raise ExportCancelled('导出已取消')

    def run(self, command, timeout=180, **kwargs):
        self.check()
        started = time.monotonic()
        with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs) as process:
            try:
                while True:
                    self.check()
                    remaining = timeout - (time.monotonic() - started)
                    if remaining <= 0: raise subprocess.TimeoutExpired(command, timeout)
                    try:
                        stdout, stderr = process.communicate(timeout=min(.1, remaining))
                        self.check()
                        return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
                    except subprocess.TimeoutExpired:
                        if time.monotonic() - started >= timeout: raise
            except BaseException:
                process.kill()
                process.communicate()
                raise


@contextmanager
def cancellation_scope(cancellation):
    previous = getattr(EXPORT_CONTEXT, 'cancellation', None)
    EXPORT_CONTEXT.cancellation = cancellation
    try:
        if cancellation: cancellation.check()
        yield
    finally:
        EXPORT_CONTEXT.cancellation = previous


def capabilities():
    import importlib.util
    return {'raw': bool(raw_executable()), 'raw_backend': 'RawTherapee' if raw_executable() else None,
            'heic': bool(importlib.util.find_spec('pillow_heif'))}


def raw_executable():
    configured = os.environ.get('PHOTOALL_RAWTHERAPEE')
    if configured:
        path = Path(configured)
        return path.resolve() if path.is_file() else None
    root = Path(__file__).parent / 'engines'
    bundled = sorted(root.glob('*/*/rawtherapee-cli.exe'))
    if bundled:
        return bundled[-1].resolve()
    installed = shutil.which('rawtherapee-cli')
    return Path(installed).resolve() if installed else None


def prepare_studio(data_dir):
    """Use upstream's supported external-editor interface, with a private profile."""
    data_dir = Path(data_dir).resolve()
    settings = data_dir / 'studio-settings'
    inbox = data_dir / 'studio-inbox'
    settings.mkdir(parents=True, exist_ok=True)
    inbox.mkdir(parents=True, exist_ok=True)
    options = settings / 'options'
    if not options.exists():
        def escape(value):
            return str(value).replace('\\', '\\\\').replace(';', '\\;')
        command = escape(Path(__file__).parent / 'companion.cmd')
        options.write_text(f'''[General]
Language=Chinese (Simplified)
LanguageAutoDetect=false

[Profiles]
SaveParamsWithFile=false
SaveParamsToCache=true

[External Editor]
Names=Photo All - 相册与模板出片;
Commands={command};
NativeCommands=true;
EditorIndex=0
OutputDir=2
CustomOutputDir={escape(inbox)}
Float32=false
BypassOutputProfile=false
''', encoding='utf-8')
    return settings, inbox


def launch_studio(data_dir, photo=None):
    executable = raw_executable()
    if not executable:
        raise ValueError('未找到 RawTherapee，请检查 product/engines 或 PHOTOALL_RAWTHERAPEE')
    gui = executable.with_name('rawtherapee.exe' if os.name == 'nt' else 'rawtherapee')
    if not gui.is_file():
        raise ValueError('当前安装只有 CLI，没有原生编辑器界面')
    settings, _ = prepare_studio(data_dir)
    cache = Path(data_dir).resolve() / 'studio-cache'
    cache.mkdir(parents=True, exist_ok=True)
    # Remote (-R) reuses another process and discards our per-library environment.
    command = [str(gui)]
    if photo:
        command.append(str(Path(photo).resolve()))
    # No shell: paths and filenames are separate arguments, including spaces/Unicode.
    return subprocess.Popen(command, env={**os.environ, 'RT_SETTINGS': str(settings),
                                         'RT_CACHE': str(cache), 'OMP_NUM_THREADS': '4',
                                         'PHOTOALL_DATA_DIR': str(Path(data_dir).resolve())},
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def raw_profile(recipe, preview_size=None):
    """Partial PP3; unspecified parameters use RawTherapee neutral defaults."""
    r = validate_recipe(recipe)
    wb = {'camera': 'Camera', 'auto': 'autold', 'custom': 'Custom'}[r['raw_wb']]
    text = f'''[Exposure]
Auto=false
HistogramMatching=false
Compensation={r['raw_exposure']}
HighlightCompr={int(r['raw_highlights'])}

[HLRecovery]
Enabled=true
Method=Coloropp

[White Balance]
Enabled=true
Setting={wb}
Temperature={int(r['raw_temperature'])}
Green={r['raw_tint']}

[Directional Pyramid Denoising]
Enabled={'true' if r['raw_denoise'] else 'false'}
Luma={r['raw_denoise']}
Chroma={r['raw_denoise']}
CMethod=MAN
LMethod=SLI

[Sharpening]
Enabled={'true' if r['raw_sharpen'] else 'false'}
Method=usm
Radius=0.5
Amount={int(r['raw_sharpen'])}

[Color Management]
OutputProfile=RTv4_sRGB
OutputProfileIntent=Relative
OutputBPC=true
'''
    if preview_size:
        text += f'\n[Resize]\nEnabled=true\nAppliesTo=Full image\nMethod=Lanczos\nDataSpecified=3\nWidth={int(preview_size[0])}\nHeight={int(preview_size[1])}\nAllowUpscaling=false\n'
    return text


def develop_raw(path, recipe=None, preview_size=None, output_16bit=False):
    """Cached native-engine output; TIFF bytes never pass through Pillow when exporting."""
    executable = raw_executable()
    if not executable:
        raise ValueError('未找到 RawTherapee；请安装随附引擎或设置 PHOTOALL_RAWTHERAPEE 指向 CLI')
    path = Path(path).resolve()
    profile = raw_profile(recipe or {}, preview_size)
    stat = path.stat()
    key = hashlib.sha256(json.dumps([str(path), stat.st_size, stat.st_mtime_ns,
                                    str(executable), executable.stat().st_mtime_ns,
                                    profile, output_16bit]).encode()).hexdigest()
    RAW_CACHE.mkdir(parents=True, exist_ok=True)
    target = RAW_CACHE / (key + ('.tif' if output_16bit else '.png'))
    cancellation = getattr(EXPORT_CONTEXT, 'cancellation', None)
    with raw_lock(cancellation):
        if cancellation: cancellation.check()
        if target.is_file():
            target.touch()
            return target
        with tempfile.TemporaryDirectory(dir=RAW_CACHE, prefix='job-') as folder:
            folder = Path(folder)
            pp3 = folder / 'recipe.pp3'
            pp3.write_text(profile, encoding='utf-8')
            output = folder / target.name
            env = {**os.environ, 'RT_SETTINGS': str(folder / 'settings'),
                   'RT_CACHE': str(folder / 'cache'), 'OMP_NUM_THREADS': '4'}
            command = [str(executable), '-q', '-o', str(output), '-p', str(pp3),
                       '-t' if output_16bit else '-n', '-b16' if output_16bit else '-b8', '-c', str(path)]
            try:
                options = dict(env=env, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                result = (cancellation.run(command, timeout=180, **options) if cancellation else
                          subprocess.run(command, capture_output=True, timeout=180, **options))
            except subprocess.TimeoutExpired as exc:
                raise RuntimeError('RAW 显影超过 180 秒，进程已终止；请降低设置后重试') from exc
            log = (result.stdout + result.stderr).decode('utf-8', errors='replace')
            (RAW_CACHE / 'last-engine.log').write_text(log, encoding='utf-8')
            if result.returncode != 0 or not output.is_file():
                raise RuntimeError(f'RawTherapee 显影失败（{result.returncode}）：{log[-700:]}')
            with Image.open(output) as check:
                check.verify()
            os.replace(output, target)
        # Keep at most 1 GiB; only generated cache images are eligible for eviction.
        cached = sorted([*RAW_CACHE.glob('*.png'), *RAW_CACHE.glob('*.tif')], key=lambda p: p.stat().st_mtime)
        total = sum(p.stat().st_size for p in cached)
        for old in cached:
            if total <= 1024 ** 3:
                break
            if old != target:
                total -= old.stat().st_size
                old.unlink(missing_ok=True)
    return target


@contextmanager
def raw_lock(cancellation):
    while not RAW_LOCK.acquire(timeout=.1):
        if cancellation: cancellation.check()
    try:
        yield
    finally:
        RAW_LOCK.release()


def open_image(path, raw_recipe=None, preview_size=None, preserve_alpha=False):
    """Return an oriented, color-managed SDR image. Optional codecs fail explicitly."""
    path = Path(path)
    if path.suffix.lower() in RAW:
        path = develop_raw(path, raw_recipe, preview_size)
    if path.suffix.lower() in {'.heic', '.heif'}:
        if not capabilities()['heic']:
            raise ValueError('HEIC 解码器未安装；可选安装 pillow-heif 后重试')
        from pillow_heif import register_heif_opener
        register_heif_opener()
    with Image.open(path) as source:
        if preview_size and source.format == 'JPEG':
            source.draft('RGB', preview_size)
        image = ImageOps.exif_transpose(source)
        image.load()
        transparent = image.mode in ('RGBA', 'LA') or (image.mode == 'P' and 'transparency' in image.info)
        alpha = image.convert('RGBA').getchannel('A') if transparent else None
        if image.mode == 'P':
            image = image.convert('RGB')
        icc = source.info.get('icc_profile')
        if icc:
            try:
                image = ImageCms.profileToProfile(image, ImageCms.ImageCmsProfile(BytesIO(icc)),
                                                  ImageCms.ImageCmsProfile(BytesIO(SRGB)), outputMode='RGB')
            except (ImageCms.PyCMSError, OSError, ValueError) as exc:
                raise ValueError('无法转换此图片的 ICC 色彩配置') from exc
        elif image.mode == 'CMYK':
            raise ValueError('CMYK 图片缺少 ICC，无法可靠转换到 sRGB')
        if alpha is not None:
            if preserve_alpha:
                image = image.convert('RGBA')
                image.putalpha(alpha)
                return image
            background = Image.new('RGB', image.size, 'white')
            background.paste(image.convert('RGB'), mask=alpha)
            image = background
        return image.convert('RGB')


def validate_recipe(recipe):
    if not isinstance(recipe, dict):
        raise ValueError('配方格式无效')
    result = {**DEFAULT_RECIPE, **recipe}
    if result['style'] not in STYLES:
        raise ValueError('未知风格')
    if result['film_stock'] != 'none' and result['film_stock'] not in film.STOCKS:
        raise ValueError('未知胶片型号')
    if result['raw_wb'] not in {'camera', 'auto', 'custom'}:
        raise ValueError('未知 RAW 白平衡模式')
    for name, low, high in [('exposure', -2, 2), ('contrast', .5, 1.5),
                            ('saturation', 0, 2), ('temperature', -1, 1),
                            ('raw_exposure', -5, 5), ('raw_temperature', 2000, 25000),
                            ('raw_tint', .2, 5), ('raw_highlights', 0, 100),
                            ('raw_denoise', 0, 100), ('raw_sharpen', 0, 300),
                            ('film_strength',0,1), ('film_grain',0,1), ('film_halation',0,1),
                            *((name, *bounds) for name, bounds in EDITOR_RANGES.items())]:
        try: value = float(result[name])
        except (ValueError, TypeError) as exc: raise ValueError(f'参数 {name} 无效') from exc
        if not math.isfinite(value) or not low <= value <= high:
            raise ValueError(f'参数 {name} 超出范围')
        result[name] = value
    for name, maximum in [('quarter_turns', 3), ('flip_x', 1), ('flip_y', 1)]:
        if type(result[name]) is not int or not 0 <= result[name] <= maximum:
            raise ValueError(f'参数 {name} 必须是 0–{maximum} 的整数')
    if result['crop_x']+result['crop_w'] > 1+1e-9 or result['crop_y']+result['crop_h'] > 1+1e-9:
        raise ValueError('裁切范围超出图片边界')
    if result['white_point'] <= result['black_point']+.01:
        raise ValueError('白场必须比黑场高至少 0.01')
    for name in ('curve_rgb', 'curve_r', 'curve_g', 'curve_b'):
        points = _recipe_json(result[name], name, 16)
        if len(points) < 2:
            raise ValueError('曲线至少需要两个点')
        for index, point in enumerate(points):
            if not isinstance(point, list) or len(point) != 2:
                raise ValueError('曲线点格式无效')
            _bounded_number(point[0], 0, 1, name)
            _bounded_number(point[1], 0, 1, name)
            if index and point[0] <= points[index-1][0]: raise ValueError('曲线横坐标必须递增')
        if points[0][0] != 0 or points[-1][0] != 1: raise ValueError('曲线须包含 0 和 1 端点')
        result[name] = json.dumps(points, separators=(',', ':'))
    for name, maximum in [('hsl', 8), ('retouch', 256), ('local_adjustments', 256)]:
        operations = _recipe_json(result[name], name, maximum)
        clean, bands = [], set()
        for operation in operations:
            if not isinstance(operation, dict): raise ValueError(f'{name} 操作格式无效')
            if name == 'hsl':
                band = operation.get('band')
                if type(band) is not int or not 0 <= band <= 7 or band in bands:
                    raise ValueError('HSL 色段必须是 0–7 的不重复整数')
                bands.add(band)
                item = {'band': band}
                for key, limit in [('hue', 30), ('saturation', 1), ('luminance', 1)]:
                    item[key] = _bounded_number(operation.get(key, 0), -limit, limit, name)
            else:
                item = {key: _bounded_number(operation.get(key), 0, 1, name) for key in ('x', 'y')}
                item['radius'] = _bounded_number(operation.get('radius'), .001, .2, name)
                if name == 'retouch':
                    if operation.get('type') not in {'clone', 'heal'}: raise ValueError('未知修复操作')
                    item.update(type=operation['type'])
                    for key in ('sx', 'sy'): item[key] = _bounded_number(operation.get(key), 0, 1, name)
                    item['strength'] = _bounded_number(operation.get('strength', 1), 0, 1, name)
                else:
                    for key, default, low, high in [('exposure', 0, -2, 2), ('saturation', 1, 0, 2), ('feather', .5, 0, 1)]:
                        item[key] = _bounded_number(operation.get(key, default), low, high, name)
            clean.append(item)
        result[name] = json.dumps(clean, separators=(',', ':'))
    return {key: result[key] for key in DEFAULT_RECIPE}


def _bounded_number(value, low, high, name):
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f'参数 {name} 超出范围')
    return value


def _recipe_json(value, name, maximum):
    if not isinstance(value, str) or len(value) > 100000:
        raise ValueError(f'参数 {name} 必须是 JSON 字符串')
    try: data = json.loads(value)
    except (ValueError, TypeError) as exc: raise ValueError(f'参数 {name} JSON 无效') from exc
    if not isinstance(data, list) or len(data) > maximum: raise ValueError(f'参数 {name} 数量超出范围')
    return data


def crop_bounds(width, height, recipe):
    """Rounded pixel-edge crop rectangle after quarter turns/flips/straighten."""
    left = min(width-1, round(recipe['crop_x']*width))
    top = min(height-1, round(recipe['crop_y']*height))
    right = min(width, max(left+1, round((recipe['crop_x']+recipe['crop_w'])*width)))
    bottom = min(height, max(top+1, round((recipe['crop_y']+recipe['crop_h'])*height)))
    return left, top, right, bottom


def render_dimensions(photo):
    recipe = validate_recipe(photo.get('recipe', {}))
    width, height = photo['width'], photo['height']
    if recipe['quarter_turns'] % 2: width, height = height, width
    left, top, right, bottom = crop_bounds(width, height, recipe)
    return right-left, bottom-top


def geometry_to_source(x, y, width, height, recipe):
    """Map normalized output pixel-edge coordinates to oriented source coordinates.

    Points outside a straightened image can lie outside [0, 1]; the UI should
    reject those brush stamps rather than clamp them onto an image edge.
    """
    recipe = validate_recipe(recipe)
    turned_w, turned_h = (height, width) if recipe['quarter_turns'] % 2 else (width, height)
    left, top, right, bottom = crop_bounds(turned_w, turned_h, recipe)
    px, py = left+x*(right-left)-turned_w/2, top+y*(bottom-top)-turned_h/2
    angle = math.radians(recipe['straighten'])
    u = (math.cos(angle)*px-math.sin(angle)*py+turned_w/2)/turned_w
    v = (math.sin(angle)*px+math.cos(angle)*py+turned_h/2)/turned_h
    if recipe['flip_x']: u = 1-u
    if recipe['flip_y']: v = 1-v
    for _ in range(recipe['quarter_turns']): u, v = v, 1-u
    return u, v


def render_image(path, recipe, max_size=None, preserve_alpha=False):
    import pixels
    return pixels.to_image(render_pixels(path,recipe,max_size,preserve_alpha))


def render_pixels(path,recipe,max_size=None,preserve_alpha=False):
    import pixels
    return pixels.render(path,recipe,max_size,preserve_alpha)



def analyze(path):
    path = Path(path)
    with path.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    image = open_image(path)
    width, height = image.size
    gray = image.convert('L')
    gray.thumbnail((256, 256))
    histogram = gray.histogram()
    total = sum(histogram)
    clipped = (sum(histogram[:5]) + sum(histogram[251:])) / total
    sharpness = ImageStat.Stat(gray.filter(ImageFilter.FIND_EDGES)).mean[0]
    contrast = ImageStat.Stat(gray).stddev[0]
    score = round(max(0, min(100, 25 + min(sharpness * 2, 35) + min(contrast / 2, 30) - clipped * 40)))
    sample = gray.resize((9, 8))
    pixels = list(sample.get_flattened_data())
    bits = ''.join('1' if pixels[y * 9 + x] > pixels[y * 9 + x + 1] else '0'
                   for y in range(8) for x in range(8))
    captured = path.stat().st_mtime
    time_source = 'file'
    try:
        with Image.open(path) as source:
            exif = source.getexif()
            detail = exif.get_ifd(34665) if 34665 in exif else {}
            value = detail.get(36867) or exif.get(36867) or exif.get(306)
            if value:
                captured = datetime.strptime(str(value), '%Y:%m:%d %H:%M:%S').timestamp()
                time_source = 'exif'
    except (OSError, ValueError, TypeError, KeyError):
        pass
    from workflow import visual_features
    return {'path': str(path.resolve()), 'name': path.name, 'width': width, 'height': height,
            'digest': digest, 'phash': f'{int(bits, 2):016x}', 'captured': captured,
            'time_source': time_source, 'score': score, 'features': json.dumps(visual_features(image))}


class Catalog:
    """One connection per thread; catalog and undo history persist in SQLite."""
    def __init__(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, timeout=20)
        self.db.row_factory = sqlite3.Row
        self.db.executescript('''
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS photos (
              id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
              width INTEGER, height INTEGER, digest TEXT, phash TEXT, captured REAL,
              time_source TEXT, score INTEGER, group_id TEXT, duplicate_of INTEGER,
              decision TEXT NOT NULL DEFAULT 'pending', recipe TEXT NOT NULL DEFAULT '{}');
            CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY, snapshot TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS redo_history (id INTEGER PRIMARY KEY, snapshot TEXT NOT NULL);
        ''')
        # Additive migration: existing decisions, recipes and undo history stay intact.
        columns = {row['name'] for row in self.db.execute('PRAGMA table_info(photos)')}
        if 'features' not in columns:
            self.db.execute("ALTER TABLE photos ADD COLUMN features TEXT NOT NULL DEFAULT '{}'")
        if 'hidden' not in columns:
            self.db.execute('ALTER TABLE photos ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0')
        has_albums = self.db.execute("SELECT 1 FROM sqlite_master WHERE name='albums'").fetchone()
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS albums (id INTEGER PRIMARY KEY, name TEXT NOT NULL, created REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS album_photos (album_id INTEGER NOT NULL, photo_id INTEGER NOT NULL,
                PRIMARY KEY(album_id,photo_id));
            CREATE TABLE IF NOT EXISTS composites (id INTEGER PRIMARY KEY, document TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS purged_albums (id INTEGER PRIMARY KEY);
        ''')
        album_columns = {row['name'] for row in self.db.execute('PRAGMA table_info(albums)')}
        if 'trashed_at' not in album_columns:
            self.db.execute('ALTER TABLE albums ADD COLUMN trashed_at REAL')
            self.db.execute('ALTER TABLE albums ADD COLUMN purge_at REAL')
        self.db.commit()
        self.purge_expired_albums()
        if not has_albums and self.db.execute('SELECT 1 FROM photos LIMIT 1').fetchone():
            album = self.create_album('已有照片')
            with self.db:
                self.db.execute('INSERT INTO album_photos SELECT ?,id FROM photos', (album['id'],))

    def close(self):
        self.db.close()

    def photos(self, include_hidden=False):
        self.purge_expired_albums()
        rows = [dict(row) for row in self.db.execute('SELECT * FROM photos '+('' if include_hidden else 'WHERE hidden=0 ')+'ORDER BY captured,id')]
        for row in rows:
            row['recipe'] = {**DEFAULT_RECIPE, **json.loads(row['recipe'])}
            row['render_width'], row['render_height'] = render_dimensions(row)
            row['features'] = json.loads(row['features'])
            row['album_ids'] = []
        membership = {}
        for item in self.db.execute('SELECT ap.* FROM album_photos ap JOIN albums a ON a.id=ap.album_id WHERE a.trashed_at IS NULL'):
            membership.setdefault(item['photo_id'], []).append(item['album_id'])
        for row in rows:
            row['album_ids'] = membership.get(row['id'], [])
        return rows

    def albums(self, trashed=False):
        self.purge_expired_albums()
        return [dict(row) for row in self.db.execute('''SELECT a.*,COUNT(p.id) AS count
            FROM albums a LEFT JOIN album_photos ap ON a.id=ap.album_id
            LEFT JOIN photos p ON p.id=ap.photo_id AND p.hidden=0
            WHERE a.trashed_at IS ''' + ('NOT NULL' if trashed else 'NULL') + ' GROUP BY a.id ORDER BY a.created,a.id')]

    def trash_albums(self):
        return self.albums(trashed=True)

    def purge_expired_albums(self):
        # Own transaction only outside another catalog mutation.
        expired = [row['id'] for row in self.db.execute('SELECT id FROM albums WHERE purge_at<=?', (time.time(),))]
        if not expired: return
        nested = self.db.in_transaction
        self.db.executemany('INSERT OR IGNORE INTO purged_albums(id) VALUES (?)', [(identity,) for identity in expired])
        self.db.executemany('DELETE FROM album_photos WHERE album_id=?', [(identity,) for identity in expired])
        self.db.executemany('DELETE FROM albums WHERE id=?', [(identity,) for identity in expired])
        if not nested: self.db.commit()

    def trash_album(self, identity):
        self.purge_expired_albums()
        if type(identity) is not int: raise ValueError('图集 ID 无效')
        row = self.db.execute('SELECT trashed_at FROM albums WHERE id=?', (identity,)).fetchone()
        if row is None: raise ValueError('图集不存在')
        if row['trashed_at'] is not None: return False
        now = time.time()
        with self.db:
            self.db.execute('UPDATE albums SET trashed_at=?,purge_at=? WHERE id=?', (now, now + 30 * 86400, identity))
        return True

    def restore_album(self, identity):
        self.purge_expired_albums()
        if type(identity) is not int: raise ValueError('图集 ID 无效')
        row = self.db.execute('SELECT trashed_at FROM albums WHERE id=?', (identity,)).fetchone()
        if row is None: raise ValueError('图集已销毁或不存在')
        if row['trashed_at'] is None: return False
        with self.db:
            self.db.execute('UPDATE albums SET trashed_at=NULL,purge_at=NULL WHERE id=?', (identity,))
        return True

    def create_album(self, name):
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 80:
            raise ValueError('图集名称需为 1–80 个字符')
        with self.db:
            # SQLite otherwise reuses the last deleted integer primary key,
            # allowing an old membership undo to target an unrelated new album.
            self.db.execute('BEGIN IMMEDIATE')
            identity = self.db.execute('SELECT COALESCE(MAX(id),0)+1 FROM (SELECT id FROM albums UNION ALL SELECT id FROM purged_albums)').fetchone()[0]
            cursor = self.db.execute('INSERT INTO albums(id,name,created) VALUES (?,?,?)', (identity, name.strip(), time.time()))
        return next(a for a in self.albums() if a['id'] == cursor.lastrowid)

    def save_features(self, identity, features):
        with self.db:
            self.db.execute('UPDATE photos SET features=? WHERE id=?', (json.dumps(features), identity))

    def composites(self):
        return [dict(json.loads(row['document']), id=row['id'])
                for row in self.db.execute('SELECT * FROM composites ORDER BY id DESC')]

    def save_composite(self, document):
        from workflow import validate_composite
        document = validate_composite(document, self.photos())
        identity = document.pop('id', None)
        with self.db:
            if identity is None:
                identity = self.db.execute('INSERT INTO composites(document) VALUES (?)',
                                           (json.dumps(document),)).lastrowid
            else:
                if not self.db.execute('SELECT 1 FROM composites WHERE id=?', (identity,)).fetchone():
                    raise ValueError('合成项目不存在')
                self.db.execute('UPDATE composites SET document=? WHERE id=?', (json.dumps(document), identity))
        return dict(document, id=identity)

    def import_files(self, paths, progress=None, album_id=None):
        self.purge_expired_albums()
        if album_id is not None and (type(album_id) is not int or not self.db.execute(
                'SELECT 1 FROM albums WHERE id=? AND trashed_at IS NULL', (album_id,)).fetchone()):
            raise ValueError('图集不存在，请先新建图集')
        imported, errors = [], []
        paths = list(dict.fromkeys(str(Path(p).resolve()) for p in paths))
        if album_id is None and paths:
            legacy = self.db.execute("SELECT id FROM albums WHERE name='未归档照片' AND trashed_at IS NULL LIMIT 1").fetchone()
            album_id = legacy['id'] if legacy else self.create_album('未归档照片')['id']
        for index, path in enumerate(paths):
            try:
                existing = self.db.execute('SELECT id FROM photos WHERE path=?', (path,)).fetchone()
                if existing:
                    if album_id is not None:
                        with self.db:
                            self.db.execute('BEGIN IMMEDIATE')
                            self.require_active_album(album_id)
                            self.db.execute('INSERT OR IGNORE INTO album_photos VALUES (?,?)', (album_id, existing['id']))
                            self.db.execute('UPDATE photos SET hidden=0 WHERE id=?',(existing['id'],))
                    continue
                info = analyze(path)
                columns = ','.join(info)
                with self.db:
                    self.db.execute('BEGIN IMMEDIATE')
                    if album_id is not None: self.require_active_album(album_id)
                    cursor = self.db.execute(f'INSERT INTO photos ({columns}) VALUES ({",".join("?" for _ in info)})',
                                             tuple(info.values()))
                    if album_id is not None:
                        self.db.execute('INSERT INTO album_photos VALUES (?,?)', (album_id, cursor.lastrowid))
                imported.append(path)
            except (OSError, ValueError, RuntimeError) as exc:
                errors.append({'path': path, 'error': str(exc)})
            finally:
                if progress:
                    progress(index + 1, len(paths))
        self.regroup()
        return [p for p in self.photos() if p['path'] in imported], errors

    def require_active_album(self, identity):
        if not self.db.execute('SELECT 1 FROM albums WHERE id=? AND trashed_at IS NULL', (identity,)).fetchone():
            raise ValueError('图集已删除或不存在，请先还原或新建图集')

    def regroup(self):
        seen, last, group = {}, None, None
        with self.db:
            for photo in self.photos():
                if last is None or photo['captured'] - last > 45 * 60:
                    group = str(photo['id'])
                duplicate = seen.get(photo['digest'])
                seen.setdefault(photo['digest'], photo['id'])
                self.db.execute('UPDATE photos SET group_id=?,duplicate_of=? WHERE id=?',
                                (group, duplicate, photo['id']))
                last = photo['captured']

    def edit(self, ids, recipe=None, decision=None, recipe_patch=None):
        ids = set(ids)
        if decision is not None and decision not in {'pending', 'keep', 'reject'}:
            raise ValueError('未知选片状态')
        if recipe is not None:
            recipe = validate_recipe(recipe)
        if recipe_patch is not None and (not isinstance(recipe_patch, dict) or not set(recipe_patch) <= set(DEFAULT_RECIPE)):
            raise ValueError('批量配方参数无效')
        with self.db:
            self.db.execute('BEGIN IMMEDIATE')
            targets = [p for p in self.photos() if p['id'] in ids]
            recipes = {p['id']: validate_recipe({**p['recipe'], **recipe_patch}) for p in targets} if recipe_patch is not None else {}
            targets = [p for p in targets if recipes.get(p['id'], recipe if recipe is not None else p['recipe']) != p['recipe']
                       or (decision is not None and decision != p['decision'])]
            if not targets:
                return False
            self.db.execute('INSERT INTO history(snapshot) VALUES (?)', (json.dumps(targets),))
            self.db.execute('DELETE FROM redo_history')
            for photo in targets:
                self.db.execute('UPDATE photos SET recipe=?,decision=? WHERE id=?',
                                (json.dumps(recipes.get(photo['id'], recipe if recipe is not None else photo['recipe'])),
                                 decision if decision is not None else photo['decision'], photo['id']))
        return True

    def undo(self):
        return self.restore_history('history', 'redo_history')

    def remove_photos(self, ids, album_id=None, album_ids=None):
        """Remove selected memberships atomically; no scope hides library entries.

        History records only memberships actually removed, so undo/redo cannot
        erase another album or a membership established by a later import.
        """
        if not isinstance(ids,list) or not all(type(i) is int for i in ids):
            raise ValueError('照片 ID 列表无效')
        if album_id is not None and album_ids is not None:
            raise ValueError('请只指定一种图集范围')
        if album_id is not None:
            album_ids = [album_id]
        if album_ids is not None and (not isinstance(album_ids, list) or not album_ids or
                not all(type(i) is int for i in album_ids) or len(set(album_ids)) != len(album_ids)):
            raise ValueError('图集范围必须是不重复的非空整数列表')
        scope = set(album_ids) if album_ids is not None else None
        identities = set(ids)
        with self.db:
            self.db.execute('BEGIN IMMEDIATE')
            if scope is not None:
                available = {row['id'] for row in self.db.execute('SELECT id FROM albums WHERE trashed_at IS NULL')}
                if not scope <= available: raise ValueError('图集不存在')
            targets = [p for p in self.photos() if p['id'] in identities and
                       (scope is None or scope.intersection(p['album_ids']))]
            if not targets: return False
            changes = [({'id': p['id'], 'hidden': p['hidden']} if scope is None else
                        {'id': p['id'], 'add': sorted(scope.intersection(p['album_ids'])), 'remove': []})
                       for p in targets]
            snapshot = {'operation': 'membership_delta', 'photos': changes}
            self.db.execute('INSERT INTO history(snapshot) VALUES (?)', (json.dumps(snapshot),))
            self.db.execute('DELETE FROM redo_history')
            for change in changes:
                if scope is None:
                    self.db.execute('UPDATE photos SET hidden=1 WHERE id=?', (change['id'],))
                else:
                    self.db.executemany('DELETE FROM album_photos WHERE album_id=? AND photo_id=?',
                                        [(album, change['id']) for album in change['add']])
        return True

    def redo(self):
        return self.restore_history('redo_history', 'history')

    def history_state(self):
        return {'undo': self.db.execute('SELECT COUNT(*) FROM history').fetchone()[0],
                'redo': self.db.execute('SELECT COUNT(*) FROM redo_history').fetchone()[0]}

    def restore_history(self, source, destination):
        self.purge_expired_albums()
        # Only internal fixed table names reach this helper.
        with self.db:
            self.db.execute('BEGIN IMMEDIATE')
            row = self.db.execute(f'SELECT * FROM {source} ORDER BY id DESC LIMIT 1').fetchone()
            if not row:
                return False
            snapshot = json.loads(row['snapshot'])
            if isinstance(snapshot,dict) and snapshot.get('operation') in {'membership','membership_delta'}:
                ids={p['id'] for p in snapshot['photos']}
                live={p['id']:p for p in self.photos(include_hidden=True) if p['id'] in ids}
                inverse={'operation':'membership_delta','photos':[]}
                for saved in snapshot['photos']:
                    current=live.get(saved['id'])
                    if current is None:continue
                    members=set(current['album_ids']);operation=dict(saved)
                    if snapshot['operation']=='membership':
                        # Older full snapshots must not erase memberships added
                        # by later imports, which are outside edit undo history.
                        operation={'id':saved['id'],'add':list(set(saved['album_ids'])-members),'remove':[],'hidden':saved['hidden']}
                    active = {row['id'] for row in self.db.execute('SELECT id FROM albums WHERE trashed_at IS NULL')}
                    added=[a for a in operation.get('add',[]) if a not in members and a in active]
                    removed=[a for a in operation.get('remove',[]) if a in members]
                    reverse={'id':saved['id'],'add':removed,'remove':added}
                    self.db.executemany('INSERT OR IGNORE INTO album_photos VALUES (?,?)',[(a,saved['id']) for a in added])
                    self.db.executemany('DELETE FROM album_photos WHERE album_id=? AND photo_id=?',[(a,saved['id']) for a in removed])
                    if 'hidden' in operation:
                        reverse['hidden']=current['hidden'];self.db.execute('UPDATE photos SET hidden=? WHERE id=?',(operation['hidden'],saved['id']))
                    inverse['photos'].append(reverse)
                self.db.execute(f'INSERT INTO {destination}(snapshot) VALUES (?)',(json.dumps(inverse),))
                self.db.execute(f'DELETE FROM {source} WHERE id=?',(row['id'],))
                return True
            ids = {p['id'] for p in snapshot}
            current = [{'id': p['id'], 'recipe': p['recipe'], 'decision': p['decision']}
                       for p in self.photos() if p['id'] in ids]
            self.db.execute(f'INSERT INTO {destination}(snapshot) VALUES (?)', (json.dumps(current),))
            for photo in snapshot:
                self.db.execute('UPDATE photos SET recipe=?,decision=? WHERE id=?',
                                (json.dumps(photo['recipe']), photo['decision'], photo['id']))
            self.db.execute(f'DELETE FROM {source} WHERE id=?', (row['id'],))
        return True


def export_photo(photo, folder, template='plain', size=2400, format='jpeg', cancellation=None):
    """Full-source float processing, then one explicit codec boundary; never overwrite."""
    import pixels
    import numpy as np
    extensions={'jpeg':'.jpg','png':'.png','tiff':'.tif','webp':'.webp','original':Path(photo['path']).suffix.lower()}
    if format not in extensions or template not in TEMPLATES or (int(size)!=0 and not 300<=int(size)<=12000):
        raise ValueError('导出规格无效')
    size=int(size);folder=Path(folder).resolve();folder.mkdir(parents=True,exist_ok=True)
    image=None
    if cancellation: cancellation.check()
    if format!='original':
        with cancellation_scope(cancellation):
            image=render_pixels(photo['path'],photo['recipe'],preserve_alpha=format in {'png','tiff','webp'})
        h,w=image.shape[:2]
        if template=='plain':
            if size and max(w,h)>size:
                scale=size/max(w,h);image=pixels.resize(image,(max(1,round(w*scale)),max(1,round(h*scale))))
        else:
            canvas_width=size or math.ceil(max(w/.87,h/(.87 if template=='frame' else 1.12)))
            canvas_height=canvas_width if template=='frame' else round(canvas_width*1.25)
            margin=round(canvas_width*.065);scale=min(1,(canvas_width-2*margin)/w,(canvas_height-2*margin)/h)
            if scale<1:image=pixels.resize(image,(max(1,round(w*scale)),max(1,round(h*scale))))
            canvas=np.empty((canvas_height,canvas_width,3),np.float32);canvas[:]=np.array([247,245,240],np.float32)/255
            ih,iw=image.shape[:2];y=(canvas_height-ih)//2;x=(canvas_width-iw)//2
            if image.shape[-1]==4:canvas[y:y+ih,x:x+iw]=image[...,:3]*image[...,3:]+canvas[y:y+ih,x:x+iw]*(1-image[...,3:])
            else:canvas[y:y+ih,x:x+iw]=image
            image=canvas
    if cancellation: cancellation.check()
    stem=Path(photo['name']).stem;suffix=0
    while True:
        path=folder/(stem+'_photoall'+(f'_{suffix}' if suffix else '')+extensions[format]);sidecar=path.with_suffix('.recipe.json')
        if sidecar.exists():suffix+=1;continue
        try:
            with path.open('xb'):pass
            break
        except FileExistsError:suffix+=1
    temporary=None; sidecar_created=False
    try:
        with tempfile.NamedTemporaryFile(dir=folder,suffix='.tmp',delete=False) as stream:
            temporary=Path(stream.name)
            if format=='original':
                with Path(photo['path']).open('rb') as source:shutil.copyfileobj(source,stream)
            else:pixels.write(stream,image,{'jpeg':'jpeg','png':'png16','tiff':'tiff16','webp':'webp_lossless'}[format])
        if cancellation: cancellation.check()
        os.replace(temporary,path)
        metadata={'schema':2,'source_name':photo['name'],'source_sha256':photo['digest'],'recipe':photo['recipe'],
            'template':template,'size':size,'format':format,'pipeline':'float32 sRGB SDR',
            'output_color':'original bytes' if format=='original' else 'sRGB SDR '+('16-bit' if format in {'png','tiff'} else '8-bit'),
            'recipe_applied':format!='original','lossless_encoding':format!='jpeg',
            'film_simulation':{'engine':'spektrafilm 0.3.4','revision':film.REVISION,'stock':photo['recipe'].get('film_stock'),
                'mode':'33^3 sRGB float LUT','spatial_effects':'Photo All additions'} if format!='original' and photo['recipe'].get('film_stock','none')!='none' else None}
        with sidecar.open('x',encoding='utf-8') as stream:
            sidecar_created=True
            json.dump(metadata,stream,ensure_ascii=False,indent=2)
        if cancellation: cancellation.check()
        return path
    except Exception:
        if temporary:temporary.unlink(missing_ok=True)
        if sidecar_created:sidecar.unlink(missing_ok=True)
        path.unlink(missing_ok=True);raise


def export_raw_tiff(photo, folder, cancellation=None):
    """Full-resolution 16-bit sRGB TIFF: RAW development only, no 8-bit style or frame."""
    if Path(photo['path']).suffix.lower() not in RAW:
        raise ValueError('16-bit RAW 导出只接受相机 RAW 文件')
    recipe = validate_recipe(photo.get('recipe', {}))
    with cancellation_scope(cancellation):
        developed = develop_raw(photo['path'], recipe, output_16bit=True)
    if cancellation: cancellation.check()
    folder = Path(folder).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    count = 0
    while True:
        stem = Path(photo['path']).stem + '_raw' + (f'_{count}' if count else '')
        output = folder / (stem + '.tif')
        pp3 = folder / (stem + '.pp3')
        if pp3.exists():
            count += 1
            continue
        try:
            stream = output.open('xb')
            break
        except FileExistsError:
            count += 1
    profile_created = False
    try:
        with stream, developed.open('rb') as source:
            shutil.copyfileobj(source, stream)
        if cancellation: cancellation.check()
        with pp3.open('x', encoding='utf-8') as profile:
            profile_created = True
            profile.write(raw_profile(recipe))
        if cancellation: cancellation.check()
        return output
    except Exception:
        if profile_created: pp3.unlink(missing_ok=True)
        output.unlink(missing_ok=True)
        raise
