// SPDX-License-Identifier: GPL-3.0-or-later
// Direct manipulation of photo recipes; chemistry is an artistic metaphor.
import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { DragControls } from "three/addons/controls/DragControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  FlaskConical,
  RotateCcw,
  Save,
  Eye,
  EyeOff,
  Play,
  Pause,
  Pipette,
  Square,
  Undo2,
  X,
} from "lucide-react";
import {
  Photo, Recipe, Library, draftBlob, liveRecipeKey,
  currentPreviewGraphics, previewPixelRatio, filmStock, spectralRecipe,
} from "./model";
import { Picture } from "./Preview";
import { LivePreview } from "./LivePreview";
import type { DarkroomRoll } from "./Darkroom";

export const SERUMS = [
  {
    id: "warm",
    name: "暖金",
    english: "AMBER",
    color: "#d99946",
    note: "给画面加入温暖的金色，轻轻提升饱和度。",
    effect: "暖调 · 鲜活",
  },
  {
    id: "cyan",
    name: "青影",
    english: "CYAN",
    color: "#67a9ae",
    note: "把冷色带进阴影，保留清透的层次。",
    effect: "冷调 · 通透",
  },
  {
    id: "rose",
    name: "玫瑰",
    english: "ROSE",
    color: "#c77688",
    note: "柔和的玫瑰染色，收住过亮的高光。",
    effect: "染色 · 柔光",
  },
  {
    id: "soft",
    name: "柔雾",
    english: "MIST",
    color: "#c1baa4",
    note: "抬起黑位，柔化对比，留下薄雾般的空气感。",
    effect: "低反差 · 哑光",
  },
  {
    id: "grain",
    name: "银盐",
    english: "SILVER",
    color: "#9d9f91",
    note: "在选定胶片基底上增加颗粒。请先选择胶片基底。",
    effect: "胶片颗粒",
  },
  {
    id: "glow",
    name: "辉光",
    english: "HALO",
    color: "#d0a486",
    note: "在选定胶片基底上增加高光光晕。请先选择胶片基底。",
    effect: "高光光晕",
  },
] as const;
type Serum = (typeof SERUMS)[number]["id"];
export const BASES = [
  {
    id: "inherit",
    name: "原有底色",
    short: "ORIGINAL",
    iso: null,
    color: "#b9b6a2",
    note: "保留照片已有的风格与胶片设置。",
  },
  {
    id: "kodak_portra_400",
    name: "Portra 400",
    short: "PORTRA",
    iso: 400,
    color: "#baa36f",
    note: "柔和的人像负片基底，来自现有 Spektrafilm 色彩引擎。",
  },
  {
    id: "kodak_gold_200",
    name: "Gold 200",
    short: "GOLD",
    iso: 200,
    color: "#bc8740",
    note: "温暖的日常负片基底，来自现有 Spektrafilm 色彩引擎。",
  },
  {
    id: "kodak_ektar_100",
    name: "Ektar 100",
    short: "EKTAR",
    iso: 100,
    color: "#9f5346",
    note: "鲜明的风光负片基底，来自现有 Spektrafilm 色彩引擎。",
  },
  {
    id: "fujifilm_pro_400h",
    name: "Pro 400H",
    short: "PRO 400H",
    iso: 400,
    color: "#7b9581",
    note: "清淡柔和的彩色负片基底，来自现有 Spektrafilm 色彩引擎。",
  },
] as const;
export type CreativeMix = {
  development: number;
  agitation: number;
  bath: number;
  stock: string;
  doses: Record<Serum, number>;
  timer: number;
  warmth: number;
  concentration: number;
};
const clamp = (v: number, min = 0, max = 1) => Math.max(min, Math.min(max, v));
const finite = (v: unknown, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
export function newMix(): CreativeMix {
  return {
    development: 0,
    agitation: 0,
    bath: 0,
    stock: "inherit",
    doses: { warm: 0, cyan: 0, rose: 0, soft: 0, grain: 0, glow: 0 },
    timer: 0.5,
    warmth: 0.5,
    concentration: 1,
  };
}
export function addDose(
  m: CreativeMix,
  id: Serum,
  amount: number,
): CreativeMix {
  if (!Number.isFinite(amount) || amount <= 0) return m;
  const total = Object.values(m.doses).reduce((a, b) => a + b, 0),
    value = Math.min(1 - m.doses[id], 2.4 - total, amount);
  return value > 1e-8
    ? { ...m, doses: { ...m.doses, [id]: m.doses[id] + value } }
    : m;
}
export function restoreMix(value: unknown): CreativeMix {
  const m = newMix();
  if (!value || typeof value !== "object") return m;
  const v = value as Partial<CreativeMix>;
  m.stock = BASES.some((b) => b.id === v.stock) ? String(v.stock) : "inherit";
  m.timer = clamp(finite(v.timer, 0.5));
  m.warmth = clamp(finite(v.warmth, 0.5));
  m.concentration = clamp(finite(v.concentration, 1));
  m.agitation = clamp(finite(v.agitation, 0));
  m.development = clamp(finite(v.development, 0));
  m.bath = clamp(finite(v.bath, 0));
  for (const s of SERUMS) {
    const next = addDose(m, s.id, clamp(finite(v.doses?.[s.id], 0)));
    m.doses = next.doses;
  }
  return m;
}
export function creativeRecipe(base: Recipe, m: CreativeMix): Recipe {
  const out = { ...base },
    n = (key: string, fallback: number) => Number(base[key] ?? fallback),
    c = m.concentration;
  const d = Object.fromEntries(
    SERUMS.map((s) => [s.id, m.doses[s.id] * c]),
  ) as Record<Serum, number>;
  const time = (m.development * 0.65 + m.agitation * 0.28) * c,
    temperature = (m.warmth - 0.5) * 1.3 * c + d.warm * 0.65 - d.cyan * 0.55;
  const set = (
    key: string,
    value: number,
    min: number,
    max: number,
    fallback: number,
  ) => {
    const next = clamp(value, min, max);
    if (Math.abs(next - n(key, fallback)) > 1e-8)
      out[key] = Math.round(next * 100000) / 100000;
  };
  set(
    "contrast",
    n("contrast", 1) * (1 + time * 0.65) * (1 - d.soft * 0.24),
    0.5,
    1.5,
    1,
  );
  set("blacks", n("blacks", 0) - time * 0.22 + d.soft * 0.2, -1, 1, 0);
  set("exposure", n("exposure", 0) + m.bath * 0.38 * c, -2, 2, 0);
  set("temperature", n("temperature", 0) + temperature, -1, 1, 0);
  set("tint", n("tint", 0) + d.rose * 0.6 - d.cyan * 0.15, -1, 1, 0);
  set(
    "saturation",
    n("saturation", 1) * (1 + d.warm * 0.16 - d.soft * 0.08),
    0,
    2,
    1,
  );
  set("shadows", n("shadows", 0) + d.soft * 0.18 + d.cyan * 0.12, -1, 1, 0);
  set(
    "highlights",
    n("highlights", 0) - d.rose * 0.12 - d.glow * 0.1,
    -1,
    1,
    0,
  );
  if (m.stock !== "inherit") {
    out.film_stock = m.stock;
    out.film_strength = c;
    if (base.film_advanced) out.film_advanced = "";
  }
  const spectral = spectralRecipe(out);
  if (spectral) {
    if (d.grain > 0) {
      spectral.grain = "on";
      spectral.grain_area = clamp(Number(spectral.grain_area ?? .2) + d.grain * .5, .01, 3.2);
    }
    if (d.glow > 0) {
      spectral.halation = "on";
      spectral.halo_amount = clamp(Number(spectral.halo_amount ?? 1) + d.glow, 0, 3);
    }
    if (d.grain > 0 || d.glow > 0) out.film_advanced = JSON.stringify(spectral);
  } else if (filmStock(out) !== "none") {
    set("film_grain", n("film_grain", 0) + d.grain * 0.8, 0, 1, 0);
    set("film_halation", n("film_halation", 0) + d.glow * 0.85, 0, 1, 0);
  }
  return out;
}
export function processAction(
  m: CreativeMix,
  action: "agitation" | "bath" | "development",
  amount: number,
): CreativeMix {
  if (!Number.isFinite(amount) || amount <= 0) return m;
  return { ...m, [action]: clamp(m[action] + amount) };
}
export function processTimeline(value: number) {
  const p = clamp(finite(value, 0));
  const ease = (a: number, b: number) => {
    const t = clamp((p - a) / (b - a));
    return t * t * (3 - 2 * t);
  };
  return {
    lidOpen: ease(0, 0.055) - ease(0.266, 0.3) +
      ease(0.78, 0.815) - ease(0.94, 1),
    cupTravel: ease(0.055, 0.126),
    cupTip: ease(0.126, 0.156) - ease(0.22, 0.24),
    transfer: ease(0.156, 0.22),
    cupReturn: ease(0.24, 0.266),
    agitate: ease(0.3, 0.78),
    drain: ease(0.815, 0.94),
    phase:
      p < 0.22
        ? "pour"
        : p < 0.3
          ? "seal"
          : p < 0.78
            ? "agitate"
            : p < 0.94
              ? "drain"
              : p < 1
                ? "settle"
                : "done",
  };
}
export function developmentStep(
  m: CreativeMix,
  from: number,
  to: number,
  timer: number,
) {
  const amount =
    Math.max(0, processTimeline(to).agitate - processTimeline(from).agitate) *
    (0.2 + 0.58 * clamp(finite(timer, 0.5)));
  return processAction(m, "development", amount);
}
export function orbitView(
  current: { yaw: number; pitch: number },
  dx: number,
  dy: number,
) {
  return {
    yaw: clamp(current.yaw + finite(dx, 0) * 0.002, -0.32, 0.32),
    pitch: clamp(current.pitch + finite(dy, 0) * 0.002, -0.18, 0.18),
  };
}
type Work = {
  running: boolean;
  paused: boolean;
  phase: string;
  progress: number;
};
const IDLE_WORK: Work = {
  running: false,
  paused: false,
  phase: "idle",
  progress: 0,
};
type ProofImage = HTMLImageElement | HTMLCanvasElement;
export function creativePatch(base: Recipe, m: CreativeMix): Recipe {
  return Object.fromEntries(
    Object.entries(creativeRecipe(base, m)).filter(([k, v]) => base[k] !== v),
  );
}
export function dragDial(
  current: number,
  previousAngle: number,
  nextAngle: number,
) {
  if (![current, previousAngle, nextAngle].every(Number.isFinite))
    return clamp(finite(current, 0.5));
  return clamp(
    current + (((nextAngle - previousAngle + 540) % 360) - 180) / 270,
  );
}
const signature = (r: Recipe) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(r).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
const equalMix = (a: CreativeMix, b: CreativeMix) =>
  JSON.stringify(a) === JSON.stringify(b);
type View = "shelf" | "develop" | "colour" | "finish";
const VIEWS = [
  {
    id: "shelf" as View,
    name: "配方架",
    english: "THE SHELF",
    line: "一点颜色，一种感觉。",
    hint: "挑一卷底片，再把药瓶拖到量杯里",
  },
  {
    id: "develop" as View,
    name: "显影台",
    english: "THE TANK",
    line: "让影调慢慢显现。",
    hint: "拨好计时器，把量杯拖到罐口",
  },
  {
    id: "colour" as View,
    name: "调色台",
    english: "THE TRAYS",
    line: "调到心里的颜色。",
    hint: "夹起相纸放进显影盘，等它浮现",
  },
  {
    id: "finish" as View,
    name: "成品台",
    english: "THE LINE",
    line: "留住这一次调配。",
    hint: "把相纸挂上绳子，晾干后应用到照片",
  },
];
type DialId = "timer" | "warmth" | "concentration";
const developmentSeconds = (value: number) => 7 + value * 7;
const dialByView = { shelf: "concentration", develop: "timer", colour: "warmth", finish: null } as const;
type Hover = { kind: "bottle"; id: Serum } | { kind: "dial"; id: DialId } | null;
type MeasuredDose = { id: Serum; ml: number };
type DoseRequest = { id: Serum; atCup?: boolean };

type RoomState = {
  mix: CreativeMix;
  view: View;
  disabled: boolean;
  filmReady: boolean;
  allowed: string[];
  reduced: boolean;
  showPhoto: boolean;
  compare: boolean;
  frame: string;
  lightsOn: boolean;
};
type RoomEvents = {
  hover: (value: Hover) => void;
  begin: () => void;
  end: (cancelled?: boolean) => void;
  measure: (request: DoseRequest | null) => void;
  dial: (id: "timer" | "warmth" | "concentration", value: number) => void;
  base: (id: string) => void;
  action: (id: "agitation" | "bath" | "development", amount: number) => void;
  develop: (from: number, to: number, timer: number) => void;
  work: (value: Work) => void;
  error: () => void;
  next: () => void;
  cue: (value: { text: string; mark: string }) => void;
};
type Studio = {
  update: (value: RoomState) => void;
  dispose: () => void;
  reset: () => void;
  cancel: (rollback?: boolean) => void;
  cancelStaging: () => boolean;
  proof: (image: ProofImage, original?: boolean) => void;
  start: () => void;
  pause: () => void;
  meter: (fraction: number) => void;
  pour: (dose: MeasuredDose, previousDose: number) => void;
  applied: () => void;
};

const studioNativePixels = 3840 * 2160;
const studioProofWidth = 1920;

function makeStudio(host: HTMLDivElement, events: RoomEvents): Studio {
  const budget = currentPreviewGraphics();
  const graphics = {
    ...budget,
    maxPixels: Math.max(studioNativePixels, Math.min(10_500_000, budget.maxPixels * 2)),
    maxRatio: budget.maxRatio + .25,
  };
  const renderer = new THREE.WebGLRenderer({
    powerPreference: "high-performance",
  });
  const gl = renderer.getContext();
  const maxTextureSize = renderer.capabilities.maxTextureSize;
  const maxBufferSize = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number, maxTextureSize);
  const artworkScale = Math.min(graphics.maxRatio, maxTextureSize / 1024);
  const anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
  renderer.transmissionResolutionScale = Math.min(1, graphics.transmissionScale + .2);
  renderer.setClearColor("#070403");
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const canvas = renderer.domElement;
  canvas.setAttribute("aria-label", "创作暗房三维桌面");
  host.appendChild(canvas);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#140403");
  scene.fog = new THREE.Fog("#140403", 11, 21);
  const camera = new THREE.PerspectiveCamera(31, 1, 0.1, 60);
  camera.position.set(0, 9.7, 7.7);
  const look = new THREE.Vector3(0, 0.7, -0.4),
    lookGoal = look.clone(),
    cameraGoal = camera.position.clone();
  camera.lookAt(look);
  const environment = new RoomEnvironment(),
    pmrem = new THREE.PMREMGenerator(renderer),
    env = pmrem.fromScene(environment, 0.04);
  scene.environment = env.texture;
  scene.environmentIntensity = 0.1;
  environment.dispose();
  pmrem.dispose();
  // The bench sits under a broad overhead safelight: one large soft pool of
  // red-orange light, a dim red fill and no hard specular hot spots. The
  // composer keeps a faint bloom only for the lamp-lit edges of the frame.
  const composerTarget = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
  });
  const composer = new EffectComposer(renderer, composerTarget);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.06, 0.8, 1);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const ambient = new THREE.HemisphereLight("#d0533a", "#2a0805", 0.9);
  scene.add(ambient);
  const key = new THREE.SpotLight("#ff8a5e", 260, 34, 0.78, 1, 2);
  key.position.set(-0.6, 12.5, 3.2);
  key.target.position.set(0.2, 0.6, 0.2);
  key.castShadow = true;
  key.shadow.mapSize.setScalar(graphics.shadowSize);
  key.shadow.camera.near = 4;
  key.shadow.camera.far = 26;
  key.shadow.normalBias = 0.03;
  key.shadow.bias = -0.0002;
  key.shadow.radius = 9;
  key.shadow.blurSamples = 16;
  scene.add(key, key.target);
  const safe = new THREE.SpotLight("#ff3418", 60, 30, 1, 1, 2);
  safe.position.set(-7, 7.5, -3.5);
  safe.target.position.set(0.8, 0.6, 1.2);
  scene.add(safe, safe.target);
  const rim = new THREE.DirectionalLight("#ff5a3a", 0.12);
  rim.position.set(5, 6, -3);
  scene.add(rim);
  const bounce = new THREE.PointLight("#b0311c", 0, 8, 2);
  scene.add(bounce);
  // High, close, looking down onto the bench like a person standing over it.
  const roomLooks = {
    shelf: {
      wall: "#120403",
      light: "#ff9a68",
      power: 260,
      safe: 50,
      fill: 0.95,
      rim: 0.12,
      exposure: 1,
      bloom: 0.06,
      eye: [0, 9.7, 7.7],
      focus: [0, 0.7, -0.4],
    },
    develop: {
      wall: "#120403",
      light: "#ff9466",
      power: 250,
      safe: 55,
      fill: 0.9,
      rim: 0.12,
      exposure: 1,
      bloom: 0.06,
      eye: [0.55, 9.9, 8.4],
      focus: [0.55, 0.8, 0.25],
    },
    colour: {
      wall: "#140302",
      light: "#ff7a50",
      power: 240,
      safe: 70,
      fill: 0.85,
      rim: 0.12,
      exposure: 1,
      bloom: 0.06,
      eye: [1.0, 10.6, 9.4],
      focus: [1.0, 0.6, 0.7],
    },
    finish: {
      wall: "#140302",
      light: "#ff7a50",
      power: 240,
      safe: 70,
      fill: 0.85,
      rim: 0.12,
      exposure: 1,
      bloom: 0.06,
      eye: [0, 9.8, 11.2],
      focus: [0, 1.05, 0.15],
    },
  } as const;
  // The viewing lamp swaps the safelight for neutral light so colours can be
  // judged; it changes only the lights, never the recipe.
  let lightsOn = false;
  function lightRoom(view: View) {
    const look = roomLooks[view];
    const wall = lightsOn ? "#1b1916" : look.wall;
    scene.background = new THREE.Color(wall);
    scene.fog = new THREE.Fog(wall, 11, 21);
    key.color.set(lightsOn ? "#fff3e6" : look.light);
    key.intensity = lightsOn ? 230 : look.power;
    safe.intensity = lightsOn ? 0 : look.safe;
    ambient.color.set(lightsOn ? "#e9e3da" : "#d0533a");
    ambient.groundColor.set(lightsOn ? "#3b352e" : "#2a0805");
    ambient.intensity = lightsOn ? 1.05 : look.fill;
    rim.intensity = lightsOn ? 0 : look.rim;
    renderer.toneMappingExposure = look.exposure;
    bloom.strength = lightsOn ? 0 : look.bloom;
  }
  lightRoom("shelf");
  const geometries: THREE.BufferGeometry[] = [],
    materials: THREE.Material[] = [],
    textures: THREE.Texture[] = [];
  const material = (color: string, roughness = 0.5, metalness = 0) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness, metalness });
    materials.push(m);
    return m;
  };
  const brass = material("#a88b56", 0.3, 0.78),
    charcoal = material("#222824", 0.42, 0.18),
    wood = material("#875f4a", 0.51),
    paper = material("#e8dfc8", 0.9),
    black = material("#111713", 0.5),
    steel = material("#9a8574", 0.62, 0.42);
  const glass = new THREE.MeshPhysicalMaterial({
    color: "#f9f8ed",
    roughness: 0.42,
    metalness: 0,
    transmission: 1,
    thickness: 0.3,
    attenuationColor: new THREE.Color("#dfce9f"),
    attenuationDistance: 2,
    ior: 1.46,
    clearcoat: 0,
    envMapIntensity: 0.2,
  });
  materials.push(glass);
  const bakelite = new THREE.MeshPhysicalMaterial({
    color: "#1c120d",
    roughness: 0.38,
    clearcoat: 0.1,
    clearcoatRoughness: 0.6,
  });
  const lacquerRed = new THREE.MeshPhysicalMaterial({
    color: "#5a1c13",
    roughness: 0.35,
    clearcoat: 0,
  });
  const domeGlass = new THREE.MeshPhysicalMaterial({
    color: "#ffffff",
    roughness: 0.04,
    transparent: true,
    opacity: 0.14,
    depthWrite: false,
    envMapIntensity: 0.3,
    clearcoat: 0,
  });
  const iron = material("#1b1715", 0.42, 0.7);
  const bamboo = new THREE.MeshStandardMaterial({ color: "#8f6e4a", roughness: 0.62 });
  const bambooNode = new THREE.MeshStandardMaterial({ color: "#5e4229", roughness: 0.7 });
  materials.push(bakelite, lacquerRed, domeGlass, bamboo, bambooNode);
  const mesh = (
    g: THREE.BufferGeometry,
    m: THREE.Material,
    parent: THREE.Object3D,
    x = 0,
    y = 0,
    z = 0,
  ) => {
    geometries.push(g);
    const o = new THREE.Mesh(g, m);
    o.position.set(x, y, z);
    o.castShadow = true;
    if (m === glass) o.castShadow = false;
    o.receiveShadow = true;
    parent.add(o);
    return o;
  };
  const box = (
    p: THREE.Object3D,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    m = wood,
    r = 0.035,
  ) =>
    mesh(
      new RoundedBoxGeometry(w, h, d, 3, Math.min(r, w / 3, h / 3, d / 3)),
      m,
      p,
      x,
      y,
      z,
    );
  const cylinder = (
    p: THREE.Object3D,
    r: number,
    h: number,
    x: number,
    y: number,
    z: number,
    m: THREE.Material = charcoal,
    top = r,
  ) => mesh(new THREE.CylinderGeometry(top, r, h, 48), m, p, x, y, z);
  const torus = (
    p: THREE.Object3D,
    r: number,
    t: number,
    x: number,
    y: number,
    z: number,
    m: THREE.Material = brass,
  ) => {
    const o = mesh(new THREE.TorusGeometry(r, t, 8, 64), m, p, x, y, z);
    o.rotation.x = Math.PI / 2;
    return o;
  };
  const lathe = (p: THREE.Object3D, profile: number[][], m: THREE.Material) =>
    mesh(
      new THREE.LatheGeometry(
        profile.map(([x, y]) => new THREE.Vector2(x, y)),
        64,
      ),
      m,
      p,
    );
  function texture(
    width: number,
    height: number,
    draw: (ctx: CanvasRenderingContext2D) => void,
  ) {
    const c = document.createElement("canvas");
    c.width = Math.round(width * artworkScale);
    c.height = Math.round(height * artworkScale);
    const ctx = c.getContext("2d")!;
    ctx.scale(c.width / width, c.height / height);
    draw(ctx);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = anisotropy;
    textures.push(t);
    return t;
  }
  function wrappedLabel(
    parent: THREE.Object3D,
    r: number,
    y: number,
    title: string,
    sub: string,
    color: string,
    height = 0.48,
    arc = 1.7,
  ) {
    // Apothecary label: foxed paper, double rule, italic serif and a hand-
    // brushed Chinese name, so it reads as printed stock rather than UI.
    const t = texture(768, 512, (ctx) => {
      const rand = seeded(title.charCodeAt(0) * 31 + sub.length);
      const paperTone = ctx.createRadialGradient(384, 256, 60, 384, 256, 470);
      paperTone.addColorStop(0, "#efe4c8");
      paperTone.addColorStop(1, "#c9b48a");
      ctx.fillStyle = paperTone;
      ctx.fillRect(0, 0, 768, 512);
      for (let i = 0; i < 70; i++) {
        ctx.fillStyle = `rgba(122,84,40,${0.03 + rand() * 0.06})`;
        ctx.beginPath();
        ctx.arc(rand() * 768, rand() * 512, 4 + rand() * 26, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.strokeStyle = "#3b2a1c";
      ctx.lineWidth = 5;
      ctx.strokeRect(34, 30, 700, 452);
      ctx.lineWidth = 1.6;
      ctx.strokeRect(48, 44, 672, 424);
      ctx.fillStyle = color;
      ctx.fillRect(48, 44, 672, 14);
      ctx.textAlign = "center";
      ctx.fillStyle = "#4a3726";
      ctx.font = "600 22px Georgia, serif";
      ctx.fillText("Nº " + String(1 + (title.charCodeAt(0) % 9)).padStart(2, "0") + "  ·  PHOTO ALL ATELIER", 384, 104);
      ctx.fillStyle = "#24170e";
      ctx.font = "italic 400 92px Georgia, 'Palatino Linotype', serif";
      ctx.fillText(sub.charAt(0) + sub.slice(1).toLowerCase(), 384, 228, 640);
      ctx.font = "112px KaiTi, STKaiti, 'Microsoft YaHei', serif";
      ctx.fillStyle = "#3a2615";
      ctx.fillText(title, 384, 372, 640);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(384, 432, 10, 0, Math.PI * 2);
      ctx.fill();
    });
    const m = new THREE.MeshStandardMaterial({ map: t, roughness: 0.82 });
    materials.push(m);
    return mesh(
      new THREE.CylinderGeometry(
        r + 0.003,
        r + 0.003,
        height,
        48,
        1,
        true,
        -arc / 2,
        arc,
      ),
      m,
      parent,
      0,
      y,
      0,
    );
  }
  // Seeded procedural surfaces keep the room deterministic and offline.
  function seeded(seed: number) {
    return () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
  }
  function woodTexture(base: string, light: string, dark: string, seed: number) {
    const rand = seeded(seed);
    return texture(1024, 1024, (ctx) => {
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, 1024, 1024);
      for (let i = 0; i < 2600; i++) {
        const y = rand() * 1024,
          wave = 2 + rand() * 9,
          phase = rand() * Math.PI * 2;
        ctx.strokeStyle = rand() < 0.55 ? dark : light;
        ctx.globalAlpha = 0.03 + rand() * 0.07;
        ctx.lineWidth = 0.5 + rand() * 2.2;
        ctx.beginPath();
        for (let x = 0; x <= 1024; x += 32)
          ctx.lineTo(x, y + Math.sin(x / 190 + phase) * wave + Math.sin(x / 47 + phase) * 0.8);
        ctx.stroke();
      }
      // Cathedral figure: nested arcs where the plank was cut across a ring.
      for (let k = 0; k < 5; k++) {
        const cx = rand() * 1024,
          cy = rand() * 1024;
        for (let r = 0; r < 14; r++) {
          ctx.strokeStyle = r % 2 ? dark : light;
          ctx.globalAlpha = 0.07;
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.ellipse(cx, cy, 70 + r * 22, 9 + r * 6, 0, Math.PI, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      for (let i = 0; i < 9000; i++) {
        ctx.fillStyle = rand() < 0.5 ? "#00000022" : "#ffffff0d";
        ctx.fillRect(rand() * 1024, rand() * 1024, 1 + rand() * 3, 1);
      }
    });
  }
  const walnut = woodTexture("#4a2a1a", "#8a5634", "#1e0f08", 37);
  walnut.wrapS = walnut.wrapT = THREE.RepeatWrapping;
  wood.color.set("#e6c7ad");
  wood.map = walnut;
  wood.bumpMap = walnut;
  wood.bumpScale = 0.35;
  wood.roughness = 0.46;
  wood.needsUpdate = true;
  const brushed = texture(512, 512, (ctx) => {
    const rand = seeded(91);
    ctx.fillStyle = "#808080";
    ctx.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 1600; i++) {
      const v = 90 + Math.floor(rand() * 90);
      ctx.fillStyle = `rgba(${v},${v},${v},0.35)`;
      ctx.fillRect(0, rand() * 512, 512, 0.6 + rand() * 1.4);
    }
  });
  brushed.wrapS = brushed.wrapT = THREE.RepeatWrapping;
  brushed.colorSpace = THREE.NoColorSpace;
  steel.roughnessMap = brushed;
  steel.roughness = 0.85;
  steel.envMapIntensity = 0.35;
  steel.color.set("#8f7a68");
  steel.needsUpdate = true;
  const fibre = texture(512, 512, (ctx) => {
    const rand = seeded(53);
    ctx.fillStyle = "#f1e9d6";
    ctx.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 5000; i++) {
      ctx.fillStyle = rand() < 0.5 ? "#c9bc9e30" : "#ffffff40";
      ctx.save();
      ctx.translate(rand() * 512, rand() * 512);
      ctx.rotate(rand() * Math.PI);
      ctx.fillRect(0, 0, 3 + rand() * 9, 0.7);
      ctx.restore();
    }
  });
  paper.map = fibre;
  paper.color.set("#cdb99a");
  paper.needsUpdate = true;
  const sets = Object.fromEntries(
    (["shelf", "develop", "colour", "finish"] as View[]).map((id) => {
      const group = new THREE.Object3D();
      group.name = id;
      group.visible = id === "shelf";
      scene.add(group);
      return [id, group];
    }),
  ) as Record<View, THREE.Object3D>;
  const shelfSet = sets.shelf,
    developSet = sets.develop,
    colourSet = sets.colour,
    finishSet = sets.finish;
  // One long lacquered walnut bench runs through every station; only the
  // fixtures and the wall behind it change between the four scenes.
  const benchMap = walnut.clone();
  benchMap.repeat.set(1.3, 0.9);
  benchMap.needsUpdate = true;
  textures.push(benchMap);
  const bench = new THREE.MeshPhysicalMaterial({
    color: "#c89a78",
    map: benchMap,
    bumpMap: benchMap,
    bumpScale: 0.12,
    roughness: 0.82,
    clearcoat: 0,
    clearcoatRoughness: 1,
  });
  materials.push(bench);
  box(scene, 40, 0.24, 30, 0, 0.48, -1, bench, 0.02);
  // A felt runner marks the formula station; bottles stand straight on it.
  box(shelfSet, 9.6, 0.02, 1.5, 0, 0.61, -1.05, material("#2a1410", 0.95), 0.01);
  const bottleObjects: THREE.Group[] = [],
    baseObjects: THREE.Group[] = [],
    targets: THREE.Object3D[] = [];
  for (const [i, s] of SERUMS.entries()) {
    const g = new THREE.Group();
    shelfSet.add(g);
    g.position.set(-3.45 + i * 1.38, 0.62, -1.05);
    g.userData = { id: s.id, kind: "bottle", home: g.position.clone() };
    lathe(
      g,
      [
        [0, 0],
        [0.28, 0],
        [0.32, 0.035],
        [0.335, 0.09],
        [0.335, 0.94],
        [0.328, 1.03],
        [0.29, 1.1],
        [0.19, 1.19],
        [0.145, 1.24],
        [0.145, 1.42],
        [0.12, 1.43],
      ],
      glass,
    );
    const liquidMaterial = new THREE.MeshStandardMaterial({
      color: s.color,
      roughness: 0.26,
      metalness: 0.04,
    });
    materials.push(liquidMaterial);
    const liquid = cylinder(g, 0.296, 0.8, 0, 0.46, 0, liquidMaterial);
    g.userData.liquid = liquid;
    const cap = new THREE.Group();
    g.add(cap);
    cap.position.y = 1.47;
    g.userData.cap = cap;
    cylinder(cap, 0.17, 0.15, 0, 0, 0, charcoal);
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      box(
        cap,
        0.012,
        0.12,
        0.012,
        Math.sin(a) * 0.17,
        0,
        Math.cos(a) * 0.17,
        black,
        0.003,
      );
    }
    torus(g, 0.147, 0.014, 0, 1.35, 0, brass);
    wrappedLabel(g, 0.337, 0.64, s.name, s.english, s.color, 0.49);
    bottleObjects.push(g);
    targets.push(g);
  }
  const cassetteLeader = texture(256, 512, (ctx) => {
    ctx.fillStyle = "#9a542e";
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(131, 0);
    ctx.quadraticCurveTo(182, 0, 185, 51);
    ctx.lineTo(185, 170);
    ctx.quadraticCurveTo(185, 208, 239, 211);
    ctx.lineTo(256, 211);
    ctx.lineTo(256, 512);
    ctx.lineTo(0, 512);
    ctx.closePath();
    ctx.fill();
    for (const y of [30, 451])
      for (const x of [24, 83, 142, 201]) ctx.clearRect(x, y, 29, 29);
  });
  const leaderMaterial = new THREE.MeshStandardMaterial({
    map: cassetteLeader, roughness: 0.47, alphaTest: 0.5, side: THREE.DoubleSide,
  });
  materials.push(leaderMaterial);
  const cassetteMetal = material("#4c4c47", 0.34, 0.67);
  const cassetteEdge = material("#93918a", 0.37, 0.77);
  function filmCassette(group: THREE.Group, name: string, color: string, iso: number | null) {
    const label = texture(1024, 512, (ctx) => {
      const gold = name === "GOLD";
      const portra = name === "PORTRA";
      const ektar = name === "EKTAR";
      const fuji = name === "PRO 400H";
      ctx.fillStyle = gold ? "#edb42d" : iso ? "#242321" : color;
      ctx.fillRect(0, 0, 1024, 512);
      ctx.textAlign = "center";
      function printLabel(value: string, y: number, size: number, ink: string, x = 512) {
        ctx.fillStyle = ink;
        ctx.font = `bold ${size}px 'Arial Narrow', 'Segoe UI', sans-serif`;
        ctx.fillText(value, x, y, 490);
      }
      function band(y: number, height: number, ink: string) {
        ctx.fillStyle = ink;
        ctx.fillRect(0, y, 1024, height);
      }
      if (gold) {
        printLabel("GOLD", 98, 53, "#a62b24");
        printLabel("200", 288, 173, "#221f17");
        printLabel("35 mm COLOR PRINT FILM", 357, 29, "#221f17");
        printLabel("36 EXP   /   C-41", 436, 31, "#221f17");
      } else if (fuji) {
        band(275, 63, "#674575");
        band(338, 174, "#43754b");
        ctx.fillStyle = "#eeeadd";
        ctx.fillRect(237, 96, 98, 165);
        printLabel("36", 170, 39, "#272722", 286);
        printLabel("135", 221, 26, "#272722", 286);
        printLabel("PRO 400H", 222, 77, "#ebdf94", 549);
        printLabel("COLOR NEGATIVE FILM", 316, 28, "#f5ebdd");
        printLabel("FUJICOLOR", 405, 48, "#fff9e8");
        printLabel("PROFESSIONAL", 461, 27, "#fff9e8");
      } else if (portra || ektar) {
        band(0, portra ? 132 : 145, "#e3ae32");
        printLabel(portra ? "C-41   /   NOTES" : "C-41   /   36 EXP", 92, 40, "#2c2319");
        printLabel("COLOR NEGATIVE FILM", 208, 29, "#e8ddcb");
        printLabel(`${name} ${iso}`, 318, portra ? 68 : 79, portra ? "#e37967" : "#f1eadd");
        printLabel(portra ? "135–36   /   PROFESSIONAL" : "ISO 100   /   135–36", 427, 31, "#e8ddcb");
      } else {
        band(117, 228, "#b8a07a");
        printLabel("PHOTO ALL  /  135", 77, 28, "#d6c3a2");
        printLabel(name, 273, 76, "#262018");
        printLabel("35 mm   /   ATELIER", 430, 31, "#d6c3a2");
      }
      if (iso === null) return;
      for (let row = 0; row < 2; row++)
        for (let col = 0; col < 6; col++) {
          ctx.fillStyle = (col + row * 2) % 3 ? "#bfc0b5" : "#282823";
          ctx.fillRect(802 + col * 25, 242 + row * 63, 23, 60);
        }
    });
    const printedMetal = new THREE.MeshStandardMaterial({ map: label, roughness: 0.72, metalness: 0.08 });
    materials.push(printedMetal);
    mesh(new THREE.CylinderGeometry(0.282, 0.282, 0.76, 56, 1, true, -Math.PI),
      printedMetal, group, 0, 0.426, 0);
    for (const y of [0.036, 0.817]) {
      cylinder(group, 0.299, 0.052, 0, y, 0, cassetteMetal);
      torus(group, 0.286, 0.01, 0, y + 0.025, 0, cassetteEdge);
    }
    cylinder(group, 0.141, 0.028, 0, 0.849, 0, black);
    cylinder(group, 0.087, 0.085, 0, 0.904, 0, charcoal);
    cylinder(group, 0.075, 0.02, 0, 0.013, 0, black);
    for (const z of [-0.048, 0.048])
      box(group, 0.126, 0.038, 0.042, 0, 0.959, z, charcoal, 0.006);
    for (const z of [0.027, 0.109])
      box(group, 0.164, 0.739, 0.048, 0.288, 0.421, z, cassetteMetal, 0.012);
    box(group, 0.147, 0.722, 0.037, 0.293, 0.421, 0.069, black, 0.005);
    mesh(new THREE.PlaneGeometry(0.22, 0.706), leaderMaterial, group, 0.454, 0.421, 0.074);
  }
  for (const [i, b] of BASES.entries()) {
    const g = new THREE.Group();
    shelfSet.add(g);
    g.position.set(-3.3 + i * 1.65, 0.61, -2.95);
    g.userData = { id: b.id, kind: "base", home: g.position.clone() };
    filmCassette(g, b.id === "inherit" ? "原色" : b.short, b.color, b.iso);
    baseObjects.push(g);
    targets.push(g);
  }
  const cup = new THREE.Group();
  shelfSet.add(cup);
  cup.userData = { id: "mixing-cup", kind: "cup" };
  cup.position.set(-0.1, 0.62, 1.12);
  lathe(
    cup,
    [
      [0, 0],
      [0.63, 0],
      [0.7, 0.06],
      [0.76, 0.16],
      [0.83, 0.82],
      [0.84, 0.87],
      [0.83, 0.9],
      [0.79, 0.9],
      [0.78, 0.86],
      [0.72, 0.16],
      [0.64, 0.09],
      [0, 0.09],
    ],
    glass,
  );
  torus(cup, 0.82, 0.018, 0, 0.89, 0, glass);
  const graduationTexture = texture(256, 512, (ctx) => {
    ctx.fillStyle = "#f0e2bb";
    ctx.font = "bold 34px Consolas";
    ctx.textBaseline = "middle";
    for (let ml = 0; ml <= 240; ml += 30) {
      const y = (0.69 - (ml / 240) * 0.64) * (512 / 0.72);
      const major = ml % 60 === 0;
      ctx.fillRect(18, y - 2, major ? 66 : 40, 4);
      if (major) ctx.fillText(String(ml), 97, y);
    }
  });
  const graduationMaterial = new THREE.MeshBasicMaterial({
    map: graduationTexture,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  materials.push(graduationMaterial);
  const graduation = mesh(
    new THREE.CylinderGeometry(0.84, 0.76, 0.72, 32, 1, true, -0.36, 0.72),
    graduationMaterial,
    cup,
    0, 0.5, 0,
  );
  graduation.castShadow = false;
  graduation.renderOrder = 2;
  const mixtureMaterial = new THREE.MeshStandardMaterial({
    color: "#b9a16d",
    roughness: 0.23,
    metalness: 0.1,
  });
  materials.push(mixtureMaterial);
  const mixture = cylinder(cup, 0.7, 0.12, 0, 0.16, 0, mixtureMaterial);
  mixture.castShadow = false;
  const meniscus = torus(cup, 0.69, 0.012, 0, 0.22, 0, mixtureMaterial);
  meniscus.castShadow = false;
  const receiverMaterial = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  materials.push(receiverMaterial);
  const receiver = mesh(
    new THREE.CircleGeometry(1.1, 48),
    receiverMaterial,
    shelfSet,
    cup.position.x,
    1.55,
    cup.position.z,
  );
  receiver.rotation.x = -Math.PI / 2;
  receiver.castShadow = false;
  const saucer = box(
      shelfSet,
      2.25,
      0.06,
      2.2,
      -0.1,
      0.61,
      1.12,
      material("#2b1810", 0.88),
      0.2,
    ),
    materialForSaucer = saucer.material;
  const jetMaterial = new THREE.MeshStandardMaterial({
    color: "#edd8a6",
    emissive: "#a77640",
    emissiveIntensity: 0.55,
    roughness: 0.25,
  });
  materials.push(jetMaterial);
  const stream = mesh(
    new THREE.CylinderGeometry(0.036, 0.044, 1, 12),
    jetMaterial,
    shelfSet,
  );
  stream.castShadow = false;
  stream.visible = false;
  const tank = new THREE.Group();
  developSet.add(tank);
  tank.position.set(0.8, 0.62, 0.45);
  tank.userData = { id: "tank", kind: "tank", home: tank.position.clone() };
  targets.push(tank);
  // Stainless daylight tank: spun body with rolled ribs and a beaded rim.
  const tankProfile: number[][] = [[0, 0], [0.52, 0], [0.58, 0.05], [0.595, 0.14]];
  for (const y of [0.32, 0.62, 0.92, 1.18]) {
    tankProfile.push([0.595, y - 0.05], [0.615, y - 0.02], [0.615, y + 0.02], [0.595, y + 0.05]);
  }
  tankProfile.push([0.595, 1.36], [0.62, 1.42], [0.6, 1.48], [0.5, 1.48], [0.48, 1.44], [0.48, 0.16], [0, 0.16]);
  lathe(tank, tankProfile, steel);
  const tankLid = new THREE.Group();
  developSet.add(tankLid);
  const lidSeat = new THREE.Vector3(0, 1.535, 0);
  const lidRest = new THREE.Vector3(1.86, 0.677, 1.93);
  const lidLevel = new THREE.Quaternion();
  function placeLid(open: number) {
    const lift = THREE.MathUtils.smoothstep(open, 0, 0.25);
    const slide = THREE.MathUtils.smoothstep(open, 0.25, 0.7);
    const lower = THREE.MathUtils.smoothstep(open, 0.7, 1);
    const seat = tank.localToWorld(lidSeat.clone());
    tankLid.position.copy(seat).lerp(lidRest, slide);
    tankLid.position.y = THREE.MathUtils.lerp(seat.y + lift * 0.28, lidRest.y, lower);
    tank.getWorldQuaternion(tankLid.quaternion).slerp(lidLevel, slide);
  }
  placeLid(0);
  // Light-tight lid: knurled bakelite skirt, stepped crown and a pouring cap.
  mesh(new THREE.CylinderGeometry(0.64, 0.65, 0.12, 72, 1), bakelite, tankLid);
  for (let k = 0; k < 48; k++) {
    const a = (k / 48) * Math.PI * 2;
    box(tankLid, 0.03, 0.1, 0.03, Math.sin(a) * 0.648, 0, Math.cos(a) * 0.648, bakelite, 0.01).rotation.y = a;
  }
  cylinder(tankLid, 0.5, 0.06, 0, 0.08, 0, bakelite, 0.46);
  cylinder(tankLid, 0.24, 0.1, 0, 0.14, 0, lacquerRed, 0.22);
  torus(tankLid, 0.235, 0.014, 0, 0.19, 0, brass);
  wrappedLabel(tank, 0.6, 0.77, "显影", "DEVELOP", "#8e2a1c", 0.22, 0.95);
  const dialObjects: THREE.Group[] = [],
    hands = new Map<string, THREE.Group>();
  function dial(
    id: DialId,
    x: number,
    z: number,
    radius: number,
    title: string,
    left: string,
    right: string,
  ) {
    const g = new THREE.Group();
    (id === "timer" ? developSet : id === "warmth" ? colourSet : shelfSet).add(
      g,
    );
    g.position.set(x, 0.66 + radius * 0.72, z);
    g.rotation.set(-0.84, 0.24, 0, "YXZ");
    g.userData = { id, kind: "dial", radius };
    // Bakelite instrument case with a turned brass bezel, domed glass and a
    // folding rear stand, in the manner of an old enlarger timer.
    const back = lathe(
      g,
      [
        [0, -0.16],
        [radius * 0.94, -0.16],
        [radius * 1.02, -0.11],
        [radius * 1.04, 0.02],
        [radius * 1.01, 0.1],
        [0, 0.1],
      ],
      bakelite,
    );
    back.rotation.x = Math.PI / 2;
    const bezel = mesh(new THREE.TorusGeometry(radius * 0.96, radius * 0.06, 16, 96), brass, g, 0, 0, 0.12);
    bezel.castShadow = false;
    mesh(new THREE.TorusGeometry(radius * 0.9, radius * 0.018, 8, 96), brass, g, 0, 0, 0.15);
    // A short wedge foot holds the tilted case on the bench.
    const foot = box(g, radius * 1.1, radius * 0.5, 0.36, 0, -radius * 0.86, -0.16, bakelite, 0.03);
    foot.rotation.x = 0.84;
    const ticks = 54;
    const faceTex = texture(1024, 1024, (ctx) => {
      const tone = ctx.createRadialGradient(512, 470, 80, 512, 512, 520);
      tone.addColorStop(0, "#d8c4a0");
      tone.addColorStop(0.8, "#bba37a");
      tone.addColorStop(1, "#7f6646");
      ctx.fillStyle = tone;
      ctx.fillRect(0, 0, 1024, 1024);
      ctx.translate(512, 512);
      ctx.strokeStyle = "#2a1d12";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, 420, ((-135 - 90) * Math.PI) / 180, ((135 - 90) * Math.PI) / 180);
      ctx.stroke();
      for (let i = 0; i <= ticks; i++) {
        const a = ((-135 + (i * 270) / ticks) * Math.PI) / 180,
          major = i % 6 === 0,
          inner = major ? 352 : i % 3 === 0 ? 382 : 396;
        ctx.strokeStyle = major ? "#1a120b" : "#3d2c1d";
        ctx.lineWidth = major ? 9 : 4;
        ctx.beginPath();
        ctx.moveTo(Math.sin(a) * 420, -Math.cos(a) * 420);
        ctx.lineTo(Math.sin(a) * inner, -Math.cos(a) * inner);
        ctx.stroke();
        if (!major) continue;
        const v = i / ticks;
        const numeral = id === "timer"
          ? String(Math.round(developmentSeconds(v)))
          : id === "concentration"
            ? String(Math.round(v * 100))
            : (v < 0.5 ? "−" : v > 0.5 ? "+" : "") + Math.round(Math.abs(v - 0.5) * 100);
        ctx.fillStyle = "#1d140c";
        ctx.font = "600 54px Georgia, serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(numeral, Math.sin(a) * 296, -Math.cos(a) * 296);
      }
      ctx.fillStyle = "#8e2a1c";
      ctx.beginPath();
      ctx.arc(Math.sin((135 * Math.PI) / 180) * 420, -Math.cos((135 * Math.PI) / 180) * 420, 13, 0, Math.PI * 2);
      ctx.fill();
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = "#2b1d12";
      ctx.font = "62px KaiTi, STKaiti, serif";
      ctx.fillText(title, 0, 180);
      ctx.font = "italic 30px Georgia, serif";
      ctx.fillText(id === "timer" ? "seconds" : id === "warmth" ? "colour balance" : "strength", 0, 232);
      ctx.font = "46px KaiTi, STKaiti, serif";
      ctx.fillText(left, -250, 330);
      ctx.fillText(right, 250, 330);
      ctx.font = "600 20px Georgia, serif";
      ctx.fillText("PHOTO ALL  ·  ATELIER", 0, -150);
    });
    const fm = new THREE.MeshStandardMaterial({
      map: faceTex,
      roughness: 0.7,
      emissive: "#ffffff",
      emissiveMap: faceTex,
      emissiveIntensity: 0.04,
    });
    materials.push(fm);
    mesh(new THREE.CircleGeometry(radius * 0.9, 96), fm, g, 0, 0, 0.105);
    const dome = mesh(
      new THREE.SphereGeometry(radius * 2.2, 48, 12, 0, Math.PI * 2, 0, Math.asin(0.41)),
      domeGlass,
      g,
      0,
      0,
      0.13 - radius * 2.2 * Math.cos(Math.asin(0.41)),
    );
    dome.rotation.x = Math.PI / 2;
    dome.castShadow = false;
    const hand = new THREE.Group();
    g.add(hand);
    hand.position.z = 0.15;
    const pointer = new THREE.Shape();
    pointer.moveTo(-radius * 0.035, -radius * 0.2);
    pointer.lineTo(radius * 0.035, -radius * 0.2);
    pointer.lineTo(radius * 0.012, radius * 0.78);
    pointer.lineTo(0, radius * 0.84);
    pointer.lineTo(-radius * 0.012, radius * 0.78);
    pointer.closePath();
    mesh(new THREE.ExtrudeGeometry(pointer, { depth: 0.012, bevelEnabled: false }), lacquerRed, hand);
    const pin = cylinder(hand, radius * 0.07, 0.03, 0, 0, 0.02, brass);
    pin.rotation.x = Math.PI / 2;
    hands.set(id, hand);
    dialObjects.push(g);
    targets.push(g);
  }
  dial("timer", -3.55, 1.55, 0.79, "显影时间", "短", "长");
  dial("warmth", -3.75, 0.15, 0.52, "色温", "冷", "暖");
  dial("concentration", -3.55, 1.55, 0.52, "浓度", "淡", "浓");
  // Separate wet bench, red-light bath and drying room. Only one group is visible.
  function labTray(
    parent: THREE.Object3D,
    x: number,
    y: number,
    z: number,
    width: number,
    depth: number,
    height: number,
    surface: THREE.MeshStandardMaterial,
  ) {
    const levels = [
      { scale: 0.92, y: 0 },
      { scale: 0.94, y: 0.025 },
      { scale: 0.99, y: height - 0.028 },
      { scale: 1, y: height },
      { scale: 0.96, y: height + 0.016 },
      { scale: 0.92, y: height },
      { scale: 0.875, y: 0.048 },
    ];
    const segments = 32;
    const positions: number[] = [],
      indices: number[] = [];
    for (const level of levels) {
      const halfW = (width * level.scale) / 2;
      const halfD = (depth * level.scale) / 2;
      const radius = 0.19 * level.scale;
      for (let corner = 0; corner < 4; corner++) {
        const mid = (corner * Math.PI) / 2 + Math.PI / 4;
        const centerX = Math.sign(Math.cos(mid)) * (halfW - radius);
        const centerZ = Math.sign(Math.sin(mid)) * (halfD - radius);
        for (let j = 0; j < 8; j++) {
          const angle = (corner * Math.PI) / 2 + (j * Math.PI) / 14;
          positions.push(
            centerX + Math.cos(angle) * radius,
            level.y,
            centerZ + Math.sin(angle) * radius,
          );
        }
      }
    }
    for (let level = 0; level < levels.length - 1; level++) {
      for (let i = 0; i < segments; i++) {
        const current = level * segments + i;
        const next = level * segments + ((i + 1) % segments);
        indices.push(
          current,
          current + segments,
          next + segments,
          current,
          next + segments,
          next,
        );
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    mesh(geometry, surface, parent, x, y, z);
    box(
      parent,
      width * 0.912,
      0.053,
      depth * 0.912,
      x,
      y + 0.024,
      z,
      surface,
      0.022,
    );
  }
  function tongs(
    parent: THREE.Object3D,
    x: number,
    z: number,
    color: string,
    rotation: number,
  ) {
    // Bamboo print tongs: two split slats joined by a bent spring, with
    // dipped rubber tips colour-coded to the bath they belong to.
    const group = new THREE.Group();
    group.position.set(x, 0.66, z);
    group.rotation.y = rotation;
    parent.add(group);
    const tip = material(color, 0.62);
    for (const side of [-1, 1]) {
      const slat = box(group, 0.085, 0.032, 1.42, side * 0.07, 0, 0, bamboo, 0.012);
      slat.rotation.y = side * 0.03;
      for (const node of [-0.28, 0.24])
        box(group, 0.092, 0.038, 0.035, side * (0.07 - node * 0.03), 0, node, bambooNode, 0.008);
      box(group, 0.092, 0.04, 0.2, side * 0.091, 0, -0.66, tip, 0.016);
    }
    box(group, 0.21, 0.045, 0.1, 0, 0, 0.68, bambooNode, 0.02);
    return group;
  }
  const sink = new THREE.Group();
  developSet.add(sink);
  sink.position.set(3.2, 0.65, -0.2);
  labTray(sink, 0, -0.04, 0, 2.46, 2.68, 0.31, steel);
  cylinder(sink, 0.145, 0.018, 0, 0.03, 0.16, charcoal);
  for (const angle of [0, Math.PI / 3, (Math.PI * 2) / 3])
    box(sink, 0.2, 0.013, 0.026, 0, 0.044, 0.16, steel, 0.006).rotation.y =
      angle;
  const faucetCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(3.2, 0.65, -1.4),
    new THREE.Vector3(3.2, 2.6, -1.4),
    new THREE.Vector3(3.2, 2.8, -0.4),
    new THREE.Vector3(3.2, 2.3, -0.4),
  ]);
  mesh(
    new THREE.TubeGeometry(faucetCurve, 36, 0.055, 10, false),
    steel,
    developSet,
  );
  const developCup = cup.clone(true);
  developSet.add(developCup);
  developCup.position.set(-1.44, 0.64, 0.18);
  const developLiquid = developCup.children[cup.children.indexOf(mixture)];
  const developSurface = developCup.children[cup.children.indexOf(meniscus)];
  const developLip = new THREE.Vector3(0.83, 0.89, 0);
  const pourPivot = new THREE.Vector3(0.66, 3.08, 0.45);
  const cupClearance = pourPivot.y - developLip.y;
  const cupRotationAxis = new THREE.Vector3(0, 0, 1);
  developCup.userData = {
    id: "process-cup",
    kind: "process-cup",
    home: developCup.position.clone(),
  };
  targets.push(developCup);
  const tankTarget = mesh(
    new THREE.CircleGeometry(1.08, 48),
    receiverMaterial,
    developSet,
    0.8,
    2.25,
    0.45,
  );
  tankTarget.rotation.x = -Math.PI / 2;
  tankTarget.castShadow = false;
  const processStream = mesh(
    new THREE.CylinderGeometry(0.045, 0.057, 1, 12),
    jetMaterial,
    developSet,
  );
  processStream.castShadow = false;
  processStream.visible = false;
  const drainStream = mesh(
    new THREE.CylinderGeometry(0.025, 0.04, 1, 10),
    mixtureMaterial,
    developSet,
  );
  drainStream.castShadow = false;
  drainStream.visible = false;
  function placeJet(jet: THREE.Mesh, mouth: THREE.Vector3, end: THREE.Vector3, width: number) {
    jet.position.copy(mouth).lerp(end, 0.5);
    jet.scale.set(width, mouth.distanceTo(end), width);
    jet.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), mouth.sub(end).normalize());
  }
  const red = material("#a72615", 0.32);
  red.emissive.set("#ff2a10");
  red.emissiveIntensity = 1.8;
  const safeGlow = new THREE.PointLight("#ff2a10", 12, 8, 2);
  safeGlow.position.set(-3.5, 2.4, -1.9);
  colourSet.add(safeGlow);
  const trayCenters = [-1.5, 1.25, 4],
    baths: THREE.Mesh[] = [],
    trayTongs: THREE.Object3D[] = [];
  // Dark chemistry: a still, nearly black surface with a soft sheen.
  const waterMaterial = new THREE.MeshPhysicalMaterial({
    color: "#2a1a12",
    roughness: 0.28,
    metalness: 0,
    transparent: true,
    opacity: 0.46,
    clearcoat: 0,
    clearcoatRoughness: 1,
    envMapIntensity: 0.25,
    depthWrite: false,
  });
  materials.push(waterMaterial);
  const blackEnamel = new THREE.MeshPhysicalMaterial({ color: "#2e1d16", roughness: 0.66, clearcoat: 0 });
  const whiteEnamel = new THREE.MeshPhysicalMaterial({ color: "#a4907a", roughness: 0.68, clearcoat: 0 });
  materials.push(blackEnamel, whiteEnamel);
  const trayMaterials = [steel, blackEnamel, whiteEnamel];
  const bathNames = [
    ["显影", "DEVELOPER"],
    ["停显", "STOP BATH"],
    ["定影", "FIXER"],
  ];
  for (const [i, x] of trayCenters.entries()) {
    labTray(colourSet, x, 0.6, 0.29, 2.54, 2.73, 0.36, trayMaterials[i]);
    const pair = tongs(
      colourSet,
      x + 0.82,
      2.2,
      ["#4f2219", "#5c4c2e", "#33393a"][i],
      -0.25,
    );
    pair.userData.home = pair.position.clone();
    pair.userData.yaw = pair.rotation.y;
    trayTongs.push(pair);
    const water = mesh(
      new THREE.PlaneGeometry(2.23, 2.39, 40, 40),
      waterMaterial,
      colourSet,
      x,
      0.86,
      0.29,
    );
    water.rotation.x = -Math.PI / 2;
    water.castShadow = false;
    water.receiveShadow = false;
    baths.push(water);
    // Handwritten tent card naming each bath.
    const card = texture(512, 256, (ctx) => {
      ctx.fillStyle = "#c4ae8a";
      ctx.fillRect(0, 0, 512, 256);
      ctx.strokeStyle = "#7a2a1c";
      ctx.lineWidth = 3;
      ctx.strokeRect(14, 14, 484, 228);
      ctx.fillStyle = "#2a1a10";
      ctx.textAlign = "center";
      ctx.font = "96px KaiTi, STKaiti, serif";
      ctx.fillText(bathNames[i][0], 256, 130);
      ctx.font = "italic 34px Georgia, serif";
      ctx.fillText(`${i + 1} · ${bathNames[i][1].toLowerCase()}`, 256, 200);
    });
    const cardMaterial = new THREE.MeshStandardMaterial({ map: card, roughness: 0.85 });
    materials.push(cardMaterial);
    const tent = mesh(new THREE.PlaneGeometry(0.9, 0.45), cardMaterial, colourSet, x - 0.62, 0.8, 1.86);
    tent.rotation.x = -0.5;
  }
  const bathTarget = mesh(
    new THREE.CircleGeometry(1.2, 48),
    receiverMaterial,
    colourSet,
    -1.5,
    1.01,
    0.29,
  );
  bathTarget.rotation.x = -Math.PI / 2;
  bathTarget.castShadow = false;
  const trayTargets = [
    bathTarget,
    ...trayCenters.slice(1).map((x) => {
      const target = mesh(new THREE.CircleGeometry(1.2, 48), receiverMaterial, colourSet, x, 1.01, 0.29);
      target.rotation.x = -Math.PI / 2;
      target.castShadow = false;
      return target;
    }),
  ];
  // Concentric ripples are written straight into each bath's vertex grid.
  const ripples: { bath: number; x: number; y: number; start: number; strength: number }[] = [];
  const restingWater = baths.map((b) => Float32Array.from(b.geometry.attributes.position.array));
  function ripple(bath: number, at: THREE.Vector3, strength = 1) {
    baths[bath].updateMatrixWorld();
    const local = baths[bath].worldToLocal(at.clone());
    ripples.push({ bath, x: local.x, y: local.y, start: performance.now(), strength });
    if (ripples.length > 14) ripples.shift();
  }
  function waveWater(now: number) {
    let active = false;
    for (const [i, water] of baths.entries()) {
      const mine = ripples.filter((r) => r.bath === i && now - r.start < 2600);
      if (!mine.length && !water.userData.rippling) continue;
      const position = water.geometry.attributes.position as THREE.BufferAttribute;
      const rest = restingWater[i];
      for (let v = 0; v < position.count; v++) {
        const x = rest[v * 3],
          y = rest[v * 3 + 1];
        let z = 0;
        for (const r of mine) {
          const age = (now - r.start) / 1000,
            front = age * 1.1,
            d = Math.hypot(x - r.x, y - r.y) - front;
          z += Math.sin(d * 14) * Math.exp(-Math.abs(d) * 4.5) * Math.exp(-age * 1.5) * 0.014 * r.strength;
        }
        position.setZ(v, z);
      }
      position.needsUpdate = true;
      water.geometry.computeVertexNormals();
      water.userData.rippling = mine.length > 0;
      active ||= mine.length > 0;
    }
    return active;
  }
  const imageCanvas = document.createElement("canvas");
  imageCanvas.width = Math.min(studioProofWidth, maxTextureSize);
  imageCanvas.height = imageCanvas.width * 3 / 4;
  const imageContext = imageCanvas.getContext("2d")!;
  imageContext.fillStyle = "#161b18";
  imageContext.fillRect(0, 0, imageCanvas.width, imageCanvas.height);
  const photoTexture = new THREE.CanvasTexture(imageCanvas);
  photoTexture.colorSpace = THREE.SRGBColorSpace;
  photoTexture.anisotropy = anisotropy;
  textures.push(photoTexture);
  const latentMaterial = new THREE.MeshBasicMaterial({
    map: photoTexture,
    toneMapped: false,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  materials.push(latentMaterial);
  const finishedMaterial = new THREE.MeshBasicMaterial({
    map: photoTexture,
    toneMapped: false,
  });
  materials.push(finishedMaterial);
  function print(
    parent: THREE.Object3D,
    id: string,
    x: number,
    y: number,
    z: number,
    latent: boolean,
  ) {
    const g = new THREE.Group();
    parent.add(g);
    g.position.set(x, y, z);
    g.rotation.x = -Math.PI / 2;
    box(g, 1.85, 1.46, 0.028, 0, 0, 0, paper, 0.025);
    mesh(
      new THREE.PlaneGeometry(1.65, 1.2375),
      latent ? latentMaterial : finishedMaterial,
      g,
      0,
      0.035,
      0.017,
    );
    g.userData = { id, kind: id, home: g.position.clone() };
    targets.push(g);
    return g;
  }
  box(colourSet, 1.94, 0.046, 1.53, -1.5, 0.62, 2.43, charcoal, 0.023);
  const bathPrint = print(colourSet, "bath-paper", -1.5, 0.662, 2.43, true);
  // Drying room: rope, timber rack, clips and a paper landing tray.
  // Drying corner: plaster wall, iron hooks and a waxed line with pegs.
  const dryingLight = new THREE.PointLight("#ff3a1c", 9, 7, 2);
  dryingLight.position.set(-5.2, 3.2, -2.2);
  finishSet.add(dryingLight);
  const ropeCurve = new THREE.CatmullRomCurve3(
    Array.from({ length: 9 }, (_, i) => {
      const t = i / 8 - 0.5;
      return new THREE.Vector3(t * 16, 3.15 - (0.25 - t * t) * 0.5, -1.7);
    }),
  );
  mesh(
    new THREE.TubeGeometry(ropeCurve, 96, 0.016, 8, false),
    material("#cdbb98", 0.95),
    finishSet,
  );
  const ropeAt = (x: number) => ropeCurve.getPointAt(clamp(x / 16 + 0.5));
  // Spring pegs: two bevelled wooden jaws hinged on a steel coil.
  const pegWood = material("#86644a", 0.68);
  function peg(parent: THREE.Object3D) {
    const g = new THREE.Group();
    parent.add(g);
    for (const z of [-0.035, 0.035]) {
      const jaw = box(g, 0.075, 0.42, 0.06, 0, -0.08, z, pegWood, 0.018);
      jaw.rotation.x = z > 0 ? -0.04 : 0.04;
    }
    const coil = torus(g, 0.045, 0.011, 0, -0.02, 0, steel);
    coil.rotation.set(0, Math.PI / 2, 0);
    return g;
  }
  const clips: THREE.Group[] = [];
  for (const x of [-0.67, 0.67]) {
    const clip = peg(finishSet);
    clip.position.copy(ropeAt(x)).add(new THREE.Vector3(0, -0.02, 0));
    clips.push(clip);
  }
  const hangSlots = [-3.9, -2.35, 2.35, 3.9];
  for (const x of hangSlots) {
    const spare = peg(finishSet);
    spare.position.copy(ropeAt(x));
    spare.rotation.z = x * 0.012;
  }
  labTray(finishSet, 0, 0.6, 1.4, 3.66, 2.72, 0.24, steel);
  tongs(finishSet, 2.36, 1.92, "#95573d", -0.63);
  for (const [i, [x, z]] of [
    [3.4, 0.4],
    [4.29, 0.17],
    [4.05, 1.15],
  ].entries()) {
    const spool = new THREE.Group();
    finishSet.add(spool);
    spool.position.set(x, 0.61, z);
    spool.rotation.y = 0.14 - i * 0.28;
    filmCassette(spool, ["ATELIER", "NEGATIVE", "ARCHIVE"][i], "#4e3324", null);
  }
  const dryPrint = print(finishSet, "dry-paper", 0, 0.7, 1.4, false);
  dryPrint.scale.setScalar(1.45);
  // Every print applied in this session stays pegged on the line as a small
  // snapshot of its finished look; clicking one moves on to the next frame.
  const hungPrints: THREE.Group[] = [];
  function hangCopy() {
    const snapshot = document.createElement("canvas");
    snapshot.width = graphics.liveSize;
    snapshot.height = snapshot.width * 3 / 4;
    const context = snapshot.getContext("2d")!;
    context.imageSmoothingQuality = "high";
    context.drawImage(imageCanvas, 0, 0, snapshot.width, snapshot.height);
    const map = new THREE.CanvasTexture(snapshot);
    map.colorSpace = THREE.SRGBColorSpace;
    textures.push(map);
    const face = new THREE.MeshBasicMaterial({ map, toneMapped: false });
    materials.push(face);
    const slot = hangSlot++ % hangSlots.length;
    if (hungPrints[slot]) finishSet.remove(hungPrints[slot]);
    const g = new THREE.Group();
    finishSet.add(g);
    g.position.copy(ropeAt(hangSlots[slot])).add(new THREE.Vector3(0, -0.47, 0.03));
    g.scale.setScalar(0.62);
    box(g, 1.85, 1.46, 0.028, 0, 0, 0, paper, 0.02);
    mesh(new THREE.PlaneGeometry(1.65, 1.2375), face, g, 0, 0.035, 0.017);
    g.userData = { id: "hung-print", kind: "hung-print" };
    targets.push(g);
    hungPrints[slot] = g;
  }
  const hanger = new THREE.Object3D();
  hanger.position.copy(ropeAt(0)).add(new THREE.Vector3(0, -1.06, -0.01));
  finishSet.add(hanger);
  const sheenMaterial = new THREE.MeshBasicMaterial({
    color: "#ffffff",
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
  });
  materials.push(sheenMaterial);
  const wetSheen = mesh(
    new THREE.PlaneGeometry(1.82, 1.43),
    sheenMaterial,
    dryPrint,
    0,
    0.02,
    0.025,
  );
  wetSheen.castShadow = false;
  const droplets: THREE.Mesh[] = [];
  for (let i = 0; i < 12; i++) {
    const drop = mesh(new THREE.SphereGeometry(0.025, 8, 6), glass, colourSet);
    drop.visible = false;
    drop.castShadow = false;
    droplets.push(drop);
  }
  // A handwritten process card travels with you between the stations: it
  // records the formula and ticks off each of the four steps.
  const cardCanvas = document.createElement("canvas");
  cardCanvas.width = Math.round(768 * artworkScale);
  cardCanvas.height = Math.round(1000 * artworkScale);
  const cardContext = cardCanvas.getContext("2d")!;
  cardContext.scale(cardCanvas.width / 768, cardCanvas.height / 1000);
  const cardTexture = new THREE.CanvasTexture(cardCanvas);
  cardTexture.colorSpace = THREE.SRGBColorSpace;
  cardTexture.anisotropy = anisotropy;
  textures.push(cardTexture);
  const cardFace = new THREE.MeshStandardMaterial({
    map: cardTexture,
    roughness: 0.9,
    emissive: "#ffffff",
    emissiveMap: cardTexture,
    emissiveIntensity: 0.04,
  });
  materials.push(cardFace);
  const recordCard = new THREE.Group();
  scene.add(recordCard);
  box(recordCard, 1.42, 0.03, 1.84, 0, 0, 0, paper, 0.01);
  box(recordCard, 1.4, 0.022, 1.82, 0.03, -0.012, -0.025, paper, 0.01).rotation.y = 0.03;
  const cardTop = mesh(new THREE.PlaneGeometry(1.38, 1.8), cardFace, recordCard, 0, 0.017, 0);
  cardTop.rotation.x = -Math.PI / 2;
  cardTop.castShadow = false;
  const cardPlaces: Record<View, [number, number, number, number]> = {
    shelf: [3.75, 0.615, 1.75, -0.22],
    develop: [1.75, 0.615, 1.95, -0.14],
    colour: [-3.35, 0.615, 2.35, 0.16],
    finish: [-3.5, 0.615, 1.7, 0.2],
  };
  let cardKey = "";
  function drawCard() {
    const m = state.mix,
      base = BASES.find((b) => b.id === m.stock),
      doses = SERUMS.filter((s) => m.doses[s.id] > 0.004).map((s) => `${s.name} ${Math.round(m.doses[s.id] * 100)}`),
      steps: [string, boolean, string][] = [
        ["配方", m.stock !== "inherit" || doses.length > 0, ""],
        ["显影", m.development > 0.001, m.development > 0.001 ? `${Math.round(m.development * 100)}%` : ""],
        ["冲印", printStage === "fixed", printStage === "fresh" ? "" : { developing: "显影中", stopped: "已停显", fixed: "已定影", fresh: "" }[printStage]],
        ["晾干", drying >= 1, drying >= 0 && drying < 1 ? "晾着" : ""],
      ];
    const key = JSON.stringify([state.frame, base?.id, doses, m.concentration, m.timer, m.warmth, steps]);
    if (key === cardKey) return;
    cardKey = key;
    const ctx = cardContext;
    const rand = seeded(7);
    ctx.fillStyle = "#d6c09c";
    ctx.fillRect(0, 0, 768, 1000);
    for (let i = 0; i < 26; i++) {
      ctx.strokeStyle = "#7a9ab433";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(40, 170 + i * 31);
      ctx.lineTo(728, 170 + i * 31);
      ctx.stroke();
    }
    ctx.strokeStyle = "#c0473a66";
    ctx.beginPath();
    ctx.moveTo(118, 0);
    ctx.lineTo(118, 1000);
    ctx.stroke();
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = `rgba(120,86,40,${0.02 + rand() * 0.05})`;
      ctx.beginPath();
      ctx.arc(rand() * 768, rand() * 1000, 6 + rand() * 30, 0, Math.PI * 2);
      ctx.fill();
    }
    const hand = (text: string, x: number, y: number, size: number, ink = "#2a1a10", rotate = -0.012) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rotate);
      ctx.fillStyle = ink;
      ctx.font = `${size}px KaiTi, STKaiti, 'Ink Free', serif`;
      ctx.fillText(text, 0, 0, 600);
      ctx.restore();
    };
    ctx.textAlign = "left";
    ctx.fillStyle = "#4a3726";
    ctx.font = "600 22px Georgia, serif";
    ctx.fillText("DARKROOM  RECORD", 136, 64);
    hand("冲洗记录", 136, 136, 66);
    ctx.font = "italic 30px Georgia, serif";
    ctx.fillStyle = "#5a4330";
    ctx.fillText(`No. ${state.frame || "—"}`, 400, 132, 340);
    hand(`底片  ${base?.name || "原有底色"}`, 136, 232, 44);
    const formula = doses.length ? doses : ["（还没加药剂）"];
    hand(`配方  ${formula.slice(0, 2).join(" · ")}`, 136, 294, 40);
    if (formula.length > 2) hand(`      ${formula.slice(2, 4).join(" · ")}`, 136, 350, 40);
    if (formula.length > 4) hand(`      ${formula.slice(4).join(" · ")}`, 136, 406, 40);
    const warmth = Math.round((m.warmth - 0.5) * 100);
    hand(`浓度 ${Math.round(m.concentration * 100)}%   时间 ${developmentSeconds(m.timer).toFixed(1)}s`, 136, 470, 38);
    hand(`色温 ${warmth > 0 ? "+" : warmth < 0 ? "−" : ""}${Math.abs(warmth)}`, 136, 528, 38);
    for (const [i, [name, done, detail]] of steps.entries()) {
      const y = 640 + i * 82;
      ctx.strokeStyle = "#3a2615";
      ctx.lineWidth = 3;
      ctx.strokeRect(140, y - 40, 42, 42);
      hand(`${i + 1}. ${name}`, 204, y, 46, done ? "#2a1a10" : "#6d5a48");
      if (detail) hand(detail, 470, y, 36, "#9a3324");
      if (done) {
        ctx.strokeStyle = "#b8341f";
        ctx.lineWidth = 7;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(140, y - 22);
        ctx.lineTo(158, y - 2);
        ctx.lineTo(196, y - 56);
        ctx.stroke();
      }
    }
    cardTexture.needsUpdate = true;
  }
  function placeCard(view: View) {
    const [x, y, z, yaw] = cardPlaces[view];
    recordCard.position.set(x, y, z);
    recordCard.rotation.set(0, yaw, 0);
  }
  placeCard("shelf");
  const proofRig = new THREE.Group();
  const pinPositions: Partial<Record<View, THREE.Vector2>> = {};
  const wallDepth = -2.4;
  const pinPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -wallDepth);
  let pinDrag: {
    pointerId: number;
    start: THREE.Vector3;
    offset: THREE.Vector3;
  } | null = null;
  scene.add(proofRig);
  proofRig.position.set(4.6, 1.75, wallDepth);
  proofRig.visible = false;
  proofRig.userData = { id: "proof-photo", kind: "proof-photo" };
  targets.push(proofRig);
  const proofFrame = new THREE.Group();
  proofRig.add(proofFrame);
  box(proofFrame, 1.91, 1.49, 0.018, 0, 0, 0, paper, 0.012);
  const pin = new THREE.Group();
  proofRig.add(pin);
  pin.position.set(0.07, 0.675, 0.04);
  cylinder(pin, 0.028, 0.1, 0, 0, 0.035, steel).rotation.x = Math.PI / 2;
  mesh(new THREE.SphereGeometry(0.063, 14, 9), red, pin, 0, 0, 0.098);
  const originalCanvas = document.createElement("canvas");
  originalCanvas.width = imageCanvas.width;
  originalCanvas.height = imageCanvas.height;
  const originalTexture = new THREE.CanvasTexture(originalCanvas);
  originalTexture.colorSpace = THREE.SRGBColorSpace;
  originalTexture.anisotropy = anisotropy;
  textures.push(originalTexture);
  const proofMaterial = new THREE.MeshBasicMaterial({
    map: photoTexture,
    toneMapped: false,
  });
  materials.push(proofMaterial);
  mesh(
    new THREE.PlaneGeometry(1.74, 1.305),
    proofMaterial,
    proofFrame,
    0,
    0,
    0.013,
  );
  let process: {
    progress: number;
    lastAgitate: number;
    timer: number;
    paused: boolean;
    cupOrigin: THREE.Vector3;
  } | null = null;
  let meteredPour: {
    bottle: THREE.Group;
    origin: THREE.Vector3;
    originAngle: number;
    destination: THREE.Vector3;
    angle: number;
    elapsed: number;
    previousDose: number;
    streamEnd: number;
    streamStart: number;
  } | null = null;
  let stagedBottle: THREE.Group | null = null;
  let bottleArrival: { elapsed: number; origin: THREE.Vector3; angle: number } | null = null;
  const capRest = new THREE.Vector3(1.46, 0.697, 1.92);
  function positionBottleCap(bottle: THREE.Group, unthreaded: number, parked: number) {
    const cap = bottle.userData.cap as THREE.Group;
    const neck = bottle.localToWorld(new THREE.Vector3(0, 1.47 + 0.27 * unthreaded, 0));
    const position = neck.clone().lerp(capRest, parked);
    position.y = THREE.MathUtils.lerp(neck.y, capRest.y, THREE.MathUtils.smoothstep(parked, 0.65, 1));
    cap.position.copy(bottle.worldToLocal(position));
    cap.rotation.set(0, Math.PI * 3 * unthreaded, 0);
    cap.quaternion.slerp(bottle.getWorldQuaternion(new THREE.Quaternion()).invert(), parked);
  }
  function aimBottle(bottle: THREE.Group, fraction: number) {
    const angle = THREE.MathUtils.lerp(1.67, 2.24, fraction);
    bottle.rotation.z = angle;
    bottle.position.set(
      cup.position.x + 0.03 + Math.sin(angle) * 1.44,
      1.74 - Math.cos(angle) * 1.44,
      cup.position.z,
    );
  }
  let proofScale = 1;
  let remainingTimer: number | null = null,
    workKey = "";
  let orbit = { yaw: 0, pitch: 0 };
  let orbitDrag: { id: number; x: number; y: number } | null = null;
  const baseCamera = camera.position.clone();
  let processPhase = "idle",
    lifted = 0,
    drying = -1,
    transition = 1;
  // The print's wet journey: it may rest in any tray; the developer tray keeps
  // working while it soaks, stop and fix are timed steps toward drying.
  let printTray = -1,
    printStage: "fresh" | "developing" | "stopped" | "fixed" = "fresh",
    soakTime = 0,
    soaking = false,
    lastRipple = 0,
    note = "",
    noteUntil = 0,
    hangSlot = 0;
  function say(text: string, seconds = 3.2) {
    note = text;
    noteUntil = performance.now() + seconds * 1000;
    setTimeout(wake, seconds * 1000 + 40);
    wake();
  }
  // The cue is the bench talking back: one handwritten line at the bottom and,
  // when something should be touched next, a short note with an arrow on it.
  let previousView: View = "shelf";
  let lastCue = "",
    justApplied = false;
  type StudioCue = { text: string; mark: string; at?: THREE.Vector3 };
  function currentCue(now: number): StudioCue {
    const above = (o: THREE.Object3D, y: number) => o.localToWorld(new THREE.Vector3(0, y, 0));
    const doses = Object.values(state.mix.doses).reduce((a, b) => a + b, 0);
    if (process)
      return {
        text: {
          pour: "倒进去…",
          seal: "盖好盖子，不能见光",
          agitate: "翻过来，再翻回去",
          drain: "倒掉药液",
          settle: "静一静",
          done: "显影完成",
        }[processPhase] || "显影中…",
        mark: "",
      };
    if (manipulation?.object === bathPrint && manipulation.over)
      return { text: "松手，让它泡着", mark: "", at: undefined };
    if (now < noteUntil) return { text: note, mark: "" };
    switch (state.view) {
      case "shelf":
        if (stagedBottle || meteredPour) return { text: "上滑多倒一点，下滑少一点", mark: "" };
        return doses > 0
          ? { text: "还能再加一点，或者去显影台", mark: "调好了", at: above(cup, 0.95) }
          : state.mix.stock === "inherit"
            ? { text: "先挑一卷底片", mark: "选一卷", at: above(baseObjects[1], 1.05) }
            : { text: "再把一瓶药水拖进量杯", mark: "这一瓶？", at: above(bottleObjects[0], 1.6) };
      case "develop":
        return state.mix.development > 0.001
          ? { text: "显影好了，去冲印", mark: "" }
          : { text: "拨好计时表，把量杯拖到罐口", mark: "倒进这里", at: above(tank, 1.75) };
      case "colour":
        if (printTray === 0)
          return state.mix.bath < 0.12
            ? { text: "等一等…", mark: "" }
            : { text: "出来了。夹起来，放进停显盘", mark: "下一盘", at: trayTargets[1].getWorldPosition(new THREE.Vector3()) };
        if (printTray === 1) return { text: "停显中…", mark: "" };
        if (printTray === 2) return { text: printStage === "fixed" ? "定影好了，去晾干" : "定影中…", mark: "" };
        if (printStage === "stopped")
          return { text: "再放进定影盘", mark: "定影", at: trayTargets[2].getWorldPosition(new THREE.Vector3()) };
        if (printStage === "fixed") return { text: "定影好了，去晾干", mark: "" };
        return { text: "夹起相纸，放进显影盘", mark: "放这里", at: trayTargets[0].getWorldPosition(new THREE.Vector3()) };
      case "finish":
        if (justApplied && hungPrints.some(Boolean))
          return { text: "点绳上的相片，换下一张", mark: "嘘，点我", at: hungPrints[(hangSlot - 1) % hangSlots.length]?.getWorldPosition(new THREE.Vector3()) };
        if (drying < 0) return { text: "把相纸挂上绳子", mark: "挂这里", at: ropeAt(0) };
        if (drying < 1) return { text: "晾着…", mark: "" };
        return { text: "干了。满意就应用到照片", mark: "", at: undefined };
    }
  }
  function endSoak() {
    if (!soaking) return;
    soaking = false;
    events.end();
  }
  let manipulation: {
    object: THREE.Group;
    pointerId: number;
    previousX: number;
    previousY: number;
    over: boolean;
    tray: number;
    plane: THREE.Plane;
  } | null = null;
  let state: RoomState = {
    mix: newMix(),
    view: "shelf",
    disabled: false,
    filmReady: false,
    allowed: ["inherit"],
    reduced: false,
    showPhoto: false,
    compare: false,
    frame: "",
    lightsOn: false,
  };
  let disposed = false,
    failed = false,
    raf = 0,
    last = 0,
    zoom = 1,
    dragged: THREE.Group | null = null,
    overCup = false,
    hoverId = "",
    cancelled = false;
  const pointer = new THREE.Vector2(),
    ray = new THREE.Raycaster(),
    tablePlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -1.55),
    intersection = new THREE.Vector3();
  let activeDial: {
    id: DialId;
    angle: number;
    center: { x: number; y: number };
    pointerId: number;
    value: number;
  } | null = null;
  const project = (object: THREE.Object3D, offset = new THREE.Vector3()) => {
    const p = object.localToWorld(offset.clone()).project(camera);
    return {
      x: (p.x * 0.5 + 0.5) * host.clientWidth,
      y: (-0.5 * p.y + 0.5) * host.clientHeight,
    };
  };
  const controls = new DragControls([], camera, canvas);
  controls.transformGroup = true;
  controls.mouseButtons.RIGHT = -1 as THREE.MOUSE;
  controls.mouseButtons.MIDDLE = -1 as THREE.MOUSE;
  function at(event: MouseEvent) {
    const rect = canvas.getBoundingClientRect();
    pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      (-(event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    ray.setFromCamera(pointer, camera);
  }
  function rootOf(object: THREE.Object3D) {
    let o = object;
    while (o.parent && !o.userData.kind) o = o.parent;
    return o as THREE.Group;
  }
  function pick(event: MouseEvent) {
    at(event);
    return ray
      .intersectObjects(targets, true)
      .map((h) => rootOf(h.object))
      .find((o) => {
        let p: THREE.Object3D | null = o;
        while (p) {
          if (!p.visible) return false;
          p = p.parent;
        }
        return !!o.userData.kind;
      });
  }
  const usable = (id: string) =>
    !(id === "grain" || id === "glow") || state.filmReady;
  function showHover(object: THREE.Group | undefined) {
    const onShelf = object?.userData.kind === "bottle" &&
      object.position.distanceTo(object.userData.home) < 0.23;
    const id = state.view === "shelf" && !state.disabled && !stagedBottle && !meteredPour && onShelf
      ? object.userData.id as Serum
      : "";
    if (id !== hoverId) {
      hoverId = id;
      if (id && object) positionBottleNote(object);
      events.hover(id ? { kind: "bottle", id } : null);
      wake();
    }
    canvas.style.cursor = object
      ? object.userData.kind === "bottle" || object === proofRig
        ? "grab"
        : object.userData.kind === "dial"
          ? "ew-resize"
          : "pointer"
      : "default";
  }
  function positionBottleNote(bottle: THREE.Group) {
    const style = host.parentElement?.style;
    if (!style) return;
    const edge = project(bottle, new THREE.Vector3(0.34, -0.1, 0.35));
    const right = edge.x + 192 < host.clientWidth;
    const leftEdge = right ? edge.x : project(bottle, new THREE.Vector3(-0.34, 0, 0.35)).x;
    style.setProperty("--bottle-note-x", `${Math.max(12, leftEdge + (right ? 10 : -184))}px`);
    style.setProperty("--bottle-note-y", `${host.offsetTop + edge.y}px`);
    style.setProperty("--bottle-note-shift", right ? "-8px" : "8px");
  }
  function positionDialArc(object: THREE.Group) {
    const style = host.parentElement?.style;
    if (!style) return;
    const center = project(object, new THREE.Vector3(0, 0, 0.142));
    const edge = project(object, new THREE.Vector3(object.userData.radius, 0, 0.142));
    const top = project(object, new THREE.Vector3(0, object.userData.radius, 0.142));
    style.setProperty("--dial-arc-x", `${center.x}px`);
    style.setProperty("--dial-arc-y", `${host.offsetTop + center.y}px`);
    style.setProperty("--dial-arc-width", `${Math.hypot(edge.x - center.x, edge.y - center.y) * 3.2}px`);
    style.setProperty("--dial-arc-height", `${Math.hypot(top.x - center.x, top.y - center.y) * 3.2}px`);
    style.setProperty("--dial-arc-angle", `${Math.atan2(edge.y - center.y, edge.x - center.x)}rad`);
  }
  function wake() {
    if (!disposed && !failed && !raf && !document.hidden)
      raf = requestAnimationFrame(draw);
  }
  function draw(now: number) {
    raf = 0;
    if (disposed || failed) return;
    const dt = Math.min(0.2, (now - last) / 1000 || 0.016);
    last = now;
    let moving = false;
    if (state.reduced) {
      camera.position.copy(cameraGoal);
      look.copy(lookGoal);
    } else {
      camera.position.lerp(cameraGoal, 0.1);
      look.lerp(lookGoal, 0.1);
    }
    camera.lookAt(look);
    camera.updateMatrixWorld(true);
    const visibleDial = dialObjects.find((dial) => dial.userData.id === dialByView[state.view]);
    if (visibleDial) positionDialArc(visibleDial);
    moving =
      camera.position.distanceTo(cameraGoal) > 0.002 ||
      look.distanceTo(lookGoal) > 0.002;
    transition = Math.min(1, transition + dt * 3.4);
    host.style.setProperty("--scene-opacity", String(0.35 + 0.65 * transition));
    moving ||= transition < 1;
    if (process) {
      if (!process.paused) {
        const previous = process.progress;
        process.progress = Math.min(
          1,
          process.progress + dt / developmentSeconds(process.timer),
        );
        const choreography = processTimeline(process.progress);
        processPhase = choreography.phase;
        controls.enabled = false;
        const returningCup = process.progress >= 0.24;
        const cupTravel = returningCup ? 1 - choreography.cupReturn : choreography.cupTravel;
        const cupOrigin = returningCup ? developCup.userData.home : process.cupOrigin;
        const safeLift = cupOrigin.clone().setY(cupClearance);
        const cupAngle = -1.24 * choreography.cupTip;
        if (cupTravel < 0.42) {
          developCup.position.copy(cupOrigin).lerp(safeLift, cupTravel / 0.42);
        } else {
          const rimOffset = developLip.clone().applyAxisAngle(cupRotationAxis, cupAngle);
          developCup.position.copy(safeLift).lerp(
            pourPivot.clone().sub(rimOffset),
            (cupTravel - 0.42) / 0.58,
          );
        }
        developCup.rotation.z = cupAngle;
        // Inversion agitation: lift, turn the sealed tank fully over around
        // its middle and set it back, four times across the agitate phase.
        const home = tank.userData.home as THREE.Vector3;
        if (choreography.phase === "agitate") {
          const cycle = ((process.progress - 0.3) / 0.48) * 4,
            turn = 0.5 - 0.5 * Math.cos(cycle * Math.PI * 2),
            lift = Math.sin(turn * Math.PI) * 0.5 + 0.3 * Math.min(1, cycle * 3, (4 - cycle) * 3);
          tank.rotation.set(-turn * Math.PI, 0, Math.sin(cycle * Math.PI * 2) * 0.12);
          const middle = home.clone().add(new THREE.Vector3(0, 0.74 + lift, 0));
          tank.position.copy(middle).sub(new THREE.Vector3(0, 0.74, 0).applyEuler(tank.rotation));
        } else {
          tank.rotation.x *= 0.8;
          tank.rotation.z *= 0.8;
          tank.position.lerp(home, 0.15);
        }
        const delta = choreography.agitate - process.lastAgitate;
        process.lastAgitate = choreography.agitate;
        if (delta > 0) {
          events.develop(previous, process.progress, process.timer);
          events.action("agitation", delta * 0.1);
        }
        remainingTimer = process.timer * (1 - process.progress);
        processStream.visible = choreography.transfer > 0 && choreography.transfer < 1;
        if (processStream.visible) {
          placeJet(
            processStream,
            developCup.localToWorld(developLip.clone()),
            tank.localToWorld(new THREE.Vector3(-0.14, 1.43, 0)),
            0.75 + 0.25 * Math.sin(Math.PI * choreography.transfer),
          );
        }
        const draining = choreography.drain > 0 && choreography.drain < 1;
        drainStream.visible = draining;
        if (draining) {
          tank.rotation.z = -0.7 * Math.sin(choreography.drain * Math.PI);
          const start = tank.localToWorld(new THREE.Vector3(0.52, 1.46, 0)),
            end = new THREE.Vector3(3.2, 0.84, -0.2);
          drainStream.position.copy(start).lerp(end, 0.5);
          drainStream.scale.y = start.distanceTo(end);
          drainStream.quaternion.setFromUnitVectors(
            new THREE.Vector3(0, 1, 0),
            start.sub(end).normalize(),
          );
        }
        placeLid(choreography.lidOpen);
        if (process.progress >= 1) {
          process = null;
          processStream.visible = drainStream.visible = false;
          tank.rotation.set(0, 0, 0);
          tank.position.copy(tank.userData.home);
          placeLid(0);
          controls.enabled = !state.disabled;
          events.end();
          say("显影完成 · 去调色台冲印 →", 4);
        }
        moving = true;
      }
    } else if (dragged !== developCup) {
      placeLid(0);
      developCup.position.lerp(
        developCup.userData.home,
        state.reduced ? 1 : 0.16,
      );
      developCup.rotation.z *= 0.84;
      moving ||=
        developCup.position.distanceTo(developCup.userData.home) > 0.004 ||
        Math.abs(developCup.rotation.z) > 0.004;
    }
    const holdingPrint = manipulation?.object === bathPrint;
    if (holdingPrint && manipulation!.over && !state.disabled) {
      events.action("bath", dt * 0.095 * (0.65 + state.mix.warmth));
      bathPrint.position.y = 0.9 + Math.sin(now * 0.005) * 0.015;
      moving = true;
    }
    if (holdingPrint && manipulation!.tray >= 0 && now - lastRipple > 380) {
      lastRipple = now;
      ripple(manipulation!.tray, bathPrint.position, 0.7);
    }
    if (!manipulation && printTray >= 0) {
      // Resting in a bath: the sheet sways under the surface while the
      // chemistry works; a gentle rock of the tray sends small ripples.
      soakTime += dt;
      bathPrint.position.y = 0.83 + Math.sin(now * 0.0021) * 0.006;
      bathPrint.rotation.z = Math.sin(now * 0.0013) * 0.02;
      if (now - lastRipple > 1300) {
        lastRipple = now;
        ripple(printTray, bathPrint.position.clone().add(new THREE.Vector3(0.6, 0, 0.4)), 0.45);
      }
      if (printTray === 0 && !state.disabled) {
        events.action("bath", dt * 0.06 * (0.65 + state.mix.warmth));
        if (printStage === "fresh") printStage = "developing";
      } else if (printTray === 1 && soakTime > 1.6 && printStage === "developing") {
        printStage = "stopped";
        say("停显完成 · 放进定影盘");
      } else if (printTray === 2 && soakTime > 2.6 && printStage !== "fixed" && printStage !== "fresh") {
        printStage = "fixed";
        say("定影完成 · 去成品台晾干 →", 4);
      }
      moving = true;
    }
    // The tongs follow the sheet: they grip its near corner whenever the
    // print is being carried or rests in a bath, otherwise they lie by the tray.
    const gripping = state.view === "colour"
      ? holdingPrint ? Math.max(0, manipulation!.tray) : printTray
      : -1;
    for (const [i, pair] of trayTongs.entries()) {
      if (i === gripping) {
        const yaw = -0.62;
        const pitch = holdingPrint ? -0.52 : -0.34;
        pair.quaternion.slerp(new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, "YXZ")), 0.3);
        const tip = bathPrint.localToWorld(new THREE.Vector3(0.62, -0.58, 0.02));
        pair.position.copy(tip).sub(new THREE.Vector3(0, 0, -0.68).applyQuaternion(pair.quaternion));
      } else {
        pair.position.lerp(pair.userData.home, 0.18);
        pair.quaternion.slerp(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, pair.userData.yaw, 0)), 0.18);
        moving ||= pair.position.distanceTo(pair.userData.home) > 0.004;
      }
    }
    if (state.view === "colour") moving = waveWater(now) || moving;
    latentMaterial.opacity = Math.min(1, Math.pow(state.mix.bath * 2.4, 0.85));
    if (!manipulation && lifted > 0) {
      lifted = Math.max(0, lifted - dt * 0.6);
      bathPrint.position.lerp(bathPrint.userData.home, 0.08);
      bathPrint.rotation.x = THREE.MathUtils.lerp(
        bathPrint.rotation.x,
        -Math.PI / 2,
        0.07,
      );
      moving = true;
    }
    for (const [i, drop] of droplets.entries()) {
      drop.visible = lifted > 0 && i < Math.ceil(lifted * 12);
      if (drop.visible) {
        drop.position
          .copy(bathPrint.position)
          .add(
            new THREE.Vector3(
              ((i % 4) - 0.5) * 0.28,
              -((now * 0.0018 + i * 0.14) % 1) * 0.7,
              0.45,
            ),
          );
        drop.scale.set(0.7, 1.5, 0.7);
      }
    }
    if (drying >= 0 && !manipulation) {
      const wasWet = drying < 1;
      drying = Math.min(1, drying + dt * 0.6);
      dryPrint.position.lerp(hanger.position, 0.12);
      dryPrint.rotation.x = THREE.MathUtils.lerp(dryPrint.rotation.x, 0, 0.12);
      // A freshly pegged print swings like a pendulum and settles as it dries.
      dryPrint.rotation.z = Math.sin(now * 0.0042) * 0.07 * (1 - drying) ** 1.5;
      dryPrint.rotation.y = Math.sin(now * 0.0023) * 0.05 * (1 - drying);
      for (const clip of clips) clip.rotation.x = 0.25 * (1 - drying);
      sheenMaterial.opacity = 0.17 * (1 - drying);
      if (wasWet && drying >= 1) say("晾干了 · 满意就点「应用到照片」", 5);
      moving ||=
        drying < 1 || dryPrint.position.distanceTo(hanger.position) > 0.005;
    }
    for (const hung of hungPrints) {
      hung.rotation.z = Math.sin(now * 0.0011 + hung.position.x) * 0.012;
    }
    let pouringBottle: THREE.Group | undefined;
    let capLift = 0;
    if (stagedBottle) {
      if (bottleArrival) {
        bottleArrival.elapsed += dt * (state.reduced ? 1.45 : 1);
        const { elapsed, origin, angle } = bottleArrival;
        const unscrew = THREE.MathUtils.smoothstep(elapsed, 0, 0.32);
        const park = THREE.MathUtils.smoothstep(elapsed, 0.32, 0.58);
        const tilt = THREE.MathUtils.smoothstep(elapsed, 0.58, 0.92);
        aimBottle(stagedBottle, 0);
        stagedBottle.position.lerp(origin, 1 - tilt);
        stagedBottle.rotation.z = THREE.MathUtils.lerp(angle, stagedBottle.rotation.z, tilt);
        positionBottleCap(stagedBottle, unscrew, park);
        capLift = 0.27 * unscrew;
        if (elapsed >= 0.92) {
          bottleArrival = null;
          events.measure({ id: stagedBottle.userData.id as Serum, atCup: true });
        }
        moving = true;
      } else {
        positionBottleCap(stagedBottle, 1, 1);
        capLift = 0.27;
      }
    }
    if (meteredPour) {
      meteredPour.elapsed += dt;
      const { bottle, elapsed, streamStart, streamEnd } = meteredPour;
      const approach = streamStart === 0 ? 1 : THREE.MathUtils.smoothstep(elapsed, 0, streamStart - 0.16);
      const leave = THREE.MathUtils.smoothstep(
        elapsed,
        streamEnd + 0.55,
        streamEnd + 0.94,
      );
      bottle.position
        .copy(meteredPour.origin)
        .lerp(
          meteredPour.destination,
          approach,
        )
        .lerp(bottle.userData.home, leave);
      bottle.rotation.z = THREE.MathUtils.lerp(
        meteredPour.originAngle,
        meteredPour.angle,
        approach,
      ) * (1 - leave);
      const unscrew = streamStart === 0 ? 1 : THREE.MathUtils.smoothstep(elapsed, 0.04, streamStart - 0.21);
      const recap = THREE.MathUtils.smoothstep(elapsed, streamEnd + 0.26, streamEnd + 0.55);
      const park = (streamStart === 0 ? 1 : THREE.MathUtils.smoothstep(elapsed, streamStart - 0.21, streamStart)) -
        THREE.MathUtils.smoothstep(elapsed, streamEnd, streamEnd + 0.26);
      capLift = 0.27 * (unscrew - recap);
      positionBottleCap(bottle, unscrew - recap, park);
      if (elapsed >= streamStart && elapsed < streamEnd) pouringBottle = bottle;
      if (elapsed >= streamEnd + 0.94) {
        meteredPour = null;
        say("倒好了 · 还可以再加，或去显影台 →");
      }
      moving = true;
    }
    const visibleDoses = { ...state.mix.doses };
    if (meteredPour) {
      const id = meteredPour.bottle.userData.id as Serum;
      const delivered = THREE.MathUtils.smoothstep(
        meteredPour.elapsed,
        meteredPour.streamStart,
        meteredPour.streamEnd,
      );
      visibleDoses[id] = THREE.MathUtils.lerp(
        meteredPour.previousDose,
        visibleDoses[id],
        delivered,
      );
    }
    let hoverLift = 0;
    for (const bottle of bottleObjects) {
      const home = bottle.userData.home as THREE.Vector3;
      if (bottle !== dragged && bottle !== stagedBottle && bottle !== meteredPour?.bottle) {
        const hovered = hoverId === bottle.userData.id;
        const rest = hovered ? home.clone().add(new THREE.Vector3(0, 0.15, 0.1)) : home;
        bottle.position.lerp(rest, state.reduced ? 1 : 0.16);
        if (hovered) {
          hoverLift = bottle.position.y - home.y;
          positionBottleNote(bottle);
        }
        bottle.rotation.z = THREE.MathUtils.lerp(
          bottle.rotation.z,
          0,
          state.reduced ? 1 : 0.16,
        );
        moving ||=
          bottle.position.distanceTo(rest) > 0.005 ||
          Math.abs(bottle.rotation.z) > 0.005;
      }
      const dose = visibleDoses[bottle.userData.id as Serum];
      const liquid = bottle.userData.liquid as THREE.Mesh;
      liquid.scale.y = 1 - dose * 0.65;
      liquid.position.y = 0.06 + 0.4 * (1 - dose * 0.65);
      if (bottle !== stagedBottle && bottle !== meteredPour?.bottle) {
        const cap = bottle.userData.cap as THREE.Group;
        cap.rotation.set(0, 0, 0);
        cap.position.set(0, 1.47, 0);
      }
    }
    stream.visible = !!pouringBottle;
    if (pouringBottle) {
      const mouth = pouringBottle.localToWorld(new THREE.Vector3(0, 1.44, 0));
      const end = cup.localToWorld(
        new THREE.Vector3(0, meniscus.position.y, 0),
      );
      placeJet(stream, mouth, end, 0.85 + Math.sin(now * 0.031) * 0.14);
    }
    const total = Object.values(visibleDoses).reduce((a, b) => a + b, 0),
      colour = new THREE.Color("#c9b894").multiplyScalar(0.3);
    for (const s of SERUMS)
      colour.add(new THREE.Color(s.color).multiplyScalar(visibleDoses[s.id]));
    colour.multiplyScalar(1 / (0.3 + total));
    mixtureMaterial.color.copy(colour);
    jetMaterial.color.copy(colour).lerp(new THREE.Color("#fff6d9"), 0.35);
    jetMaterial.emissive.copy(jetMaterial.color);
    saucer.material = overCup || stagedBottle ? brass : materialForSaucer;
    const liquidHeight = 0.08 + Math.min(1, total / 2.4) * 0.64;
    mixture.scale.y = liquidHeight / 0.12;
    mixture.position.y = 0.09 + liquidHeight / 2;
    meniscus.position.y = 0.09 + liquidHeight;
    const cupRemaining = process
      ? 1 - processTimeline(process.progress).transfer
      : processPhase === "done" ? 0 : 1;
    const developHeight = liquidHeight * cupRemaining;
    developLiquid.visible = developSurface.visible = developHeight > 0.005;
    developLiquid.scale.y = developHeight / 0.12;
    developLiquid.position.y = 0.09 + developHeight / 2;
    developSurface.position.y = 0.09 + developHeight;
    for (const [id, hand] of hands)
      hand.rotation.z =
        -(
          (id === "timer" && remainingTimer !== null
            ? remainingTimer
            : state.mix[id as "timer" | "warmth" | "concentration"]) - 0.5
        ) *
        Math.PI *
        1.5;
    // The chosen roll is drawn forward off the shelf and turned to face you.
    for (const g of baseObjects) {
      const chosen = g.userData.id === state.mix.stock;
      const rest = (g.userData.home as THREE.Vector3).clone().add(
        chosen ? new THREE.Vector3(0, 0.06, 0.42) : new THREE.Vector3(),
      );
      g.position.lerp(rest, state.reduced ? 1 : 0.14);
      g.rotation.y = THREE.MathUtils.lerp(g.rotation.y, chosen ? -0.35 : 0, state.reduced ? 1 : 0.14);
      moving ||= g.position.distanceTo(rest) > 0.003;
    }
    const positions: Record<string, { x: number; y: number }> = {
      cup: project(cup, new THREE.Vector3(0, 0.7, 0)),
    };
    for (const o of [
      ...bottleObjects,
      ...baseObjects,
      ...dialObjects,
      developCup,
      tank,
      bathPrint,
      dryPrint,
    ])
      positions[(o.userData.kind === "base" ? "base:" : "") + o.userData.id] =
        project(
          o,
          new THREE.Vector3(
            0,
            ["bottle", "tank", "process-cup"].includes(o.userData.kind)
              ? 0.65
              : o.userData.kind === "base"
                ? 0.4
                : 0,
            0.17,
          ),
        );
    host.dataset.targets = JSON.stringify(positions);
    host.dataset.renderer = "ready";
    host.dataset.dragging = dragged?.userData.id || "";
    host.dataset.pouring = String(!!pouringBottle);
    host.dataset.capLift = String(capLift);
    host.dataset.bottleLift = hoverLift.toFixed(3);
    host.dataset.developPouring = String(processStream.visible);
    host.dataset.developLid = tankLid.position.y.toFixed(3);
    host.dataset.overCup = String(overCup);
    host.dataset.doseTilt = stagedBottle?.rotation.z.toFixed(3) || "";
    if (stagedBottle) positionDoseControls();
    positions["tank-mouth"] = project(tank, new THREE.Vector3(0, 1.6, 0));
    positions.bath = project(bathTarget);
    positions.hanger = project(hanger);
    host.dataset.targets = JSON.stringify(positions);
    proofRig.visible = state.showPhoto;
    host.dataset.pinPosition = JSON.stringify(proofRig.position.toArray());
    host.dataset.proofScale = proofScale.toFixed(3);
    positions["proof-photo"] = project(proofRig);
    host.dataset.targets = JSON.stringify(positions);
    proofMaterial.map = state.compare ? originalTexture : photoTexture;
    host.dataset.photoVisible = String(state.showPhoto);
    host.dataset.orbit = JSON.stringify(orbit);
    host.dataset.timerRemaining = String(remainingTimer ?? state.mix.timer);
    const work = {
      running: !!process,
      paused: process?.paused || false,
      phase: processPhase,
      progress:
        Math.round(
          (process?.progress ?? (processPhase === "done" ? 1 : 0)) * 100,
        ) / 100,
    };
    const nextWorkKey = JSON.stringify(work);
    if (nextWorkKey !== workKey) {
      workKey = nextWorkKey;
      events.work(work);
    }
    host.dataset.process = processPhase;
    host.dataset.processProgress = String(
      process?.progress ?? (processPhase === "done" ? 1 : 0),
    );
    host.dataset.bath = String(
      !!manipulation?.over && manipulation?.object === bathPrint,
    );
    host.dataset.drying = String(drying);
    host.dataset.visibleSets = Object.entries(sets)
      .filter(([, g]) => g.visible)
      .map(([id]) => id)
      .join(",");
    const cue = currentCue(now);
    host.dataset.processLabel = cue.text;
    const cueKey = cue.text + "|" + cue.mark;
    if (cueKey !== lastCue) {
      lastCue = cueKey;
      events.cue({ text: cue.text, mark: cue.mark });
    }
    const cueStyle = host.parentElement?.style;
    if (cueStyle && cue.at) {
      const p = cue.at.clone().project(camera);
      cueStyle.setProperty("--cue-x", `${(p.x * 0.5 + 0.5) * host.clientWidth}px`);
      cueStyle.setProperty("--cue-y", `${host.offsetTop + (-0.5 * p.y + 0.5) * host.clientHeight}px`);
    }
    host.dataset.printStage = printStage;
    host.dataset.view = state.view;
    drawCard();
    composer.render(dt);
    if (
      moving ||
      dragged ||
      activeDial ||
      manipulation ||
      (process && !process.paused) ||
      orbitDrag
    )
      wake();
  }
  function setOrbitCamera() {
    const spherical = new THREE.Spherical().setFromVector3(
      baseCamera.clone().sub(lookGoal),
    );
    spherical.theta += orbit.yaw;
    spherical.phi += orbit.pitch;
    cameraGoal
      .copy(lookGoal)
      .add(new THREE.Vector3().setFromSpherical(spherical));
  }
  function startDevelopment() {
    if (process || state.disabled || state.view !== "develop") return;
    cancel(false);
    events.begin();
    process = {
      progress: 0,
      lastAgitate: 0,
      timer: state.mix.timer,
      paused: false,
      cupOrigin: developCup.position.clone(),
    };
    remainingTimer = state.mix.timer;
    processPhase = "pour";
    placeLid(0);
    controls.enabled = false;
    last = performance.now();
    wake();
  }
  const dragStart = (event: { object: THREE.Object3D }) => {
    if (state.disabled) return;
    dragged = event.object as THREE.Group;
    cancelled = false;
    overCup = false;
    events.begin();
    events.hover(null);
    hoverId = "";
    canvas.style.cursor = "grabbing";
    wake();
  };
  const dragMove = () => {
    if (!dragged) return;
    ray.setFromCamera(pointer, camera);
    if (dragged === developCup) {
      overCup = ray.intersectObject(tankTarget, false).length > 0;
      if (overCup) {
        developCup.position.set(-0.86, 1.3, 0.45);
      } else if (ray.ray.intersectPlane(tablePlane, intersection)) {
        developCup.position.set(
          clamp(intersection.x, -2.2, -0.85),
          1.3,
          clamp(intersection.z, -1.25, 0.45),
        );
      }
      wake();
      return;
    }
    overCup = ray.intersectObject(receiver, false).length > 0;
    if (overCup) {
      dragged.position.set(cup.position.x + 0.65, 1.76, cup.position.z);
      dragged.rotation.z = 0;
    } else if (ray.ray.intersectPlane(tablePlane, intersection)) {
      dragged.position.set(
        clamp(intersection.x, -5, 5),
        1.4,
        clamp(intersection.z, -2.2, 3),
      );
      dragged.rotation.z = 0.08;
    }
    wake();
  };
  let releasedOverCup = false;
  function positionDoseControls() {
    const style = host.parentElement?.style;
    if (!style) return;
    const cupMark = project(cup, new THREE.Vector3(0, 0.5, 0));
    const bottleMark = project(cup, new THREE.Vector3(1.73, 1.65, 0));
    style.setProperty("--dose-cup-x", `${cupMark.x}px`);
    style.setProperty("--dose-cup-y", `${host.offsetTop + cupMark.y}px`);
    style.setProperty("--dose-bottle-x", `${bottleMark.x}px`);
    style.setProperty("--dose-bottle-y", `${host.offsetTop + bottleMark.y}px`);
  }
  const dragEnd = () => {
    if (!dragged) return;
    const startProcess = dragged === developCup && overCup && !cancelled;
    if (!cancelled && releasedOverCup && dragged.userData.kind === "bottle") {
      stagedBottle = dragged;
      bottleArrival = { elapsed: 0, origin: dragged.position.clone(), angle: dragged.rotation.z };
      last = performance.now();
    }
    releasedOverCup = false;
    dragged = null;
    overCup = false;
    events.end(cancelled);
    if (startProcess) startDevelopment();
    cancelled = false;
    controls.objects = [];
    wake();
  };
  controls.addEventListener("dragstart", dragStart);
  controls.addEventListener("drag", dragMove);
  controls.addEventListener("dragend", dragEnd);
  const move = (event: PointerEvent) => {
    at(event);
    if (orbitDrag) {
      orbit = orbitView(
        orbit,
        event.clientX - orbitDrag.x,
        event.clientY - orbitDrag.y,
      );
      orbitDrag.x = event.clientX;
      orbitDrag.y = event.clientY;
      setOrbitCamera();
      wake();
      return;
    }
    if (pinDrag) {
      if (ray.ray.intersectPlane(pinPlane, intersection)) {
        intersection.add(pinDrag.offset);
        proofRig.position.set(
          clamp(intersection.x, -6, 6),
          clamp(intersection.y, 1.3, 2.9),
          wallDepth + 0.17,
        );
      }
      wake();
      return;
    }
    if (manipulation) {
      const m = manipulation,
        dx = event.clientX - m.previousX,
        dy = event.clientY - m.previousY;
      m.previousX = event.clientX;
      m.previousY = event.clientY;
      if (m.object === tank) {
        tank.rotation.z = clamp(tank.rotation.z + dx * 0.007, -0.48, 0.48);
        tank.rotation.x = clamp(tank.rotation.x + dy * 0.005, -0.25, 0.25);
        events.action("agitation", Math.min(0.04, Math.hypot(dx, dy) / 900));
      } else {
        if (ray.ray.intersectPlane(m.plane, intersection))
          m.object.position.copy(intersection);
        if (m.object === bathPrint) {
          m.tray = trayTargets.findIndex((t) => ray.intersectObject(t, false).length > 0);
          m.over = m.tray === 0;
          if (m.tray >= 0) {
            bathPrint.position.set(trayCenters[m.tray], 0.9, 0.29);
            bathPrint.rotation.x = -Math.PI / 2;
          } else bathPrint.rotation.x = -0.55;
        } else {
          const h = project(hanger),
            r = canvas.getBoundingClientRect();
          m.over =
            Math.hypot(
              event.clientX - r.left - h.x,
              event.clientY - r.top - h.y,
            ) < 100;
          m.object.rotation.x = -0.15;
        }
      }
      wake();
      return;
    }
    if (activeDial) {
      const angle =
        (Math.atan2(
          event.clientX - activeDial.center.x,
          activeDial.center.y - event.clientY,
        ) *
          180) /
        Math.PI;
      activeDial.value = dragDial(activeDial.value, activeDial.angle, angle);
      events.dial(activeDial.id, activeDial.value);
      activeDial.angle = angle;
      wake();
      return;
    }
    if (dragged) return;
    const object = pick(event);
    controls.objects =
      !state.disabled &&
      !stagedBottle &&
      (object?.userData.kind === "bottle" ||
        object?.userData.kind === "process-cup") &&
      usable(object.userData.id)
        ? [object]
        : [];
    showHover(object);
  };
  const down = (event: PointerEvent) => {
    if (event.button === 1) {
      event.preventDefault();
      event.stopImmediatePropagation();
      orbitDrag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      controls.objects = [];
      controls.enabled = false;
      canvas.setPointerCapture(event.pointerId);
      canvas.style.cursor = "grabbing";
      wake();
      return;
    }
    if (state.disabled || process || stagedBottle || meteredPour || event.button !== 0) {
      controls.objects = [];
      return;
    }
    const object = pick(event);
    if (!object) {
      controls.objects = [];
      return;
    }
    if (object === proofRig && ray.ray.intersectPlane(pinPlane, intersection)) {
      controls.objects = [];
      pinDrag = {
        pointerId: event.pointerId,
        start: proofRig.position.clone(),
        offset: proofRig.position.clone().sub(intersection),
      };
      proofRig.position.z = wallDepth + 0.17;
      proofFrame.rotation.z = -0.035;
      pin.visible = false;
      canvas.setPointerCapture(event.pointerId);
      canvas.style.cursor = "grabbing";
      wake();
      return;
    }
    if (object.userData.kind === "hung-print") {
      controls.objects = [];
      events.next();
      return;
    }
    if (["tank", "bath-paper", "dry-paper"].includes(object.userData.kind)) {
      controls.objects = [];
      const normal = camera.getWorldDirection(new THREE.Vector3());
      if (object === bathPrint) {
        // Lifting the sheet out of a bath closes that soak as one undo step.
        endSoak();
        if (printTray >= 0) ripple(printTray, bathPrint.position, 1.4);
        printTray = -1;
        bathPrint.rotation.z = 0;
      }
      manipulation = {
        object,
        pointerId: event.pointerId,
        previousX: event.clientX,
        previousY: event.clientY,
        over: false,
        tray: -1,
        plane: new THREE.Plane().setFromNormalAndCoplanarPoint(
          normal,
          object.position,
        ),
      };
      if (object === dryPrint) drying = -1;
      canvas.setPointerCapture(event.pointerId);
      events.begin();
      hoverId = "";
      events.hover(null);
      wake();
      return;
    }
    if (object.userData.kind === "base") {
      controls.objects = [];
      if (state.allowed.includes(object.userData.id)) {
        events.begin();
        events.base(object.userData.id);
        events.end();
      }
      return;
    }
    if (object.userData.kind === "dial") {
      if (object.userData.id === "timer") remainingTimer = null;
      controls.objects = [];
      const local = project(object),
        rect = canvas.getBoundingClientRect(),
        center = { x: local.x + rect.left, y: local.y + rect.top };
      activeDial = {
        id: object.userData.id,
        angle:
          (Math.atan2(event.clientX - center.x, center.y - event.clientY) *
            180) /
          Math.PI,
        center,
        pointerId: event.pointerId,
        value:
          state.mix[object.userData.id as "timer" | "warmth" | "concentration"],
      };
      canvas.setPointerCapture(event.pointerId);
      events.begin();
      hoverId = "";
      positionDialArc(object);
      events.hover({ kind: "dial", id: activeDial.id });
      wake();
      return;
    }
    controls.objects = usable(object.userData.id) ? [object] : [];
  };
  function releasePin(rollback: boolean) {
    if (!pinDrag) return;
    const { pointerId, start } = pinDrag;
    pinDrag = null;
    if (rollback) proofRig.position.copy(start);
    proofRig.position.z = wallDepth;
    proofFrame.rotation.z = 0;
    pin.visible = true;
    pinPositions[state.view] = new THREE.Vector2(
      proofRig.position.x,
      proofRig.position.y,
    );
    if (canvas.hasPointerCapture(pointerId))
      canvas.releasePointerCapture(pointerId);
    canvas.style.cursor = "grab";
    wake();
  }
  const up = (event: PointerEvent) => {
    if (event.button === 0 && dragged?.userData.kind === "bottle") {
      at(event);
      releasedOverCup = ray.intersectObject(receiver, false).length > 0;
    }
    if (pinDrag) {
      releasePin(false);
      return;
    }
    if (orbitDrag) {
      const id = orbitDrag.id;
      orbitDrag = null;
      if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
      controls.enabled = !state.disabled && !process;
      canvas.style.cursor = "default";
      wake();
      return;
    }
    if (manipulation) {
      const m = manipulation;
      manipulation = null;
      let keepGesture = false;
      if (m.object === bathPrint) {
        if (m.tray >= 0 && !state.disabled) {
          // Set it down in the bath; the developer keeps working until the
          // sheet is lifted again, which ends this gesture.
          printTray = m.tray;
          soakTime = 0;
          bathPrint.position.set(trayCenters[m.tray] - 0.04, 0.83, 0.3);
          bathPrint.rotation.set(-Math.PI / 2, 0, 0);
          ripple(m.tray, bathPrint.position, 1.8);
          keepGesture = soaking = m.tray === 0;
          if (m.tray === 0) say(printStage === "fresh" ? "等一等，影像正在浮现…" : "继续显影…", 3.5);
          if (m.tray === 1 && printStage === "fresh") say("还没显影 · 先放进显影盘");
          if (m.tray === 2 && printStage === "developing") say("先停显，再定影");
        } else lifted = 1;
      }
      if (m.object === dryPrint && m.over) drying = 0;
      if (m.object === tank) {
        tank.rotation.set(0, 0, 0);
      }
      if (canvas.hasPointerCapture(m.pointerId))
        canvas.releasePointerCapture(m.pointerId);
      if (!keepGesture) events.end();
      wake();
    }
    if (activeDial) {
      const id = activeDial.pointerId;
      activeDial = null;
      events.hover(null);
      if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
      events.end();
      wake();
    }
  };
  function cancelStaging() {
    if (!stagedBottle) return false;
    stagedBottle = null;
    bottleArrival = null;
    events.measure(null);
    wake();
    return true;
  }
  const cancel = (rollback = true) => {
    releasePin(rollback);
    cancelStaging();
    if (hoverId) {
      hoverId = "";
      events.hover(null);
    }
    if (meteredPour) {
      const bottle = meteredPour.bottle;
      bottle.position.copy(bottle.userData.home);
      bottle.rotation.z = 0;
    }
    meteredPour = null;
    stream.visible = false;
    if (orbitDrag) {
      const id = orbitDrag.id;
      orbitDrag = null;
      if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
      controls.enabled = !state.disabled && !process;
    }
    if (process) {
      process = null;
      processPhase = "idle";
      remainingTimer = null;
      processStream.visible = drainStream.visible = false;
      tank.rotation.set(0, 0, 0);
      tank.position.y = 0.62;
      placeLid(0);
      developCup.position.copy(developCup.userData.home);
      developCup.rotation.z = 0;
      controls.enabled = !state.disabled;
      events.end(rollback);
    }
    if (manipulation) {
      const m = manipulation;
      manipulation = null;
      m.object.position.copy(m.object.userData.home);
      m.object.rotation.set(m.object === tank ? 0 : -Math.PI / 2, 0, 0);
      if (canvas.hasPointerCapture(m.pointerId))
        canvas.releasePointerCapture(m.pointerId);
      events.end(rollback);
    }
    if (printTray >= 0) {
      // Leaving the bench keeps what the soak already did: lift the sheet out.
      endSoak();
      printTray = -1;
      lifted = 1;
    }
    if (activeDial) {
      const pointerId = activeDial.pointerId;
      activeDial = null;
      events.hover(null);
      if (canvas.hasPointerCapture(pointerId))
        canvas.releasePointerCapture(pointerId);
      events.end(rollback);
    }
    if (dragged) {
      cancelled = true;
      canvas.dispatchEvent(new PointerEvent("pointerleave"));
    }
    wake();
  };
  const leave = () => {
    if (!dragged && !activeDial) {
      hoverId = "";
      events.hover(null);
      wake();
    }
  };
  const cancelEvent = () => cancel(true);
  const lostCapture = () => {
    if (orbitDrag || manipulation || activeDial || pinDrag) cancel(true);
  };
  const auxClick = (e: MouseEvent) => {
    if (e.button === 1) e.preventDefault();
  };
  const lost = (event: Event) => {
    event.preventDefault();
    cancel();
    failed = true;
    cancelAnimationFrame(raf);
    raf = 0;
    events.error();
  };
  const visibility = () => {
    if (document.hidden) {
      cancel();
      cancelAnimationFrame(raf);
      raf = 0;
    } else {
      last = 0;
      wake();
    }
  };
  const wheel = (event: WheelEvent) => {
    event.preventDefault();
    if (state.disabled) return;
    if (state.showPhoto && (pinDrag || pick(event) === proofRig)) {
      proofScale = clamp(proofScale * Math.exp(-event.deltaY * 0.0015), 0.65, 2.5);
      proofFrame.scale.set(proofScale, proofScale, 1);
      pin.position.set(0.07 * proofScale, 0.675 * proofScale, 0.04);
      wake();
      return;
    }
    zoom = clamp(zoom * Math.exp(-event.deltaY * 0.0005), 0.8, 1.35);
    camera.zoom = zoom;
    camera.updateProjectionMatrix();
    wake();
  };
  canvas.addEventListener("pointermove", move, true);
  canvas.addEventListener("pointerdown", down, true);
  canvas.addEventListener("pointerup", up, true);
  canvas.addEventListener("pointercancel", cancelEvent);
  canvas.addEventListener("lostpointercapture", lostCapture);
  canvas.addEventListener("auxclick", auxClick);
  canvas.addEventListener("pointerleave", leave);
  canvas.addEventListener("webglcontextlost", lost);
  canvas.addEventListener("wheel", wheel, { passive: false });
  document.addEventListener("visibilitychange", visibility);
  function resize() {
    const w = host.clientWidth,
      h = host.clientHeight;
    if (!w || !h) return;
    const deviceRatio = window.devicePixelRatio || 1;
    // VRAM tiers may cap supersampling, but a 4K display still needs one
    // rendered pixel per device pixel, including under Windows DPI scaling.
    const ratio = previewPixelRatio(
      { ...graphics, maxRatio: Math.max(deviceRatio, graphics.maxRatio) },
      w, h, Math.max(1.25, deviceRatio), maxBufferSize,
    );
    renderer.setDrawingBufferSize(w, h, ratio);
    // Composer starts at pixel ratio 1. Pass the actual backing size so the
    // scene, bloom and output buffers match without an intermediate resize.
    const samples = graphics.antialias && canvas.width * canvas.height <= 4_000_000
      ? Math.min(2, renderer.capabilities.maxSamples) : 0;
    if (composerTarget.samples !== samples) {
      for (const target of [composer.renderTarget1, composer.renderTarget2]) {
        target.dispose();
        target.samples = samples;
      }
    }
    composer.setSize(canvas.width, canvas.height);
    camera.aspect = w / Math.max(1, h);
    camera.fov = THREE.MathUtils.radToDeg(
      2 *
        Math.atan(
          Math.tan(THREE.MathUtils.degToRad(31 / 2)) *
            Math.max(1, 1.48 / camera.aspect),
        ),
    );
    camera.updateProjectionMatrix();
    wake();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  window.addEventListener("resize", resize);
  resize();
  return {
    cancel,
    cancelStaging,
    start: startDevelopment,
    meter(fraction) {
      if (stagedBottle) {
        aimBottle(stagedBottle, fraction);
        wake();
      }
    },
    pour({ id, ml }, previousDose) {
      const bottle = bottleObjects.find((bottle) => bottle.userData.id === id);
      const wasStaged = bottle === stagedBottle;
      stagedBottle = null;
      if (!bottle || state.view !== "shelf") return;
      const streamStart = wasStaged ? 0 : state.reduced ? 0.5 : 0.72;
      meteredPour = {
        bottle,
        origin: bottle.position.clone(),
        originAngle: bottle.rotation.z,
        destination: wasStaged
          ? bottle.position.clone()
          : new THREE.Vector3(cup.position.x + 1.23, 2.27, cup.position.z),
        angle: wasStaged ? bottle.rotation.z : 2.08,
        elapsed: 0,
        previousDose,
        streamStart,
        streamEnd: streamStart + 0.62 + ml * 0.009,
      };
      last = performance.now();
      wake();
    },
    applied() {
      hangCopy();
      drying = -1;
      dryPrint.position.copy(dryPrint.userData.home);
      dryPrint.rotation.set(-Math.PI / 2, 0, 0);
      sheenMaterial.opacity = 0.16;
      printStage = "fresh";
      justApplied = true;
      say("收好了，挂在绳上", 2.5);
    },
    pause() {
      if (process) {
        process.paused = !process.paused;
        last = performance.now();
        wake();
      }
    },
    proof(image, original = false) {
      const target = original ? originalCanvas : imageCanvas,
        ctx = target.getContext("2d")!;
      const w =
          image instanceof HTMLImageElement ? image.naturalWidth : image.width,
        h =
          image instanceof HTMLImageElement
            ? image.naturalHeight
            : image.height;
      if (!w || !h) return;
      ctx.imageSmoothingQuality = "high";
      ctx.fillStyle = "#e4d8c1";
      ctx.fillRect(0, 0, target.width, target.height);
      const fit = Math.min(target.width / w, target.height / h);
      ctx.drawImage(
        image,
        (target.width - w * fit) / 2,
        (target.height - h * fit) / 2,
        w * fit,
        h * fit,
      );
      (original ? originalTexture : photoTexture).needsUpdate = true;
      if (!original)
        host.dataset.proofQuality =
          image instanceof HTMLImageElement ? "exact" : "live";
      wake();
    },
    update(next) {
      const changed = state.view !== next.view;
      if (state.disabled && !next.disabled) cancelStaging();
      if (
        (next.disabled && !state.disabled && !stagedBottle) ||
        changed ||
        (!next.showPhoto && pinDrag)
      )
        cancel(true);
      if (next.frame !== state.frame) {
        // A new frame starts with fresh paper on every bench.
        printStage = "fresh";
        justApplied = false;
        drying = -1;
        lifted = 0;
        dryPrint.position.copy(dryPrint.userData.home);
        dryPrint.rotation.set(-Math.PI / 2, 0, 0);
        bathPrint.position.copy(bathPrint.userData.home);
        bathPrint.rotation.set(-Math.PI / 2, 0, 0);
        sheenMaterial.opacity = 0.16;
      }
      state = next;
      if (next.mix.bath === 0 && printTray < 0) printStage = "fresh";
      controls.enabled = !next.disabled && !process && !orbitDrag;
      if (next.lightsOn !== lightsOn) {
        lightsOn = next.lightsOn;
        lightRoom(next.view);
      }
      if (changed) {
        const order = VIEWS.map((v) => v.id);
        const slide = Math.sign(order.indexOf(next.view) - order.indexOf(previousView)) * 3.2;
        previousView = next.view;
        for (const [id, g] of Object.entries(sets))
          g.visible = id === next.view;
        transition = 0;
        lightRoom(next.view);
        placeCard(next.view);
        const pinPosition = pinPositions[next.view];
        proofRig.position.set(pinPosition?.x ?? 4.6, pinPosition?.y ?? 1.75, wallDepth);
        const station = roomLooks[next.view];
        orbit = { yaw: 0, pitch: 0 };
        baseCamera.set(station.eye[0], station.eye[1], station.eye[2]);
        cameraGoal.copy(baseCamera);
        lookGoal.set(station.focus[0], station.focus[1], station.focus[2]);
        if (!next.reduced) {
          // Walk along the bench to the next station instead of cutting.
          camera.position.copy(cameraGoal).add(new THREE.Vector3(-slide, 0.4, 0));
          look.copy(lookGoal).add(new THREE.Vector3(-slide, 0, 0));
        }
        hoverId = "";
        events.hover(null);
      }
      wake();
    },
    reset() {
      orbit = { yaw: 0, pitch: 0 };
      setOrbitCamera();
      zoom = 1;
      camera.zoom = 1;
      camera.updateProjectionMatrix();
      wake();
    },
    dispose() {
      if (disposed) return;
      cancel();
      disposed = true;
      controls.dispose();
      observer.disconnect();
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", visibility);
      canvas.removeEventListener("pointermove", move, true);
      canvas.removeEventListener("pointerdown", down, true);
      canvas.removeEventListener("pointerup", up, true);
      canvas.removeEventListener("pointercancel", cancelEvent);
      canvas.removeEventListener("lostpointercapture", lostCapture);
      canvas.removeEventListener("auxclick", auxClick);
      canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("webglcontextlost", lost);
      canvas.removeEventListener("wheel", wheel);
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      for (const t of textures) t.dispose();
      env.dispose();
      bloom.dispose();
      composer.dispose();
      composerTarget.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      host.dataset.renderer = "disposed";
    },
  };
}

