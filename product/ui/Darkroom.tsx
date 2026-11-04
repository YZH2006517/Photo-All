// SPDX-License-Identifier: GPL-3.0-or-later
// The darkroom is a view of the library. Its lights and geometry never edit recipes.
import React, { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import {
  ArrowLeft,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Film,
  Boxes,
  ChevronDown,
  View,
  Maximize2,
  Minus,
  Plus,
  Moon,
  RotateCcw,
  Search,
  Sun,
  Volume2,
  VolumeX,
  X,
  FlaskConical,
} from "lucide-react";
import {
  Album,
  Library,
  Photo,
  applyVariantPreference,
  photoBlob,
  photoDimensions,
  currentPreviewGraphics,
  previewPixelRatio,
} from "./model";
import { Picture } from "./Preview";
import "./darkroom.css";
import { WetLab } from "./WetLab";

export type DarkroomRoll = {
  album: Album;
  photos: Photo[];
  number: string;
  key: string;
  title: string;
  part: number;
  parts: number;
};
export function darkroomRolls(
  library: Pick<Library, "albums" | "photos">,
  partition = true,
): DarkroomRoll[] {
  return library.albums
    .filter((album) => !album.trashed_at)
    .flatMap((album) => {
      const photos = applyVariantPreference(
        [
          ...new Map(
            library.photos
              .filter((photo) => photo.album_ids.includes(album.id))
              .map((photo) => [photo.id, photo]),
          ).values(),
        ],
        "jpeg",
      ).sort((a, b) => a.captured - b.captured || a.id - b.id);
      const parts = partition ? Math.max(1, Math.ceil(photos.length / 36)) : 1;
      return Array.from({ length: parts }, (_, i) => ({
        album,
        key: `${album.id}:${i + 1}`,
        part: i + 1,
        parts,
        number: `${String(album.id).padStart(2, "0")}${parts > 1 ? `-${i + 1}` : ""}`,
        title: album.name + (parts > 1 ? ` · 第 ${i + 1}/${parts} 卷` : ""),
        photos: partition ? photos.slice(i * 36, (i + 1) * 36) : photos,
      }));
    });
}
export function darkroomFramePage(photos: Photo[], cursor: number) {
  const strip = photos.slice(0, 36),
    index = Math.max(
      0,
      Math.min(
        Math.max(0, strip.length - 1),
        Number.isFinite(cursor) ? Math.floor(cursor) : 0,
      ),
    );
  return { index, page: 0, start: 0, pages: 1, photos: strip };
}

// One scale for the 35mm strip, cassette mouth and frame spacing.
export const DARKROOM_FILM = {
  height: 1.575,
  bodyHeight: 2.1,
  bodyCenter: 1.18,
  frameWidth: 1.62,
  frameHeight: 1.08,
  cell: 1.71,
  pitch: 1.71 / 8,
  holeWidth: 0.126,
  holeHeight: 0.09,
  leader: 0.58,
  exit: { x: 0.82, y: 1.18, z: 0.16 },
} as const;
const TABLE = { x: -4.25, y: -0.2, z: 0.05 };
const SHELF_Y = [3.12, 0.29];
const FILM_ORIGIN = {
  x: TABLE.x + DARKROOM_FILM.exit.x,
  y: TABLE.y + DARKROOM_FILM.exit.y,
  z: TABLE.z + DARKROOM_FILM.exit.z,
};
export const DARKROOM_DURATION = 4.8 / 1.25;
export function darkroomFeed(width: number, reveal: number, advance = 0) {
  const span = Number.isFinite(width) ? Math.max(0, width) : 0;
  const progress = Number.isFinite(reveal)
    ? Math.max(0, Math.min(1, reveal))
    : 0;
  const offset = Number.isFinite(advance)
    ? Math.max(-span, Math.min(0, advance))
    : 0;
  return -span * (1 - progress) + offset * progress;
}
export function darkroomScreenPower(insertion: number, ready: boolean) {
  return insertion >= 1 && ready ? 1 : 0;
}
export function darkroomZoom(current: number, delta: number) {
  const value = Number.isFinite(current) ? current : 1;
  const wheel = Number.isFinite(delta)
    ? Math.max(-1000, Math.min(1000, delta))
    : 0;
  return Math.max(0.65, Math.min(1.8, value * Math.exp(-wheel * 0.0012)));
}
export function darkroomMotion(value: number) {
  const progress = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  const smooth = (value: number) => {
    const t = Math.max(0, Math.min(1, value));
    return t * t * (3 - 2 * t);
  };
  return {
    travel: smooth(progress / 0.29),
    film: smooth((progress - 0.36) / 0.48),
    paper: smooth((progress - 0.79) / 0.21),
    phase:
      progress === 0 || progress === 1
        ? "idle"
        : progress < 0.29
          ? "transport"
          : progress < 0.36
            ? "settle"
            : progress < 0.79
              ? "unroll"
              : "paper",
  };
}
export function darkroomPerforations(width: number) {
  const result: number[] = [];
  if (!Number.isFinite(width)) return result;
  for (let index = 0; (index + 0.5) * DARKROOM_FILM.pitch < width; index++)
    result.push((index + 0.5) * DARKROOM_FILM.pitch);
  return result;
}

type Stage = "shelf" | "table" | "inspect";
type SceneState = {
  roll?: DarkroomRoll;
  shelf: DarkroomRoll[];
  frames: ReturnType<typeof darkroomFramePage>;
  stage: Stage;
  neutral: boolean;
  reduced: boolean;
  revisions: Record<number, number>;
  parts: { sheet: boolean; viewer: boolean; optical: boolean };
};
type ScenePick = {
  rollId?: string;
  frame?: number;
  viewer?: boolean;
  film?: boolean;
  selectOnly?: boolean;
};
type Room = {
  update: (state: SceneState) => void;
  resetZoom: () => void;
  dispose: () => void;
};
const palette = [
  "#254b3d",
  "#bcab81",
  "#692f26",
  "#303d50",
  "#897351",
  "#3d4140",
];
const text = (value: string, length = 20) =>
  Array.from(value).slice(0, length).join("") +
  (Array.from(value).length > length ? "…" : "");
const saved = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}
function canvas(width: number, height: number, scale = 1, verticalScale = scale) {
  const element = document.createElement("canvas");
  element.width = Math.round(width * scale);
  element.height = Math.round(height * verticalScale);
  const context = element.getContext("2d")!;
  context.scale(element.width / width, element.height / height);
  context.imageSmoothingQuality = "high";
  return { element, context };
}

