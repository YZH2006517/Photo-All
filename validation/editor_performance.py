"""Real-photo timings. Uses an isolated catalog; never writes input photos."""
from pathlib import Path
from io import BytesIO
import argparse
import hashlib
import json
import sys
import threading
import time
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'product'))
sys.path.insert(0, str(ROOT / 'product/engines/precision-packages'))
import engine
import service
from PIL import Image


def run():
    parser = argparse.ArgumentParser()
    parser.add_argument('--label', default='baseline')
    parser.add_argument('--input', default='E:/醒图over')
    parser.add_argument('--spectral-only', action='store_true')
    parser.add_argument('--interactive', action='store_true')
    args = parser.parse_args()
    output = ROOT / 'validation/artifacts' / ('editor-perf-' + args.label)
    output.mkdir(parents=True, exist_ok=True)
    files = sorted((p for p in Path(args.input).iterdir() if p.suffix.lower() in engine.SUPPORTED), key=lambda p:p.stat().st_size)
    selected = [files[len(files)//2], files[-1], files[0]]
    before = {str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in selected}
    server = service.create_server(output / 'data', 'perf-test', 0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}'
    catalog = engine.Catalog(output / 'data/library.sqlite')
    album = catalog.create_album('真实照片性能验证')
    started = time.perf_counter()
    catalog.import_files(selected, album_id=album['id'])
    print(json.dumps({'import_seconds':round(time.perf_counter()-started,3)},ensure_ascii=False),flush=True)
    photos = list(catalog.photos())
    catalog.close()
    results = []
    def request(route, body=None):
        request = Request(base+route, data=None if body is None else json.dumps(body).encode(),
                          headers={'Authorization':'Bearer perf-test','Content-Type':'application/json'})
        with urlopen(request, timeout=300) as response:
            return response.read()
    def timed(photo, name, route, body=None):
        start = time.perf_counter()
        try:
            data = request(route,body)
            image = Image.open(BytesIO(data))
            result = dict(photo=photo['name'],source_bytes=Path(photo['path']).stat().st_size,
                          source_pixels=[photo['width'],photo['height']],operation=name,
                          seconds=round(time.perf_counter()-start,4),bytes=len(data),output=list(image.size))
        except Exception as exc:
            result=dict(photo=photo['name'],operation=name,seconds=round(time.perf_counter()-start,4),error=str(exc))
        results.append(result)
        (output/'timings.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps(result,ensure_ascii=False),flush=True)
    def edit(photo, patch):
        recipe = engine.validate_recipe({**engine.DEFAULT_RECIPE,**patch})
        request('/api/edit',{'ids':[photo['id']],'recipe':recipe})
        return recipe
    try:
        if not args.spectral_only:
            for photo in photos:
                route=f"/api/image/{photo['id']}?size=0&quality=source"
                timed(photo,'enter_native_cold',route)
                timed(photo,'enter_native_warm',route)
                timed(photo,'live_base_native',f"/api/live-base/{photo['id']}?size=0")
                for name, patch in [('exposure',{'exposure':.7}),('shadows',{'shadows':.4}),
                                    ('curves',{'curve_rgb':'[[0,0],[0.5,0.62],[1,1]]'}),
                                    ('hsl',{'temperature':.2}),('clarity',{'clarity':.3}),
                                    ('rotate',{'straighten':3}),('film_lut',{'film_stock':'kodak_gold_200','film_strength':.8})]:
                    edit(photo,patch)
                    timed(photo,name+'_native',route)
                recipe=edit(photo,{'exposure':.3})
                for style in ('film35','negative','slide','instant','film35'):
                    bordered={**recipe,'border':json.dumps({'style':style})}
                    timed(photo,'border_'+style,'/api/border-preview',{'id':photo['id'],'recipe':bordered,'preview_session':'benchmark'})
        photo=photos[0]
        spectral={'stock':'kodak_gold_200'}
        cases=[('stock',{}),('film_ev',{'film_ev':.3}),('paper_ev',{'paper_ev':.25}),
               ('filter',{'tune_m':3}),('preflash',{'preflash':'on'}),
               ('couplers',{'coupler_amount':.7}),('halation',{'halation':'on'}),
               ('grain',{'grain':'on'}),('light',{'scene_light':'D50'})]
        for index,(name, patch) in enumerate(cases):
            recipe=edit(photo,{'film_advanced':json.dumps({**spectral,**patch}),'film_strength':.8})
            if args.interactive:
                timed(photo,'spectral_'+name+'_interactive','/api/editor-preview',
                      {'id':photo['id'],'recipe':recipe,'preview_session':'spectral-perf','generation':index,'size':640})
            else:
                timed(photo,'spectral_'+name+'_native',f"/api/image/{photo['id']}?size=0&quality=source")
        recipe=edit(photo,{'film_advanced':json.dumps(spectral),'film_strength':.8})
        timed(photo,'spectral_border_film35','/api/border-preview',{'id':photo['id'],'recipe':{**recipe,'border':json.dumps({'style':'film35'})},'preview_session':'benchmark'})
        if args.interactive:
            for style in ('negative','slide','instant','film35'):
                timed(photo,'spectral_border_'+style,'/api/border-preview',{'id':photo['id'],'recipe':{**recipe,'border':json.dumps({'style':style})},'preview_session':'benchmark'})
            timed(photo,'spectral_final_native','/api/editor-preview',{'id':photo['id'],'recipe':recipe,'preview_session':'native-perf','generation':0,'size':0})
    finally:
        server.shutdown()
        server.server_close()
        engine.film_spectral.stop_worker()
        assert before == {str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in selected}, 'Source changed!'
        print('Source hashes unchanged; '+str(output/'timings.json'),flush=True)


if __name__=='__main__':
    run()
