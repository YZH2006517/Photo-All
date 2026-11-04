// SPDX-License-Identifier: GPL-3.0-or-later
// Disposable screen proxy. Export and saved recipes always use the float32 engine.
import React, { useEffect, useRef, useState } from "react";
import {
  api,
  Photo,
  Recipe,
  geometrySignature,
  liveBaseBlob,
  liveBaseKey,
  liveRecipeKey,
  filterLayers,
  FilterLayer,
  currentPreviewGraphics,
} from "./model";

type Table = { edge: number; data: number[] };
type Looks = Partial<Record<"style" | "film" | "filter", Table>> & {
  stack?: Record<string, Table>;
};
const lookCache = new Map<string, Looks>();
const n = (r: Recipe, key: string, fallback = 0) => Number(r[key] ?? fallback);
const vertex = `#version 300 es
out vec2 uv;
void main(){vec2 p=vec2(gl_VertexID==1?3.:-1.,gl_VertexID==2?3.:-1.);uv=p*.5+.5;gl_Position=vec4(p,0,1);}`;
const fragment = `#version 300 es
precision highp float;
precision highp sampler3D;
precision highp sampler2DArray;
in vec2 uv;out vec4 outColor;
uniform sampler2D source,curves;
uniform sampler3D creative,stock,look;
uniform sampler2DArray stackAtlas;
uniform vec4 stackParams[16];
uniform int stackCount;
uniform vec2 pixel;
uniform vec4 basic,tones,levels,color,detail,film;
uniform vec4 bands[8];
uniform float mean,temperature,style,creativeOn,stockOn,lookOn;
vec3 clip(vec3 c){return clamp(c,0.,1.);}
float lum(vec3 c){return dot(c,vec3(.2126,.7152,.0722));}
vec3 lut(sampler3D t,vec3 c){
 ivec3 edge=textureSize(t,0)-1;vec3 p=clip(c)*vec3(edge),f=fract(p);ivec3 a=ivec3(floor(p)),b=min(a+1,edge);
 return mix(mix(mix(texelFetch(t,ivec3(a.x,a.y,a.z),0).rgb,texelFetch(t,ivec3(b.x,a.y,a.z),0).rgb,f.x),
                mix(texelFetch(t,ivec3(a.x,b.y,a.z),0).rgb,texelFetch(t,ivec3(b.x,b.y,a.z),0).rgb,f.x),f.y),
            mix(mix(texelFetch(t,ivec3(a.x,a.y,b.z),0).rgb,texelFetch(t,ivec3(b.x,a.y,b.z),0).rgb,f.x),
                mix(texelFetch(t,ivec3(a.x,b.y,b.z),0).rgb,texelFetch(t,ivec3(b.x,b.y,b.z),0).rgb,f.x),f.y),f.z);
}
float curve(float v,int ch){float p=clamp(v,0.,1.)*1023.;int i=int(floor(p));return mix(texelFetch(curves,ivec2(i,0),0)[ch],texelFetch(curves,ivec2(min(1023,i+1),0),0)[ch],fract(p));}
vec3 stackAt(ivec3 p,int layer){return texelFetch(stackAtlas,ivec3(p.x+p.y*33,p.z,layer),0).rgb;}
vec3 stackLut(vec3 c,int layer){
 vec3 p=clip(c)*32.,f=fract(p);ivec3 a=ivec3(floor(p)),b=min(a+1,ivec3(32));
 return mix(mix(mix(stackAt(ivec3(a.x,a.y,a.z),layer),stackAt(ivec3(b.x,a.y,a.z),layer),f.x),mix(stackAt(ivec3(a.x,b.y,a.z),layer),stackAt(ivec3(b.x,b.y,a.z),layer),f.x),f.y),
 mix(mix(stackAt(ivec3(a.x,a.y,b.z),layer),stackAt(ivec3(b.x,a.y,b.z),layer),f.x),mix(stackAt(ivec3(a.x,b.y,b.z),layer),stackAt(ivec3(b.x,b.y,b.z),layer),f.x),f.y),f.z);
}
vec3 hsl(vec3 c){
 float hi=max(c.r,max(c.g,c.b)),lo=min(c.r,min(c.g,c.b)),d=hi-lo,l=(hi+lo)*.5;
 if(d<.000001)return c;
 float s=d/max(.000001,1.-abs(2.*l-1.)),h;
 if(hi==c.r)h=mod((c.g-c.b)/d,6.);else if(hi==c.g)h=(c.b-c.r)/d+2.;else h=(c.r-c.g)/d+4.;
 h=fract(h/6.+1.);float oh=h,os=s;float centers[8]=float[8](0.,30.,60.,120.,180.,240.,270.,300.);
 for(int i=0;i<8;i++){
  vec4 op=bands[i];float dist=abs(mod(oh*360.-centers[int(op.x)]+180.,360.)-180.);
  float w=clamp(1.-dist/45.,0.,1.);w=w*w*(3.-2.*w)*min(1.,os*4.);
  h+=op.y/360.*w;float a=op.z*w;s+=a>=0.?(1.-s)*a:s*a;
  a=op.w*w;l+=a>=0.?(1.-l)*a:l*a;
 }
 h=fract(h+1.)*6.;float k=(1.-abs(2.*l-1.))*clamp(s,0.,1.),x=k*(1.-abs(mod(h,2.)-1.));vec3 rgb;
 if(h<1.)rgb=vec3(k,x,0);else if(h<2.)rgb=vec3(x,k,0);else if(h<3.)rgb=vec3(0,k,x);else if(h<4.)rgb=vec3(0,x,k);else if(h<5.)rgb=vec3(x,0,k);else rgb=vec3(k,0,x);
 return rgb+l-k*.5;
}
void main(){
 vec3 src=texture(source,uv).rgb,c=clip(src*exp2(basic.x));
 c=clip((c-mean)*basic.y+mean);c=clip(mix(vec3(dot(c,vec3(.299,.587,.114))),c,basic.z));
 c=clip(c*vec3(1.+temperature*.18,1.,1.-temperature*.18));
 if(style==1.)c=mix(vec3(dot(c,vec3(.299,.587,.114))),c,.82)*.9+14./255.;
 if(style==2.)c=vec3(dot(c,vec3(.299,.587,.114)));
 if(creativeOn>.5)c=lut(creative,c);
 if(stockOn>.5){vec3 g=lut(stock,c);float halo=max((lum(c)-180./255.)/(75./255.),0.)*film.y;
  g+=(1.-g)*vec3(189.,72.,34.)/255.*halo;
  float noise=(fract(sin(dot(floor(uv/pixel),vec2(12.9898,78.233)))*43758.5453)-.5)*.18;
  g=clip(g+noise*film.z);c=mix(c,g,film.x);
 }
 if(lookOn>.5)c=mix(c,lut(look,c),film.w);
 for(int i=0;i<16;i++){
  if(i>=stackCount)break;vec4 layer=stackParams[i];if(layer.y==0.)continue;
  vec3 g=c;
  if(layer.x==1.)g=clip(c*vec3(1.0324,1.,.9676));
  else if(layer.x==2.)g=clip(c*vec3(.973,1.,1.027));
  else if(layer.x==3.){g=clip(c*vec3(1.0144,1.,.9856));g=mix(vec3(dot(g,vec3(.299,.587,.114))),g,.82)*.9+14./255.;}
  else if(layer.x==4.)g=vec3(dot(c,vec3(.299,.587,.114)));
  else if(layer.x==5.)g=stackLut(c,i);
  c=mix(c,clip(g),layer.y);
 }
 c=clip(c);float y=lum(c);
 float a=.45*(tones.x*pow(1.-y,3.)+tones.y*pow(y,3.)+tones.z*pow(max(2.*y-1.,0.),2.)+tones.w*pow(max(1.-2.*y,0.),2.));
 c+=a>=0.?(1.-c)*a:c*a;c*=vec3(1.+color.y*.12,1.-color.y*.12,1.+color.y*.12);
 float chroma=max(c.r,max(c.g,c.b))-min(c.r,min(c.g,c.b));c=mix(vec3(lum(c)),c,1.+color.x*(1.-chroma)*.8);
 c=(c-.06*color.z)/(1.-.18*color.z);c=pow(clip((c-levels.x)/(levels.y-levels.x)),vec3(1./levels.z));
 c=vec3(curve(c.r,0),curve(c.g,0),curve(c.b,0));c=vec3(curve(c.r,1),curve(c.g,2),curve(c.b,3));c=clip(hsl(c));
 // Screen-size spatial kernels; the native engine supplies the precise final blur/noise result.
 if(detail.x!=0.||detail.y!=0.||detail.w!=0.){
  vec2 near=pixel*max(1.,detail.z),far=pixel*8.;
  vec3 soft=(texture(source,uv+vec2(near.x,0)).rgb+texture(source,uv-vec2(near.x,0)).rgb+texture(source,uv+vec2(0,near.y)).rgb+texture(source,uv-vec2(0,near.y)).rgb)*.25;
  float diff=lum(src)-lum(soft);c+=diff*detail.x;
  float broad=(lum(texture(source,uv+vec2(far.x,0)).rgb)+lum(texture(source,uv-vec2(far.x,0)).rgb)+lum(texture(source,uv+vec2(0,far.y)).rgb)+lum(texture(source,uv-vec2(0,far.y)).rgb))*.25;
  c+=(lum(src)-broad)*detail.y*.8;c+=(soft-src)*detail.w*exp(-pow(diff/.06,2.));
 }
 c*=exp2(-color.w*2.*pow(clamp(dot(uv*2.-1.,uv*2.-1.)*.5,0.,1.),1.4));outColor=vec4(clip(c),1.);
}`;

