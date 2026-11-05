# SPDX-License-Identifier: GPL-3.0-or-later
"""Fit a scanned negative to a film profile's developed CMY densities."""

import numpy as np


BASE_KEYS = ('negative_base_r', 'negative_base_g', 'negative_base_b')
# Nominal narrow scanner bands, in sRGB channel order. Actual scanner spectral
# sensitivities and any embedded scanner processing are unknown.
_SCANNER_WAVELENGTHS_NM = (620, 540, 450)
_BLOCK = 65536


def _linear_srgb(encoded):
    return np.where(encoded <= .04045, encoded / 12.92,
                    ((encoded + .055) / 1.055) ** 2.4)


def scan_to_density(rgb, film_profile, base_reference=(0, 0, 0)):
    """Return float32 CMY, ready for the spectral print stage.

    ``rgb`` is an uninverted negative scan encoded as sRGB. Each nonzero
    ``base_reference`` value is the encoded reading of clear, unexposed film
    in that scanner channel. Zero estimates it from the channel's 99.5th
    percentile. Use a real clear-film reading when the scan contains no border.

    Normalizing the scan by clear film removes the scanner's reading of the
    orange mask. The downstream spectral print stage adds the stock's modeled
    base density once. The three-band dye fit is approximate and cannot recover
    a measured spectrum from a colour-processed or clipped scanner image.
    """
    rgb = np.asarray(rgb, dtype=np.float32)
    if rgb.ndim != 3 or rgb.shape[-1] != 3 or not rgb.size or not np.isfinite(rgb).all():
        raise ValueError('负片扫描需要非空、有限的 sRGB 三通道图像')
    reference = np.asarray(base_reference, dtype=np.float32)
    if reference.shape != (3,) or not np.all((reference == 0) | ((reference >= .01) & (reference <= 1))):
        raise ValueError('片基参考 RGB 应为 0（估计）或 0.01–1 的 sRGB 读数')

    profile = film_profile.data
    wavelength = np.asarray(profile.wavelengths, dtype=np.float64)
    dye = np.asarray(profile.channel_density, dtype=np.float64)
    if (wavelength.ndim != 1 or dye.shape != (len(wavelength), 3) or
            not np.isfinite(wavelength).all() or not np.all(np.diff(wavelength) > 0) or
            not len(wavelength) or wavelength[0] > min(_SCANNER_WAVELENGTHS_NM) or
            wavelength[-1] < max(_SCANNER_WAVELENGTHS_NM)):
        raise ValueError('胶片配置缺少可用于扫描拟合的染料光谱')
    matrix = np.column_stack([np.interp(_SCANNER_WAVELENGTHS_NM, wavelength, dye[:, channel])
                              for channel in range(3)])
    if not np.isfinite(matrix).all() or not np.any(matrix):
        raise ValueError('胶片配置的染料光谱无效')
    # Pseudoinverse handles monochrome profiles that carry only one dye axis.
    # Drop nearly singular components instead of amplifying scanner noise.
    inverse = np.linalg.pinv(matrix, rcond=.005).astype(np.float32)
    maximum_density = np.maximum(0, np.nan_to_num(profile.density_curves, nan=0,
                                                 posinf=0, neginf=0).max(axis=0)).astype(np.float32)

    scan = rgb.reshape(-1, 3)
    automatic = reference == 0
    if np.any(automatic):
        sample = scan[::max(1, len(scan)//131072)]
        estimated = np.quantile(sample, .995, axis=0).astype(np.float32)
        reference = np.where(automatic, np.clip(estimated, .01, 1), reference)
    base_light = _linear_srgb(reference)
    density = np.empty(scan.shape, np.float32)
    for start in range(0, len(scan), _BLOCK):
        end = start + _BLOCK
        transmitted_light = _linear_srgb(np.clip(scan[start:end], 0, 1))
        optical_density = -np.log10(np.maximum(transmitted_light/base_light, 1e-6))
        density[start:end] = np.clip(optical_density @ inverse.T, 0, maximum_density)
    return density.reshape(rgb.shape)
