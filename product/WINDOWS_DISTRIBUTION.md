# Photo All Studio for Windows x64

Use the `*-setup.exe` installer for a per-user installation, or extract the entire
portable ZIP and open **Photo All Studio.exe**. Keep `runtime` beside the EXE.
Windows 10/11 x64 and Microsoft Edge WebView2 are required. The installer detects
WebView2 and includes Microsoft's bootstrapper; installing WebView2 for the first
time requires an internet connection. Existing WebView2 installations can run
Photo All offline. A portable ZIP does not install WebView2.

Python, NumPy, Pillow, TIFF/PNG codecs, the CPU ONNX inference runtime/tokenizer,
the local CLIP model, film LUTs, the open-filter library, and the complete
official RawTherapee portable
distribution are included. End users do not need Python, Node, Rust, pip, or the
source checkout. HEIC is available only if `pillow_heif` appears in the included
runtime manifest; this release does not claim an unbundled HEIC codec.

Database, thumbnail/RAW caches and backend diagnostics are stored at
`%LOCALAPPDATA%\org.photoall.studio`. Original photos stay at their imported paths.
Installing a newer release into the same application directory preserves this
library and its edits. Download the new installer from GitHub Releases and run
it manually; Photo All does not download or install upgrades automatically.
Uninstalling preserves this library by default; selecting the installer's
explicit option to delete application data removes it. Portable here means the
application folder is movable; the library profile stays in AppData.

## Build and verify

On a Windows x64 builder install Rust/MSVC Build Tools, Node, project npm
dependencies, and the Python packages listed in `requirements.txt`. Prepare
the pinned CLIP assets with `setup_recognition.py` and the film LUTs with
`film.py --setup` and the open-filter assets with `film.py --setup-filters`.
The latter verifies the pinned original archive and each source/converted LUT.
Put the unmodified RawTherapee 5.13 release directory under
`engines/RawTherapee-5.13/`. Use a CPython 3.12 builder containing Tkinter and the
NumPy/Pillow packages. Set `VCToolsRedistDir` if the Build Tools redistributable
directory differs from the default. Run `python package_windows.py sources`
first to retrieve matching third-party source and original dependency notices.
An unchanged, already verified `Photo-All-third-party-corresponding-source.zip`
and `build/third-party-sources` can be reused for a subsequent release; there is
no need to download or recompress those unchanged source packages.
Run `python package_windows.py filter-sources` to package the original open-filter
archive and its licenses separately as `dist/Photo-All-open-filter-sources.zip`.
Then `python package_windows.py stage` creates `build/runtime`;
`python package_windows.py build` builds NSIS plus portable ZIP in `dist`.
`python package_windows.py all` runs both source steps, staging and building.
The stage is a deliberately selected runtime, not a copy of the
builder environment. Package versions and per-file SHA-256 hashes are recorded
in `runtime/runtime-manifest.json`. Both staging and building verify every
open-filter LUT against the pinned catalog and require its attribution,
license text and modification notice.

From the repository root run `python validation/packaging_smoke.py product/build/runtime
--raw validation/inputs/D7000.NEF --output validation/artifacts/packaging-report.json`.
This relocates the runtime,
removes Python/workspace variables and PATH entries, loads real ONNX models,
checks real RAW decoding, film rendering, PNG16/TIFF16 round trips, the Tk
companion and LittleCMS loading, starts the API, and verifies a separate AppData
profile. Also run the native executable smoke against the portable EXE. No build
cache, user library, photos, film training environment or model training code is
included. Build artifacts and downloads are ignored by Git.

To verify a manual upgrade, run `node validation/package_native_smoke.cjs
<new-portable-directory> <new-installer> <previous-installer>` from the repository
root. It refuses to install when the application already has an HKCU installer
entry, installs into an isolated temporary directory, imports and edits a test
photo in an isolated `PHOTOALL_DATA_DIR`, installs the newer version over it,
and checks the saved photo, recipe, original file and registry version. It also
checks that uninstalling preserves this isolated library. It never uses the
real AppData photo library.

## Licenses, attribution and corresponding source

Photo All is **GPL-3.0-or-later**, see `runtime/LICENSE`. Its corresponding
application source is the source archive attached to the same release, including
the Python modules, frontend, Rust wrapper, lockfiles and build script. Releases
must make that source available next to the binary downloads.

