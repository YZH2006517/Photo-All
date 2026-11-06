// End-to-end response timings on the requested real photos, in an isolated library.
const {spawn,spawnSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const {chromium}=require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=path.resolve(__dirname,'..');
const python='C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const output=path.join(__dirname,'artifacts','editor-ui-real-'+Date.now());fs.mkdirSync(output,{recursive:true});
const init=spawnSync(python,['-c',`import sys
from pathlib import Path
sys.path.insert(0,r'${path.join(root,'product')}')
import engine
c=engine.Catalog(Path(r'${output}')/'data/library.sqlite')
a=c.create_album('真实照片验证')
c.import_files([Path('E:/醒图over')/n for n in ['DSC_0534.JPG','DSC_1134.JPG','DSC_1393(1).JPG']],album_id=a['id'])
c.close()`],{encoding:'utf8',windowsHide:true});
if(init.status)throw Error(init.stderr);
const child=spawn(python,['-u',path.join(root,'product/service.py'),'--data-dir',path.join(output,'data')],{windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8'}});
let browser,vite,connection;
const report=[];
child.stderr.on('data',d=>process.stderr.write(d));
const line=readline.createInterface({input:child.stdout});
async function until(fn,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,30));}throw Error('Timed out');}
function record(name,started,extra={}){const result={operation:name,milliseconds:Date.now()-started,...extra};report.push(result);fs.writeFileSync(path.join(output,'timings.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(result));}
async function call(route,body){const response=await fetch(`http://127.0.0.1:${connection.port}/api${route}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${connection.token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});if(!response.ok)throw Error(await response.text());return response.json();}
(async()=>{
  connection=JSON.parse(await new Promise(resolve=>line.once('line',resolve)));
  try{await fetch('http://127.0.0.1:1420');}catch{
    vite=spawn(process.execPath,[path.join(root,'product/node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port','1420','--strictPort'],{cwd:path.join(root,'product'),windowsHide:true,stdio:'ignore'});
    await until(async()=>{try{return(await fetch('http://127.0.0.1:1420')).ok}catch{return false}});
  }
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1600,height:1000}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:1420/#port=${connection.port}&token=${connection.token}`);
  await page.getByRole('button',{name:'打开图集 真实照片验证',exact:true}).click();
  const photos=(await call('/library')).photos;
  for(const photo of photos){
    await page.mouse.move(900,400);
    const scrim=page.getByRole('button',{name:'关闭导航抽屉',exact:true});
    if(await scrim.isVisible())await scrim.click({position:{x:900,y:300}});
    await page.locator(`article[aria-label="照片 ${photo.name}"] img`).waitFor();
    let start=Date.now();
    await page.locator(`article[aria-label="照片 ${photo.name}"]`).dblclick();
    const editor=page.getByRole('region',{name:'高精度照片编辑器'});
    await editor.locator('.comparison-edited img').waitFor();
    record('first_visible',start,{photo:photo.name});
    await until(async()=>await editor.locator('.comparison-edited').getAttribute('data-geometry-ready')==='true');
    record('native_ready',start,{photo:photo.name});
    await until(async()=>await editor.locator('.live-preview').getAttribute('data-live-ready')==='true');
    for(const [label,value] of [['亮度曝光','0.4'],['亮度曝光','0.2'],['阴影','0.3']]){
      const slider=editor.getByRole('slider',{name:label,exact:true});
      start=Date.now();await slider.fill(value);
      await until(async()=>await editor.locator('.live-preview').getAttribute('data-live-preview')==='true');
      await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
      record('live_'+label,start,{photo:photo.name});
      await page.waitForTimeout(250);
    }
    const gpu=await editor.locator('.live-preview').evaluate(canvas=>{const gl=canvas.getContext('webgl2');return{buffer:[canvas.width,canvas.height],gpu:gl.getParameter(gl.RENDERER)};});
    report.push({operation:'gpu',photo:photo.name,...gpu});
    await editor.getByRole('button',{name:'照片库',exact:true}).click();
  }
  await page.mouse.move(900,400);
  const finalScrim=page.getByRole('button',{name:'关闭导航抽屉',exact:true});
  if(await finalScrim.isVisible())await finalScrim.click({position:{x:900,y:300}});
  const photo=photos[0];await page.locator(`article[aria-label="照片 ${photo.name}"]`).dblclick();
  const editor=page.getByRole('region',{name:'高精度照片编辑器'});
  await editor.getByRole('button',{name:'片边',exact:true}).click();
  for(const style of ['经典 35mm','暖棕负片','幻灯片框','经典 35mm']){
    const start=Date.now();await editor.getByRole('button',{name:'片边样式 '+style,exact:true}).click();
    await until(async()=>await editor.locator('.border-preview').getAttribute('aria-busy')==='false');
    record('border_'+style,start);
  }
  await editor.getByRole('button',{name:'胶片模拟',exact:true}).click();
  const start=Date.now();await editor.getByRole('button',{name:'启用光谱工艺',exact:true}).click();
  await editor.locator('.spectral-interactive-preview').waitFor({timeout:30000});record('spectral_first',start);
  const choices=[['胶片','胶片曝光','0.4'],['冲印','相纸曝光','0.3'],['放大机滤色','品红微调','4']];
  for(const [group,label,value] of choices){
    const section=editor.locator('.film-group').filter({has:page.locator('section[aria-label="'+group+'"]')});
    if(await section.count())await section.locator('summary').click();
    const slider=editor.getByRole('slider',{name:label,exact:true});
    await slider.scrollIntoViewIfNeeded();
    const old=await editor.locator('.spectral-interactive-preview').getAttribute('data-preview-key');
    const start=Date.now();await slider.fill(value);
    await until(async()=>await editor.locator('.spectral-interactive-preview').getAttribute('data-preview-key')!==old,30000);
    record('spectral_live_'+label,start);
  }
  // Deliberately resume editing after native refinement has started.
  await page.waitForTimeout(6500);
  const previous=await editor.locator('.spectral-interactive-preview').getAttribute('data-preview-key');
  const resumed=Date.now();await editor.getByRole('slider',{name:'品红微调',exact:true}).fill('7');
  await until(async()=>await editor.locator('.spectral-interactive-preview').getAttribute('data-preview-key')!==previous,30000);
  record('spectral_resume_during_native',resumed);
  await page.screenshot({path:path.join(output,'editor.png')});
  if(errors.length)throw Error(errors.join('\n'));
  console.log(JSON.stringify({output,errors,complete:true}));
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{if(browser)await browser.close();spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});if(vite)vite.kill();});
