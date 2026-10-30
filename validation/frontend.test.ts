import { describe, expect, it } from 'vitest';
import * as model from '../product/ui/model';
describe('filter thumbnail cache identity',()=>{
  const sample = {id:7,path:'C:/photos/frame.jpg',digest:'source',recipe:{exposure:0,style:'warm',filter_id:'one',filter_strength:.2}} as any;
  it('reuses thumbnails when only the selected filter, legacy style or strength changes',()=>{
    expect(typeof model.filterPreviewKey).toBe('function');
    const changed={...sample,recipe:{...sample.recipe,style:'cool',filter_id:'two',filter_strength:.9}};
    expect(model.filterPreviewKey(sample,'target',180)).toBe(model.filterPreviewKey(changed,'target',180));
  });
  it('invalidates for adjusted source pixels and different target looks',()=>{
    expect(typeof model.filterPreviewKey).toBe('function');
    const changed={...sample,recipe:{...sample.recipe,exposure:1}};
    expect(model.filterPreviewKey(sample,'target',180)).not.toBe(model.filterPreviewKey(changed,'target',180));
    expect(model.filterPreviewKey(sample,'target',180)).not.toBe(model.filterPreviewKey(sample,'style:mono',180));
  });
});
import { selectPhotos, exportIds, recommendIds, persistRecipes, classifyPhotos, createCloseHandler, facetCounts, PreviewPool, splitPosition, mergeLibraryRecipes, reviewStep, reviewPair, reviewPhotos } from '../product/ui/model';
const photos = [
  {id:1,name:'海边.jpg',group_id:'a',decision:'keep',duplicate_of:null,score:70,captured:10,path:'a.jpg'},
  {id:2,name:'山间.NEF',group_id:'a',decision:'pending',duplicate_of:null,score:90,captured:20,path:'b.NEF'},
  {id:3,name:'重复.jpg',group_id:'b',decision:'pending',duplicate_of:1,score:99,captured:30,path:'c.jpg'},
  {id:4,name:'夜色.jpg',group_id:'b',decision:'reject',duplicate_of:null,score:80,captured:40,path:'d.jpg'},
] as any;