function curveTable(recipe: Recipe) {
  const table = new Float32Array(4096);
  ["curve_rgb", "curve_r", "curve_g", "curve_b"].forEach((key, channel) => {
    let points: number[][];
    try {
      points = JSON.parse(String(recipe[key] || "[[0,0],[1,1]]"));
    } catch {
      points = [
        [0, 0],
        [1, 1],
      ];
    }
    let j = 1;
    for (let i = 0; i < 1024; i++) {
      const x = i / 1023;
      while (j < points.length - 1 && points[j][0] < x) j++;
      const [a, b] = [points[j - 1], points[j]];
      table[i * 4 + channel] =
        a[1] + ((b[1] - a[1]) * (x - a[0])) / Math.max(0.000001, b[0] - a[0]);
    }
  });
  return table;
}

function renderer(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    preserveDrawingBuffer: true,
  });
  if (!gl) throw Error("WebGL2 unavailable");
  const program = gl.createProgram()!,
    shaders: WebGLShader[] = [];
  for (const [type, text] of [
    [gl.VERTEX_SHADER, vertex],
    [gl.FRAGMENT_SHADER, fragment],
  ] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, text);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw Error(gl.getShaderInfoLog(shader) || "Shader failed");
    shaders.push(shader);
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw Error(gl.getProgramInfoLog(program) || "Link failed");
  gl.useProgram(program);
  const uniforms = new Map<string, WebGLUniformLocation | null>();
  const location = (name: string) => {
    if (!uniforms.has(name))
      uniforms.set(name, gl.getUniformLocation(program, name));
    return uniforms.get(name)!;
  };
  const textures = Array.from({ length: 6 }, () => gl.createTexture()!);
  const bind = (unit: number, target: number) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(target, textures[unit]);
  };
  const settings = (target: number) => {
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (target === gl.TEXTURE_3D)
      gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  };
  ["source", "creative", "stock", "look", "curves"].forEach((name, i) =>
    gl.uniform1i(location(name), i),
  );
  gl.uniform1i(location("stackAtlas"), 5);
  const identity = new Float32Array(24);
  for (let b = 0; b < 2; b++)
    for (let g = 0; g < 2; g++)
      for (let r = 0; r < 2; r++)
        identity.set([r, g, b], ((b * 2 + g) * 2 + r) * 3);
  const upload = (unit: number, table?: Table) => {
    bind(unit, gl.TEXTURE_3D);
    settings(gl.TEXTURE_3D);
    const edge = table?.edge || 2;
    gl.texImage3D(
      gl.TEXTURE_3D,
      0,
      gl.RGB32F,
      edge,
      edge,
      edge,
      0,
      gl.RGB,
      gl.FLOAT,
      table ? new Float32Array(table.data) : identity,
    );
  };
  upload(1);
  upload(2);
  upload(3);
  bind(5, gl.TEXTURE_2D_ARRAY);
  settings(gl.TEXTURE_2D_ARRAY);
  gl.texImage3D(
    gl.TEXTURE_2D_ARRAY,
    0,
    gl.RGB32F,
    1,
    1,
    1,
    0,
    gl.RGB,
    gl.FLOAT,
    new Float32Array(3),
  );
  let histogram = new Float64Array(768),
    total = 1,
    previousCurves = "";
  return {
    base(image: HTMLImageElement) {
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      gl.viewport(0, 0, canvas.width, canvas.height);
      bind(0, gl.TEXTURE_2D);
      settings(gl.TEXTURE_2D);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        image,
      );
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      const probe = document.createElement("canvas");
      probe.width = canvas.width;
      probe.height = canvas.height;
      const context = probe.getContext("2d", { willReadFrequently: true })!;
      context.drawImage(image, 0, 0);
      const bytes = context.getImageData(0, 0, probe.width, probe.height).data;
      histogram = new Float64Array(768);
      total = bytes.length / 4;
      for (let i = 0; i < bytes.length; i += 4) {
        histogram[bytes[i]]++;
        histogram[256 + bytes[i + 1]]++;
        histogram[512 + bytes[i + 2]]++;
      }
    },
    looks(looks: Looks, layers: FilterLayer[]) {
      upload(1, looks.style);
      upload(2, looks.film);
      upload(3, looks.filter);
      gl.uniform1f(location("creativeOn"), looks.style ? 1 : 0);
      gl.uniform1f(location("stockOn"), looks.film ? 1 : 0);
      gl.uniform1f(location("lookOn"), looks.filter ? 1 : 0);
      const depth = Math.max(1, layers.length),
        atlas = new Float32Array(33 * 33 * 33 * 3 * depth);
      layers.forEach((layer, index) => {
        const table = looks.stack?.[`${layer.kind}:${layer.id}`];
        if (table) atlas.set(table.data, index * 33 * 33 * 33 * 3);
      });
      bind(5, gl.TEXTURE_2D_ARRAY);
      settings(gl.TEXTURE_2D_ARRAY);
      gl.texImage3D(
        gl.TEXTURE_2D_ARRAY,
        0,
        gl.RGB32F,
        33 * 33,
        33,
        depth,
        0,
        gl.RGB,
        gl.FLOAT,
        atlas,
      );
    },
    draw(recipe: Recipe, base: Recipe) {
      const layers = recipe.filter_stack ? filterLayers(recipe) : [];
      const config = new Float32Array(64);
      layers.forEach((layer, index) => {
        const code =
          layer.kind === "lut"
            ? 5
            : ({ natural: 0, warm: 1, cool: 2, film: 3, mono: 4 }[layer.id] ??
              5);
        config.set([code, layer.enabled ? layer.strength : 0, 0, 0], index * 4);
      });
      gl.uniform1i(location("stackCount"), layers.length);
      gl.uniform4fv(location("stackParams[0]"), config);
      const exposure =
        n(recipe, "exposure") +
        n(recipe, "raw_exposure") -
        n(base, "raw_exposure");
      let avg = 0;
      for (let i = 0; i < 256; i++)
        avg +=
          Math.min(1, (i / 255) * 2 ** exposure) *
          (0.299 * histogram[i] +
            0.587 * histogram[256 + i] +
            0.114 * histogram[512 + i]);
      gl.uniform1f(location("mean"), avg / total);
      const v = (name: string, values: number[]) =>
        gl.uniform4fv(location(name), values);
      v("basic", [
        exposure,
        n(recipe, "contrast", 1),
        n(recipe, "saturation", 1),
        0,
      ]);
      v(
        "tones",
        ["shadows", "highlights", "whites", "blacks"].map((k) => n(recipe, k)),
      );
      v("levels", [
        n(recipe, "black_point"),
        n(recipe, "white_point", 1),
        n(recipe, "gamma", 1),
        0,
      ]);
      v(
        "color",
        ["vibrance", "tint", "dehaze", "vignette"].map((k) => n(recipe, k)),
      );
      v("detail", [
        n(recipe, "sharpen"),
        n(recipe, "clarity"),
        n(recipe, "sharpen_radius", 1),
        n(recipe, "denoise"),
      ]);
      v("film", [
        n(recipe, "film_strength", 1),
        n(recipe, "film_halation"),
        n(recipe, "film_grain"),
        n(recipe, "filter_strength", 1),
      ]);
      const style = String(recipe.style || "natural");
      gl.uniform1f(
        location("temperature"),
        n(recipe, "temperature") +
          ({ warm: 0.18, cool: -0.15, film: 0.08 }[style] || 0) +
          (n(recipe, "raw_temperature", 6500) -
            n(base, "raw_temperature", 6500)) /
            18000,
      );
      gl.uniform1f(
        location("style"),
        style === "film" ? 1 : style === "mono" ? 2 : 0,
      );
      gl.uniform2f(location("pixel"), 1 / canvas.width, 1 / canvas.height);
      let operations: {
        band: number;
        hue: number;
        saturation: number;
        luminance: number;
      }[] = [];
      try {
        operations = JSON.parse(String(recipe.hsl || "[]"));
      } catch {}
      const hsl = new Float32Array(32);
      operations
        .slice(0, 8)
        .forEach((op, i) =>
          hsl.set([op.band, op.hue, op.saturation, op.luminance], i * 4),
        );
      gl.uniform4fv(location("bands[0]"), hsl);
      const curvesKey = ["curve_rgb", "curve_r", "curve_g", "curve_b"]
        .map((key) => recipe[key])
        .join("|");
      if (previousCurves !== curvesKey || !previousCurves) {
        bind(4, gl.TEXTURE_2D);
        settings(gl.TEXTURE_2D);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA32F,
          1024,
          1,
          0,
          gl.RGBA,
          gl.FLOAT,
          curveTable(recipe),
        );
        previousCurves = curvesKey;
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    close() {
      textures.forEach((t) => gl.deleteTexture(t));
      shaders.forEach((s) => gl.deleteShader(s));
      gl.deleteProgram(program);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}

// Preparation happens once per source/RAW/geometry. Slider frames perform no HTTP requests.
export function LivePreview({
  photo,
  exact,
  uncropped = false,
  sourceSize = currentPreviewGraphics().liveSize,
  onFrame,
}: {
  photo: Photo;
  exact: string;
  uncropped?: boolean;
  sourceSize?: number;
  onFrame?: (canvas: HTMLCanvasElement) => void;
}) {
  const frameGate = useRef({ exact, live: liveRecipeKey(photo.recipe) });
  frameGate.current = { exact, live: liveRecipeKey(photo.recipe) };
  const frameCallback = useRef(onFrame);
  frameCallback.current = onFrame;
  const canvas = useRef<HTMLCanvasElement>(null),
    gpu = useRef<ReturnType<typeof renderer> | null>(null);
  const source = useRef<{
    image: HTMLImageElement;
    recipe: Recipe;
    geometry: string;
  } | null>(null);
  const latest = useRef(photo.recipe);
  latest.current = photo.recipe;
  const [ready, setReady] = useState(false),
    [looksReady, setLooksReady] = useState(false),
    [baseVersion, setBaseVersion] = useState(0);
  const committed = {
    ...photo,
    recipe: photo.committed_recipe ?? photo.recipe,
  };
  const baseKey = liveBaseKey(committed, uncropped);
  const lookKey = JSON.stringify([
    photo.recipe.style,
    photo.recipe.film_stock,
    photo.recipe.filter_id,
    photo.recipe.filter_stack
      ? filterLayers(photo.recipe).map(({ kind, id }) => ({ kind, id }))
      : [],
  ]);
  const live = liveRecipeKey(photo.recipe),
    geometry = geometrySignature(
      uncropped
        ? { ...photo.recipe, crop_x: 0, crop_y: 0, crop_w: 1, crop_h: 1 }
        : photo.recipe,
    );
  useEffect(() => {
    try {
      gpu.current = renderer(canvas.current!);
    } catch (error) {
      gpu.current = null;
      canvas.current!.dataset.liveError = String(error);
    }
    const lost = (event: Event) => {
      event.preventDefault();
      setReady(false);
    };
    canvas.current?.addEventListener("webglcontextlost", lost);
    const host = canvas.current;
    return () => {
      host?.removeEventListener("webglcontextlost", lost);
      gpu.current?.close();
      gpu.current = null;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let url = "";
    if (gpu.current)
      liveBaseBlob(committed, uncropped, controller.signal, sourceSize)
        .then(async (blob) => {
          if (controller.signal.aborted) return;
          url = URL.createObjectURL(blob);
          const image = new Image();
          image.src = url;
          await image.decode();
          if (controller.signal.aborted) return;
          gpu.current?.base(image);
          source.current = {
            image,
            recipe: { ...committed.recipe },
            geometry: geometrySignature(
              uncropped
                ? {
                    ...committed.recipe,
                    crop_x: 0,
                    crop_y: 0,
                    crop_w: 1,
                    crop_h: 1,
                  }
                : committed.recipe,
            ),
          };
          gpu.current?.draw(latest.current, source.current.recipe);
          if (
            canvas.current &&
            frameGate.current.exact !== frameGate.current.live
          )
            frameCallback.current?.(canvas.current);
          setReady(true);
          setBaseVersion((v) => v + 1);
        })
        .catch(() => {});
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [baseKey, sourceSize]);
  useEffect(() => {
    const controller = new AbortController();
    setLooksReady(false);
    const query = new URLSearchParams({
      style: String(photo.recipe.style || "natural"),
      film_stock: String(photo.recipe.film_stock || "none"),
      filter_id: String(photo.recipe.filter_id || "none"),
      stack: JSON.stringify(
        photo.recipe.filter_stack
          ? filterLayers(photo.recipe).map(({ kind, id }) => ({ kind, id }))
          : [],
      ),
    });
    if (gpu.current)
      (lookCache.has(lookKey)
        ? Promise.resolve(lookCache.get(lookKey)!)
        : api<Looks>(`/live-look?${query}`, undefined, controller.signal)
      )
        .then((looks) => {
          if (!controller.signal.aborted) {
            lookCache.set(lookKey, looks);
            if (lookCache.size > 6)
              lookCache.delete(lookCache.keys().next().value!);
            gpu.current?.looks(
              looks,
              latest.current.filter_stack ? filterLayers(latest.current) : [],
            );
            setLooksReady(true);
          }
        })
        .catch(() => {});
    return () => controller.abort();
  }, [lookKey]);
  const active =
    ready &&
    looksReady &&
    source.current?.geometry === geometry &&
    exact !== live;
  useEffect(() => {
    if (!ready || !looksReady || !source.current) return;
    const frame = requestAnimationFrame(() => {
      gpu.current?.draw(latest.current, source.current!.recipe);
      if (canvas.current && frameGate.current.exact !== frameGate.current.live)
        frameCallback.current?.(canvas.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [live, ready, looksReady, baseKey, baseVersion]);
  return (
    <>
      <canvas
        ref={canvas}
        className={`live-preview ${active ? "is-active" : ""}`}
        data-live-preview={active ? "true" : "false"}
        data-live-ready={ready && looksReady ? "true" : "false"}
        aria-hidden="true"
      />
      {active && <span className="live-preview-note">实时预览</span>}
    </>
  );
}
