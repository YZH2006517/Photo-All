// Real folder import, UI cancellation, partial catalog retention and resume.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
const { chromium } = require(process.env.PHOTOALL_PLAYWRIGHT || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(__dirname, 'artifacts', 'import-cancel-' + Date.now());
const python = process.env.PHOTOALL_PYTHON || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
fs.mkdirSync(output, {recursive:true});
const prepare = spawnSync(python, ['-c', `
from PIL import Image
from pathlib import Path
import hashlib,json
p=Path(r'${output}');(p/'inbox').mkdir()
for i in range(3):Image.new('RGB',(640,400),(40+i*50,100,180)).save(p/'inbox'/f'{i:02d}.png')
(p/'hashes.json').write_text(json.dumps({f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in (p/'inbox').iterdir()}))
`], {encoding:'utf8',windowsHide:true});
if (prepare.status) throw Error(prepare.stderr);
const child = spawn(python, ['-u', '-c', `
import sys,secrets,json,time
from pathlib import Path
sys.path.insert(0,r'${path.join(root,'product')}')
import engine,service
original=engine.analyze
calls=0
def paced(path,cancel=None):
 global calls
 calls+=1
 if calls>1 and not Path(r'${path.join(output,'resume.flag')}').exists():
  deadline=time.time()+25
  while time.time()<deadline:
   cancel.check();time.sleep(.03)
 return original(path,cancel=cancel)
engine.analyze=paced
server=service.create_server(Path(r'${path.join(output,'data')}'),secrets.token_urlsafe(32))
print(json.dumps({'port':server.server_port,'token':server.token}),flush=True)
try:server.serve_forever()
finally:server.server_close()
`], {windowsHide:true});
child.stderr.on('data', d => process.stderr.write(d));
let browser;
async function until(fn) { const end=Date.now()+30000; while(Date.now()<end) {if(await fn())return; await new Promise(r=>setTimeout(r,75));} throw Error('Import cancel verification timeout'); }
(async()=>{
 const connection=JSON.parse(await new Promise((resolve,reject)=>{readline.createInterface({input:child.stdout}).once('line',resolve);child.once('error',reject);}));
 const call=async(route,body)=>{const r=await fetch(`http://127.0.0.1:${connection.port}/api${route}`,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+connection.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const result=await r.json();if(!r.ok)throw Error(result.error);return result;};
 await call('/albums',{name:'可终止导入'});
 browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:940}}), errors=[],imports=[];
 page.on('pageerror', e=>errors.push(e.message));
 page.on('response', async response=>{if(response.url().endsWith('/api/import')&&response.request().method()==='POST')imports.push(await response.json());});
 await page.goto(`http://127.0.0.1:1420/#port=${connection.port}&token=${connection.token}`);
 await page.getByRole('button',{name:'打开图集 可终止导入',exact:true}).click();
 await page.evaluate(({folder,connection})=>{window.isTauri=true;window.__TAURI_INTERNALS__={invoke:async cmd=>{if(cmd==='pick_folder')return folder;if(cmd==='connection')return connection;throw Error('Unexpected native command '+cmd);}};},{folder:path.join(output,'inbox'),connection});
 const start=async()=>{await page.getByRole('button',{name:'导入照片',exact:true}).click();await page.getByRole('button',{name:'导入文件夹',exact:true}).click();};
 await start();await until(()=>imports.length===1);
 await until(async()=>{const job=await call('/jobs/'+imports[0].id);if(job.status==='error')throw Error(job.error);return job.done===1;});
 await page.getByRole('button',{name:'终止导入',exact:true}).waitFor();
 await page.screenshot({path:path.join(output,'01-import-running.png')});
 await page.getByRole('button',{name:'终止导入',exact:true}).click();
 let stopped;await until(async()=>{stopped=await call('/jobs/'+imports[0].id);return stopped.status==='cancelled';});
 if(stopped.result.imported!==1)throw Error('Completed import record was not retained');
 await until(()=>page.locator('.photo-card').count().then(n=>n===1));
 await page.getByText(/导入已终止，已新增 1 张/).waitFor();
 await page.screenshot({path:path.join(output,'02-import-cancelled.png')});
 fs.writeFileSync(path.join(output,'resume.flag'),'resume');await start();await until(()=>imports.length===2);
 let resumed;await until(async()=>{resumed=await call('/jobs/'+imports[1].id);return resumed.status==='done';});
 await until(()=>page.locator('.photo-card').count().then(n=>n===3));
 if(resumed.result.imported!==2)throw Error('Resuming duplicated an already imported source');
 const verify=spawnSync(python,['-c',`from pathlib import Path;import hashlib,json;p=Path(r'${output}');old=json.loads((p/'hashes.json').read_text());assert all(hashlib.sha256((p/'inbox'/name).read_bytes()).hexdigest()==value for name,value in old.items())`],{encoding:'utf8',windowsHide:true});
 if(verify.status)throw Error(verify.stderr);if(errors.length)throw Error(errors.join('\n'));
 const report={status:'passed',folder_import_cancel:true,cancelled_imported:stopped.result.imported,completed_rows_visible:true,resumed_imported:resumed.result.imported,total_rows:3,source_hashes_unchanged:true,browser_errors:errors};
 fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();child.kill();});
