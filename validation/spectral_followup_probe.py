"""Native-photo profiling for film reuse, downstream edits and distribution size."""
from pathlib import Path
import cProfile, json, os, pstats, sys, time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'product'))
os.environ.setdefault('NUMBA_NUM_THREADS', '4')
os.environ.setdefault('OPENBLAS_NUM_THREADS', '2')
import numpy as np
import film_spectral as film

OUT = ROOT/'validation/artifacts/spectral-followup-2026-11-12'
OUT.mkdir(exist_ok=True, parents=True)

if '--stage' in sys.argv:
    import package_windows
    destination = OUT/'spectral-runtime'
    result = package_windows.stage_spectral_runtime(destination, ROOT/'product/build/runtime/engines/spectral-python')
    (OUT/'runtime-size.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(result['compaction']),flush=True)

if '--cold' in sys.argv:
    os.environ['LOCALAPPDATA']=str(OUT/('cold-'+str(time.time_ns())))
    film.PYTHONS=(OUT/'spectral-runtime/python.exe',)
    image=np.load(ROOT/'validation/artifacts/spectral-acceleration-2026-11-11/input.npy')[::10,::10].copy()
    recipe={'film_advanced':json.dumps({'stock':'kodak_portra_400','grain':'on','grain_area':.35,
            'halation':'on','halo_amount':1.3,'scene_mode':'kelvin','scene_kelvin':6100})}
    rows=[]
    for i in range(2):
        film._render_cache.clear()
        start=time.perf_counter();film.prepare_preview();result=film.render(image,recipe,{},preview=True)
        rows.append({'operation':'first_install' if i==0 else 'restart_disk_cache',
                     'seconds':time.perf_counter()-start,'shape':list(result.shape)})
        print(json.dumps(rows[-1]),flush=True);film.stop_worker()
    (OUT/'cold-spatial-final.json').write_text(json.dumps(rows,indent=2),encoding='utf-8')

if '--cancel' in sys.argv:
    import threading
    os.environ['LOCALAPPDATA']=str(OUT/'localappdata')
    film.PYTHONS=(OUT/'spectral-runtime/python.exe',)
    image=np.load(ROOT/'validation/artifacts/spectral-acceleration-2026-11-11/input.npy')
    config={'stock':'kodak_portra_400','grain':'on','halation':'on','grain_area':.35,'halo_amount':1.3}
    recipe={'film_advanced':json.dumps(config)}
    film.render(image[::4,::4].copy(),recipe,{},preview=True)
    pid=film._native_worker.process.pid
    current=threading.Event();current.set();outcome=[]
    def render():
        try:
            with film.preview_task(current.is_set):film.render(image,recipe,{},preview=True)
            outcome.append('unexpected completion')
        except film.PreviewSuperseded:outcome.append('cancelled')
        except Exception as exc:outcome.append(repr(exc))
    thread=threading.Thread(target=render);thread.start();time.sleep(.5)
    start=time.perf_counter();current.clear();thread.join(20)
    elapsed=time.perf_counter()-start
    assert not thread.is_alive() and outcome==['cancelled'],outcome
    assert film._native_worker.process.pid==pid and film._native_worker.process.poll() is None
    # A different native-sized image must still compute in that same worker.
    next_image=film.render(image[::3,::3].copy(),recipe,{},preview=True)
    report={'cancel_seconds':elapsed,'worker_pid_before':pid,'worker_pid_after':film._native_worker.process.pid,
            'outcome':outcome,'next_shape':list(next_image.shape),'renderer':film._native_worker.renderer}
    print(json.dumps(report),flush=True)
    (OUT/'cooperative-cancel.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    film.stop_worker()

if '--pipeline' in sys.argv:
    from unittest.mock import patch
    import contextlib
    import engine, film_gpu, open_filters, pixels
    import tempfile
    temporary = OUT/'tmp'
    temporary.mkdir(exist_ok=True)
    tempfile.tempdir = str(temporary)
    os.environ['LOCALAPPDATA'] = str(OUT/'localappdata')
    engine.RAW_CACHE = OUT/'raw-cache'
    film.PYTHONS = (OUT/'spectral-runtime/python.exe',) if '--compact' in sys.argv else (ROOT/'product/build/runtime/engines/spectral-python/python.exe',)
    baseline = '--baseline' in sys.argv
    rows = []
    path = Path('E:/醒图over/DSC_1073.JPG') if '--jpg' in sys.argv else Path('F:/PHOTO ALL/raw test/DSC_0772.NEF')
    config={'stock':'kodak_gold_200'}
    if '--spatial' in sys.argv:
        config={'stock':'kodak_portra_400','film_ev':.4,'paper_ev':.3,'tune_m':4,
                'preflash':'on','preflash_ev':-8,'coupler_amount':.7,'halation':'on',
                'halo_amount':1.3,'grain':'on','grain_area':.35,'scene_mode':'kelvin','scene_kelvin':6100}
    recipe = engine.validate_recipe({'film_advanced':json.dumps(config)})
    def measure(name, callback):
        start = time.perf_counter()
        result = callback()
        rows.append({'operation':name,'seconds':round(time.perf_counter()-start,4),
                     'shape':list(result.shape) if isinstance(result,np.ndarray) else None})
        print(json.dumps(rows[-1]),flush=True)
        report = {'source':str(path),'baseline_cache_bypass':baseline,'results':rows,
                  'renderers':film.catalog({})['renderers']}
        (OUT/(('spatial-' if '--spatial' in sys.argv else '')+('before-' if baseline else 'after-')+('jpg' if '--jpg' in sys.argv else 'raw')+'.json')).write_text(json.dumps(report,indent=2),encoding='utf-8')
        return result
    with contextlib.ExitStack() as stack:
        if baseline:
            stack.enter_context(patch.object(film._render_cache,'get',return_value=None))
            stack.enter_context(patch.object(film_gpu,'device',return_value=None))  # CPU LUT baseline only; worker keeps Vulkan.
        measure('decode_native',lambda:pixels.render(path,{},preview=True))
        film.prepare_preview()
        measure('film_draft_640',lambda:pixels.render(path,recipe,max_size=(640,640),preview=True))
        measure('film_native_first',lambda:pixels.render(path,recipe,preview=True))
        shadow = {**recipe,'shadows':.25,'blacks':-.1}
        measure('post_shadows_native',lambda:pixels.render(path,shadow,preview=True))
        lut = next(iter(open_filters.manifest()['items']))
        filtered = {**shadow,'filter_id':lut,'filter_strength':.8}
        image = measure('post_lut_native',lambda:pixels.render(path,filtered,preview=True))
        import hashlib
        photo = {'path':str(path),'name':path.name,'digest':hashlib.sha256(path.read_bytes()).hexdigest(),'recipe':filtered,
                 'width':image.shape[1],'height':image.shape[0]}
        for format in ('jpeg','tiff','png'):
            measure('export_'+format+'_native',lambda f=format:engine.export_photo(photo,OUT/'exports',template='plain',size=0,format=f))
        reprint={**recipe,'film_advanced':json.dumps({**config,'paper_ev':.6})}
        measure('spectral_reprint_native',lambda:pixels.render(path,reprint,preview=True))
        measure('pre_film_exposure_native',lambda:pixels.render(path,{**recipe,'exposure':.2},preview=True))
    film.stop_worker()

if '--gpu' in sys.argv:
    import ctypes
    from film_gpu import Vulkan
    rgb = np.load(ROOT/'validation/artifacts/spectral-acceleration-2026-11-11/input.npy')
    axis = np.linspace(0,1,65, dtype=np.float32)
    grid = np.stack(np.meshgrid(axis, axis, axis, indexing='ij'), axis=-1)
    with Vulkan() as gpu:
        gpu.library.pa_gpu_timings.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_double)]
        timings = (ctypes.c_double*4)()
        for i in range(2):
            start = time.perf_counter()
            result = gpu.trilinear(rgb, grid)
            gpu.library.pa_gpu_timings(gpu.context, timings)
            print(json.dumps({'seconds':time.perf_counter()-start, 'last_tile':list(timings), 'tile':gpu.tile}), flush=True)

