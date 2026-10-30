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
async function verifyAlbumCovers(page) {
  script(`
import sys
from pathlib import Path
from PIL import Image
sys.path.insert(0,r'${path.join(root, "product")}')
import engine
p=Path(r'${output}');(p/'cover-input').mkdir();c=engine.Catalog(p/'data'/'library.sqlite')
cases=[('封面单竖',['portrait']),('封面单横',['landscape']),('封面双混',['portrait','landscape']),('封面双竖',['portrait','portrait']),('封面三混',['portrait','landscape','portrait']),('封面三横',['landscape','landscape','landscape'])]
for n,(name,kinds) in enumerate(cases):
 a=c.create_album(name)
 for i,kind in enumerate(kinds):
  size=(360,1200) if kind=='portrait' else (1600,400)
  f=p/'cover-input'/f'cover-{n}-{i}.png';Image.new('RGB',size,(65+n*23,100+i*45,160+n*8)).save(f);c.import_files([f],album_id=a['id'])
c.close()
`);
  await page.reload();
  await page
    .getByRole("button", { name: "打开图集 封面三横", exact: true })
    .waitFor();
  const measurements = [];
  for (const width of [1080, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const covers = page.locator(".album-cover");
    for (let index = 0; index < (await covers.count()); index++) {
      const cover = covers.nth(index);
      await cover.scrollIntoViewIfNeeded();
      await until(
        () =>
          cover.evaluate((el) =>
            Array.from(el.querySelectorAll(".picture")).every(
              (p) => p.querySelector("img")?.naturalWidth > 0,
            ),
          ),
        "cover images decoded",
      );
    }
    await capture({
      path: path.join(output, `09-covers-${width}.png`),
      fullPage: true,
    });
    const sizes = await page.evaluate(() => {
      const art = document
        .querySelector(".new-album-art")
        .getBoundingClientRect();
      return Array.from(document.querySelectorAll(".album-cover")).map((el) => {
        const cover = el.getBoundingClientRect();
        return {
          name: el.closest(".album-card").querySelector(".album-title strong")
            .textContent,
          width: cover.width,
          height: cover.height,
          art_width: art.width,
          art_height: art.height,
          pictures: Array.from(el.querySelectorAll(".picture")).map((p) => {
            const b = p.getBoundingClientRect();
            return {
              x: b.x - cover.x,
              y: b.y - cover.y,
              width: b.width,
              height: b.height,
            };
          }),
        };
      });
    });
    for (const cover of sizes) {
      assert(
        Math.abs(cover.width - cover.art_width) < 1 &&
          Math.abs(cover.height - cover.art_height) < 1,
        `Album cover disagrees with new-album art at ${width}px: ${JSON.stringify(cover)}`,
      );
      assert(
        Math.abs(cover.height - cover.width / 1.55) < 1,
        `Portrait pixels stretched the album cover at ${width}px: ${JSON.stringify(cover)}`,
      );
      assert(
        cover.pictures.every(
          (p) =>
            p.x >= 0 &&
            p.y >= 0 &&
            p.x + p.width <= cover.width + 1 &&
            p.y + p.height <= cover.height + 1,
        ),
        "Cover image escaped its frame: " + cover.name,
      );
      const [first, second, third] = cover.pictures;
      if (first)
        assert(
          Math.abs(first.y + first.height - (cover.height - 5)) < 2,
          "First cover image must fill its column: " + cover.name,
        );
      if (second)
        assert(
          second.x >= first.x + first.width && Math.abs(second.y - first.y) < 1,
          "Second cover image must start in the right column: " + cover.name,
        );
      if (third)
        assert(
          third.y >= second.y + second.height &&
            Math.abs(third.x - second.x) < 1,
          "Third cover image must occupy the lower right cell: " + cover.name,
        );
    }
    measurements.push({ viewport_width: width, covers: sizes });
  }
  return measurements;
}
async function verifyVariantFlow(page) {
  script(`
import sys,shutil
from pathlib import Path
from PIL import Image
sys.path.insert(0,r'${path.join(root, "product")}')
import engine
p=Path(r'${output}');(p/'variant-input').mkdir();engine.RAW_CACHE=p/'data'/'raw-cache'
raw=p/'variant-input'/'paired.NEF';jpeg=p/'variant-input'/'paired.jpg'
shutil.copyfile(r'${path.join(root, "validation/inputs/D7000.NEF")}',raw)
Image.new('RGB',(640,400),'#4587a1').save(jpeg)
c=engine.Catalog(p/'data'/'library.sqlite');a=c.create_album('格式配对');b=c.create_album('仅JPEG');d=c.create_album('仅RAW')
c.import_files([raw,jpeg],album_id=a['id']);c.import_files([jpeg],album_id=b['id']);c.import_files([raw],album_id=d['id'])
assert len([x for x in c.photos() if a['id'] in x['album_ids']])==2
c.close()
`);
  await page.reload();
  const pair = page.getByRole("button", {
    name: "打开图集 格式配对",
    exact: true,
  });
  const jpegOnly = page.getByRole("button", {
    name: "打开图集 仅JPEG",
    exact: true,
  });
  const rawOnly = page.getByRole("button", {
    name: "打开图集 仅RAW",
    exact: true,
  });
  await pair.waitFor();
  const home = page.getByLabel("图集封面格式偏好", { exact: true });
  await home.selectOption("raw");
  await until(
    async () =>
      (await pair.locator(".album-count").textContent()).includes("1 张"),
    "RAW cover count",
  );
  await jpegOnly.scrollIntoViewIfNeeded();
  await until(
    async () => (await jpegOnly.locator('img[alt="paired.jpg"]').count()) === 1,
    "album-local JPEG cover survives RAW preference",
  );
  await rawOnly.scrollIntoViewIfNeeded();
  await until(
    async () => (await rawOnly.locator('img[alt="paired.NEF"]').count()) === 1,
    "unpaired RAW cover",
  );
  await pair.scrollIntoViewIfNeeded();
  await until(
    async () =>
      (await pair.locator('img[alt="paired.NEF"]').count()) === 1 &&
      (await pair.locator('img[alt="paired.jpg"]').count()) === 0,
    "paired RAW cover",
  );
  await home.selectOption("jpeg");
  await until(
    async () =>
      (await pair.locator('img[alt="paired.jpg"]').count()) === 1 &&
      (await pair.locator('img[alt="paired.NEF"]').count()) === 0,
    "paired JPEG cover",
  );
  assert(
    (await rawOnly.locator(".album-count").textContent()).includes("1 张"),
    "JPEG preference hid an album-local unpaired RAW",
  );
  await home.selectOption("all");
  await until(
    async () =>
      (await pair.locator(".album-count").textContent()).includes("2 张"),
    "all format cover count",
  );
  await home.selectOption("raw");
  await pair.click();
  await page.getByLabel("图集格式偏好", { exact: true }).waitFor();
  await until(
    async () => (await page.locator(".photo-card").count()) === 1,
    "library RAW preference",
  );
  await page.getByRole("button", { name: "电子观片台", exact: true }).click();
  const viewer = page.getByRole("dialog", { name: "电子观片台", exact: true });
  await viewer.waitFor();
  const selector = viewer.getByLabel("观片格式偏好", { exact: true });
  assert(
    (await selector.inputValue()) === "raw",
    "Viewer did not inherit RAW preference",
  );
  await until(
    async () =>
      (await viewer
        .getByLabel("跳转观片 paired.NEF", { exact: true })
        .count()) === 1 &&
      (await viewer
        .getByLabel("跳转观片 paired.jpg", { exact: true })
        .count()) === 0,
    "viewer RAW variant",
  );
  await selector.selectOption("jpeg");
  await until(
    async () =>
      (await viewer
        .getByLabel("跳转观片 paired.jpg", { exact: true })
        .count()) === 1 &&
      (await viewer
        .getByLabel("跳转观片 paired.NEF", { exact: true })
        .count()) === 0,
    "viewer JPEG variant from expanded review scope",
  );
  await selector.selectOption("all");
  await until(
    async () => (await viewer.locator(".lt-strip button").count()) === 2,
    "viewer all variants",
  );
  await until(
    () => viewer.locator(".film-table .lt-contact-frame .picture img").evaluateAll(images => images.length === 2 && images.every(image => image.complete && image.naturalWidth > 0)),
    "viewer source pixels decoded",
    60000,
  );
  await capture({ path: path.join(output, "10-viewer-variants.png") });
  await selector.selectOption("jpeg");
  await viewer.getByLabel("退出观片台", { exact: true }).click();
  await page.getByLabel("图集格式偏好", { exact: true }).waitFor();
  assert(
    (await page.getByLabel("图集格式偏好", { exact: true }).inputValue()) ===
      "jpeg",
    "Viewer preference was not shared back to the library",
  );
  await page.getByLabel("返回全部图集", { exact: true }).click();
  assert(
    (await page
      .getByLabel("图集封面格式偏好", { exact: true })
      .inputValue()) === "jpeg",
    "Home cover preference did not remain shared",
  );
  await pair.scrollIntoViewIfNeeded();
  await capture({
    path: path.join(output, "11-home-variant-covers.png"),
    fullPage: true,
  });
  return {
    actual_nef: true,
    album_local_pairing: true,
    cover_counts: true,
    shared_home_library_viewer_preference: true,
    review_scope_keeps_both_variants: true,
  };
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
  if (process.argv.includes("--covers-only")) {
    const covers = await verifyAlbumCovers(page);
    const report = { status: "passed", covers, browser_errors: errors };
    assert(!errors.length, errors.join("\n"));
    fs.writeFileSync(
      path.join(output, "report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify({ output, ...report }, null, 2));
    return;
  }
  if (process.argv.includes("--variants-only")) {
    const variants = await verifyVariantFlow(page);
    const report = { status: "passed", variants, browser_errors: errors };
    assert(!errors.length, errors.join("\n"));
    fs.writeFileSync(
      path.join(output, "report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify({ output, ...report }, null, 2));
    return;
  }
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
  const sidebar = page.locator(".sidebar");
  const drawerExpanded = () =>
    sidebar.locator(".drawer-toggle").getAttribute("aria-expanded");
  await page.mouse.move(500, 150);
  await page.mouse.move(25, 150);
  await page.waitForTimeout(45);
  await page.mouse.move(500, 150);
  await page.waitForTimeout(200);
  assert(
    (await drawerExpanded()) === "false",
    "Quick rail transit flashed the drawer",
  );
  await page.mouse.move(25, 150);
  await until(
    async () => (await drawerExpanded()) === "true",
    "hover intent opens drawer",
    2000,
  );
  await page.mouse.move(160, 550);
  await page.waitForTimeout(450);
  assert(
    (await drawerExpanded()) === "true",
    "Moving within the open drawer closed it",
  );
  await page.mouse.move(600, 550);
  await page.waitForTimeout(140);
  assert(
    (await drawerExpanded()) === "true",
    "Drawer closed without its leave delay",
  );
  await until(
    async () => (await drawerExpanded()) === "false",
    "pointer leave closes drawer",
    2000,
  );
  assert(
    await sidebar.evaluate((el) =>
      getComputedStyle(el).transitionProperty.includes("width"),
    ),
    "Drawer has no smooth closing transition",
  );
  await page.waitForTimeout(280);
  await sidebar.dispatchEvent("pointerenter", { pointerType: "touch" });
  await page.waitForTimeout(180);
  assert(
    (await drawerExpanded()) === "false",
    "Touch generated an unintended hover open",
  );
  await page.keyboard.press("Tab");
  await sidebar.locator(".drawer-toggle").focus();
  await until(
    async () => (await drawerExpanded()) === "true",
    "keyboard focus opens drawer",
    2000,
  );
  await page.mouse.move(600, 800);
  await page.waitForTimeout(500);
  assert(
    (await drawerExpanded()) === "true",
    "Sidebar keyboard focus was not retained",
  );
  await page.getByLabel("返回全部图集", { exact: true }).focus();
  await until(
    async () => (await drawerExpanded()) === "false",
    "focus leaving closes drawer",
    2000,
  );
  await page.mouse.move(25, 150);
  await until(
    async () => (await drawerExpanded()) === "true",
    "hover reopens drawer",
    2000,
  );
  await sidebar.getByTitle("图集", { exact: true }).click();
  await page.waitForTimeout(550);
  assert(
    (await drawerExpanded()) === "false",
    "Navigation close immediately reopened under the pointer",
  );
  await page.mouse.move(600, 100);
  await page.mouse.move(25, 150);
  await until(
    async () => (await drawerExpanded()) === "true",
    "drawer opens before Escape",
    2000,
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  assert(
    (await drawerExpanded()) === "false",
    "Escape close immediately reopened under the pointer",
  );
  await page.mouse.move(600, 100);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await until(
    async () =>
      await sidebar.evaluate((el) =>
        getComputedStyle(el)
          .transitionDuration.split(",")
          .every((v) => parseFloat(v) === 0),
      ),
    "reduced-motion disables drawer movement",
    2000,
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.getByLabel("展开导航", { exact: true }).click();
  await sidebar.locator(".drawer-toggle").click();
  await page.waitForTimeout(250);
  assert((await drawerExpanded()) === "false", "Manual collapse button failed");
  await page.mouse.move(600, 100);
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
  const covers = await verifyAlbumCovers(page);
  const variants = await verifyVariantFlow(page);
  assert(!errors.length, errors.join("\n"));
  const report = {
    status: "passed",
    layout,
    facet_count: 13,
    all_facets_exercised: true,
    linked_facets: true,
    hover_drawer: {
      intent_ms: 120,
      leave_ms: 350,
      quick_transit_no_flash: true,
      internal_pointer_retained: true,
      keyboard_focus_retained: true,
      touch_no_hover: true,
      reduced_motion: true,
    },
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
    covers,
    variants,
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
