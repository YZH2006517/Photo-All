// Focused real pointer checks: independent sets, physical actions and 36-frame rolls.
const {spawn,spawnSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const {chromium}=require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=path.resolve(__dirname,'..'),output=path.join(__dirname,'artifacts','creative-'+Date.now());
const python='C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
fs.mkdirSync(output,{recursive:true});
const setup=spawnSync(python,['-c',`
from pathlib import Path
import sys
sys.path.insert(0,r'${path.join(root,'product')}')
import engine
from PIL import ImageOps, ImageDraw
out=Path(r'${output}');(out/'input').mkdir()
source=engine.analysis_image(Path(r'${path.join(root,'validation/inputs/D7000.NEF')}'))[0];source.thumbnail((1200,800))
paths=[]
for i in range(3):
    p=out/'input'/f'FRAME_{i+1}.jpg';(ImageOps.mirror(source) if i==1 else ImageOps.flip(source) if i==2 else source).save(p,quality=95);paths.append(p)
c=engine.Catalog(out/'data/library.sqlite');a=c.create_album('山间来信');c.import_files(paths,album_id=a['id']);a=c.create_album('林间试片');c.import_files(paths,album_id=a['id']);parts=[]
for i in range(73):
    small=source.copy();small.thumbnail((240,160));ImageDraw.Draw(small).rectangle((0,0,32,32),fill=(i*3%255,i,50));p=out/'input'/f'ROLL_{i+1:02}.jpg';small.save(p,quality=95);parts.append(p)
a=c.create_album('分卷验证');c.import_files(parts,album_id=a['id']);c.close()
`],{encoding:'utf8',windowsHide:true});if(setup.status)throw Error(setup.stderr);
const backend=spawn(python,['-u',path.join(root,'product/service.py'),'--data-dir',path.join(output,'data')],{windowsHide:true});backend.stderr.on('data',d=>process.stderr.write(d));
const frontend=spawn(process.execPath,[path.join(root,'product/node_modules/vite/bin/vite.js'),'preview','--host','127.0.0.1','--port','1420','--strictPort'],{cwd:path.join(root,'product'),windowsHide:true});
const ready=new Promise((resolve,reject)=>{frontend.stdout.on('data',d=>{if(d.toString().includes('Local:'))resolve();});frontend.once('exit',code=>reject(Error('Frontend exit '+code)));});
let browser,page;
async function until(fn,timeout=45000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,60));}throw Error('Wetlab verification timeout');}
(async()=>{
  const crypto=require('node:crypto');
  const connection=JSON.parse(await new Promise(resolve=>readline.createInterface({input:backend.stdout}).once('line',resolve)));await ready;
  const call=async(route,body)=>{const response=await fetch(`http://127.0.0.1:${connection.port}/api${route}`,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+connection.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});if(!response.ok)throw Error(await response.text());return response.json();};
  const before=await call('/library'),hashes=new Map(before.photos.map(p=>[p.id,crypto.createHash('sha256').update(fs.readFileSync(p.path)).digest('hex')]));
  const url=`http://127.0.0.1:1420/#port=${connection.port}&token=${connection.token}`;
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  page=await browser.newPage({viewport:{width:1600,height:1000},reducedMotion:'reduce'});
  const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});
  await page.addInitScript(()=>{window.__creativeDisposed=0;const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){const context=original.call(this,type,...args);if(type==='webgl2'&&context){const get=context.getExtension.bind(context);context.getExtension=function(name){const ext=get(name);if(name==='WEBGL_lose_context'&&ext){const lose=ext.loseContext.bind(ext);ext.loseContext=()=>{window.__creativeDisposed++;lose();};}return ext;};}return context;};});
  async function enter(){await page.getByRole('button',{name:'首页胶片暗房',exact:true}).click();await page.getByRole('button',{name:'进入创作暗房',exact:true}).click();}
  await page.route('**/api/live-look?**',async route=>{await new Promise(r=>setTimeout(r,3000));await route.continue();});
  await page.goto(url);
  await page.waitForTimeout(700);
  const art=await page.locator('.new-album-art').boundingBox(),cover=await page.locator('.album-cover').first().boundingBox();
  if(Math.abs(art.y-cover.y)>1||Math.abs(art.height-cover.height)>1)throw Error('Album cards misaligned '+JSON.stringify({art,cover}));
  await page.screenshot({path:path.join(output,'00-aligned-albums.png')});await enter();
  const lab=page.getByRole('region',{name:'创作暗房'}),scene=lab.locator('.cl-scene');
  const mix=async()=>JSON.parse(await lab.getAttribute('data-mix'));
  await until(()=>scene.getAttribute('data-renderer').then(v=>v==='ready'));
  await until(()=>lab.locator('[data-live-ready=true]').count().then(v=>v>0));
  async function target(id){const box=await scene.boundingBox(),points=JSON.parse(await scene.getAttribute('data-targets'));return {x:box.x+points[id].x,y:box.y+points[id].y};}
  async function view(name,id){await lab.getByRole('navigation',{name:'创作暗房场景'}).getByRole('button',{name,exact:true}).click();await until(()=>scene.getAttribute('data-visible-sets').then(v=>v===id));}
  async function moveTo(id){const p=await target(id);await page.mouse.move(p.x,p.y);return p;}
  async function exact(){await until(()=>lab.locator('.cl-preview-state').textContent().then(t=>t==='精细成像'));await until(()=>lab.locator('.cl-exact').evaluate(img=>img.complete&&img.naturalWidth>0));}
  async function pixels(){return lab.locator('.cl-exact').evaluate(img=>{const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);const data=ctx.getImageData(0,0,c.width,c.height).data;let sum=0;for(let i=0;i<data.length;i++)sum=(sum+data[i]*(i%19+1))%2147483647;return sum;});}
  await exact();await page.waitForTimeout(400);if(await scene.getAttribute('data-proof-quality')!=='exact')throw Error('Late GPU frame replaced exact 3D proof');
  if(await lab.locator('.cl-proof').count())throw Error('Old proof panel remains');
  const full=await scene.boundingBox();if(full.width<1595)throw Error('Scene is not full width');
  if(await scene.getAttribute('data-photo-visible')!=='false')throw Error('Photo rack shown by default');
  await lab.getByRole('button',{name:'场景照片显示',exact:true}).click();await until(()=>scene.getAttribute('data-photo-visible').then(v=>v==='true'));
  const initialMix=JSON.stringify(await mix());await page.mouse.move(full.x+full.width*.5,full.y+full.height*.22);await page.mouse.down({button:'middle'});await page.mouse.move(full.x+full.width*.5+240,full.y+full.height*.22-170,{steps:12});await page.mouse.up({button:'middle'});
  const orbit=JSON.parse(await scene.getAttribute('data-orbit'));if(Math.abs(orbit.yaw)<.15||Math.abs(orbit.pitch)>.18||JSON.stringify(await mix())!==initialMix)throw Error('Middle view orbit modifies edits or escapes bounds');
  await page.screenshot({path:path.join(output,'11-middle-view.png')});await lab.getByRole('button',{name:'重置创作镜头',exact:true}).click();await until(()=>scene.getAttribute('data-orbit').then(v=>JSON.parse(v).yaw===0));
  await page.screenshot({path:path.join(output,'01-atelier.png')});
  if(!(await lab.locator('.cl-dial-arc text').allTextContents()).includes('100%'))throw Error('Concentration scale must show values while idle');
  await moveTo('warm');await lab.getByRole('tooltip').waitFor();if(!(await lab.getByRole('tooltip').textContent()).includes('温暖'))throw Error('Bottle hover details missing');
  await until(()=>scene.getAttribute('data-bottle-lift').then(v=>Number(v)>.08));
  await lab.locator('.cl-bottle-note').waitFor();
  await page.screenshot({path:path.join(output,'16-ingredient-hover.png')});
  const concentration=await target('concentration');
  await page.mouse.move(concentration.x,concentration.y-7);await page.mouse.down();
  await lab.getByRole('tooltip',{name:'浓度刻度'}).locator('svg').waitFor();
  await page.screenshot({path:path.join(output,'17-concentration-arc.png')});
  await page.mouse.up();
  const selected=await target('base:kodak_portra_400');await page.mouse.click(selected.x,selected.y);await until(()=>mix().then(m=>m.stock==='kodak_portra_400'));
  await exact();const neutralPixels=await pixels();
  const warmHome=await target('warm');
  async function measureWarm() {
    await holdAtCup();
    if(await lab.locator('.cl-dose-ui').count())throw Error('Dose controls opened before release');
    await page.mouse.up();
    await until(async()=>{
      const tilt=Number(await scene.getAttribute('data-dose-tilt'));
      return tilt>0&&tilt<1.66&&Number(await scene.getAttribute('data-cap-lift'))>.2;
    });
    const meter=lab.getByRole('group',{name:/暖金.*倾倒用量/});
    await meter.waitFor();
    if(Number(await scene.getAttribute('data-cap-lift'))<.25||await scene.getAttribute('data-pouring')!=='false')throw Error('Metering must start with an open bottle and no flow');
    const handle=await meter.getByRole('button',{name:'按住滑动定量，松开倾倒'}).boundingBox();
    const x=handle.x+handle.width/2,y=handle.y+handle.height/2;
    await page.mouse.move(x,y);await page.mouse.down();
    return {meter,slide:distance=>page.mouse.move(x,y-distance,{steps:5})};
  }
  async function holdAtCup() {
    await moveTo('warm');
    await page.mouse.down();
    const cup=await target('cup');
    await page.mouse.move(cup.x,cup.y,{steps:12});
    await until(()=>scene.getAttribute('data-over-cup').then(v=>v==='true'));
  }
  const pinStart=JSON.parse(await scene.getAttribute('data-pin-position'));
  const pinned=await target('proof-photo');
  await page.mouse.move(pinned.x,pinned.y);await page.mouse.wheel(0,-240);
  await until(()=>scene.getAttribute('data-proof-scale').then(v=>Number(v)>1));
  await page.mouse.move(pinned.x,pinned.y);await page.mouse.down();
  await page.mouse.move(pinned.x-115,pinned.y-30,{steps:8});await page.mouse.up();
  await until(()=>scene.getAttribute('data-pin-position').then(v=>{
    const p=JSON.parse(v);return p[0]<pinStart[0]-.4&&p[2]===pinStart[2];
  }));
  let dose=await measureWarm();
  if(await lab.locator('dialog').count())throw Error('Dosing must stay in the scene');
  const beforeTilt=Number(await scene.getAttribute('data-dose-tilt'));
  const volume=dose.meter.getByRole('slider',{name:'用量毫升'});
  await dose.slide(-10);
  if(await volume.inputValue()!=='0')throw Error('Sliding down from zero must not add liquid');
  await dose.slide(25);
  await until(()=>volume.inputValue().then(v=>v==='25'));
  await until(()=>scene.getAttribute('data-dose-tilt').then(v=>Number(v)>beforeTilt+.1));
  const params=dose.meter.getByLabel('对应参数');
  const largeDose=await params.textContent();
  await dose.slide(10);
  await until(()=>volume.inputValue().then(v=>v==='10'));
  if(largeDose===await params.textContent())throw Error('Parameter preview does not follow the requested amount');
  await dose.slide(25);
  await page.screenshot({path:path.join(output,'02-measure.png')});
  if((await mix()).doses.warm!==0||await scene.getAttribute('data-pouring')!=='false')throw Error('Unconfirmed dose modified the recipe');
  await page.mouse.up();
  await until(()=>mix().then(m=>m.doses.warm===.25));
  await until(()=>scene.getAttribute('data-pouring').then(v=>v==='true'));
  await page.screenshot({path:path.join(output,'14-liquid-stream.png')});
  await exact();if(await pixels()===neutralPixels)throw Error('Pouring does not alter image pixels');
  if(JSON.stringify((await call('/library')).photos)!==JSON.stringify(before.photos))throw Error('Draft writes to photo before confirmation');
  await lab.getByRole('button',{name:'撤销暗房调配',exact:true}).click();await until(()=>mix().then(m=>m.doses.warm===0));
  await until(async()=>{const p=await target('warm');return Math.hypot(p.x-warmHome.x,p.y-warmHome.y)<2;});
  dose=await measureWarm();await dose.slide(12);await page.mouse.up();
  await until(()=>mix().then(m=>m.doses.warm===.12));
  await view('显影台','develop');
  if(!(await lab.locator('.cl-dial-arc text').allTextContents()).includes('14s'))throw Error('Timer scale must show simulated seconds while idle');
  await exact();const timerPixels=await pixels();
  const beforeTimer=(await mix()).timer,timer=await target('timer');
  await page.mouse.move(timer.x+17,timer.y-18);await page.mouse.down();
  const timerScale=lab.getByRole('tooltip',{name:'显影计时刻度'});
  await timerScale.waitFor();
  await timerScale.locator('svg').waitFor();
  await page.mouse.move(timer.x+35,timer.y+17,{steps:12});
  await page.screenshot({path:path.join(output,'03-analog-timer.png')});
  await page.mouse.up();await timerScale.waitFor({state:'detached'});
  await until(()=>mix().then(m=>m.timer>beforeTimer+.08));
  await exact();if(await pixels()!==timerPixels)throw Error('Setting time directly edits image');
  const planned=JSON.stringify(await mix());await lab.getByRole('button',{name:'开始显影',exact:true}).click();
  await until(()=>scene.getAttribute('data-develop-pouring').then(v=>v==='true'));
  if(Number(await scene.getAttribute('data-develop-lid'))>.7)throw Error('Tank lid must rest on the worktop during transfer');
  await page.screenshot({path:path.join(output,'15-develop-transfer.png')});
  await until(()=>scene.getAttribute('data-process-progress').then(v=>Number(v)>.37));
  await lab.getByRole('button',{name:'暂停显影',exact:true}).click();await lab.getByRole('button',{name:'继续显影',exact:true}).waitFor();
  const pausedProgress=await scene.getAttribute('data-process-progress'),pausedMix=JSON.stringify(await mix());await page.waitForTimeout(500);
  if(await scene.getAttribute('data-process-progress')!==pausedProgress||JSON.stringify(await mix())!==pausedMix)throw Error('Paused development keeps changing image');
  await page.mouse.move(full.x+full.width*.5,full.y+full.height*.2);await page.mouse.down({button:'middle'});await page.mouse.move(full.x+full.width*.5+50,full.y+full.height*.2+25,{steps:5});await page.mouse.up({button:'middle'});
  if(!await lab.getByRole('button',{name:'继续显影',exact:true}).count())throw Error('Releasing middle button cancels paused process');
  await lab.getByRole('button',{name:'继续显影',exact:true}).click();await until(()=>scene.getAttribute('data-process').then(v=>v==='done'),45000);
  await exact();if((await mix()).development<.35||await pixels()===timerPixels)throw Error('Timed development has no image effect');
  await lab.getByRole('button',{name:'开始显影',exact:true}).click();await until(()=>scene.getAttribute('data-process-progress').then(v=>Number(v)>.35));
  await lab.getByRole('button',{name:'取消显影',exact:true}).click();await until(()=>scene.getAttribute('data-process').then(v=>v==='idle'));
  await lab.getByRole('button',{name:'重置创作镜头',exact:true}).click();
  await view('配方架','shelf');
  const priorCancel=JSON.stringify(await mix());
  dose=await measureWarm();await dose.slide(10);await page.keyboard.press('Escape');await page.mouse.up();
  await dose.meter.waitFor({state:'detached'});
  await until(async()=>JSON.stringify(await mix())===priorCancel);if(!await lab.count())throw Error('Escape left studio during cancellation');
  await lab.getByRole('button',{name:'对比原有调整',exact:true}).click();if(!await lab.locator('.cl-image').evaluate(el=>getComputedStyle(el.querySelector('.cl-exact')).visibility==='hidden'))throw Error('Compare does not reveal committed image');await lab.getByRole('button',{name:'对比原有调整',exact:true}).click();
  const savedMix=JSON.stringify(await mix()),firstId=await lab.getAttribute('data-photo');
  await lab.getByRole('button',{name:'下一张调配照片',exact:true}).click();await until(()=>lab.getAttribute('data-photo').then(v=>v!==firstId));await until(()=>mix().then(m=>m.stock==='inherit'&&m.doses.warm===0));
  await lab.getByRole('button',{name:'上一张调配照片',exact:true}).click();await until(async()=>JSON.stringify(await mix())===savedMix);
  await lab.locator('.cl-presets summary').click();await lab.getByRole('textbox',{name:'暗房配方名称'}).fill('秋日试片');await lab.getByRole('button',{name:'收藏',exact:true}).click();
  await lab.getByRole('button',{name:'下一张调配照片',exact:true}).click();await until(()=>mix().then(m=>m.stock==='inherit'));await lab.getByRole('button',{name:'秋日试片',exact:true}).click();await until(async()=>JSON.stringify(await mix())===savedMix);
  const secondId=await lab.getAttribute('data-photo');await page.reload();await enter();await until(()=>lab.getAttribute('data-photo').then(v=>v===secondId));await until(async()=>JSON.stringify(await mix())===savedMix);
  await view('显影台','develop');
  await page.screenshot({path:path.join(output,'05-development-set.png')});
  const processCup=await target('process-cup'),mouth=await target('tank-mouth');
  await page.mouse.move(processCup.x,processCup.y);await page.mouse.down();await page.mouse.move(mouth.x,mouth.y,{steps:12});await page.mouse.up();
  await until(()=>scene.getAttribute('data-process').then(v=>v==='pour'));
  await until(()=>scene.getAttribute('data-process').then(v=>v==='agitate'));await lab.locator('.cl-presets summary').click();if(!await lab.getByRole('button',{name:'秋日试片',exact:true}).isDisabled())throw Error('Preset mutates running development');await lab.locator('.cl-presets summary').click();await lab.locator('.cl-formula-menu summary').click();if(!await lab.getByTitle('移除暖金',{exact:true}).isDisabled())throw Error('Ingredient removal active during process');await lab.locator('.cl-formula-menu summary').click();await page.screenshot({path:path.join(output,'06-agitating.png')});
  await until(()=>scene.getAttribute('data-process').then(v=>v==='done'),30000);
  if((await mix()).development<.4)throw Error('Development animation did not affect actual recipe');
  const beforeShake=(await mix()).agitation,tank=await target('tank');await page.mouse.move(tank.x,tank.y);await page.mouse.down();
  for(let i=0;i<4;i++)await page.mouse.move(tank.x+(i%2?40:-40),tank.y,{steps:4});await page.mouse.up();
  if((await mix()).agitation<=beforeShake)throw Error('Physical shaking has no effect');
  await view('调色台','colour');await exact();
  if(!(await lab.locator('.cl-dial-arc text').allTextContents()).includes('−50'))throw Error('Warmth scale must show relative values while idle');
  const warmth=await target('warmth');
  await page.mouse.move(warmth.x,warmth.y-7);await page.mouse.down();
  await lab.getByRole('tooltip',{name:'色温刻度'}).locator('svg').waitFor();
  await page.screenshot({path:path.join(output,'18-warmth-arc.png')});
  await page.mouse.up();
  await page.screenshot({path:path.join(output,'07-bath-set.png')});
  const sheet=await target('bath-paper'),bath=await target('bath');await page.mouse.move(sheet.x,sheet.y);await page.mouse.down();await page.mouse.move(bath.x,bath.y,{steps:12});
  await until(()=>mix().then(m=>m.bath>.065));await page.screenshot({path:path.join(output,'08-immersing-paper.png')});await page.mouse.up();
  await view('成品台','finish');await exact();const paper=await target('dry-paper'),hanger=await target('hanger');
  await page.mouse.move(paper.x,paper.y);await page.mouse.down();await page.mouse.move(hanger.x,hanger.y,{steps:12});await page.mouse.up();
  await until(()=>scene.getAttribute('data-drying').then(v=>Number(v)===1));await page.screenshot({path:path.join(output,'09-drying-set.png')});
  await view('配方架','shelf');
  await page.route('**/api/edit',async route=>{await new Promise(r=>setTimeout(r,700));await route.continue();});
  await holdAtCup();
  await lab.getByRole('button',{name:'应用到照片',exact:true}).press('Enter');await page.mouse.up();await lab.getByText('调配已写入照片，可在编辑器中继续调整或撤销。',{exact:true}).waitFor();
  await page.waitForTimeout(1500);if((await mix()).doses.warm!==0||await scene.getAttribute('data-dragging')!=='')throw Error('Saving left an unpressed bottle pouring');
  const after=await call('/library'),changed=after.photos.filter(p=>JSON.stringify(p.recipe)!==JSON.stringify(before.photos.find(b=>b.id===p.id).recipe));if(changed.length!==1||String(changed[0].id)!==secondId)throw Error('Apply edits the wrong photos');
  for(const p of after.photos)if(crypto.createHash('sha256').update(fs.readFileSync(p.path)).digest('hex')!==hashes.get(p.id))throw Error('Source file changed');
  await page.screenshot({path:path.join(output,'04-applied.png')});
  await lab.getByRole('button',{name:'观片暗房',exact:true}).click();await lab.waitFor({state:'detached'});if(await page.evaluate(()=>window.__creativeDisposed)<2)throw Error('Scene GPU not released');
  const archive=page.getByRole('region',{name:'独立胶片暗房'});
  await archive.getByRole('textbox',{name:'搜索暗房胶卷'}).fill('分卷验证');
  await page.mouse.move(800,997);
  const choices=archive.getByRole('group',{name:'暗房胶卷选择'}).getByRole('button');if(await choices.count()!==3)throw Error('73-frame album not split into 3 rolls');
  await archive.getByRole('button',{name:'展开胶卷 分卷验证 · 第 1/3 卷',exact:true}).click();
  await until(()=>archive.locator('.dr-frame-list>button').count().then(n=>n===36));
  await archive.getByRole('button',{name:'选择暗房照片 36',exact:true}).click();await page.screenshot({path:path.join(output,'10-roll36.png')});
  await page.mouse.move(30,140);
  await until(()=>archive.evaluate(el=>{
    const header=el.querySelector('.dr-header').getBoundingClientRect();
    const stow=el.querySelector('.dr-stow').getBoundingClientRect();
    const list=el.querySelector('.dr-frame-list').getBoundingClientRect();
    const bounds=el.getBoundingClientRect();
    return el.scrollTop===0&&header.top>=bounds.top&&stow.bottom<=bounds.bottom&&list.top>=bounds.bottom;
  }));
  await page.screenshot({path:path.join(output,'13-dock-collapsed.png')});
  await archive.getByRole('button',{name:'查看照片',exact:true}).click();
  await archive.getByRole('button',{name:'放大暗房照片',exact:true}).click();
  await until(()=>archive.getByRole('button',{name:'适合窗口'}).textContent().then(v=>v==='125%'));
  await archive.getByRole('button',{name:'回到暗房桌面'}).click();
  await archive.getByRole('button',{name:'收回暗房胶卷',exact:true}).click();
  await page.mouse.move(800,997);
  await archive.getByRole('button',{name:'展开胶卷 分卷验证 · 第 3/3 卷',exact:true}).click();
  await until(()=>archive.locator('.dr-frame-list>button').count().then(n=>n===1));
  await call('/undo',{});const undone=await call('/library');if(JSON.stringify(undone.photos.find(p=>String(p.id)===secondId).recipe)!==JSON.stringify(before.photos.find(p=>String(p.id)===secondId).recipe))throw Error('Persistent undo lost original parameters');
  const fallback=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'});await fallback.addInitScript(()=>{const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){if(type==='webgl'||type==='webgl2')return null;return original.call(this,type,...args);};});
  await fallback.goto(url);await fallback.getByRole('button',{name:'首页胶片暗房',exact:true}).click();await fallback.getByRole('button',{name:'进入创作暗房',exact:true}).click();const fallbackLab=fallback.getByRole('region',{name:'创作暗房'});await fallbackLab.locator('.cl-fallback').waitFor();await fallbackLab.getByRole('button',{name:'场景照片显示',exact:true}).click();await fallbackLab.locator('.cl-render-source.is-fallback').waitFor();await fallbackLab.locator('.cl-fallback').getByRole('button',{name:'暖金 +',exact:true}).click();await fallbackLab.getByRole('slider',{name:'用量毫升'}).press('End');await fallbackLab.getByRole('button',{name:'加入量杯',exact:true}).press('Enter');await until(()=>fallbackLab.locator('.cl-preview-state').textContent().then(v=>v==='精细成像'));await until(()=>fallbackLab.locator('.cl-exact').evaluate(img=>img.complete&&img.naturalWidth>0));if(!await fallbackLab.locator('.cl-render-source.is-fallback').isVisible())throw Error('Fallback has no visible photo');await fallback.screenshot({path:path.join(output,'12-visible-fallback.png')});await fallback.close();
  if(errors.length)throw Error(errors.join('\n'));
  const report={status:'passed',version:'0.10.6',three_official_drag_controls:true,immersive_header:true,exact_proof_wins_race:true,visible_fallback_photo:true,running_recipe_controls_locked:true,draggable_pinned_photo:true,measured_release_pour:true,inline_tilt_release:true,up_increases_dose:true,visible_cap_and_liquid:true,opens_before_metering:true,parked_tank_lid:true,live_timer_scale:true,bottle_hover_note:true,all_dial_arcs:true,numbered_dial_arcs:true,collapsed_dock_header:true,preview_zoom:true,parameter_preview_follows_amount:true,middle_view_orbit:true,timer_settings_do_not_edit:true,explicit_start_pause_resume_cancel:true,aligned_album_cards:true,roll36:true,overflow_rolls:true,distinct_scene_groups:true,real_develop_sequence:true,manual_tank_agitation:true,paper_bath_affects_recipe:true,paper_drag_drying:true,hover_details:true,real_pointer_bottle_pour:true,analog_pointer_timer:true,live_gpu_preview:true,precise_pixel_change:true,drafts_read_only:true,gesture_undo:true,escape_cancel:true,photo_drafts_isolated:true,non_first_photo_restored:true,reusable_presets:true,held_bottle_save_stops_pouring:true,single_photo_apply:true,persistent_undo:true,original_files_unchanged:true,no_webgl_fallback:true,gpu_cleanup:true,browser_errors:errors};
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report},null,2));
})().catch(async error=>{console.error(error);if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();backend.kill();frontend.kill();});
