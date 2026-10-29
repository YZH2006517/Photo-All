// Real renderer plus isolated Comparison/Picture components, with exact save acknowledgements.
const {spawn,spawnSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const {chromium}=require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=path.resolve(__dirname,'..'),output=path.join(__dirname,'artifacts','cache-geometry-'+Date.now());fs.mkdirSync(output,{recursive:true});
const python='C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const input=path.join(output,'source.png');
const made=spawnSync(python,['-c',`from PIL import Image,ImageDraw;im=Image.new('RGB',(4000,3000));d=ImageDraw.Draw(im);d.rectangle((0,0,1999,1499),fill=(210,40,30));d.rectangle((2000,0,3999,1499),fill=(35,180,70));d.rectangle((0,1500,1999,2999),fill=(35,70,205));d.rectangle((2000,1500,3999,2999),fill=(220,180,45));im.save(r'${input}')`],{encoding:'utf8'});if(made.status)throw Error(made.stderr);
const service=spawn(python,['-B','-u',path.join(root,'product/service.py'),'--data-dir',path.join(output,'data')],{windowsHide:true});service.stderr.on('data',d=>process.stderr.write(d));let browser;
async function until(fn,message,ms=15000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,60));}throw Error(message);}
(async()=>{
 const connection=JSON.parse(await new Promise(resolve=>readline.createInterface({input:service.stdout}).once('line',resolve)));
 const call=async(route,body)=>{const response=await fetch(`http://127.0.0.1:${connection.port}/api${route}`,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+connection.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const value=await response.json();if(!response.ok)throw Error(value.error);return value;};
 const job=await call('/import',{paths:[input]});await until(async()=>(await call('/jobs/'+job.id)).status==='done','Import failed');
 const photo=async()=> (await call('/library')).photos[0];let current=await photo();
 const edit=async recipe=>{await call('/edit',{ids:[current.id],recipe});return photo();};
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1000,height:1000}}),errors=[];let originalRequests=0;
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().includes('/api/image/')&&new URL(r.url()).searchParams.get('original')==='1')originalRequests++;});
 await page.goto(`http://127.0.0.1:1420/#port=${connection.port}&token=${connection.token}`);
 await page.evaluate(async()=>{
   const ReactModule=await import('/node_modules/.vite/deps/react.js'),ClientModule=await import('/node_modules/.vite/deps/react-dom_client.js'),Views=await import('/ui/Preview.tsx');
   const React=ReactModule.default||ReactModule,Client=ClientModule.default||ClientModule;
   const host=document.createElement('div');host.id='cache-geometry-harness';Object.assign(host.style,{position:'fixed',inset:'0',width:'800px',height:'600px',zIndex:'99999',background:'#ddd'});document.body.append(host);
   const root=Client.createRoot(host);
   window.cacheHarness={render:(photo,revision,mode='compare',size=512,uncropped=false)=>root.render(React.createElement(mode==='picture'?Views.Picture:Views.Comparison,{photo,revision,active:true,eager:true,quality:'source',size,uncropped,onLoaded:()=>{}})),size:(width,height)=>{host.style.width=width+'px';host.style.height=height+'px';}};
 });
 const render=async(p,revision,mode='compare',size=512,uncropped=false)=>page.evaluate(({p,revision,mode,size,uncropped})=>window.cacheHarness.render(p,revision,mode,size,uncropped),{p,revision,mode,size,uncropped});
 const imageInfo=async selector=>page.locator('#cache-geometry-harness '+selector).evaluate(img=>({width:img.naturalWidth,height:img.naturalHeight,src:img.src}));
 const settled=async()=>until(async()=>await page.locator('#cache-geometry-harness .picture.loading').count()===0&&await page.locator('#cache-geometry-harness img').count()>0,'Preview did not settle');
 const bothReady=async()=>{await settled();await until(()=>page.locator('#cache-geometry-harness .comparison-original.ready').count().then(n=>n===1),'Original geometry acknowledgement never became ready');};
 const chosen=process.argv[2]||'all',results={};
 if(chosen==='all'||chosen==='legacy'){
   await render(current,0);await bothReady();
   current=await edit({...current.recipe,quarter_turns:1,flip_x:1});await render(current,1);await bothReady();
   const edited=await imageInfo('.comparison-edited img'),original=await imageInfo('.comparison-original img');
   if(edited.width>=edited.height||edited.width!==original.width||edited.height!==original.height)throw Error('Legacy revision geometry differs between edited and original');
   results.legacy_rotate_flip=true;
 }
 if(chosen==='all'||chosen==='uncropped'){
   current=await edit({...current.recipe,quarter_turns:0,flip_x:0,crop_x:.35,crop_y:.25,crop_w:.25,crop_h:.5});
   await render({...current,committed_recipe:current.recipe},2,'compare',512,true);await bothReady();
   const box=await page.locator('#cache-geometry-harness .comparison-frame').boundingBox();
   if(Math.abs(box.width/box.height-4/3)>.002)throw Error('Uncropped comparison retained crop offsets: '+JSON.stringify(box));
   const edited=await imageInfo('.comparison-edited img'),original=await imageInfo('.comparison-original img');
   if(edited.width!==original.width||edited.height!==original.height)throw Error('Uncropped comparison geometry differs');results.uncropped_offsets=true;
 }
 if(chosen==='all'||chosen==='rounded'){
   current=await edit({...current.recipe,quarter_turns:0,flip_x:0,crop_x:.01,crop_y:.11,crop_w:.11,crop_h:.27});
   const acknowledged={...current,committed_recipe:current.recipe};await render(acknowledged,3,'picture',512);await settled();const small=await imageInfo('img');
   await render(acknowledged,3,'picture',1024);await settled();const larger=await imageInfo('img');
   if(Math.max(larger.width,larger.height)<=Math.max(small.width,small.height))throw Error('Rounded preview was incorrectly retained as native pixels');
   await render(acknowledged,3,'picture',0);await settled();const full=await imageInfo('img');
   if(full.width!==440||full.height!==810)throw Error('Native crop pixels missing: '+JSON.stringify(full));results.rounded_crop={small:[small.width,small.height],larger:[larger.width,larger.height],full:[full.width,full.height]};
 }
 if(chosen==='all'||chosen==='acks'){
   current=await edit({...current.recipe,quarter_turns:1,flip_x:1,crop_x:0,crop_y:0,crop_w:1,crop_h:1});const ack1=current.recipe;
   await render({...current,recipe:{...ack1,quarter_turns:2},committed_recipe:ack1},4);await bothReady();const before=await imageInfo('.comparison-original img');
   current=await edit({...ack1,quarter_turns:2});const ack2=current.recipe;
   await render({...current,recipe:{...ack2,quarter_turns:3},committed_recipe:ack2},4);await bothReady();
   const after=await imageInfo('.comparison-original img');if(after.src===before.src||after.width<=after.height)throw Error('Fast geometry acknowledgements cached newer unsaved edits');
   const beforeTone=originalRequests;current=await edit({...ack2,exposure:1});await render({...current,committed_recipe:current.recipe},5);await bothReady();
   if(originalRequests!==beforeTone)throw Error('Tonal acknowledgement reloaded original geometry');results.fast_acknowledgements=true;results.original_tonal_requests=0;
 }
 if(errors.length)throw Error(errors.join('\n'));const report={status:'passed',...results,browser_errors:errors};fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();service.kill();});
