// Code-only release artwork. Render the same editable HTML to a 1200 × 1600 PNG.
const fs = require('node:fs'), path = require('node:path');
const { chromium } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = path.resolve(__dirname, '..'), output = path.join(root, 'docs/media');
const sections = [
  ['实时调节与构图', '滑杆即时预览，停止调节后精细渲染。', '旋转自动覆盖白边，图层合成融入编辑器。'],
  ['可叠加的滤镜', '点选替换当前层，点「＋」再叠加。', '独立强度、顺序、开关与收藏。'],
  ['更顺手的观片台', 'V 键在鼠标位置开镜，关灯底色自由选择。', '拖向整块准备区收纳，沉浸时收起爱心。'],
  ['统一的深浅界面', '侧栏展开不跳位，图集顶部更紧凑。', '新图标与主题标题栏，编辑器可切换深浅色。'],
  ['更完整的图集管理', '名称留空也能创建，回收站可彻底移除记录。', '只移除软件记录，电脑本地照片保留。'],
  ['导入与缓存优化', '支持的 RAW 优先读取内嵌预览，并行分析。', '修复原尺寸缓存切换，减少反复加载。'],
];
const icon = fs.readFileSync(path.join(root, 'product/ui/brand.svg'), 'utf8');
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Photo All Studio 0.10.6 更新</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#ecefe8;color:#23382e;font-family:"Segoe UI","Microsoft YaHei UI",sans-serif;-webkit-font-smoothing:antialiased}
.poster{position:relative;width:1200px;height:1600px;overflow:hidden;background:#f5f4ed;padding:64px 76px}
.hero{position:relative;border-bottom:1px solid #cdd4c9;padding-bottom:44px;margin-bottom:13px}
.brand{display:flex;align-items:center;gap:14px;font-size:24px;font-weight:600;letter-spacing:.1px}.brand svg{width:48px;height:48px}
.date{margin-left:auto;font-size:18px;color:#78877b;font-weight:400;letter-spacing:1px}
.version{display:flex;align-items:baseline;gap:26px;margin:26px 0 12px}.version b{font-size:112px;font-weight:600;line-height:1.05;letter-spacing:-6px}.version span{font-size:38px;letter-spacing:1px;font-weight:500}
.baseline{font-size:21px;color:#708272;letter-spacing:.5px}
.rows{position:relative}.row{height:167px;display:grid;grid-template-columns:58px 1fr;align-items:start;gap:21px;padding:25px 0 22px;border-bottom:1px solid #dce0d5}
.number{font-size:19px;font-weight:600;color:#7b8c7b;letter-spacing:2px;padding-top:5px;font-variant-numeric:tabular-nums}
h2{font-size:31px;line-height:1.35;margin:0 0 10px;font-weight:600;letter-spacing:.3px}p{margin:0;font-size:23px;line-height:1.62;color:#6d7b6e}
.footer{position:absolute;left:76px;right:76px;bottom:57px;display:flex;justify-content:space-between;align-items:center;font-size:18px;color:#788677}
.footer strong{color:#354d3c;font-size:18px;font-weight:500}.dot{width:7px;height:7px;border-radius:50%;background:#b5a175;display:inline-block;margin-right:12px;vertical-align:3px}
.orb{position:absolute;right:-100px;top:120px;width:440px;height:440px;border:1px solid #cfd7c73b;border-radius:50%;pointer-events:none}.orb:before{content:"";position:absolute;inset:32px;border:1px solid #d2d8cb5c;border-radius:50%}
</style><main class="poster"><div class="orb"></div><header class="hero"><div class="brand">${icon}<span>Photo All Studio</span><span class="date">2026.11</span></div><div class="version"><b>0.10.6</b><span>更新内容</span></div><div class="baseline">相较 0.10.5 的主要改进</div></header><section class="rows">${sections.map(([title,a,b],i)=>`<article class="row"><span class="number">${String(i+1).padStart(2,'0')}</span><div><h2>${title}</h2><p>${a}<br>${b}</p></div></article>`).join('')}</section><footer class="footer"><strong><i class="dot"></i>免费开源 · 本地处理 · 原片只读</strong><span>github.com/YZH2006517/Photo-All</span></footer></main></html>`;
(async () => {
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'update-0.10.6.html'), html);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 1600 }, deviceScaleFactor: 1 });
    await page.setContent(html); await page.evaluate(() => document.fonts.ready);
    const overflow = await page.locator('.row').evaluateAll(rows => rows.some(row => row.scrollHeight > row.clientHeight));
    if (overflow) throw Error('Release artwork has overflowing text');
    await page.screenshot({ path: path.join(output, 'update-0.10.6.png') });
    console.log(JSON.stringify({ png: path.join(output, 'update-0.10.6.png'), width:1200, height:1600, codeOnly:true }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
