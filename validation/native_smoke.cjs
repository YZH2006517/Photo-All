// Exercise the actual Tauri executable, including native close and child cleanup.
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=path.resolve(__dirname,'..');
const output=path.join(__dirname,'artifacts','native-'+Date.now());fs.mkdirSync(output,{recursive:true});
const data=path.join(output,'data');
const executable=process.env.PHOTOALL_TEST_EXECUTABLE||path.join(root,'product/src-tauri/target/debug/photo-all.exe');
const nativeButton=process.env.PHOTOALL_NATIVE_BUTTON==='1';
const child=spawn(executable,[],{windowsHide:!nativeButton,env:{...process.env,PHOTOALL_DATA_DIR:data,WEBVIEW2_USER_DATA_FOLDER:path.join(output,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9237 --remote-debugging-address=127.0.0.1'}});
let browser,closed=false;child.once('exit',()=>{closed=true;});
child.stderr.on('data',d=>process.stderr.write(d));
async function waitFor(check,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){try{if(await check())return;}catch{}await new Promise(r=>setTimeout(r,150));}throw Error('Native verification timeout');}
(async()=>{
  await waitFor(()=>fetch('http://127.0.0.1:9237/json/version').then(r=>r.ok));
  browser=await chromium.connectOverCDP('http://127.0.0.1:9237');
  const context=browser.contexts()[0];let page;
  await waitFor(async()=>{page=context.pages().find(p=>p.url().includes('tauri.localhost'));return !!page;});
  await page.getByRole('heading',{name:'图集',exact:true}).waitFor();
  const session=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('connection'));
  const call=async(route,body)=>{const response=await fetch(`http://127.0.0.1:${session.port}/api${route}`,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+session.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return response.json();};
  const job=await call('/import',{paths:[path.join(__dirname,'inputs/recognition-fixture.jpg')]});
  await waitFor(async()=>(await call('/jobs/'+job.id)).status==='done');
  await page.reload();await page.getByRole('button',{name:/打开图集 /}).first().click();await page.locator('.photo-card').first().waitFor();
  const compositeMode=process.env.PHOTOALL_NATIVE_COMPOSITE==='1';
  const lighttableMode=process.env.PHOTOALL_NATIVE_LIGHTTABLE==='1';
  if(lighttableMode){
    await page.getByRole('button',{name:'电子观片台',exact:true}).click();await page.getByRole('dialog',{name:'电子观片台'}).waitFor();
    await page.getByRole('button',{name:'观片台背光开关'}).click();await page.keyboard.press('v');await page.locator('.ft-magnifier').waitFor();await page.locator('.ft-optics img').first().waitFor();
    if(!await page.locator('.ft-optics').evaluate(el=>getComputedStyle(el).filter.includes('url(')))throw Error('Native optical refraction filter missing');
    await page.screenshot({path:path.join(output,'desktop-film-loupe.png')});await page.keyboard.press('Escape');await page.locator('.ft-magnifier').waitFor({state:'detached'});
    await page.mouse.move(700,5);await page.getByRole('button',{name:'胶片边框开关'}).click();if(await page.locator('.ft-rail').count())throw Error('Native film border did not hide');await page.screenshot({path:path.join(output,'desktop-images-only.png')});await page.getByRole('button',{name:'胶片边框开关'}).click();await page.locator('.ft-rail').first().waitFor();
    await page.keyboard.press('f');await waitFor(()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('viewer_fullscreen',{enabled:null})));
    await page.keyboard.press('Escape');await waitFor(async()=>!await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('viewer_fullscreen',{enabled:null})));
    if(await page.getByRole('dialog',{name:'电子观片台'}).count()!==1)throw Error('Escape left viewer before restoring fullscreen');
    await page.route('**/api/edit',async route=>{await new Promise(r=>setTimeout(r,1800));await route.continue();});
    await page.keyboard.press('p');
    if((await call('/library')).photos[0].decision!=='pending')throw Error('Review save was not pending at native close');
  }else if(compositeMode){
    await page.locator('.photo-card').first().click();await page.getByRole('button',{name:'多图层合成',exact:true}).click();
    await waitFor(async()=>(await call('/library')).composites.length===1);
    await page.evaluate(pendingDelay=>{const timer=window.setTimeout;window.setTimeout=(handler,delay,...args)=>timer(handler,delay===750?pendingDelay:delay,...args);},nativeButton?60000:8000);
    await page.getByLabel('图层透明度').fill('0.37');
    if((await call('/library')).composites[0].layers[0].opacity!==1)throw Error('Composite autosave was not pending');
  }else{
  await page.locator('.photo-card').first().dblclick();
  await page.getByRole('button',{name:'暖日胶片',exact:true}).waitFor();
  // Force the autosave debounce to remain pending until native close flushes it.
  await page.evaluate(pendingDelay=>{const timer=window.setTimeout;window.setTimeout=(handler,delay,...args)=>timer(handler,delay===350?pendingDelay:delay,...args);},nativeButton?60000:8000);
  await page.getByRole('button',{name:'暖日胶片',exact:true}).click();
  const before=(await call('/library')).photos[0].recipe.style;
  if(before!=='natural')throw Error('Autosave was not pending at close test');
  }
  await page.screenshot({path:path.join(output,'desktop-editor.png')});
  const brokenClose=process.env.PHOTOALL_TEST_CLOSE_FAILURE==='1';
  if(brokenClose)await page.evaluate(()=>{const invoke=window.__TAURI_INTERNALS__.invoke;window.__TAURI_INTERNALS__.invoke=(cmd,...args)=>cmd==='finish_close'?Promise.reject('runtime error: failed to send message to the webview'):invoke(cmd,...args);});
  if(nativeButton)console.log(JSON.stringify({ready_for_native_close:true,output,pid:child.pid}));
  else await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('plugin:window|close',{label:'main'})).catch(()=>{});
  await waitFor(()=>closed,nativeButton?60000:30000);
  const python='C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
  const sql=lighttableMode?"import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute('select decision from photos').fetchone()[0]);c.close()":compositeMode?"import sqlite3,json,sys; c=sqlite3.connect(sys.argv[1]); print(json.loads(c.execute('select document from composites').fetchone()[0])['layers'][0]['opacity']);c.close()":"import sqlite3,json,sys; c=sqlite3.connect(sys.argv[1]); print(json.loads(c.execute('select recipe from photos').fetchone()[0])['style']);c.close()";
  const verify=spawn(python,['-c',sql,path.join(data,'library.sqlite')],{windowsHide:true});
  let saved='';verify.stdout.on('data',d=>saved+=d);await new Promise(resolve=>verify.on('exit',resolve));
  if(saved.trim()!==(lighttableMode?'keep':compositeMode?'0.37':'warm'))throw Error('Native close lost pending edits: '+saved);
  let reachable=true;try{await call('/library');}catch{reachable=false;}
  if(reachable)throw Error('Backend remained alive after native window closed');
  const report={status:'passed',native_close_saved:true,native_button:nativeButton,composite_pending_close:compositeMode,lighttable_pending_close:lighttableMode,native_optical_loupe:lighttableMode,native_fullscreen_restore:lighttableMode,broken_window_channel_recovery:brokenClose,backend_cleanup:true,executable};
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close().catch(()=>{});if(!closed)child.kill();});