describe('RAW and JPEG display preference',()=>{
  const variants = [
    {id:11,path:'C:\\Travel\\DSC_001.NEF',name:'DSC_001.NEF'},
    {id:12,path:'c:/TRAVEL/dsc_001.JpEg',name:'dsc_001.JpEg'},
    {id:13,path:'C:/Travel/only-raw.DNG',name:'only-raw.DNG'},
    {id:14,path:'C:/Travel/only-jpeg.jpg',name:'only-jpeg.jpg'},
    {id:15,path:'C:/Other/DSC_001.jpg',name:'DSC_001.jpg'},
    {id:16,path:'C:/Travel/DSC_001.png',name:'DSC_001.png'},
    {id:17,path:'C:/Travel/DSC_001.ARW',name:'DSC_001.ARW'},
  ] as any;
  it('pairs only RAW/JPEG in the same case-folded directory and stem',()=>{
    expect(typeof model.applyVariantPreference).toBe('function');
    expect(model.applyVariantPreference(variants,'raw').map(p=>p.id)).toEqual([11,13,14,15,16,17]);
    expect(model.applyVariantPreference(variants,'jpeg').map(p=>p.id)).toEqual([12,13,14,15,16]);
    expect(model.applyVariantPreference(variants,'all')).toEqual(variants);
    expect(variants.map((p:any)=>p.id)).toEqual([11,12,13,14,15,16,17]);
  });
  it('preserves input order and all unpaired/other-format records',()=>{
    const reordered=[variants[4],variants[1],variants[3],variants[6],variants[0],variants[2],variants[5]];
    expect(model.applyVariantPreference(reordered,'raw').map(p=>p.id)).toEqual([15,14,17,11,13,16]);
    expect(model.applyVariantPreference([variants[1]],'raw')).toEqual([variants[1]]);
    expect(model.applyVariantPreference([], 'jpeg')).toEqual([]);
  });
  it('supports Unicode casefold and dotted stems without matching another directory',()=>{
    const input=[{id:1,path:'D:/相片/Straße.001.NEF'},{id:2,path:'d:/相片/STRASSE.001.JPG'},
      {id:3,path:'D:/相片/sub/straße.001.jpg'}] as any;
    expect(model.applyVariantPreference(input,'raw').map(p=>p.id)).toEqual([1,3]);
  });
  it('moves a hidden current photo to its paired version and keeps a visible selection',()=>{
    expect(typeof model.resolveVariantSelection).toBe('function');
    const raw=model.applyVariantPreference(variants,'raw'),jpeg=model.applyVariantPreference(variants,'jpeg');
    expect(model.resolveVariantSelection(variants,raw,12,[11,12,13,14,15,16,17])).toBe(11);
    expect(model.resolveVariantSelection(variants,jpeg,17,[11,12,13,14,15,16,17])).toBe(12);
    expect(model.resolveVariantSelection(variants,raw,15,[11,12,13,14,15,16,17])).toBe(15);
    expect(model.reviewStep(raw.map(p=>p.id),11,1)).toBe(13);
  });
  it('falls forward to the next surviving review frame, then backward, and handles an empty view',()=>{
    const visible=[variants[0],variants[3]];
    expect(model.resolveVariantSelection(variants,visible,13,[11,13,14])).toBe(14);
    expect(model.resolveVariantSelection(variants,[variants[0]],13,[11,13])).toBe(11);
    expect(model.resolveVariantSelection(variants,[],12,[11,12])).toBeUndefined();
  });
  it('expands only selected paired RAW/JPEG captures without leaking another folder or PNG',()=>{
    expect(typeof model.expandVariantScope).toBe('function');
    expect(model.expandVariantScope(variants,[12]).map(p=>p.id)).toEqual([11,12,17]);
    expect(model.expandVariantScope(variants,[16]).map(p=>p.id)).toEqual([16]);
    expect(model.expandVariantScope(variants,[15,13,15,999]).map(p=>p.id)).toEqual([13,15]);
    expect(model.expandVariantScope([variants[0],variants[6]],[11]).map(p=>p.id)).toEqual([11]);
    expect(model.expandVariantScope(variants,[])).toEqual([]);
  });
});
describe('real library selection', () => {
  it('combines search, group and decision without modifying the library', () => {
    expect(selectPhotos(photos, 'a', 'all', '山', 'time').map(p=>p.id)).toEqual([2]);
    expect(photos.length).toBe(4);
  });
  it('exports the explicit scope without substituting favorites or rejected decisions', () => {
    expect(exportIds(photos,'tiff16')).toEqual([2]);
    expect(exportIds(photos,'jpeg')).toEqual([1,2,3,4]);
    expect(exportIds([photos[1]],'jpeg')).toEqual([2]);
    expect(exportIds([],'jpeg')).toEqual([]);
  });
  it('never recommends exact duplicates or changes an explicit rejection', () => {
    expect(recommendIds(photos)).toEqual([2]);
  });
});

describe('pending edits',()=>{
  it('restores failed and unattempted photos without replacing newer edits',async()=>{
    const batch=new Map([[1,{exposure:1}],[2,{exposure:2}]]);
    const pending=new Map([[2,{exposure:3}]]);
    await expect(persistRecipes(batch,pending,async()=>{throw Error('offline');})).rejects.toThrow('offline');
    expect([...pending.keys()].sort()).toEqual([1,2]);
    expect(pending.get(2)?.exposure).toBe(3);
  });
});

