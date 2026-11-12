# SPDX-License-Identifier: GPL-3.0-or-later
"""Photo All's C++/Vulkan bridge with one serialized context per process."""
import ctypes
import atexit
import contextlib
from collections import OrderedDict
import hashlib
import os
import threading
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parent
_work = threading.local()


@contextlib.contextmanager
def work_task(check):
    previous=getattr(_work,'check',None)
    _work.check=check
    try:yield
    finally:_work.check=previous


def checkpoint():
    callback=getattr(_work,'check',None)
    if callback is not None:callback()


class Vulkan:
    def __init__(self):
        root = ROOT / 'engines' / 'photo-all-gpu'
        self.library = ctypes.CDLL(str(root/'photo_all_gpu.dll'))
        lib = self.library
        version = getattr(lib, 'pa_gpu_version', None)
        if version is None or version() != 4:
            raise RuntimeError('Photo All GPU library version mismatch')
        float_pointer = ctypes.POINTER(ctypes.c_float)
        lib.pa_gpu_create.argtypes = [ctypes.c_char_p]
        lib.pa_gpu_create.restype = ctypes.c_void_p
        lib.pa_gpu_destroy.argtypes = [ctypes.c_void_p]
        lib.pa_gpu_destroy.restype = None
        lib.pa_gpu_error.argtypes = []
        lib.pa_gpu_error.restype = ctypes.c_char_p
        lib.pa_gpu_device.argtypes = [ctypes.c_void_p]
        lib.pa_gpu_device.restype = ctypes.c_char_p
        lib.pa_gpu_memory.argtypes = [ctypes.c_void_p]
        lib.pa_gpu_memory.restype = ctypes.c_uint64
        lib.pa_gpu_run.argtypes = [ctypes.c_void_p, float_pointer, float_pointer, ctypes.c_uint32,
                                  float_pointer, ctypes.c_size_t, ctypes.c_uint64,
                                  ctypes.POINTER(ctypes.c_uint32)]
        lib.pa_gpu_blur.argtypes = [ctypes.c_void_p,float_pointer,float_pointer,ctypes.c_uint32,
                                    ctypes.c_uint32,ctypes.POINTER(ctypes.c_double),ctypes.c_uint32,ctypes.c_uint32]
        self.context = lib.pa_gpu_create(os.fsencode(root/'film.spv'))
        if not self.context:
            raise RuntimeError(lib.pa_gpu_error().decode('utf-8', errors='replace'))
        self.device = lib.pa_gpu_device(self.context).decode('utf-8')
        self.memory = lib.pa_gpu_memory(self.context)
        # Four I/O buffers stay below 1/32 of reported local memory, capped
        # at 96 MiB. Larger batches avoid a driver fence per 262k pixels.
        self.tile = max(16384, min(2097152, self.memory//(32*48))) if self.memory else 262144
        self._tables = OrderedDict()
        self.lock = threading.RLock()

    def close(self):
        with self.lock:
            if self.context:
                self.library.pa_gpu_destroy(self.context)
                self.context = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def _run(self, image, table, token, parameters, low=(0, 0, 0), high=(1, 1, 1), dtype=np.float64):
        with self.lock:
            return self._execute(image, table, token, parameters, low, high, dtype)

    def _execute(self, image, table, token, parameters, low, high, dtype):
        if not self.context:
            raise RuntimeError('Vulkan context is closed')
        flat = np.asarray(image).reshape(-1, 3)
        result = np.empty(flat.shape, dtype)
        pointer = ctypes.POINTER(ctypes.c_float)
        bounds = np.concatenate((np.asarray(low), 1/(np.asarray(high)-low))).astype(np.float32)
        settings = (ctypes.c_uint32 * 16)(*parameters, *bounds.view(np.uint32).tolist())
        for start in range(0, len(flat), self.tile):
            checkpoint()
            count = min(self.tile, len(flat)-start)
            settings[0] = count
            if parameters[1] in (6, 7, 8):
                settings[2] = start
            source = np.ascontiguousarray(flat[start:start+count], np.float32)
            target = np.empty(source.shape, np.float32)
            status = self.library.pa_gpu_run(
                self.context, source.ctypes.data_as(pointer), target.ctypes.data_as(pointer),
                count, table.ctypes.data_as(pointer), table.size, token, settings)
            if status:
                self.close()
                raise RuntimeError(self.library.pa_gpu_error().decode('utf-8', errors='replace'))
            result[start:start+count] = target
        return result.reshape(image.shape)

    def gaussian(self,image,sigma,truncate=3.):
        image=np.asarray(image)
        if image.ndim!=2 or not np.isfinite(sigma) or not np.isfinite(truncate) or truncate<=0:
            raise ValueError('Spatial filter requires a 2D plane and finite radius')
        if sigma<=0:return image.copy()
        if sigma>=3:
            q=.98711*float(sigma)-.96330
            b0=1.57825+2.44413*q+1.4281*q*q+.422205*q*q*q
            b1=(2.44413*q+2.85619*q*q+1.26661*q*q*q)/b0
            b2=-(1.4281*q*q+1.26661*q*q*q)/b0
            b3=.422205*q*q*q/b0
            coefficients=np.array([1-b1-b2-b3,b1,b2,b3],np.float64)
        else:
            radius=int(truncate*sigma+.5)
            x=np.arange(-radius,radius+1,dtype=np.float64)
            coefficients=np.exp(-.5*(x/sigma)**2);coefficients/=coefficients.sum()
        source=np.ascontiguousarray(image,np.float32);target=np.empty(source.shape,np.float32)
        pointer=ctypes.POINTER(ctypes.c_float)
        with self.lock:
            checkpoint()
            if not self.context:raise RuntimeError('Vulkan context is closed')
            status=self.library.pa_gpu_blur(self.context,source.ctypes.data_as(pointer),target.ctypes.data_as(pointer),
                image.shape[1],image.shape[0],coefficients.ctypes.data_as(ctypes.POINTER(ctypes.c_double)),
                coefficients.size,int(sigma>=3))
            if status==1:raise ValueError('Spatial filter exceeds device capabilities or memory budget')
            if status:raise RuntimeError(self.library.pa_gpu_error().decode('utf-8',errors='replace'))
        return target.astype(image.dtype,copy=False)

    def colour_transform(self, image, matrix):
        matrix = np.ascontiguousarray(matrix, np.float32).reshape(3,3)
        token = int.from_bytes(hashlib.blake2b(memoryview(matrix),digest_size=8).digest(),'little')
        return self._run(image,matrix,token,[0,9,0,0,0,0,0,0,0,0])

    def grain_layer(self, image, axes, layer, minimum, maximum, particles, uniformity, *, seed, positive=False):
        direct=axes is None
        if direct:axes=layer=np.zeros((2,3))
        axes = np.asarray(axes,np.float64) * (-1 if positive else 1)
        layer = np.asarray(layer,np.float64)
        if axes.ndim != 2 or axes.shape != layer.shape or axes.shape[1] != 3 or len(axes) < 2:
            raise ValueError('Grain curves require K by 3 samples')
        if not np.isfinite(axes).all() or not np.isfinite(layer).all() or np.any(np.diff(axes,axis=0)<0):
            raise ValueError('Unsupported grain curve domain')
        constants = np.column_stack([np.broadcast_to(value,(3,)) for value in (minimum,maximum,particles,uniformity)])
        if not np.isfinite(constants).all() or np.any(constants[:,1:3]<=0):
            raise ValueError('Invalid particle parameters')
        entries=[constants.astype(np.float32).reshape(-1)];offsets=[];size=12
        for channel in range(3):
            entry=np.column_stack((axes[:,channel],layer[:,channel])).astype(np.float32).reshape(-1)
            entries.append(entry);offsets.append(size);size+=entry.size
        table=np.concatenate(entries)
        token=int.from_bytes(hashlib.blake2b(memoryview(table),digest_size=8).digest(),'little')
        return self._run(image,table,token,[0,8 if direct else (7 if positive else 6),0,int(seed)&0xffffffff,*offsets,*([len(axes)]*3)])

    def trilinear(self, image, table, *, rgb_order=False, low=(0, 0, 0), high=(1, 1, 1), dtype=np.float32):
        table = np.ascontiguousarray(table, np.float32)
        if table.ndim != 4 or table.shape[-1] != 3 or len(set(table.shape[:3])) != 1 or len(table) < 2:
            raise ValueError('Invalid BGR LUT')
        token = int.from_bytes(hashlib.blake2b(memoryview(table), digest_size=8).digest(), 'little')
        return self._run(image, table, token, [0, 5 if rgb_order else 4, len(table), 0, 0, 0, 0, 0, 0, 0],
                         low, high, dtype=dtype)

    def interpolate(self, image, prepared, identity, low=(0, 0, 0), high=(1, 1, 1)):
        # Keep packed tables bounded separately from upstream float64 tables.
        key = ('lut', identity)
        entry = self._tables.pop(key, None)
        if entry is None:
            lengths = [entry.size for entry in prepared]
            offsets = np.cumsum([0, *lengths[:-1]]).tolist()
            table = np.concatenate([entry.reshape(-1) for entry in prepared]).astype(np.float32)
            token = int.from_bytes(hashlib.blake2b(repr(key).encode(), digest_size=8).digest(), 'little')
            entry = (table, token, [0, 0, len(prepared[0]), 0, *offsets])
        self._tables[key] = entry
        while len(self._tables)>4 or sum(item[0].nbytes for item in self._tables.values())>96*1024**2:
            self._tables.popitem(last=False)
        table, token, parameters = entry
        return self._run(image, table, token, parameters, low, high)

    def spectral(self, image, dyes, base, weights, identity, offset=None, curves=None):
        if np.shape(dyes) != (len(base), 3) or np.shape(weights) != (len(base), 3):
            raise ValueError('Spectral GPU inputs require one RGB triplet per wavelength')
        table = np.column_stack((dyes, base, weights)).astype(np.float32).reshape(-1)
        table = np.concatenate((table, np.zeros(3, np.float32) if offset is None else np.asarray(offset, np.float32).reshape(3)))
        parameters = [0, 1, 0, len(base), 0, 0, 0, 0, 0, 0]
        if curves is not None:
            curve_table, offsets, lengths = self._curve_table(*curves, offset=table.size)
            table = np.concatenate((table, curve_table))
            parameters = [0, 3, 0, len(base), *offsets, *lengths]
        token = int.from_bytes(hashlib.blake2b(table.tobytes(), digest_size=8).digest(), 'little')
        return self._run(image, table, token, parameters)

    @staticmethod
    def _curve_table(exposure, curves, gamma, offset=0):
        gamma = np.broadcast_to(np.asarray(gamma), (3,))
        entries, offsets, lengths = [], [], []
        size = offset
        for channel in range(3):
            valid = np.isfinite(exposure)
            entry = np.column_stack((exposure[valid]/gamma[channel], curves[valid, channel])).astype(np.float32)
            if len(entry) < 2 or np.any(np.diff(entry[:, 0]) <= 0):
                raise ValueError('GPU curve requires two increasing finite samples')
            offsets.append(size)
            lengths.append(len(entry))
            entries.append(entry.reshape(-1))
            size += entry.size
        table = np.concatenate(entries)
        return table, offsets, lengths

    def curves(self, image, exposure, curves, gamma):
        table, offsets, lengths = self._curve_table(exposure, curves, gamma)
        token = int.from_bytes(hashlib.blake2b(table.tobytes(), digest_size=8).digest(), 'little')
        return self._run(image, table, token, [0, 2, 0, 0, *offsets, *lengths])


_gpu = None
_unavailable = False
_device_lock = threading.RLock()


def device():
    global _gpu, _unavailable
    with _device_lock:
        if _gpu is None and not _unavailable:
            try:
                _gpu = Vulkan()
            except (OSError, RuntimeError):
                _unavailable = True
        return _gpu


def disable():
    global _gpu, _unavailable
    with _device_lock:
        if _gpu is not None:
            _gpu.close()
        _gpu = None
        _unavailable = True


atexit.register(disable)
