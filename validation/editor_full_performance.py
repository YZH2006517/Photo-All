"""Real-photo editor matrix; isolated catalog/exports, no application source edits."""
from pathlib import Path
from io import BytesIO
import argparse, hashlib, json, os, platform, statistics, sys, threading, time
from urllib.request import Request, urlopen
from urllib.error import HTTPError

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'product'))
sys.path.insert(0,str(ROOT/'product/engines/precision-packages'))
import engine, service, film, film_spectral, borders, open_filters, workflow
from PIL import Image
film_spectral.PYTHONS=(ROOT/'product/build/runtime/engines/spectral-python/python.exe',)

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--input',default='E:/醒图over')
    parser.add_argument('--output',required=True)
    parser.add_argument('--phase',choices=['all','general','spectral','native','exports','verify','raw-verify'],default='all')
    args=parser.parse_args()
    out=Path(args.output).resolve();out.mkdir(parents=True,exist_ok=True)
    files=sorted([p for p in Path(args.input).rglob('*') if p.is_file() and p.suffix.lower() in engine.SUPPORTED],key=lambda p:p.stat().st_size)
    if not files:raise RuntimeError('No real photos')
    def digest(p):
        h=hashlib.sha256()
        with p.open('rb') as stream:
            for b in iter(lambda:stream.read(1024*1024),b''):h.update(b)
        return h.hexdigest()
    hashes={str(p):digest(p) for p in files}
    (out/'source-hashes-before.json').write_text(json.dumps(hashes,ensure_ascii=False,indent=2),encoding='utf-8')
    existing=out/'backend-timings.json'
    results=json.loads(existing.read_text(encoding='utf-8')) if args.phase in {'verify','raw-verify'} and existing.exists() else []
    generation=0
    def record(operation,started,**extra):
        row=dict(operation=operation,seconds=round(time.perf_counter()-started,4),**extra)
        results.append(row)
        (out/'backend-timings.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps(row,ensure_ascii=False),flush=True);return row
    server=service.create_server(out/'data','full-real-test',0)
    raw_traces=[]
    original_develop=engine.develop_raw
    def traced_develop(path,recipe=None,preview_size=None,output_16bit=False,**options):
        before=set(engine.RAW_CACHE.glob('*.tif'))|set(engine.RAW_CACHE.glob('*.png'))
        t=time.perf_counter()
        target=original_develop(path,recipe,preview_size,output_16bit,**options)
        with Image.open(target) as image:
            dimensions=list(image.size);bits=image.tag_v2.get(258) if target.suffix=='.tif' else 8
        raw_traces.append(dict(source=str(path),preview_size=preview_size,output_16bit=output_16bit,
            seconds=round(time.perf_counter()-t,4),cache_hit=target in before,output=str(target),
            dimensions=dimensions,bits=bits,raw_recipe={k:v for k,v in (recipe or {}).items() if k.startswith('raw_')}))
        trace_name='raw-verify-develop-traces.json' if args.phase=='raw-verify' else 'raw-develop-traces.json'
        (out/trace_name).write_text(json.dumps(raw_traces,ensure_ascii=False,indent=2),encoding='utf-8')
        return target
    engine.develop_raw=traced_develop
    threading.Thread(target=server.serve_forever,daemon=True).start()
    base=f'http://127.0.0.1:{server.server_port}'
    (out/'endpoint.json').write_text(json.dumps(dict(port=server.server_port,token='full-real-test')),encoding='utf-8')
    def request(route,body=None):
        req=Request(base+'/api'+route,data=None if body is None else json.dumps(body).encode(),headers={'Authorization':'Bearer full-real-test','Content-Type':'application/json'})
        with urlopen(req,timeout=360) as response:
            data=response.read()
            return json.loads(data) if 'application/json' in response.headers.get('Content-Type','') else data
    def job(route,body,cancel=False):
        value=request(route,body);identity=value['id']
        cancel_started=None
        if cancel:
            # Cancel after at least one real image has finished, while the next
            # original-size TIFF is being rendered; not merely a queued job.
            deadline=time.perf_counter()+90
            while time.perf_counter()<deadline:
                progress=request('/jobs/'+identity)
                if progress['status']!='running' or progress['done']>=1:break
                time.sleep(.05)
            time.sleep(.15)
            cancel_started=time.perf_counter()
            request('/jobs/'+identity+'/cancel',{})
        end=time.perf_counter()+420
        while time.perf_counter()<end:
            value=request('/jobs/'+identity)
            if value['status']!='running':
                if value['status']=='error':raise RuntimeError(value.get('error'))
                if value.get('result',{}).get('errors'):raise RuntimeError(value['result']['errors'])
                if cancel_started is not None:value['cancel_latency_seconds']=round(time.perf_counter()-cancel_started,4)
                return value
            time.sleep(.05)
        raise TimeoutError('job '+identity)
    def recipe(patch=None):return engine.validate_recipe({**engine.DEFAULT_RECIPE,**(patch or {})})
    def save(photo,r):return request('/edit',dict(ids=[photo['id']],recipe=r))
    def image_case(photo,name,r,size=1024,category='general',border=False,save_image=False):
        nonlocal generation
        started=time.perf_counter()
        try:
            generation+=1
            route='/border-preview' if border else '/editor-preview'
            data=request(route,dict(id=photo['id'],recipe=r,size=size,preview_session='full-matrix',generation=generation))
            with Image.open(BytesIO(data)) as img:
                img.load();dimensions=list(img.size)
                # Include actual decoded output evidence, rather than only an HTTP 200.
                extrema=img.convert('RGB').getextrema()
                if all(a==b for a,b in extrema):raise RuntimeError('constant-color result')
            row=record(name,started,category=category,photo=photo['name'],source_pixels=[photo['width'],photo['height']],output=dimensions,bytes=len(data),ok=True)
            if save_image:(out/(name+'.jpg')).write_bytes(data)
            return row
        except Exception as exc:
            return record(name,started,category=category,photo=photo['name'],ok=False,error=str(exc))
    try:
        started=time.perf_counter()
        library=request('/library')
        if not library['albums']:
            album=request('/albums',{'name':Path(args.input).name+' 全功能实拍测试'})
            imported=job('/import',dict(folder=args.input,album_id=album['id']))
            record('import_all_real_photos',started,category='import',ok=True,result=imported)
        library=request('/library');photos=library['photos']
        bypath={str(Path(p['path']).resolve()).lower():p for p in photos}
        chosen=[bypath[str(p.resolve()).lower()] for p in [files[0],files[len(files)//2],files[-1]]]
        inventory=dict(input=args.input,count=len(files),bytes=sum(p.stat().st_size for p in files),platform=platform.platform(),python=sys.version,cpu_count=os.cpu_count(),representatives=[dict(name=p['name'],width=p['width'],height=p['height'],bytes=Path(p['path']).stat().st_size,id=p['id']) for p in chosen],spectral_fields=sum(len(v) for v in film_spectral.GROUPS.values()),spectral_stocks=len(film.STOCKS)+len(film_spectral.SLIDES),filters=library['filters']['count'])
        (out/'inventory.json').write_text(json.dumps(inventory,ensure_ascii=False,indent=2),encoding='utf-8')
        (out/'spectral-controls.json').write_text(json.dumps(film_spectral.GROUPS,ensure_ascii=False,indent=2),encoding='utf-8')
        if args.phase in ['all','general']:
            if any(Path(p['path']).suffix.lower() in engine.RAW for p in photos):
                for photo in photos:
                    t=time.perf_counter()
                    try:
                        data=request(f'/image/{photo["id"]}?size=640&quality=camera')
                        with Image.open(BytesIO(data)) as im:im.load();dims=list(im.size)
                        record('raw_camera_thumbnail_all',t,category='raw_thumbnail',photo=photo['name'],ok=True,output=dims)
                    except Exception as exc:record('raw_camera_thumbnail_all',t,category='raw_thumbnail',photo=photo['name'],ok=False,error=str(exc))
            for p in chosen:
                save(p,recipe())
                for name,route in [('thumbnail_cold',f'/image/{p["id"]}?size=640'),('thumbnail_warm',f'/image/{p["id"]}?size=640'),('native_cold',f'/image/{p["id"]}?size=0&quality=source'),('native_warm',f'/image/{p["id"]}?size=0&quality=source'),('live_base',f'/live-base/{p["id"]}?size=0')]:
                    t=time.perf_counter()
                    try:
                        data=request(route)
                        with Image.open(BytesIO(data)) as im:im.load();dims=list(im.size)
                        record(name,t,category='load',photo=p['name'],ok=True,output=dims)
                    except Exception as exc:record(name,t,category='load',photo=p['name'],ok=False,error=str(exc))
            p=chosen[1]
            if Path(p['path']).suffix.lower() in engine.RAW:
                raw_cases=[('raw_exposure',dict(raw_exposure=.7)),('raw_wb_auto',dict(raw_wb='auto')),
                    ('raw_temperature',dict(raw_wb='custom',raw_temperature=5200)),
                    ('raw_tint',dict(raw_wb='custom',raw_temperature=5200,raw_tint=1.2)),
                    ('raw_highlights',dict(raw_highlights=35)),('raw_denoise',dict(raw_denoise=15)),
                    ('raw_sharpen',dict(raw_sharpen=60))]
                for name,patch in raw_cases:
                    image_case(p,name,recipe(patch),category='raw_controls')
                    image_case(p,name+'_cached',recipe(patch),category='raw_controls_warm')
            values=dict(exposure=.5,contrast=1.2,saturation=1.3,temperature=.25,shadows=.4,highlights=-.3,whites=.2,blacks=-.2,vibrance=.3,tint=.2,black_point=.1,white_point=.9,gamma=1.2,clarity=.3,dehaze=.3,sharpen=.5,sharpen_radius=2,denoise=.25,vignette=.3,quarter_turns=1,flip_x=1,flip_y=1,straighten=5)
            for key,value in values.items():image_case(p,'adjust_'+key,recipe({key:value}))
            image_case(p,'crop',recipe(dict(crop_x=.1,crop_y=.1,crop_w=.7,crop_h=.7)))
            for key in ['curve_rgb','curve_r','curve_g','curve_b']:
                image_case(p,key,recipe({key:'[[0,0],[0.5,0.65],[1,1]]'}))
            for band in range(8):image_case(p,'hsl_'+str(band),recipe(dict(hsl=json.dumps([dict(band=band,hue=10,saturation=.2,luminance=.1)]))))
            for key in film.STOCKS:image_case(p,'film_lut_'+key,recipe(dict(film_stock=key,film_strength=.8,film_grain=.35,film_halation=.15)),category='film_lut')
            for key in engine.STYLES:image_case(p,'style_'+key,recipe(dict(style=key)),category='style')
            available=[key for key,v in library['filters']['items'].items() if v['ready']]
            for key in available:image_case(p,'open_lut_'+key,recipe(dict(filter_id=key,filter_strength=.8)),category='open_lut')
            layers=[dict(uid='a',kind='style',id='cinema',strength=.7),dict(uid='b',kind='style',id='soft',strength=.4)]
            if available:layers.append(dict(uid='c',kind='lut',id=available[0],strength=.8))
            for name,stack in [('stack',layers),('stack_reorder',list(reversed(layers))),('stack_disabled',[{**a,'enabled':False} if a['uid']=='a' else a for a in layers])]:image_case(p,name,recipe(dict(filter_stack=json.dumps(stack))))
            for style in borders.STYLES:image_case(p,'border_'+style,recipe(dict(exposure=.2,border=json.dumps(dict(style=style,roll_name='真实照片测试',signature='Photo All',date_mode='custom',date_text='2026.11.11',info_mode='custom',info_text='JPEG / 6000 × 4000')))),border=True,category='border')
            save(p,recipe(dict(exposure=.4)))
            for route in ['/undo','/redo']:
                t=time.perf_counter();request(route,{});record(route[1:],t,category='history',ok=True)
            for key,patch in [('light_native',dict(exposure=.3,shadows=.3,highlights=-.2)),('color_native',dict(temperature=.2,vibrance=.2)),('detail_native',dict(clarity=.2,sharpen=.5,denoise=.2)),('composition_native',dict(straighten=5,crop_x=.05,crop_y=.05,crop_w=.9,crop_h=.9))]:
                for photo in chosen:image_case(photo,key,recipe(patch),size=0,category='general_native')
            for blend in workflow.BLENDS:
                doc=dict(name='实拍多层验证',width=1800,height=1200,layers=[dict(photo_id=chosen[0]['id']),dict(photo_id=chosen[2]['id'],opacity=.5,blend=blend)])
                t=time.perf_counter()
                try:
                    data=request('/composite-preview',doc)
                    with Image.open(BytesIO(data)) as im:im.load();dims=list(im.size)
                    record('composite_'+blend,t,category='composite',ok=True,output=dims)
                except Exception as exc:record('composite_'+blend,t,category='composite',ok=False,error=str(exc))
        def spectral(config):return recipe(dict(film_advanced=json.dumps({'stock':'kodak_gold_200',**config}),film_strength=.8))
        if args.phase=='raw-verify':
            from PIL import ImageStat
            p=chosen[1]
            baseline=request('/editor-preview',dict(id=p['id'],recipe=recipe(),size=1024,preview_session='raw-signal',generation=1))
            with Image.open(BytesIO(baseline)) as img:base_rgb=img.convert('RGB');base_mean=sum(ImageStat.Stat(base_rgb).mean)/3;base_hash=hashlib.sha256(base_rgb.tobytes()).hexdigest()
            patches=[dict(raw_exposure=.7),dict(raw_wb='auto'),dict(raw_wb='custom',raw_temperature=5200),dict(raw_wb='custom',raw_temperature=5200,raw_tint=1.2),dict(raw_highlights=35),dict(raw_denoise=15),dict(raw_sharpen=60)]
            for index,patch in enumerate(patches,2):
                t=time.perf_counter()
                try:
                    data=request('/editor-preview',dict(id=p['id'],recipe=recipe(patch),size=1024,preview_session='raw-signal',generation=index))
                    with Image.open(BytesIO(data)) as img:rgb=img.convert('RGB');mean=sum(ImageStat.Stat(rgb).mean)/3;value=hashlib.sha256(rgb.tobytes()).hexdigest()
                    changed=value!=base_hash;assert changed,'RAW control did not change decoded RGB'
                    if 'raw_exposure' in patch:assert mean>base_mean,'RAW positive exposure did not brighten image'
                    record('raw_signal_'+str(index),t,category='raw_signal',ok=True,patch=patch,decoded_pixels_changed=changed,baseline_mean=base_mean,result_mean=mean)
                except Exception as exc:record('raw_signal_'+str(index),t,category='raw_signal',ok=False,patch=patch,error=str(exc))
        if args.phase in ['all','spectral']:
            p=chosen[1]
            for group,fields in film_spectral.GROUPS.items():
                for field in fields:
                    key=field['key']
                    if 'options' in field:values=list(field['options'])
                    else:
                        v=field['default'];distance=(field['max']-field['min'])*.13
                        values=[round(min(field['max'],v+distance) if v+distance<=field['max'] else max(field['min'],v-distance),4)]
                    for value in values:
                        config={key:value}
                        if group=='预闪' and key!='preflash':config['preflash']='on'
                        if group=='光晕' and key!='halation':config['halation']='on'
                        if group=='颗粒' and key!='grain':config['grain']='on'
                        if key.startswith('filter_'):config['neutral']='manual'
                        if key.startswith('negative_base'):config['process']='negative'
                        if key.endswith('_kelvin'):config[key.replace('_kelvin','_mode')]='kelvin'
                        # The preview ignores enlargement, but validates all exposed choices.
                        image_case(p,f'spectral_{key}_{value}',spectral(config),size=640,category='spectral_'+group)
            for stock in [*film.STOCKS,*film_spectral.SLIDES]:image_case(p,'spectral_stock_'+stock,spectral(dict(stock=stock)),size=640,category='spectral_stock')
            r=spectral(dict(film_ev=.2,paper_ev=.2))
            for style in borders.STYLES:image_case(p,'spectral_border_'+style,{**r,'border':json.dumps(dict(style=style))},border=True,category='spectral_border')
        if args.phase in ['all','native']:
            p=chosen[1]
            configs=[('base',{}),('film_paper_cc_preflash_couplers_light',dict(film_ev=.3,film_gamma=1.1,paper_ev=.3,paper_gamma=1.1,tune_m=4,tune_y=3,preflash='on',preflash_ev=-8,coupler_amount=.7,lang_r=.2,scene_light='D50',scan_light='D65')),('halation_grain',dict(halation='on',halo_amount=1.2,grain='on',grain_area=.3)),('scan',dict(process='scan'))]
            for name,config in configs:image_case(p,'spectral_native_'+name,spectral(config),size=0,category='spectral_native',save_image=True)
        if args.phase=='verify':
            for key in ['preflash','halation','grain']:
                image_case(chosen[1],'verify_spectral_'+key+'_off',spectral({key:'off'}),size=640,category='spectral_switch_verify')
            for photo in photos:save(photo,recipe())
            t=time.perf_counter()
            value=job('/export',dict(ids=[x['id'] for x in photos],folder=str(out/'exports'/'cancel-inflight'),format='tiff',size=0),cancel=True)
            record('export_cancel_inflight',t,category='export',ok=value['status']=='cancelled',result=value)
            for fmt in ['jpeg','png','tiff','webp','original']:
                t=time.perf_counter()
                targets=[p for p in (out/'exports'/fmt).glob('*') if p.suffix!='.json']
                details=[]
                for target in targets:
                    with Image.open(target) as im:
                        im.load();bits=im.tag_v2.get(258) if fmt=='tiff' else target.read_bytes()[24] if fmt=='png' else 8
                        details.append(dict(file=target.name,pixels=list(im.size),bits=bits,icc=bool(im.info.get('icc_profile'))))
                expected=all(d['bits']==16 if fmt=='png' else set(d['bits'] if isinstance(d['bits'],tuple) else [d['bits']])=={16} if fmt=='tiff' else True for d in details)
                record('verify_export_'+fmt,t,category='export_verify',ok=len(targets)==1 and expected,outputs=details)
        if args.phase in ['all','exports']:
            p=chosen[1];save(p,recipe(dict(exposure=.2,shadows=.2)))
            for fmt in ['jpeg','png','tiff','webp','original']:
                t=time.perf_counter()
                try:
                    result=job('/export',dict(ids=[p['id']],folder=str(out/'exports'/fmt),format=fmt,size=0,template='recipe'))
                    paths=[Path(v) for v in result['result']['outputs']]
                    detail=[]
                    for target in paths:
                        if fmt=='original' and target.suffix.lower() in engine.RAW:
                            if digest(target)!=hashes[p['path']]:raise RuntimeError('original RAW copy differs')
                            detail.append(dict(file=str(target),bytes=target.stat().st_size,original_sha256_match=True))
                            continue
                        with Image.open(target) as im:
                            im.load();dims=list(im.size)
                            bits=im.tag_v2.get(258) if fmt=='tiff' else target.read_bytes()[24] if fmt=='png' else 8
                            if fmt=='png' and bits!=16:raise RuntimeError('PNG is not 16 bit')
                            if fmt=='tiff' and set(bits if isinstance(bits,tuple) else [bits])!={16}:raise RuntimeError('TIFF is not 16 bit')
                            icc=bool(im.info.get('icc_profile'))
                        detail.append(dict(file=str(target),bytes=target.stat().st_size,output=dims,bits=bits,icc=icc))
                    if len(paths)!=1:raise RuntimeError('selected one but output '+str(len(paths)))
                    if fmt=='original' and digest(paths[0])!=hashes[p['path']]:raise RuntimeError('original copy differs')
                    record('export_'+fmt,t,category='export',ok=True,outputs=detail)
                except Exception as exc:record('export_'+fmt,t,category='export',ok=False,error=str(exc))
            for template in ['frame','portrait']:
                t=time.perf_counter();value=job('/export',dict(ids=[p['id']],folder=str(out/'exports'/template),format='jpeg',size=2400,template=template))
                record('template_'+template,t,category='export',ok=True,result=value)
            t=time.perf_counter();value=job('/export',dict(ids=[x['id'] for x in chosen],folder=str(out/'exports'/'album'),format='jpeg',size=1200,folder_mode='album'))
            record('export_album_folders',t,category='export',ok=len(value['result']['outputs'])==3,result=value)
            t=time.perf_counter();value=job('/export',dict(ids=[x['id'] for x in photos],folder=str(out/'exports'/'cancel'),format='tiff',size=0),cancel=True)
            record('export_cancel',t,category='export',ok=value['status']=='cancelled',result=value)
            # Full-source spectral export is measured separately from preview.
            save(p,spectral(dict(grain='on',halation='on')))
            t=time.perf_counter()
            try:
                value=job('/export',dict(ids=[p['id']],folder=str(out/'exports'/'spectral'),format='jpeg',size=0))
                record('export_spectral_jpeg',t,category='export',ok=len(value['result']['outputs'])==1,result=value)
            except Exception as exc:record('export_spectral_jpeg',t,category='export',ok=False,error=str(exc))
    finally:
        server.shutdown();server.server_close();film_spectral.stop_worker()
        engine.develop_raw=original_develop
        after={str(p):digest(p) for p in files}
        integrity=dict(unchanged=hashes==after,count=len(files))
        (out/'source-integrity.json').write_text(json.dumps(integrity),encoding='utf-8')
        assert integrity['unchanged'],'Original photo changed'
        summary={}
        for category in sorted({r['category'] for r in results}):
            rows=[r for r in results if r['category']==category];times=[r['seconds'] for r in rows if r.get('ok')]
            summary[category]=dict(total=len(rows),passed=sum(r.get('ok',False) for r in rows),median=round(statistics.median(times),4) if times else None,max=max(times) if times else None)
        (out/'backend-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps(dict(complete=True,source_integrity=integrity,summary=summary),ensure_ascii=False),flush=True)

if __name__=='__main__':main()