describe('album classification',()=>{
  it('intersects color, tone, lightness and content without leaking another album',()=>{
    const collection=[
      {...photos[0],album_ids:[1],features:{color:'blue',tone:'cool',brightness:'dark',content:{label:'city'}}},
      {...photos[1],album_ids:[2],features:{color:'blue',tone:'cool',brightness:'dark',content:{label:'city'}}},
      {...photos[2],album_ids:[1],features:{color:'red',tone:'warm',brightness:'bright',content:null}},
    ];
    expect(classifyPhotos(collection as any,1,{color:'blue',tone:'cool',brightness:'dark',content:'city'}).map(p=>p.id)).toEqual([1]);
    expect(classifyPhotos(collection as any,1,{content:'unindexed'}).map(p=>p.id)).toEqual([3]);
  });
});

describe('desktop close recovery',()=>{
  it('saves before falling back to app exit when the window message channel is broken',async()=>{
    const calls:string[]=[];
    expect(typeof createCloseHandler).toBe('function');
    const close=createCloseHandler(async()=>{calls.push('saved');},async()=>{
      calls.push('window-close');throw Error('runtime error: failed to send message to the webview');
    },async()=>{calls.push('app-exit');},message=>{calls.push(message);});
    await close({preventDefault:()=>calls.push('prevent')});
    expect(calls).toEqual(['prevent','saved','window-close','app-exit']);
  });
  it('does not exit if saving fails and allows the next close attempt to retry',async()=>{
    let fail=true;const calls:string[]=[];
    expect(typeof createCloseHandler).toBe('function');
    const close=createCloseHandler(async()=>{if(fail)throw Error('disk full');},async()=>{calls.push('close');},async()=>{calls.push('quit');},message=>calls.push(message));
    await close({preventDefault:()=>{}});expect(calls).toEqual(['disk full']);
    fail=false;await close({preventDefault:()=>{}});expect(calls).toEqual(['disk full','close']);
  });
  it('coalesces repeated close requests while saving',async()=>{
    let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);let saves=0,exits=0;
    expect(typeof createCloseHandler).toBe('function');
    const close=createCloseHandler(async()=>{saves++;await gate;},async()=>{exits++;},async()=>{exits++;},()=>{});
    const first=close({preventDefault:()=>{}});const second=close({preventDefault:()=>{}});
    release();await Promise.all([first,second]);expect(saves).toBe(1);expect(exits).toBe(1);
  });
});

describe('dependent facets',()=>{
  const collection=[
    {...photos[0],features:{color:'blue',tone:'cool',brightness:'dark',content:{label:'city'}}},
    {...photos[1],features:{color:'blue',tone:'cool',brightness:'bright',content:{label:'city'}}},
    {...photos[2],features:{color:'red',tone:'warm',brightness:'dark',content:{label:'portrait'}}},
    {...photos[3],features:{color:'blue',tone:'cool',brightness:'dark',content:{label:'animal'}}},
  ] as any;
  it('updates each dimension using all other active facets without filtering itself',()=>{
    expect(typeof facetCounts).toBe('function');
    expect(facetCounts(collection,{color:'blue',brightness:'dark',content:'city'},'content')).toEqual({city:1,animal:1});
    expect(facetCounts(collection,{color:'blue',content:'portrait'},'color')).toEqual({red:1});
    expect(facetCounts(collection,{color:'blue',content:'city'},'brightness')).toEqual({dark:1,bright:1});
  });
});

