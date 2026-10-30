# SPDX-License-Identifier: GPL-3.0-or-later
"""Stage a curated CPython runtime, then build NSIS and a portable ZIP on Windows.

No workstation Python paths are embedded in the output. Build tools are needed
only on the builder; end users need Windows 10/11 x64 and Microsoft WebView2.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
import fnmatch
import hashlib
import importlib.metadata
from io import BytesIO
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
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
RUNTIME_FILES = ['service.py', 'engine.py', 'pixels.py', 'workflow.py', 'film.py',
                 'open_filters.py', 'open-filters-manifest.json',
                 'app.py', 'companion.cmd', 'LICENSE', 'README.md']

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


def fetch(url, path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.is_file():
        temporary = path.with_suffix(path.suffix + '.partial')
        urllib.request.urlretrieve(url, temporary)
        temporary.replace(path)
    return path


def corresponding_sources():
    """Retrieve matching MSYS2 binary provenance and complete source packages."""
    base = 'https://repo.msys2.org/mingw/'
    binary_index = unquote(fetch(base + 'ucrt64/', DOWNLOADS / 'msys2-ucrt64-index.html').read_text(encoding='utf-8'))
    source_index = unquote(fetch(base + 'sources/', DOWNLOADS / 'msys2-sources-index.html').read_text(encoding='utf-8'))
    entries = [(name, datetime.strptime(date, '%d-%b-%Y %H:%M')) for name, date in
               re.findall(r'<a href="([^"]+)".*?</a\s*>\s+(\d{2}-\w{3}-\d{4} \d{2}:\d{2})', binary_index, re.S)
               if name.endswith('.pkg.tar.zst')]
    cutoff = datetime(2026, 7, 25, 23, 59)
    raw = ROOT / 'engines/RawTherapee-5.13/RawTherapee_5.13_win64_x86_64_release'
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
    sys.path.insert(0, str(ROOT / 'engines/precision-packages'))
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
    copy(fetch('https://github.com/RawTherapee/RawTherapee/archive/refs/tags/5.13.tar.gz',
               DOWNLOADS / 'RawTherapee-5.13-source.tar.gz'), output / 'RawTherapee-5.13-source.tar.gz')
    copy(DOWNLOADS / 'spektrafilm-3bb2c2d2801ff68b92019cf1dbcbb133d60832bc.tar.gz', output / 'spektrafilm-source.tar.gz')
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


def stage():
    verify_open_filters(ROOT)
    DOWNLOADS.mkdir(parents=True, exist_ok=True)
    archive = DOWNLOADS / PYTHON_URL.rsplit('/', 1)[1]
    if not archive.is_file():
        urllib.request.urlretrieve(PYTHON_URL, archive)
    if sha256(archive) != PYTHON_SHA256:
        raise RuntimeError('Official Python runtime checksum mismatch')
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
    site = Path(importlib.metadata.distribution('numpy').locate_file(''))
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
    redist = Path(os.environ.get('VCToolsRedistDir', 'C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Redist/MSVC/14.44.35112'))
    crt = redist / 'x64/Microsoft.VC143.CRT'
    for item in crt.glob('*.dll'):
        copy(item, python / item.name)
    if not (python / 'msvcp140.dll').is_file():
        raise RuntimeError('Microsoft.VC143.CRT redistributable DLL directory is required (VCToolsRedistDir)')
    for name in RUNTIME_FILES:
        copy(ROOT / name, STAGE / name)
    for name in ['RawTherapee-5.13', 'clip-vit-base-patch32', 'film-luts', 'open-filters']:
        copy(ROOT / 'engines' / name, STAGE / 'engines' / name)
    verify_open_filters(STAGE)
    copy(ROOT / 'WINDOWS_DISTRIBUTION.md', STAGE / 'THIRD_PARTY_NOTICES.md')
    if (ROOT / 'build/third-party-sources/LICENSES.txt').is_file():
        copy(ROOT / 'build/third-party-sources/LICENSES.txt', STAGE / 'licenses/RawTherapee-dependencies.txt')
    dependency_notices()
    spektra = next((ROOT / 'engines/spektrafilm-source').iterdir())
    for item in spektra.glob('*LICENSE*'):
        copy(item, STAGE / 'licenses/spektrafilm' / item.name)
    # Keep package metadata/license trees: a binary distribution without its
    # upstream notices is not an acceptable size optimization.
    manifest = {'format': 1, 'python_url': PYTHON_URL, 'python_sha256': PYTHON_SHA256,
                'packages': {d.metadata['Name']: d.version for d in importlib.metadata.distributions(path=[str(packages)])},
                'files': {str(p.relative_to(STAGE)).replace('\\', '/'): sha256(p)
                          for p in sorted(STAGE.rglob('*')) if p.is_file()}}
    (STAGE / 'runtime-manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    size = sum(p.stat().st_size for p in STAGE.rglob('*') if p.is_file())
    print(json.dumps({'runtime': str(STAGE), 'bytes': size, 'packages': manifest['packages']}, indent=2), flush=True)


def build():
    if not (STAGE / 'runtime-manifest.json').is_file():
        raise RuntimeError('Run stage first')
    if not (STAGE / 'licenses/RawTherapee-dependencies.txt').is_file() or not (ROOT / 'dist/Photo-All-third-party-corresponding-source.zip').is_file():
        raise RuntimeError('Corresponding source and notices are required; run sources, then stage')
    verify_open_filters(ROOT)
    verify_open_filters(STAGE)
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
    output = ROOT / 'dist'
    output.mkdir(exist_ok=True)
    portable = output / f'Photo-All-Studio_{version}_windows-x64'
    assert portable.resolve().parent == output.resolve()
    if portable.exists():
        shutil.rmtree(portable)
    portable.mkdir(exist_ok=True)
    copy(ROOT / 'src-tauri/target/release/photo-all.exe', portable / 'Photo All Studio.exe')
    copy(STAGE, portable / 'runtime')
    copy(ROOT / 'WINDOWS_DISTRIBUTION.md', portable / 'README.txt')
    shutil.make_archive(str(portable), 'zip', root_dir=portable)
    for installer in (ROOT / 'src-tauri/target/release/bundle/nsis').glob('*-setup.exe'):
        copy(installer, output / installer.name)
    files = [p for p in output.iterdir() if p.is_file() and p.suffix in {'.zip', '.exe'}]
    (output / 'SHA256SUMS.txt').write_text(''.join(f'{sha256(p)}  {p.name}\n' for p in sorted(files)), encoding='utf-8')
    print(json.dumps({'artifacts': [{'path': str(p), 'bytes': p.stat().st_size, 'sha256': sha256(p)} for p in files]}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['stage', 'build', 'all', 'sources', 'filter-sources'])
    options = parser.parse_args()
    if options.action in {'sources', 'all'}:
        corresponding_sources()
    if options.action in {'filter-sources', 'all'}:
        open_filter_sources()
    if options.action in {'stage', 'all'}:
        stage()
    if options.action in {'build', 'all'}:
        build()
