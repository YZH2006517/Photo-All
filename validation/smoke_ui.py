"""Real Tk window workflow using synthetic fixtures; artifacts are isolated here."""
import json
from pathlib import Path
import sys
import time
from unittest.mock import patch

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent / 'product'))
from app import PhotoApp

artifacts = ROOT / 'artifacts'
artifacts.mkdir(exist_ok=True)
run = artifacts / time.strftime('%Y%m%d-%H%M%S')
run.mkdir()
photos = run / 'photos'
photos.mkdir()
paths = []
for index, color in enumerate(['#d4a97b', '#a8c7c0', '#aaa0bb']):
    image = Image.new('RGB', (1200, 800), color)
    draw = ImageDraw.Draw(image)
    draw.ellipse((750, 90, 950, 290), fill='#f6e4b9')
    draw.polygon([(0, 650), (370, 220), (760, 650)], fill='#627c73')
    draw.polygon([(450, 800), (890, 350), (1200, 800)], fill='#3d5b56')
    path = photos / f'landscape-{index}.jpg'
    image.save(path)
    paths.append(path)

app = PhotoApp(run / 'data')
errors = []
app.report_callback_exception = lambda *exc: errors.append(str(exc))

def pump_until(condition, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        app.update()
        if condition():
            return
        time.sleep(.03)
    raise AssertionError('Timed out waiting for UI task')

try:
    app.update()
    app.import_paths(paths)
    assert app.group_combo.instate(['disabled']), 'Import must disable editing controls'
    pump_until(lambda: not app.busy and app.current is not None)
    assert not app.group_combo.instate(['disabled']), 'Controls must recover after import'
    assert len(app.rows) == 3
    # Switching to an empty filter before debounce must preserve the edit.
    edited_id = app.current['id']
    app.variables['exposure'].set(.7)
    app.changed()
    app.filter.set('已保留')
    app.refresh()
    app.update()
    saved = next(p for p in app.catalog.photos() if p['id'] == edited_id)
    assert saved['recipe']['exposure'] == .7, 'Filter switch lost a pending edit'
    app.filter.set('全部状态')
    app.refresh(select_id=edited_id)
    app.update()
    assert app.variables['exposure'].get() == .7, 'Controls reloaded a stale recipe'
    app.style_name.set('暖调日记')
    app.variables['exposure'].set(.4)
    app.changed()
    pump_until(lambda: app.save_timer is None and app.current['recipe']['style'] == 'warm')
    app.apply_group()
    pump_until(lambda: all(p['recipe']['style'] == 'warm' for p in app.rows))
    app.recommend()
    pump_until(lambda: any(p['decision'] == 'keep' for p in app.rows))
    app.undo()
    pump_until(lambda: all(p['decision'] == 'pending' for p in app.rows))
    with patch('app.filedialog.askdirectory', return_value=str(run / 'exports')), patch('app.messagebox.showinfo'), patch('app.messagebox.showwarning'):
        app.export_size.set('1200')
        app.export()
        pump_until(lambda: not app.busy)
    outputs = list((run / 'exports').glob('*.jpg'))
    assert len(outputs) == 3, outputs
    pump_until(lambda: app.tk_image is not None)
    assert not errors, errors
    report = {'status': 'passed', 'imported': len(app.rows), 'exported': len(outputs),
              'window': [app.winfo_width(), app.winfo_height()], 'errors': errors,
              'scope': 'synthetic fixtures, not real photo quality evaluation'}
    (run / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({'run': str(run), **report}, indent=2))
    if '--keep-open' in sys.argv:
        app.mainloop()
finally:
    if app.winfo_exists():
        app.close()