function makeRoom(
  host: HTMLElement,
  events: {
    pick: (pick: ScenePick) => void;
    ready: (count: number) => void;
    error: (message: string) => void;
    returnReady: () => void;
    zoom: (value: number) => void;
  },
): Room {
  const budget = currentPreviewGraphics();
  // Keep this scene sharp independently of the other preview surfaces.
  const graphics = {
    ...budget,
    filmWidth: Math.round(budget.filmWidth * 1.5),
    maxPixels: budget.maxPixels * 2,
    maxRatio: budget.maxRatio + .25,
  };
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
  });
  const gl = renderer.getContext();
  const maxBufferSize = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number;
  const maxTextureSize = renderer.capabilities.maxTextureSize;
  const artScale = Math.min(graphics.maxRatio, maxTextureSize / 1536);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.18;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.localClippingEnabled = true;
  renderer.domElement.setAttribute("aria-label", "胶片暗房三维场景");
  renderer.domElement.setAttribute("role", "img");
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#100d0a");
  scene.fog = new THREE.FogExp2("#100d0a", 0.025);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 70);
  camera.position.set(7.8, 5.4, 13.8);
  const aim = new THREE.Vector3(0, 1.1, -1.2),
    desiredAim = aim.clone(),
    desiredCamera = camera.position.clone();
  const ray = new THREE.Raycaster(),
    pointer = new THREE.Vector2();
  const hemi = new THREE.HemisphereLight(0xdcd6b8, 0x28160c, 1.5);
  scene.add(hemi);
  const key = new THREE.SpotLight(0xffd49c, 125, 28, 0.8, 0.75, 1.6);
  key.position.set(0.5, 9, 1.8);
  key.target.position.set(0, 0.1, -0.3);
  key.castShadow = true;
  key.shadow.mapSize.setScalar(graphics.shadowSize);
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.035;
  scene.add(key, key.target);
  const rim = new THREE.PointLight(0xff9d4f, 22, 18, 1.7);
  rim.position.set(6, 3, -3);
  scene.add(rim);
  const fill = new THREE.DirectionalLight(0xb3c9bf, 0.65);
  fill.position.set(4, 4, 8);
  scene.add(fill);
  const materials = {
    brass: new THREE.MeshStandardMaterial({
      color: "#c59a51",
      metalness: 0.78,
      roughness: 0.29,
    }),
    black: new THREE.MeshStandardMaterial({
      color: "#151917",
      metalness: 0.32,
      roughness: 0.42,
    }),
    shell: new THREE.MeshStandardMaterial({
      color: "#262b29",
      metalness: 0.72,
      roughness: 0.32,
    }),
    felt: new THREE.MeshStandardMaterial({ color: "#080a09", roughness: 1 }),
    paper: new THREE.MeshStandardMaterial({
      color: "#e3d6b6",
      roughness: 0.95,
    }),
  };
  let disposed = false,
    state: SceneState | undefined,
    frame = 0,
    last = performance.now(),
    progress = 0;
  let atShelf = true;
  let zoom = 1,
    sheetProgress = 0,
    viewerProgress = 0,
    slideProgress = 1,
    opticalProgress = 0,
    screenLight = 0,
    feed = 0,
    desiredFeed = 0,
    lastFeed = NaN;
  let viewerPhotoKey = "";
  let drag: { id: number; x: number; feed: number; moved: boolean } | null =
    null;
  const dragPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -FILM_ORIGIN.z);
  const dragPoint = new THREE.Vector3();
  let frameKey = "",
    shelfKey = "",
    activeRollKey = "",
    controller = new AbortController();
  let strip = new THREE.Group(),
    cartridge = new THREE.Group(),
    shelves = new THREE.Group();
  const bendable: {
    geometry: THREE.PlaneGeometry;
    x: number;
    y: number;
    z: number;
  }[] = [];
  const mouseLean = new THREE.Vector2(),
    cameraBase = new THREE.Vector3();
  const revealPlane = new THREE.Plane(
    new THREE.Vector3(1, 0, 0),
    -FILM_ORIGIN.x,
  );
  const home = new THREE.Vector3(),
    tablePosition = new THREE.Vector3(TABLE.x, TABLE.y, TABLE.z);
  const mouth = new THREE.Vector3(),
    filmStart = new THREE.Vector3(FILM_ORIGIN.x, FILM_ORIGIN.y, FILM_ORIGIN.z);
  let loading = 0,
    loadErrors = 0;

  const texture = (source: HTMLCanvasElement) => {
    const result = new THREE.CanvasTexture(source);
    result.colorSpace = THREE.SRGBColorSpace;
    result.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
    return result;
  };
  const mesh = (
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    parent: THREE.Object3D,
    x = 0,
    y = 0,
    z = 0,
  ) => {
    const result = new THREE.Mesh(geometry, material);
    result.position.set(x, y, z);
    result.castShadow = true;
    result.receiveShadow = true;
    parent.add(result);
    return result;
  };
  const box = (
    parent: THREE.Object3D,
    size: number[],
    pos: number[],
    material: THREE.Material,
  ) =>
    mesh(
      new THREE.BoxGeometry(size[0], size[1], size[2]),
      material,
      parent,
      ...(pos as [number, number, number]),
    );
  function release(object: THREE.Object3D) {
    const geometries = new Set<THREE.BufferGeometry>(),
      mats = new Set<THREE.Material>(),
      maps = new Set<THREE.Texture>();
    object.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      geometries.add(node.geometry);
      for (const mat of Array.isArray(node.material)
        ? node.material
        : [node.material]) {
        if (Object.values(materials).includes(mat as typeof materials.brass))
          continue;
        mats.add(mat);
        for (const value of Object.values(mat))
          if (value instanceof THREE.Texture) maps.add(value);
      }
    });
    geometries.forEach((value) => value.dispose());
    maps.forEach((value) => value.dispose());
    mats.forEach((value) => value.dispose());
  }
  const wood = canvas(1024, 1024, artScale);
  const gradient = wood.context.createLinearGradient(0, 0, 0, 1024);
  gradient.addColorStop(0, "#54321e");
  gradient.addColorStop(0.5, "#3d2418");
  gradient.addColorStop(1, "#4b2c1c");
  wood.context.fillStyle = gradient;
  wood.context.fillRect(0, 0, 1024, 1024);
  let randomSeed = 9321;
  const random = () =>
    (randomSeed = (randomSeed * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < 1800; i++) {
    const y = random() * 1024;
    wood.context.beginPath();
    wood.context.moveTo(0, y);
    wood.context.bezierCurveTo(
      260,
      y + random() * 19,
      740,
      y - random() * 19,
      1024,
      y + random() * 7,
    );
    wood.context.strokeStyle = random() > 0.5 ? "#d89c5710" : "#12090025";
    wood.context.lineWidth = 0.3 + random() * 1.3;
    wood.context.stroke();
  }
  const woodMap = texture(wood.element);
  woodMap.wrapS = woodMap.wrapT = THREE.RepeatWrapping;
  woodMap.repeat.set(2, 2);
  const woodMaterial = new THREE.MeshStandardMaterial({
    map: woodMap,
    roughness: 0.7,
    metalness: 0.06,
  });
  box(scene, [25, 0.4, 17], [0, -0.42, 0], woodMaterial);
  const wall = mesh(
    new THREE.PlaneGeometry(32, 15),
    new THREE.MeshStandardMaterial({ color: "#29291f", roughness: 1 }),
    scene,
    0,
    5.5,
    -5,
  );
  wall.receiveShadow = true;
  // The back rack is real geometry; the cartridges cast shadows onto its ledges.
  for (const y of [0.18, 3.01]) {
    box(scene, [14.6, 0.18, 1.45], [0, y, -3.25], woodMaterial);
    box(scene, [14.6, 0.25, 0.12], [0, y - 0.1, -2.5], materials.black);
  }
  for (const x of [-7.1, 7.1])
    box(scene, [0.15, 6.2, 0.7], [x, 2.7, -3.9], materials.black);
  // The broad overhead key lights the table; there is no desk-lamp model.
  // An empty tray is environmental dressing, not a pretend chemical simulation.
  const tray = new THREE.Group();
  tray.position.set(4.7, -0.14, 2.5);
  tray.rotation.y = -0.12;
  scene.add(tray);
  box(tray, [2.65, 0.06, 1.85], [0, 0, 0], materials.black);
  for (const z of [-0.92, 0.92])
    box(tray, [2.8, 0.16, 0.07], [0, 0.08, z], materials.brass);
  for (const x of [-1.36, 1.36])
    box(tray, [0.07, 0.16, 1.9], [x, 0.08, 0], materials.brass);
  const liquid = mesh(
    new THREE.PlaneGeometry(2.6, 1.8),
    new THREE.MeshStandardMaterial({
      color: "#594126",
      metalness: 0.5,
      roughness: 0.22,
    }),
    tray,
    0,
    0.045,
    0,
  );
  liquid.rotation.x = -Math.PI / 2;
  const pencil = new THREE.Group();
  pencil.position.set(-3.7, -0.1, 3.2);
  pencil.rotation.z = Math.PI / 2;
  pencil.rotation.y = -0.3;
  scene.add(pencil);
  mesh(
    new THREE.CylinderGeometry(0.045, 0.045, 2.1, 6),
    new THREE.MeshStandardMaterial({ color: "#ba6434", roughness: 0.7 }),
    pencil,
  );
  mesh(
    new THREE.ConeGeometry(0.045, 0.2, 6),
    materials.black,
    pencil,
    0,
    1.15,
    0,
  );
  scene.add(strip, cartridge, shelves);

  function makeCartridge(roll: DarkroomRoll, scale: number) {
    const group = new THREE.Group();
    group.scale.setScalar(scale);
    group.userData.rollId = roll.key;
    const label = canvas(1024, 512, artScale),
      ctx = label.context;
    const color = palette[(roll.album.id - 1) % palette.length];
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1024, 512);
    ctx.fillStyle = "#101a14";
    ctx.fillRect(0, 0, 1024, 46);
    ctx.fillRect(0, 466, 1024, 46);
    ctx.fillStyle = "#e5dec4";
    ctx.textAlign = "center";
    ctx.font = "bold 23px monospace";
    ctx.fillText("PHOTO ALL", 512, 99);
    ctx.font = "17px monospace";
    ctx.fillText(`ROLL ${roll.number}  /  135`, 512, 137);
    ctx.font = '52px Georgia,"Microsoft YaHei",serif';
    ctx.fillText(text(roll.title, 14), 512, 261, 440);
    ctx.font = "19px monospace";
    ctx.fillText(`${roll.photos.length} FRAMES`, 512, 382);
    ctx.font = "15px monospace";
    ctx.fillText("35 mm / PHOTO ARCHIVE", 512, 416);
    // Small metallic contact-like patches recall a 135 cassette, not a brand label.
    for (let row = 0; row < 2; row++)
      for (let col = 0; col < 6; col++) {
        ctx.fillStyle = (col + row * 3) % 3 ? "#b8b9ac" : "#17201a";
        ctx.fillRect(802 + col * 25, 336 + row * 46, 22, 41);
      }
    const body = mesh(
      new THREE.CylinderGeometry(
        0.62,
        0.62,
        DARKROOM_FILM.bodyHeight,
        80,
        1,
        true,
      ),
      new THREE.MeshStandardMaterial({
        map: texture(label.element),
        metalness: 0.13,
        roughness: 0.59,
      }),
      group,
      0,
      DARKROOM_FILM.bodyCenter,
      0,
    );
    body.rotation.y = Math.PI;
    for (const y of [0.1, 2.26]) {
      mesh(
        new THREE.CylinderGeometry(0.65, 0.65, 0.075, 80),
        materials.shell,
        group,
        0,
        y,
        0,
      );
      const rim = mesh(
        new THREE.TorusGeometry(0.635, 0.021, 10, 80),
        materials.shell,
        group,
        0,
        y + 0.038,
        0,
      );
      rim.rotation.x = Math.PI / 2;
    }
    for (const radius of [0.39, 0.46]) {
      const groove = mesh(
        new THREE.TorusGeometry(radius, 0.006, 6, 64),
        materials.black,
        group,
        0,
        2.301,
        0,
      );
      groove.rotation.x = Math.PI / 2;
    }
    mesh(
      new THREE.CylinderGeometry(0.175, 0.175, 0.23, 32, 1, true),
      materials.black,
      group,
      0,
      2.4,
      0,
    );
    const spindle = mesh(
      new THREE.RingGeometry(0.075, 0.175, 32),
      materials.black,
      group,
      0,
      2.515,
      0,
    );
    spindle.rotation.x = -Math.PI / 2;
    mesh(
      new THREE.CylinderGeometry(0.074, 0.074, 0.03, 24),
      materials.felt,
      group,
      0,
      2.43,
      0,
    );
    // Two felt-lined lips leave a real open slot centred on the film's plane.
    const mouth = DARKROOM_FILM.exit,
      slotHeight = DARKROOM_FILM.height + 0.12;
    for (const z of [mouth.z - 0.073, mouth.z + 0.073]) {
      box(
        group,
        [0.26, slotHeight, 0.06],
        [mouth.x - 0.13, mouth.y, z],
        materials.black,
      );
      box(
        group,
        [0.27, slotHeight - 0.05, 0.012],
        [mouth.x - 0.13, mouth.y, z + (z < mouth.z ? 0.035 : -0.035)],
        materials.felt,
      );
    }
    for (const sign of [-1, 1])
      box(
        group,
        [0.26, 0.05, 0.21],
        [mouth.x - 0.13, mouth.y + sign * (slotHeight / 2), mouth.z],
        materials.shell,
      );
    return group;
  }
  function stripGeometry(
    width: number,
    height: number,
    x: number,
    y: number,
    z: number,
  ) {
    const geometry = new THREE.PlaneGeometry(
      width,
      height,
      Math.max(30, Math.ceil(width * 8)),
      1,
    );
    bendable.push({ geometry, x, y, z });
    return geometry;
  }
  function filmTexture(number: string, count: number, width: number) {
    const aspect = width / DARKROOM_FILM.height;
    const pixelWidth = Math.min(maxTextureSize, Math.ceil(aspect * 512 * artScale));
    const heightScale = Math.max(1, pixelWidth / (aspect * 512));
    const c = canvas(pixelWidth, 512, 1, heightScale),
      ctx = c.context,
      px = pixelWidth / width,
      py = 512 / DARKROOM_FILM.height;
    const coating = ctx.createLinearGradient(0, 0, 0, 512);
    coating.addColorStop(0, "#7c421f");
    coating.addColorStop(0.08, "#5a2d17");
    coating.addColorStop(0.5, "#3e2014");
    coating.addColorStop(0.92, "#64351b");
    coating.addColorStop(1, "#86502b");
    ctx.fillStyle = coating;
    ctx.fillRect(0, 0, pixelWidth, 512);
    ctx.strokeStyle = "#dca56b35";
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, pixelWidth - 1, 511);
    for (let i = 0; i < count; i++) {
      const centre = DARKROOM_FILM.leader + DARKROOM_FILM.cell * (i + 0.5);
      const left = (centre - DARKROOM_FILM.frameWidth / 2) * px;
      const top = ((DARKROOM_FILM.height - DARKROOM_FILM.frameHeight) / 2) * py;
      ctx.fillStyle = "#100e0b";
      ctx.fillRect(
        left - 2,
        top - 2,
        DARKROOM_FILM.frameWidth * px + 4,
        DARKROOM_FILM.frameHeight * py + 4,
      );
      ctx.fillStyle = "#cbb187";
      ctx.font = "11px monospace";
      ctx.fillText(`PHOTO ALL  ${number}  ·  35mm`, left, 13);
      ctx.font = "12px monospace";
      ctx.fillText(`${state!.frames.start + i + 1}  ▸`, left, 507);
      for (let bar = 0; bar < 18; bar++) {
        ctx.globalAlpha = 0.66;
        ctx.fillRect(left + 80 + bar * 5, 498, bar % 3 ? 2 : 4, 9);
        ctx.globalAlpha = 1;
      }
    }
    // The pitch continues through leaders and frame gaps. Holes are actual alpha cutouts.
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "#fff";
    for (const x of darkroomPerforations(width))
      for (const edge of [0.1125, DARKROOM_FILM.height - 0.1125]) {
        const w = DARKROOM_FILM.holeWidth * px,
          h = DARKROOM_FILM.holeHeight * py;
        ctx.beginPath();
        ctx.roundRect(
          (x - DARKROOM_FILM.holeWidth / 2) * px,
          (edge - DARKROOM_FILM.holeHeight / 2) * py,
          w,
          h,
          Math.min(w, h) * 0.19,
        );
        ctx.fill();
      }
    ctx.globalCompositeOperation = "source-over";
    return texture(c.element);
  }
  const sheetCanvas = canvas(1536, 900, artScale),
    sheetTexture = texture(sheetCanvas.element);
  const sheet = mesh(
    new THREE.PlaneGeometry(5.8, 3.4),
    new THREE.MeshStandardMaterial({
      map: sheetTexture,
      roughness: 0.93,
      side: THREE.DoubleSide,
    }),
    scene,
    0.35,
    -0.205,
    2.3,
  );
  sheet.rotation.x = -Math.PI / 2;
  sheet.rotation.z = -0.045;
  const sheetImages = new Map<number, HTMLCanvasElement>();
  // A compact, upward-angled optical slide viewer: moulded housing, insertion
  // slot, raised lens bezel and neutral backlight. All assets are procedural.
  function rounded(width: number, height: number, radius: number) {
    const shape = new THREE.Shape(),
      x = -width / 2,
      y = -height / 2;
    shape.moveTo(x + radius, y);
    shape.lineTo(x + width - radius, y);
    shape.quadraticCurveTo(x + width, y, x + width, y + radius);
    shape.lineTo(x + width, y + height - radius);
    shape.quadraticCurveTo(
      x + width,
      y + height,
      x + width - radius,
      y + height,
    );
    shape.lineTo(x + radius, y + height);
    shape.quadraticCurveTo(x, y + height, x, y + height - radius);
    shape.lineTo(x, y + radius);
    shape.quadraticCurveTo(x, y, x + radius, y);
    return shape;
  }
  const viewer = new THREE.Group();
  viewer.name = "desktop-slide-viewer";
  scene.add(viewer);
  const housing = new THREE.MeshStandardMaterial({
    color: "#b8ad94",
    roughness: 0.66,
    metalness: 0.05,
  });
  box(viewer, [2.45, 0.16, 1.65], [0, 0.08, 0], materials.black);
  for (const x of [-0.9, 0.9])
    for (const z of [-0.55, 0.55])
      box(viewer, [0.3, 0.1, 0.23], [x, 0.025, z], materials.felt);
  const viewerFace = new THREE.Group();
  viewerFace.position.set(0, 1.02, -0.12);
  viewerFace.rotation.x = -0.3;
  viewer.add(viewerFace);
  const housingGeometry = new THREE.ExtrudeGeometry(rounded(2.25, 1.76, 0.16), {
    depth: 0.72,
    bevelEnabled: true,
    bevelSize: 0.06,
    bevelThickness: 0.045,
    bevelSegments: 3,
    steps: 1,
    curveSegments: 12,
  });
  housingGeometry.translate(0, 0, -0.36);
  mesh(housingGeometry, housing, viewerFace);
  const bezelGeometry = new THREE.ExtrudeGeometry(rounded(2.06, 1.42, 0.1), {
    depth: 0.08,
    bevelEnabled: true,
    bevelSize: 0.035,
    bevelThickness: 0.025,
    bevelSegments: 3,
    curveSegments: 12,
  });
  mesh(bezelGeometry, materials.black, viewerFace, 0, 0.09, 0.38);
  const viewerCanvas = canvas(960, 640, artScale),
    viewerTexture = texture(viewerCanvas.element);
  const viewerImageMaterial = new THREE.MeshBasicMaterial({
    map: viewerTexture,
    toneMapped: false,
    fog: false,
    color: "#111111",
  });
  const viewerImage = mesh(
    new THREE.PlaneGeometry(1.83, 1.22),
    viewerImageMaterial,
    viewerFace,
    0,
    0.09,
    0.487,
  );
  viewerImage.castShadow = viewerImage.receiveShadow = false;
  viewerImage.userData.viewer = true;
  // A thin optical highlight at the lens rim, rather than a grey veil over the image.
  const lensHighlight = new THREE.MeshBasicMaterial({
    color: "#f7f4e5",
    transparent: true,
    opacity: 0.22,
    toneMapped: false,
    depthWrite: false,
  });
  const glint = mesh(
    new THREE.PlaneGeometry(1.68, 0.008),
    lensHighlight,
    viewerFace,
    0,
    0.735,
    0.49,
  );
  glint.castShadow = glint.receiveShadow = false;
  box(viewerFace, [1.14, 0.035, 0.11], [0, 0.905, -0.02], materials.felt);
  for (const x of [-0.58, 0.58])
    box(viewerFace, [0.035, 0.035, 0.17], [x, 0.905, -0.02], materials.shell);
  const slide = new THREE.Group();
  viewerFace.add(slide);
  const slideShape = rounded(1.05, 1.05, 0.025),
    slideWindow = new THREE.Path();
  slideWindow.moveTo(-0.35, -0.235);
  slideWindow.lineTo(-0.35, 0.235);
  slideWindow.lineTo(0.35, 0.235);
  slideWindow.lineTo(0.35, -0.235);
  slideWindow.closePath();
  slideShape.holes.push(slideWindow);
  mesh(
    new THREE.ExtrudeGeometry(slideShape, {
      depth: 0.035,
      bevelEnabled: false,
    }),
    new THREE.MeshStandardMaterial({ color: "#e6decb", roughness: 0.95 }),
    slide,
  );
  const slideImage = mesh(
    new THREE.PlaneGeometry(0.7, 0.47),
    new THREE.MeshBasicMaterial({
      map: viewerTexture,
      toneMapped: false,
      fog: false,
    }),
    slide,
    0,
    0,
    0.038,
  );
  slideImage.castShadow = slideImage.receiveShadow = false;
  const badge = canvas(512, 80, artScale);
  badge.context.fillStyle = "#3b4039";
  badge.context.font = "19px monospace";
  badge.context.fillText("PHOTO ALL  /  35 mm", 36, 48);
  const badgePlane = mesh(
    new THREE.PlaneGeometry(1.4, 0.22),
    new THREE.MeshBasicMaterial({
      map: texture(badge.element),
      transparent: true,
      toneMapped: false,
    }),
    viewerFace,
    -0.05,
    -0.72,
    0.43,
  );
  badgePlane.castShadow = badgePlane.receiveShadow = false;
  // Eject key and vent ribs make the proportions read as a real small appliance.
  const ejectKey = mesh(
    new THREE.CylinderGeometry(0.09, 0.09, 0.025, 24),
    materials.shell,
    viewerFace,
    0.94,
    -0.71,
    0.43,
  );
  ejectKey.rotation.x = Math.PI / 2;
  for (let i = 0; i < 7; i++)
    box(
      viewer,
      [0.018, 0.055, 0.37],
      [-0.28 + i * 0.08, 0.18, 0.61],
      materials.felt,
    );
  const viewerGlow = new THREE.PointLight(0xe6f0ed, 0, 3, 2);
  viewerGlow.position.set(0, 0.6, 1);
  viewer.add(viewerGlow);
  viewer.position.set(1.1, -0.2, 2.6);
  viewer.rotation.y = -0.08;
  function paintViewer() {
    const current =
      state?.frames.photos[state.frames.index - state.frames.start];
    const image = current ? sheetImages.get(current.id) : undefined;
    const ctx = viewerCanvas.context;
    ctx.fillStyle = "#111715";
    ctx.fillRect(0, 0, 960, 640);
    if (image) ctx.drawImage(image, 0, 0, 960, 640);
    viewerTexture.needsUpdate = true;
    viewerImage.userData.frame = current ? state!.frames.index : undefined;
    host.dataset.viewerFrame = String(viewerImage.userData.frame ?? -1);
    wake();
  }
  // A separate optical reader surrounds the real strip. There is no duplicate
  // photo surface here: the same continuous film runs between the side rollers.
  const optical = new THREE.Group();
  optical.name = "film-strip-optical-reader";
  const opticalX =
    FILM_ORIGIN.x + DARKROOM_FILM.leader + DARKROOM_FILM.cell / 2;
  const opticalDistance = opticalX - FILM_ORIGIN.x;
  const opticalY =
    FILM_ORIGIN.y +
    Math.sin(opticalDistance * 0.36) *
      0.035 *
      (1 - Math.exp(-opticalDistance * 1.6));
  const opticalZ =
    FILM_ORIGIN.z -
    Math.sin(opticalDistance * 0.42) *
      0.2 *
      (1 - Math.exp(-opticalDistance * 1.6));
  scene.add(optical);
  const enamel = new THREE.MeshStandardMaterial({
    color: "#243c33",
    roughness: 0.43,
    metalness: 0.2,
  });
  const readerFrame = rounded(2.22, 1.96, 0.16);
  const readerWindow = rounded(1.8, 1.22, 0.045);
  readerFrame.holes.push(new THREE.Path(readerWindow.getPoints(36).reverse()));
  const readerGeometry = new THREE.ExtrudeGeometry(readerFrame, {
    depth: 0.12,
    bevelEnabled: true,
    bevelSize: 0.025,
    bevelThickness: 0.025,
    bevelSegments: 3,
    curveSegments: 12,
  });
  mesh(readerGeometry, enamel, optical, 0, 0, 0.13);
  const innerFrame = rounded(1.88, 1.3, 0.06);
  innerFrame.holes.push(
    new THREE.Path(rounded(1.8, 1.22, 0.04).getPoints(36).reverse()),
  );
  const readerRim = mesh(
    new THREE.ShapeGeometry(innerFrame),
    materials.brass,
    optical,
    0,
    0,
    0.279,
  );
  readerRim.castShadow = false;
  const diffuser = mesh(
    new THREE.PlaneGeometry(1.83, 1.25),
    new THREE.MeshBasicMaterial({ color: "#e8ede0", toneMapped: false }),
    optical,
    0,
    0,
    -0.16,
  );
  diffuser.castShadow = diffuser.receiveShadow = false;
  const opticalGlass = mesh(
    new THREE.PlaneGeometry(1.8, 1.22),
    new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
      colorWrite: false,
    }),
    optical,
    0,
    0,
    0.3,
  );
  opticalGlass.castShadow = opticalGlass.receiveShadow = false;
  opticalGlass.userData.viewer = true;
  const rollers: THREE.Mesh[] = [];
  for (const x of [-1.12, 1.12])
    for (const z of [-0.15, 0.15]) {
      const roller = mesh(
        new THREE.CylinderGeometry(0.04, 0.04, DARKROOM_FILM.height + 0.08, 20),
        materials.felt,
        optical,
        x,
        0,
        z,
      );
      rollers.push(roller);
    }
  box(optical, [2.5, 0.12, 0.92], [0, -opticalY - 0.14, 0.03], materials.black);
  for (const x of [-0.94, 0.94])
    box(optical, [0.12, 0.24, 0.5], [x, -0.99, 0.03], enamel);
  const crank = new THREE.Group();
  crank.position.set(1.3, -0.25, 0.23);
  optical.add(crank);
  const hub = mesh(
    new THREE.CylinderGeometry(0.095, 0.095, 0.09, 24),
    materials.shell,
    crank,
  );
  hub.rotation.x = Math.PI / 2;
  box(crank, [0.055, 0.37, 0.06], [0, -0.16, 0.02], materials.shell);
  mesh(
    new THREE.SphereGeometry(0.09, 20, 16),
    new THREE.MeshStandardMaterial({ color: "#943729", roughness: 0.28 }),
    crank,
    0,
    -0.35,
    0.06,
  );
  const readerBadge = canvas(512, 64, artScale);
  readerBadge.context.fillStyle = "#cab88f";
  readerBadge.context.font = "18px monospace";
  readerBadge.context.fillText("PHOTO ALL  /  OPTICAL 35", 32, 42);
  const readerLabel = mesh(
    new THREE.PlaneGeometry(1.4, 0.18),
    new THREE.MeshBasicMaterial({
      map: texture(readerBadge.element),
      transparent: true,
      toneMapped: false,
    }),
    optical,
    0,
    -0.82,
    0.28,
  );
  readerLabel.castShadow = readerLabel.receiveShadow = false;
  function drawSheet() {
    const ctx = sheetCanvas.context,
      page = state?.frames;
    ctx.fillStyle = "#e9dfc5";
    ctx.fillRect(0, 0, 1536, 900);
    ctx.fillStyle = "#554d3c";
    ctx.font = "24px monospace";
    ctx.fillText(
      `CONTACT SHEET  /  ${text(state?.roll?.title || "PHOTO ALL", 24)}`,
      68,
      67,
    );
    ctx.font = "18px monospace";
    ctx.fillText(
      `ROLL ${state?.roll?.number || "—"}   /   ${page ? page.start + 1 : 0} — ${page ? page.start + page.photos.length : 0}`,
      68,
      836,
    );
    const count = page?.photos.length || 0,
      columns = Math.min(6, Math.max(1, Math.ceil(Math.sqrt(count * 1.5)))),
      rows = Math.max(1, Math.ceil(count / columns));
    const cw = 1400 / columns,
      ch = 690 / rows;
    page?.photos.forEach((photo, i) => {
      const x = 68 + (i % columns) * cw,
        y = 100 + Math.floor(i / columns) * ch,
        w = cw - 10,
        h = ch - 10;
      ctx.fillStyle = "#151713";
      ctx.fillRect(x, y, w, h);
      const image = sheetImages.get(photo.id),
        ratio = Math.min((w - 14) / 960, (h - 25) / 640);
      if (image)
        ctx.drawImage(
          image,
          x + (w - 960 * ratio) / 2,
          y + 5,
          960 * ratio,
          640 * ratio,
        );
      ctx.fillStyle = "#cdbd97";
      ctx.font = `${Math.max(12, Math.min(16, ch * 0.08))}px monospace`;
      ctx.fillText(String(i + 1).padStart(2, "0"), x + 7, y + h - 4);
      if (page.index === i) {
        ctx.strokeStyle = "#a64030";
        ctx.lineWidth = 3;
        ctx.strokeRect(x + 2, y + 2, w - 4, h - 4);
      }
    });
    sheetTexture.needsUpdate = true;
    paintViewer();
    wake();
  }
  function buildStrip() {
    controller.abort();
    controller = new AbortController();
    const signal = controller.signal;
    release(strip);
    scene.remove(strip);
    strip = new THREE.Group();
    scene.add(strip);
    bendable.length = 0;
    sheetImages.clear();
    feed = desiredFeed = 0;
    lastFeed = NaN;
    loading = 0;
    loadErrors = 0;
    events.ready(0);
    if (!state?.roll) {
      drawSheet();
      return;
    }
    const current = state,
      { frames } = current,
      roll = current.roll!,
      count = frames.photos.length;
    const cell = DARKROOM_FILM.cell,
      width = DARKROOM_FILM.leader + Math.max(1, count) * cell + 0.15,
      startX = FILM_ORIGIN.x;
    const substrate = mesh(
      stripGeometry(
        width,
        DARKROOM_FILM.height,
        startX + width / 2,
        FILM_ORIGIN.y,
        FILM_ORIGIN.z,
      ),
      new THREE.MeshStandardMaterial({
        map: filmTexture(roll.number, count, width),
        alphaTest: 0.5,
        clippingPlanes: [revealPlane],
        clipShadows: true,
        side: THREE.DoubleSide,
        roughness: 0.45,
        metalness: 0.08,
      }),
      strip,
    );
    substrate.name = "film-substrate";
    substrate.userData.film = true;
    substrate.receiveShadow = false;
    const queue: (() => Promise<void>)[] = [];
    const imageWidth = Math.min(graphics.filmWidth, maxTextureSize);
    const imageHeight = Math.round(imageWidth * 2 / 3);
    frames.photos.forEach((photo, i) => {
      const x = startX + DARKROOM_FILM.leader + cell * (i + 0.5),
        geometry = stripGeometry(
          DARKROOM_FILM.frameWidth,
          DARKROOM_FILM.frameHeight,
          x,
          FILM_ORIGIN.y,
          FILM_ORIGIN.z + 0.006,
        );
      const mat = new THREE.MeshBasicMaterial({
        color: "#28241c",
        side: THREE.DoubleSide,
        toneMapped: false,
        fog: false,
        clippingPlanes: [revealPlane],
      });
      const panel = mesh(geometry, mat, strip);
      // The substrate already contains the opaque image windows. One surface casts
      // the perforated, clipped shadow; photo overlays never cast duplicate shadows.
      panel.castShadow = false;
      panel.receiveShadow = false;
      panel.name = "film-photo";
      panel.userData.frame = frames.start + i;
      panel.userData.film = true;
      queue.push(async () => {
        try {
          const blob = await photoBlob(
            photo,
            imageWidth,
            false,
            signal,
            current.revisions[photo.id] || 0,
            "source",
          );
          if (signal.aborted || disposed) return;
          const bitmap = await createImageBitmap(blob);
          if (signal.aborted || disposed) {
            bitmap.close();
            return;
          }
          const image = canvas(imageWidth, imageHeight),
            ratio = Math.min(imageWidth / bitmap.width, imageHeight / bitmap.height);
          image.context.fillStyle = "#171814";
          image.context.fillRect(0, 0, imageWidth, imageHeight);
          image.context.drawImage(
            bitmap,
            (imageWidth - bitmap.width * ratio) / 2,
            (imageHeight - bitmap.height * ratio) / 2,
            bitmap.width * ratio,
            bitmap.height * ratio,
          );
          bitmap.close();
          mat.map = texture(image.element);
          mat.color.set("#ffffff");
          mat.needsUpdate = true;
          sheetImages.set(photo.id, image.element);
          loading++;
          events.ready(loading);
          drawSheet();
        } catch (error) {
          if (!signal.aborted && !disposed) {
            loadErrors++;
            host.dataset.photoErrors = String(loadErrors);
          }
        }
      });
    });
    for (let i = 0; i < Math.min(2, queue.length); i++)
      void (async () => {
        while (queue.length && !signal.aborted && !disposed)
          await queue.shift()!();
      })();
    host.dataset.filmShadowCasters = String(
      strip.children.filter(
        (object) => object instanceof THREE.Mesh && object.castShadow,
      ).length,
    );
    host.dataset.filmShadowClipped = String(substrate.material.clipShadows);
    drawSheet();
  }
  function setPositions(displacement = strip.position.x) {
    for (const piece of bendable) {
      const positions = piece.geometry.attributes.position,
        original = piece.geometry.parameters;
      for (let i = 0; i < positions.count; i++) {
        const u = (i % (original.widthSegments + 1)) / original.widthSegments;
        const v = Math.floor(i / (original.widthSegments + 1));
        const x = piece.x + (u - 0.5) * original.width;
        const distance = x + displacement - FILM_ORIGIN.x,
          soften = 1 - Math.exp(-Math.max(0, distance) * 1.6);
        positions.setXYZ(
          i,
          x,
          piece.y +
            (0.5 - v) * original.height +
            Math.sin(distance * 0.36) * 0.035 * soften,
          piece.z - Math.sin(distance * 0.42) * 0.2 * soften,
        );
      }
      positions.needsUpdate = true;
      piece.geometry.computeVertexNormals();
      piece.geometry.computeBoundingSphere();
    }
  }
  function wake() {
    if (!disposed && !frame && !document.hidden)
      frame = requestAnimationFrame(draw);
  }
  function draw(now: number) {
    frame = 0;
    if (disposed || document.hidden || !state) return;
    // Keep the requested speed at lower frame rates; background resume resets last.
    const dt = Math.min(0.25, Math.max(0.001, (now - last) / 1000));
    last = now;
    const step = state.reduced ? 1 : 1 - Math.exp(-dt * 5.5);
    const target = state.stage === "shelf" ? 0 : 1;
    progress = state.reduced
      ? target
      : Math.max(
          0,
          Math.min(
            1,
            progress + (Math.sign(target - progress) * dt) / DARKROOM_DURATION,
          ),
        );
    const motion = darkroomMotion(progress);
    const width =
      DARKROOM_FILM.leader +
      Math.max(1, state.frames.photos.length) * DARKROOM_FILM.cell +
      0.15;
    if (state.parts.optical && opticalProgress === 1 && !drag) {
      desiredFeed =
        -(state.frames.index - state.frames.start) * DARKROOM_FILM.cell;
    }
    feed =
      state.reduced || drag
        ? desiredFeed
        : THREE.MathUtils.lerp(feed, desiredFeed, 1 - Math.exp(-dt * 8));
    if (Math.abs(feed - desiredFeed) < 0.0001) feed = desiredFeed;
    strip.position.x = darkroomFeed(width, motion.film, feed);
    if (strip.position.x !== lastFeed) {
      lastFeed = strip.position.x;
      setPositions(lastFeed);
    }
    strip.visible = motion.film > 0.001;
    const slot = state.shelf.findIndex((item) => item.key === state!.roll?.key);
    home.set(
      slot < 0 ? -5.05 : -5.05 + (slot % 4) * 3.36,
      SHELF_Y[slot < 4 ? 0 : 1],
      -3.2,
    );
    cartridge.position.lerpVectors(home, tablePosition, motion.travel);
    cartridge.position.y += Math.sin(motion.travel * Math.PI) * 0.48;
    cartridge.rotation.y = Math.sin(motion.travel * Math.PI) * -0.13;
    cartridge.scale.setScalar(1);
    cartridge.visible = !!state.roll && progress > 0.0001;
    shelves.children.forEach((object) => {
      object.visible =
        object.userData.rollId !== state!.roll?.key || progress <= 0.0001;
    });
    const approach = (value: number, goal: number, duration: number) =>
      state!.reduced || Math.abs(goal - value) <= dt / duration
        ? goal
        : value + (Math.sign(goal - value) * dt) / duration;
    sheetProgress = approach(
      sheetProgress,
      state.parts.sheet ? motion.paper : 0,
      0.45,
    );
    viewerProgress = approach(
      viewerProgress,
      state.parts.viewer ? motion.paper : 0,
      0.45,
    );
    const opticalGoal = state.parts.optical ? motion.travel : 0;
    opticalProgress = approach(opticalProgress, opticalGoal, 0.55);
    optical.visible = opticalProgress > 0.001;
    optical.position.set(
      opticalX,
      opticalY,
      opticalZ + 6 * (1 - opticalProgress),
    );
    optical.rotation.x = -0.06 * (1 - opticalProgress);
    opticalGlass.userData.frame = state.frames.photos.length
      ? state.frames.index
      : undefined;
    crank.rotation.z = (strip.position.x / DARKROOM_FILM.cell) * Math.PI * 2;
    rollers.forEach((roller) => {
      roller.rotation.y = strip.position.x / 0.04;
    });
    slideProgress = approach(slideProgress, viewerProgress > 0.7 ? 1 : 0, 0.8);
    sheet.visible = sheetProgress > 0.001;
    sheet.scale.setScalar(0.82);
    sheet.position.set(
      -0.8,
      -0.205 + Math.sin(sheetProgress * Math.PI) * 0.43,
      2.6 + 8 * (1 - sheetProgress),
    );
    sheet.rotation.set(
      -Math.PI / 2 + 0.12 * (1 - sheetProgress),
      0.05 * (1 - sheetProgress),
      -0.045 + 0.19 * (1 - sheetProgress),
    );
    viewer.visible = viewerProgress > 0.001;
    const viewerX = state.parts.sheet ? 3.8 : 1.1;
    viewer.position.x = state.reduced
      ? viewerX
      : THREE.MathUtils.lerp(viewer.position.x, viewerX, step);
    viewer.position.y = -0.2 + Math.sin(viewerProgress * Math.PI) * 0.12;
    viewer.position.z = 2.6 + 7 * (1 - viewerProgress);
    viewer.rotation.x = -0.08 * (1 - viewerProgress);
    slide.position.set(0, 0.35 + 1.5 * (1 - slideProgress), -0.02);
    slide.rotation.z = -0.08 * Math.sin(slideProgress * Math.PI);
    const screenTarget = darkroomScreenPower(
      slideProgress,
      state.parts.viewer &&
        viewerProgress === 1 &&
        sheetImages.has(
          state.frames.photos[state.frames.index - state.frames.start]?.id,
        ),
    );
    screenLight = screenTarget ? approach(screenLight, 1, 0.2) : 0;
    const backlight = screenLight;
    viewerImageMaterial.color.setScalar(backlight);
    viewerGlow.intensity = backlight * 1.2;
    ejectKey.position.z = 0.43 - 0.015 * Math.sin(slideProgress * Math.PI);
    tray.visible = viewerProgress <= 0.001;
    if (state.stage === "shelf" && progress === 0 && !atShelf) {
      atShelf = true;
      events.returnReady();
    }
    cameraBase
      .copy(desiredCamera)
      .sub(desiredAim)
      .multiplyScalar(1 / zoom)
      .add(desiredAim);
    if (!state.reduced) {
      cameraBase.x += mouseLean.x * 0.13;
      cameraBase.y += mouseLean.y * 0.07;
    }
    camera.position.lerp(cameraBase, step);
    aim.lerp(desiredAim, step);
    camera.lookAt(aim);
    renderer.render(scene, camera);
    host.dataset.renderer = "ready";
    host.dataset.stage = state.stage;
    host.dataset.textures = String(renderer.info.memory.textures);
    host.dataset.phase = motion.phase;
    host.dataset.rollTravel = motion.travel.toFixed(5);
    host.dataset.filmReveal = motion.film.toFixed(5);
    host.dataset.paperReveal = sheetProgress.toFixed(5);
    host.dataset.viewerReveal = viewerProgress.toFixed(5);
    host.dataset.viewerSlide = slideProgress.toFixed(5);
    host.dataset.viewerLight = backlight.toFixed(5);
    host.dataset.filmFeed = strip.position.x.toFixed(5);
    host.dataset.filmAdvance = feed.toFixed(5);
    const firstPanel = strip.children.find(
      (object) => object.name === "film-photo",
    ) as THREE.Mesh<THREE.PlaneGeometry> | undefined;
    if (firstPanel) {
      const anchor = new THREE.Vector3().fromBufferAttribute(
        firstPanel.geometry.attributes.position,
        Math.floor(firstPanel.geometry.parameters.widthSegments / 2),
      );
      firstPanel.localToWorld(anchor);
      host.dataset.frameAnchorX = anchor.x.toFixed(5);
    }
    host.dataset.opticalReveal = opticalProgress.toFixed(5);
    host.dataset.opticalFrame = String(
      state.frames.start +
        Math.max(
          0,
          Math.min(
            state.frames.photos.length - 1,
            Math.round(-feed / DARKROOM_FILM.cell),
          ),
        ),
    );
    host.dataset.zoom = zoom.toFixed(4);
    mouth.set(DARKROOM_FILM.exit.x, DARKROOM_FILM.exit.y, DARKROOM_FILM.exit.z);
    cartridge.localToWorld(mouth);
    host.dataset.mouthGap = mouth.distanceTo(filmStart).toFixed(5);
    const moving =
      progress !== target ||
      Math.abs(feed - desiredFeed) > 0.0001 ||
      Math.abs(screenLight - screenTarget) > 0.00001 ||
      Math.abs(opticalProgress - opticalGoal) > 0.00001 ||
      Math.abs(sheetProgress - (state.parts.sheet ? motion.paper : 0)) >
        0.00001 ||
      Math.abs(viewerProgress - (state.parts.viewer ? motion.paper : 0)) >
        0.00001 ||
      Math.abs(slideProgress - (viewerProgress > 0.7 ? 1 : 0)) > 0.00001 ||
      (viewer.visible && Math.abs(viewer.position.x - viewerX) > 0.001) ||
      camera.position.distanceToSquared(cameraBase) > 0.00001 ||
      aim.distanceToSquared(desiredAim) > 0.00001;
    host.dataset.motion = moving ? "moving" : "idle";
    if (moving) wake();
  }
  function resize() {
    const width = host.clientWidth,
      height = host.clientHeight;
    if (!width || !height) return;
    renderer.setDrawingBufferSize(
      width, height,
      previewPixelRatio(graphics, width, height, Math.max(1.25, window.devicePixelRatio || 1), maxBufferSize),
    );
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    wake();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  function hits(event: PointerEvent) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      (-(event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    scene.updateMatrixWorld(true);
    camera.updateMatrixWorld();
    ray.setFromCamera(pointer, camera);
    const groups =
      state?.stage === "shelf"
        ? [shelves]
        : [
            strip,
            cartridge,
            ...(viewer.visible ? [viewer] : []),
            ...(optical.visible ? [optical] : []),
          ];
    if (state?.stage === "shelf" && progress > 0.0001) return undefined;
    for (const hit of ray.intersectObjects(groups, true)) {
      if (
        hit.object.parent === strip &&
        revealPlane.distanceToPoint(hit.point) < 0
      )
        continue;
      let node: THREE.Object3D | null = hit.object;
      while (node) {
        if (
          node.userData.frame !== undefined ||
          node.userData.film ||
          node.userData.rollId !== undefined
        )
          return node.userData as ScenePick;
        node = node.parent;
      }
    }
    return undefined;
  }
  let down = { x: 0, y: 0 };
  const freeFilm = () =>
    state?.stage === "table" &&
    progress === 1 &&
    !state.parts.viewer &&
    !state.parts.optical &&
    !state.parts.sheet &&
    viewerProgress === 0 &&
    opticalProgress === 0 &&
    sheetProgress === 0;
  const pointerDown = (event: PointerEvent) => {
    down = { x: event.clientX, y: event.clientY };
    const hit = hits(event);
    if (
      event.button === 0 &&
      freeFilm() &&
      hit?.film &&
      ray.ray.intersectPlane(dragPlane, dragPoint)
    ) {
      drag = { id: event.pointerId, x: dragPoint.x, feed, moved: false };
      renderer.domElement.setPointerCapture(event.pointerId);
      host.style.cursor = "grabbing";
      event.preventDefault();
    }
  };
  const pointerUp = (event: PointerEvent) => {
    if (drag?.id === event.pointerId) {
      const moved = drag.moved;
      feed = desiredFeed;
      drag = null;
      if (renderer.domElement.hasPointerCapture(event.pointerId))
        renderer.domElement.releasePointerCapture(event.pointerId);
      if (moved && state) {
        events.pick({
          frame:
            state.frames.start +
            Math.max(
              0,
              Math.min(
                state.frames.photos.length - 1,
                Math.round(-feed / DARKROOM_FILM.cell),
              ),
            ),
          selectOnly: true,
        });
        wake();
        return;
      }
    }
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) < 6) {
      const pick = hits(event);
      if (pick) events.pick(pick);
    }
  };
  const pointerMove = (event: PointerEvent) => {
    const hit = hits(event);
    if (
      drag?.id === event.pointerId &&
      ray.ray.intersectPlane(dragPlane, dragPoint)
    ) {
      drag.moved ||=
        Math.hypot(event.clientX - down.x, event.clientY - down.y) > 6;
      desiredFeed = Math.max(
        -Math.max(0, state!.frames.photos.length - 1) * DARKROOM_FILM.cell,
        Math.min(0, drag.feed + dragPoint.x - drag.x),
      );
      host.style.cursor = "grabbing";
      wake();
      return;
    }
    host.style.cursor =
      freeFilm() && hit?.film ? "grab" : hit ? "pointer" : "default";
    mouseLean.copy(pointer);
    wake();
  };
  const pointerLeave = () => {
    if (drag) return;
    mouseLean.set(0, 0);
    host.style.cursor = "default";
    wake();
  };
  const cancelDrag = () => {
    if (!drag) return;
    drag = null;
    desiredFeed = feed;
    host.style.cursor = "default";
    wake();
  };
  const visibility = () => {
    if (document.hidden) {
      cancelAnimationFrame(frame);
      frame = 0;
    } else {
      last = performance.now();
      wake();
    }
  };
  const lost = (event: Event) => {
    event.preventDefault();
    cancelAnimationFrame(frame);
    frame = 0;
    events.error("三维场景暂时不可用，可以重试或继续查看照片。");
  };
  const wheel = (event: WheelEvent) => {
    if (!state || state.stage === "inspect") return;
    event.preventDefault();
    const delta =
      event.deltaY *
      (event.deltaMode === 1
        ? 16
        : event.deltaMode === 2
          ? host.clientHeight
          : 1);
    zoom = darkroomZoom(zoom, delta);
    events.zoom(zoom);
    wake();
  };
  renderer.domElement.addEventListener("pointerdown", pointerDown);
  renderer.domElement.addEventListener("pointerup", pointerUp);
  renderer.domElement.addEventListener("pointermove", pointerMove);
  renderer.domElement.addEventListener("pointerleave", pointerLeave);
  renderer.domElement.addEventListener("pointercancel", cancelDrag);
  renderer.domElement.addEventListener("lostpointercapture", cancelDrag);
  renderer.domElement.addEventListener("webglcontextlost", lost);
  renderer.domElement.addEventListener("wheel", wheel, { passive: false });
  document.addEventListener("visibilitychange", visibility);
  resize();
  return {
    resetZoom() {
      zoom = 1;
      events.zoom(zoom);
      wake();
    },
    update(next) {
      if (disposed) return;
      if (
        drag &&
        (next.stage !== "table" ||
          next.parts.viewer ||
          next.parts.optical ||
          next.parts.sheet)
      )
        cancelDrag();
      state = next;
      const photo = next.frames.photos[next.frames.index - next.frames.start];
      const selection = photo
        ? `${next.roll?.key}:${photo.id}:${next.revisions[photo.id] || 0}:${JSON.stringify(photo.recipe)}`
        : "";
      if (selection !== viewerPhotoKey) {
        viewerPhotoKey = selection;
        slideProgress = 0;
        screenLight = 0;
      }
      if (next.stage !== "shelf") atShelf = false;
      const shelfSignature = next.shelf
        .map((roll) => `${roll.key}:${roll.title}:${roll.photos.length}`)
        .join("|");
      if (shelfKey !== shelfSignature) {
        shelfKey = shelfSignature;
        release(shelves);
        scene.remove(shelves);
        shelves = new THREE.Group();
        scene.add(shelves);
        next.shelf.forEach((roll, i) => {
          const object = makeCartridge(roll, 1);
          object.position.set(
            -5.05 + (i % 4) * 3.36,
            SHELF_Y[i < 4 ? 0 : 1],
            -3.2,
          );
          shelves.add(object);
        });
      }
      const activeSignature = next.roll
        ? `${next.roll.key}:${next.roll.title}:${next.roll.photos.length}`
        : "";
      if (activeRollKey !== activeSignature) {
        activeRollKey = activeSignature;
        release(cartridge);
        scene.remove(cartridge);
        cartridge = new THREE.Group();
        if (next.roll) cartridge.add(makeCartridge(next.roll, 1));
        cartridge.position.copy(tablePosition);
        scene.add(cartridge);
      }
      const signature =
        next.frames.photos
          .map(
            (photo) =>
              `${photo.id}:${next.revisions[photo.id] || 0}:${JSON.stringify(photo.recipe)}`,
          )
          .join("|") + `/${next.roll?.key}`;
      if (signature !== frameKey) {
        drag = null;
        frameKey = signature;
        buildStrip();
        setPositions();
      } else drawSheet();
      if (next.stage === "shelf") {
        desiredCamera.set(6.6, 5.1, 14.9);
        desiredAim.set(0, 2.15, -2.6);
      } else {
        desiredCamera.set(0.9, 6.2, 12.8);
        desiredAim.set(0.2, 0.5, 0.1);
      }
      if (next.neutral) {
        key.color.set("#ffffff");
        rim.color.set("#dbe3df");
        hemi.color.set("#e9f1ef");
        scene.background = new THREE.Color("#171c1b");
        renderer.toneMappingExposure = 1.2;
      } else {
        key.color.set("#ffd49c");
        rim.color.set("#ff9d4f");
        hemi.color.set("#dcd6b8");
        scene.background = new THREE.Color("#100d0a");
        renderer.toneMappingExposure = 1.18;
      }
      host.dataset.frameCount = String(next.frames.photos.length);
      host.dataset.photoErrors = String(loadErrors);
      last = performance.now();
      wake();
    },
    dispose() {
      disposed = true;
      controller.abort();
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      renderer.domElement.removeEventListener("pointerdown", pointerDown);
      renderer.domElement.removeEventListener("pointerup", pointerUp);
      renderer.domElement.removeEventListener("pointermove", pointerMove);
      renderer.domElement.removeEventListener("pointerleave", pointerLeave);
      renderer.domElement.removeEventListener("pointercancel", cancelDrag);
      renderer.domElement.removeEventListener("lostpointercapture", cancelDrag);
      renderer.domElement.removeEventListener("webglcontextlost", lost);
      renderer.domElement.removeEventListener("wheel", wheel);
      release(scene);
      Object.values(materials).forEach((material) => material.dispose());
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      host.dataset.renderer = "disposed";
    },
  };
}

