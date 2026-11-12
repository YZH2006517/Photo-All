"""Cross-preview/export film reuse must obey actual pixel/config boundaries."""
from pathlib import Path
import json, sys, threading, unittest
from unittest.mock import patch
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'product'))
import film_spectral as film


class SpectralReuseTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform=='win32','Windows cooperative preview cancellation')
    def test_superseded_preview_signals_worker_without_destroying_gpu_cache(self):
        import queue
        from types import SimpleNamespace
        from unittest.mock import Mock
        worker=film.SpectralWorker()
        worker.process=SimpleNamespace(poll=lambda:None,stdin=Mock())
        worker.responses=queue.Queue();worker.responses.put(json.dumps({'ok':True}))
        current=iter((True,True,False,False))
        with film.SharedFrame((5,6,3)) as frame,patch.object(worker,'stop') as stop:
            with self.assertRaises(film.PreviewSuperseded),film.preview_task(lambda:next(current,False)):
                worker.call(Path(sys.executable),None,{},'paper',preview=True,shared=frame.metadata)
            stop.assert_not_called()
            self.assertTrue(frame.cancelled(),'Worker did not receive cancellation')

    def test_post_edits_and_native_export_share_only_matching_film_pixels(self):
        self.assertTrue(hasattr(film, '_render_cache'), 'Missing bounded spectral result cache')
        film._render_cache.clear()
        rgb = np.full((24, 36, 3), .25, np.float32)
        recipe = {'film_advanced': json.dumps({'stock':'kodak_gold_200'})}
        calls = []
        def compute(python, root, config, paper, quality, **options):
            calls.append((config, quality))
            if options.get('shared'):
                import mmap
                frame=options['shared']
                with mmap.mmap(-1,frame['bytes'],tagname=frame['name']) as mapping:
                    image=np.ndarray(frame['shape'],np.float32,buffer=mapping)
                    target=np.ndarray(frame['output_shape'],np.float32,buffer=mapping,offset=image.nbytes)
                    target[:]=image*.8
                    del image,target
            else:
                image = np.load(root/'input.npy')
                np.save(root/'output.npy', image*.8)
        with patch.object(film, 'interpreter', return_value=Path(sys.executable)), \
             patch.object(film._interactive_worker, 'call', side_effect=compute), \
             patch.object(film._native_worker, 'call', side_effect=compute):
            first = film.render(rgb, recipe, {}, preview=True)
            first[:] = 0  # Downstream strength/tone operations must not poison cached pixels.
            reused = film.render(rgb, {**recipe, 'filter_id':'other', 'shadows':.2}, {}, preview=False)
            self.assertEqual(len(calls), 1, 'Export/post filters repeated film simulation')
            np.testing.assert_array_equal(reused, rgb*.8)
            film.render(rgb*.9, recipe, {}, preview=True)
            self.assertEqual(len(calls), 2, 'Changed pre-film pixels reused stale film')
            film.render(rgb, {**recipe, 'film_advanced':json.dumps({'stock':'kodak_gold_200','paper_ev':1})}, {})
            self.assertEqual(len(calls), 3, 'Changed physical parameters reused stale film')
            with film.calculation_mode('exact'), patch.object(film,'SharedFrame',side_effect=OSError('commit limit')):
                film.render(rgb, recipe, {})
            self.assertEqual(calls[-1][1], 'exact', 'Exact export reused approximate film')
            self.assertEqual(len(calls), 4)
        film._render_cache.clear()

    @unittest.skipUnless(sys.platform=='win32','Windows named mapping transport')
    def test_native_worker_uses_shared_pixels_without_temporary_npy_files(self):
        self.assertTrue(hasattr(film,'SharedFrame'), 'Missing shared-memory transport')
        image=np.arange(90,dtype=np.float32).reshape(5,6,3)
        with film.SharedFrame(image.shape,2) as frame:
            frame.input[:]=image
            import mmap
            with mmap.mmap(-1,frame.metadata['bytes'],tagname=frame.metadata['name']) as other:
                source=np.ndarray(image.shape,np.float32,buffer=other)
                output=np.ndarray(frame.output.shape,np.float32,buffer=other,offset=image.nbytes)
                np.testing.assert_array_equal(source,image)
                output[:]=.25
                del source,output
            np.testing.assert_array_equal(frame.output,np.full((10,12,3),.25,np.float32))

    def test_cache_is_bounded_and_does_not_keep_unlimited_sources(self):
        self.assertTrue(hasattr(film, 'RenderCache'), 'Missing bounded spectral cache')
        cache = film.RenderCache(native_bytes=2000, small_bytes=1000)
        image = np.ones((10,10,3), np.float32)
        for key in range(20):
            cache.put(key, image)
        self.assertIsNone(cache.get(0))
        self.assertIsNotNone(cache.get(19))
        self.assertLessEqual(cache.bytes, 3000)
        cache.put('oversized', np.ones((30,30,3),np.float32))
        self.assertIsNone(cache.get('oversized'))

if __name__=='__main__': unittest.main(verbosity=2)
