// Real-photo UI timings. Run after backend matrix to avoid CPU contention.
const {spawn,spawnSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const {chromium}=require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const spectralOnly=process.argv.includes('--spectral-only');
const port=spectralOnly?1439:1427;
const defaultDataset=spectralOnly && !process.argv.includes('--jpg')?'validation/artifacts/editor-raw-real-2026-11-11-packaged':'validation/artifacts/editor-full-real-2026-11-11-packaged';
const root=path.resolve(__dirname,'..'), out=path.join(root,process.env.PHOTOALL_TEST_ARTIFACTS||defaultDataset,process.env.PHOTOALL_TEST_UI_SUBDIR||(spectralOnly?'ui-reprint-final':'ui'));
fs.mkdirSync(out,{recursive:true});
const inventory=JSON.parse(fs.readFileSync(path.join(out,'../inventory.json'),'utf8'));
const spectralFields=Object.values(JSON.parse(fs.readFileSync(path.join(out,'../spectral-controls.json'),'utf8'))).flat();
const python=path.join(root,'product/build/runtime/python/python.exe');
const moduleRoot=path.join(root,spectralOnly?'product':'product/build/runtime');
const setup=spawnSync(python,['-c',`import sys,json
from pathlib import Path
sys.path.insert(0,r'${path.join(root,'product/build/runtime')}')
import engine
c=engine.Catalog(Path(r'${out}')/'data/library.sqlite');a=next(iter(c.albums()),None) or c.create_album('真实大图界面测试')
c.close()`],{encoding:'utf8',windowsHide:true});
if(setup.status)throw Error(setup.stderr||setup.stdout);
// Use canonical paths from the backend isolated catalog, not ambiguous basenames.
const transfer=spawnSync(python,['-c',`import sys,sqlite3,json
from pathlib import Path
sys.path.insert(0,r'${path.join(root,'product/build/runtime')}')
import engine
db=sqlite3.connect(r'${path.join(out,'../data/library.sqlite')}');rows=db.execute('SELECT path FROM photos WHERE id IN (${inventory.representatives.map(p=>p.id).join(',')})').fetchall();db.close()
c=engine.Catalog(Path(r'${out}')/'data/library.sqlite');album=c.albums()[0];c.import_files([Path(r[0]) for r in rows],album_id=album['id']);c.edit([p['id'] for p in c.photos()],recipe=engine.DEFAULT_RECIPE);c.close()`],{encoding:'utf8',windowsHide:true});
if(transfer.status)throw Error(transfer.stderr||transfer.stdout);
const child=spawn(python,['-u','-c',`import sys,json
from pathlib import Path
sys.path.insert(0,r'${path.join(root,'product/build/runtime')}')
sys.path.insert(0,r'${moduleRoot}')
import service
if ${spectralOnly ? 'True' : 'False'}:
    service.engine.film_spectral.PYTHONS=(Path(r'${process.env.PHOTOALL_TEST_SPECTRAL_PYTHON||path.join(root,'product/build/runtime/engines/spectral-python/python.exe')}'),)
service.ORIGINS.add('http://127.0.0.1:${port}')
server=service.create_server(Path(r'${out}')/'data','isolated-ui-test',0)
print(json.dumps({'port':server.server_port,'token':'isolated-ui-test'}),flush=True)
server.serve_forever()`],{windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8'}});
const lines=readline.createInterface({input:child.stdout});
child.stderr.on('data',d=>fs.appendFileSync(path.join(out,'service.log'),d));
let browser,vite,connection,editor,page;
const results=[],errors=[];
const followup=process.argv.includes('--followup');
const viewersOnly=process.argv.includes('--viewers-only');
const rawLiveOnly=process.argv.includes('--raw-live-only');
const colorOnly=process.argv.includes('--color-only')||followup,resultName=rawLiveOnly?'ui-raw-live-timings.json':viewersOnly?'ui-viewers-timings.json':followup?'ui-followup-timings.json':colorOnly?'ui-color-timings.json':'ui-timings.json';
function record(operation,start,extra={}){const row={operation,milliseconds:Date.now()-start,...extra};results.push(row);fs.writeFileSync(path.join(out,resultName),JSON.stringify(results,null,2));console.log(JSON.stringify(row));return row;}
async function until(fn,ms=45000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,25));}throw Error('Timed out after '+ms+' ms');}
async function call(route,body){const response=await fetch(`http://127.0.0.1:${connection.port}/api${route}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${connection.token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});if(!response.ok)throw Error(await response.text());return response.json();}
async function frames(){await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));}
async function fingerprint(){return editor.locator('.live-preview').evaluate(c=>{const p=document.createElement('canvas');p.width=40;p.height=24;const x=p.getContext('2d');x.drawImage(c,0,0,40,24);let a=2166136261;for(const v of x.getImageData(0,0,40,24).data)a=Math.imul(a^v,16777619);return a>>>0;});}
async function measured(name,fn){const t=Date.now();try{await fn();record(name,t,{ok:true});}catch(e){record(name,t,{ok:false,error:String(e)});await page.screenshot({path:path.join(out,'failure-'+results.length+'.png')}).catch(()=>{});}}
async function panel(name){const b=editor.getByRole('button',{name,exact:true});if(await b.getAttribute('aria-expanded')!=='true')await b.click();}
async function ready(){await until(async()=>await editor.locator('.comparison-edited').getAttribute('data-geometry-ready')==='true',90000);}
async function liveSlider(label,value){const slider=editor.getByRole('slider',{name:label,exact:true});await slider.scrollIntoViewIfNeeded();const old=await fingerprint();await slider.fill(String(value));await until(async()=>await fingerprint()!==old);await frames();}
async function spectralValue(label,value){const key=await editor.locator('.spectral-interactive-preview').getAttribute('data-preview-key');if(!key)return false;const r=Object.fromEntries(JSON.parse(key)),c=JSON.parse(r.film_advanced||'{}'),field=spectralFields.find(f=>f.label===label);return Number(c[field.key]??field.default)===Number(value);}
(async()=>{
 connection=JSON.parse(await new Promise(resolve=>lines.once('line',resolve)));
 vite=spawn(process.execPath,[path.join(root,'product/node_modules/vite/bin/vite.js'),'preview','--host','127.0.0.1','--port',String(port),'--strictPort'],{cwd:path.join(root,'product'),windowsHide:true,stdio:['ignore','ignore','inherit']});
 await until(async()=>{if(vite.exitCode!==null)throw Error('Vite exited '+vite.exitCode);try{return(await fetch(`http://127.0.0.1:${port}`)).ok}catch{return false}});
 browser=await chromium.launch({channel:'chrome',headless:true});page=await browser.newPage({viewport:{width:1680,height:1050}});
 page.on('pageerror',e=>errors.push(e.message));
 if(process.argv.includes('--native-check'))page.on('response',async response=>{
   if(!response.url().endsWith('/api/editor-preview'))return;
   const request=response.request().postDataJSON();
   if(request?.size===0)console.log(JSON.stringify({nativeResponse:response.status(),generation:request.generation,
     error:response.ok()?undefined:await response.text().catch(()=>undefined)}));
 });
 await page.goto(`http://127.0.0.1:${port}/#port=${connection.port}&token=${connection.token}`);
 await page.getByRole('button',{name:'打开图集 真实大图界面测试',exact:true}).click();
 const libraryPhotos=(await call('/library')).photos;
 const photos=inventory.representatives.map(rep=>libraryPhotos.find(p=>p.name===rep.name));
 if(rawLiveOnly){
   await page.mouse.move(1000,400);const shade=page.getByRole('button',{name:'关闭导航抽屉',exact:true});if(await shade.isVisible())await shade.click({position:{x:1000,y:300}});
   await page.locator(`article[aria-label="照片 ${photos[1].name}"]`).dblclick();editor=page.getByRole('region',{name:'高精度照片编辑器'});await ready();
   await until(async()=>await editor.locator('.live-preview').getAttribute('data-live-ready')==='true',90000);
   await editor.getByRole('button',{name:'RAW 显影',exact:true}).click();
   for(const [label,value] of [['RAW 曝光',.7],['RAW 降噪',15]])await measured('raw_complete_'+label,async()=>{
     await page.waitForLoadState('networkidle',{timeout:30000});
     const old=await fingerprint(),src=await editor.locator('.comparison-edited img').getAttribute('src'),start=Date.now();
     await editor.getByRole('slider',{name:label,exact:true}).fill(String(value));
     const native=async()=>await editor.locator('.comparison-edited img').evaluate((img,url)=>img.getAttribute('src')!==url&&img.complete&&img.naturalWidth>2000,src);
     await until(async()=>await native()||(await editor.locator('.live-preview').getAttribute('data-live-preview')==='true'&&await fingerprint()!==old),120000);
     record('raw_first_visible_'+label,start,{ok:true,native_already_ready:await native()});
     await until(native,120000);await ready();
   });
   await page.screenshot({path:path.join(out,'raw-live.png')});return;
 }
 if(viewersOnly){
   async function pictureReady(container){await until(async()=>await container.locator('.picture:not(.loading)[data-quality="source"][data-geometry-ready="true"] img').count()>0&&!await container.locator('.picture-refresh-labeled').count(),120000);}
   let lt;
   await measured('lighttable_enter_single_raw',async()=>{
     await page.getByRole('button',{name:'电子观片台',exact:true}).click();lt=page.getByRole('dialog',{name:'电子观片台',exact:true});
     await lt.getByLabel('单张观片',{exact:true}).click();await pictureReady(lt.locator('.lt-display'));
   });
   if(lt&&await lt.isVisible()){
     for(let n=0;n<2;n++)await measured('lighttable_next_raw_'+n,async()=>{const old=await lt.locator('.lt-display img').getAttribute('alt');await lt.getByLabel('观片下一张',{exact:true}).click();await until(async()=>await lt.locator('.lt-display img').getAttribute('alt')!==old);await pictureReady(lt.locator('.lt-display'));});
     results.push({operation:'lighttable_source_evidence',pictures:await lt.locator('.lt-display .picture').evaluateAll(list=>list.map(e=>({requested:e.dataset.sourceSize,natural:[e.querySelector('img')?.naturalWidth,e.querySelector('img')?.naturalHeight]})))});
     await page.screenshot({path:path.join(out,'lighttable-raw.png')});await lt.getByLabel('退出观片台',{exact:true}).click();
   }
   await measured('collection_enter_raw_roll',async()=>{
     await page.getByLabel('打开胶片收藏室',{exact:true}).click();const dr=page.getByRole('region',{name:'独立胶片收藏室'});
     await dr.locator('canvas').waitFor({timeout:90000});await page.mouse.move(800,1042);
     await dr.getByRole('button',{name:/^展开胶卷 /}).first().click();await until(async()=>await dr.getAttribute('data-stage')==='table',60000);
   });
   const dr=page.getByRole('region',{name:'独立胶片收藏室'});
   if(await dr.isVisible()){
     await measured('collection_raw_photo_detail',async()=>{await page.mouse.move(800,1042);await dr.getByRole('button',{name:'查看照片',exact:true}).click();await pictureReady(dr.locator('.dr-photo-content'));});
     await measured('collection_raw_native_1to1',async()=>{await dr.getByLabel('按原像素查看',{exact:true}).click();await until(async()=>Number(await dr.locator('.dr-photo-content .picture').getAttribute('data-source-size'))===0&&await dr.locator('.dr-photo-content img').evaluate(img=>img.complete&&img.naturalWidth>5000),90000);await pictureReady(dr.locator('.dr-photo-content'));});
     results.push({operation:'collection_source_evidence',pictures:await dr.locator('.dr-photo-content .picture').evaluateAll(list=>list.map(e=>({requested:e.dataset.sourceSize,natural:[e.querySelector('img')?.naturalWidth,e.querySelector('img')?.naturalHeight]})))});
     await page.screenshot({path:path.join(out,'collection-raw.png')});
   }
   fs.writeFileSync(path.join(out,'ui-viewers-errors.json'),JSON.stringify(errors,null,2));return;
 }
 if(colorOnly){
   const p=photos.find(p=>p.name===inventory.representatives[1].name)||photos[0];
   await page.mouse.move(1000,400);const scrim=page.getByRole('button',{name:'关闭导航抽屉',exact:true});if(await scrim.isVisible())await scrim.click({position:{x:1000,y:300}});
   await page.locator(`article[aria-label="照片 ${p.name}"]`).dblclick();editor=page.getByRole('region',{name:'高精度照片编辑器'});await ready();
   await until(async()=>await editor.locator('.live-preview').getAttribute('data-live-ready')==='true',60000);
   await panel('色彩');await measured('saturation_color_photo_recheck',()=>liveSlider('饱和度',1.3));
   await page.screenshot({path:path.join(out,'saturation-color.png')});
   if(followup)await measured('composition_persisted_pixels_undo_redo',async()=>{
     const current=async()=>(await call('/library')).photos.find(x=>x.id===p.id).recipe;
     await editor.getByRole('button',{name:'构图',exact:true}).click();await ready();
     const nativeSize=await editor.locator('.comparison-edited img').evaluate(img=>[img.naturalWidth,img.naturalHeight]);
     await editor.getByLabel('顺时针旋转90度',{exact:true}).click();
     await until(async()=>(await current()).quarter_turns===1);
     await until(async()=>await editor.locator('.comparison-edited img').evaluate((img,expected)=>img.naturalWidth===expected[1]&&img.naturalHeight===expected[0],nativeSize),90000);
     await ready();
     await editor.getByLabel('裁剪比例',{exact:true}).selectOption('1');
     await editor.getByLabel('应用裁剪',{exact:true}).click();
     await until(async()=>{const r=await current();return r.crop_w<.99||r.crop_h<.99;});
     await editor.getByRole('button',{name:'调节',exact:true}).click();
     await until(async()=>await editor.locator('.comparison-edited img').evaluate(img=>img.naturalWidth===img.naturalHeight),90000);
     await editor.getByLabel('撤销上次修改',{exact:true}).click();
     await until(async()=>{const r=await current();return r.crop_w===1&&r.crop_h===1;});
     await editor.getByLabel('重做上次修改',{exact:true}).click();
     await until(async()=>{const r=await current();return r.crop_w<.99||r.crop_h<.99;});
   });
   return;
 }
 if(spectralOnly){
   await page.mouse.move(1000,400);
   const shade=page.getByRole('button',{name:'关闭导航抽屉',exact:true});
   if(await shade.isVisible())await shade.click({position:{x:1000,y:300}});
   await page.locator(`article[aria-label="照片 ${photos[1].name}"]`).dblclick();
   editor=page.getByRole('region',{name:'高精度照片编辑器'});await ready();
 }else{
 for(const photo of photos){
   await page.mouse.move(1000,400);const scrim=page.getByRole('button',{name:'关闭导航抽屉',exact:true});if(await scrim.isVisible())await scrim.click({position:{x:1000,y:300}});
   const item=page.locator('article').filter({has:page.locator(`img[alt="${photo.name}"]`)});
   const card=page.locator(`article[aria-label="照片 ${photo.name}"]`);await card.locator('img').waitFor();
   let t=Date.now();await card.dblclick();editor=page.getByRole('region',{name:'高精度照片编辑器'});
   await editor.locator('.comparison-edited img').waitFor({timeout:60000});record('enter_first_visible',t,{photo:photo.name,ok:true});
   await ready();record('enter_native_ready',t,{photo:photo.name,ok:true});
   await until(async()=>await editor.locator('.live-preview').getAttribute('data-live-ready')==='true',90000);
   await panel('光线');await measured('live_exposure_'+photo.name,()=>liveSlider('亮度曝光',.4));
   await measured('live_shadows_'+photo.name,()=>liveSlider('阴影',.3));
   results.push({operation:'gpu',photo:photo.name,...await editor.locator('.live-preview').evaluate(c=>{const gl=c.getContext('webgl2'),ext=gl.getExtension('WEBGL_debug_renderer_info');return {buffer:[c.width,c.height],gpu:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),version:gl.getParameter(gl.VERSION)};})});
   await editor.getByRole('button',{name:'照片库',exact:true}).click();
 }
 await page.mouse.move(1000,400);const scrim=page.getByRole('button',{name:'关闭导航抽屉',exact:true});if(await scrim.isVisible())await scrim.click({position:{x:1000,y:300}});
 await page.locator(`article[aria-label="照片 ${photos[1].name}"]`).dblclick();editor=page.getByRole('region',{name:'高精度照片编辑器'});await ready();
 if(/\.(nef|cr2|cr3|arw|dng)$/i.test(photos[1].name)){
   await editor.getByRole('button',{name:'RAW 显影',exact:true}).click();
   async function rawRefresh(action){
     const previous=await editor.locator('.comparison-edited img').getAttribute('src');await action();
     await until(async()=>await editor.locator('.comparison-edited img').evaluate((img,old)=>img.getAttribute('src')!==old&&img.complete&&img.naturalWidth>2000,previous),120000);await ready();
   }
   for(const [label,value] of [['RAW 曝光',.7],['RAW 高光压缩',35],['RAW 降噪',15],['RAW 锐化',60]])
     await measured('raw_ui_'+label,()=>rawRefresh(()=>editor.getByRole('slider',{name:label,exact:true}).fill(String(value))));
   await measured('raw_ui_custom_wb',()=>rawRefresh(()=>editor.getByLabel('RAW 白平衡',{exact:true}).selectOption('custom')));
   await measured('raw_ui_temperature',()=>rawRefresh(()=>editor.getByRole('slider',{name:'RAW 色温',exact:true}).fill('5200')));
   await measured('raw_ui_tint',()=>rawRefresh(()=>editor.getByRole('slider',{name:'RAW 绿色倍率',exact:true}).fill('1.2')));
   await page.screenshot({path:path.join(out,'raw-controls.png')});
   await editor.getByRole('button',{name:'照片库',exact:true}).click();
   await call('/edit',{ids:[photos[1].id],recipe:{raw_exposure:0,raw_wb:'camera',raw_temperature:6500,raw_tint:1,raw_highlights:0,raw_denoise:0,raw_sharpen:0}});
   await page.reload();await page.getByRole('button',{name:'打开图集 真实大图界面测试',exact:true}).click();
   await page.mouse.move(1000,400);const shade=page.getByRole('button',{name:'关闭导航抽屉',exact:true});if(await shade.isVisible())await shade.click({position:{x:1000,y:300}});
   await page.locator(`article[aria-label="照片 ${photos[1].name}"]`).dblclick();editor=page.getByRole('region',{name:'高精度照片编辑器'});await ready();
 }
 for(const [group,label,value] of [['色彩','冷暖',.3],['色彩','饱和度',1.3],['色阶与伽马','黑场',.12],['色阶与伽马','白场',.88],['效果','清晰度',.35]]){
   await measured('adjust_ui_'+label,async()=>{await panel(group);await liveSlider(label,value);});
 }
 await measured('numeric_keyboard',async()=>{await panel('光线');const input=editor.getByRole('textbox',{name:'亮度曝光数值',exact:true});await input.fill('.65');await input.press('Enter');await until(async()=>(await call('/library')).photos.find(p=>p.id===photos[1].id).recipe.exposure===.65);});
 await panel('细节');
 for(const amount of [.3,0])await measured('denoise_visible_'+amount,async()=>{
   const previous=await editor.locator('.comparison-edited img').getAttribute('src');
   await editor.getByRole('slider',{name:'降噪',exact:true}).fill(String(amount));
   await until(async()=>await editor.locator('.comparison-edited img').evaluate((img,old)=>img.getAttribute('src')!==old&&img.complete&&img.naturalWidth>0,previous),90000);
 });
 await measured('compare_drag',async()=>{await editor.getByRole('button',{name:'对比原图',exact:true}).click();const divider=editor.getByRole('slider',{name:'原图对比分割线'});await divider.waitFor();const b=await divider.boundingBox();await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+150,b.y+b.height/2,{steps:12});await page.mouse.up();if(Number(await divider.getAttribute('aria-valuenow'))<=50)throw Error('divider did not move');await page.screenshot({path:path.join(out,'compare.png')});await editor.getByRole('button',{name:'对比原图',exact:true}).click();});
 await editor.getByRole('button',{name:'构图',exact:true}).click();
 await measured('rotate_crop_undo',async()=>{
   const current=async()=>(await call('/library')).photos.find(p=>p.id===photos[1].id).recipe;
   await ready();const before=await editor.locator('.comparison-edited img').evaluate(img=>[img.naturalWidth,img.naturalHeight]);
   const oldTurns=(await current()).quarter_turns||0;
   await editor.getByLabel('顺时针旋转90度',{exact:true}).click();
   await until(async()=>(await current()).quarter_turns===(oldTurns+1)%4);
   await until(async()=>await editor.locator('.comparison-edited img').evaluate((img,size)=>img.complete&&img.naturalWidth===size[1]&&img.naturalHeight===size[0],before),90000);
   await ready();await editor.getByLabel('裁剪比例',{exact:true}).selectOption('1');
   const cropSource=await editor.locator('.comparison-edited img').getAttribute('src');
   await editor.getByLabel('应用裁剪',{exact:true}).click();
   await until(async()=>{const r=await current();return r.crop_w<.99||r.crop_h<.99});
   await editor.getByRole('button',{name:'调节',exact:true}).click();
   await until(async()=>await editor.locator('.comparison-edited img').evaluate((img,old)=>img.getAttribute('src')!==old&&img.complete&&img.naturalWidth>0,cropSource),90000);
   await ready();const cropped=await editor.locator('.comparison-edited img').evaluate(img=>[img.naturalWidth,img.naturalHeight]);
   await editor.getByLabel('撤销上次修改',{exact:true}).click();
   await until(async()=>{const r=await current();return r.crop_w===1&&r.crop_h===1});await ready();
   if(cropped[0]!==cropped[1])throw Error('Square crop returned '+cropped.join('x')+' pixels');
 });
 await editor.getByRole('button',{name:'片边',exact:true}).click();
 for(const name of ['经典 35mm','暖棕负片','幻灯片框','即影即有','无片边','经典 35mm'])await measured('border_ui_'+name,async()=>{const previous=await editor.locator('.border-preview img').getAttribute('src').catch(()=>null);await editor.getByRole('button',{name:'片边样式 '+name,exact:true}).click();await until(async()=>await editor.locator('.border-preview').getAttribute('aria-busy')==='false'&&await editor.locator('.border-preview img').getAttribute('src')!==previous);});
 }
 await editor.getByRole('button',{name:'胶片模拟',exact:true}).click();
 await measured('spectral_first_ui',async()=>{await editor.getByRole('button',{name:'启用光谱工艺',exact:true}).click();await editor.locator('.spectral-interactive-preview').waitFor({timeout:90000});});
 const matrix=[['胶片','胶片曝光',.4],['冲印','相纸曝光',.3],['放大机滤色','品红微调',4],['预闪','预闪曝光',-8],['耦合剂','耦合剂用量',.7],['光晕','背反射强度',1.3],['颗粒','颗粒面积',.35],['光源','场景色温',5800]];
 for(const [group,label,value] of matrix)await measured('spectral_ui_'+group,async()=>{
   const stage = group === '光源' ? '光源' : ['冲印','放大机滤色','预闪'].includes(group) ? '冲印' : '底片';
   await editor.getByRole('group',{name:'光谱工序'}).getByRole('button',{name:stage,exact:true}).click();
   const section=editor.locator('.film-group').filter({has:page.locator(`section[aria-label="${group}"]`)});if(!await section.evaluate(e=>e.open))await section.locator('summary').click();
   for(const [key,option] of group==='预闪'?[['相纸预闪','on']]:group==='光晕'?[['乳剂散射和背反射','on']]:group==='颗粒'?[['乳剂颗粒','on']]:group==='光源'?[['场景模式','kelvin']]:[]){await editor.getByLabel(key,{exact:true}).selectOption(option);await new Promise(r=>setTimeout(r,200));}
   const start=Date.now();await editor.getByRole('slider',{name:label,exact:true}).fill(String(value));
   await until(()=>spectralValue(label,value),60000);
   await frames();
   record('slider_to_frame_'+label,start,{ok:true,photo:photos[1].name});
 });
 await page.screenshot({path:path.join(out,'spectral.png')});
 await new Promise(r=>setTimeout(r,5000));
 await measured('spectral_resume_during_native',async()=>{await editor.getByRole('slider',{name:'场景色温',exact:true}).fill('6100');await until(()=>spectralValue('场景色温',6100),60000);});
 if(process.argv.includes('--native-check')){
   const start=Date.now();
   await until(async()=>{
     const error=editor.locator('.comparison-edited .picture-error');
     if(await error.count())throw Error(await error.getAttribute('title'));
     return await editor.locator('.spectral-interactive-preview').count()===0 &&
       await editor.locator('.comparison-edited img').evaluate(img=>img.complete && img.naturalWidth>2000);
   },180000);
   const size=await editor.locator('.comparison-edited img').evaluate(img=>[img.naturalWidth,img.naturalHeight]);
   record('full_frame_after_interactive',start,{ok:true,pixels:size,photo:photos[1].name});
   const renderer=(await call('/library')).film.spectral.renderers;
   fs.writeFileSync(path.join(out,'renderers.json'),JSON.stringify(renderer,null,2));
   if(process.argv.includes('--require-gpu') && renderer.native?.backend!=='vulkan')
     throw Error('Native refinement did not use Vulkan');
 }
 fs.writeFileSync(path.join(out,'ui-errors.json'),JSON.stringify(errors,null,2));console.log(JSON.stringify({complete:true,results:results.length,pageErrors:errors,output:out}));
 if(spectralOnly && (errors.length || results.some(row=>row.ok===false)))process.exitCode=1;
})().catch(async e=>{console.error(e);fs.writeFileSync(path.join(out,'fatal.txt'),String(e.stack||e));if(page)await page.screenshot({path:path.join(out,'fatal.png')}).catch(()=>{});process.exitCode=1}).finally(async()=>{if(browser)await browser.close();spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});if(vite)spawnSync('taskkill',['/PID',String(vite.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});fs.writeFileSync(path.join(out,resultName),JSON.stringify(results,null,2));});
