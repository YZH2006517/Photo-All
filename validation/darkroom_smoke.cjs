// Isolated first-stage darkroom checks, including bounded textures and GPU cleanup.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
const { chromium } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = path.resolve(__dirname, '..'), output = path.join(__dirname, 'artifacts', 'darkroom-' + Date.now());
const python = 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
fs.mkdirSync(output, { recursive:true });
const setup = spawnSync(python, ['-c', `
from pathlib import Path
import sys
sys.path.insert(0,r'${path.join(root,'product')}')
import engine
from PIL import Image,ImageEnhance,ImageOps,ImageDraw
folder=Path(r'${output}'); photos=folder/'photos';photos.mkdir()
source=engine.analysis_image(Path(r'${path.join(root,'validation/inputs/D7000.NEF')}'))[0]
paths=[]
for i in range(13):
    image=ImageEnhance.Color(source).enhance(.55+i*.07)
    if i%3==1:image=ImageOps.mirror(image)
    if i==0:image=image.resize((5120,3413),Image.Resampling.LANCZOS)
    if i==12:image=image.crop((image.width//4,0,image.width*3//4,image.height))
    ImageDraw.Draw(image).text((8,8),str(i+1),fill=(220,200,160));p=photos/f'FRAME_{i+1:02}.jpg';image.save(p);paths.append(p)
c=engine.Catalog(folder/'data/library.sqlite')
a=c.create_album('山间来信');c.import_files(paths,album_id=a['id'])
for name in ['海岸日记','远行','森林散步','黄昏之后','城市片段','晴日','雨季','空胶卷']:
    a=c.create_album(name)
    if name!='空胶卷':c.import_files(paths[:3],album_id=a['id'])
a=c.create_album('已删除胶卷');c.import_files(paths[:1],album_id=a['id']);c.trash_album(a['id']);c.close()
`], { encoding:'utf8', windowsHide:true });
if(setup.status) throw Error(setup.stderr);
const backend = spawn(python, ['-u', path.join(root,'product/service.py'), '--data-dir',path.join(output,'data')], { windowsHide:true });
const frontend = spawn(process.execPath,[path.join(root,'product/node_modules/vite/bin/vite.js'),'preview','--host','127.0.0.1','--port','1420','--strictPort'], { cwd:path.join(root,'product'), windowsHide:true });
const ready = new Promise((resolve,reject) => { frontend.stdout.on('data',chunk=>{if(chunk.toString().includes('Local:')) resolve();}); frontend.once('exit',code=>reject(Error('Frontend exited '+code))); });
let browser,page;
async function until(fn,timeout=45000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,90));}throw Error('Darkroom check timed out');}
(async()=>{
  const connection=JSON.parse(await new Promise((resolve,reject)=>{readline.createInterface({input:backend.stdout}).once('line',resolve);backend.once('error',reject);}));
  await ready;
  const url=`http://127.0.0.1:1420/#port=${connection.port}&token=${connection.token}`;
  const library=()=>fetch(`http://127.0.0.1:${connection.port}/api/library`,{headers:{Authorization:'Bearer '+connection.token}}).then(r=>r.json());
  const before=await library();
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  page=await browser.newPage({viewport:{width:1600,height:1000}});
  const errors=[];page.on('pageerror',error=>{errors.push(error.message);console.error(error.message);});
  await page.addInitScript(()=>{
    window.__darkroomLost=0;const getContext=HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext=function(type,...args){const context=getContext.call(this,type,...args);if(type==='webgl2'&&context){const getExtension=context.getExtension.bind(context);context.getExtension=function(name){const extension=getExtension(name);if(name==='WEBGL_lose_context'&&extension){const lose=extension.loseContext.bind(extension);extension.loseContext=()=>{window.__darkroomLost++;lose();};}return extension;};}return context;};
  });
  await page.goto(url);await page.getByRole('button',{name:'首页胶片暗房',exact:true}).click();
  const darkroom=page.getByRole('region',{name:'独立胶片暗房'}),scene=darkroom.locator('.dr-scene');
  await until(()=>scene.getAttribute('data-renderer').then(value=>value==='ready'));
  await until(()=>scene.getAttribute('data-motion').then(value=>value==='idle'));
  if(await page.getByRole('button',{name:'展开胶卷 已删除胶卷',exact:true}).count())throw Error('Trashed roll leaked into darkroom');
  await page.mouse.move(1100,380);
  await until(()=>darkroom.locator('.dr-dock').boundingBox().then(box=>box.y>985));
  await page.screenshot({path:path.join(output,'01-shelf.png')});
  const showDock=async()=>{await page.mouse.move(800,996);await until(()=>darkroom.locator('.dr-dock').boundingBox().then(box=>box.y<930));};
  await showDock();
  await page.getByRole('button',{name:'下一页胶卷',exact:true}).click();
  await showDock();
  await darkroom.getByRole('button',{name:'展开胶卷 空胶卷',exact:true}).waitFor();
  await page.getByRole('button',{name:'上一页胶卷',exact:true}).click();
  await page.mouse.move(1100,380);await page.waitForTimeout(500);
  await page.mouse.click(505,350);
  await until(()=>darkroom.getAttribute('data-stage').then(value=>value==='table'));
  await darkroom.locator('.dr-roll-title').getByRole('heading',{name:'山间来信',exact:true}).waitFor();
  await until(()=>scene.getAttribute('data-stage').then(value=>value==='table'));
  await until(()=>scene.getAttribute('data-phase').then(value=>value==='transport'));
  if(Number(await scene.getAttribute('data-film-reveal'))!==0||Number(await scene.getAttribute('data-paper-reveal'))!==0)throw Error('Film/paper appears during cassette transfer');
  await page.screenshot({path:path.join(output,'01a-transport.png')});
  await until(()=>scene.getAttribute('data-phase').then(value=>value==='settle'));
  if(Number(await scene.getAttribute('data-roll-travel'))!==1||Number(await scene.getAttribute('data-film-reveal'))!==0)throw Error('Cassette does not settle before unfolding');
  if(Number(await scene.getAttribute('data-mouth-gap'))>.002)throw Error('Film root misses the actual cassette mouth');
  await until(()=>scene.getAttribute('data-phase').then(value=>value==='unroll'));
  if(await scene.getAttribute('data-film-shadow-casters')!=='1'||await scene.getAttribute('data-film-shadow-clipped')!=='true')throw Error('Film still uses duplicate or unclipped shadow casters');
  await until(()=>scene.getAttribute('data-film-reveal').then(value=>Number(value)>.25&&Number(value)<.9));
  const feedBefore=Number(await scene.getAttribute('data-film-feed')),anchorBefore=Number(await scene.getAttribute('data-frame-anchor-x'));
  await page.screenshot({path:path.join(output,'01b-unroll-shadow.png')});
  await until(()=>scene.getAttribute('data-film-feed').then(value=>Number(value)>feedBefore+.5));
  const feedAfter=Number(await scene.getAttribute('data-film-feed')),anchorAfter=Number(await scene.getAttribute('data-frame-anchor-x'));
  if(Math.abs((feedAfter-feedBefore)-(anchorAfter-anchorBefore))>.08)throw Error('Pictures do not move with the film substrate');
  if(Number(await scene.getAttribute('data-paper-reveal'))!==0)throw Error('Contact sheet appears before unfolding');
  await until(()=>darkroom.locator('.dr-roll-title p').textContent().then(value=>value.includes('6/6')));
  await until(()=>scene.getAttribute('data-motion').then(value=>value==='idle'));await page.screenshot({path:path.join(output,'02-table.png')});
  if(Number(await scene.getAttribute('data-mouth-gap'))>.002||Number(await scene.getAttribute('data-paper-reveal'))!==0||Number(await scene.getAttribute('data-optical-reveal'))!==1||Number(await scene.getAttribute('data-viewer-reveal'))!==0)throw Error('Default optional parts or optical viewer is wrong');
  await showDock();
  await darkroom.getByRole('button',{name:'选择暗房照片 2',exact:true}).click();
  await until(()=>scene.getAttribute('data-film-advance').then(value=>Math.abs(Number(value)+1.71)<.001));
  if(await scene.getAttribute('data-optical-frame')!=='1')throw Error('The actual film does not align with the selected optical frame');
  await darkroom.locator('.dr-parts summary').click();
  await darkroom.getByRole('button',{name:'电子观片器',exact:true}).click();
  await darkroom.locator('.dr-parts summary').click();
  await until(()=>scene.getAttribute('data-viewer-slide').then(value=>Number(value)>.15&&Number(value)<.9));
  if(Number(await scene.getAttribute('data-viewer-light'))!==0)throw Error('Electronic viewer leaks a dim image before insertion');
  if(await darkroom.locator('.dr-photo-viewer').count())throw Error('Thumbnail bypasses the desktop viewer');
  await until(()=>scene.getAttribute('data-viewer-frame').then(value=>value==='1'));
  await until(()=>scene.getAttribute('data-viewer-light').then(value=>Number(value)===1));
  await page.mouse.click(885,585);
  await darkroom.getByRole('dialog',{name:'暗房照片查看'}).waitFor();
  await page.keyboard.press('Escape');
  await showDock();
  await darkroom.getByRole('button',{name:'选择暗房照片 1',exact:true}).click();
  await until(()=>scene.getAttribute('data-motion').then(value=>value==='idle'));
  await page.mouse.move(850,390);await page.mouse.wheel(0,-400);
  await until(()=>scene.getAttribute('data-zoom').then(value=>Number(value)>1));
  await until(()=>scene.getAttribute('data-motion').then(value=>value==='idle'));
  await page.screenshot({path:path.join(output,'02a-zoom.png')});
  await darkroom.getByRole('button',{name:'重置暗房镜头距离',exact:true}).click();
  await until(()=>scene.getAttribute('data-zoom').then(value=>Number(value)===1));
  await darkroom.locator('.dr-parts summary').click();
  await darkroom.getByRole('button',{name:'接触印样',exact:true}).click();
  await until(()=>scene.getAttribute('data-paper-reveal').then(value=>Number(value)===1));
  await until(()=>scene.getAttribute('data-motion').then(value=>value==='idle'));
  await darkroom.locator('.dr-parts summary').click();
  await page.screenshot({path:path.join(output,'02b-optional-parts.png')});
  await darkroom.locator('.dr-parts summary').click();
  await darkroom.getByRole('button',{name:'电子观片器',exact:true}).click();
  await until(()=>scene.getAttribute('data-viewer-reveal').then(value=>Number(value)===0));
  if(Number(await scene.getAttribute('data-paper-reveal'))!==1)throw Error('Disabling viewer unexpectedly disables the contact sheet');
  await darkroom.getByRole('button',{name:'电子观片器',exact:true}).click();
  await darkroom.getByRole('button',{name:'接触印样',exact:true}).click();
  await darkroom.locator('.dr-parts summary').click();
  await until(()=>scene.getAttribute('data-motion').then(value=>value==='idle'));
  await page.keyboard.press('ArrowRight');
  await until(()=>scene.getAttribute('data-viewer-slide').then(value=>Number(value)<.8));
  await until(()=>scene.getAttribute('data-viewer-light').then(value=>Number(value)===1));
  await page.keyboard.press('ArrowLeft');
  await until(()=>scene.getAttribute('data-motion').then(value=>value==='idle'));
  await darkroom.locator('.dr-parts summary').click();
  await darkroom.getByRole('button',{name:'电子观片器',exact:true}).click();
  await darkroom.getByRole('button',{name:'胶片观片器',exact:true}).click();
  await darkroom.locator('.dr-parts summary').click();
  await until(()=>scene.getAttribute('data-motion').then(value=>value==='idle'));
  const freeBefore=Number(await scene.getAttribute('data-film-advance'));
  await page.mouse.move(1120,468);await page.mouse.down();
  await page.mouse.move(925,468,{steps:12});await page.mouse.up();
  await until(()=>scene.getAttribute('data-film-advance').then(value=>Number(value)<freeBefore-.2));
  if(await darkroom.locator('.dr-photo-viewer').count())throw Error('Dragging the film opens the photo dialog');
  await page.screenshot({path:path.join(output,'02c-free-film-drag.png')});
  await darkroom.locator('.dr-parts summary').click();
  await darkroom.getByRole('button',{name:'电子观片器',exact:true}).click();
  await darkroom.getByRole('button',{name:'胶片观片器',exact:true}).click();
  await darkroom.locator('.dr-parts summary').click();
  await until(()=>scene.getAttribute('data-motion').then(value=>value==='idle'));
  if(await scene.getAttribute('data-frame-count')!=='6')throw Error('The scene loads unbounded frame geometry');
  const textureFirst=Number(await scene.getAttribute('data-textures'));
  await showDock();
  await darkroom.getByRole('button',{name:'选择暗房照片 1',exact:true}).click();
  await darkroom.getByRole('button',{name:'查看照片',exact:true}).click();
  const photo=page.getByRole('dialog',{name:'暗房照片查看'});await photo.waitFor();
  await until(()=>photo.locator('img').evaluateAll(images=>images.length>0&&images.every(image=>image.complete&&image.naturalWidth>0)));
  if(await photo.locator('.picture').getAttribute('data-quality')!=='source')throw Error('Inspection uses thumbnail quality');
  if(await photo.locator('img').evaluate(image=>image.naturalWidth)!==5120)throw Error('Inspection downsamples a source above 4096 pixels');
  await photo.getByRole('button',{name:'按原像素查看',exact:true}).click();
  if(Math.abs((await photo.locator('.dr-photo-content').boundingBox()).width-5120)>1)throw Error('1:1 inspection does not preserve source pixels');
  await photo.getByRole('button',{name:'按原像素查看',exact:true}).click();
  await page.screenshot({path:path.join(output,'03-photo.png')});
  await page.keyboard.press('ArrowRight');await photo.getByText('2 / 13',{exact:true}).waitFor();
  await page.keyboard.press('Escape');await photo.waitFor({state:'detached'});
  await showDock();
  await darkroom.getByRole('button',{name:'下一组胶片',exact:true}).click();
  await darkroom.getByRole('button',{name:'选择暗房照片 7',exact:true}).waitFor();
  await until(()=>darkroom.locator('.dr-roll-title p').textContent().then(value=>value.includes('6/6')));
  await showDock();
  await darkroom.getByRole('button',{name:'下一组胶片',exact:true}).click();
  await until(()=>darkroom.locator('.dr-roll-title p').textContent().then(value=>value.includes('1/1')));
  if(await scene.getAttribute('data-frame-count')!=='1')throw Error('Last frame page is wrong');
  const textureLast=Number(await scene.getAttribute('data-textures'));
  if(textureLast>textureFirst+2)throw Error('Old page textures remain allocated');
  await darkroom.getByRole('button',{name:'暗房灯光切换',exact:true}).click();
  if(!await darkroom.evaluate(el=>el.classList.contains('dr-neutral')))throw Error('Neutral lighting failed');
  await page.screenshot({path:path.join(output,'04-neutral.png')});
  await showDock();
  await darkroom.getByRole('button',{name:'收回暗房胶卷',exact:true}).click();
  await until(()=>darkroom.getAttribute('data-stage').then(value=>value==='shelf'));
  await scene.locator('canvas').evaluate(canvas=>canvas.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext());
  await darkroom.getByText('三维场景暂时不可用，可以重试或继续查看照片。',{exact:true}).waitFor();
  if(await darkroom.getByRole('textbox',{name:'搜索暗房胶卷',exact:true}).isDisabled())throw Error('Lost WebGL context leaves returning controls locked');
  await darkroom.getByRole('button',{name:'重新加载场景',exact:true}).click();
  await darkroom.locator('.dr-recovery').waitFor({state:'detached'});
  await until(()=>scene.getAttribute('data-motion').then(value=>value==='idle'));
  await showDock();
  await darkroom.getByRole('textbox',{name:'搜索暗房胶卷',exact:true}).fill('空胶卷');
  await showDock();
  await darkroom.getByRole('button',{name:'展开胶卷 空胶卷',exact:true}).click();
  await darkroom.locator('.dr-empty').filter({hasText:'这是一卷空胶片'}).waitFor();
  await darkroom.getByRole('button',{name:'退出胶片暗房',exact:true}).click();
  await darkroom.waitFor({state:'detached'});
  if(await page.evaluate(()=>window.__darkroomLost)<1)throw Error('Exiting does not release WebGL context');
  await page.getByRole('button',{name:'首页胶片暗房',exact:true}).click();await darkroom.waitFor();
  await until(()=>scene.getAttribute('data-renderer').then(value=>value==='ready'));
  await page.emulateMedia({reducedMotion:'reduce'});
  await showDock();
  await darkroom.getByRole('textbox',{name:'搜索暗房胶卷',exact:true}).fill('空胶卷');
  await showDock();
  await darkroom.getByRole('button',{name:'展开胶卷 空胶卷',exact:true}).click();
  await darkroom.getByText('滚轮拉近拉远 · ← → 翻片 · Esc 返回 · 已减弱动效',{exact:true}).waitFor();
  await darkroom.getByRole('button',{name:'退出胶片暗房',exact:true}).click();
  const after=await library();
  const records=data=>JSON.stringify(data.photos.map(p=>({id:p.id,path:p.path,recipe:p.recipe,decision:p.decision,album_ids:p.album_ids})));
  if(records(before)!==records(after))throw Error('Darkroom mutated library records');
  const fallback=await browser.newPage({viewport:{width:1080,height:720}});
  fallback.on('pageerror',error=>errors.push(error.message));
  await fallback.addInitScript(()=>{const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){return /webgl/i.test(type)?null:original.call(this,type,...args);};});
  await fallback.goto(url);await fallback.getByRole('button',{name:'首页胶片暗房',exact:true}).click();
  await fallback.getByText('当前设备无法开启三维场景，仍可从下方选卷查看照片。',{exact:true}).waitFor();
  await fallback.mouse.move(540,716);await fallback.waitForTimeout(550);
  await fallback.getByRole('button',{name:'展开胶卷 雨季',exact:true}).click();
  await fallback.getByRole('button',{name:'选择暗房照片 1',exact:true}).click();
  await fallback.getByRole('dialog',{name:'暗房照片查看'}).waitFor();
  await fallback.screenshot({path:path.join(output,'05-fallback.png')});
  await fallback.keyboard.press('Escape');
  await fallback.mouse.move(540,716);await fallback.waitForTimeout(550);
  await fallback.getByRole('button',{name:'收回暗房胶卷',exact:true}).click();
  await fallback.getByRole('textbox',{name:'搜索暗房胶卷',exact:true}).fill('山间来信');
  await fallback.getByRole('button',{name:'展开胶卷 山间来信',exact:true}).click();
  await fallback.getByRole('button',{name:'退出胶片暗房',exact:true}).click();
  await fallback.route('**/api/library',route=>route.fulfill({json:{...before,albums:[],photos:[],trash_albums:[]}}));
  await fallback.reload();await fallback.getByRole('button',{name:'首页胶片暗房',exact:true}).click();
  await fallback.locator('.dr-empty').filter({hasText:'还没有胶卷'}).waitFor();
  if(errors.length)throw Error(errors.join('\n'));
  const report={status:'passed',separate_module:true,real_album_membership:true,bounded_frame_textures:true,source_quality_inspection:true,sequenced_transport_and_unroll:true,unified_clipped_film_shadow:true,optional_desktop_parts:true,animated_slide_viewer:true,whole_film_transport:true,optical_strip_reader:true,black_screen_before_insertion:true,hover_dock:true,free_film_drag:true,wheel_zoom:true,context_loss_recovery:true,outlet_alignment:true,contact_sheet_entrance:true,roll_and_frame_paging:true,lighting:true,empty_and_trashed_rolls:true,reduced_motion:true,webgl_fallback:true,context_disposed:true,library_unchanged:true,browser_errors:errors};
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report},null,2));
})().catch(async error=>{if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});console.error(error);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close().catch(()=>{});backend.kill();frontend.kill();});