describe('extended style facets',()=>{
  const collection=[
    {...photos[0],width:6000,height:4000,recipe:{style:'warm',film_stock:'portra400'},features:{color:'blue',saturation:.5,contrast:.22}},
    {...photos[1],width:3000,height:4000,recipe:{style:'natural',film_stock:'none'},features:{color:'blue',saturation:.1,contrast:.04}},
    {...photos[2],width:1600,height:1600,recipe:{style:'mono',film_stock:'none'},features:{color:'red',saturation:.3,contrast:.12}},
  ] as any;
  it('combines measurable color, geometry, source format and recipe filters',()=>{
    expect(classifyPhotos(collection,null,{saturation:'high',contrast:'high',orientation:'landscape',format:'jpeg',resolution:'large',style:'warm',film:'portra400'} as any).map(p=>p.id)).toEqual([1]);
    expect(classifyPhotos(collection,null,{orientation:'portrait',format:'raw'} as any).map(p=>p.id)).toEqual([2]);
  });
  it('updates new facet counts from all the other filters and identifies missing measurements',()=>{
    expect(facetCounts(collection,{color:'blue'},'saturation' as any)).toEqual({high:1,low:1});
    expect(facetCounts([{...collection[0],features:{}}],{},'contrast' as any)).toEqual({unindexed:1});
  });
  it('includes the HEIF extension in the HEIC format option',()=>{
    expect(classifyPhotos([{...collection[0],path:'portrait.heif'}],null,{format:'heic'}).map(p=>p.id)).toEqual([1]);
  });
});

describe('preview scheduling',()=>{
  it('deduplicates requests, bounds concurrency and reuses results across remounts',async()=>{
    expect(typeof PreviewPool).toBe('function');
    const pool=new PreviewPool(2,1024);let active=0,peak=0,loads=0;
    const release:Array<()=>void>=[];
    const load=async()=>{loads++;active++;peak=Math.max(peak,active);await new Promise<void>(r=>release.push(r));active--;return new Blob(['image']);};
    const a=pool.read('a',load),duplicate=pool.read('a',load),b=pool.read('b',load),c=pool.read('c',load);
    await Promise.resolve();expect(loads).toBe(2);release.splice(0).forEach(r=>r());
    await Promise.all([a,duplicate,b]);await Promise.resolve();release.splice(0).forEach(r=>r());await c;
    await pool.read('a',load);expect(loads).toBe(3);expect(peak).toBe(2);
  });
  it('never starts a queued request after its view has been removed',async()=>{
    expect(typeof PreviewPool).toBe('function');
    const pool=new PreviewPool(1,1024);let release!:()=>void,queuedLoads=0;
    const first=pool.read('active',async()=>{await new Promise<void>(r=>release=r);return new Blob(['a']);});
    const controller=new AbortController();
    const queued=pool.read('removed',async()=>{queuedLoads++;return new Blob(['b']);},controller.signal);
    const rejected=expect(queued).rejects.toMatchObject({name:'AbortError'});controller.abort();await rejected;
    release();await first;expect(queuedLoads).toBe(0);
  });
  it('keeps a shared request alive when only one consumer leaves',async()=>{
    expect(typeof PreviewPool).toBe('function');
    const pool=new PreviewPool(1,1024);let release!:()=>void;
    const controller=new AbortController();const load=async(signal:AbortSignal)=>{await new Promise<void>(r=>release=r);if(signal.aborted)throw Error('cancelled');return new Blob(['ok']);};
    const a=pool.read('same',load,controller.signal),b=pool.read('same',load);
    const rejected=expect(a).rejects.toMatchObject({name:'AbortError'});controller.abort();await rejected;release();expect((await b).size).toBe(2);
  });
});

describe('split comparison',()=>{
  it('maps the pointer into the displayed image, clamps edges and handles zero width',()=>{
    expect(typeof splitPosition).toBe('function');
    expect(splitPosition(250,100,300)).toBe(.5);
    expect(splitPosition(0,100,300)).toBe(0);
    expect(splitPosition(500,100,300)).toBe(1);
    expect(splitPosition(500,100,0)).toBe(.5);
  });
});

