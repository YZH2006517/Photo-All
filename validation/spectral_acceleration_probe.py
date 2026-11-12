"""Diagnostic A/B only: keep application code and its defaults untouched."""
from pathlib import Path
import argparse,contextlib,json,os,sys,time
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'product'))
import numpy as np

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--prepare',action='store_true');parser.add_argument('--profile',action='store_true');parser.add_argument('--tiled',action='store_true');parser.add_argument('--implemented',action='store_true');parser.add_argument('--reprint',action='store_true');parser.add_argument('--vulkan',action='store_true');args=parser.parse_args()
    out=ROOT/'validation/artifacts/spectral-acceleration-2026-11-11';out.mkdir(parents=True,exist_ok=True)
    if args.prepare:
        sys.path.insert(0,str(ROOT/'product/engines/precision-packages'))
        import engine,pixels
        engine.RAW_CACHE=ROOT/'validation/artifacts/editor-raw-real-2026-11-11-packaged/data/raw-cache'
        path=engine.develop_raw(ROOT/'raw test/DSC_0772.NEF',output_16bit=True)
        rgb=np.ascontiguousarray(pixels.read(path)[...,:3],dtype=np.float32)
        np.save(out/'input.npy',rgb,allow_pickle=False)
        print(json.dumps({'input':str(path),'shape':rgb.shape,'dtype':str(rgb.dtype)},ensure_ascii=True));return
    import film_spectral as bridge
    if args.vulkan:
        import film_gpu, colour
        from unittest.mock import patch
        gpu=film_gpu.device()
        if gpu is None:raise RuntimeError('No real Vulkan GPU')
        rgb=np.load(out/'input.npy',mmap_mode='r');small=rgb[::10,::10]
        rows=[]
        def measure(name,image,config):
            start=time.perf_counter()
            result=bridge.simulate_array(image,config,'kodak_portra_endura',preview=True)
            row={'operation':name,'seconds':round(time.perf_counter()-start,4),
                 'shape':list(result.shape),'device':gpu.device,
                 'stages':dict(bridge._pipelines['accelerated'].get_timings())}
            rows.append(row);print(json.dumps(row),flush=True)
            (out/'vulkan-timings.json').write_text(json.dumps(rows,indent=2),encoding='utf-8')
            return result
        base={'stock':'kodak_gold_200'}
        measure('gpu_warmup',small,base)
        native=measure('gpu_native',rgb,base)
        measure('gpu_native_reprint',rgb,{**base,'paper_ev':.3})
        reference=np.load(out/'exact.npy',mmap_mode='r')
        def lab(image):return colour.XYZ_to_Lab(colour.sRGB_to_XYZ(np.clip(image,0,1)))
        delta=colour.delta_E(lab(reference[::16,::16]),lab(native[::16,::16]),method='CIE 2000')
        rows[-2]['p95_delta_e']=float(np.quantile(delta,.95))
        for stock in ('kodak_portra_400','fujifilm_provia_100f'):
            config={'stock':stock}
            native=measure('gpu_preview_'+stock,small,config)
            with patch.object(film_gpu,'device',return_value=None):
                bridge._color_luts.clear()
                cpu=measure('cpu_preview_'+stock,small,config)
            np.testing.assert_allclose(native,cpu,atol=.004)
        measure('gpu_native_spatial',rgb,{**base,'halation':'on','grain':'on','grain_area':.3})
        (out/'vulkan-timings.json').write_text(json.dumps(rows,indent=2),encoding='utf-8')
        return
    if args.reprint:
        from unittest.mock import patch
        from spektrafilm.model import glare
        import colour
        source=np.load(out/'input.npy',mmap_mode='r')
        rgb=np.ascontiguousarray(source[::10,::10])
        base={'stock':'kodak_gold_200','halation':'on'}
        def run(changes, *, preview=False, quality='accelerated', image=rgb):
            start=time.perf_counter()
            result=bridge.simulate_array(image,{**base,**changes},'kodak_portra_endura',preview=preview,quality=quality)
            return result,round(time.perf_counter()-start,4)
        report={'raw':'DSC_0772.NEF','preview_pixels':[rgb.shape[1],rgb.shape[0]],'reprints':[]}
        run({},preview=True)
        for ev in (.3,.6,1.0):
            # Warm the same downstream LUT in both routes before comparing the film stages.
            run({'paper_ev':ev})
            plain,t0=run({'paper_ev':ev})
            reuse,t1=run({'paper_ev':ev},preview=True)
            np.testing.assert_allclose(plain,reuse,atol=2e-6)
            report['reprints'].append({'paper_ev':ev,'all_stages_s':t0,'reprint_s':t1})
        glare_field=glare.compute_random_glare_amount(10.,.5,.5,rgb.shape[:2])
        with patch.object(glare,'compute_random_glare_amount',return_value=glare_field):
            exact,_=run({'glare':.1},quality='exact')
            fast,_=run({'glare':.1})
            def lab(image):return colour.XYZ_to_Lab(colour.sRGB_to_XYZ(np.clip(image,0,1)))
            delta=colour.delta_E(lab(exact),lab(fast),method='CIE 2000')
            report['paired_glare_p95_delta_e']=float(np.quantile(delta,.95))
        result,elapsed=run({'halation':'off'},image=source)
        report['native_seconds']=elapsed
        reference=np.load(out/'exact.npy',mmap_mode='r')
        delta=colour.delta_E(lab(reference[::16,::16]),lab(result[::16,::16]),method='CIE 2000')
        report['native_p95_delta_e']=float(np.quantile(delta,.95))
        (out/'reprint-timings.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
        print(json.dumps(report),flush=True)
        return
    if args.implemented:
        import colour
        rgb=np.load(out/'input.npy',allow_pickle=False);small=rgb[::10,::10];rows=[]
        def measure(name,image,config,quality):
            t=time.perf_counter()
            with contextlib.redirect_stdout(sys.stderr):value=bridge.simulate_array(image,config,'kodak_portra_endura',quality=quality)
            row={'operation':name,'seconds':round(time.perf_counter()-t,4),'pixels':[image.shape[1],image.shape[0]],'finite':bool(np.isfinite(value).all())};rows.append(row)
            print(json.dumps(row),flush=True);(out/'implemented-timings.json').write_text(json.dumps(rows,indent=2),encoding='utf-8');return value
        def error(a,b):
            first=colour.XYZ_to_Lab(colour.sRGB_to_XYZ(np.clip(a,0,1)));second=colour.XYZ_to_Lab(colour.sRGB_to_XYZ(np.clip(b,0,1)));delta=colour.delta_E(first,second,method='CIE 2000')
            return {'median':float(np.median(delta)),'p95':float(np.quantile(delta,.95)),'p99':float(np.quantile(delta,.99)),'max':float(np.max(delta))}
        base={'stock':'kodak_gold_200','grain':'off','halation':'off'}
        measure('warmup',small,base,'accelerated')
        fast=measure('accelerated_native',rgb,base,'accelerated')
        reference=np.load(out/'exact.npy',allow_pickle=False)
        rows[-1]['delta_e_2000']=error(fast[::16,::16],reference[::16,::16]);np.save(out/'implemented-native.npy',fast,allow_pickle=False)
        measure('accelerated_repeat_preview',small,base,'accelerated')
        variants=[('portra',{'stock':'kodak_portra_400'}),('provia',{'stock':'fujifilm_provia_100f'}),('film_plus3',{'film_ev':3}),('film_minus3',{'film_ev':-3}),('paper_plus2',{'paper_ev':2}),('cc_preflash',{'tune_m':20,'tune_y':-15,'preflash':'on','preflash_ev':-7}),('couplers',{'coupler_amount':1.3,'lang_r':.25}),('glare',{'glare':.1}),('kelvin',{'scene_mode':'kelvin','scene_kelvin':3200})]
        for name,patch in variants:
            config={**base,**patch};a=measure(name+'_exact',small,config,'exact');b=measure(name+'_accelerated',small,config,'accelerated');rows[-1]['delta_e_2000']=error(a[::2,::2],b[::2,::2])
            (out/'implemented-timings.json').write_text(json.dumps(rows,indent=2),encoding='utf-8')
        measure('native_halation_grain',rgb,{**base,'halation':'on','grain':'on','grain_area':.3},'accelerated')
        (out/'implemented-timings.json').write_text(json.dumps(rows,indent=2),encoding='utf-8');return
    import spektrafilm.runtime.pipeline as module
    from spektrafilm.runtime.services import SpectralLUTService
    original_pipeline=module.SimulationPipeline
    results=[];instances={};latest=[None]
    class NativeLUTProxy:
        def __init__(self,service):object.__setattr__(self,'service',service)
        def __getattr__(self,name):return getattr(self.service,name)
        def __setattr__(self,name,value):
            if name not in {'spectral_compute_enlarger','spectral_compute_scanner'}:setattr(self.service,name,value)
    def accelerated(params):
        resolution=current_resolution[0]
        params.settings.use_enlarger_lut=True
        params.settings.use_scanner_lut=True
        params.settings.use_fast_stats=True
        params.settings.lut_resolution=resolution
        pipeline=instances.get(resolution)
        if pipeline is None:
            pipeline=original_pipeline(params);pipeline._lut_service=NativeLUTProxy(pipeline._lut_service);instances[resolution]=pipeline
        else:pipeline.update(params)
        latest[0]=pipeline
        return pipeline
    rgb=np.load(out/'input.npy',allow_pickle=False)
    config={'stock':'kodak_gold_200','grain':'off','halation':'off'}
    def run(name,image,mode):
        module.SimulationPipeline=original_pipeline if mode=='exact' else accelerated
        t=time.perf_counter()
        with contextlib.redirect_stdout(sys.stderr):value=bridge.simulate_array(image,config,'kodak_portra_endura')
        seconds=time.perf_counter()-t
        assert value.shape==image.shape and np.isfinite(value).all()
        row={'operation':name,'seconds':round(seconds,4),'pixels':[image.shape[1],image.shape[0]],'mode':mode}
        if mode!='exact':row['stage_timings']=latest[0].get_timings()
        results.append(row);(out/'timings.json').write_text(json.dumps(results,indent=2),encoding='utf-8');print(json.dumps(row),flush=True)
        return value
    current_resolution=[17]
    small=rgb[::10,::10]
    if args.tiled:
        from spektrafilm.runtime.stages import scanning
        original_compress=scanning.compress_rgb
        def tiled_compress(array,*args,**kwargs):
            flat=np.asarray(array).reshape(-1,3)
            if len(flat)<=65536:return original_compress(array,*args,**kwargs)
            result=np.empty(flat.shape,dtype=np.float64)
            for start in range(0,len(flat),65536):result[start:start+65536]=original_compress(flat[start:start+65536],*args,**kwargs)
            return result.reshape(array.shape)
        scanning.compress_rgb=tiled_compress
        current_resolution[0]=33
        run('tiled_warmup',small,'lut')
        value=run('tiled_native',rgb,'lut')
        reference=np.load(out/'lut33.npy',allow_pickle=False)
        results[-1]['compared_with_same_lut33']={'identical_float32':bool(np.array_equal(value,reference)),'max_abs_error':float(np.max(np.abs(value-reference)))}
        (out/'tiled-timings.json').write_text(json.dumps(results,indent=2),encoding='utf-8')
        return
    if args.profile:
        import cProfile,pstats
        current_resolution[0]=33
        run('profile_warmup',small,'lut')
        profiler=cProfile.Profile();profiler.enable()
        run('profile_native',rgb,'lut')
        profiler.disable()
        with (out/'profile-lut33.txt').open('w',encoding='utf-8') as stream:pstats.Stats(profiler,stream=stream).sort_stats('cumtime').print_stats(65)
        (out/'profile-timings.json').write_text(json.dumps(results,indent=2),encoding='utf-8')
        return
    reference_small=run('exact_small',small,'exact')
    for resolution in [17,33]:
        current_resolution[0]=resolution
        result=run(f'lut{resolution}_small_first',small,'lut')
        error=np.abs(result-reference_small)
        results[-1]['rgb_abs_error']={'mean':float(error.mean()),'p99':float(np.quantile(error,.99)),'max':float(error.max())}
        run(f'lut{resolution}_small_repeat',small,'lut')
    reference=run('exact_native',rgb,'exact');np.save(out/'exact.npy',reference,allow_pickle=False)
    for resolution in [17,33]:
        current_resolution[0]=resolution
        value=run(f'lut{resolution}_native',rgb,'lut')
        # Keep the full native grid; sample it only for expensive error metrics.
        error=np.abs(value[::4,::4]-reference[::4,::4])
        import colour
        reference_rgb=np.clip(reference[::16,::16],0,1);result_rgb=np.clip(value[::16,::16],0,1)
        reference_lab=colour.XYZ_to_Lab(colour.sRGB_to_XYZ(reference_rgb));result_lab=colour.XYZ_to_Lab(colour.sRGB_to_XYZ(result_rgb))
        delta=colour.delta_E(reference_lab,result_lab,method='CIE 2000')
        results[-1]['rgb_abs_error']={'mean':float(error.mean()),'p99':float(np.quantile(error,.99)),'max':float(error.max())}
        results[-1]['delta_e_2000_sample']={'count':int(delta.size),'median':float(np.median(delta)),'p95':float(np.quantile(delta,.95)),'max':float(delta.max())}
        np.save(out/f'lut{resolution}.npy',value,allow_pickle=False)
        (out/'timings.json').write_text(json.dumps(results,indent=2),encoding='utf-8')
    module.SimulationPipeline=original_pipeline

if __name__=='__main__':main()
