// Render the code-authored SVG used by the UI into Windows multi-resolution icons.
const { chromium } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
    await page.setContent('<style>html,body{margin:0;background:transparent}svg{display:block;width:1024px;height:1024px}</style>' + fs.readFileSync(path.join(root, 'product/ui/brand.svg'), 'utf8'));
    const output = path.join(__dirname, 'artifacts', 'app-icon.png');
    await page.screenshot({ path: output, omitBackground: true });
    const python = 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
    const result = spawnSync(python, ['-c', "from PIL import Image; import sys; im=Image.open(sys.argv[1]); im.save(sys.argv[2],sizes=[(s,s) for s in (16,24,32,48,64,128,256)]); print('Windows ICO generated')", output, path.join(root, 'product/src-tauri/icons/icon.ico')], { encoding: 'utf8', windowsHide: true });
    if (result.status) throw Error(result.stderr);
    console.log(result.stdout.trim());
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
