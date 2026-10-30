"""HTTP integration with a real isolated catalog, without touching product data."""
from pathlib import Path
import importlib.util
import json
import sys
import tempfile
import threading
import unittest
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from PIL import Image

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent / 'product'))


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(importlib.util.find_spec('service'), 'Unified UI service is missing')
        import service
        self.temp = tempfile.TemporaryDirectory(dir=ROOT)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.server = service.create_server(self.root / 'data', 'test-secret', 0)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.base = f'http://127.0.0.1:{self.server.server_port}'

    def call(self, route, body=None, token='test-secret'):
        request = Request(self.base + route, data=json.dumps(body).encode() if body is not None else None,
                          headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        with urlopen(request, timeout=20) as response:
            return json.load(response)

    def wait_job(self, identity):
        import time
        for _ in range(300):
            job = self.call('/api/jobs/' + identity)
            if job['status'] != 'running': return job
            time.sleep(.02)
        self.fail('Job timed out')

    def test_album_trash_and_restore_routes_expose_recycle_bin(self):
        album = self.call('/api/albums', {'name': '回收'})
        self.assertTrue(self.call(f"/api/albums/{album['id']}/trash", {})['changed'])
        library = self.call('/api/library')
        self.assertEqual(library['albums'], [])
        self.assertEqual(library['trash_albums'][0]['id'], album['id'])
        self.assertTrue(self.call(f"/api/albums/{album['id']}/restore", {})['changed'])
        self.assertEqual(self.call('/api/library')['trash_albums'], [])

    def test_import_cancel_keeps_completed_photos_and_resumes_without_duplicates(self):
        import engine
        from unittest.mock import patch
        album = self.call('/api/albums', {'name': 'Cancelled import'})
        paths = [self.root / f'import-{index}.png' for index in range(3)]
        for path in paths: Image.new('RGB', (20, 20), 'coral').save(path)
        entered = threading.Event(); release = threading.Event(); analyze = engine.analyze; calls = []
        def controlled(path, *args, **kwargs):
            calls.append(path)
            if len(calls) == 2:
                entered.set(); release.wait(5)
            return analyze(path, *args, **kwargs)
        with patch('engine.analyze', side_effect=controlled):
            identity = self.call('/api/import', {'paths': [str(path) for path in paths], 'album_id': album['id']})['id']
            try:
                self.assertTrue(entered.wait(5))
                self.assertTrue(self.call('/api/jobs/' + identity + '/cancel', {})['cancel_requested'])
            finally: release.set()
            job = self.wait_job(identity)
        self.assertEqual(job['status'], 'cancelled', job)
        self.assertEqual(job['done'], 1); self.assertEqual(job['total'], 3)
        self.assertEqual(job['result'], {'imported': 1, 'errors': []})
        self.assertEqual(len(self.call('/api/library')['photos']), 1)
        resumed = self.wait_job(self.call('/api/import', {'paths': [str(path) for path in paths], 'album_id': album['id']})['id'])
        self.assertEqual(resumed['status'], 'done', resumed)
        self.assertEqual(resumed['result']['imported'], 2)
        self.assertEqual(len(self.call('/api/library')['photos']), 3)

    def test_import_cancel_during_directory_scan_does_not_consume_rest_of_directory(self):
        import service
        from unittest.mock import patch
        folder = self.root / 'scanning'; folder.mkdir()
        (folder / 'not-a-photo.txt').write_text('unrelated', encoding='utf-8')
        entered = threading.Event(); release = threading.Event(); next_calls = []
        real_scandir = service.os.scandir
        class ControlledScan:
            def __init__(self, path): self.entries = real_scandir(path)
            def __enter__(self): return self
            def __exit__(self, *args): self.entries.close()
            def __iter__(self): return self
            def __next__(self):
                next_calls.append(True)
                if len(next_calls) == 1:
                    entered.set(); release.wait(5)
                    return next(self.entries)
                raise AssertionError('Scan advanced again after cancellation')
        with patch('service.os.scandir', side_effect=ControlledScan):
            identity = self.call('/api/import', {'folder': str(folder)})['id']
            try:
                self.assertTrue(entered.wait(5))
                self.assertTrue(self.call('/api/jobs/' + identity + '/cancel', {})['cancel_requested'])
            finally: release.set()
            job = self.wait_job(identity)
        self.assertEqual(job['status'], 'cancelled', job)
        self.assertEqual(job['result'], {'imported': 0, 'errors': []})
        self.assertEqual(job['done'], 0); self.assertEqual(job['total'], 0)
        self.assertEqual(len(next_calls), 1)

    def test_export_rejects_empty_invalid_and_missing_photo_ids(self):
        import engine
        path = self.root / 'valid.png'; Image.new('RGB', (20, 20), 'coral').save(path)
        catalog = engine.Catalog(self.root / 'data/library.sqlite')
        catalog.import_files([path]); identity = catalog.photos()[0]['id']; catalog.close()
        for ids in ([], [True], [str(identity)], [9999], [identity, 9999], [identity, identity], str(identity)):
            with self.subTest(ids=ids):
                with self.assertRaises(HTTPError) as error:
                    self.call('/api/export', {'ids': ids, 'folder': str(self.root / 'out')})
                self.assertEqual(error.exception.code, 400)

    def test_export_album_folders_use_only_explicit_ids_and_safe_unique_names(self):
        import engine
        catalog = engine.Catalog(self.root / 'data/library.sqlite')
        self.addCleanup(catalog.close)
        albums = [catalog.create_album(name) for name in ('../CON', '../CON')]
        paths = [self.root / name for name in ('one.png', 'two.png', 'excluded.png')]
        for path in paths: Image.new('RGB', (20, 20), 'coral').save(path)
        catalog.import_files(paths, album_id=albums[0]['id'])
        catalog.import_files([paths[1]], album_id=albums[1]['id'])
        ids = [photo['id'] for photo in catalog.photos() if photo['name'] != 'excluded.png']
        folder = self.root / 'exports'
        job = self.wait_job(self.call('/api/export', {'ids': ids, 'folder': str(folder), 'folder_mode': 'album',
            'album_ids': [a['id'] for a in reversed(albums)], 'format': 'png'})['id'])
        self.assertEqual(job['status'], 'done', job)
        outputs = [Path(path) for path in job['result']['outputs']]
        self.assertEqual(len(outputs), 2)
        self.assertEqual(len({path.parent.name for path in outputs}), 2)
        self.assertTrue(next(path for path in outputs if path.name.startswith('two_')).parent.name.endswith('_' + str(albums[1]['id'])))
        for path in outputs:
            self.assertEqual(path.parent.parent, folder)
            self.assertNotIn('excluded', path.name)
            self.assertNotIn('..', path.parent.name)

    def test_export_cancel_preserves_finished_file_and_stops_current_and_later_photos(self):
        import engine
        from unittest.mock import patch
        catalog = engine.Catalog(self.root / 'data/library.sqlite')
        self.addCleanup(catalog.close)
        paths = [self.root / f'cancel-{index}.png' for index in range(3)]
        for path in paths: Image.new('RGB', (20, 20), 'coral').save(path)
        catalog.import_files(paths)
        ids = [photo['id'] for photo in catalog.photos()]
        entered = threading.Event(); release = threading.Event(); real_export = engine.export_photo
        calls = []
        def export(*args, **kwargs):
            calls.append(args[0]['id'])
            if len(calls) == 2:
                entered.set(); release.wait(5)
            return real_export(*args, **kwargs)
        with patch('engine.export_photo', side_effect=export):
            identity = self.call('/api/export', {'ids': ids, 'folder': str(self.root / 'cancel-output'), 'format': 'png'})['id']
            self.assertTrue(entered.wait(5))
            try:
                cancelled = self.call('/api/jobs/' + identity + '/cancel', {})
                self.assertTrue(cancelled['cancel_requested'])
            finally: release.set()
            job = self.wait_job(identity)
        self.assertEqual(job['status'], 'cancelled', job)
        self.assertEqual(len(calls), 2)
        self.assertEqual(len(job['result']['outputs']), 1)
        self.assertEqual(len(list((self.root / 'cancel-output').glob('*.png'))), 1)
        self.assertEqual(job['result']['errors'], [])
        self.assertEqual(self.call('/api/jobs/' + identity + '/cancel', {})['status'], 'cancelled')

    def test_unauthenticated_requests_cannot_read_catalog(self):
        with self.assertRaises(HTTPError) as error:
            self.call('/api/library', token='wrong')
        self.assertEqual(error.exception.code, 401)

    def test_source_display_is_lossless_full_resolution_and_not_limited_to_2400(self):
        import engine
        from io import BytesIO
        path=self.root/'large.png';im=Image.new('RGB',(3100,200),'#08172a');im.putpixel((3000,100),(17,39,99));im.save(path)
        catalog=engine.Catalog(self.root/'data'/'library.sqlite');catalog.import_files([path]);identity=catalog.photos()[0]['id'];catalog.close()
        request=Request(self.base+f'/api/image/{identity}?size=0&quality=source',headers={'Authorization':'Bearer test-secret'})
        with urlopen(request) as response:
            self.assertEqual(response.headers['Content-Type'],'image/png');actual=Image.open(BytesIO(response.read()));actual.load()
        self.assertEqual(actual.size,(3100,200));self.assertEqual(actual.getpixel((3000,100)),(17,39,99))

    def test_original_comparison_preserves_geometry_and_crop_authoring_can_read_uncropped(self):
        import engine
        from io import BytesIO
        path=self.root/'geometry.png';Image.new('RGB',(80,40),(80,100,120)).save(path)
        catalog=engine.Catalog(self.root/'data'/'library.sqlite');catalog.import_files([path]);identity=catalog.photos()[0]['id']
        catalog.edit([identity],recipe_patch={'quarter_turns':1,'crop_x':.25,'crop_y':.25,'crop_w':.5,'crop_h':.5,'exposure':1});catalog.close()
        def read(query):
            with urlopen(Request(self.base+f'/api/image/{identity}?quality=source&size=0&'+query,headers={'Authorization':'Bearer test-secret'})) as response:
                image=Image.open(BytesIO(response.read()));image.load();return image
        edited=read('original=0');original=read('original=1');uncropped=read('uncropped=1')
        self.assertEqual(edited.size,(20,40));self.assertEqual(original.size,edited.size);self.assertEqual(original.getpixel((0,0)),(80,100,120));self.assertEqual(uncropped.size,(40,80))

    def test_preview_cleanup_failure_always_releases_shared_waiters(self):
        from unittest.mock import patch
        path=self.root/'cleanup.png';Image.new('RGB',(32,24),'coral').save(path)
        with patch('service.os.replace',side_effect=PermissionError('busy target')),patch.object(Path,'unlink',side_effect=PermissionError('busy temporary')):
            with self.assertRaises(PermissionError):self.server.preview({'path':str(path),'recipe':{}},120,False)
        self.assertFalse(self.server.preview_flights,'Cleanup failure leaked a preview flight')

    def test_import_edit_preview_and_export(self):
        import time
        path = self.root / '中文 photo.jpg'
        Image.new('RGB', (600, 400), 'coral').save(path)
        result = self.call('/api/import', {'paths': [str(path)]})
        for _ in range(150):
            job = self.call('/api/jobs/' + result['id'])
            if job['status'] in ('done', 'error'):
                break
            time.sleep(.02)
        self.assertEqual(job['status'], 'done', job)
        library = self.call('/api/library')
        photo = library['photos'][0]
        self.call('/api/edit', {'ids': [photo['id']], 'recipe': {'style': 'mono'}, 'decision': 'keep'})
        saved = self.call('/api/library')['photos'][0]
        self.assertEqual(saved['recipe']['style'], 'mono')
        with urlopen(Request(self.base + f'/api/image/{photo["id"]}?size=300', headers={'Authorization': 'Bearer test-secret'})) as response:
            self.assertEqual(response.headers['Content-Type'], 'image/jpeg')
            self.assertGreater(len(response.read()), 100)
        with self.assertRaises(HTTPError) as error:
            self.call('/api/image/9999?size=300')
        self.assertEqual(error.exception.code, 404)

    def test_single_edit_returns_exact_canonical_recipe_acknowledgement(self):
        import engine
        path = self.root / 'ack.png'
        Image.new('RGB', (32, 24), 'coral').save(path)
        catalog = engine.Catalog(self.root / 'data' / 'library.sqlite')
        catalog.import_files([path])
        identity = catalog.photos()[0]['id']
        catalog.close()
        first = self.call('/api/edit', {'ids': [identity], 'recipe': {'exposure': 1, 'quarter_turns': 1}})
        self.call('/api/edit', {'ids': [identity], 'recipe': {'exposure': 2, 'quarter_turns': 2}})
        self.assertEqual(first['recipes'][str(identity)]['exposure'], 1)
        self.assertEqual(first['recipes'][str(identity)]['quarter_turns'], 1)
        self.assertEqual(first['recipes'][str(identity)]['crop_w'], 1)

    def test_untrusted_origin_is_rejected_even_with_token(self):
        request = Request(self.base + '/api/library', headers={'Origin': 'https://example.com', 'Authorization': 'Bearer test-secret'})
        with self.assertRaises(HTTPError) as error:
            urlopen(request)
        self.assertEqual(error.exception.code, 403)

    def test_album_import_analysis_and_composite_round_trip(self):
        import time
        album = self.call('/api/albums', {'name': '旅行图集'})
        path = self.root / 'photo.png'
        Image.new('RGB', (160, 120), '#de3f20').save(path)
        def wait(result):
            for _ in range(300):
                job = self.call('/api/jobs/' + result['id'])
                if job['status'] != 'running':
                    self.assertEqual(job['status'], 'done', job)
                    return job
                time.sleep(.02)
            self.fail('Job timed out')
        wait(self.call('/api/import', {'folder': str(self.root), 'album_id': album['id']}))
        library = self.call('/api/library')
        photo = library['photos'][0]
        self.assertEqual(photo['album_ids'], [album['id']])
        self.assertEqual(library['albums'][0]['count'], 1)
        wait(self.call('/api/analyze', {'ids': [photo['id']], 'semantic': False}))
        doc = dict(name='合成', width=160, height=120, album_id=album['id'], layers=[dict(photo_id=photo['id'])])
        saved = self.call('/api/composites', doc)
        self.assertEqual(self.call('/api/library')['composites'][0]['id'], saved['id'])
        request = Request(self.base + '/api/composite-preview', data=json.dumps(saved).encode(),
                          headers={'Authorization': 'Bearer test-secret', 'Content-Type': 'application/json'})
        with urlopen(request) as response:
            self.assertEqual(response.headers['Content-Type'], 'image/png')
            from io import BytesIO
            image = Image.open(BytesIO(response.read()))
            self.assertEqual(image.size, (160, 120))
        wait(self.call('/api/composite-export', {'document': saved, 'folder': str(self.root / 'export')}))
        self.assertEqual(len(list((self.root / 'export').glob('*.png'))), 1)

    def test_preview_cache_reuses_pixels_and_invalidates_after_edit_and_source_change(self):
        import engine
        from unittest.mock import patch
        path=self.root/'preview.jpg';Image.new('RGB',(1200,800),'coral').save(path)
        catalog=engine.Catalog(self.root/'data'/'library.sqlite')
        self.addCleanup(catalog.close)
        catalog.import_files([path]);identity=catalog.photos()[0]['id']
        def read(original=False):
            request=Request(self.base+f'/api/image/{identity}?size=300&original={int(original)}',headers={'Authorization':'Bearer test-secret'})
            with urlopen(request) as response:return response.read()
        with patch.object(engine,'render_image',wraps=engine.render_image) as render:
            first=read();self.assertEqual(first,read());self.assertEqual(render.call_count,1)
            catalog.edit([identity],recipe={'style':'mono'})
            changed=read();self.assertNotEqual(first,changed);self.assertEqual(render.call_count,2)
            read(True);self.assertEqual(render.call_count,2)  # Reuses the neutral source preview.
            Image.new('RGB',(600,400),'blue').save(path)
            self.assertNotEqual(changed,read());self.assertEqual(render.call_count,3)

    def test_failed_preview_is_shared_and_new_source_can_retry(self):
        import engine
        from unittest.mock import patch
        from concurrent.futures import ThreadPoolExecutor
        path=self.root/'failure.jpg';Image.new('RGB',(1200,800),'coral').save(path)
        catalog=engine.Catalog(self.root/'data'/'library.sqlite');self.addCleanup(catalog.close)
        catalog.import_files([path]);identity=catalog.photos()[0]['id']
        def read():
            try:
                with urlopen(Request(self.base+f'/api/image/{identity}?size=300',headers={'Authorization':'Bearer test-secret'})) as r:return r.status
            except HTTPError as error:return error.code
        with patch.object(engine,'render_image',side_effect=RuntimeError('decoder failed')) as render:
            with ThreadPoolExecutor(3) as executor:self.assertEqual(list(executor.map(lambda _:read(),range(3))),[500]*3)
            self.assertEqual(render.call_count,1)
        Image.new('RGB',(500,300),'blue').save(path)
        self.assertEqual(read(),200)


if __name__ == '__main__':
    unittest.main(verbosity=2)