describe('edits while undo refresh is in flight',()=>{
  it('keeps the exact acknowledged recipe when an older library response arrives',()=>{
    const loaded={photos:[{id:1,recipe:{exposure:0},committed_recipe:{exposure:0}}]} as any;
    const live={photos:[{id:1,recipe:{exposure:2},committed_recipe:{exposure:1}}]} as any;
    const result=mergeLibraryRecipes(loaded,live,new Map([[1,1]]),new Map([[1,2]]));
    expect(result.photos[0].recipe.exposure).toBe(2);
    expect(result.photos[0].committed_recipe?.exposure).toBe(1);
  });
  it('preserves newer local parameters even when the save queue already flushed',()=>{
    expect(typeof mergeLibraryRecipes).toBe('function');
    const loaded={photos:[{id:1,recipe:{exposure:0}},{id:2,recipe:{exposure:.3}}]} as any;
    const live={photos:[{id:1,recipe:{exposure:1}},{id:2,recipe:{exposure:.1}}]} as any;
    const result=mergeLibraryRecipes(loaded,live,new Map([[1,1]]),new Map([[1,2]]));
    expect(result.photos.map(p=>p.recipe.exposure)).toEqual([1,.3]);
    expect(loaded.photos[0].recipe.exposure).toBe(0);
  });
});

describe('film lighttable sequence',()=>{
  it('keeps the chosen order and does not include photos outside the entry scope',()=>{
    expect(typeof reviewPhotos).toBe('function');
    expect(reviewPhotos(photos,[3,1,3,999]).map(p=>p.id)).toEqual([3,1]);
  });
  it('moves within bounds and skips the pinned comparison frame',()=>{
    expect(typeof reviewStep).toBe('function');
    expect(reviewStep([1,2,3],2,-1,1)).toBe(2);
    expect(reviewStep([1,2,3],2,1,1)).toBe(3);
    expect(reviewStep([1,2,3],3,1)).toBe(3);
    expect(reviewStep([1,2,3],999,1)).toBe(1);
  });
  it('never shows the same photo in both comparison panes',()=>{
    expect(typeof reviewPair).toBe('function');
    expect(reviewPair([1,2,3],1,1)).toEqual({current:2,reference:1});
    expect(reviewPair([1],1,1)).toEqual({current:1,reference:undefined});
  });
});

describe('physical film table geometry',()=>{
  it('removes rail height and side borders in both table and roll when decoration is disabled',()=>{
    const input=[{id:1,width:600,height:400},{id:2,width:400,height:600}];
    const table=model.filmTableLayout(input,2,false),roll=model.filmRollLayout(input,false);
    expect(table[0].height).toBe(120);expect(table[1].height).toBe(270);
    expect(roll[0].height).toBe(200);expect(roll[0].width).toBe(300);
    expect(roll[1].x).toBe(roll[0].x+roll[0].width);
  });
  it('joins different aspect ratios into one horizontal roll with continuous edges',()=>{
    expect(typeof model.filmRollLayout).toBe('function');
    const frames=model.filmRollLayout([{id:1,width:600,height:400},{id:2,width:400,height:600},{id:3,width:800,height:400}]);
    expect(frames[1].x).toBe(frames[0].x+frames[0].width);
    expect(frames[2].x).toBe(frames[1].x+frames[1].width);
    expect(frames.every(f=>f.y===frames[0].y&&f.height===frames[0].height)).toBe(true);
    expect(frames[1].width).toBeLessThan(frames[0].width);
  });
  it('encodes a neutral optical centre and opposing radial refraction at the edges',()=>{
    expect(typeof model.filmRefractionMap).toBe('function');
    const data=model.filmRefractionMap(5),pixel=(x:number,y:number)=>Array.from(data.slice((y*5+x)*4,(y*5+x)*4+4));
    expect(pixel(2,2)).toEqual([128,128,128,255]);
    expect(pixel(4,2)).toEqual([255,128,128,255]);
    expect(pixel(0,2)).toEqual([1,128,128,255]);
    expect(pixel(2,0)).toEqual([128,1,128,255]);
  });
  it('keeps portrait frames uncropped and places rows without overlaps',()=>{
    expect(typeof model.filmTableLayout).toBe('function');
    const frames=model.filmTableLayout([{id:1,width:600,height:400},{id:2,width:400,height:600},{id:3,width:800,height:400}],2);
    expect(frames[1].height).toBeGreaterThan(frames[0].height);
    expect(frames[2].y).toBeGreaterThanOrEqual(frames[1].y+frames[1].height);
    expect(frames[0].width).toBe(frames[1].width);
  });
  it('zooms around the pointer and magnifies the same scene point inside the loupe',()=>{
    expect(typeof model.filmTableZoom).toBe('function');
    const view={x:20,y:30,scale:.5},pointer={x:220,y:130};
    const next=model.filmTableZoom(view,pointer,1);
    expect((pointer.x-next.x)/next.scale).toBe((pointer.x-view.x)/view.scale);
    expect((pointer.y-next.y)/next.scale).toBe((pointer.y-view.y)/view.scale);
    const lens=model.filmLoupeTransform(view,pointer,3,200);
    const world={x:(pointer.x-view.x)/view.scale,y:(pointer.y-view.y)/view.scale};
    expect(world.x*lens.scale+lens.x).toBe(200);
    expect(world.y*lens.scale+lens.y).toBe(200);
  });
});
describe('explicit album selection for lighttable',()=>{
  it('returns the union of checked albums once and excludes unchecked photos',()=>{
    const input=[{id:1,album_ids:[1,2]},{id:2,album_ids:[2]},{id:3,album_ids:[3]}] as any;
    expect(typeof model.albumSelectionPhotos).toBe('function');
    expect(model.albumSelectionPhotos(input,[1,2]).map(p=>p.id)).toEqual([1,2]);
    expect(model.albumSelectionPhotos(input,[])).toEqual([]);
  });
});

