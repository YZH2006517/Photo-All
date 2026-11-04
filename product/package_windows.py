# SPDX-License-Identifier: GPL-3.0-or-later
"""Stage a curated CPython runtime, then build NSIS and a portable ZIP on Windows.

No workstation Python paths are embedded in the output. Build tools are needed
only on the builder; end users need Windows 10/11 x64 and Microsoft WebView2.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from difflib import unified_diff
import fnmatch
import hashlib
import importlib.metadata
from io import BytesIO
import json
import os
import platform
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import tomllib
import urllib.request
from urllib.parse import unquote
import zipfile

ROOT = Path(__file__).resolve().parent
WORKSPACE = ROOT.parent
STAGE = ROOT / 'build/runtime'
DOWNLOADS = WORKSPACE / 'validation/downloads'
PYTHON_URL = 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip'
PYTHON_SHA256 = '4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3'
RAW_RELEASE = 'RawTherapee_5.13_win64_x86_64_release'
RAW_URL = f'https://github.com/RawTherapee/RawTherapee/releases/download/5.13/{RAW_RELEASE}.zip'
RAW_SHA256 = 'ba29d23f3f12097c925bdab6d80e831a84ed3a88a81ce94606e4dcc796fa87ee'
RAW_SOURCE_URL = 'https://github.com/RawTherapee/RawTherapee/archive/refs/tags/5.13.tar.gz'
RAW_SOURCE_SHA256 = '09c7a1e1ad39cf1fe178a3a8e392fb0426e81c540106937801e54549e3567ea4'
BASE_WHEELS = {'numpy': '2.3.5', 'pillow': '12.3.0', 'packaging': '26.3'}
PRECISION_WHEELS = {'imagecodecs': '2026.10.10', 'pypng': '0.20220715.0', 'tifffile': '2026.10.15'}
RECOGNITION_WHEELS = {'onnxruntime': '1.23.2', 'tokenizers': '0.22.1'}
RUNTIME_FILES = ['service.py', 'engine.py', 'pixels.py', 'workflow.py', 'film.py', 'film_spectral.py', 'film_negative.py', 'borders.py',
                 'open_filters.py', 'open-filters-manifest.json',
                 'app.py', 'companion.cmd', 'LICENSE', 'README.md']
SPECTRAL_PYTHON_VERSION = '3.13.13'
SPECTRAL_PYTHON_PATHS = '.\nLib\nDLLs\nLib/site-packages\n..\\..\n'
SPECTRAL_REVISION = '3bb2c2d2801ff68b92019cf1dbcbb133d60832bc'
SPECTRAL_SOURCE_URL = f'https://codeload.github.com/andreavolpato/spektrafilm/legacy.tar.gz/{SPECTRAL_REVISION}'
SPECTRAL_SOURCE_SHA256 = '0cc38b1c497047da14b153d4d5ba0cdf0a83da04cb1c1b1d113a971f624a04f9'
SPECTRAL_WHEELS = {
    'numpy': '2.5.4', 'scipy': '1.18.1', 'colour-science': '0.4.7', 'scikit-image': '0.26.0',
    'matplotlib': '3.11.2', 'opt-einsum': '3.4.0', 'numba': '0.68.1', 'llvmlite': '0.50.0',
    'pillow': '12.3.0', 'imageio': '2.38.1', 'tifffile': '2026.10.15', 'networkx': '3.7',
    'lazy-loader': '0.6', 'packaging': '26.3', 'contourpy': '1.4.0', 'cycler': '0.12.1',
    'fonttools': '4.68.0', 'kiwisolver': '1.5.1', 'pyparsing': '3.3.3',
    'python-dateutil': '3.0.0', 'six': '1.17.0', 'tzdata': '2026.6',
}
SPECTRAL_PACKAGES = set(SPECTRAL_WHEELS) | {'spektrafilm'}
# LUT baking uses the unmodified upstream CLI dependency closure. These are
# builder tools only and are excluded from the staged spectral worker.
LUT_BAKER_WHEELS = {'openimageio': '3.1.19.0', 'pyfftw': '0.15.1', 'rawpy': '0.26.1',
                    'exiv2': '0.18.1', 'lensfunpy': '1.18.0', 'markdown': '3.11.2',
                    'setuptools': '80.9.0', 'wheel': '0.45.1'}
SPECTRAL_PATCH_NAME = 'spektrafilm-photo-all.patch'
SPECTRAL_PATCHES = {
    'utils/__init__.py': ('d5afe630ecca3efaca71f549537375433fea141d108a16dc68617b8a18f256f4', [
        ('from spektrafilm.utils.raw_file_processor import load_and_process_raw_file',
         'def __getattr__(name):\n'
         "    if name == 'load_and_process_raw_file':\n"
         '        from spektrafilm.utils.raw_file_processor import load_and_process_raw_file\n'
         '        return load_and_process_raw_file\n'
         '    raise AttributeError(name)'),
    ]),
    'utils/io.py': ('3d15ffa56cc27f3c34a0967570afb406ce08e33b237300c603e6715ae7825ef0', [
        ('import exiv2\n', ''),
        ('import OpenImageIO as oiio\n', ''),
        ('    try:\n        image = exiv2.ImageFactory.open(filename)',
         '    import exiv2\n\n    try:\n        image = exiv2.ImageFactory.open(filename)'),
        ('    image_input = oiio.ImageInput.open(filename)',
         '    import exiv2\n    import OpenImageIO as oiio\n\n    image_input = oiio.ImageInput.open(filename)'),
        ('def load_image_oiio(filename):\n', 'def load_image_oiio(filename):\n    import OpenImageIO as oiio\n\n'),
        ('    # Extract image dimensions and number of channels',
         '    import OpenImageIO as oiio\n\n    # Extract image dimensions and number of channels'),
    ]),
    'utils/fft_gaussian_filter.py': ('ac3e96ad0923c30bfe71129e208f51d61059288a0ba55b9f2b15e1a249001ecc', [
        ('import pyfftw.interfaces.numpy_fft as fft  # use pyFFTW FFT routines', 'from scipy import fft'),
        ('    Uses pyFFTW for FFT operations.', '    Uses SciPy for FFT operations.'),
        (", planner_effort='FFTW_MEASURE'", ''),
        ('(pyFFTW)', '(SciPy FFT)'),
    ]),
}

# Exact binary ownership is confirmed by SHA-256, never inferred from the name
# alone. Full source packages retain upstream tarballs, patches and PKGBUILD.
RAW_PACKAGES = {
    'atk': ['libatk-1.0-0.dll'], 'atkmm': ['libatkmm-*.dll'],
    'brotli': ['libbrotli*.dll'], 'bzip2': ['libbz2-1.dll'],
    'cairo': ['libcairo-2.dll', 'libcairo-gobject-2.dll'], 'cairomm': ['libcairomm*.dll'],
    'openssl': ['libcrypto*.dll', 'libssl*.dll'], 'curl': ['libcurl-4.dll'],
    'libdatrie': ['libdatrie-1.dll'], 'libdeflate': ['libdeflate.dll'],
    'libepoxy': ['libepoxy-0.dll'], 'exiv2': ['libexiv2-28.dll'],
    'expat': ['libexpat-1.dll'], 'libffi': ['libffi-8.dll'],
    'fftw': ['libfftw*.dll'], 'fontconfig': ['libfontconfig-1.dll'],
    'freetype': ['libfreetype-6.dll'], 'fribidi': ['libfribidi-0.dll'],
    'gcc-libs': ['libgcc_s_seh-1.dll', 'libgomp-1.dll', 'libstdc++-6.dll'],
    'gdk-pixbuf2': ['libgdk_pixbuf-*.dll', 'libpixbufloader-ani.dll', 'libpixbufloader-bmp.dll',
                    'libpixbufloader-gif.dll', 'libpixbufloader-icns.dll', 'libpixbufloader-ico.dll',
                    'libpixbufloader-jpeg.dll', 'libpixbufloader-png.dll', 'libpixbufloader-pnm.dll',
                    'libpixbufloader-qtif.dll', 'libpixbufloader-tga.dll', 'libpixbufloader-tiff.dll',
                    'libpixbufloader-xbm.dll', 'libpixbufloader-xpm.dll'],
    'gtk3': ['libgdk-3-0.dll', 'libgtk-3-0.dll'],
    'gtkmm3': ['libgdkmm-3.0-1.dll', 'libgtkmm-3.0-1.dll'],
    'glib2': ['libgio-2.0-0.dll', 'libglib-2.0-0.dll', 'libgmodule-2.0-0.dll',
              'libgobject-2.0-0.dll', 'gdbus.exe', 'gspawn-win64-helper*.exe'],
    'glibmm': ['libgiomm-2.4-1.dll', 'libglibmm-2.4-1.dll'],
    'graphite2': ['libgraphite2.dll'], 'harfbuzz': ['libharfbuzz-0.dll'],
    'highway': ['libhwy.dll'], 'libiconv': ['libiconv-2.dll'],
    'libidn2': ['libidn2-0.dll'], 'libinih': ['libinih-0.dll', 'libINIReader-0.dll'],
    'gettext-runtime': ['libintl-8.dll'], 'jbigkit': ['libjbig-0.dll'],
    'libjpeg-turbo': ['libjpeg-8.dll'], 'libjxl': ['libjxl*.dll', 'libpixbufloader-jxl.dll'],
    'lcms2': ['liblcms2-2.dll'], 'lensfun': ['liblensfun.dll'], 'lerc': ['libLerc.dll'],
    'xz': ['liblzma-5.dll'], 'nghttp2': ['libnghttp2-14.dll'],
    'nghttp3': ['libnghttp3-9.dll'], 'ngtcp2': ['libngtcp2*.dll'],
    'pango': ['libpango-1.0-0.dll', 'libpangocairo-1.0-0.dll', 'libpangoft2-1.0-0.dll', 'libpangowin32-1.0-0.dll'],
    'pangomm': ['libpangomm-1.4-1.dll'], 'pcre2': ['libpcre2-8-0.dll'],
    'pixman': ['libpixman-1-0.dll'], 'libpng': ['libpng16-16.dll'],
    'libpsl': ['libpsl-5.dll'], 'librsvg': ['librsvg-2-2.dll', 'pixbufloader_svg.dll'],
    'libwebp': ['libsharpyuv-0.dll', 'libwebp-7.dll'],
    'libsigc++': ['libsigc-2.0-0.dll'], 'libssh2': ['libssh2-1.dll'],
    'libsystre': ['libsystre-0.dll'], 'libthai': ['libthai-0.dll'],
    'libtiff': ['libtiff-6.dll'], 'libtre': ['libtre-5.dll'],
    'libunistring': ['libunistring-5.dll'], 'libwinpthread': ['libwinpthread-1.dll'],
    'libxml2': ['libxml2-16.dll'], 'zstd': ['libzstd.dll'], 'zlib': ['zlib1.dll'],
}


def fetch(url, path, expected=None):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_file():
        if expected and sha256(path) != expected:
            raise RuntimeError('SHA-256 mismatch: ' + str(path))
        return path
    temporary = path.with_suffix(path.suffix + '.partial')
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, headers={'User-Agent': 'Photo-All-Windows-builder/1.0'})
            with urllib.request.urlopen(request, timeout=120) as response, temporary.open('wb') as stream:
                shutil.copyfileobj(response, stream, length=1024 * 1024)
            if expected and sha256(temporary) != expected:
                raise RuntimeError('SHA-256 mismatch: ' + url)
            temporary.replace(path)
            return path
        except OSError:
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)
        finally:
            temporary.unlink(missing_ok=True)


def spectral_source_archive():
    return fetch(SPECTRAL_SOURCE_URL, DOWNLOADS / f'spektrafilm-{SPECTRAL_REVISION}.tar.gz',
                 SPECTRAL_SOURCE_SHA256)


def visual_cpp_runtime():
    override = os.environ.get('VCToolsRedistDir')
    if override:
        base = Path(override)
        for candidate in (base / 'x64/Microsoft.VC143.CRT', base):
            if (candidate / 'msvcp140.dll').is_file():
                return candidate
        raise RuntimeError('VCToolsRedistDir does not contain the x64 Visual C++ runtime')

    program_files = Path(os.environ.get('ProgramFiles(x86)', 'C:/Program Files (x86)'))
    vswhere = program_files / 'Microsoft Visual Studio/Installer/vswhere.exe'
    if vswhere.is_file():
        result = subprocess.run([str(vswhere), '-products', '*', '-utf8', '-property', 'installationPath'],
                                capture_output=True, encoding='utf-8', check=True)
        for line in result.stdout.splitlines():
            if not line.strip():
                continue
            redist = Path(line.strip()) / 'VC/Redist/MSVC'
            candidates = sorted(redist.glob('*/x64/Microsoft.VC143.CRT'),
                                key=lambda path: tuple(int(part) for part in path.parents[1].name.split('.')),
                                reverse=True)
            for candidate in candidates:
                if (candidate / 'msvcp140.dll').is_file():
                    return candidate
    raise RuntimeError('Install the x64 Visual C++ redistributable component or set VCToolsRedistDir')


def package_versions(directory):
    return {dist.metadata['Name'].lower().replace('_', '-'): dist.version
            for dist in importlib.metadata.distributions(path=[str(directory)])}


def install_wheels(destination, pins):
    if package_versions(destination) == pins:
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.resolve().parent != (ROOT / 'engines').resolve():
        raise RuntimeError('Invalid builder package directory: ' + str(destination))
    with tempfile.TemporaryDirectory(prefix='wheels-', dir=destination.parent) as directory:
        target = Path(directory) / 'packages'
        requirements = [f'{name}=={version}' for name, version in pins.items()]
        subprocess.run([sys.executable, '-m', 'pip', 'install', '--only-binary=:all:', '--no-deps',
                        '--target', str(target), *requirements], check=True)
        if package_versions(target) != pins:
            raise RuntimeError('Builder wheel versions did not match the requested pins')
        if destination.exists():
            shutil.rmtree(destination)
        target.replace(destination)


def prepare_builder():
    """Prepare public, pinned inputs on a clean Windows x64 runner."""
    if sys.platform != 'win32' or sys.version_info[:2] != (3, 12) or platform.machine().upper() != 'AMD64':
        raise RuntimeError('Run prepare with 64-bit Windows CPython 3.12')
    uv = shutil.which('uv')
    if not uv:
        raise RuntimeError('Install uv and make it available on PATH before running prepare')
    visual_cpp_runtime()
    verify_border_assets(ROOT)

    engines = ROOT / 'engines'
    builder_site = engines / 'builder-site-packages'
    install_wheels(builder_site, BASE_WHEELS)
    install_wheels(engines / 'precision-packages', PRECISION_WHEELS)
    install_wheels(engines / 'recognition-runtime', RECOGNITION_WHEELS)

    fetch(PYTHON_URL, DOWNLOADS / PYTHON_URL.rsplit('/', 1)[1], PYTHON_SHA256)
    archive = fetch(RAW_URL, DOWNLOADS / f'{RAW_RELEASE}.zip', RAW_SHA256)
    raw = engines / 'RawTherapee-5.13'
    if not (raw / RAW_RELEASE / 'rawtherapee-cli.exe').is_file():
        with zipfile.ZipFile(archive) as source:
            source.extractall(raw)
    fetch(RAW_SOURCE_URL, DOWNLOADS / 'RawTherapee-5.13-source.tar.gz', RAW_SOURCE_SHA256)

    from setup_recognition import ASSETS, REVISION
    model = engines / 'clip-vit-base-patch32'
    for name, digest in ASSETS.items():
        fetch(f'https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/{REVISION}/{name}',
              model / name, digest)
    fetch('https://raw.githubusercontent.com/openai/CLIP/main/LICENSE', model / 'LICENSE',
          '987e63b32f6c89ff5160e429458a872ff048e6860b590a3912e938f9da8f14db')
    (model / 'revision.txt').write_text(REVISION, encoding='utf-8')

    source_archive = spectral_source_archive()
    source_parent = engines / 'spektrafilm-source'
    source = source_parent / f'andreavolpato-spektrafilm-{SPECTRAL_REVISION[:7]}'
    if not (source / 'pyproject.toml').is_file():
        with tarfile.open(source_archive) as bundle:
            bundle.extractall(source_parent, filter='data')
    environment = {**os.environ, 'UV_CACHE_DIR': str(engines / 'uv-cache'),
                   'UV_PYTHON_INSTALL_DIR': str(engines / 'python')}
    venv = engines / 'film-runtime'
    python = venv / 'Scripts/python.exe'
    if not python.is_file():
        subprocess.run([uv, 'venv', str(venv), '--python', SPECTRAL_PYTHON_VERSION,
                        '--managed-python'], env=environment, check=True)
    packages = venv / 'Lib/site-packages'
    spectral_pins = SPECTRAL_WHEELS | LUT_BAKER_WHEELS
    installed = package_versions(packages)
    missing = [f'{name}=={version}' for name, version in spectral_pins.items() if installed.get(name) != version]
    if missing:
        subprocess.run([uv, 'pip', 'install', '--python', str(python), '--no-deps',
                        '--only-binary', ':all:', *missing], env=environment, check=True)
    if installed.get('spektrafilm') != '0.3.4':
        subprocess.run([uv, 'pip', 'install', '--python', str(python), '--no-deps',
                        '--no-build-isolation', str(source)], env=environment, check=True)
    subprocess.run([str(python), str(ROOT / 'film.py'), '--bake'],
                   env={**environment, 'MPLBACKEND': 'Agg', 'OPENBLAS_NUM_THREADS': '2'}, check=True)
    subprocess.run([sys.executable, str(ROOT / 'film.py'), '--setup-filters'],
                   env={**os.environ, 'PYTHONPATH': str(builder_site)}, check=True)
    verify_open_filters(ROOT)
    print('Builder dependencies ready. Run package_windows.py all to generate sources, stage, and build.', flush=True)


def corresponding_sources():
    """Retrieve matching MSYS2 binary provenance and complete source packages."""
    base = 'https://repo.msys2.org/mingw/'
    binary_index = unquote(fetch(base + 'ucrt64/', DOWNLOADS / 'msys2-ucrt64-index.html').read_text(encoding='utf-8'))
    source_index = unquote(fetch(base + 'sources/', DOWNLOADS / 'msys2-sources-index.html').read_text(encoding='utf-8'))
    entries = [(name, datetime.strptime(date, '%d-%b-%Y %H:%M')) for name, date in
               re.findall(r'<a href="([^"]+)".*?</a\s*>\s+(\d{2}-\w{3}-\d{4} \d{2}:\d{2})', binary_index, re.S)
               if name.endswith('.pkg.tar.zst')]
    cutoff = datetime(2026, 7, 25, 23, 59)
    raw = ROOT / 'engines/RawTherapee-5.13' / RAW_RELEASE
    libraries = [p for p in raw.rglob('*') if p.is_file() and p.suffix.lower() in {'.dll', '.exe'}
                 and p.name not in {'rawtherapee.exe', 'rawtherapee-cli.exe'}]
    assigned = set()
    jobs = []
    for package, patterns in RAW_PACKAGES.items():
        files = [p for p in libraries if any(fnmatch.fnmatchcase(p.name.lower(), pattern.lower()) for pattern in patterns)]
        if files:
            jobs.append((package, files))
            assigned.update(files)
    if set(libraries) != assigned:
        raise RuntimeError('Unmapped libraries: ' + ', '.join(str(p) for p in set(libraries) - assigned))
    output = ROOT / 'build/third-party-sources'
    output.mkdir(parents=True, exist_ok=True)
    icons = [p for p in (raw / 'share/icons/Adwaita').rglob('*') if p.is_file()]
    jobs.append(('adwaita-icon-theme', icons))
    # Read binary package contents without writing files or following archive
    # paths onto the host filesystem. Large source archives use streaming bsdtar.
    sys.path[:0] = [str(ROOT / 'engines/precision-packages'), str(ROOT / 'engines/builder-site-packages')]
    import imagecodecs

    def prepare(job):
        package, files = job
        cached = output / 'provenance' / (package + '.json')
        if cached.is_file():
            result = json.loads(cached.read_text(encoding='utf-8'))
            source = output / result['source_url'].rsplit('/', 1)[-1]
            if source.is_file() and sha256(source) == result['source_sha256'] and len(result['dlls']) == len(files) and all(
                result['dlls'].get(str(p.relative_to(raw)).replace('\\', '/')) == sha256(p) for p in files):
                return result
        expression = re.compile(r'mingw-w64-ucrt-x86_64-' + re.escape(package) + r'-\d')
        candidates = sorted([(name, date) for name, date in entries if expression.match(name) and date <= cutoff],
                            key=lambda item: item[1], reverse=True)
        expected = {str(p.relative_to(raw)).replace('\\', '/'): sha256(p) for p in files}
        failures = []
        for name, _ in candidates[:10]:
            archive = fetch(base + 'ucrt64/' + name, DOWNLOADS / 'msys2-binaries' / name)
            found = {}
            with tarfile.open(fileobj=BytesIO(imagecodecs.zstd_decode(archive.read_bytes()))) as binary:
                for member in binary:
                    relative = member.name.removeprefix('ucrt64/')
                    relative = relative.removeprefix('bin/')
                    if relative in expected:
                        found[relative] = hashlib.sha256(binary.extractfile(member).read()).hexdigest()
                pkginfo = binary.extractfile('.PKGINFO').read().decode('utf-8')
                buildinfo = binary.extractfile('.BUILDINFO').read().decode('utf-8')
                licenses = [member for member in binary.getmembers() if member.isfile() and '/share/licenses/' in member.name]
                notices = '\n'.join('=== ' + member.name + ' ===\n' + binary.extractfile(member).read().decode('utf-8', errors='replace') for member in licenses)
            if found != expected:
                failures.append(name)
                continue
            metadata = {}
            for line in pkginfo.splitlines():
                if ' = ' in line:
                    key, value = line.split(' = ', 1)
                    metadata.setdefault(key, []).append(value)
            pkgbase, version = metadata['pkgbase'][0], metadata['pkgver'][0]
            source_name = f'{pkgbase}-{version}.src.tar.zst'
            if f'href="{source_name}"' not in source_index:
                raise RuntimeError(f'Exact source archive absent: {source_name}')
            source = fetch(base + 'sources/' + source_name, output / source_name)
            source_listing = subprocess.run(['tar', '-tf', str(source)], capture_output=True, text=True, check=True).stdout.splitlines()
            recipe = next((item for item in source_listing if item.endswith('/PKGBUILD')), None)
            if recipe is None:
                raise RuntimeError('Source package has no PKGBUILD: ' + source_name)
            recipe_bytes = subprocess.run(['tar', '-xOf', str(source), recipe], capture_output=True, check=True).stdout
            recorded_recipe_hash = re.search(r'^pkgbuild_sha256sum = (.+)$', buildinfo, re.M)
            if recorded_recipe_hash and hashlib.sha256(recipe_bytes).hexdigest() != recorded_recipe_hash[1]:
                raise RuntimeError('Source recipe does not match binary build: ' + source_name)
            evidence = output / 'provenance'
            evidence.mkdir(exist_ok=True)
            (evidence / (package + '.PKGINFO')).write_text(pkginfo, encoding='utf-8')
            (evidence / (package + '.BUILDINFO')).write_text(buildinfo, encoding='utf-8')
            (evidence / (package + '-LICENSES.txt')).write_text(notices, encoding='utf-8')
            result = {'package': metadata['pkgname'][0], 'pkgbase': pkgbase, 'version': version,
                      'license': metadata.get('license', []), 'binary_url': base + 'ucrt64/' + name,
                      'binary_sha256': sha256(archive), 'source_url': base + 'sources/' + source_name,
                      'source_sha256': sha256(source), 'source_bytes': source.stat().st_size,
                      'pkgbuild_sha256': hashlib.sha256(recipe_bytes).hexdigest(),
                      'dlls': {str(p.relative_to(raw)).replace('\\', '/'): sha256(p) for p in files}}
            print(f'Source verified: {package} {version} ({len(files)} files)', flush=True)
            cached.write_text(json.dumps(result, indent=2), encoding='utf-8')
            return result
        raise RuntimeError(f'No exact DLL match for {package}; candidates: {failures}')

    results = []
    failures = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(prepare, job): job[0] for job in jobs}
        for future in as_completed(futures):
            try:
                results.append(future.result())
            except Exception as error:
                failures.append(f'{futures[future]}: {error}')
                print(f'Source unresolved: {futures[future]}: {error}', flush=True)
        (output / 'manifest.partial.json').write_text(json.dumps({'packages': results, 'errors': failures}, indent=2), encoding='utf-8')
    if failures:
        raise RuntimeError('\n'.join(failures))
    results.sort(key=lambda result: result['package'])
    notices = []
    for result in results:
        package = result['package'].removeprefix('mingw-w64-ucrt-x86_64-')
        binary = DOWNLOADS / 'msys2-binaries' / result['binary_url'].rsplit('/', 1)[-1]
        notice = output / 'provenance' / (package + '-LICENSES.txt')
        if not notice.is_file():
            with tarfile.open(fileobj=BytesIO(imagecodecs.zstd_decode(binary.read_bytes()))) as source:
                notice.write_text('\n'.join('=== ' + member.name + ' ===\n' + source.extractfile(member).read().decode('utf-8', errors='replace')
                    for member in source if member.isfile() and '/share/licenses/' in member.name), encoding='utf-8')
        notices.append(f"\n=== {result['package']} {result['version']}: {', '.join(result['license'])} ===\n" + notice.read_text(encoding='utf-8'))
    (output / 'LICENSES.txt').write_text('\n'.join(notices), encoding='utf-8')
    (output / 'manifest.json').write_text(json.dumps({'rawtherapee_version': '5.13',
        'rawtherapee_commit': '1924179107995b01b73cdc7f4fe91e44fc8227a7',
        'dlls_verified': len(libraries), 'packages': results}, indent=2), encoding='utf-8')
    (output / 'manifest.partial.json').unlink(missing_ok=True)
    copy(fetch(RAW_SOURCE_URL, DOWNLOADS / 'RawTherapee-5.13-source.tar.gz', RAW_SOURCE_SHA256),
         output / 'RawTherapee-5.13-source.tar.gz')
    copy(spectral_source_archive(), output / 'spektrafilm-source.tar.gz')
    (output / 'README.txt').write_text('Corresponding third-party source for the unmodified RawTherapee 5.13 Windows x64 distribution.\n'
        'manifest.json maps every redistributed DLL/helper EXE to a byte-for-byte verified MSYS2 binary package, '
        'its complete source package and PKGBUILD hash. provenance contains package license metadata and build environment.\n'
        'Extract *.src.tar.zst with bsdtar/7-Zip. These contain upstream source archives, patches and MSYS2 build scripts.\n'
        'Rebuild packages with MSYS2 makepkg-mingw using the recorded .BUILDINFO environment. '
        'The RawTherapee source contains .github/workflows/windows.yml with its original build/bundle steps.\n'
        'Photo All application source is provided separately with the same release.\n', encoding='utf-8')
    dist = ROOT / 'dist'
    dist.mkdir(exist_ok=True)
    archive = dist / 'Photo-All-third-party-corresponding-source.zip'
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_STORED) as target:
        for path in sorted(output.rglob('*')):
            if path.is_file():
                target.write(path, path.relative_to(output))
    print(json.dumps({'source_archive': str(archive), 'bytes': archive.stat().st_size,
                      'sha256': sha256(archive), 'packages': len(results), 'dlls': len(libraries)}, indent=2))


def sha256(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def verify_open_filters(base):
    """Reject partial look libraries and omitted upstream/adaptation notices."""
    base = Path(base)
    manifest = base / 'open-filters-manifest.json'
    assets = base / 'engines/open-filters'
    if not manifest.is_file():
        raise RuntimeError('Open-filter manifest is missing; run film.py --setup-filters')
    data = json.loads(manifest.read_text(encoding='utf-8'))
    for name in ['manifest.json', 'UPSTREAM-README.txt', 'LICENSE-CC-BY-SA-4.0.txt', 'CHANGES.txt']:
        if not (assets / name).is_file():
            raise RuntimeError('Open-filter notice is missing: ' + name)
    if (assets / 'manifest.json').read_bytes() != manifest.read_bytes():
        raise RuntimeError('Open-filter asset manifest is outdated; run film.py --setup-filters')
    if not data.get('items'):
        raise RuntimeError('Open-filter manifest has no assets')
    for identity, entry in data['items'].items():
        asset = assets / (identity + '.npy')
        if not asset.is_file() or sha256(asset) != entry['sha256']:
            raise RuntimeError('Open-filter asset is missing or has changed: ' + identity)
    return data


def verify_border_assets(base):
    """Require pinned originals and their MIT notices in every distribution."""
    assets = Path(base) / 'engines/film-borders'
    data = json.loads((assets / 'SOURCES.json').read_text(encoding='utf-8'))
    if len(data.get('sources', [])) != 2:
        raise RuntimeError('Film-border source manifest is incomplete')
    for source in data['sources']:
        asset = assets / source['asset']
        if not asset.is_file() or sha256(asset) != source['sha256']:
            raise RuntimeError('Film-border original is missing or changed: ' + source['asset'])
    for name in ['LICENSE-romnn-MIT.txt', 'LICENSE-NegativeConverter-MIT.txt']:
        if not (assets / name).is_file():
            raise RuntimeError('Film-border MIT notice is missing: ' + name)
    return data


def open_filter_sources():
    """Package the original look archive separately; leave existing sources intact."""
    data = verify_open_filters(ROOT)
    original = DOWNLOADS / 'open-filters/RawTherapee-HaldCLUT.zip'
    if not original.is_file() or sha256(original) != data['archive_sha256']:
        raise RuntimeError('Open-filter original archive checksum mismatch; run film.py --setup-filters')
    output = ROOT / 'dist/Photo-All-open-filter-sources.zip'
    output.parent.mkdir(parents=True, exist_ok=True)
    # The upstream ZIP is already compressed. Store it verbatim rather than
    # recompressing it or rebuilding the unrelated MSYS2 source distribution.
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_STORED) as target:
        target.write(original, original.name)
        for name in ['open-filters-manifest.json', 'open_filters.py', 'LICENSE']:
            target.write(ROOT / name, name)
        for name in ['UPSTREAM-README.txt', 'LICENSE-CC-BY-SA-4.0.txt', 'CHANGES.txt']:
            target.write(ROOT / 'engines/open-filters' / name, name)
        target.writestr('README.txt',
            'Original RawTherapee Film Simulation Collection lookup assets and notices.\n'
            f"Pinned revision: {data['revision']}\n"
            f"Original archive SHA-256: {data['archive_sha256']}\n"
            'See open-filters-manifest.json for every source member and converted LUT hash.\n'
            'The application source archive attached to this release includes the converter,\n'
            'its dependencies, license and build instructions. To reproduce the float32 LUTs,\n'
            'place RawTherapee-HaldCLUT.zip in validation/downloads/open-filters/ and run\n'
            'python product/film.py --setup-filters from that source checkout.\n')
    print(json.dumps({'source_archive': str(output), 'bytes': output.stat().st_size,
                      'sha256': sha256(output), 'looks': len(data['items'])}, indent=2), flush=True)
    return output


def dependency_notices():
    notices = []
    names = ['react', 'react-dom', 'scheduler', 'lucide-react', 'motion', 'framer-motion',
             'motion-dom', 'motion-utils', '@tauri-apps/api']
    for name in names:
        directory = ROOT / 'node_modules' / name
        if directory.is_dir():
            metadata = json.loads((directory / 'package.json').read_text(encoding='utf-8'))
            notices.append(f"\n=== npm {name} {metadata['version']} ===\n")
            for license in directory.glob('*LICENSE*'):
                if license.is_file():
                    notices.append(license.read_text(encoding='utf-8', errors='replace'))
    registry = Path(os.environ.get('CARGO_HOME', str(Path.home() / '.cargo'))) / 'registry/src'
    for package in tomllib.loads((ROOT / 'src-tauri/Cargo.lock').read_text(encoding='utf-8'))['package']:
        if not package.get('source', '').startswith('registry+'):
            continue
        for directory in registry.glob(f"*/{package['name']}-{package['version']}"):
            metadata = tomllib.loads((directory / 'Cargo.toml').read_text(encoding='utf-8')).get('package', {})
            notices.append(f"\n=== Rust {package['name']} {package['version']} ({metadata.get('license', '')}) ===\n")
            for license in directory.iterdir():
                if license.is_file() and license.name.lower().startswith(('license', 'licence', 'copying', 'notice')):
                    notices.append(license.read_text(encoding='utf-8', errors='replace'))
    (STAGE / 'licenses').mkdir(exist_ok=True)
    (STAGE / 'licenses/frontend-and-rust.txt').write_text('\n'.join(notices), encoding='utf-8')


def copy(source, destination):
    source, destination = Path(source), Path(destination)
    if not source.exists():
        raise FileNotFoundError(source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if source.is_dir():
        shutil.copytree(source, destination, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns('__pycache__', '*.pyc', 'tests', 'test', '.git'))
    else:
        shutil.copy2(source, destination)


def patch_spectral_sources(destination, packages):
    """Apply and record the headless adaptations against pinned upstream bytes."""
    patch = []
    files = {}
    for relative, (expected, replacements) in SPECTRAL_PATCHES.items():
        source_name = 'spektrafilm/' + relative
        path = packages / source_name
        original = path.read_bytes()
        if hashlib.sha256(original).hexdigest() != expected:
            raise RuntimeError('Unexpected upstream Spektrafilm source: ' + source_name)
        before = after = original.decode('utf-8')
        for old, new in replacements:
            if old not in after:
                raise RuntimeError('Unmatched Spektrafilm adaptation: ' + source_name)
            after = after.replace(old, new)
        result = after.encode('utf-8')
        path.write_bytes(result)
        files[source_name] = {'upstream_sha256': expected, 'staged_sha256': sha256(path)}
        for line in unified_diff(before.splitlines(keepends=True), after.splitlines(keepends=True),
                                 fromfile=f'a/src/{source_name}', tofile=f'b/src/{source_name}'):
            patch.append(line if line.endswith('\n') else line + '\n\\ No newline at end of file\n')
    patch_path = destination / SPECTRAL_PATCH_NAME
    patch_path.write_bytes(''.join(patch).encode('utf-8'))
    return {'upstream_revision': SPECTRAL_REVISION, 'file': patch_path.name,
            'sha256': sha256(patch_path), 'files': files}


def stage_spectral_runtime(destination, crt):
    """Stage the optional, isolated CPython and headless Spektrafilm runtime."""
    engines = ROOT / 'engines'
    source = engines / 'film-runtime/Lib/site-packages'
    if not source.is_dir():
        return None
    base = engines / 'python' / f'cpython-{SPECTRAL_PYTHON_VERSION}-windows-x86_64-none'
    if not (base / 'python.exe').is_file():
        raise RuntimeError(f'Local CPython {SPECTRAL_PYTHON_VERSION} x64 is required for the spectral runtime')
    distributions = {dist.metadata['Name'].lower().replace('_', '-'): dist
                     for dist in importlib.metadata.distributions(path=[str(source)])}
    missing = SPECTRAL_PACKAGES - distributions.keys()
    if missing:
        raise RuntimeError('Spectral runtime packages are missing: ' + ', '.join(sorted(missing)))
    if distributions['spektrafilm'].version != '0.3.4':
        raise RuntimeError('The spectral runtime requires Spektrafilm 0.3.4')

    destination = Path(destination)
    for name in ['python.exe', 'python3.dll', 'python313.dll', 'LICENSE.txt']:
        copy(base / name, destination / name)
    for library in sorted(Path(crt).glob('*.dll')):
        copy(library, destination / library.name)
    for library in sorted(base.glob('vcruntime*.dll')):
        if not (destination / library.name).is_file():
            copy(library, destination / library.name)
    for item in (base / 'DLLs').iterdir():
        if item.name.startswith('_test') or item.name in {'_ctypes_test.pyd', '_tkinter.pyd', 'tcl86t.dll', 'tk86t.dll'}:
            continue
        copy(item, destination / 'DLLs' / item.name)
    for item in (base / 'Lib').iterdir():
        if item.name in {'__pycache__', 'ensurepip', 'idlelib', 'site-packages', 'test', 'tkinter', 'turtledemo', 'venv'}:
            continue
        copy(item, destination / 'Lib' / item.name)
    # Isolate the worker while allowing it to import Photo All modules from runtime/.
    (destination / 'python313._pth').write_text(SPECTRAL_PYTHON_PATHS, encoding='utf-8')

    packages = destination / 'Lib/site-packages'
    for name in sorted(SPECTRAL_PACKAGES):
        dist = distributions[name]
        if not dist.files:
            raise RuntimeError('Spectral runtime package has no file inventory: ' + name)
        for item in dist.files:
            relative = Path(str(item))
            if (relative.is_absolute() or relative.drive
                    or {'..', '__pycache__', 'tests', 'test'}.intersection(relative.parts)
                    or relative.suffix in {'.pyc', '.nbc', '.nbi', '.whl'}
                    or relative.parts[0] in {'spektrafilm_gui', 'spektrafilm_lut_creator'}
                    or relative.name in {'direct_url.json', 'uv_cache.json', 'uv_build.json'}):
                continue
            copy(source / relative, packages / relative)
    return {'python': SPECTRAL_PYTHON_VERSION, 'source_patch': patch_spectral_sources(destination, packages),
            'packages': {name: distributions[name].version for name in sorted(SPECTRAL_PACKAGES)}}


def stage():
    verify_open_filters(ROOT)
    verify_border_assets(ROOT)
    archive = fetch(PYTHON_URL, DOWNLOADS / PYTHON_URL.rsplit('/', 1)[1], PYTHON_SHA256)
    # Never delete a computed directory outside the known staging parent.
    assert STAGE.resolve().parent == (ROOT / 'build').resolve()
    if STAGE.exists():
        shutil.rmtree(STAGE)
    python = STAGE / 'python'
    python.mkdir(parents=True)
    with zipfile.ZipFile(archive) as source:
        source.extractall(python)
    (python / 'python312._pth').write_text('python312.zip\n.\nLib\nLib/site-packages\n..\n', encoding='utf-8')
    packages = python / 'Lib/site-packages'
    prepared_site = ROOT / 'engines/builder-site-packages'
    site = prepared_site if package_versions(prepared_site) == BASE_WHEELS else Path(importlib.metadata.distribution('numpy').locate_file(''))
    for pattern in ['numpy', 'numpy.libs', 'numpy-*.dist-info', 'PIL', 'pillow-*.dist-info',
                    'pillow.libs', 'packaging', 'packaging-*.dist-info']:
        for source in site.glob(pattern):
            copy(source, packages / source.name)
    for name in ['precision-packages', 'recognition-runtime']:
        source = ROOT / 'engines' / name
        for item in source.iterdir():
            if item.name not in {'bin', '__pycache__'}:
                copy(item, packages / item.name)
    # Optional codec, included whenever the builder has explicitly installed it.
    for pattern in ['pillow_heif', 'pillow_heif.libs', 'pillow_heif-*.dist-info']:
        for item in site.glob(pattern):
            copy(item, packages / item.name)
    # The upstream external-editor companion uses Tk. Ship its CPython 3.12
    # extension and Tcl data alongside the embedded interpreter as an add-on.
    base = Path(sys.base_prefix)
    copy(base / 'Lib/tkinter', python / 'Lib/tkinter')
    for pattern in ['_tkinter.pyd', 'tcl*.dll', 'tk*.dll']:
        for item in (base / 'DLLs').glob(pattern):
            copy(item, python / item.name)
    copy(base / 'tcl', python / 'tcl')
    copy(base / 'LICENSE.txt', STAGE / 'licenses/CPython-builder-addons.txt')
    # app-local VC runtime avoids requiring a machine-wide VC redistributable.
    crt = visual_cpp_runtime()
    for item in crt.glob('*.dll'):
        copy(item, python / item.name)
    if not (python / 'msvcp140.dll').is_file():
        raise RuntimeError('Microsoft.VC143.CRT redistributable DLL directory is required (VCToolsRedistDir)')
    for name in RUNTIME_FILES:
        copy(ROOT / name, STAGE / name)
    for name in ['RawTherapee-5.13', 'clip-vit-base-patch32', 'film-luts', 'open-filters', 'film-borders']:
        copy(ROOT / 'engines' / name, STAGE / 'engines' / name)
    spectral = stage_spectral_runtime(STAGE / 'engines/spectral-python', crt)
    verify_open_filters(STAGE)
    verify_border_assets(STAGE)
    copy(ROOT / 'WINDOWS_DISTRIBUTION.md', STAGE / 'THIRD_PARTY_NOTICES.md')
    if (ROOT / 'build/third-party-sources/LICENSES.txt').is_file():
        copy(ROOT / 'build/third-party-sources/LICENSES.txt', STAGE / 'licenses/RawTherapee-dependencies.txt')
    dependency_notices()
    spektra = next((p.parent for p in (ROOT / 'engines/spektrafilm-source').glob('*/pyproject.toml')), None)
    if spektra is None:
        raise RuntimeError('Spektrafilm source is missing; run prepare first')
    for item in spektra.glob('*LICENSE*'):
        copy(item, STAGE / 'licenses/spektrafilm' / item.name)
    # Keep package metadata/license trees: a binary distribution without its
    # upstream notices is not an acceptable size optimization.
    manifest = {'format': 1, 'python_url': PYTHON_URL, 'python_sha256': PYTHON_SHA256,
                'packages': {d.metadata['Name']: d.version for d in importlib.metadata.distributions(path=[str(packages)])},
                'files': {str(p.relative_to(STAGE)).replace('\\', '/'): sha256(p)
                          for p in sorted(STAGE.rglob('*')) if p.is_file()}}
    if spectral:
        manifest['spectral_python'] = spectral
    (STAGE / 'runtime-manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    size = sum(p.stat().st_size for p in STAGE.rglob('*') if p.is_file())
    print(json.dumps({'runtime': str(STAGE), 'bytes': size, 'packages': manifest['packages']}, indent=2), flush=True)


def build(output=None):
    target = Path(os.environ.get('CARGO_TARGET_DIR', str(ROOT / 'src-tauri/target')))
    if not target.is_absolute():
        target = (ROOT / target).resolve()
    if not (STAGE / 'runtime-manifest.json').is_file():
        raise RuntimeError('Run stage first')
    if not (STAGE / 'licenses/RawTherapee-dependencies.txt').is_file() or not (ROOT / 'dist/Photo-All-third-party-corresponding-source.zip').is_file():
        raise RuntimeError('Corresponding source and notices are required; run sources, then stage')
    verify_open_filters(ROOT)
    verify_open_filters(STAGE)
    verify_border_assets(ROOT)
    verify_border_assets(STAGE)
    for name in ['SOURCES.json', 'LICENSE-romnn-MIT.txt', 'LICENSE-NegativeConverter-MIT.txt']:
        if sha256(ROOT / 'engines/film-borders' / name) != sha256(STAGE / 'engines/film-borders' / name):
            raise RuntimeError('Staged film-border notices are outdated: ' + name)
    filter_source = ROOT / 'dist/Photo-All-open-filter-sources.zip'
    if not filter_source.is_file():
        raise RuntimeError('Open-filter corresponding source is required; run filter-sources')
    with zipfile.ZipFile(filter_source) as source:
        for name in ['open-filters-manifest.json', 'open_filters.py', 'LICENSE']:
            if source.read(name) != (ROOT / name).read_bytes():
                raise RuntimeError('Open-filter source bundle is outdated; run filter-sources')
    for name in RUNTIME_FILES:
        if not (STAGE / name).is_file() or sha256(STAGE / name) != sha256(ROOT / name):
            raise RuntimeError(f'Staged {name} is outdated; run stage again')
    if sha256(STAGE / 'THIRD_PARTY_NOTICES.md') != sha256(ROOT / 'WINDOWS_DISTRIBUTION.md'):
        raise RuntimeError('Staged distribution notices are outdated; run stage again')
    node = shutil.which('node')
    if not node:
        raise RuntimeError('Node.js must be on the build PATH')
    subprocess.run([node, str(ROOT / 'node_modules/@tauri-apps/cli/tauri.js'), 'build', '--bundles', 'nsis'],
                   cwd=ROOT, check=True)
    version = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
    output = Path(output).resolve() if output is not None else ROOT / 'dist'
    output.mkdir(parents=True, exist_ok=True)
    # Build independently of any portable folder the user currently has open.
    # Never delete or overwrite a running installation to assemble its update.
    with tempfile.TemporaryDirectory(prefix='portable-', dir=ROOT / 'build') as temporary:
        portable = Path(temporary).resolve()
        assert portable.parent == (ROOT / 'build').resolve()
        copy(target / 'release/photo-all.exe', portable / 'Photo All Studio.exe')
        copy(STAGE, portable / 'runtime')
        copy(ROOT / 'WINDOWS_DISTRIBUTION.md', portable / 'README.txt')
        shutil.make_archive(str(output / f'Photo-All-Studio_{version}_windows-x64'), 'zip', root_dir=portable)
    installers = sorted((target / 'release/bundle/nsis').glob(f'*_{version}_*-setup.exe'))
    if not installers:
        raise RuntimeError(f'NSIS installer for {version} was not produced')
    for installer in installers:
        copy(installer, output / installer.name)
    spectral_patch = STAGE / 'engines/spectral-python' / SPECTRAL_PATCH_NAME
    if spectral_patch.is_file():
        copy(spectral_patch, output / SPECTRAL_PATCH_NAME)
    files = [p for p in output.iterdir() if p.is_file() and p.suffix in {'.zip', '.exe', '.patch'}]
    (output / 'SHA256SUMS.txt').write_text(''.join(f'{sha256(p)}  {p.name}\n' for p in sorted(files)), encoding='utf-8')
    print(json.dumps({'artifacts': [{'path': str(p), 'bytes': p.stat().st_size, 'sha256': sha256(p)} for p in files]}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'stage', 'build', 'all', 'sources', 'filter-sources'])
    parser.add_argument('--output', type=Path, help='Write build artifacts to this directory instead of dist')
    options = parser.parse_args()
    if options.action == 'prepare':
        prepare_builder()
    if options.action in {'sources', 'all'}:
        corresponding_sources()
    if options.action in {'filter-sources', 'all'}:
        open_filter_sources()
    if options.action in {'stage', 'all'}:
        stage()
    if options.action in {'build', 'all'}:
        build(options.output)