const doseParameters = [
  { key: "temperature", label: "冷暖", neutral: 0 },
  { key: "tint", label: "色偏", neutral: 0 },
  { key: "contrast", label: "对比度", neutral: 1 },
  { key: "saturation", label: "饱和度", neutral: 1 },
  { key: "blacks", label: "黑位", neutral: 0 },
  { key: "shadows", label: "阴影", neutral: 0 },
  { key: "highlights", label: "高光", neutral: 0 },
  { key: "film_grain", label: "颗粒", neutral: 0 },
  { key: "film_halation", label: "光晕", neutral: 0 },
] as const;

function dialPoint(value: number, radius: number) {
  const angle = (value - 0.5) * Math.PI * 1.5;
  return { x: Math.sin(angle) * radius, y: -Math.cos(angle) * radius };
}

function DialArc({ id, value, active }: { id: DialId; value: number; active: boolean }) {
  const radius = 58;
  const start = dialPoint(0, radius);
  const end = dialPoint(1, radius);
  const marker = dialPoint(value, radius);
  const track = `M ${start.x} ${start.y} A ${radius} ${radius} 0 1 1 ${end.x} ${end.y}`;
  const label = { timer: "显影计时刻度", warmth: "色温刻度", concentration: "浓度刻度" }[id];
  const labels = id === "timer" ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1];
  return (
    <div className={`cl-dial-arc ${active ? "is-active" : ""}`} role={active ? "tooltip" : undefined} aria-label={active ? label : undefined} aria-hidden={!active}>
      <svg viewBox="-80 -80 160 160" preserveAspectRatio="none" aria-hidden="true">
        <path className="cl-dial-track" d={track} />
        {active && <path className="cl-dial-progress" d={track} pathLength={100} strokeDasharray={`${value * 100} 100`} />}
        {Array.from({ length: 25 }, (_, index) => {
          const major = index % 4 === 0;
          const from = dialPoint(index / 24, major ? 51 : 54);
          const to = dialPoint(index / 24, radius);
          return <line key={index} x1={from.x} y1={from.y} x2={to.x} y2={to.y} className={major ? "is-major" : ""} />;
        })}
        {labels.map((position) => {
          const point = dialPoint(position, 70);
          const relative = (position - 0.5) * 100;
          const text = id === "timer" ? `${developmentSeconds(position)}s`
            : id === "concentration" ? `${position * 100}%`
            : relative < 0 ? `−${-relative}` : relative > 0 ? `+${relative}` : "0";
          return <text key={position} x={point.x} y={point.y} textAnchor="middle" dominantBaseline="central">{text}</text>;
        })}
        {active && <circle className="cl-dial-marker" cx={marker.x} cy={marker.y} r={2.8} />}
      </svg>
    </div>
  );
}

