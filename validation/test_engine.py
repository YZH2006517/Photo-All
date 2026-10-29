"""Behavior checks; generated photos and outputs live only in temporary folders."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
import os

from PIL import Image

PRODUCT = Path(__file__).resolve().parents[1] / 'product'
sys.path.insert(0, str(PRODUCT))


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(importlib.util.find_spec('engine'), 'Product engine has not been implemented')
        import engine
        self.engine = engine
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.catalog = engine.Catalog(self.root / 'library.sqlite')
        self.addCleanup(self.catalog.close)

    def photo(self, name, color='coral'):
        path = self.root / name
        Image.new('RGB', (180, 120), color).save(path)
        return path

    def test_album_trash_restore_and_expiry_preserve_original_and_shared_photo(self):
        from unittest.mock import patch
        path = self.photo('trash-shared.png'); original = path.read_bytes()
        import time
        now = time.time()
        a, b = [self.catalog.create_album(name)['id'] for name in ('A', 'B')]
        for album in (a, b): self.catalog.import_files([path], album_id=album)
        with patch('engine.time.time', return_value=now):
            self.assertTrue(self.catalog.trash_album(a))
            self.assertFalse(self.catalog.trash_album(a))
        self.assertEqual([album['id'] for album in self.catalog.albums()], [b])
        trashed = self.catalog.trash_albums()[0]
        self.assertEqual(trashed['purge_at'], now + 30 * 86400)
        with self.assertRaises(ValueError): self.catalog.import_files([path], album_id=a)
        self.assertTrue(self.catalog.restore_album(a))
        self.assertEqual(set(self.catalog.photos()[0]['album_ids']), {a, b})
        with patch('engine.time.time', return_value=now): self.catalog.trash_album(a)
        with patch('engine.time.time', return_value=now + 30 * 86400):
            self.assertEqual(self.catalog.trash_albums(), [])
        self.assertEqual(self.catalog.photos()[0]['album_ids'], [b])
        self.assertEqual(path.read_bytes(), original)
        with self.assertRaises(ValueError): self.catalog.restore_album(a)

    def test_undo_membership_cannot_recreate_trashed_or_purged_album(self):
        from unittest.mock import patch
        path = self.photo('history-trash.png')
        album = self.catalog.create_album('A')['id']
        self.catalog.import_files([path], album_id=album)
        identity = self.catalog.photos()[0]['id']
        self.catalog.remove_photos([identity], album_id=album)
        self.catalog.trash_album(album)
        self.assertTrue(self.catalog.undo())
        self.assertEqual(list(self.catalog.db.execute('SELECT * FROM album_photos')), [])

    def test_expired_album_identity_cannot_be_reused_by_old_history(self):
        from unittest.mock import patch
        path = self.photo('id-reuse.png')
        old = self.catalog.create_album('Old')['id']
        self.catalog.import_files([path], album_id=old)
        identity = self.catalog.photos()[0]['id']
        self.catalog.remove_photos([identity], album_id=old)
        self.catalog.trash_album(old)
        with patch('engine.time.time', return_value=10**12): self.catalog.trash_albums()
        new = self.catalog.create_album('New')['id']
        self.assertNotEqual(old, new)
        self.catalog.undo()
        self.assertEqual(self.catalog.photos()[0]['album_ids'], [])
        self.catalog.redo()
        with patch('engine.time.time', return_value=10**12): self.catalog.trash_albums()
        self.catalog.undo()
        self.assertEqual(list(self.catalog.db.execute('SELECT * FROM album_photos')), [])

    def test_running_import_does_not_add_more_members_after_album_is_trashed(self):
        album = self.catalog.create_album('Importing')['id']
        paths = [self.photo('import-first.png'), self.photo('import-second.png')]
        def progress(done, total):
            if done == 1: self.catalog.trash_album(album)
        rows, errors = self.catalog.import_files(paths, progress, album)
        self.assertEqual(len(errors), 1)
        self.assertEqual(self.catalog.trash_albums()[0]['count'], 1)
        self.assertTrue(all(path.exists() for path in paths))

    def test_export_cancellation_cleans_current_file_and_preserves_finished_output(self):
        from unittest.mock import patch
        self.catalog.import_files([self.photo('cancel.png')])
        photo = self.catalog.photos()[0]; folder = self.root / 'export'
        completed = self.engine.export_photo(photo, folder, format='png')
        cancellation = self.engine.CancellationToken()
        import pixels
        real_write = pixels.write
        def cancel_after_write(*args, **kwargs):
            real_write(*args, **kwargs)
            cancellation.cancel()
        with patch('pixels.write', side_effect=cancel_after_write), self.assertRaises(self.engine.ExportCancelled):
            self.engine.export_photo(photo, folder, format='png', cancellation=cancellation)
        self.assertTrue(completed.exists())
        self.assertEqual(sorted(path.name for path in folder.iterdir()), sorted([completed.name, completed.with_suffix('.recipe.json').name]))

    def test_cancellation_terminates_active_decoder_subprocess(self):
        import threading
        import time
        cancellation = self.engine.CancellationToken()
        timer = threading.Timer(.2, cancellation.cancel)
        timer.start(); self.addCleanup(timer.cancel)
        started = time.monotonic()
        with self.assertRaises(self.engine.ExportCancelled):
            cancellation.run([sys.executable, '-c', 'import time; time.sleep(30)'], timeout=60)
        self.assertLess(time.monotonic() - started, 5)

    def test_cancellation_during_metadata_drops_current_photo_and_sidecar(self):
        from unittest.mock import patch
        self.catalog.import_files([self.photo('metadata-cancel.png')])
        photo = self.catalog.photos()[0]; folder = self.root / 'metadata-output'
        cancellation = self.engine.CancellationToken()
        real_dump = self.engine.json.dump
        def dump(*args, **kwargs):
            real_dump(*args, **kwargs)
            cancellation.cancel()
        with patch('engine.json.dump', side_effect=dump), self.assertRaises(self.engine.ExportCancelled):
            self.engine.export_photo(photo, folder, format='png', cancellation=cancellation)
        self.assertEqual(list(folder.iterdir()), [])

    def test_cancellation_during_raw_sidecar_drops_current_tiff_and_profile(self):
        from unittest.mock import patch
        developed = self.root / 'developed.tif'; Image.new('RGB', (20, 20), 'coral').save(developed)
        cancellation = self.engine.CancellationToken(); folder = self.root / 'raw-output'
        def profile(*args, **kwargs):
            cancellation.cancel()
            return '[Exposure]\n'
        with patch('engine.develop_raw', return_value=developed), patch('engine.raw_profile', side_effect=profile), self.assertRaises(self.engine.ExportCancelled):
            self.engine.export_raw_tiff({'path': str(self.root / 'source.nef'), 'recipe': {}}, folder, cancellation=cancellation)
        self.assertEqual(list(folder.iterdir()), [])

    def test_import_is_idempotent_and_does_not_modify_original(self):
        path = self.photo('旅行.jpg')
        before = path.read_bytes()
        rows, errors = self.catalog.import_files([path, path])
        self.assertFalse(errors)
        self.assertEqual(len(self.catalog.photos()), 1)
        self.assertEqual(path.read_bytes(), before)

    def test_remove_from_album_is_undoable_and_keeps_shared_original(self):
        path=self.photo('shared.png');before=path.read_bytes();a=self.catalog.create_album('A');b=self.catalog.create_album('B')
        self.catalog.import_files([path],album_id=a['id']);self.catalog.import_files([path],album_id=b['id']);identity=self.catalog.photos()[0]['id']
        self.assertTrue(self.catalog.remove_photos([identity],a['id']))
        self.assertEqual(self.catalog.photos()[0]['album_ids'],[b['id']]);self.assertEqual(path.read_bytes(),before)
        self.assertTrue(self.catalog.undo());self.assertEqual(set(self.catalog.photos()[0]['album_ids']),{a['id'],b['id']})
        self.assertTrue(self.catalog.redo());self.assertEqual(self.catalog.photos()[0]['album_ids'],[b['id']])
        self.assertTrue(self.catalog.remove_photos([identity],None));self.assertEqual(self.catalog.photos(),[])
        self.assertTrue(self.catalog.undo());self.assertEqual(self.catalog.photos()[0]['id'],identity);self.assertTrue(path.exists())

    def test_undo_removal_does_not_erase_a_later_import_into_another_album(self):
        path=self.photo('shared-later.png');a=self.catalog.create_album('A');b=self.catalog.create_album('B')
        self.catalog.import_files([path],album_id=a['id']);identity=self.catalog.photos()[0]['id']
        self.catalog.remove_photos([identity],a['id']);self.catalog.import_files([path],album_id=b['id'])
        self.assertTrue(self.catalog.undo());self.assertEqual(set(self.catalog.photos()[0]['album_ids']),{a['id'],b['id']})
        self.assertTrue(self.catalog.redo());self.assertEqual(self.catalog.photos()[0]['album_ids'],[b['id']])

    def test_multi_album_removal_is_one_undoable_membership_delta(self):
        import hashlib
        path = self.photo('shared-three.png')
        original = hashlib.sha256(path.read_bytes()).digest()
        a, b, c = [self.catalog.create_album(name)['id'] for name in ('A', 'B', 'C')]
        for album in (a, b, c): self.catalog.import_files([path], album_id=album)
        identity = self.catalog.photos()[0]['id']
        self.assertTrue(self.catalog.remove_photos([identity], album_ids=[a, c]))
        self.assertEqual(self.catalog.photos()[0]['album_ids'], [b])
        self.assertEqual(self.catalog.history_state(), {'undo': 1, 'redo': 0})
        self.assertTrue(self.catalog.undo())
        self.assertEqual(set(self.catalog.photos()[0]['album_ids']), {a, b, c})
        self.assertEqual(self.catalog.history_state(), {'undo': 0, 'redo': 1})
        self.assertTrue(self.catalog.redo())
        self.assertEqual(self.catalog.photos()[0]['album_ids'], [b])
        self.assertEqual(self.catalog.history_state(), {'undo': 1, 'redo': 0})
        self.assertEqual(hashlib.sha256(path.read_bytes()).digest(), original)

    def test_multi_album_undo_and_redo_preserve_later_import_memberships(self):
        path = self.photo('later-memberships.png')
        a, b, c, d = [self.catalog.create_album(name)['id'] for name in ('A', 'B', 'C', 'D')]
        for album in (a, b, c): self.catalog.import_files([path], album_id=album)
        identity = self.catalog.photos()[0]['id']
        self.catalog.remove_photos([identity], album_ids=[a, c])
        # Re-import into one removed album and an unrelated new album.
        for album in (a, d): self.catalog.import_files([path], album_id=album)
        self.catalog.undo()
        self.assertEqual(set(self.catalog.photos()[0]['album_ids']), {a, b, c, d})
        self.catalog.redo()
        self.assertEqual(set(self.catalog.photos()[0]['album_ids']), {a, b, d})

    def test_multi_album_scope_validation_and_empty_intersection_are_noops(self):
        path = self.photo('scope.png')
        a, b = [self.catalog.create_album(name)['id'] for name in ('A', 'B')]
        self.catalog.import_files([path], album_id=a)
        identity = self.catalog.photos()[0]['id']
        for scope in ([], [a, a], [True], ['1'], [a, 999], a):
            with self.subTest(scope=scope), self.assertRaises(ValueError):
                self.catalog.remove_photos([identity], album_ids=scope)
        with self.assertRaises(ValueError):
            self.catalog.remove_photos([identity], album_id=a, album_ids=[b])
        self.assertFalse(self.catalog.remove_photos([identity], album_ids=[b]))
        self.assertEqual(self.catalog.history_state(), {'undo': 0, 'redo': 0})
        self.assertEqual(self.catalog.photos()[0]['album_ids'], [a])

    def test_remove_http_forwards_selected_album_scope(self):
        import json
        import threading
        from urllib.request import Request, urlopen
        import service
        server = service.create_server(self.root/'api-data', 'scope-test', 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        catalog = self.engine.Catalog(self.root/'api-data/library.sqlite')
        self.addCleanup(catalog.close)
        a, b, c = [catalog.create_album(name)['id'] for name in ('A', 'B', 'C')]
        path = self.photo('api-shared.png')
        for album in (a, b, c): catalog.import_files([path], album_id=album)
        identity = catalog.photos()[0]['id']
        request = Request(f'http://127.0.0.1:{server.server_port}/api/remove',
            data=json.dumps({'ids': [identity], 'album_ids': [a, c]}).encode(),
            headers={'Authorization': 'Bearer scope-test', 'Content-Type': 'application/json'})
        with urlopen(request, timeout=10) as response: result = json.load(response)
        self.assertTrue(result['changed'])
        self.assertEqual(catalog.photos()[0]['album_ids'], [b])

    def test_exact_duplicates_are_flagged_without_deleting_them(self):
        a = self.photo('a.jpg')
        b = self.root / 'b.jpg'
        b.write_bytes(a.read_bytes())
        self.catalog.import_files([a, b])
        rows = self.catalog.photos()
        self.assertEqual(len(rows), 2)
        self.assertEqual(sum(bool(p['duplicate_of']) for p in rows), 1)
        self.assertTrue(b.exists())

    def test_broken_image_does_not_abort_import(self):
        broken = self.root / 'broken.jpg'
        broken.write_bytes(b'not an image')
        rows, errors = self.catalog.import_files([broken, self.photo('good.png')])
        self.assertEqual(len(rows), 1)
        self.assertEqual(len(errors), 1)

    def test_batch_edit_and_persistent_undo(self):
        self.catalog.import_files([self.photo('a.jpg'), self.photo('b.jpg', 'teal')])
        ids = [p['id'] for p in self.catalog.photos()]
        self.catalog.edit(ids, recipe={'style': 'warm', 'exposure': 0.5})
        self.assertTrue(all(p['recipe']['style'] == 'warm' for p in self.catalog.photos()))
        self.assertTrue(self.catalog.undo())
        self.assertTrue(all(p['recipe'].get('style', 'natural') == 'natural' for p in self.catalog.photos()))

    def test_decision_survives_restart(self):
        self.catalog.import_files([self.photo('a.jpg')])
        self.catalog.edit([self.catalog.photos()[0]['id']], decision='keep')
        other = self.engine.Catalog(self.root / 'library.sqlite')
        try:
            self.assertEqual(other.photos()[0]['decision'], 'keep')
        finally:
            other.close()

    def test_template_export_preserves_source_and_never_overwrites(self):
        path = self.photo('source.jpg')
        before = path.read_bytes()
        self.catalog.import_files([path])
        photo = self.catalog.photos()[0]
        first = self.engine.export_photo(photo, self.root / 'exports', 'frame', 600)
        second = self.engine.export_photo(photo, self.root / 'exports', 'frame', 600)
        self.assertNotEqual(first, second)
        self.assertEqual(path.read_bytes(), before)
        with Image.open(first) as image:
            self.assertEqual(image.size, (600, 600))
            self.assertTrue(image.info.get('icc_profile'))

    def test_multiple_exports_read_original_precision_and_allow_native_size(self):
        import pixels,numpy as np
        data=np.repeat(np.linspace(0,1,2048,dtype=np.float32)[None,:,None],3,axis=2);path=self.root/'ramp.tif';pixels.write(path,data,'tiff16')
        self.catalog.import_files([path]);photo=self.catalog.photos()[0];before=path.read_bytes()
        for format in ('png','tiff'):
            output=self.engine.export_photo(photo,self.root/'out','plain',0,format)
            np.testing.assert_array_equal(np.rint(pixels.read(output)*65535).astype('uint16'),np.rint(data*65535).astype('uint16'))
            self.assertGreater(len(np.unique(pixels.read(output)[...,0])),1000)
        for format in ('webp','jpeg','original'):
            output=self.engine.export_photo(photo,self.root/'out','plain',0,format);self.assertTrue(output.is_file())
            if format=='original':self.assertEqual(output.read_bytes(),before)
        self.assertEqual(path.read_bytes(),before)

    def test_invalid_recipe_is_rejected(self):
        with self.assertRaises(ValueError):
            self.engine.render_image(self.photo('a.jpg'), {'exposure': float('nan')})

    def test_time_groups_use_capture_time(self):
        paths = []
        for index, date in enumerate(['2026:10:20 10:00:00', '2026:10:20 10:01:00', '2026:10:20 12:00:00']):
            path = self.root / f'{index}.jpg'
            exif = Image.Exif()
            exif[306] = date
            Image.new('RGB', (100, 80), ('coral', 'teal', 'navy')[index]).save(path, exif=exif)
            os.utime(path, (100, 100))
            paths.append(path)
        self.catalog.import_files(paths)
        photos = self.catalog.photos()
        self.assertEqual(photos[0]['group_id'], photos[1]['group_id'])
        self.assertNotEqual(photos[1]['group_id'], photos[2]['group_id'])
        self.assertTrue(all(p['time_source'] == 'exif' for p in photos))

    def test_saved_edit_undo_survives_restart(self):
        self.catalog.import_files([self.photo('a.jpg')])
        self.catalog.edit([self.catalog.photos()[0]['id']], recipe={'style': 'mono'})
        other = self.engine.Catalog(self.root / 'library.sqlite')
        try:
            self.assertTrue(other.undo())
            self.assertEqual(other.photos()[0]['recipe']['style'], 'natural')
        finally:
            other.close()

    def test_preview_and_export_use_the_same_recipe(self):
        self.catalog.import_files([self.photo('a.png')])
        photo = self.catalog.photos()[0]
        photo['recipe'] = {'style': 'mono', 'exposure': .5}
        preview = self.engine.render_image(photo['path'], photo['recipe'])
        output = self.engine.export_photo(photo, self.root / 'out', 'plain', 600)
        with Image.open(output) as actual:
            self.assertEqual(actual.size, preview.size)
            self.assertLess(abs(actual.getpixel((50, 50))[0] - preview.getpixel((50, 50))[0]), 3)

    def test_orientation_is_applied(self):
        path = self.root / 'rotated.jpg'
        exif = Image.Exif()
        exif[274] = 6
        Image.new('RGB', (180, 120), 'teal').save(path, exif=exif)
        self.assertEqual(self.engine.open_image(path).size, (120, 180))

    def test_icc_conversion_preserves_transparency_before_white_compositing(self):
        path = self.root / 'transparent.png'
        Image.new('RGBA', (60, 40), (255, 0, 0, 0)).save(path, icc_profile=self.engine.SRGB)
        self.assertEqual(self.engine.open_image(path).getpixel((10, 10)), (255, 255, 255))

    def test_raw_recipe_parameters_survive_edit_and_restart(self):
        self.catalog.import_files([self.photo('a.jpg')])
        self.catalog.edit([self.catalog.photos()[0]['id']], recipe={'raw_exposure': 1.2, 'raw_wb': 'custom', 'raw_temperature': 4800})
        saved = self.catalog.photos()[0]['recipe']
        self.assertEqual(saved.get('raw_exposure'), 1.2)
        self.assertEqual(saved.get('raw_wb'), 'custom')

    def test_raw_profile_maps_to_real_processing_parameters(self):
        self.assertTrue(hasattr(self.engine, 'raw_profile'), 'RAW processing adapter is missing')
        text = self.engine.raw_profile({'raw_exposure': 1.5, 'raw_wb': 'custom',
                                        'raw_temperature': 4300, 'raw_denoise': 20, 'raw_sharpen': 80})
        import configparser
        profile = configparser.ConfigParser()
        profile.read_string(text)
        self.assertEqual(profile.getfloat('Exposure', 'Compensation'), 1.5)
        self.assertEqual(profile.get('White Balance', 'Setting'), 'Custom')
        self.assertEqual(profile.getint('White Balance', 'Temperature'), 4300)
        self.assertTrue(profile.getboolean('Directional Pyramid Denoising', 'Enabled'))
        self.assertEqual(profile.getint('Sharpening', 'Amount'), 80)

    def test_raw_parameters_reject_nan_and_unknown_white_balance(self):
        for recipe in ({'raw_exposure': float('nan')}, {'raw_wb': 'invalid'}, {'raw_temperature': 0}):
            with self.assertRaises(ValueError):
                self.engine.validate_recipe(recipe)

    def test_professional_export_rejects_non_raw_input(self):
        self.assertTrue(hasattr(self.engine, 'export_raw_tiff'), '16-bit RAW export is missing')
        with self.assertRaises(ValueError):
            self.engine.export_raw_tiff({'path': str(self.photo('a.jpg'))}, self.root / 'exports')

    def test_native_frontend_extension_has_isolated_settings(self):
        self.assertTrue(hasattr(self.engine, 'prepare_studio'), 'Native editor frontend has not been integrated')
        settings, inbox = self.engine.prepare_studio(self.root / 'studio')
        content = (settings / 'options').read_text(encoding='utf-8')
        self.assertIn('[External Editor]', content)
        self.assertIn('Photo All', content)
        self.assertIn('SaveParamsWithFile=false', content)
        self.assertTrue(inbox.is_dir())
        (settings / 'options').write_text(content + '\n# user preference\n', encoding='utf-8')
        self.engine.prepare_studio(self.root / 'studio')
        self.assertIn('# user preference', (settings / 'options').read_text(encoding='utf-8'))

    def test_native_frontend_cannot_reuse_another_library_instance(self):
        from unittest.mock import patch
        cli = self.root / 'rawtherapee-cli.exe'
        cli.touch()
        cli.with_name('rawtherapee.exe').touch()
        with patch.dict(os.environ, {'PHOTOALL_RAWTHERAPEE': str(cli)}), patch('engine.subprocess.Popen') as launch:
            self.engine.launch_studio(self.root / 'studio')
            self.assertNotIn('-R', launch.call_args.args[0], 'Remote reuse discards this library environment')
            self.assertEqual(launch.call_args.kwargs['env']['PHOTOALL_DATA_DIR'], str((self.root / 'studio').resolve()))


if __name__ == '__main__':
    unittest.main(verbosity=2)
