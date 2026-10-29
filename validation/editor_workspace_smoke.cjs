// Real-service precision workspace: composition, tone, curves, HSL and 16-bit export.
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs"),
  path = require("node:path"),
  readline = require("node:readline");
const {
  chromium,
} = require("C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const root = path.resolve(__dirname, "..");
const output = path.join(
  __dirname,
  "artifacts",
  "editor-workspace-" + Date.now(),
);
const python =
  process.env.PHOTOALL_PYTHON ||
  "C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe";
fs.mkdirSync(output, { recursive: true });
function script(source) {
  const result = spawnSync(python, ["-c", source], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status) throw Error(result.stderr || result.stdout);
  return result.stdout;
}
script(`
import sys,hashlib,json
from pathlib import Path
import numpy as np
sys.path.insert(0,r'${path.join(root, "product")}')
import engine,pixels
p=Path(r'${output}');(p/'input').mkdir();y,x=np.indices((240,400))
image=np.stack([x/399,y/239,(x+y)/638],axis=-1).astype(np.float32)
source=p/'input'/'precise.png';pixels.write(source,image,'png16')
c=engine.Catalog(p/'data'/'library.sqlite');a=c.create_album('编辑器验证');c.import_files([source],album_id=a['id']);c.close()
(p/'source-hash.txt').write_text(hashlib.sha256(source.read_bytes()).hexdigest())
`);
const child = spawn(
  python,
  [
    "-u",
    path.join(root, "product/service.py"),
    "--data-dir",
    path.join(output, "data"),
  ],
  { windowsHide: true },
);
child.stderr.on("data", (d) => process.stderr.write(d));
let browser;
async function until(fn, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw Error("Precision editor verification timed out");
}
async function waitReady(editor) {
  await until(
    async () =>
      (await editor
        .locator(".comparison-edited")
        .getAttribute("data-geometry-ready")) === "true",
  );
}
async function verifyReadiness(page, editor, current) {
  await editor.getByRole("button", { name: "构图", exact: true }).click();
  await waitReady(editor);
  let releaseSave,
    releasePixels,
    saveHeld = true,
    pixelsHeld = true,
    pixelRequests = 0;
  const saveGate = new Promise((r) => (releaseSave = r));
  const pixelGate = new Promise((r) => (releasePixels = r));
  await page.route("**/api/edit", async (route) => {
    if (saveHeld) await saveGate;
    return route.continue();
  });
  await page.route("**/api/image/**", async (route) => {
    if (pixelsHeld && route.request().url().includes("quality=source")) {
      pixelRequests++;
      await pixelGate;
    }
    return route.continue();
  });
  await editor.getByLabel("顺时针旋转90度").click();
  await editor.getByRole("button", { name: "移动与缩放", exact: true }).click();
  const composition = editor.getByRole("button", { name: "构图", exact: true });
  await composition.click();
  await page.waitForTimeout(120);
  if ((await composition.getAttribute("aria-pressed")) === "true")
    throw Error("Composition opened before its geometry save was acknowledged");
  saveHeld = false;
  releaseSave();
  await until(
    async () => (await composition.getAttribute("aria-pressed")) === "true",
  );
  await until(
    async () =>
      (await current()).recipe.quarter_turns === 1 && pixelRequests > 0,
  );
  const staleDimensions = await editor
    .locator(".comparison-edited img")
    .evaluate((image) => [image.naturalWidth, image.naturalHeight]);
  if (staleDimensions[0] !== 400 || staleDimensions[1] !== 240)
    throw Error("The fixture did not exercise the old-pixel fallback window");
  const before = await editor.locator(".ew-crop-rect").getAttribute("style");
  let box = await editor.getByLabel("裁剪画框").boundingBox();
  let handle = await editor.locator(".ew-crop-handle.se").boundingBox();
  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7);
  await page.mouse.up();
  if ((await editor.locator(".ew-crop-rect").getAttribute("style")) !== before)
    throw Error("Stale pixels accepted crop coordinates");
  // An aspect selection may create a draft, but applying it must still be gated.
  await editor.getByLabel("裁剪比例").selectOption("1");
  await editor.getByLabel("应用裁剪", { exact: true }).click();
  await page.waitForTimeout(400);
  if (
    (await current()).recipe.crop_w !== 1 ||
    (await editor.getByLabel("裁剪画框").count()) !== 1
  )
    throw Error(
      "Crop was applied before the uncropped geometry pixels were ready",
    );
  pixelsHeld = false;
  releasePixels();
  await waitReady(editor);
  await editor.getByLabel("应用裁剪", { exact: true }).click();
  await until(async () => (await current()).recipe.crop_h < 0.9);
  await editor.getByLabel("撤销上次修改", { exact: true }).click();
  await until(async () => (await current()).recipe.crop_h === 1);
  return {
    save_gate: true,
    acknowledged_but_stale_pixels_gate: true,
    crop_gate: true,
    ready_canvas_accepts_crop: true,
  };
}
async function verifyInspector(page, editor, current, output) {
  for (const height of [720, 620, 1020]) {
    await page.setViewportSize({ width: 1540, height });
    for (const name of ["亮度曝光", "白场", "中间调伽马"]) {
      const input = editor.getByRole("slider", { name, exact: true });
      await input.scrollIntoViewIfNeeded();
      const bounds = await input.boundingBox();
      const footer = await editor.locator(".ew-inspector-footer").boundingBox();
      const scroll = await editor.locator(".ew-inspector-scroll").boundingBox();
      if (bounds.y < scroll.y || bounds.y + bounds.height > footer.y)
        throw Error(`${name} overlaps the footer at viewport height ${height}`);
    }
    if (height === 620)
      await page.screenshot({
        path: path.join(output, "tone-small-window.png"),
      });
  }
  await editor.getByRole("slider", { name: "白场", exact: true }).fill("0.92");
  await until(
    async () => Math.abs((await current()).recipe.white_point - 0.92) < 0.001,
  );
  return true;
}