describe('retained viewer pixels',()=>{
  const asset=(url:string,width=10,height=10)=>({url,width,height});
  it('does not mistake a rounded cropped preview one pixel below its bucket for native pixels',async()=>{
    let reads=0;
    const pool=new model.DecodedPreviewPool(8*1024*1024,async()=>++reads===1?asset('preview-511',278,511):asset('native',440,810),()=>{});
    const native={width:440,height:810};
    await pool.read('cropped',512,async()=>new Blob(['small']),undefined,native);
    expect(pool.sufficient('cropped',1024)).toBe(false);
    const full=await pool.read('cropped',1024,async()=>new Blob(['large']),undefined,native);
    expect(full.width).toBe(440);expect(reads).toBe(2);expect(pool.peek('cropped',0,false)).toBe(full);
  });
  it('reuses one decoded higher-resolution asset synchronously in smaller modes',async()=>{
    expect(typeof model.DecodedPreviewPool).toBe('function');
    let decodes=0;const pool=new model.DecodedPreviewPool(4096,async()=>{decodes++;return asset('shared',32,24);},()=>{});
    const first=await pool.read('photo',2048,async()=>new Blob(['pixels']));
    expect(pool.peek('photo',512)).toBe(first);
    expect(await pool.read('photo',512,async()=>{throw Error('Unnecessary fetch');})).toBe(first);
    expect(decodes).toBe(1);
  });
  it('evicts unreferenced decoded images by memory and protects displayed assets',async()=>{
    expect(typeof model.DecodedPreviewPool).toBe('function');
    let serial=0;const revoked:string[]=[];
    const pool=new model.DecodedPreviewPool(800,async()=>asset(String(++serial)),a=>revoked.push(a.url));
    const a=await pool.read('a',512,async()=>new Blob(['a']));pool.retain(a);
    await pool.read('b',512,async()=>new Blob(['b']));
    await pool.read('c',512,async()=>new Blob(['c']));
    expect(revoked).toEqual(['2']);expect(pool.peek('a',512)).toBe(a);
    pool.release(a);pool.clear();expect(revoked.sort()).toEqual(['1','2','3']);
  });
  it('keeps an active fetch across a view handoff after its first consumer aborts',async()=>{
    const pool=new PreviewPool(1,1024);let release!:()=>void,loads=0;
    const firstAbort=new AbortController();
    const load=async(signal:AbortSignal)=>{loads++;await new Promise<void>(r=>release=r);if(signal.aborted)throw Error('Cancelled');return new Blob(['same']);};
    const first=pool.read('handoff',load,firstAbort.signal);const rejected=expect(first).rejects.toMatchObject({name:'AbortError'});
    firstAbort.abort();await rejected;const second=pool.read('handoff',load);release();
    expect((await second).size).toBe(4);expect(loads).toBe(1);
  });
  it('shares decoding across a view handoff and reuses an in-flight larger request',async()=>{
    let release!:()=>void,loads=0,decodes=0;
    const pool=new model.DecodedPreviewPool(4096,async()=>{decodes++;return asset('decoded-shared',32,24);},()=>{});
    const controller=new AbortController();
    const load=async()=>{loads++;await new Promise<void>(r=>release=r);return new Blob(['pixels']);};
    const first=pool.read('frame',2048,load,controller.signal),rejected=expect(first).rejects.toMatchObject({name:'AbortError'});
    controller.abort();await rejected;const next=pool.read('frame',512,load);release();
    expect((await next).url).toBe('decoded-shared');expect(loads).toBe(1);expect(decodes).toBe(1);
  });
});