RawTherapee **5.13**, build commit
`1924179107995b01b73cdc7f4fe91e44fc8227a7`, is included unmodified as a separate
program under GPL-3.0. The complete binary directory, its `LICENSE`, `licenses/`,
`AboutThisBuild.txt`, profiles and upstream notices are retained. Official binary
and matching source are at <https://github.com/RawTherapee/RawTherapee/releases/tag/5.13>.
Its source archive is <https://github.com/RawTherapee/RawTherapee/archive/refs/tags/5.13.tar.gz>.
The Windows build also contains separately licensed libraries (including LGPL
GTK/GLib/gtkmm, Lensfun and other dependencies). The release's
`Photo-All-third-party-corresponding-source.zip` includes RawTherapee source,
spektrafilm source, and **61 complete MSYS2 source packages**, with upstream
source archives, patches and PKGBUILD build scripts. Every one of the 99 bundled
DLL/helper executables and all 548 copied Adwaita artwork files was matched by
SHA-256 to its exact official MSYS2 binary package. `manifest.json` records
those hashes, package versions, SPDX license identifiers, source URLs and source
archive hashes; `provenance/` retains `.PKGINFO` licenses and `.BUILDINFO` build
environments. Each source PKGBUILD hash was checked against the binary's build
record. `runtime/licenses/RawTherapee-dependencies.txt` retains the packages'
original bundled license notices. Adwaita 50.0 artwork is LGPL-3.0-or-later OR
CC-BY-SA-3.0; its source and notices are included too.

Provide that corresponding-source ZIP at the same release download location as
the installer and portable ZIP, either attached or directly linked to the identical
previously published archive with its SHA-256. Its packages can be rebuilt in MSYS2 with
`makepkg-mingw` and the recorded build environment. Original build/bundle steps
are in RawTherapee's `.github/workflows/windows.yml`. Upstream source locations:
<https://repo.msys2.org/mingw/sources/>, <https://packages.msys2.org/> and
<https://github.com/msys2/MINGW-packages>.

Film colour powered by **spektrafilm**, Andrea Volpato, revision
`3bb2c2d2801ff68b92019cf1dbcbb133d60832bc`,
<https://github.com/andreavolpato/spektrafilm>. Its Python code is GPL-3.0; film
profiles and these generated 33³ sRGB LUT adaptations are **CC BY-SA 4.0**. Photo
All generated/resaved the LUTs through upstream BundleBuilder and NumPy. Each
LUT's JSON records the stock, paper, source revision, hash and modification.
Share adaptations under the same license and retain attribution. The upstream
license files are copied to `runtime/licenses/spektrafilm/`. CC BY-SA 4.0 text:
<https://creativecommons.org/licenses/by-sa/4.0/legalcode>.

The **RawTherapee Film Simulation Collection 2015-09-20** supplies the additional
open looks, attributed upstream to Pat David, Pavlov Dmitry and Michael Ezra,
under **CC BY-SA 4.0**. Source and background:
<https://patdavid.net/2015/03/film-emulation-in-rawtherapee/>; original archive:
<https://rawtherapee.com/shared/HaldCLUT.zip>, pinned SHA-256
`0ffca81f30c72d7bbb85adab0ed98bbdeb0e1034cd6f5986f9f993bb66999dc2`.
Photo All converts the original 8/16-bit Hald look samples to deduplicated 33³
float32 LUT adaptations; the photo rendering pipeline remains float32 until
output encoding. The runtime keeps `engines/open-filters/manifest.json`,
`UPSTREAM-README.txt`, `LICENSE-CC-BY-SA-4.0.txt` and `CHANGES.txt` beside the LUTs.
The manifest records each original member/hash, source bit depth, conversion,
attribution, license and converted LUT hash. These adaptations retain CC BY-SA
4.0. The same release must offer `Photo-All-open-filter-sources.zip` alongside
the binaries, attached or directly linked to the identical previously published
archive with its SHA-256. It contains the complete unchanged original Hald archive, the
catalog, license, upstream attribution, modification notice and converter.
The application source includes `open_filters.py`, `pixels.py`, the checked-in
catalog and `filter-licenses/`; run `python product/film.py --setup-filters`
from that source checkout to reproduce the installed adaptations.

CLIP ViT-B/32 is the local quantized Xenova conversion, revision
`6b7c523703ae26e39be4b03774966f8571c7f523`,
<https://huggingface.co/Xenova/clip-vit-base-patch32>. OpenAI CLIP is MIT-licensed;
the bundled model folder retains its model card and license. ONNX Runtime 1.23.2
is MIT; Tokenizers 0.22.1 is Apache-2.0. These use local model files and no model
download client. Their inference path does not require optional training,
development or hub-download dependencies.

CPython 3.12.10 is the official Python.org embeddable distribution under the PSF
license (`runtime/python/LICENSE.txt`), plus the builder's CPython 3.12 Tk/Tcl
add-on. NumPy is BSD-3-Clause, Pillow HPND, tifffile BSD-3-Clause, PyPNG MIT and
imagecodecs BSD-3-Clause with separately licensed codec libraries. Their wheel
`.dist-info` directories and all bundled license texts are retained alongside
their packages. Consult those notices for each transitive library's exact terms.
Microsoft VC runtime DLLs are redistributed app-local from Visual Studio Build
Tools' `Microsoft.VC143.CRT`; they remain subject to Microsoft's distributable
code license. WebView2 and its installer remain subject to Microsoft's license.
Tauri is MIT/Apache-2.0; the JS/Rust dependency lockfiles in the application source
identify the frontend and wrapper dependency versions.

Official implementation references:
<https://www.python.org/downloads/release/python-31210/> and
<https://v2.tauri.app/distribute/windows-installer/>.
