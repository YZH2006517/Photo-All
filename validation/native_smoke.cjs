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
  if(process.env.PHOTOALL_NATIVE_CHROME==='1'){
    const state=command=>page.evaluate(command=>window.__TAURI_INTERNALS__.invoke('plugin:window|'+command,{label:'main'}),command);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.getByRole('banner',{name:'窗口标题栏'}).waitFor();
    if(await state('is_decorated'))throw Error('Windows native title bar remains');
    await page.getByRole('button',{name:'最大化窗口',exact:true}).click();
    await waitFor(()=>state('is_maximized'));
    await page.getByRole('button',{name:'还原窗口',exact:true}).click();
    await waitFor(async()=>!await state('is_maximized'));
    await page.locator('.window-drag').dblclick();
    await waitFor(()=>state('is_maximized'));
    await page.getByRole('button',{name:'还原窗口',exact:true}).click();
    await waitFor(async()=>!await state('is_maximized'));
    await page.screenshot({path:path.join(output,'window-chrome.png')});
    await page.getByRole('button',{name:'最小化窗口',exact:true}).click();
    await waitFor(()=>state('is_minimized'));
    // DOM click works while minimized, and still exercises the guarded close path.
    await page.getByRole('button',{name:'关闭窗口',exact:true}).evaluate(button=>button.click());
    await waitFor(()=>closed);
    if(errors.length)throw Error(errors.join('\n'));
    const report={status:'passed',version:'0.10.6',frameless:true,maximize_restore:true,double_click_maximize:true,minimize:true,guarded_close:true,browser_errors:errors};
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({output,...report},null,2));return;
  }
  const session=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('connection'));
  const call=async(route,body)=>{const response=await fetch(`http://127.0.0.1:${session.port}/api${route}`,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+session.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return response.json();};
  const job=await call('/import',{paths:[path.join(__dirname,'inputs/recognition-fixture.jpg')]});
  await waitFor(async()=>(await call('/jobs/'+job.id)).status==='done');
  await page.reload();
  if(process.env.PHOTOALL_NATIVE_WETLAB==='1'){
    await page.emulateMedia({reducedMotion:'no-preference'});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.getByRole('button',{name:'首页胶片暗房',exact:true}).click();
    await page.getByRole('button',{name:'进入创作暗房',exact:true}).click();
    const lab=page.getByRole('region',{name:'创作暗房'}),scene=lab.locator('.cl-scene');
    await waitFor(()=>scene.getAttribute('data-renderer').then(v=>v==='ready'));
    if(await lab.locator('.cl-proof').count())throw Error('Native proof panel remains');await lab.getByRole('button',{name:'场景照片显示',exact:true}).click();await waitFor(()=>scene.getAttribute('data-photo-visible').then(v=>v==='true'));
    const mix=async()=>JSON.parse(await lab.getAttribute('data-mix'));
    const target=async id=>{const box=await scene.boundingBox(),points=JSON.parse(await scene.getAttribute('data-targets'));return{x:box.x+points[id].x,y:box.y+points[id].y};};
    await page.screenshot({path:path.join(output,'native-formula.png')});
    if(!(await lab.locator('.cl-dial-arc text').allTextContents()).includes('100%'))throw Error('Native idle dial is missing scale numbers');
    const pin=await target('proof-photo'),pinned=JSON.parse(await scene.getAttribute('data-pin-position'));
    await page.mouse.move(pin.x,pin.y);await page.mouse.down();await page.mouse.move(pin.x-65,pin.y-20,{steps:8});await page.mouse.up();
    await waitFor(()=>scene.getAttribute('data-pin-position').then(value=>{const point=JSON.parse(value);return point[0]<pinned[0]-.25&&point[2]===pinned[2];}));
    const bottle=await target('warm');await page.mouse.move(bottle.x,bottle.y);await lab.getByRole('tooltip').waitFor();
    await lab.locator('.cl-bottle-note').waitFor();
    await waitFor(()=>scene.getAttribute('data-bottle-lift').then(v=>Number(v)>.08));
    const cup=await target('cup');
    await page.mouse.down();await page.mouse.move(cup.x,cup.y,{steps:12});
    if((await mix()).doses.warm!==0)throw Error('Native pre-release dose was applied');
    await page.mouse.up();
    await waitFor(async()=>Number(await scene.getAttribute('data-cap-lift'))>.08&&await scene.getAttribute('data-pouring')==='false');
    const dose=lab.getByRole('group',{name:/暖金.*倾倒用量/});
    await dose.waitFor();
    if(Number(await scene.getAttribute('data-cap-lift'))<.25)throw Error('Native metering started with the bottle capped');
    const handle=await dose.getByRole('button',{name:'按住滑动定量，松开倾倒'}).boundingBox();
    const doseX=handle.x+handle.width/2,doseY=handle.y+handle.height/2;
    await page.mouse.move(doseX,doseY);await page.mouse.down();await page.mouse.move(doseX,doseY-30,{steps:6});
    const volume=dose.getByRole('slider',{name:'用量毫升'});
    await waitFor(()=>volume.inputValue().then(v=>v==='30'));
    await page.mouse.move(doseX,doseY-20,{steps:4});
    await waitFor(()=>volume.inputValue().then(v=>v==='20'));
    if((await mix()).doses.warm!==0)throw Error('Native unconfirmed dose was applied');
    await page.mouse.up();
    await waitFor(()=>mix().then(m=>m.doses.warm===.2));
    await waitFor(()=>scene.getAttribute('data-pouring').then(value=>value==='true'));
    await page.screenshot({path:path.join(output,'native-pour.png')});
    await waitFor(()=>scene.getAttribute('data-pouring').then(value=>value==='false'));
    await page.emulateMedia({reducedMotion:'reduce'});
    await lab.getByRole('button',{name:'显影台',exact:true}).click();await waitFor(()=>scene.getAttribute('data-visible-sets').then(v=>v==='develop'));
    if(await lab.locator('.cl-proof').count())throw Error('Native old proof panel remains');await lab.getByRole('button',{name:'开始显影',exact:true}).click();await waitFor(()=>scene.getAttribute('data-process-progress').then(v=>Number(v)>.2));await lab.getByRole('button',{name:'暂停显影',exact:true}).click();await lab.getByRole('button',{name:'继续显影',exact:true}).click();await waitFor(()=>scene.getAttribute('data-process').then(v=>v==='done'));if((await mix()).development<.4)throw Error('Native physical development did not affect recipe');
    const prior=(await mix()).timer,timer=await target('timer');
    await page.mouse.move(timer.x+13,timer.y-16);await page.mouse.down();
    await lab.getByRole('tooltip',{name:'显影计时刻度'}).locator('svg').waitFor();
    await page.mouse.move(timer.x+29,timer.y+17,{steps:12});await page.mouse.up();
    await waitFor(()=>mix().then(m=>m.timer>prior+.08));
    await waitFor(()=>lab.locator('.cl-preview-state').textContent().then(v=>v==='精细成像'));
    await page.screenshot({path:path.join(output,'native-creative-darkroom.png')});
    await lab.getByRole('button',{name:'调色台',exact:true}).click();
    await waitFor(()=>scene.getAttribute('data-visible-sets').then(v=>v==='colour'));
    const paper=await target('bath-paper'),bath=await target('bath');
    await page.mouse.move(paper.x,paper.y);await page.mouse.down();await page.mouse.move(bath.x,bath.y,{steps:12});
    await waitFor(()=>mix().then(m=>m.bath>.04));await page.mouse.up();
    await page.screenshot({path:path.join(output,'native-toning.png')});
    await lab.getByRole('button',{name:'成品台',exact:true}).click();
    await waitFor(()=>scene.getAttribute('data-visible-sets').then(v=>v==='finish'));
    await page.screenshot({path:path.join(output,'native-finishing.png')});
    await lab.getByRole('button',{name:'应用到照片',exact:true}).click();
    await lab.getByText('调配已写入照片，可在编辑器中继续调整或撤销。',{exact:true}).waitFor();
    const saved=(await call('/library')).photos[0];if(!(saved.recipe.temperature>0))throw Error('Native creative edit not saved');
    await lab.getByRole('button',{name:'观片暗房',exact:true}).click();await lab.waitFor({state:'detached'});
    await page.getByRole('button',{name:'退出胶片暗房',exact:true}).click();
    await page.getByRole('button',{name:'关闭窗口',exact:true}).click();await waitFor(()=>closed);
    let reachable=true;try{await call('/library');}catch{reachable=false;}
    if(reachable||errors.length)throw Error('Native creative errors '+JSON.stringify({reachable,errors}));
    const report={status:'passed',version:'0.10.6',native_creative:true,native_physical_darkroom:true,native_immersive_darkroom:true,native_measured_pour:true,native_drag_then_meter:true,native_up_increases_dose:true,native_visible_cap_and_liquid:true,native_opens_before_metering:true,native_live_timer_scale:true,native_bottle_hover_and_arc:true,native_numbered_dial_arc:true,native_pinned_photo:true,explicit_timed_development:true,real_three_scene:true,real_bottle_drag:true,analog_timer:true,precise_preview:true,single_photo_apply:true,guarded_close:true,backend_cleanup:true,browser_errors:errors};
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report},null,2));return;
  }
  if(process.env.PHOTOALL_NATIVE_BORDERS==='1'){
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.evaluate(()=>localStorage.setItem('photoall-theme','dark'));await page.reload();
    await page.getByRole('button',{name:/打开图集 /}).first().click();
    await page.locator('.photo-card').first().dblclick();
    const editor=page.getByRole('region',{name:'高精度照片编辑器'});
    await editor.getByRole('button',{name:'片边',exact:true}).click();
    await editor.getByRole('button',{name:'片边样式 经典 35mm',exact:true}).click();
    await editor.getByRole('textbox',{name:'签名',exact:true}).fill('Native film border');
    const preview=editor.getByLabel('片边导出预览',{exact:true});
    await waitFor(()=>preview.getAttribute('aria-busy').then(value=>value==='false'));
    await waitFor(()=>preview.locator('img').evaluateAll(images=>images.length>0&&images.every(image=>image.complete&&image.naturalWidth>0)));
    if(await preview.getByRole('alert').count())throw Error(await preview.getByRole('alert').textContent());
    await waitFor(async()=>JSON.parse((await call('/library')).photos[0].recipe.border||'{}').signature==='Native film border');
    const photo=(await call('/library')).photos[0];
    const exported=await call('/export',{ids:[photo.id],folder:path.join(output,'export'),format:'png',size:1200});
    let result;await waitFor(async()=>{result=await call('/jobs/'+exported.id);return result.status!=='running';});
    if(result.status!=='done'||result.result.outputs.length!==1||result.result.errors.length)throw Error('Native border export failed: '+JSON.stringify(result));
    const file=result.result.outputs[0],sidecar=JSON.parse(fs.readFileSync(file.replace(/\.png$/,'.recipe.json'),'utf8'));
    if(fs.readFileSync(file)[24]!==16||sidecar.border.settings.style!=='film35'||sidecar.border.printed.signature!=='Native film border')throw Error('Native border export differs from preview');
    await page.screenshot({path:path.join(output,'native-borders.png')});
    await page.getByRole('button',{name:'关闭窗口',exact:true}).click();await waitFor(()=>closed);
    let reachable=true;try{await call('/library');}catch{reachable=false;}
    if(reachable||errors.length)throw Error('Native border errors: '+JSON.stringify({reachable,errors}));
    const report={status:'passed',version:'0.10.6',native_borders:true,real_preview:true,png16:true,custom_text:true,dark_editor:true,guarded_close:true,backend_cleanup:true,browser_errors:errors};
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report},null,2));return;
  }
  if(process.env.PHOTOALL_NATIVE_DARKROOM==='1'){
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.getByRole('button',{name:'首页胶片暗房',exact:true}).click();
    const room=page.getByRole('region',{name:'独立胶片暗房'}),scene=room.locator('.dr-scene');
    const showDock=async()=>{const size=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));await page.mouse.move(size.width/2,size.height-3);await waitFor(()=>room.locator('.dr-dock').boundingBox().then(box=>box.y<size.height-50));};
    await waitFor(()=>scene.getAttribute('data-renderer').then(value=>value==='ready'));
    await showDock();
    await room.locator('.dr-roll-choice').first().click();
    await waitFor(()=>room.locator('.dr-roll-title p').textContent().then(value=>value.includes('1/1')));
    await waitFor(()=>scene.getAttribute('data-motion').then(value=>value==='idle'));
    if(await scene.getAttribute('data-film-shadow-casters')!=='1'||Number(await scene.getAttribute('data-paper-reveal'))!==0||Number(await scene.getAttribute('data-optical-reveal'))!==1||Number(await scene.getAttribute('data-viewer-light'))!==0)throw Error('Native darkroom shadow or default parts are wrong');
    await scene.locator('canvas').dispatchEvent('wheel',{deltaY:-200,deltaMode:0});
    await waitFor(()=>scene.getAttribute('data-zoom').then(value=>Number(value)>1));
    await room.getByRole('button',{name:'重置暗房镜头距离',exact:true}).click();
    await waitFor(()=>scene.getAttribute('data-motion').then(value=>value==='idle'));
    await page.screenshot({path:path.join(output,'native-darkroom.png')});
    await showDock();
    await room.getByRole('button',{name:'查看照片',exact:true}).click();
    await waitFor(()=>room.locator('.dr-photo-viewer img').evaluateAll(images=>images.length>0&&images.every(image=>image.complete&&image.naturalWidth>0)));
    await page.keyboard.press('Escape');
    await showDock();
    await room.getByRole('button',{name:'收回暗房胶卷',exact:true}).click();
    await room.getByRole('button',{name:'退出胶片暗房',exact:true}).click();
    await room.waitFor({state:'detached'});
    await page.getByRole('button',{name:'关闭窗口',exact:true}).click();await waitFor(()=>closed);
    let reachable=true;try{await call('/library');}catch{reachable=false;}
    if(reachable||errors.length)throw Error('Native darkroom errors: '+JSON.stringify({reachable,errors}));
    const report={status:'passed',version:'0.10.6',native_darkroom:true,real_photo_texture:true,unified_shadow:true,optical_viewer:true,hover_dock:true,wheel_zoom:true,inspect_stow_exit:true,guarded_close:true,backend_cleanup:true,browser_errors:errors};
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report},null,2));return;
  }
  await page.getByRole('button',{name:/打开图集 /}).first().click();await page.locator('.photo-card').first().waitFor();
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
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  if(!closed&&browser){
    const page=browser.contexts()[0]?.pages().find(page=>page.url().startsWith('http://tauri.localhost'));
    if(page)await Promise.race([page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('finish_close')).catch(()=>{}),new Promise(resolve=>setTimeout(resolve,2500))]);
    if(!closed)await waitFor(()=>closed,2500).catch(()=>{});
  }
  if(!closed)child.kill();
  if(browser)await Promise.race([browser.close().catch(()=>{}),new Promise(resolve=>setTimeout(resolve,2500))]);
});
