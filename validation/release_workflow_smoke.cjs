// Isolated real-service release regression. Only the native folder dialog is stubbed.
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs"),
  path = require("node:path"),
  readline = require("node:readline");
const {
  chromium,
} = require("C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const root = path.resolve(__dirname, ".."),
  output = path.join(__dirname, "artifacts", "release-workflow-" + Date.now());
const python =
  "C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe";
fs.mkdirSync(output, { recursive: true });
function script(source) {
  const r = spawnSync(python, ["-c", source], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.status) throw Error(r.stderr || r.stdout);
  return r.stdout;
}
script(`
import sys,json,hashlib
from pathlib import Path
from PIL import Image
sys.path.insert(0,r'${path.join(root, "product")}')
import engine
p=Path(r'${output}');(p/'input').mkdir();c=engine.Catalog(p/'data'/'library.sqlite')
a=c.create_album('交付甲');b=c.create_album('交付乙')
rows=[('pending.jpg','blue','cool','dark','city','low','high',1735704000,a),('keep-a.jpg','blue','cool','bright','city','high','balanced',1735790400,a),('keep-b.png','red','warm','balanced','portrait','balanced','low',1735790400,a),('keep-c.png','orange','warm','balanced','plant','high','balanced',1735876800,a),('other.png','red','warm','bright','animal','low','high',1735876800,b)]
hashes={}
for i,(name,color,tone,brightness,content,saturation,contrast,captured,album) in enumerate(rows):
 f=p/'input'/name;im=Image.new('RGB',(640,400),{'blue':'#357dc4','red':'#de483b','orange':'#c68b51'}[color]);im.paste((180+i*10,220-i*10,150+i*10),(30,40,300,330));im.save(f)
 c.import_files([f],album_id=album['id']);photo=next(x for x in c.photos() if x['name']==name)
 c.save_features(photo['id'],{'color':color,'tone':tone,'brightness':brightness,'saturation':{'low':.08,'balanced':.3,'high':.7}[saturation],'contrast':{'low':.04,'balanced':.12,'high':.3}[contrast],'content':{'label':content,'score':.95,'candidates':[],'model':'release fixture'}})
 with c.db:c.db.execute('UPDATE photos SET decision=?,captured=? WHERE id=?',('pending' if i==0 else 'keep',captured,photo['id']))
 hashes[str(f.resolve())]=hashlib.sha256(f.read_bytes()).hexdigest()
c.close();(p/'source-hashes.json').write_text(json.dumps(hashes))
`);
// Pause between actual exports in the cancellation case, while checking the real token.
// The real service, exporter, pixel pipeline, files, and terminal job state stay intact.
const child = spawn(
  python,
  [
    "-u",
    "-c",
    `
import sys,json,time,secrets
from pathlib import Path
sys.path.insert(0,r'${path.join(root, "product")}')
import engine,service
original=engine.export_photo
def paced(photo,folder,*args,**kwargs):
 p=Path(folder)
 if p.name=='cancel-export' and any(p.glob('*.png')):
  deadline=time.time()+20
  while time.time()<deadline:
   kwargs['cancellation'].check();time.sleep(.03)
 return original(photo,folder,*args,**kwargs)
engine.export_photo=paced
server=service.create_server(Path(r'${path.join(output, "data")}'),secrets.token_urlsafe(32))
print(json.dumps({'port':server.server_port,'token':server.token}),flush=True)
try:server.serve_forever()
finally:server.server_close()
`,
  ],
  { windowsHide: true },
);
child.stderr.on("data", (d) => process.stderr.write(d));
let browser, page;
const errors = [],
  exportBodies = [],
  cancelledRequests = [];
async function until(fn, label = "condition", timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Timed out waiting for " + label);
}
function assert(value, message) {
  if (!value) throw Error(message);
}
async function capture(options) {
  // React Motion uses JS-driven opacity/transform transitions; wait before visual QA.
  await page.waitForTimeout(750);
  return page.screenshot(options);
}
(async () => {
  const connection = JSON.parse(
    await new Promise((resolve, reject) => {
      readline.createInterface({ input: child.stdout }).once("line", resolve);
      child.once("error", reject);
    }),
  );
  const call = async (route, body) => {
    const r = await fetch(`http://127.0.0.1:${connection.port}/api${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer " + connection.token,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await r.json();
    if (!r.ok) throw Error(value.error);
    return value;
  };
  const waitJob = async (id) => {
    let job;
    await until(async () => {
      job = await call("/jobs/" + id);
      return job.status !== "running";
    }, "job terminal state");
    return job;
  };
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST" && pathname === "/api/export")
      exportBodies.push(request.postDataJSON());
    if (
      request.method() === "POST" &&
      /\/api\/jobs\/[^/]+\/cancel$/.test(pathname)
    )
      cancelledRequests.push(pathname);
  });
  await page.goto(
    `http://127.0.0.1:1420/#port=${connection.port}&token=${connection.token}`,
  );
  await page
    .getByRole("button", { name: "打开图集 交付甲", exact: true })
    .waitFor();
  const initial = await call("/library"),
    pending = initial.photos.find((p) => p.name === "pending.jpg");
  assert(
    initial.photos.filter((p) => p.decision === "keep").length === 4,
    "Fixture must include four keeps and one pending",
  );
  assert(
    Math.abs((await page.locator(".sidebar").boundingBox()).width - 72) < 1,
    "Default rail is not 72px",
  );
  await page.getByLabel("展开导航", { exact: true }).click();
  assert(
    (await page
      .getByLabel("收起导航", { exact: true })
      .getAttribute("aria-expanded")) === "true",
    "Drawer did not open",
  );
  await capture({ path: path.join(output, "01-drawer.png") });
  await page.getByLabel("关闭导航抽屉", { exact: true }).click();
  await page
    .getByRole("button", { name: "打开图集 交付甲", exact: true })
    .click();
  await until(
    async () => (await page.locator(".photo-card").count()) === 4,
    "album photos",
  );
  assert(
    (await page
      .getByRole("button", { name: /多图层合成|打开合成/ })
      .count()) === 0,
    "Album composition entrance remains",
  );
  assert(
    await page
      .getByRole("button", { name: "导出作品", exact: true })
      .isDisabled(),
    "No-selection export must be disabled",
  );
  const layout = [];
  for (const width of [1080, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const box = await page
      .getByRole("region", { name: "风格筛选" })
      .boundingBox();
    const overflow = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth - innerWidth,
      panel:
        document.querySelector(".classification-panel").scrollWidth -
        document.querySelector(".classification-panel").clientWidth,
    }));
    assert(
      box.height < 90,
      "Collapsed classification must be below 90px: " + box.height,
    );
    assert(
      overflow.document <= 1 && overflow.panel <= 1,
      "Classification has horizontal overflow: " + JSON.stringify(overflow),
    );
    assert(
      (await page
        .getByRole("region", { name: "风格筛选" })
        .locator("select")
        .count()) === 4,
      "Collapsed classification should have four selectors",
    );
    layout.push({ width, collapsed_height: box.height, overflow });
    await capture({
      path: path.join(output, `02-compact-${width}.png`),
    });
  }
  await page.getByLabel("更多筛选", { exact: true }).click();
  const panel = page.getByRole("region", { name: "风格筛选" });
  assert(
    (await panel.locator("select").count()) === 13,
    "Expected all thirteen linked facets",
  );
  const facets = [
    "主色",
    "冷暖",
    "亮度",
    "内容",
    "日期",
    "饱和度",
    "对比度",
    "方向",
    "格式",
    "像素",
    "质量",
    "风格",
    "胶片",
  ];
  for (const name of facets) {
    const select = page.getByLabel(`按${name}分类`, { exact: true });
    const option = await select
      .locator("option")
      .evaluateAll(
        (options) => options.find((o) => o.value && !o.disabled)?.value,
      );
    assert(option, "Missing available facet option: " + name);
    const text = await select
      .locator("option")
      .evaluateAll(
        (options, value) => options.find((o) => o.value === value).textContent,
        option,
      );
    const expected = Number(text.split(" · ").at(-1));
    await select.selectOption(option);
    await until(
      async () => (await page.locator(".photo-card").count()) === expected,
      "facet " + name,
    );
    await select.selectOption("");
    await until(
      async () => (await page.locator(".photo-card").count()) === 4,
      "facet clear " + name,
    );
  }
  await page.getByLabel("按主色分类").selectOption("blue");
  await until(
    async () => (await page.locator(".photo-card").count()) === 2,
    "blue facet",
  );
  await until(
    async () =>
      await page
        .getByLabel("按内容分类")
        .locator('option[value="portrait"]')
        .evaluate((option) => option.disabled),
    "linked zero-count facet disabled",
  );
  await page.getByLabel("按内容分类").selectOption("city");
  await page.getByLabel("按日期分类").selectOption("2025-01-02");
  await until(
    async () => (await page.locator(".photo-card").count()) === 1,
    "linked date/color/content",
  );
  assert(
    (await page.locator('article[aria-label="照片 keep-a.jpg"]').count()) === 1,
    "Linked facets returned the wrong photo",
  );
  await capture({ path: path.join(output, "03-linked-filters.png") });
  await page.getByRole("button", { name: "清除全部", exact: true }).click();
  await page.getByLabel("更多筛选", { exact: true }).click();
  await page.getByLabel("返回全部图集", { exact: true }).click();
  await page
    .getByRole("button", { name: "删除图集 交付乙", exact: true })
    .click();
  await until(
    async () => (await call("/library")).trash_albums.length === 1,
    "trash album",
  );
  let library = await call("/library"),
    trashed = library.trash_albums[0];
  assert(
    Math.abs(trashed.purge_at - trashed.trashed_at - 30 * 86400) < 1,
    "Trash retention is not thirty days",
  );
  assert(
    !library.albums.some((a) => a.id === trashed.id),
    "Trashed album remains active",
  );
  await page.getByLabel("打开回收站", { exact: true }).click();
  await page.getByRole("heading", { name: "回收站", exact: true }).waitFor();
  await page.getByText("剩余 30 天", { exact: false }).waitFor();
  await capture({ path: path.join(output, "04-trash.png") });
  await page
    .getByRole("button", { name: "还原图集 交付乙", exact: true })
    .click();
  await until(
    async () => (await call("/library")).trash_albums.length === 0,
    "restored album",
  );
  await page.getByLabel("返回全部图集", { exact: true }).click();
  await page
    .getByRole("button", { name: "打开图集 交付乙", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "打开图集 交付甲", exact: true })
    .click();
  await page.locator('article[aria-label="照片 pending.jpg"]').click();
  // The connection is already cached. Stub only the OS folder selection boundary.
  const chooseFolder = async (folder) =>
    page.evaluate((folder) => {
      globalThis.isTauri = true;
      globalThis.__TAURI_INTERNALS__ = {
        invoke: (command) => {
          if (command === "pick_folder") return Promise.resolve(folder);
          throw Error("Unexpected native invocation: " + command);
        },
      };
    }, folder);
  const startExport = async (folder, album = false, screenshot) => {
    await chooseFolder(folder);
    await page.getByRole("button", { name: "导出作品", exact: true }).click();
    await page.getByLabel("导出格式", { exact: true }).selectOption("png");
    await page
      .getByLabel("全部导出到同一个文件夹", { exact: true })
      .setChecked(!album);
    if (screenshot) await capture({ path: path.join(output, screenshot) });
    const response = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        new URL(r.url()).pathname === "/api/export",
    );
    await page
      .getByRole("button", { name: "选择位置并导出", exact: true })
      .click();
    return (await (await response).json()).id;
  };
  // A previous incompatible format must never lock the dialog entrance.
  await page.getByRole("button", { name: "导出作品", exact: true }).click();
  await page.getByLabel("导出格式", { exact: true }).selectOption("tiff16");
  assert(
    await page
      .getByRole("button", { name: "选择位置并导出", exact: true })
      .isDisabled(),
    "JPEG cannot be exported as a RAW master",
  );
  await page.getByLabel("关闭导出", { exact: true }).click();
  assert(
    await page
      .getByRole("button", { name: "导出作品", exact: true })
      .isEnabled(),
    "An incompatible previous format locked the export entrance",
  );
  await page.getByRole("button", { name: "导出作品", exact: true }).click();
  assert(
    (await page.getByLabel("导出格式", { exact: true }).inputValue()) ===
      "tiff16",
    "The regression must exercise persisted RAW format state",
  );
  await page.getByLabel("导出格式", { exact: true }).selectOption("png");
  await page.getByLabel("关闭导出", { exact: true }).click();
  const one = await startExport(
    path.join(output, "pending-export"),
    false,
    "05-selected-export.png",
  );
  const single = await waitJob(one);
  assert(
    single.status === "done" && single.result.outputs.length === 1,
    "Selected pending must produce exactly one output",
  );
  assert(
    exportBodies.at(-1).ids.length === 1 &&
      exportBodies.at(-1).ids[0] === pending.id,
    "UI exported keeps instead of the selected pending photo",
  );
  assert(
    path.basename(single.result.outputs[0]).startsWith("pending"),
    "The wrong photo was exported",
  );
  await until(
    async () =>
      await page
        .getByRole("button", { name: "导出作品", exact: true })
        .isEnabled(),
    "export idle",
  );
  await page.getByTitle("全部照片", { exact: true }).click();
  await until(
    async () => (await page.locator(".photo-card").count()) === 5,
    "all photos",
  );
  await page.locator('article[aria-label="照片 pending.jpg"]').click();
  await page
    .locator('article[aria-label="照片 other.png"]')
    .click({ modifiers: ["Control"] });
  const splitId = await startExport(
    path.join(output, "album-export"),
    true,
    "06-album-folders.png",
  );
  const split = await waitJob(splitId),
    splitBody = exportBodies.at(-1);
  assert(
    split.status === "done" && split.result.outputs.length === 2,
    "Two-album export did not finish",
  );
  assert(
    splitBody.folder_mode === "album" &&
      splitBody.ids.length === 2 &&
      !splitBody.album_ids,
    "Multi-album directory selection payload is wrong",
  );
  assert(
    new Set(split.result.outputs.map((file) => path.dirname(file))).size === 2,
    "Album exports did not create separate directories",
  );
  await until(
    async () =>
      await page
        .getByRole("button", { name: "导出作品", exact: true })
        .isEnabled(),
    "split export idle",
  );
  await page.getByRole("button", { name: "取消选择", exact: true }).click();
  await page.getByRole("button", { name: "选择 5 张", exact: true }).click();
  const cancelId = await startExport(path.join(output, "cancel-export"));
  await until(
    async () => (await call("/jobs/" + cancelId)).done === 1,
    "first real completed output",
  );
  await page.getByLabel("终止导出", { exact: true }).waitFor();
  await capture({ path: path.join(output, "07-cancel-running.png") });
  await page.getByLabel("终止导出", { exact: true }).click();
  const cancelled = await waitJob(cancelId);
  assert(
    cancelledRequests.includes(`/api/jobs/${cancelId}/cancel`),
    "Cancel UI did not target the current job",
  );
  assert(
    cancelled.status === "cancelled" &&
      cancelled.done === 1 &&
      cancelled.result.outputs.length === 1,
    "Cancel terminal result or completed count is wrong",
  );
  await page
    .getByRole("status")
    .filter({ hasText: "导出已终止，已完成 1 张" })
    .waitFor();
  assert(
    fs
      .readdirSync(path.join(output, "cancel-export"))
      .filter((f) => f.endsWith(".png")).length === 1,
    "Cancel changed completed output count",
  );
  await capture({ path: path.join(output, "08-cancelled.png") });
  const precision = JSON.parse(
    script(`
import sys,json,hashlib
from pathlib import Path
import numpy as np
sys.path.insert(0,r'${path.join(root, "product")}')
import engine,pixels,png
p=Path(r'${output}');c=engine.Catalog(p/'data'/'library.sqlite');photo=next(x for x in c.photos() if x['name']=='pending.jpg');c.close()
f=next((p/'pending-export').glob('*.png'))
with f.open('rb') as stream:w,h,rows,info=png.Reader(file=stream).asDirect();assert info['bitdepth']==16
actual=pixels.read(f);expected=engine.render_pixels(photo['path'],photo['recipe'])
np.testing.assert_array_equal(np.rint(actual*65535).astype('uint16'),np.rint(expected*65535).astype('uint16'))
for source,digest in json.loads((p/'source-hashes.json').read_text()).items():assert hashlib.sha256(Path(source).read_bytes()).hexdigest()==digest
print(json.dumps({'bits':16,'float_pipeline_match':True,'sources_unchanged':True}))
`),
  );
  assert(!errors.length, errors.join("\n"));
  const report = {
    status: "passed",
    layout,
    facet_count: 13,
    all_facets_exercised: true,
    linked_facets: true,
    incompatible_format_dialog_reopens: true,
    trash_retention_days: 30,
    trash_restore: true,
    selected_pending_export: {
      ids: exportBodies[0].ids,
      outputs: single.result.outputs.length,
    },
    album_directories: split.result.outputs,
    cancel: {
      id: cancelId,
      status: cancelled.status,
      done: cancelled.done,
      outputs: cancelled.result.outputs.length,
      ui_targeted_current_job: true,
    },
    precision,
    browser_errors: errors,
  };
  fs.writeFileSync(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify({ output, ...report }, null, 2));
})()
  .catch(async (error) => {
    console.error(error);
    if (page) {
      await page
        .screenshot({ path: path.join(output, "failure.png") })
        .catch(() => {});
      fs.writeFileSync(
        path.join(output, "failure.html"),
        await page.content().catch(() => ""),
      );
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    if (browser) await browser.close();
    child.kill();
  });