export function Darkroom(props: {
  library: Library;
  revisions: Record<number, number>;
  onBack: () => void;
  onApply: (
    id: number,
    patch: Record<string, string | number>,
  ) => Promise<void>;
}) {
  const [processing, setProcessing] = useState(false);
  return processing ? (
    <WetLab
      rolls={darkroomRolls(props.library, false)}
      revisions={props.revisions}
      stocks={props.library.film.stocks}
      onApply={props.onApply}
      onBack={() => setProcessing(false)}
    />
  ) : (
    <ArchiveDarkroom {...props} onProcess={() => setProcessing(true)} />
  );
}

function ArchiveDarkroom({
  library,
  revisions,
  onBack,
  onProcess,
}: {
  library: Library;
  revisions: Record<number, number>;
  onBack: () => void;
  onProcess: () => void;
}) {
  const rolls = useMemo(
    () => darkroomRolls(library),
    [library.albums, library.photos],
  );
  const [rollId, setRollId] = useState(
    () => saved("photoall-darkroom-roll") || "",
  );
  const roll =
    rolls.find(
      (item) =>
        item.key === rollId ||
        (item.part === 1 && String(item.album.id) === rollId),
    ) ||
    rolls.find((item) => item.photos.length) ||
    rolls[0];
  const [stage, setStage] = useState<Stage>("shelf"),
    [cursor, setCursor] = useState(0);
  const [pixelSize, setPixelSize] = useState(false);
  const [photoZoom, setPhotoZoom] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [parts, setParts] = useState(() => ({
    viewer: saved("photoall-darkroom-viewer") === "true",
    optical: saved("photoall-darkroom-optical") !== "false",
    sheet: saved("photoall-darkroom-sheet") === "true",
  }));
  const [returning, setReturning] = useState(false);
  const [query, setQuery] = useState(""),
    [shelfPage, setShelfPage] = useState(0);
  const [neutral, setNeutral] = useState(
    () => saved("photoall-darkroom-light") === "neutral",
  );
  const media = useMemo(
    () => window.matchMedia("(prefers-reduced-motion: reduce)"),
    [],
  );
  const [reduced, setReduced] = useState(media.matches),
    [sound, setSound] = useState(false);
  const [error, setError] = useState(""),
    [attempt, setAttempt] = useState(0),
    [loaded, setLoaded] = useState(0);
  const host = useRef<HTMLDivElement>(null),
    frameList = useRef<HTMLDivElement>(null),
    room = useRef<Room | null>(null),
    audio = useRef<AudioContext | null>(null);
  const frames = darkroomFramePage(roll?.photos || [], cursor),
    current = roll?.photos[frames.index];
  const dimensions = current
    ? photoDimensions(current)
    : { width: 0, height: 0 };
  useEffect(() => {
    setPixelSize(false);
    setPhotoZoom(1);
  }, [current?.id, stage]);
  useEffect(() => {
    const list = frameList.current;
    const selected = list?.querySelector<HTMLButtonElement>("button.selected");
    if (!list || !selected) return;
    const bounds = list.getBoundingClientRect();
    const frame = selected.getBoundingClientRect();
    list.scrollTo({
      left: list.scrollLeft + frame.left - bounds.left - (bounds.width - frame.width) / 2,
      behavior: reduced ? "instant" : "smooth",
    });
  }, [current?.id, stage, reduced]);
  const zoomPhoto = (factor: number) => {
    setPixelSize(false);
    setPhotoZoom((value) => Math.min(4, Math.max(0.5, value * factor)));
  };
  const filtered = rolls.filter((item) =>
    item.title.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / 8)),
    safePage = Math.min(shelfPage, pages - 1);
  const visible = filtered.slice(safePage * 8, safePage * 8 + 8);
  const currentState: SceneState = {
    roll,
    shelf: visible,
    frames,
    stage,
    neutral,
    reduced,
    revisions,
    parts,
  };
  const togglePart = (part: "sheet" | "viewer" | "optical") => {
    setParts((value) => {
      const next = { ...value, [part]: !value[part] };
      remember(`photoall-darkroom-${part}`, String(next[part]));
      return next;
    });
  };
  function clickSound() {
    if (!sound) return;
    try {
      audio.current ||= new AudioContext();
      const context = audio.current;
      void context.resume();
      const oscillator = context.createOscillator(),
        gain = context.createGain();
      oscillator.type = "triangle";
      oscillator.frequency.setValueAtTime(190, context.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(
        65,
        context.currentTime + 0.09,
      );
      gain.gain.setValueAtTime(0.045, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.1);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.11);
      oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
      };
    } catch {}
  }
  const chooseRoll = (id: string) => {
    if (returning) return;
    clickSound();
    setRollId(id);
    remember("photoall-darkroom-roll", String(id));
    setCursor(0);
    setStage("table");
  };
  const stow = () => {
    clickSound();
    setReturning(!!room.current && !error);
    setStage("shelf");
  };
  const viewFrame = (index: number) => {
    clickSound();
    setCursor(index);
    setStage("inspect");
  };
  const selectFrame = (index: number) => {
    if ((!parts.viewer && !parts.optical) || error || !room.current) {
      viewFrame(index);
      return;
    }
    clickSound();
    setCursor(index);
    setStage("table");
  };
  const pick = useRef<(pick: ScenePick) => void>(() => {});
  pick.current = (selection) => {
    if (selection.selectOnly && selection.frame !== undefined) {
      setCursor(selection.frame);
      return;
    }
    if (selection.frame !== undefined) {
      if (selection.viewer) viewFrame(selection.frame);
      else selectFrame(selection.frame);
    } else if (selection.rollId !== undefined) chooseRoll(selection.rollId);
  };
  useEffect(() => {
    const change = () => setReduced(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, [media]);
  useEffect(() => {
    let runtime: Room | null = null;
    setError("");
    setReturning(false);
    setZoom(1);
    try {
      runtime = makeRoom(host.current!, {
        pick: (value) => pick.current(value),
        ready: setLoaded,
        error: (message) => {
          setError(message);
          setReturning(false);
        },
        returnReady: () => setReturning(false),
        zoom: setZoom,
      });
      room.current = runtime;
      runtime.update(currentState);
    } catch {
      setError("当前设备无法开启三维场景，仍可从下方选卷查看照片。");
    }
    return () => {
      room.current = null;
      runtime?.dispose();
    };
  }, [attempt]);
  useEffect(() => {
    room.current?.update(currentState);
  }, [
    roll,
    cursor,
    stage,
    neutral,
    reduced,
    revisions,
    query,
    shelfPage,
    library,
    parts,
  ]);
  useEffect(
    () => () => {
      void audio.current?.close();
    },
    [],
  );
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        (event.target as HTMLElement).closest("input,textarea,select") ||
        event.ctrlKey ||
        event.metaKey
      )
        return;
      if (event.key === "Escape") {
        event.preventDefault();
        const menu =
          host.current?.parentElement?.querySelector<HTMLDetailsElement>(
            ".dr-parts[open]",
          );
        if (menu) {
          menu.open = false;
          return;
        }
        if (stage === "inspect") setStage("table");
        else if (stage === "table") stow();
        else onBack();
      }
      if (
        stage !== "shelf" &&
        ["ArrowLeft", "ArrowRight"].includes(event.key)
      ) {
        event.preventDefault();
        setCursor((index) =>
          Math.max(
            0,
            Math.min(
              (roll?.photos.length || 1) - 1,
              index + (event.key === "ArrowLeft" ? -1 : 1),
            ),
          ),
        );
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [stage, roll, onBack]);
  return (
    <section
      className={`darkroom dr-stage-${stage} ${neutral ? "dr-neutral" : ""} ${error ? "dr-failed" : ""}`}
      role="region"
      aria-label="独立胶片暗房"
      data-stage={stage}
    >
      <div className="dr-scene" ref={host} />
      <div className="dr-vignette" aria-hidden="true" />
      <header className="dr-header">
        <button className="dr-back" onClick={onBack}>
          <ArrowLeft size={16} />
          <span>返回工作台</span>
        </button>
        <div className="dr-wordmark">
          <Film size={19} />
          <span>
            胶片暗房<small>PHOTO ALL · DARKROOM</small>
          </span>
        </div>
        <div className="dr-utilities">
          <button aria-label="进入创作暗房" onClick={onProcess}>
            <FlaskConical size={16} />
            <span>创作暗房</span>
          </button>
          <button
            className="dr-camera-zoom"
            aria-label="重置暗房镜头距离"
            title="滚轮拉近拉远 · 点击复位"
            onClick={() => room.current?.resetZoom()}
          >
            <Maximize2 size={14} />
            <span>{Math.round(zoom * 100)}%</span>
          </button>
          <details className="dr-parts">
            <summary aria-label="选择暗房桌面部件">
              <Boxes size={16} />
              <span>桌面部件</span>
              <ChevronDown size={12} />
            </summary>
            <div
              className="dr-parts-menu"
              role="group"
              aria-label="暗房桌面部件"
            >
              <button
                aria-label="胶片观片器"
                aria-pressed={parts.optical}
                onClick={() => togglePart("optical")}
              >
                <Film size={20} />
                <span>
                  胶片观片器<small>胶片穿入 · 输片换帧</small>
                </span>
                <i aria-hidden="true" />
              </button>
              <button
                aria-label="电子观片器"
                aria-pressed={parts.viewer}
                onClick={() => togglePart("viewer")}
              >
                <View size={20} />
                <span>
                  电子观片器<small>插片 · 放大 · 背光</small>
                </span>
                <i aria-hidden="true" />
              </button>
              <button
                aria-label="接触印样"
                aria-pressed={parts.sheet}
                onClick={() => togglePart("sheet")}
              >
                <Film size={20} />
                <span>
                  接触印样<small>当前胶卷对照选片</small>
                </span>
                <i aria-hidden="true" />
              </button>
            </div>
          </details>
          <button
            title={neutral ? "切换氛围灯" : "切换中性灯"}
            aria-label="暗房灯光切换"
            aria-pressed={neutral}
            onClick={() => {
              setNeutral((value) => !value);
              remember("photoall-darkroom-light", neutral ? "warm" : "neutral");
            }}
          >
            {neutral ? <Sun size={16} /> : <Moon size={16} />}
            <span>{neutral ? "中性灯" : "氛围灯"}</span>
          </button>
          <button
            aria-label="暗房声音开关"
            aria-pressed={sound}
            title={sound ? "关闭声音" : "打开声音"}
            onClick={() => setSound((value) => !value)}
          >
            {sound ? <Volume2 size={16} /> : <VolumeX size={16} />}
          </button>
          <button aria-label="退出胶片暗房" title="退出暗房" onClick={onBack}>
            <X size={19} />
          </button>
        </div>
      </header>
      <div className="dr-scene-caption">
        <span>
          {stage === "shelf"
            ? "01 / THE ARCHIVE"
            : stage === "inspect"
              ? "03 / THE FRAME"
              : "02 / THE TABLE"}
        </span>
        <span>
          {rolls.length} 卷 ·{" "}
          {rolls.reduce((total, item) => total + item.photos.length, 0)} 帧
        </span>
      </div>
      {error && (
        <div className="dr-recovery" role="status">
          <p>{error}</p>
          <button onClick={() => setAttempt((value) => value + 1)}>
            <RotateCcw size={14} />
            重新加载场景
          </button>
        </div>
      )}
      {stage === "shelf" && (
        <div className="dr-intro">
          <span>THE PERSONAL ARCHIVE</span>
          <h1>把记忆，收进一卷胶片。</h1>
          <p>
            {rolls.length
              ? "选一卷，回到那一天。"
              : "先创建图集并导入照片，在这里展开你的第一卷。"}
          </p>
        </div>
      )}
      {stage === "inspect" && current && (
        <div
          className="dr-photo-viewer"
          role="dialog"
          aria-label="暗房照片查看"
        >
          <button
            className="dr-close-photo"
            aria-label="回到暗房桌面"
            onClick={() => setStage("table")}
          >
            <X size={19} />
          </button>
          <div className={`dr-photo-mat ${pixelSize ? "is-pixel" : "is-fit"}`}>
            <div
              className="dr-photo-content"
              style={
                pixelSize
                  ? {
                      width: dimensions.width / (window.devicePixelRatio || 1),
                      height:
                        dimensions.height / (window.devicePixelRatio || 1),
                    }
                  : { width: `${photoZoom * 100}%`, height: `${photoZoom * 100}%` }
              }
            >
              <Picture
                photo={current}
                size={0}
                revision={revisions[current.id]}
                quality="source"
                eager
              />
            </div>
          </div>
          <div className="dr-photo-caption">
            <span>{current.name}</span>
            <div className="dr-photo-zoom">
              <button aria-label="缩小暗房照片" disabled={!pixelSize && photoZoom <= 0.5} onClick={() => zoomPhoto(0.8)}><Minus size={14} /></button>
              <button aria-label="适合窗口" onClick={() => { setPixelSize(false); setPhotoZoom(1); }}>
                {pixelSize ? "适合窗口" : `${Math.round(photoZoom * 100)}%`}
              </button>
              <button aria-label="放大暗房照片" disabled={!pixelSize && photoZoom >= 4} onClick={() => zoomPhoto(1.25)}><Plus size={14} /></button>
              <button className="dr-pixel-toggle" aria-label="按原像素查看" aria-pressed={pixelSize} onClick={() => setPixelSize((value) => !value)}>
                1:1 像素
              </button>
            </div>
            <span>
              {frames.index + 1} / {roll!.photos.length}
            </span>
          </div>
          <button
            className="dr-photo-prev"
            aria-label="暗房上一张照片"
            disabled={frames.index === 0}
            onClick={() => setCursor(frames.index - 1)}
          >
            <ChevronLeft size={28} />
          </button>
          <button
            className="dr-photo-next"
            aria-label="暗房下一张照片"
            disabled={frames.index >= roll!.photos.length - 1}
            onClick={() => setCursor(frames.index + 1)}
          >
            <ChevronRight size={28} />
          </button>
        </div>
      )}
      {stage !== "shelf" && (
        <aside className="dr-roll-title">
          <span>ROLL {roll?.number || "—"}</span>
          <h1>{roll?.title || "尚无胶卷"}</h1>
          <p>
            {roll?.photos.length || 0} 帧 · {loaded}/{frames.photos.length}{" "}
            张就绪
          </p>
        </aside>
      )}
      <div className="dr-dock-zone">
        <footer className="dr-dock" aria-label="暗房底部导航，靠近下边缘展开">
          {stage === "shelf" ? (
            <>
              <div className="dr-dock-heading">
                <div>
                  <Film size={15} />
                  <span>{returning ? "正在收回卷架" : "我的胶卷"}</span>
                  <b>{rolls.length}</b>
                </div>
                <label className="dr-search">
                  <Search size={14} />
                  <input
                    aria-label="搜索暗房胶卷"
                    placeholder="寻找一卷记忆"
                    disabled={returning}
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setShelfPage(0);
                    }}
                  />
                </label>
              </div>
              <div
                className="dr-roll-list"
                role="group"
                aria-label="暗房胶卷选择"
              >
                {visible.map((item) => (
                  <button
                    className={`dr-roll-choice ${item.key === roll?.key ? "selected" : ""}`}
                    key={item.key}
                    aria-label={`展开胶卷 ${item.title}`}
                    disabled={returning}
                    onClick={() => chooseRoll(item.key)}
                  >
                    <span
                      className="dr-mini-canister"
                      style={
                        {
                          "--roll-color":
                            palette[(item.album.id - 1) % palette.length],
                        } as React.CSSProperties
                      }
                    >
                      <i />
                      <b>{item.number}</b>
                    </span>
                    <span>
                      {item.title}
                      <small>{item.photos.length} 帧</small>
                    </span>
                    <ArrowRight size={14} />
                  </button>
                ))}
                {!visible.length && (
                  <div className="dr-empty">
                    {rolls.length ? "没有匹配的胶卷" : "还没有胶卷"}
                    <button onClick={onBack}>返回图集</button>
                  </div>
                )}
              </div>
              <div className="dr-dock-bottom">
                <span>图集作为胶卷展示 · 原片与编辑配方保留</span>
                <div>
                  <button
                    aria-label="上一页胶卷"
                    disabled={returning || safePage === 0}
                    onClick={() => setShelfPage(safePage - 1)}
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <span>
                    {safePage + 1} / {pages}
                  </span>
                  <button
                    aria-label="下一页胶卷"
                    disabled={returning || safePage >= pages - 1}
                    onClick={() => setShelfPage(safePage + 1)}
                  >
                    <ChevronRight size={14} />
                  </button>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="dr-dock-heading">
                <button
                  className="dr-stow"
                  aria-label="收回暗房胶卷"
                  onClick={stow}
                >
                  <RotateCcw size={15} />
                  收回卷架
                </button>
                <span className="dr-strip-count">
                  {roll?.photos.length || 0} / 36 帧 · {roll?.part || 1}/
                  {roll?.parts || 1} 卷
                </span>
                <button
                  className="dr-open-photo"
                  disabled={!current}
                  onClick={() => viewFrame(frames.index)}
                >
                  <Maximize2 size={15} />
                  查看照片
                </button>
              </div>
              <div
                className="dr-frame-list"
                ref={frameList}
                role="group"
                aria-label="暗房胶片帧"
              >
                {frames.photos.map((photo, i) => (
                  <button
                    key={photo.id}
                    aria-label={`选择暗房照片 ${frames.start + i + 1}`}
                    className={
                      frames.index === frames.start + i ? "selected" : ""
                    }
                    onClick={() => selectFrame(frames.start + i)}
                  >
                    <Picture
                      photo={photo}
                      size={240}
                      revision={revisions[photo.id]}
                    />
                    <span>{String(frames.start + i + 1).padStart(2, "0")}</span>
                  </button>
                ))}
                {!frames.photos.length && (
                  <div className="dr-empty">
                    这是一卷空胶片
                    <button onClick={onBack}>返回图集导入照片</button>
                  </div>
                )}
              </div>
              <div className="dr-dock-bottom">
                <span>
                  滚轮拉近拉远 · ← → 翻片 · Esc 返回
                  {reduced ? " · 已减弱动效" : ""}
                </span>
                <span>环境灯光只用于展示</span>
              </div>
            </>
          )}
        </footer>
      </div>
    </section>
  );
}
