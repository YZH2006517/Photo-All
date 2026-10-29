# SPDX-License-Identifier: GPL-3.0-or-later
"""Native desktop UI. All widget and application flow code stays in this file."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
import argparse
import json
import os
import queue
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from PIL import ImageTk
import engine
from engine import Catalog, DEFAULT_RECIPE, RAW, RAW_DEFAULTS, STYLES, SUPPORTED, TEMPLATES, capabilities, export_photo, export_raw_tiff, render_image

BG, PANEL, TEXT, MUTED, ACCENT = '#111519', '#1a2026', '#edf0ef', '#95a29e', '#b7d8a4'


class PhotoApp(tk.Tk):
    def __init__(self, data_dir=None):
        super().__init__()
        self.title('Photo All · 相册与出片扩展')
        self.geometry('1460x920')
        self.minsize(1120, 740)
        self.configure(bg=BG)
        self.data_dir = Path(data_dir or Path(__file__).parent / 'data')
        engine.RAW_CACHE = self.data_dir / 'raw-cache'
        self.catalog = Catalog(self.data_dir / 'library.sqlite')
        self.pool = ThreadPoolExecutor(max_workers=2)
        self.events = queue.Queue()
        self.rows, self.current = [], None
        self.preview_serial = 0
        self.preview_future = None
        self.save_timer = None
        self.busy = False
        self.loading_controls = False
        self.tk_image = None
        self.status = tk.StringVar(value='本地处理 · 原图只读 · 调整自动保存')
        self.group = tk.StringVar(value='全部照片')
        self.filter = tk.StringVar(value='全部状态')
        self.style_name = tk.StringVar(value=STYLES['natural'])
        self.template = tk.StringVar(value=TEMPLATES['frame'])
        self.export_size = tk.StringVar(value='2400')
        self.export_format = tk.StringVar(value='JPEG 作品（含风格与模板）')
        self.variables = {name: tk.DoubleVar(value=DEFAULT_RECIPE[name])
                          for name in ('exposure', 'contrast', 'saturation', 'temperature')}
        self._build()
        self.refresh()
        self.after(60, self._poll)
        self.protocol('WM_DELETE_WINDOW', self.close)
        self.bind('<Control-z>', lambda _: self.undo())
        self.bind('<Control-o>', lambda _: self.choose_files())
        self.bind('<Key-k>', lambda _: self.decide('keep') if self.focus_get() == self.tree else None)
        self.bind('<Key-x>', lambda _: self.decide('reject') if self.focus_get() == self.tree else None)

    def _build(self):
        style = ttk.Style(self)
        style.theme_use('clam')
        style.configure('.', background=PANEL, foreground=TEXT, font=('Microsoft YaHei UI', 10))
        style.configure('TButton', padding=(12, 8), borderwidth=0)
        style.map('TButton', background=[('active', '#35443b')])
        style.configure('Accent.TButton', background=ACCENT, foreground='#152016')
        style.configure('TCombobox', fieldbackground='#293139', background='#293139', foreground=TEXT,
                        arrowcolor=ACCENT, padding=5)
        style.map('TCombobox', fieldbackground=[('readonly', '#293139')], selectbackground=[('readonly', '#293139')],
                  selectforeground=[('readonly', TEXT)])
        style.configure('Treeview', background=PANEL, fieldbackground=PANEL, foreground=TEXT,
                        rowheight=38, borderwidth=0)
        style.configure('Treeview.Heading', background='#242c32', foreground=MUTED, padding=8)
        style.map('Treeview', background=[('selected', '#35443b')])
        style.configure('TScale', background=PANEL, troughcolor='#303b42')
        top = tk.Frame(self, bg=BG, padx=24, pady=18)
        top.pack(fill='x')
        tk.Label(top, text='PHOTO ALL', font=('Segoe UI', 20, 'bold'), fg=ACCENT, bg=BG).pack(side='left')
        tk.Label(top, text=' /  组图工作室', font=('Microsoft YaHei UI', 12), fg=MUTED, bg=BG).pack(side='left', padx=12)
        for title, command in [('导出作品', self.export), ('导入文件夹', self.choose_folder), ('导入照片', self.choose_files)]:
            ttk.Button(top, text=title, command=command, style='Accent.TButton' if title == '导入照片' else 'TButton').pack(side='right', padx=4)
        ttk.Button(top, text='专业工作台 ↗', command=self.open_studio).pack(side='right', padx=4)
        body = tk.Frame(self, bg=BG, padx=20)
        body.pack(fill='both', expand=True)
        body.grid_rowconfigure(0, weight=1)
        body.grid_columnconfigure(1, weight=1)
        left = tk.Frame(body, bg=PANEL, padx=14, pady=16, width=340)
        left.grid(row=0, column=0, sticky='ns', padx=(0, 12))
        left.grid_propagate(False)
        self._label(left, '01 / 整理与选片', 13, True).pack(anchor='w', pady=(0, 12))
        self.summary = self._label(left, '还没有照片', 10)
        self.summary.pack(anchor='w', pady=(0, 12))
        self.group_combo = ttk.Combobox(left, textvariable=self.group, state='readonly', values=['全部照片'])
        self.group_combo.pack(fill='x', pady=4)
        self.group_combo.bind('<<ComboboxSelected>>', lambda _: self.refresh())
        combo = ttk.Combobox(left, textvariable=self.filter, state='readonly',
                             values=['全部状态', '待选', '已保留', '已排除', '完全重复'])
        combo.pack(fill='x', pady=4)
        combo.bind('<<ComboboxSelected>>', lambda _: self.refresh())
        tree_frame = tk.Frame(left, bg=PANEL)
        tree_frame.pack(fill='both', expand=True, pady=12)
        self.tree = ttk.Treeview(tree_frame, columns=('score', 'state'), selectmode='extended')
        self.tree.heading('#0', text='照片')
        self.tree.heading('score', text='评分')
        self.tree.heading('state', text='状态')
        self.tree.column('#0', width=175, minwidth=100)
        self.tree.column('score', width=45, stretch=False)
        self.tree.column('state', width=55, stretch=False)
        self.tree.pack(side='left', fill='both', expand=True)
        scroll = ttk.Scrollbar(tree_frame, orient='vertical', command=self.tree.yview)
        scroll.pack(side='right', fill='y')
        self.tree.configure(yscrollcommand=scroll.set)
        self.tree.bind('<<TreeviewSelect>>', self.select)
        buttons = tk.Frame(left, bg=PANEL)
        buttons.pack(fill='x')
        for label, state in [('保留 K', 'keep'), ('排除 X', 'reject'), ('待选', 'pending')]:
            ttk.Button(buttons, text=label, command=lambda s=state: self.decide(s)).pack(side='left', expand=True)
        ttk.Button(left, text='按组推荐保留', command=self.recommend).pack(fill='x', pady=(10, 4))
        self._label(left, '评分为清晰度/曝光启发式建议\nCtrl / Shift 多选 · 不自动删照片', 9).pack(anchor='w', pady=6)

        center = tk.Frame(body, bg=BG)
        center.grid(row=0, column=1, sticky='nsew')
        titlebar = tk.Frame(center, bg=BG)
        titlebar.pack(fill='x', pady=(6, 12))
        self.title_label = tk.Label(titlebar, text='把一组照片，变成一组作品。', fg=TEXT, bg=BG,
                                    font=('Microsoft YaHei UI', 15, 'bold'), anchor='w')
        self.title_label.pack(side='left', fill='x', expand=True)
        compare = ttk.Button(titlebar, text='按住看原图')
        compare.pack(side='right')
        compare.bind('<ButtonPress-1>', lambda _: self.preview(original=True))
        compare.bind('<ButtonRelease-1>', lambda _: self.preview())
        compare.bind('<Leave>', lambda _: self.preview())
        self.canvas = tk.Canvas(center, bg='#0b0e11', highlightthickness=0)
        self.canvas.pack(fill='both', expand=True)
        self.canvas.bind('<Configure>', self.resize_preview)
        self.resize_timer = None
        self.detail = tk.Label(center, text='导入文件或文件夹开始 · 所有处理均在本机完成',
                               bg=BG, fg=MUTED, font=('Microsoft YaHei UI', 10), anchor='w')
        self.detail.pack(fill='x', pady=14)

        right = tk.Frame(body, bg=PANEL, padx=20, pady=16, width=290)
        right.grid(row=0, column=2, sticky='ns', padx=(12, 0))
        right.pack_propagate(False)
        self._label(right, '02 / 统一风格', 13, True).pack(anchor='w', pady=(0, 12))
        style_combo = ttk.Combobox(right, textvariable=self.style_name, state='readonly', values=list(STYLES.values()))
        style_combo.pack(fill='x', pady=(0, 16))
        style_combo.bind('<<ComboboxSelected>>', self.changed)
        for name, label, low, high in [('exposure', '曝光 / EV', -2, 2), ('temperature', '冷暖', -1, 1),
                                       ('contrast', '对比度', .5, 1.5), ('saturation', '饱和度', 0, 2)]:
            row = tk.Frame(right, bg=PANEL)
            row.pack(fill='x', pady=(8, 0))
            self._label(row, label).pack(side='left')
            value = self._label(row, '0.00')
            value.pack(side='right')
            self.variables[name].trace_add('write', lambda *_a, v=self.variables[name], w=value: w.configure(text=f'{v.get():.2f}'))
            ttk.Scale(right, from_=low, to=high, variable=self.variables[name], command=self.changed).pack(fill='x', pady=(4, 6))
        ttk.Button(right, text='RAW 专业显影参数…', command=self.raw_settings).pack(fill='x', pady=4)
        ttk.Button(right, text='将当前配方应用到本组', command=self.apply_group).pack(fill='x', pady=(14, 6))
        ttk.Button(right, text='重置当前照片', command=self.reset).pack(fill='x', pady=4)
        ttk.Button(right, text='撤销上次修改  Ctrl+Z', command=self.undo).pack(fill='x', pady=4)
        self._label(right, '03 / 导出作品', 13, True).pack(anchor='w', pady=(14, 8))
        ttk.Combobox(right, textvariable=self.export_format, values=['JPEG 作品（含风格与模板）', 'RAW 16-bit TIFF（仅显影）'], state='readonly').pack(fill='x', pady=4)
        ttk.Combobox(right, textvariable=self.template, values=list(TEMPLATES.values()), state='readonly').pack(fill='x', pady=4)
        ttk.Combobox(right, textvariable=self.export_size, values=['1200', '2400', '4000', '6000'], state='readonly').pack(fill='x', pady=4)
        self._label(right, '优先导出当前范围内已保留照片。\nTIFF：全分辨率，仅 RAW 显影参数\n不包含上方风格/基础滑杆/留白模板。', 9).pack(anchor='w', pady=8)
        self.engine_label = self._label(right, '', 9)
        self.engine_label.pack(anchor='w', pady=(10, 0))
        bottom = tk.Frame(self, bg=BG, padx=24, pady=12)
        bottom.pack(fill='x')
        self.progress = ttk.Progressbar(bottom, mode='indeterminate', length=100)
        self.progress.pack(side='right')
        tk.Label(bottom, textvariable=self.status, bg=BG, fg=MUTED, anchor='w',
                 font=('Microsoft YaHei UI', 10)).pack(side='left', fill='x', expand=True)

    def _label(self, parent, text, size=10, bold=False):
        return tk.Label(parent, text=text, bg=PANEL, fg=TEXT if bold else MUTED, justify='left',
                        font=('Microsoft YaHei UI', size, 'bold' if bold else 'normal'))

    def visible(self):
        result = self.rows
        if self.group.get() != '全部照片':
            result = [p for p in result if self.group_labels.get(p['group_id']) == self.group.get()]
        state = {'待选': 'pending', '已保留': 'keep', '已排除': 'reject'}.get(self.filter.get())
        if state:
            result = [p for p in result if p['decision'] == state]
        if self.filter.get() == '完全重复':
            result = [p for p in result if p['duplicate_of']]
        return result

    def refresh(self, select_id=None):
        # Flush before querying: an empty filter must not discard pending edits.
        self.flush_edit()
        self.rows = self.catalog.photos()
        self.group_labels = {}
        for photo in self.rows:
            key = photo['group_id']
            if key not in self.group_labels:
                stamp = datetime.fromtimestamp(photo['captured']).strftime('%m-%d %H:%M')
                self.group_labels[key] = f'第 {len(self.group_labels) + 1} 组 · {stamp}'
        self.group_combo.configure(values=['全部照片', *self.group_labels.values()])
        if self.group.get() not in self.group_combo['values']:
            self.group.set('全部照片')
        self.summary.configure(text=f'{len(self.rows)} 张照片 / {len(self.group_labels)} 组 / {sum(p["decision"] == "keep" for p in self.rows)} 张保留')
        self.tree.delete(*self.tree.get_children())
        visible = self.visible()
        for photo in visible:
            state = {'pending': '待选', 'keep': '保留', 'reject': '排除'}[photo['decision']]
            self.tree.insert('', 'end', iid=str(photo['id']), text=('≡ ' if photo['duplicate_of'] else '') + photo['name'],
                             values=(photo['score'], state))
        target = select_id or (self.current['id'] if self.current else None)
        if visible:
            key = str(target if any(p['id'] == target for p in visible) else visible[0]['id'])
            self.tree.selection_set(key)
            self.tree.focus(key)
            self.tree.see(key)
        else:
            self.current = None
            self.preview_serial += 1
            self.canvas.delete('all')
            self.canvas.create_text(30, 36, anchor='nw', text='导入照片开始，或切换筛选条件。', fill=MUTED,
                                    font=('Microsoft YaHei UI', 14))
            self.title_label.configure(text='把一组照片，变成一组作品。')
        caps = capabilities()
        self.engine_label.configure(text=f'RAW: {caps["raw_backend"] or "未安装"}\nHEIC: {"可用" if caps["heic"] else "未安装"}')

    def select(self, _event=None):
        selected = self.tree.selection()
        if not selected:
            return
        target = int(self.tree.focus() or selected[0])
        photo = next((p for p in self.rows if p['id'] == target), None)
        if not photo:
            return
        self.flush_edit()
        self.current = photo
        self.loading_controls = True
        self.style_name.set(STYLES[photo['recipe']['style']])
        for key, variable in self.variables.items():
            variable.set(photo['recipe'][key])
        self.loading_controls = False
        self.title_label.configure(text=photo['name'])
        timestamp = datetime.fromtimestamp(photo['captured']).strftime('%Y-%m-%d %H:%M')
        self.detail.configure(text=f'{photo["width"]} × {photo["height"]}   /   {timestamp} '
                              f'({"EXIF" if photo["time_source"] == "exif" else "文件时间"})   /   评分 {photo["score"]}')
        self.preview()

    def recipe(self):
        return {**(self.current['recipe'] if self.current else DEFAULT_RECIPE),
                'style': next(k for k, v in STYLES.items() if v == self.style_name.get()),
                **{key: value.get() for key, value in self.variables.items()}}

    def raw_settings(self):
        if self.busy or not self.current:
            return
        if Path(self.current['path']).suffix.lower() not in RAW:
            messagebox.showinfo('RAW 专业显影', '请先选中相机 RAW 照片。普通图片继续使用右侧调色。')
            return
        if not capabilities()['raw']:
            messagebox.showerror('缺少 RAW 引擎', '未找到 RawTherapee；请查看 README 的引擎安装说明。')
            return
        self.flush_edit()
        dialog = tk.Toplevel(self)
        dialog.title('RAW 专业显影 · RawTherapee')
        dialog.configure(bg=PANEL, padx=24, pady=20)
        dialog.resizable(False, False)
        dialog.transient(self)
        dialog.grab_set()
        self._label(dialog, 'RAW 专业显影', 14, True).grid(row=0, column=0, columnspan=2, sticky='w', pady=(0, 12))
        modes = {'camera': '相机白平衡', 'auto': '自动白平衡', 'custom': '自定义色温'}
        mode = tk.StringVar(value=modes[self.current['recipe']['raw_wb']])
        self._label(dialog, '白平衡模式').grid(row=1, column=0, sticky='w', padx=(0, 16))
        ttk.Combobox(dialog, textvariable=mode, values=list(modes.values()), state='readonly', width=23).grid(row=1, column=1, pady=6)
        fields = [('raw_exposure', '显影曝光 / EV', -5, 5, .1),
                  ('raw_temperature', '色温 / K（自定义时生效）', 2000, 25000, 100),
                  ('raw_tint', '绿色倍率（自定义时生效）', .2, 5, .05),
                  ('raw_highlights', '高光压缩', 0, 100, 5),
                  ('raw_denoise', '亮度 / 色彩降噪', 0, 100, 5),
                  ('raw_sharpen', 'USM 锐化强度', 0, 300, 10)]
        values = {}
        for row, (key, label, low, high, step) in enumerate(fields, 2):
            self._label(dialog, label).grid(row=row, column=0, sticky='w', padx=(0, 16))
            values[key] = tk.StringVar(value=str(self.current['recipe'][key]))
            ttk.Spinbox(dialog, from_=low, to=high, increment=step, textvariable=values[key], width=23).grid(row=row, column=1, pady=6)
        self._label(dialog, '专业显影先于基础调色；修改后重新显影需数秒。\nTIFF 保留 16-bit；窗口预览为 SDR 8-bit。', 9).grid(row=8, column=0, columnspan=2, sticky='w', pady=14)
        def save():
            try:
                recipe = {**self.current['recipe'], **{key: float(value.get()) for key, value in values.items()},
                          'raw_wb': next(key for key, label in modes.items() if label == mode.get())}
                self.catalog.edit([self.current['id']], recipe=recipe)
            except ValueError as exc:
                messagebox.showerror('参数无效', str(exc), parent=dialog)
                return
            dialog.destroy()
            self.refresh()
            self.status.set('RAW 参数已保存，正在重新显影；原图保持只读')
        ttk.Button(dialog, text='保存并重新显影', command=save, style='Accent.TButton').grid(row=9, column=0, columnspan=2, sticky='ew')

    def open_studio(self):
        if self.busy:
            return
        self.flush_edit()
        try:
            engine.launch_studio(self.data_dir, self.current['path'] if self.current else None)
            self.status.set('已打开 RawTherapee 原生工作台；可用“外部编辑器”发送显影结果到出片扩展')
        except (ValueError, OSError) as exc:
            messagebox.showerror('专业工作台启动失败', str(exc))

    def changed(self, *_):
        if self.loading_controls or not self.current or self.busy:
            return
        if self.save_timer:
            self.after_cancel(self.save_timer)
        self.save_timer = self.after(300, self.flush_edit)

    def flush_edit(self):
        if self.save_timer:
            self.after_cancel(self.save_timer)
            self.save_timer = None
            if self.current:
                recipe = self.recipe()
                if recipe != self.current['recipe']:
                    self.catalog.edit([self.current['id']], recipe=recipe)
                    self.current['recipe'] = recipe
                    self.status.set('调整已自动保存 · 原图未修改')
                    self.preview()

    def resize_preview(self, _event=None):
        if self.resize_timer:
            self.after_cancel(self.resize_timer)
        self.resize_timer = self.after(180, self.preview)

    def preview(self, original=False):
        self.resize_timer = None
        if not self.current:
            return
        self.preview_serial += 1
        serial = self.preview_serial
        if self.preview_future:
            self.preview_future.cancel()
        photo = self.current.copy()
        recipe = DEFAULT_RECIPE if original else photo['recipe'].copy()
        size = (max(200, self.canvas.winfo_width() - 44), max(200, self.canvas.winfo_height() - 44))
        def draw(image):
            if serial != self.preview_serial:
                return
            self.tk_image = ImageTk.PhotoImage(image)
            self.canvas.delete('all')
            self.canvas.create_image(self.canvas.winfo_width() // 2, self.canvas.winfo_height() // 2, image=self.tk_image)
        self.preview_future = self.submit(lambda: render_image(photo['path'], recipe, size), draw, busy=False)

    def choose_files(self):
        if not self.busy:
            paths = filedialog.askopenfilenames(title='选择照片', filetypes=[('图片', ' '.join('*' + s for s in sorted(SUPPORTED))), ('所有文件', '*.*')])
            if paths:
                self.import_paths(paths)

    def choose_folder(self):
        if self.busy:
            return
        folder = filedialog.askdirectory(title='选择照片文件夹（包含子文件夹）')
        if folder:
            self.import_paths([p for p in Path(folder).rglob('*') if p.is_file() and p.suffix.lower() in SUPPORTED])

    def import_paths(self, paths):
        if self.busy:
            return
        self.flush_edit()
        paths = list(paths)
        if not paths:
            self.status.set('没有找到支持的照片')
            return
        def work():
            catalog = Catalog(self.data_dir / 'library.sqlite')
            try:
                return catalog.import_files(paths, lambda n, total: self.events.put(('status', f'正在分析 {n}/{total}')))
            finally:
                catalog.close()
        def done(result):
            rows, errors = result
            self.refresh()
            self.status.set(f'导入完成：新增 {len(rows)} 张，失败 {len(errors)} 张；时间分组已更新')
            if errors:
                (self.data_dir / 'import-errors.json').write_text(json.dumps(errors, ensure_ascii=False, indent=2), encoding='utf-8')
                messagebox.showwarning('部分照片未导入', '\n'.join(f'{Path(e["path"]).name}: {e["error"]}' for e in errors[:5]) + '\n完整记录保存在 data/import-errors.json')
        self.status.set(f'准备导入 {len(paths)} 张照片…')
        self.submit(work, done)

    def decide(self, decision):
        if self.busy:
            return
        self.flush_edit()
        ids = [int(key) for key in self.tree.selection()]
        if ids:
            self.catalog.edit(ids, decision=decision)
            self.refresh(select_id=ids[0])
            self.status.set(f'已更新 {len(ids)} 张照片的选片状态')

    def recommend(self):
        if self.busy:
            return
        self.flush_edit()
        groups = {}
        for photo in self.visible():
            if photo['decision'] == 'pending' and not photo['duplicate_of']:
                groups.setdefault(photo['group_id'], []).append(photo)
        ids = []
        for photos in groups.values():
            ranked = sorted(photos, key=lambda p: p['score'], reverse=True)
            ids.extend(p['id'] for p in ranked[:max(1, (len(ranked) + 2) // 3)])
        if ids:
            self.catalog.edit(ids, decision='keep')
            self.refresh()
        self.status.set(f'推荐保留 {len(ids)} 张；其余照片仍为待选，可撤销')

    def apply_group(self):
        if self.current and not self.busy:
            self.flush_edit()
            ids = [p['id'] for p in self.rows if p['group_id'] == self.current['group_id']]
            self.catalog.edit(ids, recipe=self.recipe())
            self.refresh()
            self.status.set(f'配方已同步到本组 {len(ids)} 张照片；逐张光线适配尚未实现')

    def reset(self):
        if self.current and not self.busy:
            self.flush_edit()
            self.catalog.edit([self.current['id']], recipe=DEFAULT_RECIPE)
            self.refresh()

    def undo(self):
        if not self.busy:
            self.flush_edit()
            restored = self.catalog.undo()
            self.refresh()
            self.status.set('已撤销上次修改' if restored else '没有可撤销的修改')

    def export(self):
        if self.busy:
            return
        self.flush_edit()
        candidates = self.visible()
        raw16 = self.export_format.get().startswith('RAW')
        if raw16:
            candidates = [p for p in candidates if Path(p['path']).suffix.lower() in RAW]
        kept = [p for p in candidates if p['decision'] == 'keep']
        photos = kept or [p for p in candidates if p['decision'] != 'reject']
        if not photos:
            messagebox.showinfo('导出作品', '请先导入照片，并检查筛选条件。')
            return
        folder = filedialog.askdirectory(title=f'为 {len(photos)} 张作品选择导出目录')
        if not folder:
            return
        template = next(k for k, v in TEMPLATES.items() if v == self.template.get())
        size = int(self.export_size.get())
        def work():
            outputs, errors = [], []
            for index, photo in enumerate(photos):
                try:
                    outputs.append(str(export_raw_tiff(photo, folder) if raw16 else export_photo(photo, folder, template, size)))
                except Exception as exc:
                    errors.append(f'{photo["name"]}: {exc}')
                self.events.put(('status', f'正在导出 {index + 1}/{len(photos)}'))
            return outputs, errors
        def done(result):
            outputs, errors = result
            self.status.set(f'导出完成：成功 {len(outputs)} 张，失败 {len(errors)} 张 · {folder}')
            if errors:
                messagebox.showwarning('导出问题', '\n'.join(errors[:8]))
            else:
                messagebox.showinfo('作品已导出', f'{len(outputs)} 张作品已保存到\n{folder}\n同时保存了{ " PP3 专业显影参数" if raw16 else "可读的编辑配方"}。')
        self.submit(work, done)

    def submit(self, work, done, busy=True):
        if busy:
            self.busy = True
            self._toggle_controls(True)
            self.progress.start(12)
        future = self.pool.submit(work)
        future.add_done_callback(lambda result: self.events.put(('done', result, done, busy)))
        return future

    def _toggle_controls(self, disabled):
        def walk(parent):
            for widget in parent.winfo_children():
                if isinstance(widget, (ttk.Button, ttk.Combobox, ttk.Scale)):
                    widget.state(['disabled'] if disabled else ['!disabled'])
                walk(widget)
        walk(self)

    def _poll(self):
        try:
            while True:
                event = self.events.get_nowait()
                if event[0] == 'status':
                    self.status.set(event[1])
                    continue
                _, future, done, busy = event
                if busy:
                    self.busy = False
                    self._toggle_controls(False)
                    self.progress.stop()
                if future.cancelled():
                    continue
                try:
                    done(future.result())
                except Exception as exc:
                    self.status.set(f'处理失败：{exc}')
                    if busy:
                        messagebox.showerror('处理失败', str(exc))
        except queue.Empty:
            pass
        self.after(60, self._poll)

    def close(self):
        if self.busy:
            messagebox.showinfo('正在处理', '请等待当前导入或导出完成后关闭。')
            return
        self.flush_edit()
        self.preview_serial += 1
        self.pool.shutdown(wait=False, cancel_futures=True)
        self.catalog.close()
        self.destroy()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Photo All desktop')
    parser.add_argument('--data-dir', type=Path, default=os.environ.get('PHOTOALL_DATA_DIR'), help='Override catalog location')
    parser.add_argument('--studio', action='store_true', help='Open the upstream RawTherapee frontend')
    parser.add_argument('--receive', nargs='+', type=Path, help='Receive developed images from the native editor')
    args = parser.parse_args()
    if args.studio:
        try:
            engine.launch_studio(args.data_dir or Path(__file__).parent / 'data')
        except (ValueError, OSError) as exc:
            raise SystemExit(str(exc))
    else:
        app = PhotoApp(args.data_dir)
        if args.receive:
            app.after(150, lambda: app.import_paths(args.receive))
        app.mainloop()
