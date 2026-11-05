// Focused real-service checks for the editor's non-destructive export frames.
const {spawn,spawnSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const {chromium}=require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=path.resolve(__dirname,'..'),output=path.join(__dirname,'artifacts','borders-'+Date.now());
const python='C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
fs.mkdirSync(output,{recursive:true});
function script(code){const r=spawnSync(python,['-c',code],{encoding:'utf8',windowsHide:true});if(r.status)throw Error(r.stderr||r.stdout);return r.stdout;}
script(`
import sys,hashlib
from pathlib import Path
sys.path.insert(0,r'${path.join(root,'product')}')
import engine
from PIL import Image
folder=Path(r'${output}');(folder/'input').mkdir()
image=engine.analysis_image(Path(r'${path.join(root,'validation/inputs/D7000.NEF')}'))[0];image.thumbnail((1200,800))
exif=Image.Exif();exif[36867]='2024:05:06 07:08:09';exif[271]='TEST';exif[272]='Fixture Camera';exif[33437]=2.8;exif[33434]=.004;exif[37386]=50.;exif[34855]=400
source=folder/'input/landscape.jpg';image.save(source,quality=95,exif=exif)
portrait=folder/'input/portrait.jpg';image.rotate(90,expand=True).save(portrait,quality=95)
c=engine.Catalog(folder/'data/library.sqlite');album=c.create_album('片边测试');c.import_files([source,portrait],album_id=album['id']);b=c.create_album('共享图集 B');c.import_files([source],album_id=b['id']);c.close()
(folder/'source.sha').write_text(hashlib.sha256(source.read_bytes()).hexdigest())
`);
const backend=spawn(python,['-u',path.join(root,'product/service.py'),'--data-dir',path.join(output,'data')],{windowsHide:true});
backend.stderr.on('data',d=>process.stderr.write(d));
const frontend=spawn(process.execPath,[path.join(root,'product/node_modules/vite/bin/vite.js'),'preview','--host','127.0.0.1','--port','1420','--strictPort'],{cwd:path.join(root,'product'),windowsHide:true});
const ready=new Promise((resolve,reject)=>{frontend.stdout.on('data',d=>{if(d.toString().includes('Local:'))resolve();});frontend.once('exit',c=>reject(Error('Frontend exit '+c)));});
let browser,page;
async function until(fn,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('Frame verification timed out');}
(async()=>{
  const connection=JSON.parse(await new Promise((resolve,reject)=>{readline.createInterface({input:backend.stdout}).once('line',resolve);backend.once('error',reject);}));await ready;
  const call=async(route,body)=>{const response=await fetch(`http://127.0.0.1:${connection.port}/api${route}`,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+connection.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const data=await response.json();if(!response.ok)throw Error(JSON.stringify(data));return data;};
  const initial=await call('/library'),photo=initial.photos.find(p=>p.name==='landscape.jpg');
  const info=await call('/border-info',{id:photo.id});
  if(info.date!=='2024.05.06'||!info.exposure.includes('ISO 400')||info.roll_name!=='片边测试')throw Error('EXIF or album metadata is wrong: '+JSON.stringify(info));
  browser=await chromium.launch({channel:'chrome',headless:true});page=await browser.newPage({viewport:{width:1600,height:1040}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>localStorage.setItem('photoall-theme','dark'));
  await page.goto(`http://127.0.0.1:1420/#port=${connection.port}&token=${connection.token}`);
  await page.getByRole('button',{name:'打开图集 片边测试',exact:true}).waitFor();
  const darkStyles=await page.locator('.album-card').first().evaluate(el=>({background:getComputedStyle(el).backgroundColor,decoration:getComputedStyle(el).textDecorationLine}));
  if(darkStyles.background!=='rgba(0, 0, 0, 0)'||darkStyles.decoration!=='none')throw Error('Dark album card has an opaque block or link underline: '+JSON.stringify(darkStyles));
  await page.screenshot({path:path.join(output,'00-dark-home.png')});
  await page.getByRole('button',{name:'打开图集 片边测试',exact:true}).click();
  await page.locator('.photo-card').filter({hasText:'landscape.jpg'}).dblclick();
  const editor=page.getByRole('region',{name:'高精度照片编辑器'});
  await editor.getByRole('button',{name:'片边',exact:true}).click();
  const preview=editor.getByLabel('片边导出预览',{exact:true});
  const waitPreview=async()=>{await until(()=>preview.getAttribute('aria-busy').then(v=>v==='false'));if(await preview.getByRole('alert').count())throw Error(await preview.getByRole('alert').textContent());};
  await editor.getByRole('button',{name:'片边样式 经典 35mm',exact:true}).click();await waitPreview();
  await editor.getByRole('textbox',{name:'卷名',exact:true}).fill('秋日散步');
  await editor.getByRole('textbox',{name:'签名',exact:true}).fill('摄影 / 张三');
  await editor.getByRole('combobox',{name:'片边日期来源',exact:true}).selectOption('custom');
  await editor.getByRole('textbox',{name:'拍摄日期',exact:true}).fill('2026.11.02');
  await editor.getByRole('combobox',{name:'片边信息来源',exact:true}).selectOption('custom');
  await editor.getByRole('textbox',{name:'拍摄信息',exact:true}).fill('50mm · f/2 · 1/250s · ISO 400');
  await until(async()=>JSON.parse((await call('/library')).photos.find(p=>p.id===photo.id).recipe.border||'{}').info_text?.includes('1/250s'));
  await waitPreview();
  await page.screenshot({path:path.join(output,'01-film-editor.png')});
  await editor.getByRole('button',{name:'撤销上次修改',exact:true}).click();
  await until(async()=>JSON.parse((await call('/library')).photos.find(p=>p.id===photo.id).recipe.border||'{}').info_text!=='50mm · f/2 · 1/250s · ISO 400');
  await editor.getByRole('button',{name:'重做上次修改',exact:true}).click();
  await until(async()=>JSON.parse((await call('/library')).photos.find(p=>p.id===photo.id).recipe.border||'{}').info_text==='50mm · f/2 · 1/250s · ISO 400');
  await waitPreview();
  const before=await preview.locator('img').getAttribute('src');
  await editor.getByRole('button',{name:'片边样式 即影即有',exact:true}).click();
  await until(()=>preview.locator('img').getAttribute('src').then(src=>src!==before));await waitPreview();
  await page.screenshot({path:path.join(output,'02-instant-editor.png')});
  const styles=['无片边','经典 35mm','暖棕负片','幻灯片框','即影即有','画廊留白','旅行明信片','宽幕黑边','档案卡片','黑白 35mm','120 中画幅','实扫毛边'];
  for(const name of styles){await editor.getByRole('button',{name:'片边样式 '+name,exact:true}).click();await waitPreview();}
  await editor.getByRole('button',{name:'导出作品',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'导出作品',exact:true});await dialog.waitFor();
  if(await dialog.getByRole('combobox',{name:'导出画面模板',exact:true}).inputValue()!=='recipe')throw Error('Export ignores per-photo frame settings');
  await page.screenshot({path:path.join(output,'03-export.png')});
  const job=await call('/export',{ids:[photo.id],folder:path.join(output,'export'),template:'recipe',size:0,format:'png',folder_mode:'single'});
  let result;await until(async()=>{result=await call('/jobs/'+job.id);return result.status!=='running';});
  if(result.status!=='done'||result.result.outputs.length!==1||result.result.errors.length)throw Error('Framed export failed '+JSON.stringify(result));
  const current=(await call('/library')).photos.find(p=>p.id===photo.id),savedBorder=JSON.parse(current.recipe.border);
  await call('/edit',{ids:[photo.id],recipe_patch:{border:JSON.stringify({...savedBorder,roll_name:''})}});
  const secondary=(await call('/library')).albums.find(a=>a.name==='共享图集 B');
  const sharedJob=await call('/export',{ids:[photo.id],folder:path.join(output,'shared-export'),size:1200,format:'png',album_ids:[secondary.id]});
  let sharedResult;await until(async()=>{sharedResult=await call('/jobs/'+sharedJob.id);return sharedResult.status!=='running';});
  if(sharedResult.status!=='done'||sharedResult.result.errors.length)throw Error('Shared-album export failed');
  const sharedPath=sharedResult.result.outputs[0],sharedMeta=JSON.parse(fs.readFileSync(sharedPath.replace(/\.png$/,'.recipe.json'),'utf8'));
  if(sharedMeta.template!=='recipe'||sharedMeta.border.printed.roll!==info.roll_name)throw Error('Automatic roll name differs between preview and export');
  await call('/edit',{ids:[photo.id],recipe_patch:{border:JSON.stringify(savedBorder)}});
  const exported=result.result.outputs[0];if(fs.readFileSync(exported)[24]!==16)throw Error('PNG export is not 16-bit');
  const sidecar=JSON.parse(fs.readFileSync(exported.replace(/\.png$/,'.recipe.json'),'utf8'));
  if(sidecar.border.settings.signature!=='摄影 / 张三'||sidecar.border.printed.date!=='2026.11.02')throw Error('Exported frame text differs from editor');
  script(`
import hashlib,sys
from pathlib import Path
sys.path.insert(0,r'${path.join(root,'product')}')
import borders,engine,pixels
from PIL import Image,ImageDraw
root=Path(r'${output}');assert hashlib.sha256((root/'input/landscape.jpg').read_bytes()).hexdigest()==(root/'source.sha').read_text()
source=engine.render_pixels(root/'input/landscape.jpg',engine.validate_recipe({}),max_size=(700,700))
sheet=Image.new('RGB',(1200,1390),'#e6e3da');draw=ImageDraw.Draw(sheet)
for i,(style,item) in enumerate(borders.STYLES.items()):
    image,_=borders.compose(source,{'style':style,'roll_name':'秋日散步','signature':'摄影 / 张三','date_mode':'custom','date_text':'2026.11.02','info_mode':'custom','info_text':'50mm · f/2 · ISO 400'},{})
    target=root/(style+'.png');pixels.write(target,image,'png8')
    with Image.open(target) as preview:
        preview.thumbnail((365,280));x=18+i%3*400;y=24+i//3*342
        sheet.paste(preview,(x+(365-preview.width)//2,y+(280-preview.height)//2))
        draw.text((x+8,y+293),item[0],font=borders.font('sans',18,True),fill='#343d35')
sheet.save(root/'04-styles.png')
`);
  if(errors.length)throw Error(errors.join('\n'));
  const report={status:'passed',styles:12,exif_and_album:true,custom_date_roll_signature:true,undo_redo:true,editor_preview:true,default_export_recipe:true,png16:true,selected_photo_only:true,source_untouched:true,dark_mode_cards:true,shared_album_roll_consistency:true,api_default_recipe:true,browser_errors:errors};
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report},null,2));
})().catch(async error=>{console.error(error);if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();backend.kill();frontend.kill();});
