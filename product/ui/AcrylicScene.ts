// SPDX-License-Identifier: GPL-3.0-or-later
// Procedural reconstruction from the user's reference; no third-party model.
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

export function makeAcrylicScene(renderer: THREE.WebGLRenderer, anisotropy: number) {
  const root = new THREE.Group();
  root.name = "acrylic-gallery";
  const acrylic = new THREE.MeshPhysicalMaterial({
    color: "#ffffff", roughness: .055, transmission: 1, thickness: .19, ior: 1.49,
    attenuationColor: "#96c8bc", attenuationDistance: 2.4,
    clearcoat: .35, clearcoatRoughness: .08, envMapIntensity: 1.2,
  });
  let reflections: THREE.WebGLRenderTarget | undefined;
  const plinthMat = new THREE.MeshStandardMaterial({ color: "#aea89d", roughness: .8 });
  const filmMat = new THREE.MeshStandardMaterial({ color: "#252a25", roughness: .72,
    side: THREE.DoubleSide });
  const pieces: { object: THREE.Group; position: THREE.Vector3; delay: number }[] = [];
  function part(name: string, delay: number) {
    const object = new THREE.Group(); object.name = name; root.add(object);
    pieces.push({ object, position: object.position.clone(), delay }); return object;
  }
  function box(parent: THREE.Object3D, w: number, h: number, d: number,
    x: number, y: number, z: number, material: THREE.Material) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w,h,d),material);
    mesh.position.set(x,y,z); mesh.receiveShadow=true;
    mesh.castShadow=material===plinthMat || material===filmMat;
    parent.add(mesh); return mesh;
  }
  function rounded(w: number,h: number,r: number) {
    const s=new THREE.Shape(),x=-w/2,y=-h/2;
    s.moveTo(x+r,y);s.lineTo(x+w-r,y);s.quadraticCurveTo(x+w,y,x+w,y+r);
    s.lineTo(x+w,y+h-r);s.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
    s.lineTo(x+r,y+h);s.quadraticCurveTo(x,y+h,x,y+h-r);
    s.lineTo(x,y+r);s.quadraticCurveTo(x,y,x+r,y);return s;
  }
  const pedestal=part("stone-plinth",0);
  box(pedestal,12,.34,4.5,0,-.37,0,plinthMat);
  const feet=part("clear-feet",.12);
  for(const x of [-4,4]) {
    box(feet,1.55,.10,1.9,x,-.15,.18,acrylic);
    box(feet,.19,.63,.40,x,.18,-.12,acrylic);
  }
  box(feet,1.85,.10,1.9,5.05,-.15,.18,acrylic);
  const cassette=part("current-film-cassette",.58);
  cassette.position.set(5.05,-.09,.15);
  pieces[pieces.length-1].position.copy(cassette.position);
  const frame=part("thick-acrylic-frame",.25);
  const outer=rounded(10.1,2.38,.16);
  const shell=new THREE.Mesh(new THREE.ExtrudeGeometry(outer,{depth:.15,bevelEnabled:true,
    bevelSize:.045,bevelThickness:.035,bevelSegments:3,steps:1}),acrylic);
  shell.position.set(0,1.53,-.08);frame.add(shell);
  // A second polished leaf in front of the strip catches the softbox at grazing angles.
  const cover = new THREE.Mesh(new THREE.ExtrudeGeometry(rounded(9.86,2.13,.095), {
    depth:.045, bevelEnabled:true, bevelSize:.025, bevelThickness:.018, bevelSegments:4,
  }), acrylic);
  cover.position.set(0,1.53,.255);
  frame.add(cover);
  box(frame,.12,.20,.16,-4.82,2.60,.02,new THREE.MeshStandardMaterial({color:"#343733",roughness:.8}));
  const strip=part("six-frame-film",.43);
  // One perforated substrate, with continuous 135-film pitch across all frames.
  const shape=new THREE.Shape();shape.moveTo(-4.70,.67);shape.lineTo(4.70,.67);
  shape.lineTo(4.70,2.40);shape.lineTo(-4.70,2.40);shape.closePath();
  for(let i=0;i<72;i++)for(const y of [.75,2.20]) {
    const hole=new THREE.Path(),x=-4.64+i*.130;
    const w=.072,h=.13,r=.016;
    hole.moveTo(x+r,y);hole.lineTo(x+w-r,y);hole.quadraticCurveTo(x+w,y,x+w,y+r);
    hole.lineTo(x+w,y+h-r);hole.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
    hole.lineTo(x+r,y+h);hole.quadraticCurveTo(x,y+h,x,y+h-r);
    hole.lineTo(x,y+r);hole.quadraticCurveTo(x,y,x+r,y);shape.holes.push(hole);
  }
  const base=new THREE.Mesh(new THREE.ShapeGeometry(shape,48),filmMat);base.position.z=.13;
  strip.add(base);
  const cells: { mesh: THREE.Mesh; map: THREE.CanvasTexture; canvas: HTMLCanvasElement;
    image?: HTMLCanvasElement; id?: number }[]=[];
  for(let i=0;i<6;i++) {
    const canvas=document.createElement("canvas");canvas.width=1200;canvas.height=1020;
    const map=new THREE.CanvasTexture(canvas);map.colorSpace=THREE.SRGBColorSpace;
    map.anisotropy=anisotropy;
    const material=new THREE.MeshBasicMaterial({map,toneMapped:false,fog:false,side:THREE.DoubleSide});
    const mesh=new THREE.Mesh(new THREE.PlaneGeometry(1.47,1.25),material);
    mesh.visible=false;
    mesh.position.set(-3.875+i*1.55,1.535,.22);strip.add(mesh);
    cells.push({mesh,map,canvas});
  }
  const backdrop=part("gallery-wall",0);
  box(backdrop,70,26,.2,0,7,-4,new THREE.MeshStandardMaterial({color:"#888e8c",roughness:1}));
  const ground=box(backdrop,70,.10,60,0,-.60,0,plinthMat);ground.castShadow=false;
  // Gallery lighting belongs to this scene and is never mixed into the archive.
  const softbox=new THREE.DirectionalLight(0xfff4df,2.4);
  softbox.position.set(-2,7,5);softbox.lookAt(0,1,0);root.add(softbox);
  const fill=new THREE.DirectionalLight(0xe2f2ff,.85);fill.position.set(6,3,-2);root.add(fill);
  const ambient=new THREE.HemisphereLight(0xf5f8ff,0x766b60,.85);root.add(ambient);
  const warmKey = new THREE.Color("#ffd7b1"), neutralKey = new THREE.Color("#fffaf3");
  const warmFill = new THREE.Color("#c7b8a9"), neutralFill = new THREE.Color("#e2f2ff");
  function light(blend: number) {
    softbox.color.lerpColors(warmKey, neutralKey, blend);
    fill.color.lerpColors(warmFill, neutralFill, blend);
    ambient.intensity = .62 + .23 * blend;
  }
  let lastKey="";
  function update(photos: {id:number}[],start: number,index: number,images: Map<number,HTMLCanvasElement>) {
    const offset=Math.min(Math.max(0,Math.floor((index-start)/6)*6),Math.max(0,Math.floor((photos.length-1)/6)*6));
    const key=photos.slice(offset,offset+6).map(p=>p.id).join(",");
    cells.forEach((cell,i)=>{
      const photo=photos[offset+i],image=photo ? images.get(photo.id):undefined;
      if(lastKey===key && cell.image===image)return;
      cell.image=image;cell.id=photo?.id;cell.mesh.userData=photo?{frame:start+offset+i}:{};
      cell.mesh.visible=!!photo;
      const ctx=cell.canvas.getContext("2d")!;
      ctx.fillStyle="#161b17";ctx.fillRect(0,0,1200,1020);
      if(image){const s=Math.min(1200/image.width,1020/image.height);
        ctx.drawImage(image,(1200-image.width*s)/2,(1020-image.height*s)/2,image.width*s,image.height*s);}
      cell.map.needsUpdate=true;
    });lastKey=key;
  }
  function animate(progress: number) {
    root.visible=progress>0;
    if (!root.visible) return;
    if (!reflections) {
      const studio = new RoomEnvironment();
      const pmrem = new THREE.PMREMGenerator(renderer);
      reflections = pmrem.fromScene(studio, .035);
      acrylic.envMap = reflections.texture;
      acrylic.needsUpdate = true;
      studio.dispose();
      pmrem.dispose();
    }
    for(const item of pieces) {
      const t=THREE.MathUtils.smootherstep(progress,item.delay*.68,1);
      item.object.visible=t>0;item.object.position.copy(item.position);
      if(item.object===backdrop)continue;
      if(item.object===strip) item.object.position.x-=(1-t)*1.05;
      else item.object.position.y -= (1-t) * (item.object === frame ? .46 : .23);
      item.object.rotation.x=(1-t)*-.045;
    }
  }
  animate(0);
  function dispose() { acrylic.envMap=null; reflections?.dispose(); }
  return {root,cassette,update,animate,light,dispose};
}
