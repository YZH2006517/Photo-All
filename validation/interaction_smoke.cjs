// Facet counts, split comparison, preview reuse and visible undo/redo against the real service.
const {spawn,spawnSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const {chromium}=require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=path.resolve(__dirname,'..'),output=path.join(__dirname,'artifacts','interaction-'+Date.now());fs.mkdirSync(output,{recursive:true});
const python='C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const fixture=spawnSync(python,['-c',`
import sys
from pathlib import Path
from PIL import Image
sys.path.insert(0,r'${path.join(root,'product')}')
import engine
p=Path(r'${output}');(p/'input').mkdir();c=engine.Catalog(p/'data'/'library.sqlite');a=c.create_album('交互验证')
data=[('blue','cool','dark','city'),('blue','cool','bright','city'),('red','warm','balanced','portrait'),('blue','cool','dark','animal')]+[('orange','warm','balanced','plant')]*36
for i,(color,tone,brightness,content) in enumerate(data):
 im=Image.new('RGB',(1200,800),{'blue':'#357dc4','red':'#de483b','orange':'#c68b51'}[color]);im.paste((240,220,190),(0,0,350,500));f=p/'input'/f'photo-{i:02d}.jpg';im.save(f)
 c.import_files([f],album_id=a['id']);photo=next(x for x in c.photos() if x['path']==str(f.resolve()));c.save_features(photo['id'],{'color':color,'tone':tone,'brightness':brightness,'content':{'label':content,'score':.8,'candidates':[],'model':'test fixture'}})
c.close()
`],{encoding:'utf8'});if(fixture.status)throw Error(fixture.stderr);
const child=spawn(python,['-u',path.join(root,'product/service.py'),'--data-dir',path.join(output,'data')],{windowsHide:true});child.stderr.on('data',d=>process.stderr.write(d));let browser;
async function until(fn,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('Interaction timeout');}
(async()=>{
 const connection=JSON.parse(await new Promise(r=>readline.createInterface({input:child.stdout}).once('line',r)));
 const call=async(route,body)=>{const response=await fetch(`http://127.0.0.1:${connection.port}/api${route}`,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+connection.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const value=await response.json();if(!response.ok)throw Error(value.error);return value;};
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:940}});const errors=[],transfers=[];let imageRequests=0,activeRequests=0,peakRequests=0;
 let originalRequests=0;page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().includes('/api/image/')){imageRequests++;activeRequests++;peakRequests=Math.max(peakRequests,activeRequests);if(new URL(r.url()).searchParams.get('original')==='1')originalRequests++;}});
 const finish=r=>{if(r.url().includes('/api/image/')){activeRequests--;const t=r.timing();if(t.responseEnd>=0)transfers.push([t.startTime,t.startTime+t.responseEnd]);}};page.on('requestfinished',finish);page.on('requestfailed',finish);
 await page.goto(`http://127.0.0.1:1420/#port=${connection.port}&token=${connection.token}`);await page.getByRole('button',{name:'打开图集 交互验证'}).click();
 await page.locator('.photo-card').nth(39).waitFor();await page.locator('.photo-card img').first().waitFor();await until(()=>activeRequests===0);
 const initialRequests=imageRequests;if(initialRequests>=40)throw Error('Offscreen photos were eagerly requested');
 await page.getByLabel('按主色分类').selectOption('blue');
 await until(async()=>(await page.getByLabel('按内容分类').locator('option[value="portrait"]').textContent()).includes('0'));
 const optionText=await page.getByLabel('按内容分类').locator('option').allTextContents();
 if(!(await page.getByLabel('按内容分类').locator('option[value="portrait"]').evaluate(e=>e.disabled)))throw Error('Zero-count content must be disabled: '+await page.getByLabel('按内容分类').evaluate(e=>e.outerHTML));
 await page.getByLabel('按内容分类').selectOption('city');await until(()=>page.locator('.photo-card').count().then(n=>n===2));
 if(!(await page.getByLabel('按亮度分类').locator('option[value="dark"]').textContent()).includes('1'))throw Error('Dependent brightness count wrong');
 await page.screenshot({path:path.join(output,'01-facets.png')});
 await page.locator('article[aria-label="照片 photo-00.jpg"]').dblclick();await page.locator('.comparison-edited img').waitFor();
 const editor=page.getByRole('region',{name:'高精度照片编辑器',exact:true});await editor.waitFor();
 if(await page.locator('.comparison-edited').getAttribute('data-quality')!=='source')throw Error('Editor still uses compressed display preview');
 await page.getByRole('button',{name:'暖日胶片',exact:true}).click();await until(async()=>(await call('/library')).photos[0].recipe.style==='warm');
 await until(()=>page.locator('.comparison-edited.loading').count().then(n=>n===0));
 await page.getByRole('button',{name:'对比原图',exact:true}).click();await page.locator('.comparison-original.ready').waitFor();await until(()=>activeRequests===0);
 const beforeDragRequests=imageRequests;
 const frame=await page.locator('.comparison-frame').boundingBox();if(!frame)throw Error('Comparison frame missing');
 const divider=page.getByRole('slider',{name:'原图对比分割线'});const box=await divider.boundingBox();
 await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(frame.x+frame.width*.8,frame.y+frame.height/2,{steps:20});
 const alignment=await divider.evaluate(el=>{const r=el.getBoundingClientRect(),f=el.closest('.comparison-frame').getBoundingClientRect();return {line:r.x+r.width/2,seam:f.x+f.width*Number(el.getAttribute('aria-valuenow'))/100,transform:getComputedStyle(el).transform};});
 await page.screenshot({path:path.join(output,'02-drag-active.png')});if(Math.abs(alignment.line-alignment.seam)>2)throw Error('Active split line escaped clipping seam: '+JSON.stringify(alignment));
 await page.mouse.up();
 if(Math.abs(Number(await divider.getAttribute('aria-valuenow'))-80)>2)throw Error('Divider did not follow drag');
 await divider.focus();await divider.press('Home');if(await divider.getAttribute('aria-valuenow')!=='0')throw Error('Keyboard split bounds failed');await divider.press('End');await divider.press('ArrowLeft');
 if(imageRequests!==beforeDragRequests)throw Error('Dragging reloaded image pixels');
 await divider.dblclick();await until(async()=>await divider.getAttribute('aria-valuenow')==='50');
 await page.screenshot({path:path.join(output,'02-comparison.png')});
 const editedBeforeUndo=await page.locator('.comparison-edited img').getAttribute('src');
 await editor.getByLabel('撤销上次修改',{exact:true}).click();await until(async()=>(await call('/library')).photos[0].recipe.style==='natural');
 await until(async()=>await page.locator('.comparison-edited img').getAttribute('src')!==editedBeforeUndo&&await page.locator('.comparison-edited.loading').count()===0);
 const editedBeforeRedo=await page.locator('.comparison-edited img').getAttribute('src');
 await editor.getByLabel('重做上次修改',{exact:true}).click();await until(async()=>(await call('/library')).photos[0].recipe.style==='warm');
 await until(async()=>await page.locator('.comparison-edited img').getAttribute('src')!==editedBeforeRedo&&await page.locator('.comparison-edited.loading').count()===0);
 await editor.getByRole('button',{name:'照片库',exact:true}).click();await page.locator('.photo-card').nth(1).waitFor();await until(()=>activeRequests===0);
 const beforeReopen=imageRequests;
 await page.locator('article[aria-label="照片 photo-00.jpg"]').dblclick();await page.locator('.comparison-edited img').waitFor();await until(()=>activeRequests===0);
 if(imageRequests!==beforeReopen)throw Error('Reopening a cached editor refetched pixels');
 await editor.getByRole('button',{name:'对比原图',exact:true}).click();await page.locator('.comparison-original.ready').waitFor();await until(()=>activeRequests===0);
 const beforeToolOriginal=originalRequests,beforeToolImages=imageRequests;
 const tools=editor.getByRole('navigation',{name:'编辑工具'});
 await tools.getByRole('button',{name:'曲线',exact:true}).click();await editor.getByLabel('分段线性曲线编辑器').waitFor();
 await tools.getByRole('button',{name:'色彩与 HSL',exact:true}).click();await editor.getByRole('slider',{name:'分色色相',exact:true}).waitFor();
 await tools.getByRole('button',{name:'光线与色调',exact:true}).click();await editor.getByRole('slider',{name:'亮度曝光',exact:true}).waitFor();await until(()=>activeRequests===0);
 if(originalRequests!==beforeToolOriginal||imageRequests!==beforeToolImages)throw Error('Switching editor tools reloaded unchanged image pixels');
 // Hold an undo refresh response while a newer slider edit is already saved.
 let releaseRefresh,capturedRefresh;let held=false;
 const refreshGate=new Promise(r=>releaseRefresh=r),captured=new Promise(r=>capturedRefresh=r);
 await page.route('**/api/library',async route=>{if(held)return route.continue();held=true;const response=await route.fetch();capturedRefresh();await refreshGate;await route.fulfill({response});});
 await editor.getByLabel('撤销上次修改',{exact:true}).click();await captured;
 await page.getByRole('slider',{name:'亮度曝光',exact:true}).fill('1');
 await until(async()=>(await call('/library')).photos[0].recipe.exposure===1);
 releaseRefresh();await until(async()=>Number(await page.getByRole('slider',{name:'亮度曝光',exact:true}).inputValue())===1);
 await page.unroute('**/api/library');
 await page.getByRole('slider',{name:'对比度',exact:true}).fill('1.1');
 await until(async()=>{const p=(await call('/library')).photos[0];return p.recipe.contrast===1.1&&p.recipe.exposure===1;});
 // Protocol events can arrive out of order after abort/replacement. Measure
 // completed transfers by Chromium timestamps, not notification delivery order.
 let actualActive=0,actualPeak=0;for(const [,delta] of transfers.flatMap(([a,b])=>[[a,1],[b,-1]]).sort((a,b)=>a[0]-b[0]||a[1]-b[1])){actualActive+=delta;actualPeak=Math.max(actualPeak,actualActive);}
 if(errors.length)throw Error(errors.join('\n'));if(actualPeak>3)throw Error('Preview concurrency was not bounded: '+actualPeak);
 const report={status:'passed',photos:40,initial_image_requests:initialRequests,peak_preview_requests:actualPeak,observed_event_peak:peakRequests,content_options_after_blue:optionText,drag_requests:0,undo_redo:true,edit_during_undo_refresh_preserved:true,editor_reopen_requests:0,tool_switch_original_requests:0,tool_switch_image_requests:0,browser_errors:errors};fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();child.kill();});