describe('display geometry and individual frame size',()=>{
  it('labels fast geometry acknowledgements using the exact saved recipe rather than newer live edits',()=>{
    const ack1={quarter_turns:1,flip_x:1,crop_x:0,crop_y:0,crop_w:1,crop_h:1};
    const live={id:1,digest:'photo',recipe:{...ack1,quarter_turns:2},committed_recipe:ack1} as any;
    const expected=model.photoPreviewFamily({...live,recipe:ack1,committed_recipe:undefined},true,1,'source');
    expect(model.photoPreviewFamily(live,true,1,'source')).toBe(expected);
    const ack2={...ack1,quarter_turns:2};
    const next={...live,recipe:{...ack2,quarter_turns:3},committed_recipe:ack2};
    expect(model.photoPreviewFamily(next,true,1,'source')).not.toBe(expected);
    expect(model.photoPreviewFamily({...next,committed_recipe:{...ack2,exposure:1}},true,2,'source')).toBe(model.photoPreviewFamily(next,true,1,'source'));
  });
  it('updates rotated/cropped aspect while original cache ignores tonal edits',()=>{
    expect(typeof model.photoDimensions).toBe('function');expect(typeof model.geometrySignature).toBe('function');
    const photo={width:400,height:300,recipe:{quarter_turns:1,crop_w:.5,crop_h:1}} as any;
    expect(model.photoDimensions(photo)).toEqual({width:150,height:400});
    expect(model.photoDimensions({width:400,height:300,recipe:{crop_x:.111,crop_w:.111}} as any)).toEqual({width:45,height:300});
    expect(model.photoDimensions({width:401,height:301,recipe:{crop_w:.5}} as any)).toEqual({width:200,height:301});
    expect(model.geometrySignature(photo.recipe)).toBe(model.geometrySignature({...photo.recipe,exposure:1,film_stock:'kodak'}));
    expect(model.geometrySignature(photo.recipe)).not.toBe(model.geometrySignature({...photo.recipe,flip_x:1}));
    expect(model.photoPreviewFamily(photo,true,0,'source',true)).not.toBe(model.photoPreviewFamily(photo,true,0,'source',false));
  });
  it('resizes one frame around its center while retaining fixed film rails',()=>{
    expect(typeof model.resizeFilmFrame).toBe('function');
    const frame={id:7,x:40,y:50,width:180,height:180};const larger=model.resizeFilmFrame(frame,2,true);
    expect(larger.width).toBe(348);expect(larger.height).toBe(300);
    expect(larger.x+larger.width/2).toBe(frame.x+frame.width/2);expect(larger.y+larger.height/2).toBe(frame.y+frame.height/2);
    expect(frame.width).toBe(180);
  });
});