function DoseControls({
  id,
  atCup,
  mix,
  base,
  onClose,
  onMeasure,
  onConfirm,
  fallback,
}: {
  id: Serum;
  atCup?: boolean;
  mix: CreativeMix;
  base: Recipe;
  onClose: () => void;
  onMeasure: (fraction: number) => void;
  onConfirm: (ml: number) => void;
  fallback: boolean;
}) {
  const ingredient = SERUMS.find((serum) => serum.id === id)!;
  const used = Object.values(mix.doses).reduce((sum, dose) => sum + dose, 0);
  const max = Math.max(
    0,
    Math.floor(Math.min(1 - mix.doses[id], 2.4 - used) * 100 + 1e-6),
  );
  const [amount, setAmount] = useState(0);
  const gesture = useRef<{ id: number; y: number; ml: number } | null>(null);
  const ml = Math.round(clamp(finite(amount, 0), 0, max));
  const updateAmount = (value: number) => {
    setAmount(value);
    onMeasure(max > 0 ? value / max : 0);
  };
  const pointerAmount = (clientY: number, start: { y: number; ml: number }) =>
    clamp(Math.round(start.ml + ((start.y - clientY) * max) / 100), 0, max);
  const cancelGesture = (event: React.PointerEvent) => {
    const start = gesture.current;
    if (start?.id !== event.pointerId) return;
    gesture.current = null;
    updateAmount(start.ml);
  };
  const before = creativeRecipe(base, mix);
  const after = creativeRecipe(base, addDose(mix, id, ml / 100));
  const parameters = doseParameters.flatMap(({ key, label, neutral }) => {
    const start = Number(before[key] ?? neutral);
    const end = Number(after[key] ?? neutral);
    return Math.abs(end - start) > 1e-6 ? [{ key, label, start, end }] : [];
  });
  const number = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 3 });
  return (
    <div
      className={`cl-dose-ui ${atCup ? "is-at-cup" : ""}`}
      role="group"
      aria-label={`${ingredient.name} · 倾倒用量`}
    >
      <div className="cl-dose-readout">
        <span className="cl-dose-ingredient">{ingredient.name}</span>
        <div className="cl-dose-volume" aria-live="polite">
          <span>增量</span><strong>+{number.format(ml)} mL</strong>
          <span>总量</span><strong>{number.format(used * 100 + ml)} / 240 mL</strong>
        </div>
        <div className="cl-dose-result" aria-label="对应参数">
          {parameters.map(({ key, label, start, end }) => (
            <div key={key}>
              <span>{label}</span>
              <span>{number.format(start)} → <strong>{number.format(end)}</strong></span>
            </div>
          ))}
          {max === 0 && <span>当前容量已满</span>}
        </div>
      </div>
      <div
        className="cl-dose-controls"
        onPointerDown={(event) => {
          if (
            event.button !== 0 || !max || gesture.current ||
            (event.target as Element).closest(".cl-dose-cancel")
          ) return;
          event.preventDefault();
          gesture.current = { id: event.pointerId, y: event.clientY, ml };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const start = gesture.current;
          if (start?.id === event.pointerId)
            updateAmount(pointerAmount(event.clientY, start));
        }}
        onPointerUp={(event) => {
          const start = gesture.current;
          if (start?.id !== event.pointerId) return;
          gesture.current = null;
          const measured = pointerAmount(event.clientY, start);
          updateAmount(measured);
          if (measured > 0) onConfirm(measured);
        }}
        onPointerCancel={cancelGesture}
        onLostPointerCapture={cancelGesture}
      >
        <button
          className="cl-dose-pour"
          type="button"
          aria-label={fallback ? "加入量杯" : "按住滑动定量，松开倾倒"}
          title="上滑加量，下滑减量，松开倾倒"
          disabled={max === 0}
          onClick={(event) => {
            if (event.detail === 0 && ml > 0) onConfirm(ml);
          }}
        >
          <Pipette size={19} />
        </button>
        <input
          aria-label="用量毫升"
          aria-orientation="vertical"
          aria-valuetext={`${ml} 毫升`}
          title="上滑加量，下滑减量，松开倾倒"
          type="range"
          min={0}
          max={Math.max(1, max)}
          step={1}
          value={ml}
          disabled={max === 0}
          onChange={(event) => updateAmount(event.target.valueAsNumber)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && ml > 0) onConfirm(ml);
          }}
          autoFocus
        />
        <button className="cl-dose-cancel" type="button" aria-label="取消倾倒" title="取消倾倒" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
    </div>
  );
}

