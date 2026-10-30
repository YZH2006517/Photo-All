# SPDX-License-Identifier: GPL-3.0-or-later
"""Private loopback bridge between the desktop webview and the existing engine."""
import argparse
from collections import OrderedDict
import hashlib
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import json
import copy
import re
from pathlib import Path
import secrets
import os
import threading
import sqlite3
from contextlib import closing
from urllib.parse import parse_qs, urlsplit

import engine
import workflow
import film
import open_filters

ORIGINS = {'http://127.0.0.1:1420', 'http://localhost:1420', 'http://tauri.localhost', 'tauri://localhost', 'https://tauri.localhost'}


def import_paths(folder, cancellation):
    """Stream directory entries; cancellation never waits for a full tree listing."""
    pending = [Path(folder)]
    while pending:
        cancellation.check()
        with os.scandir(pending.pop()) as entries:
            for entry in entries:
                cancellation.check()
                if entry.is_dir(follow_symlinks=False):
                    pending.append(Path(entry.path))
                elif Path(entry.name).suffix.lower() in engine.SUPPORTED and entry.is_file():
                    yield entry.path


class StudioServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, data_dir, token):
        self.data_dir = Path(data_dir).resolve()
        self.token = token
        self.jobs = {}
        self.cancellations = {}
        self.lock = threading.Lock()
        self.worker = ThreadPoolExecutor(max_workers=1)
        self.preview_lock = threading.Lock()
        self.preview_slots = threading.Semaphore(2)
        self.previews = OrderedDict()
        self.preview_bytes = 0
        self.preview_flights = {}
        self.preview_failures = OrderedDict()
        self.preview_pruned = 0
        self.preview_dir = self.data_dir / 'previews'
        self.preview_dir.mkdir(parents=True, exist_ok=True)
        self.preview_version = tuple(p.stat().st_mtime_ns for p in [Path(engine.__file__),Path(__file__),Path(film.__file__),Path(open_filters.__file__),Path(engine.__file__).with_name('pixels.py')])
        engine.RAW_CACHE = self.data_dir / 'raw-cache'
        engine.Catalog(self.data_dir / 'library.sqlite').close()
        super().__init__(address, Handler)

    def server_close(self):
        super().server_close()
        self.worker.shutdown(wait=True, cancel_futures=True)

    def submit(self, action, cancellable=False):
        identity = secrets.token_hex(8)
        cancellation = engine.CancellationToken()
        job = {'id': identity, 'status': 'running', 'done': 0, 'total': 0,
               'cancel_requested': False, 'cancellable': cancellable}
        with self.lock:
            self.jobs[identity] = job
            if cancellable: self.cancellations[identity] = cancellation
        def progress(done, total):
            with self.lock:
                job.update(done=done, total=total)
        def work():
            try:
                result = action(progress, cancellation) if cancellable else action(progress)
                with self.lock:
                    job.update(status='cancelled' if job['cancel_requested'] else 'done', result=result)
            except engine.ExportCancelled:
                with self.lock:
                    job.update(status='cancelled', result={'outputs': [], 'errors': []})
            except Exception as exc:
                with self.lock:
                    job.update(status='cancelled' if job['cancel_requested'] else 'error', error=str(exc))
            finally:
                with self.lock:
                    self.cancellations.pop(identity, None)
        self.worker.submit(work)
        return {'id': identity}

    def cancel_job(self, identity):
        with self.lock:
            job = self.jobs.get(identity)
            if job is None: return None
            if job['status'] == 'running':
                if not job['cancellable']: raise ValueError('此任务不支持取消')
                job['cancel_requested'] = True
                self.cancellations[identity].cancel()
            return copy.deepcopy(job)

    def preview(self, photo, size, original, quality='preview',uncropped=False):
        import time
        stat = Path(photo['path']).stat()
        geometry=('quarter_turns','flip_x','flip_y','straighten','crop_x','crop_y','crop_w','crop_h')
        recipe=engine.validate_recipe({**{key:photo['recipe'].get(key,engine.DEFAULT_RECIPE[key]) for key in geometry}} if original else photo['recipe'])
        if uncropped:recipe.update(crop_x=0,crop_y=0,crop_w=1,crop_h=1)
        raw_identity = None
        if Path(photo['path']).suffix.lower() in engine.RAW:
            executable = engine.raw_executable()
            if executable:
                executable_stat = executable.stat()
                raw_identity = [str(executable), executable_stat.st_mtime_ns, executable_stat.st_size]
        film_identity = None
        if recipe['film_stock'] != 'none':
            asset = film.LUTS / (recipe['film_stock'] + '.npy')
            film_identity = [film.REVISION, asset.stat().st_mtime_ns if asset.exists() else None]
        filter_identity = None
        if recipe['filter_id'] != 'none':
            asset = open_filters.asset_path(recipe['filter_id'])
            filter_identity = [open_filters.REVISION, asset.stat().st_mtime_ns if asset.exists() else None,
                               open_filters.manifest()['items'][recipe['filter_id']]['sha256']]
        key = hashlib.sha256(json.dumps([self.preview_version, photo['path'], stat.st_mtime_ns,
            stat.st_size, size, quality, recipe, raw_identity, film_identity, filter_identity], sort_keys=True).encode()).hexdigest()
        lossless=quality=='source'
        path = self.preview_dir / (key + ('.png' if lossless else '.jpg'))
        def cached():
            with self.preview_lock:
                value = self.previews.pop(key, None)
                if value is not None:
                    self.previews[key] = value
                    return value
            try:
                return path.read_bytes()
            except FileNotFoundError:
                return None
        def remember(value):
            with self.preview_lock:
                if key not in self.previews:
                    self.previews[key] = value
                    self.preview_bytes += len(value)
                    while self.preview_bytes > 32 * 1024 * 1024:
                        _, old = self.previews.popitem(last=False)
                        self.preview_bytes -= len(old)
            return value
        while True:
            value = cached()
            if value is not None:
                return remember(value)
            with self.preview_lock:
                failed = self.preview_failures.get(key)
                if failed and time.monotonic() - failed[0] < 2:
                    raise RuntimeError(failed[1])
                self.preview_failures.pop(key,None)
                event = self.preview_flights.get(key)
                owner = event is None
                if owner:
                    event = threading.Event()
                    self.preview_flights[key] = event
            if owner:
                break
            if not event.wait(190):
                raise TimeoutError('Preview processing timed out')
        temporary = None
        try:
            # Shared requests wait without using a decode slot. At most two full images live here.
            with self.preview_slots:
                value = cached()
                if value is not None:
                    return remember(value)
                image = engine.render_image(photo['path'], recipe, (size, size) if size else None)
                output = BytesIO()
                if lossless:image.save(output,format='PNG',compress_level=3,icc_profile=engine.SRGB)
                else:image.save(output, format='JPEG', quality=88, icc_profile=engine.SRGB)
                value = output.getvalue()
                import tempfile
                with tempfile.NamedTemporaryFile(dir=self.preview_dir, suffix='.tmp', delete=False) as stream:
                    temporary = Path(stream.name)
                    stream.write(value)
                os.replace(temporary, path)
                self.prune_previews()
                return remember(value)
        except Exception as exc:
            with self.preview_lock:
                self.preview_failures[key] = (time.monotonic(), str(exc))
                while len(self.preview_failures) > 64:
                    self.preview_failures.popitem(last=False)
            raise
        finally:
            try:
                if temporary:temporary.unlink(missing_ok=True)
            finally:
                # Windows may retain a temporary file. Never strand consumers
                # behind its cleanup failure; they must observe success/error.
                with self.preview_lock:
                    self.preview_flights.pop(key, None)
                    event.set()

    def prune_previews(self):
        import time
        with self.preview_lock:
            if time.monotonic() - self.preview_pruned < 30:
                return
            self.preview_pruned = time.monotonic()
        files = []
        for path in self.preview_dir.iterdir():
            if path.suffix not in {'.jpg','.png'}:continue
            try:
                files.append((path.stat().st_mtime_ns, path.stat().st_size, path))
            except FileNotFoundError:
                pass
        total = 0
        for _, size, path in sorted(files, reverse=True):
            total += size
            if total > 256 * 1024 * 1024:
                path.unlink(missing_ok=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # Keep stdout reserved for the desktop startup handshake.

    def allowed(self, preflight=False):
        host = self.headers.get('Host', '').split(':')[0]
        if host not in {'127.0.0.1', 'localhost'}:
            self.reply({'error': 'Invalid host'}, 403)
            return False
        origin = self.headers.get('Origin')
        if origin and origin not in ORIGINS:
            self.reply({'error': 'Origin not allowed'}, 403)
            return False
        if not preflight and not secrets.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + self.server.token):
            self.reply({'error': 'Session authentication required'}, 401)
            return False
        return True

    def reply(self, value, status=200, content_type='application/json'):
        data = value if isinstance(value, bytes) else json.dumps(value, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        origin = self.headers.get('Origin')
        if origin in ORIGINS:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        self.send_header('Content-Type', content_type)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass  # A newer preview request may have replaced this one.

    def do_OPTIONS(self):
        if self.allowed(preflight=True):
            self.send_response(204)
            self.send_header('Access-Control-Allow-Origin', self.headers.get('Origin', 'http://127.0.0.1:1420'))
            self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Content-Length', '0')
            self.end_headers()

    def do_GET(self):
        self.handle_api()

    def do_POST(self):
        self.handle_api()

    def library(self):
        catalog = engine.Catalog(self.server.data_dir / 'library.sqlite')
        try:
            return {'photos': catalog.photos(), 'albums': catalog.albums(), 'trash_albums': catalog.trash_albums(), 'composites': catalog.composites(), 'history': catalog.history_state(), 'film': film.catalog(),
                    'filters': open_filters.catalog(),
                    'recognition': workflow.recognition_status(), 'capabilities': engine.capabilities(), 'styles': engine.STYLES,
                    'templates': engine.TEMPLATES, 'defaults': engine.DEFAULT_RECIPE}
        finally:
            catalog.close()

    def handle_api(self):
        if not self.allowed():
            return
        route = urlsplit(self.path)
        try:
            body = {}
            if self.command == 'POST':
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 2 * 1024 * 1024:
                    raise ValueError('请求过大或为空')
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError('请求必须为对象')
            if route.path == '/api/library' and self.command == 'GET':
                return self.reply(self.library())
            if re.fullmatch(r'/api/jobs/[^/]+/cancel', route.path) and self.command == 'POST':
                job = self.server.cancel_job(route.path.split('/')[-2])
                return self.reply(job or {'error': '任务不存在'}, 200 if job else 404)
            if route.path.startswith('/api/jobs/') and self.command == 'GET':
                with self.server.lock:
                    job = copy.deepcopy(self.server.jobs.get(route.path.rsplit('/', 1)[1], {}))
                return self.reply(job or {'error': '任务不存在'}, 200 if job else 404)
            if (route.path.startswith('/api/image/') or route.path.startswith('/api/filter-preview/')) and self.command == 'GET':
                identity = int(route.path.rsplit('/', 1)[1])
                with closing(sqlite3.connect((self.server.data_dir / 'library.sqlite').as_uri() + '?mode=ro', uri=True)) as database:
                    database.row_factory = sqlite3.Row
                    row = database.execute('SELECT id,path,recipe FROM photos WHERE id=?', (identity,)).fetchone()
                    photo = dict(row) if row else None
                    if photo: photo['recipe'] = json.loads(photo['recipe'])
                if not photo:
                    return self.reply({'error': '照片不存在'}, 404)
                query = parse_qs(route.query)
                if route.path.startswith('/api/filter-preview/'):
                    identity=query.get('filter_id',['none'])[0]
                    recipe={**photo['recipe'],'filter_id':'none','filter_strength':1}
                    if identity.startswith('style:'):
                        style=identity[6:]
                        if style not in engine.STYLES:raise ValueError('未知风格')
                        recipe['style']=style
                    else:
                        if identity!='none' and not open_filters.known(identity):raise ValueError('未知开放滤镜')
                        recipe.update(style='natural',filter_id=identity)
                    photo={**photo,'recipe':engine.validate_recipe(recipe)}
                    size=min(480,max(120,int(query.get('size',['240'])[0])))
                    return self.reply(self.server.preview(photo,size,False),content_type='image/jpeg')
                quality=query.get('quality',['preview'])[0]
                if quality not in {'source','preview'}:raise ValueError('显示质量无效')
                requested=int(query.get('size',['1200'])[0])
                size=0 if quality=='source' and requested==0 else min(16384 if quality=='source' else 2400,max(120,requested))
                return self.reply(self.server.preview(photo,size,query.get('original')==['1'],quality,query.get('uncropped')==['1']),content_type='image/png' if quality=='source' else 'image/jpeg')
            if route.path == '/api/albums' and self.command == 'POST':
                catalog = engine.Catalog(self.server.data_dir / 'library.sqlite')
                try:
                    return self.reply(catalog.create_album(body.get('name')))
                finally:
                    catalog.close()
            if re.fullmatch(r'/api/albums/\d+/(trash|restore)', route.path) and self.command == 'POST':
                catalog = engine.Catalog(self.server.data_dir / 'library.sqlite')
                try:
                    identity = int(route.path.split('/')[-2])
                    changed = catalog.trash_album(identity) if route.path.endswith('/trash') else catalog.restore_album(identity)
                    return self.reply({'changed': changed})
                finally:
                    catalog.close()
            if route.path=='/api/remove' and self.command=='POST':
                catalog=engine.Catalog(self.server.data_dir/'library.sqlite')
                try:return self.reply({'changed':catalog.remove_photos(body.get('ids'),body.get('album_id'),body.get('album_ids')),'history':catalog.history_state()})
                finally:catalog.close()
            if route.path == '/api/analyze' and self.command == 'POST':
                ids = body.get('ids')
                if not isinstance(ids, list) or not all(type(i) is int for i in ids):
                    raise ValueError('照片 ID 列表无效')
                semantic = bool(body.get('semantic'))
                if semantic and not workflow.recognition_status()['ready']:
                    raise ValueError('本地识图模型未就绪，请参阅 README 安装识图引擎')
                def action(progress):
                    catalog = engine.Catalog(self.server.data_dir / 'library.sqlite')
                    errors, count = [], 0
                    try:
                        photos = [p for p in catalog.photos() if p['id'] in ids]
                        for i, photo in enumerate(photos):
                            try:
                                image = engine.render_image(photo['path'], {}, (640, 640))
                                features = workflow.visual_features(image)
                                features['content'] = workflow.classify(image) if semantic else photo['features'].get('content')
                                catalog.save_features(photo['id'], features)
                                count += 1
                            except Exception as exc:
                                errors.append({'name': photo['name'], 'error': str(exc)})
                            progress(i + 1, len(photos))
                        return {'analyzed': count, 'errors': errors}
                    finally:
                        catalog.close()
                return self.reply(self.server.submit(action))
            if route.path in {'/api/composites', '/api/composite-preview', '/api/composite-export'} and self.command == 'POST':
                catalog = engine.Catalog(self.server.data_dir / 'library.sqlite')
                try:
                    photos = catalog.photos(include_hidden=True)
                    if route.path == '/api/composites':
                        return self.reply(catalog.save_composite(body))
                    if route.path == '/api/composite-preview':
                        output = BytesIO()
                        workflow.render_composite(body, photos, max_size=1200).save(output, format='PNG', icc_profile=engine.SRGB)
                        return self.reply(output.getvalue(), content_type='image/png')
                    document = workflow.validate_composite(body.get('document'), photos)
                    folder = body.get('folder')
                    if not isinstance(folder, str) or not folder:
                        raise ValueError('请选择导出目录')
                    def action(progress):
                        image = workflow.render_composite_pixels(document, photos)
                        destination = Path(folder).resolve()
                        destination.mkdir(parents=True, exist_ok=True)
                        # Fixed safe stem: project names never become filesystem paths.
                        suffix = 0
                        while True:
                            target = destination / ('photoall_composite' + (f'_{suffix}' if suffix else '') + '.png')
                            try:
                                stream = target.open('xb')
                                break
                            except FileExistsError:
                                suffix += 1
                        try:
                            with stream:
                                import pixels
                                pixels.write(stream,image,'png16')
                        except Exception:
                            target.unlink(missing_ok=True)
                            raise
                        progress(1, 1)
                        return {'outputs': [str(target)], 'errors': []}
                    return self.reply(self.server.submit(action))
                finally:
                    catalog.close()
            if route.path == '/api/import' and self.command == 'POST':
                paths = body.get('paths', [])
                folder = body.get('folder')
                if not isinstance(paths, list) or not all(isinstance(p, str) for p in paths):
                    raise ValueError('照片路径必须是列表')
                if folder is not None and not isinstance(folder, str):
                    raise ValueError('文件夹路径无效')
                def action(progress, cancellation):
                    files = import_paths(folder, cancellation) if folder else paths
                    catalog = engine.Catalog(self.server.data_dir / 'library.sqlite')
                    try:
                        rows, errors = catalog.import_files(files, progress, album_id=body.get('album_id'), cancel=cancellation)
                        return {'imported': len(rows), 'errors': errors}
                    finally:
                        catalog.close()
                return self.reply(self.server.submit(action, cancellable=True))
            if route.path in {'/api/edit', '/api/undo', '/api/redo'} and self.command == 'POST':
                catalog = engine.Catalog(self.server.data_dir / 'library.sqlite')
                recipes = None
                try:
                    if route.path.endswith('undo'):
                        changed = catalog.undo()
                    elif route.path.endswith('redo'):
                        changed = catalog.redo()
                    else:
                        ids = body.get('ids', [])
                        if not isinstance(ids, list) or not all(type(i) is int for i in ids):
                            raise ValueError('照片 ID 列表无效')
                        if not ('recipe' in body or 'decision' in body or 'recipe_patch' in body):
                            raise ValueError('未提供修改内容')
                        changed = catalog.edit(ids, recipe=body.get('recipe'), decision=body.get('decision'), recipe_patch=body.get('recipe_patch'))
                        if len(ids) == 1 and ('recipe' in body or 'recipe_patch' in body):
                            recipes = {str(p['id']): p['recipe'] for p in catalog.photos() if p['id'] == ids[0]}
                    history = catalog.history_state()
                finally:
                    catalog.close()
                return self.reply({'changed': changed, 'history': history, **({'recipes': recipes} if recipes is not None else {})})
            if route.path == '/api/export' and self.command == 'POST':
                ids = body.get('ids')
                if (not isinstance(ids, list) or not ids or not all(type(i) is int and i > 0 for i in ids)
                        or len(set(ids)) != len(ids)):
                    raise ValueError('请提供不重复的非空照片 ID 列表')
                folder = body.get('folder')
                if not isinstance(folder, str) or not folder:
                    raise ValueError('请选择导出目录')
                library = self.library()
                available = {p['id']: p for p in library['photos']}
                if not set(ids) <= available.keys(): raise ValueError('所选照片不存在或不可导出')
                photos = [available[identity] for identity in ids]
                folder_mode = body.get('folder_mode', 'single')
                if folder_mode not in {'single', 'album'}: raise ValueError('导出目录模式无效')
                albums = {album['id']: album for album in library['albums']}
                scope = body.get('album_ids')
                if scope is not None and (not isinstance(scope, list) or not scope or
                        not all(type(identity) is int for identity in scope) or len(set(scope)) != len(scope)
                        or not set(scope) <= albums.keys()): raise ValueError('图集范围无效')
                scope = scope if scope is not None else list(albums)
                tasks = []
                for photo in photos:
                    if folder_mode == 'single':
                        tasks.append((photo, folder))
                    else:
                        identity = next((identity for identity in scope if identity in photo['album_ids']), None)
                        if identity is None:
                            tasks.append((photo, str(Path(folder) / '未归档照片')))
                        else:
                            name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', albums[identity]['name']).replace('..', '_').strip(' .')[:70] or '图集'
                            # Prefix avoids Windows device names, suffix separates identical names.
                            tasks.append((photo, str(Path(folder) / f'album_{name}_{identity}')))
                template, size = body.get('template', 'plain'), int(body.get('size', 2400))
                format=body.get('format','jpeg')
                if format not in {'jpeg','png','tiff','webp','original','tiff16'}:raise ValueError('未知导出格式')
                raw16 = format == 'tiff16'
                if template not in engine.TEMPLATES or (size != 0 and not 300 <= size <= 12000): raise ValueError('导出规格无效')
                def action(progress, cancellation):
                    outputs, errors = [], []
                    progress(0, len(tasks))
                    for i, (photo, destination) in enumerate(tasks):
                        try:
                            cancellation.check()
                            output = engine.export_raw_tiff(photo, destination, cancellation=cancellation) if raw16 else engine.export_photo(photo, destination, template, size, format, cancellation=cancellation)
                            outputs.append(str(output))
                        except engine.ExportCancelled:
                            break
                        except Exception as exc:
                            errors.append({'name': photo['name'], 'error': str(exc)})
                        progress(i + 1, len(tasks))
                    return {'outputs': outputs, 'errors': errors}
                return self.reply(self.server.submit(action, cancellable=True))
            self.reply({'error': '接口不存在'}, 404)
        except (ValueError, TypeError, KeyError, json.JSONDecodeError) as exc:
            self.reply({'error': str(exc)}, 400)
        except Exception as exc:
            self.reply({'error': str(exc)}, 500)


def create_server(data_dir, token, port=0):
    return StudioServer(('127.0.0.1', port), data_dir, token)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', type=Path, default=Path(__file__).parent / 'data')
    parser.add_argument('--port', type=int, default=0)
    args = parser.parse_args()
    import os
    token = os.environ.get('PHOTOALL_SESSION_TOKEN') or secrets.token_urlsafe(32)
    server = create_server(args.data_dir, token, args.port)
    print(json.dumps({'port': server.server_port, 'token': token}), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
