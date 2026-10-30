# Open filter catalogue, 0.10.0

Photo All includes 126 distinct source looks from the **RawTherapee Film Simulation Collection, version 2015-09-20**. These are creative approximations, separate from the existing 16 Spektrafilm simulations and the 17 legacy Photo All styles. Categories contain 37 landscape/colour, 31 cinema/creative, 28 black-and-white, 18 vintage/instant and 12 portrait-negative looks.

## Primary sources and permission

- Author announcement and original download link: [Pat David, Film Emulation in RawTherapee](https://patdavid.net/2015/03/film-emulation-in-rawtherapee/).
- Original archive: [RawTherapee HaldCLUT.zip](https://rawtherapee.com/shared/HaldCLUT.zip), 421,602,289 bytes; SHA256 `0ffca81f30c72d7bbb85adab0ed98bbdeb0e1034cd6f5986f9f993bb66999dc2`.
- The archive's `HaldCLUT/README.txt` explicitly identifies the collection version, **CC BY-SA 4.0**, encoded sRGB (unless a filename states otherwise), and authors **Pat David, Pavlov Dmitry and Michael Ezra**. The unchanged notice is distributed as `UPSTREAM-README.txt`.
- Full [CC BY-SA 4.0 legal text](https://creativecommons.org/licenses/by-sa/4.0/legalcode.txt) is preserved in `product/filter-licenses/LICENSE-CC-BY-SA-4.0.txt` and the installed asset directory. The adapted lookup tables retain that licence and attribution. Photo All marks its conversion in `CHANGES.txt` and `manifest.json`.

The versioned, content-addressed source archive is retained at `validation/downloads/open-filters/RawTherapee-HaldCLUT.zip` for the separate release source bundle. It contains only published LUT assets, not user photographs. The original 422 MB archive is not required at runtime.

## Selection and adaptation

The checked-in `product/open-filters-manifest.json` is the precise selection and rebuild contract. Each entry retains its original source filename, archive member, source PNG SHA256, converted NumPy SHA256, pixel SHA256, native cube edge and bit depth, output resolution, colour domain, licence, attribution source and group. Stable IDs are derived from original names, not invented aliases for duplicate looks.

The collection contains 294 PNG files. The selection excludes push/pull strength variants, Alt/Early variants, identity and negative-reversal transforms. Two selected sources were then removed because their converted pixels were exactly duplicated: `Ilford HPS 800.png` duplicates `Ilford HP5 Plus 400.png`; `TealOrange1.png` duplicates `TealOrange.png`. The remaining 126 tables and their rendered colour responses have unique hashes. Numbered CreativePack looks are retained where they are genuinely different upstream grades.

Only lookup assets are decoded. Hald row-major samples use R as the fastest axis, followed by G and B, then are stored as `[B,G,R,RGB]`. PNG decoding supports both 8-bit and 16-bit sample precision, including grayscale output for monochrome tables. Native 144³/256³ source grids are resampled to 33³ with float32 trilinear interpolation. These are compact adaptations of the source grades; they are not claimed to be exact copies of the original higher-resolution transform. The source package and original profile names remain available for inspection.

Runtime asset files total 54,470,610 bytes (126 NumPy tables and notices). A lazy six-entry LRU bounds loaded tables. Original photographs remain in the existing float32 encoded-sRGB SDR pipeline. No photo pixels travel through the source PNGs or an 8-bit colour intermediate. Preview, PNG/TIFF16 export and composite layers use `pixels.apply_lut` and the same saved recipe.

## Rebuild and interface

Run `python product/film.py --setup-filters` with Photo All's dependencies installed. It uses the cached original archive or downloads the official archive, refuses a changed archive digest, checks every selected source digest, reproduces the converted table digest, and copies the attribution and licence. Deleting and rebuilding a generated asset has been verified to reproduce identical bytes. Setup never accesses the user's image library.

The recipe has `filter_id: "none"` and `filter_strength: 1` (0–1). It selects one open filter. Spektrafilm controls remain independent. Legacy styles remain compatible. The UI resets legacy style to `natural` when choosing an open filter, and clears the open filter when choosing a legacy style.

`GET /api/library` includes `filters: {items: Record<id,{label,group,source,license,ready}>,count,attribution,source,mode,revision}`. `GET /api/filter-preview/{photo_id}?filter_id={id}&size=240` requires the ordinary Bearer token, loads only a catalogue photo ID, clones the saved recipe, resets legacy style, and overrides only the filter choice/strength. It uses the shared preview cache and two decode slots and never writes an edit/history entry. `filter_id=style:{legacy_id}` produces real legacy style thumbnails with the open filter cleared. There is no arbitrary file-path thumbnail endpoint.

Export recipe sidecars include the selected filter ID, strength, source revision, licence and converted-asset digest in `open_filter`.

## Other sources reviewed

- [cedeber/hald-clut](https://github.com/cedeber/hald-clut) declares GPL-3.0 at its root, but its README combines RawTherapee, PictureFX, Fuji profiles, Apple Photos and Pixelmator. Photo All uses the original RawTherapee source and its explicit asset permission instead of assuming that a collection's root licence resolves every third-party asset's provenance.
- [Jan Lohse, spectral_film_lut](https://github.com/JanLohse/spectral_film_lut) is MIT-licensed and a credible separate physical simulation project. It was not mixed into this creative-Hald catalogue because its negative/print colour pipeline and bake parameters need their own integration contract.
- [t3mujinpack](https://github.com/t3mujinpack/t3mujinpack) provides Darktable module presets. Those are not ready sRGB RGB lookup tables; importing their names alone would not create working Photo All filters. No such placeholders are included.
