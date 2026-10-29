"""Verify a relocated Windows runtime with an isolated profile and real inference."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import urllib.request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('runtime', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--raw', type=Path, help='Optional RAW fixture copied into the relocated test directory')
    args = parser.parse_args()
    temp_parent = Path(__file__).resolve().parent / 'artifacts'
    temp_parent.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='Photo All 独立验证 ', dir=temp_parent) as temporary:
        temporary = Path(temporary)
        runtime = temporary / 'application' / 'runtime'
        shutil.copytree(args.runtime, runtime)
        python = runtime / 'python/python.exe'
        assert python.is_file(), 'The embedded interpreter must ship with the application'
        env = {key: value for key, value in os.environ.items() if not key.startswith(('PYTHON', 'PHOTOALL'))}
        env['PATH'] = str(Path(os.environ['SystemRoot']) / 'System32')
        env['APPDATA'] = str(temporary / 'profile/Roaming')
        env['LOCALAPPDATA'] = str(temporary / 'profile/Local')
        env['PHOTOALL_SESSION_TOKEN'] = 'packaging-smoke-local-token'
        env['PYTHONDONTWRITEBYTECODE'] = '1'
        raw = temporary / args.raw.name if args.raw else temporary / 'no-raw-fixture'
        if args.raw:
            shutil.copy2(args.raw, raw)
        check = """
import json, sys
from pathlib import Path
import numpy, PIL, png, tifffile, imagecodecs, pixels, engine, film, workflow, tkinter
from PIL import Image
assert engine.capabilities()['raw']
assert workflow.recognition_status()['ready']
assert all(item['ready'] for item in film.catalog()['stocks'].values())
image = Image.new('RGB',(80,64),(40,130,70))
image.save(sys.argv[1])
workspace = Path(sys.argv[1]).parent
samples = numpy.random.default_rng(41).random((21,37,3), dtype=numpy.float32)
for format, suffix in [('png16','.png'),('tiff16','.tif')]:
    target = workspace / ('roundtrip' + suffix)
    pixels.write(target, samples, format)
    decoded = pixels.read(target)
    assert numpy.max(numpy.abs(decoded-samples)) <= 1/65535
pixels._lcms()
graded = film.apply_film(image, {'film_stock':'kodak_portra_400','film_strength':1,'film_grain':0,'film_halation':0})
assert graded.tobytes() != image.tobytes()
widget = tkinter.Tk()
widget.withdraw()
widget.destroy()
raw = Path(sys.argv[2])
if raw.is_file():
    engine.RAW_CACHE = workspace / 'raw-cache'
    decoded = engine.render_image(raw, {}, (400,300))
    assert decoded.width > 100 and decoded.height > 100
classifier = workflow.LocalClassifier()
features = classifier.classify(image)
print(json.dumps({'python':sys.version,'prefix':sys.prefix,'raw':str(engine.raw_executable()),'raw_decoded':raw.is_file(),'precision_roundtrips':True,'lcms_loaded':True,'film_rendered':True,'tk_companion':True,'classification':features,'numpy':numpy.__version__,'Pillow':PIL.__version__}))
"""
        fixture = temporary / 'synthetic.png'
        result = subprocess.run([str(python), '-c', check, str(fixture), str(raw)], env=env,
                                cwd=runtime, capture_output=True, text=True, timeout=240,
                                creationflags=subprocess.CREATE_NO_WINDOW)
        if result.returncode:
            raise AssertionError(result.stdout + result.stderr)
        details = json.loads(result.stdout.strip())
        data = Path(env['LOCALAPPDATA']) / 'org.photoall.studio'
        process = subprocess.Popen([str(python), '-u', str(runtime / 'service.py'), '--data-dir', str(data)],
                                   env=env, cwd=temporary, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            handshake = json.loads(process.stdout.readline())
            request = urllib.request.Request(f"http://127.0.0.1:{handshake['port']}/api/library",
                headers={'Authorization': 'Bearer ' + env['PHOTOALL_SESSION_TOKEN']})
            with urllib.request.urlopen(request, timeout=20) as response:
                library = json.load(response)
            assert library['photos'] == []
            assert (data / 'library.sqlite').is_file()
            assert not (runtime / 'data').exists(), 'Application folder must remain read-only'
            report = {'status': 'passed', 'relocated': True, 'isolated_path': True,
                      'appdata_profile': True, 'offline_inference': True, 'library_api': True,
                      'runtime_files': sum(p.is_file() for p in runtime.rglob('*')), **details}
            if args.output:
                args.output.parent.mkdir(parents=True, exist_ok=True)
                args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')
            print(json.dumps(report, indent=2, ensure_ascii=False))
        finally:
            process.kill()
            process.communicate(timeout=10)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
