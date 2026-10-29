// Album choice and reversible context removal against isolated real files/catalog.
const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const {chromium}=require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=path.resolve(__dirname,'..'),output=path.join(__dirname,'artifacts','library-quality-'+Date.now());fs.mkdirSync(output,{recursive:true});
const python='C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe',child=spawn(python,['-u',path.join(root,'product/service.py'),'--data-dir',path.join(output,'data')],{windowsHide:true});let browser;child.stderr.on('data',d=>process.stderr.write(d));
async function until(fn){const end=Date.now()+30000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('Library quality timeout');}
(async()=>{
 const connection=JSON.parse(await new Promise(r=>readline.createInterface({input:child.stdout}).once('line',r)));
 const call=async(route,body)=>{const r=await fetch(`http://127.0.0.1:${connection.port}/api${route}`,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+connection.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const v=await r.json();if(!r.ok)throw Error(v.error);return v;};
 const a=await call('/albums',{name:'图集 A'}),b=await call('/albums',{name:'图集 B'}),c=await call('/albums',{name:'图集 C'}),paths=[];
 for(let i=0;i<3;i++){const f=path.join(output,`original-${i}.jpg`);fs.copyFileSync(path.join(__dirname,'inputs/recognition-fixture.jpg'),f);paths.push(f);}
 for(const [album,files] of [[a,paths.slice(0,2)],[b,paths.slice(2)]]){const job=await call('/import',{album_id:album.id,paths:files});await until(async()=>(await call('/jobs/'+job.id)).status==='done');}
 for(const album of [b,c]){const job=await call('/import',{album_id:album.id,paths:[paths[0]]});await until(async()=>(await call('/jobs/'+job.id)).status==='done');}
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:940}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:1420/#port=${connection.port}&token=${connection.token}`);await page.getByRole('button',{name:'首页电子观片台'}).click();
 const picker=page.getByRole('dialog',{name:'选择观片图集'});await picker.waitFor({timeout:4000});if(await page.getByRole('dialog',{name:'电子观片台',exact:true}).count())throw Error('Viewer opened before album choice');
 await picker.getByRole('checkbox',{name:'图集 A',exact:true}).check();await picker.getByRole('checkbox',{name:'图集 C',exact:true}).check();await picker.getByRole('button',{name:'开始观片'}).click();const viewer=page.getByRole('dialog',{name:'电子观片台',exact:true});await viewer.waitFor();
 await until(()=>viewer.getAttribute('data-ready').then(v=>v==='true'));
 if(await page.locator('.lt-contact-frame').count()!==2)throw Error('Unchecked album leaked into lighttable');
 await page.keyboard.press('i');await page.mouse.move(700,935);await page.getByLabel('跳转观片 original-0.jpg',{exact:true}).click({button:'right'});await page.getByRole('menuitem',{name:'删除照片',exact:true}).click();
 await until(()=>page.locator('.lt-contact-frame').count().then(n=>n===1));
 const shared=()=>call('/library').then(l=>l.photos.find(p=>p.path===paths[0]));
 const membership=(await shared()).album_ids;if(membership.length!==1||membership[0]!==b.id)throw Error('Home viewer removal changed unselected album membership: '+JSON.stringify(membership));
 await page.keyboard.press('Control+z');await until(()=>page.locator('.lt-contact-frame').count().then(n=>n===2));if((await shared()).album_ids.length!==3)throw Error('Home viewer removal undo did not restore both selected albums');
 await page.keyboard.press('Escape');await page.getByRole('heading',{name:'图集',exact:true}).waitFor();
 await page.getByRole('button',{name:'打开图集 图集 A'}).click();await page.locator('.photo-card').first().click({button:'right'});await page.getByRole('menuitem',{name:'从图集中移除'}).click();await until(()=>page.locator('.photo-card').count().then(n=>n===1));
 if(paths.some(p=>!fs.existsSync(p)))throw Error('Original file deleted');await page.getByLabel('撤销上次修改',{exact:true}).click();await until(()=>page.locator('.photo-card').count().then(n=>n===2));
 await page.getByLabel('重做上次修改',{exact:true}).click();await until(()=>page.locator('.photo-card').count().then(n=>n===1));await page.getByLabel('撤销上次修改',{exact:true}).click();await until(()=>page.locator('.photo-card').count().then(n=>n===2));
 await page.screenshot({path:path.join(output,'01-album-choice-and-removal.png')});
 const source=(await call('/library')).photos[0];const exports=[];
 for(const format of ['png','tiff','webp','jpeg','original']){const job=await call('/export',{ids:[source.id],folder:path.join(output,'exports'),format,template:'plain',size:0});let result;await until(async()=>{result=await call('/jobs/'+job.id);return result.status!=='running';});if(result.status!=='done'||result.result.errors.length)throw Error('Format failed '+format+': '+JSON.stringify(result));exports.push(...result.result.outputs);}
 if(errors.length)throw Error(errors.join('\n'));const report={status:'passed',explicit_album_choice:true,unchecked_excluded:true,home_multi_album_scoped_remove_undo:true,reversible_removal:true,originals_intact:true,formats:exports.map(p=>path.extname(p)),browser_errors:errors};fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();child.kill();});