// Typewriter reveal for captions and hints: the full sentence stays in the
// accessibility tree while the visible copy is struck one character at a time.
function Typed({ text, className = "", speed = 46 }: { text: string; className?: string; speed?: number }) {
  const chars = Array.from(text);
  const [shown, setShown] = useState(chars.length);
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(chars.length);
      return;
    }
    setShown(0);
    let n = 0;
    const timer = window.setInterval(() => {
      n += 1;
      setShown(n);
      if (n >= chars.length) window.clearInterval(timer);
    }, speed);
    return () => window.clearInterval(timer);
  }, [text]);
  return (
    <span className={`cl-typed ${className}`} data-done={shown >= chars.length}>
      <span className="cl-sr">{text}</span>
      <span aria-hidden="true">
        {chars.slice(0, shown).join("")}
        <i className="cl-caret" />
      </span>
    </span>
  );
}

function RecipePreview({
  photo,
  base,
  compare,
  onFrame,
  onOriginal,
}: {
  onFrame: (image: ProofImage) => void;
  onOriginal: (image: HTMLImageElement) => void;
  photo: Photo;
  base: Recipe;
  compare: boolean;
}) {
  const [exact, setExact] = useState<{
      id: number;
      key: string;
      url: string;
    } | null>(null),
    [error, setError] = useState("");
  const key = liveRecipeKey(photo.recipe),
    session = useRef(crypto.randomUUID()),
    generation = useRef(0),
    held = useRef("");
  const precise = useRef({ id: 0, key: "" });
  const frameCallback = useRef(onFrame);
  const previewSize = Math.max(1280, currentPreviewGraphics().liveSize * 1.5);
  frameCallback.current = onFrame;
  useEffect(() => {
    const controller = new AbortController(),
      request = ++generation.current;
    setError("");
    const timer = setTimeout(() => {
      void draftBlob(photo, controller.signal, session.current, studioProofWidth)
        .then(async (blob) => {
          const url = URL.createObjectURL(blob),
            image = new Image();
          image.src = url;
          try {
            await image.decode();
            if (controller.signal.aborted || request !== generation.current) {
              URL.revokeObjectURL(url);
              return;
            }
            const old = held.current;
            held.current = url;
            precise.current = { id: photo.id, key };
            setExact({ id: photo.id, key, url });
            frameCallback.current(image);
            if (old) URL.revokeObjectURL(old);
          } catch {
            URL.revokeObjectURL(url);
          }
        })
        .catch((reason) => {
          if (!controller.signal.aborted)
            setError(String(reason.message || reason));
        });
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [photo.id, key]);
  useEffect(
    () => () => {
      if (held.current) URL.revokeObjectURL(held.current);
    },
    [],
  );
  const committed = { ...photo, recipe: base, committed_recipe: base };
  return (
    <div
      className={`cl-image ${compare ? "is-comparing" : ""}`}
      aria-label="暗房成像预览"
      onLoadCapture={(e) => {
        const img = e.target;
        if (img instanceof HTMLImageElement && img.closest(".picture"))
          onOriginal(img);
      }}
    >
      <Picture photo={committed} quality="source" size={studioProofWidth} eager />
      {exact?.id === photo.id && (
        <img className="cl-exact" src={exact.url} alt="调配效果" />
      )}
      {!photo.recipe.film_advanced && !base.film_advanced &&
        <LivePreview
          photo={{ ...photo, committed_recipe: base }}
          sourceSize={previewSize}
          exact={exact?.id === photo.id ? exact.key : ""}
          onFrame={(canvas) => {
            if (precise.current.id !== photo.id || precise.current.key !== key)
              frameCallback.current(canvas);
          }}
        />
      }
      {error && (
        <span className="cl-preview-error" role="status">
          精细预览暂不可用，实时调整仍保留。<small>{error.slice(0, 70)}</small>
        </span>
      )}
      <span className="cl-preview-state">
        {compare ? "原有调整" : exact?.key === key ? "精细成像" : "实时成像"}
      </span>
    </div>
  );
}
type Draft = { photo: number; base: string; mix: CreativeMix };
function readDraft(photo: Photo | undefined): CreativeMix {
  try {
    if (!photo) return newMix();
    const all = JSON.parse(
      localStorage.getItem("photoall-creative-drafts") || "[]",
    ) as Draft[];
    const found = all.find(
      (d) =>
        d.photo === photo.id &&
        d.base === signature(photo.committed_recipe || photo.recipe),
    );
    return found ? restoreMix(found.mix) : newMix();
  } catch {
    return newMix();
  }
}
type Preset = { name: string; mix: CreativeMix };
export function WetLab({
  rolls,
  revisions,
  stocks,
  onBack,
  onApply,
}: {
  rolls: DarkroomRoll[];
  revisions: Record<number, number>;
  stocks: Library["film"]["stocks"];
  onBack: () => void;
  onApply: (id: number, patch: Recipe) => Promise<void>;
}) {
  const available = rolls.filter((r) => r.photos.length),
    [rollId, setRollId] = useState(() => {
      try {
        const id = Number(localStorage.getItem("photoall-creative-roll"));
        if (available.some((r) => r.album.id === id)) return id;
      } catch {}
      return available[0]?.album.id || 0;
    });
  const roll = available.find((r) => r.album.id === rollId) || available[0],
    [photoId, setPhotoId] = useState(() => {
      try {
        const id = Number(localStorage.getItem("photoall-creative-photo"));
        if (roll?.photos.some((p) => p.id === id)) return id;
      } catch {}
      return roll?.photos[0]?.id || 0;
    });
  const current = roll?.photos.find((p) => p.id === photoId) || roll?.photos[0];
  const [base, setBase] = useState<Recipe>(
      current ? { ...(current.committed_recipe || current.recipe) } : {},
    ),
    [mix, setMix] = useState(() => readDraft(current));
  const [settledPhoto, setSettledPhoto] = useState(current?.id || 0);
  const shell = useRef<HTMLElement>(null),
    headerRef = useRef<HTMLElement>(null);
  const [showPhoto, setShowPhoto] = useState(
    () => localStorage.getItem("photoall-creative-show-photo") === "true",
  );
  const [work, setWork] = useState<Work>(IDLE_WORK);
  const [lightsOn, setLightsOn] = useState(false);
  const [cue, setCue] = useState({ text: "", mark: "" });
  const [doseRequest, setDoseRequest] = useState<DoseRequest | null>(null);
  useEffect(() => {
    if (!headerRef.current || !shell.current) return;
    const resize = () =>
      shell.current?.style.setProperty(
        "--cl-top",
        `${headerRef.current!.getBoundingClientRect().height}px`,
      );
    const observer = new ResizeObserver(resize);
    observer.observe(headerRef.current);
    resize();
    return () => observer.disconnect();
  }, []);
  const [view, setView] = useState<View>("shelf"),
    [hover, setHover] = useState<Hover>(null),
    [saving, setSaving] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState(false),
    [retry, setRetry] = useState(0),
    [compare, setCompare] = useState(false),
    [history, setHistory] = useState<CreativeMix[]>([]),
    [recipeName, setRecipeName] = useState("");
  const [presets, setPresets] = useState<Preset[]>(() => {
    try {
      return (
        JSON.parse(
          localStorage.getItem("photoall-creative-presets") || "[]",
        ) as Preset[]
      )
        .slice(0, 24)
        .filter((p) => typeof p.name === "string")
        .map((p) => ({ name: p.name.slice(0, 40), mix: restoreMix(p.mix) }));
    } catch {
      return [];
    }
  });
  const [reduced, setReduced] = useState(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const host = useRef<HTMLDivElement>(null),
    room = useRef<Studio | null>(null),
    latest = useRef(mix),
    gesture = useRef<CreativeMix | null>(null),
    savingRef = useRef(false),
    eventsRef = useRef<RoomEvents | null>(null);
  latest.current = mix;
  savingRef.current = saving;
  const readyBases = BASES.filter(
      (b) => b.id === "inherit" || stocks[b.id]?.ready,
    ),
    effectiveStock =
      mix.stock === "inherit" ? filmStock(base) : mix.stock,
    filmReady = (mix.stock === "inherit" && !!spectralRecipe(base))
      || (effectiveStock !== "none" && !!stocks[effectiveStock]?.ready);
  const recipe = creativeRecipe(base, mix),
    patch = creativePatch(base, mix),
    changed = Object.keys(patch).length > 0,
    total = Object.values(mix.doses).reduce((a, b) => a + b, 0);
  const begin = () => {
    if (!savingRef.current && !gesture.current)
      gesture.current = structuredClone(latest.current);
  };
  const end = (cancelled = false) => {
    const start = gesture.current;
    gesture.current = null;
    if (!start) return;
    if (cancelled) {
      latest.current = start;
      setMix(start);
    } else if (!equalMix(start, latest.current))
      setHistory((h) => [...h, start].slice(-40));
  };
  const change = (next: CreativeMix, remember = true) => {
    if (savingRef.current || (remember && work.running)) return;
    const previous = latest.current;
    if (remember && !equalMix(next, previous))
      setHistory((h) => [...h, previous].slice(-40));
    latest.current = next;
    setMix(next);
    setMessage("");
  };
  function dispense({ id, ml }: MeasuredDose) {
    if (
      savingRef.current ||
      work.running ||
      ((id === "grain" || id === "glow") && !filmReady)
    )
      return;
    const current = latest.current;
    const next = addDose(current, id, ml / 100);
    if (Math.abs(next.doses[id] - current.doses[id] - ml / 100) > 1e-7) {
      setDoseRequest({ id });
      return;
    }
    change(next);
    room.current?.pour({ id, ml }, current.doses[id]);
  }
  eventsRef.current = {
    hover: setHover,
    begin,
    end,
    measure: setDoseRequest,
    dial: (id, value) => change({ ...latest.current, [id]: value }, false),
    action: (id, n) => change(processAction(latest.current, id, n), false),
    develop: (from, to, timer) =>
      change(developmentStep(latest.current, from, to, timer), false),
    work: setWork,
    base: (id) => {
      if (readyBases.some((b) => b.id === id))
        change({ ...latest.current, stock: id }, false);
    },
    error: () => setError(true),
    cue: setCue,
    next: () => {
      if (!roll || savingRef.current || work.running) return;
      const index = roll.photos.findIndex((p) => p.id === current?.id);
      setPhotoId(roll.photos[(index + 1) % roll.photos.length].id);
    },
  };
  useEffect(() => {
    let studio: Studio | null = null;
    setError(false);
    if (!host.current) return;
    const call = (key: keyof RoomEvents, ...args: any[]) =>
      (eventsRef.current?.[key] as (...args: any[]) => void)?.(...args);
    try {
      studio = makeStudio(host.current, {
        hover: (v) => call("hover", v),
        begin: () => call("begin"),
        end: (c) => call("end", c),
        measure: (request) => call("measure", request),
        dial: (id, n) => call("dial", id, n),
        base: (id) => call("base", id),
        action: (id, n) => call("action", id, n),
        develop: (from, to, timer) => call("develop", from, to, timer),
        work: (v) => call("work", v),
        error: () => call("error"),
        next: () => call("next"),
        cue: (value) => call("cue", value),
      });
      room.current = studio;
    } catch {
      setError(true);
    }
    return () => {
      studio?.dispose();
      room.current = null;
    };
  }, [retry]);
  useEffect(() => {
    room.current?.update({
      mix,
      view,
      disabled: saving || doseRequest !== null,
      filmReady,
      allowed: readyBases.map((b) => b.id),
      reduced,
      showPhoto,
      compare,
      frame: current
        ? `${String(roll!.photos.findIndex((p) => p.id === current.id) + 1).padStart(2, "0")} · ${current.name}`
        : "",
      lightsOn,
    });
  }, [
    mix,
    view,
    saving,
    doseRequest,
    filmReady,
    stocks,
    retry,
    reduced,
    showPhoto,
    compare,
    current?.id,
    lightsOn,
  ]);
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)"),
      fn = () => setReduced(media.matches);
    media.addEventListener("change", fn);
    return () => media.removeEventListener("change", fn);
  }, []);
  useEffect(() => {
    if (!current) return;
    room.current?.cancel(true);
    end(true);
    setBase({ ...(current.committed_recipe || current.recipe) });
    const next = readDraft(current);
    latest.current = next;
    setMix(next);
    setHistory([]);
    setMessage("");
    setHover(null);
    setSettledPhoto(current.id);
    setDoseRequest(null);
  }, [current?.id]);
  useEffect(() => {
    if (!current || settledPhoto !== current.id) return;
    try {
      const old = JSON.parse(
        localStorage.getItem("photoall-creative-drafts") || "[]",
      ) as Draft[];
      const next = [
        { photo: current.id, base: signature(base), mix },
        ...old.filter((d) => d.photo !== current.id),
      ].slice(0, 24);
      localStorage.setItem("photoall-creative-drafts", JSON.stringify(next));
      localStorage.setItem("photoall-creative-roll", String(rollId));
      localStorage.setItem("photoall-creative-photo", String(current.id));
    } catch {}
  }, [mix, base, current?.id, rollId, settledPhoto]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (doseRequest) {
        if (e.key === "Escape") {
          e.preventDefault();
          setDoseRequest(null);
        }
        return;
      }
      if ((e.target as HTMLElement).closest("input,textarea,select")) return;
      if (e.key === "Escape" && room.current?.cancelStaging()) {
        e.preventDefault();
        return;
      }
      if (e.key === "Escape" && gesture.current) {
        room.current?.cancel();
        end(true);
        return;
      }
      if (e.key === "Escape" && !savingRef.current) onBack();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onBack, history, doseRequest]);
  function undo() {
    if (savingRef.current) return;
    if (work.running) {
      room.current?.cancel(true);
      end(true);
      return;
    }
    if (history.length) {
      room.current?.cancel(false);
      const next = history[history.length - 1];
      latest.current = next;
      setMix(next);
      setHistory(history.slice(0, -1));
    }
  }
  async function apply() {
    if (!current || saving || work.running || !changed) return;
    room.current?.cancel(false);
    end(false);
    const frozen = creativeRecipe(base, latest.current),
      delta = creativePatch(base, latest.current);
    setSaving(true);
    setMessage("");
    try {
      await onApply(current.id, delta);
      setBase(frozen);
      latest.current = newMix();
      setMix(newMix());
      setHistory([]);
      setMessage("调配已写入照片，可在编辑器中继续调整或撤销。");
      room.current?.applied();
    } catch (reason) {
      setMessage(
        `保存失败：${reason instanceof Error ? reason.message : String(reason)}`,
      );
    } finally {
      setSaving(false);
    }
  }
  function savePreset() {
    const name = recipeName.trim() || `我的配方 ${presets.length + 1}`,
      next = [
        { name: name.slice(0, 40), mix: structuredClone(mix) },
        ...presets.filter((p) => p.name !== name),
      ].slice(0, 24);
    try {
      localStorage.setItem("photoall-creative-presets", JSON.stringify(next));
      setPresets(next);
      setRecipeName("");
      setMessage("配方已收藏，可用于其他照片。");
    } catch {
      setMessage("本机配方空间不足，请清理后重试。");
    }
  }
  const bottleHint = hover?.kind === "bottle"
    ? SERUMS.find((serum) => serum.id === hover.id)
    : null;
  const arcId = dialByView[view];
  const sceneInfo = VIEWS.find((v) => v.id === view)!;
  return (
    <section
      ref={shell}
      className="darkroom creative-lab"
      role="region"
      aria-label="创作暗房"
      data-view={view}
      data-photo={current?.id || 0}
      data-mix={JSON.stringify(mix)}
    >
      <div className="cl-scene" ref={host} />
      <div className="cl-vignette" aria-hidden="true" />
      <div className="cl-grain" aria-hidden="true" />
      <header className="cl-header" ref={headerRef} inert={doseRequest !== null}>
        <button className="cl-back" aria-label="观片暗房" disabled={saving || work.running} onClick={onBack}>
          <ArrowLeft size={13} />
          <span lang="en">viewing room</span>
        </button>
        <div className="cl-title">
          <Typed key={view} className="cl-scene-title" text={`SCENE 0${VIEWS.findIndex((v) => v.id === view) + 1} — ${sceneInfo.english}`} />
          <span className="cl-scene-line">{sceneInfo.line}</span>
        </div>
          <nav aria-label="创作暗房场景">
            {VIEWS.map((v, i) => (
              <button
                key={v.id}
                disabled={saving || work.running}
                aria-pressed={view === v.id}
                onClick={() => {
                  room.current?.cancel(true);
                  end(true);
                  setView(v.id);
                }}
              >
                <small aria-hidden="true">0{i + 1}</small>
                {v.name}
              </button>
            ))}
          </nav>
        <span className="cl-counter" aria-hidden="true">
          {roll
            ? `FRAME ${String(roll.photos.findIndex((p) => p.id === current?.id) + 1).padStart(2, "0")} OF ${String(roll.photos.length).padStart(2, "0")}`
            : "NO ROLL"}
        </span>
        <button className="cl-icon" aria-label="重置创作镜头" onClick={() => room.current?.reset()}>
          <RotateCcw size={13} />
        </button>
      </header>
      <footer className="cl-dock" inert={doseRequest !== null}>
        <div className="cl-dock-left">
          <div className="cl-photo-nav">
            <button
              aria-label="上一张调配照片"
              disabled={
                saving ||
                !roll ||
                roll.photos.findIndex((p) => p.id === current?.id) <= 0
              }
              onClick={() =>
                setPhotoId(
                  roll!.photos[
                    roll!.photos.findIndex((p) => p.id === current?.id) - 1
                  ].id,
                )
              }
            >
              <ChevronLeft size={17} />
            </button>
            <span>{current?.name || "尚无照片"}</span>
            <button
              aria-label="下一张调配照片"
              disabled={
                saving ||
                !roll ||
                roll.photos.findIndex((p) => p.id === current?.id) >=
                  roll.photos.length - 1
              }
              onClick={() =>
                setPhotoId(
                  roll!.photos[
                    roll!.photos.findIndex((p) => p.id === current?.id) + 1
                  ].id,
                )
              }
            >
              <ChevronRight size={17} />
            </button>
          </div>
          <label className="cl-roll">
            <span>胶卷</span>
            <select
              aria-label="选择调配图集"
              value={roll?.album.id || 0}
              disabled={saving || work.running}
              onChange={(e) => {
                end(true);
                setRollId(Number(e.target.value));
                setPhotoId(0);
              }}
            >
              {available.length ? (
                available.map((r) => (
                  <option key={r.album.id} value={r.album.id}>
                    {r.album.name}
                  </option>
                ))
              ) : (
                <option value={0}>尚无图集</option>
              )}
            </select>
          </label>
        </div>
          <div className="cl-run-controls">
            {!work.running ? (
              <button
                className="cl-start"
                aria-label="开始显影"
                disabled={saving || view !== "develop" || !current || error}
                onClick={() => room.current?.start()}
              >
                <Play size={12} />
                <span>开始显影</span>
              </button>
            ) : (
              <>
                <button
                  aria-label={work.paused ? "继续显影" : "暂停显影"}
                  onClick={() => room.current?.pause()}
                >
                  {work.paused ? <Play size={14} /> : <Pause size={14} />}
                  <span>{work.paused ? "继续" : "暂停"}</span>
                </button>
                <button
                  aria-label="取消显影"
                  onClick={() => room.current?.cancel(true)}
                >
                  <Square size={11} />
                  <span>停止</span>
                </button>
              </>
            )}
            <span className="cl-work-label" role="status">
              {work.running
                ? work.paused
                  ? "已暂停"
                  : {
                      pour: "倒入配液",
                      seal: "封闭遮光盖",
                      agitate: "摇罐显影",
                      drain: "排出药液",
                      settle: "静置收尾",
                    }[work.phase] || "显影中"
                : work.phase === "done"
                  ? "显影完成"
                  : view === "develop"
                    ? "先设时间，再开始"
                    : ""}
            </span>
            {work.running && (
              <progress aria-label="显影进度" value={work.progress} max={1} />
            )}
          </div>
        <div className="cl-links">
          <button
            aria-label="场景照片显示"
            aria-pressed={showPhoto}
            onClick={() =>
              setShowPhoto((v) => {
                try {
                  localStorage.setItem(
                    "photoall-creative-show-photo",
                    String(!v),
                  );
                } catch {}
                return !v;
              })
            }
          >
            {showPhoto ? <Eye size={12} /> : <EyeOff size={12} />}
            <span>照片</span>
          </button>
          <button
            aria-label="对比原有调整"
            disabled={!current}
            aria-pressed={compare}
            onClick={() => setCompare((v) => !v)}
          >
            <span>对比</span>
          </button>
          <button
            aria-label="看片灯"
            aria-pressed={lightsOn}
            onClick={() => setLightsOn((v) => !v)}
          >
            <span>{lightsOn ? "红灯" : "白光"}</span>
          </button>
          <details className="cl-formula-menu">
            <summary>配方</summary>
            <div>
              {" "}
              <div className="cl-formula">
                <span>
                  {BASES.find((b) => b.id === mix.stock)?.name || "原有底色"}
                </span>
                <div className="cl-mixture-bar" aria-label="当前药水配比">
                  {SERUMS.map(
                    (s) =>
                      mix.doses[s.id] > 0 && (
                        <i
                          key={s.id}
                          title={s.name}
                          style={{ background: s.color, flex: mix.doses[s.id] }}
                        />
                      ),
                  )}
                </div>
                {total > 0 ? (
                  <div className="cl-ingredients">
                    {SERUMS.filter((s) => mix.doses[s.id] > 0).map((s) => (
                      <button
                        key={s.id}
                        disabled={saving || work.running}
                        title={`移除${s.name}`}
                        onClick={() =>
                          change({ ...mix, doses: { ...mix.doses, [s.id]: 0 } })
                        }
                      >
                        <i style={{ background: s.color }} />
                        {s.name}
                        <X size={10} />
                      </button>
                    ))}
                  </div>
                ) : (
                  <small>从台上挑一瓶喜欢的颜色</small>
                )}
              </div>
            </div>
          </details>
          <details className="cl-presets">
            <summary>
              <span>收藏</span> <Save size={11} />
            </summary>
            <div className="cl-menu-panel">
              <div>
                <input
                  aria-label="暗房配方名称"
                  placeholder="给这次调配起个名字"
                  maxLength={40}
                  value={recipeName}
                  onChange={(e) => setRecipeName(e.target.value)}
                />
                <button disabled={saving || work.running} onClick={savePreset}>
                  收藏
                </button>
              </div>
              {presets.map((p, i) => (
                <button
                  key={p.name + i}
                  disabled={saving || work.running}
                  onClick={() => change(restoreMix(p.mix))}
                >
                  {p.name}
                  <ArrowRight size={12} />
                </button>
              ))}
            </div>
          </details>
          <button
            aria-label="撤销暗房调配"
            disabled={!history.length || saving || work.running}
            onClick={undo}
          >
            <Undo2 size={12} />
            <span>撤销</span>
          </button>
          <button
            aria-label="重新调配"
            disabled={saving || work.running || equalMix(mix, newMix())}
            onClick={() => change(newMix())}
          >
            <span>重来</span>
          </button>
          <button
            className="cl-apply"
            disabled={!changed || saving || work.running}
            onClick={() => void apply()}
          >
            {saving ? (
              "正在保存…"
            ) : (
              <>
                <Check size={13} />
                应用到照片
              </>
            )}
          </button>
        </div>
      </footer>
      <p className="cl-hint" role="status">
        <Typed key={cue.text || sceneInfo.hint} text={cue.text || sceneInfo.hint} speed={70} />
      </p>
      {cue.mark && !error && (
        <div className="cl-cue" key={cue.mark} aria-hidden="true">
          <svg viewBox="0 0 120 70">
            <path d="M112 8 C 86 10, 52 22, 14 58" />
            <path d="M14 58 L 30 54 M14 58 L 18 42" />
          </svg>
          <span>{cue.mark}</span>
        </div>
      )}
      {!error && arcId && <DialArc id={arcId} value={mix[arcId]} active={hover?.kind === "dial" && hover.id === arcId} />}
      {bottleHint && view === "shelf" && !doseRequest && (
        <div className="cl-bottle-note" role="tooltip" style={{ "--bottle-accent": bottleHint.color } as React.CSSProperties}>
          <strong>{bottleHint.name}<span>{bottleHint.effect}</span></strong>
          <p>{bottleHint.note}</p>
        </div>
      )}
      <div
        className={`cl-render-source ${error && showPhoto ? "is-fallback" : ""}`}
        aria-hidden={!error || !showPhoto}
      >
        {current && (
          <RecipePreview
            key={current.id}
            photo={{ ...current, recipe, committed_recipe: base }}
            base={base}
            compare={compare}
            onFrame={(image) => room.current?.proof(image)}
            onOriginal={(image) => room.current?.proof(image, true)}
          />
        )}
      </div>
      {!current && <p className="cl-empty-note">先在图集中导入照片</p>}
      {message && (
        <p className="cl-top-message" role="status">
          {message}
        </p>
      )}
      <div className="cl-accessible" aria-label="暗房器具键盘操作">
        {readyBases.map((b) => (
          <button
            key={b.id}
            disabled={saving || work.running}
            aria-label={`选择胶片基底 ${b.name}`}
            onClick={() => change({ ...mix, stock: b.id })}
          >
            {b.name}
          </button>
        ))}
        {SERUMS.map((s) => (
          <button
            key={s.id}
            disabled={
              saving || ((s.id === "grain" || s.id === "glow") && !filmReady)
            }
            aria-label={`加入${s.name}药水`}
            onClick={() => setDoseRequest({ id: s.id })}
          >
            {s.name}
          </button>
        ))}
        {(["timer", "warmth", "concentration"] as const).map((id) => (
          <button
            key={id}
            role="slider"
            aria-label={
              id === "timer"
                ? "显影计时器"
                : id === "warmth"
                  ? "色温旋钮"
                  : "浓度旋钮"
            }
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(mix[id] * 100)}
            disabled={saving || work.running}
            onKeyDown={(e) => {
              if (
                [
                  "ArrowLeft",
                  "ArrowRight",
                  "ArrowUp",
                  "ArrowDown",
                  "Home",
                  "End",
                ].includes(e.key)
              ) {
                e.preventDefault();
                change({
                  ...mix,
                  [id]:
                    e.key === "Home"
                      ? 0
                      : e.key === "End"
                        ? 1
                        : clamp(
                            mix[id] +
                              (["ArrowRight", "ArrowUp"].includes(e.key)
                                ? 0.025
                                : -0.025),
                          ),
                });
              }
            }}
          >
            {id}
          </button>
        ))}
      </div>
      {error && (
        <div className="cl-fallback" role="status">
          <p>三维桌面暂不可用，仍可调配照片。</p>
          <button onClick={() => setRetry((n) => n + 1)}>重试三维桌面</button>
          <div>
            {readyBases.map((b) => (
              <button
                key={b.id}
                onClick={() => change({ ...mix, stock: b.id })}
              >
                {b.name}
              </button>
            ))}
          </div>
          <div>
            {SERUMS.map((s) => (
              <button
                key={s.id}
                disabled={(s.id === "grain" || s.id === "glow") && !filmReady}
                onClick={() => setDoseRequest({ id: s.id })}
              >
                {s.name} +
              </button>
            ))}
          </div>
          <div>
            {(["timer", "warmth", "concentration"] as const).map((id) => (
              <label key={id}>
                {id === "timer" ? "显影" : id === "warmth" ? "冷暖" : "浓度"}
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={mix[id]}
                  onChange={(e) =>
                    change({ ...mix, [id]: Number(e.target.value) })
                  }
                />
              </label>
            ))}
          </div>
        </div>
      )}
      {doseRequest && (
        <DoseControls
          id={doseRequest.id}
          atCup={doseRequest.atCup}
          mix={mix}
          base={base}
          onClose={() => setDoseRequest(null)}
          onMeasure={(fraction) => room.current?.meter(fraction)}
          fallback={error}
          onConfirm={(ml) => {
            setDoseRequest(null);
            dispense({ id: doseRequest.id, ml });
          }}
        />
      )}
      <p className="cl-help">拖动倒液 · 滚轮缩放 · 按住中键转动视角</p>
    </section>
  );
}