if '--profile' in sys.argv:
    rgb = np.load(ROOT/'validation/artifacts/spectral-acceleration-2026-11-11/input.npy')
    config = {'stock': 'kodak_gold_200'}
    if '--spatial' in sys.argv:
        config = {'stock':'kodak_portra_400','film_ev':.4,'paper_ev':.3,'tune_m':4,
                  'preflash':'on','preflash_ev':-8,'coupler_amount':.7,'halation':'on',
                  'halo_amount':1.3,'grain':'on','grain_area':.35,
                  'scene_mode':'kelvin','scene_kelvin':6100}
    film.simulate_array(rgb[::10, ::10], config, 'kodak_portra_endura', preview=True)
    profile = cProfile.Profile()
    start = time.perf_counter()
    result = profile.runcall(film.simulate_array, rgb, config, 'kodak_portra_endura', preview=True)
    metrics = {'seconds':time.perf_counter()-start,'shape':list(result.shape)}
    print(json.dumps(metrics), flush=True)
    with (OUT/('spatial-profile.txt' if '--spatial' in sys.argv else 'profile.txt')).open('w') as stream:
        pstats.Stats(profile, stream=stream).sort_stats('cumtime').print_stats(60)
    if '--spatial' in sys.argv:
        (OUT/'spatial-metrics.json').write_text(json.dumps(metrics,indent=2),encoding='utf-8')
        sys.exit(0)
    import colour
    exact = np.load(ROOT/'validation/artifacts/spectral-acceleration-2026-11-11/exact.npy', mmap_mode='r')
    def lab(image): return colour.XYZ_to_Lab(colour.sRGB_to_XYZ(np.clip(image[::16, ::16], 0, 1)))
    error = colour.delta_E(lab(exact), lab(result), method='CIE 2000')
    metrics.update(delta_e_p95=float(np.quantile(error,.95)),delta_e_max=float(error.max()))
    (OUT/'profile-metrics.json').write_text(json.dumps(metrics,indent=2),encoding='utf-8')
    print(json.dumps(metrics),flush=True)
