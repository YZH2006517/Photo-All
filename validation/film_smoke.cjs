// Real photo -> actual Spektrafilm colour -> save/undo/redo -> identical export pipeline.
const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const {chromium}=require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=path.resolve(__dirname,'..'),output=path.join(__dirname,'artifacts','film-'+Date.now());fs.mkdirSync(output,{recursive:true});
const python='C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const child=spawn(python,['-u',path.join(root,'product/service.py'),'--data-dir',path.join(output,'data')],{windowsHide:true});child.stderr.on('data',d=>process.stderr.write(d));let browser;
async function until(fn,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('Film validation timeout');}
(async()=>{
 const connection=JSON.parse(await new Promise(r=>readline.createInterface({input:child.stdout}).once('line',r)));
 const call=async(route,body)=>{const r=await fetch(`http://127.0.0.1:${connection.port}/api${route}`,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+connection.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const v=await r.json();if(!r.ok)throw Error(v.error);return v;};
 const album=await call('/albums',{name:'胶片暗房'});const imported=await call('/import',{album_id:album.id,paths:[path.join(__dirname,'inputs/recognition-fixture.jpg')]});
 await until(async()=>(await call('/jobs/'+imported.id)).status==='done');
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:940}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:1420/#port=${connection.port}&token=${connection.token}`);await page.getByRole('button',{name:'打开图集 胶片暗房'}).click();await page.locator('.photo-card').dblclick();await page.locator('.comparison-edited img').waitFor();
 const editor=page.getByRole('region',{name:'高精度照片编辑器',exact:true});await editor.waitFor();
 await editor.getByRole('button',{name:'胶片模拟',exact:true}).click();await editor.getByLabel('胶片型号').selectOption('kodak_portra_400');
 await until(async()=>(await call('/library')).photos[0].recipe.film_stock==='kodak_portra_400');
 await page.getByRole('slider',{name:'胶片强度',exact:true}).fill('0.85');await page.getByRole('slider',{name:'附加颗粒',exact:true}).fill('0.3');await page.getByRole('slider',{name:'附加光晕',exact:true}).fill('0.2');
 await until(async()=>{const p=(await call('/library')).photos[0];return p.recipe.film_strength===.85&&p.recipe.film_grain===.3&&p.recipe.film_halation===.2;});
 await page.getByRole('button',{name:'对比原图',exact:true}).click();await page.locator('.comparison-original.ready').waitFor();await until(()=>page.locator('.comparison-edited.loading').count().then(n=>n===0));
 await page.screenshot({path:path.join(output,'01-film-panel.png')});
 const beforeUndo=(await call('/library')).photos[0].recipe;
 await editor.getByLabel('撤销上次修改',{exact:true}).click();await until(async()=>JSON.stringify((await call('/library')).photos[0].recipe)!==JSON.stringify(beforeUndo));
 await editor.getByLabel('重做上次修改',{exact:true}).click();await until(async()=>JSON.stringify((await call('/library')).photos[0].recipe)===JSON.stringify(beforeUndo));
 const library=await call('/library'),photo=library.photos[0];const job=await call('/export',{ids:[photo.id],folder:path.join(output,'exports'),template:'plain',size:1200});await until(async()=>(await call('/jobs/'+job.id)).status==='done');
 const sidecar=JSON.parse(fs.readFileSync(path.join(output,'exports',fs.readdirSync(path.join(output,'exports')).find(n=>n.endsWith('.recipe.json'))),'utf8'));
 if(sidecar.film_simulation?.revision!==library.film.revision)throw Error('Export lost film provenance');
 await editor.getByRole('button',{name:'照片库',exact:true}).click();await page.locator('.photo-card').click();await page.getByLabel('批量滤镜').selectOption('film:kodak_gold_200');await page.getByRole('button',{name:'应用滤镜',exact:true}).click();await until(async()=>(await call('/library')).photos[0].recipe.film_stock==='kodak_gold_200');
 if(errors.length)throw Error(errors.join('\n'));const report={status:'passed',stocks:Object.values(library.film.stocks).filter(s=>s.ready).length,creative_styles:Object.keys(library.styles).length,stock:photo.recipe.film_stock,grain:photo.recipe.film_grain,revision:library.film.revision,undo_redo:true,batch_film:true,exported:fs.readdirSync(path.join(output,'exports')),browser_errors:errors};
 fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();child.kill();});