(async () => {
  const connection = JSON.parse(
    await new Promise((resolve, reject) => {
      readline.createInterface({ input: child.stdout }).once("line", resolve);
      child.once("error", reject);
    }),
  );
  const call = async (route, body) => {
    const response = await fetch(
      `http://127.0.0.1:${connection.port}/api${route}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: "Bearer " + connection.token,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    const value = await response.json();
    if (!response.ok) throw Error(value.error);
    return value;
  };
  const current = async () => (await call("/library")).photos[0];
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1540, height: 1020 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    `http://127.0.0.1:1420/#port=${connection.port}&token=${connection.token}`,
  );
  await page.getByRole("button", { name: "打开图集 编辑器验证" }).click();
  await page.locator('article[aria-label="照片 precise.png"]').dblclick();
  const editor = page.getByRole("region", { name: "高精度照片编辑器" });
  // A named <section> maps to region in the accessibility tree.
  await editor.waitFor();
  await editor.locator(".comparison-edited img").waitFor();
  if (process.argv.includes("--readiness")) {
    const verification = await verifyReadiness(page, editor, current);
    if (errors.length) throw Error(errors.join("\n"));
    const report = {
      status: "passed",
      ...verification,
      browser_errors: errors,
    };
    fs.writeFileSync(
      path.join(output, "report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify({ output, ...report }, null, 2));
    return;
  }

  for (const name of ["裁剪", "旋转与校正", "细节", "修复与仿制", "局部调整"]) {
    if (
      await editor
        .getByRole("navigation", { name: "编辑工具" })
        .getByRole("button", { name, exact: true })
        .count()
    )
      throw Error("Retired tool entry remains: " + name);
  }
  const inspectorAccessible = await verifyInspector(
    page,
    editor,
    current,
    output,
  );
  await editor
    .getByRole("slider", { name: "亮度曝光", exact: true })
    .fill("0.5");
  await until(async () => (await current()).recipe.exposure === 0.5);
  await editor.getByLabel("编辑画布").focus();
  await page.keyboard.press("Control+z");
  await until(async () => (await current()).recipe.exposure === 0);
  await editor.getByRole("button", { name: "移动与缩放", exact: true }).click();
  const zoomBefore = await editor.locator(".ew-zoom-number").textContent();
  await editor.getByTitle("放大", { exact: true }).click();
  if ((await editor.locator(".ew-zoom-number").textContent()) === zoomBefore)
    throw Error("Canvas pan captured the zoom button click");
  await editor.getByTitle("适合画布", { exact: true }).click();

  await editor.getByRole("button", { name: "构图", exact: true }).click();
  await waitReady(editor);
  const frame = await editor.getByLabel("裁剪画框").boundingBox();
  const handle = await editor.locator(".ew-crop-handle.se").boundingBox();
  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    frame.x + frame.width * 0.75,
    frame.y + frame.height * 0.75,
    { steps: 12 },
  );
  await page.mouse.up();
  await editor.getByLabel("应用裁剪", { exact: true }).click();
  await until(async () => (await current()).recipe.crop_w < 0.9);
  const cropped = (await current()).recipe.crop_w;
  await editor.getByLabel("撤销上次修改", { exact: true }).click();
  await until(async () => (await current()).recipe.crop_w === 1);
  await editor.getByLabel("重做上次修改", { exact: true }).click();
  await until(async () => (await current()).recipe.crop_w === cropped);
  await editor.getByLabel("撤销上次修改", { exact: true }).click();
  await until(async () => (await current()).recipe.crop_w === 1);

  await editor.getByRole("button", { name: "构图", exact: true }).click();
  await editor.getByLabel("顺时针旋转90度").click();
  await until(async () => (await current()).recipe.quarter_turns === 1);
  await editor.getByLabel("撤销上次修改", { exact: true }).click();
  await until(async () => (await current()).recipe.quarter_turns === 0);
  await editor.getByLabel("重做上次修改", { exact: true }).click();
  await until(async () => (await current()).recipe.quarter_turns === 1);

  await editor.getByRole("button", { name: "曲线", exact: true }).click();
  const curve = await editor.getByLabel("分段线性曲线编辑器").boundingBox();
  await page.mouse.dblclick(
    curve.x + curve.width * 0.5,
    curve.y + curve.height * 0.65,
  );
  await until(
    async () => JSON.parse((await current()).recipe.curve_rgb).length === 3,
  );
  await editor.getByRole("button", { name: "色彩与 HSL", exact: true }).click();
  await editor.getByLabel("HSL 蓝", { exact: true }).click();
  await editor
    .getByRole("slider", { name: "分色色相", exact: true })
    .fill("12");
  await until(async () =>
    JSON.parse((await current()).recipe.hsl).some(
      (entry) => entry.band === 5 && entry.hue === 12,
    ),
  );
  await editor
    .getByRole("slider", { name: "分色饱和度", exact: true })
    .fill("0.24");
  await until(async () =>
    JSON.parse((await current()).recipe.hsl).some(
      (entry) => entry.band === 5 && entry.saturation === 0.24,
    ),
  );
  const photo = await current();
  const job = await call("/export", {
    ids: [photo.id],
    folder: path.join(output, "exports"),
    template: "plain",
    size: 0,
    format: "png",
  });
  let result;
  await until(async () => {
    result = await call("/jobs/" + job.id);
    return result.status !== "running";
  });
  if (result.status !== "done" || result.result.errors.length)
    throw Error(JSON.stringify(result));
  const verification = script(`
import sys,hashlib,json
from pathlib import Path
import numpy as np
sys.path.insert(0,r'${path.join(root, "product")}')
import engine,pixels,png
p=Path(r'${output}');c=engine.Catalog(p/'data'/'library.sqlite');photo=c.photos()[0];c.close()
target=next((p/'exports').glob('*.png'))
with target.open('rb') as stream: w,h,rows,info=png.Reader(file=stream).asDirect();assert info['bitdepth']==16
actual=pixels.read(target);expected=engine.render_pixels(photo['path'],photo['recipe'])
assert actual.shape==expected.shape
np.testing.assert_array_equal(np.rint(actual*65535).astype('uint16'),np.rint(expected*65535).astype('uint16'))
assert np.any(np.rint(actual*65535).astype('uint16')%257), 'Export was quantized to eight bits'
assert hashlib.sha256(Path(photo['path']).read_bytes()).hexdigest()==(p/'source-hash.txt').read_text()
print(json.dumps({'width':w,'height':h,'bits':info['bitdepth'],'source_preserved':True,'samples_match_float_pipeline':True}))
`);
  if (errors.length) throw Error(errors.join("\n"));
  await page.screenshot({ path: path.join(output, "editor.png") });
  const report = {
    status: "passed",
    crop_undo_redo: true,
    rotation_undo_redo: true,
    curve_control_saved: true,
    inspector_parameters_accessible: inspectorAccessible,
    simplified_tools: true,
    hsl_saved: true,
    export: JSON.parse(verification),
    browser_errors: errors,
  };
  fs.writeFileSync(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify({ output, ...report }, null, 2));
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (browser) await browser.close();
    child.kill();
  });
