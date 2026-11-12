// SPDX-License-Identifier: GPL-3.0-or-later
/// <reference types="vite/client" />
// The darkroom is a view of the library. Its lights and geometry never edit recipes.
import React, { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
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
  Minimize2,
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
  BROWSE_PREVIEW_SIZE,
  isRaw,
  viewerFullscreen,
} from "./model";
import { Picture } from "./Preview";
import { makeAcrylicScene } from "./AcrylicScene";
import "./darkroom.css";
import { WetLab } from "./WetLab";
import { CASSETTE_PRESETS, cassetteAppearance, mountFilmCassette, paintCassette, type CassetteFields } from "./FilmCassette";
import type { CassetteAppearance } from "./FilmCassette";
import mantelClockUrl from "./assets/mantel-clock.glb?url";
import collectionCameraUrl from "./assets/collection-camera.glb?url";

const creativeDarkroomEnabled = import.meta.env.VITE_PHOTOALL_CREATIVE_DARKROOM !== "0";

export type DarkroomRoll = {
  album: Album;
  photos: Photo[];
  number: string;
  key: string;
  title: string;
  part: number;
  parts: number;
  cassette?: CassetteAppearance;
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
export const COLLECTION_CAPACITY = 14;
type CollectionShelf = { id: string; name: string; rollKeys: string[] };
const collectionKey = "photoall-collection-shelves-v1";
export function collectionSlot(index: number) {
  return { x: -5.82 + (Math.max(0, index) % 7) * 1.94, y: SHELF_Y[index < 7 ? 0 : 1], z: -3.2 };
}
// Stable membership survives renaming, new imports and deleted albums. Never changes the library.
export function collectionShelves(keys: string[], stored: unknown): CollectionShelf[] {
  const valid = new Set(keys), used = new Set<string>(), ids = new Set<string>();
  const shelves: CollectionShelf[] = [];
  if (Array.isArray(stored)) for (const item of stored) {
    if (!item || typeof item.id !== "string" || !item.id || ids.has(item.id) || !Array.isArray(item.rollKeys)) continue;
    ids.add(item.id);
    const rollKeys: string[] = [];
    for (const key of item.rollKeys) if (valid.has(key) && !used.has(key) && rollKeys.length < COLLECTION_CAPACITY) {
      used.add(key); rollKeys.push(key);
    }
    shelves.push({ id: item.id, name: typeof item.name === "string" && item.name.trim()
      ? item.name.trim().slice(0, 32) : `胶片架 ${String(shelves.length + 1).padStart(2, "0")}`, rollKeys });
  }
  const append = () => {
    let number = shelves.length + 1;
    while (ids.has(`shelf-${number}`)) number++;
    const shelf = { id: `shelf-${number}`, name: `胶片架 ${String(number).padStart(2, "0")}`, rollKeys: [] as string[] };
    ids.add(shelf.id); shelves.push(shelf); return shelf;
  };
  if (!shelves.length) append();
  for (const key of valid) if (!used.has(key)) {
    const shelf = shelves.find(s => s.rollKeys.length < COLLECTION_CAPACITY) ?? append();
    shelf.rollKeys.push(key); used.add(key);
  }
  return shelves;
}
export function moveCollectionRoll(shelves: CollectionShelf[], key: string, target: string): CollectionShelf[] {
  const destination = shelves.find(s => s.id === target);
  if (!destination || destination.rollKeys.includes(key) || destination.rollKeys.length >= COLLECTION_CAPACITY ||
    !shelves.some(s => s.rollKeys.includes(key))) return shelves;
  return shelves.map(s => ({ ...s, rollKeys: s.id === target ? [...s.rollKeys, key] : s.rollKeys.filter(k => k !== key) }));
}
const FILM_ORIGIN = {
  x: TABLE.x + DARKROOM_FILM.exit.x,
  y: TABLE.y + DARKROOM_FILM.exit.y,
  z: TABLE.z + DARKROOM_FILM.exit.z,
};
const opticalDistance = DARKROOM_FILM.leader + DARKROOM_FILM.cell / 2;
export function darkroomFilmGuide(distance: number, strength: number) {
  return strength * (1 - THREE.MathUtils.smoothstep(Math.abs(distance - opticalDistance), .92, 1.4));
}
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
  environment: "archive" | "acrylic";
  roll?: DarkroomRoll;
  shelf: DarkroomRoll[];
  shelfId: string;
  shelfIndex: number;
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
  control?: "lever" | "previous" | "next";
  controlDelta?: number;
};
type Room = {
  update: (state: SceneState) => void;
  resetZoom: () => void;
  dispose: () => void;
};
export function darkroomViewerParts(parts: SceneState["parts"], viewer: "optical" | "viewer") {
  return { ...parts, optical: viewer === "optical" && !parts.optical, viewer: viewer === "viewer" && !parts.viewer };
}
export function darkroomLeverStep(dx: number, dy: number) {
  if (Math.hypot(dx, dy) < 6) return 1;
  return (Math.abs(dy) >= Math.abs(dx) ? dy : -dx) >= 0 ? 1 : -1;
}
const cassetteSettingsKey = "photoall-darkroom-cassettes";
const cassetteSignature = (roll: DarkroomRoll) => JSON.stringify([roll.key, roll.title, roll.photos.length, roll.cassette]);
function paintRollLabel(context: CanvasRenderingContext2D, roll: DarkroomRoll) {
  const appearance = roll.cassette ?? cassetteAppearance();
  paintCassette(context, appearance, CASSETTE_PRESETS[appearance.style].body, roll.title,
    `135  /  ROLL ${roll.number}  /  ${roll.photos.length} EXP`, true);
}
function cassetteThumbnail(roll: DarkroomRoll) {
  const label = canvas(1024, 512);
  paintRollLabel(label.context, roll);
  const thumb = canvas(108, 148);
  thumb.context.drawImage(label.element, 328, 0, 368, 512, 0, 0, 108, 148);
  return thumb.element.toDataURL();
}
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
    shelfBusy: (value: boolean) => void;
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
  renderer.domElement.setAttribute("aria-label", "胶片收藏室三维场景");
  renderer.domElement.setAttribute("role", "img");
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#100d0a");
  scene.fog = new THREE.FogExp2("#100d0a", 0.025);
  const archive = new THREE.Group();
  scene.add(archive);
  const acrylic = makeAcrylicScene(renderer, Math.min(16, renderer.capabilities.getMaxAnisotropy()));
  scene.add(acrylic.root);
  let environment: SceneState["environment"] = "archive", environmentPhase = 1;
  let lightPhase: number | undefined;
  const neutralWhite = new THREE.Color("#ffffff"), neutralRim = new THREE.Color("#dbe3df");
  const neutralFill = new THREE.Color("#e9f1ef"), warmKey = new THREE.Color("#ffd49c");
  const warmRim = new THREE.Color("#ff9d4f"), warmFill = new THREE.Color("#dcd6b8");
  const warmProp = new THREE.Color("#ffdab0"), warmRoom = new THREE.Color("#100d0a");
  const coolRoom = new THREE.Color("#171c1b");
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
    lastFeed = NaN,
    lastGuide = NaN;
  let viewerPhotoKey = "";
  let drag: { id: number; x: number; feed: number; moved: boolean } | null =
    null;
  let orbitDrag: { id: number; x: number; y: number } | null = null;
  let controlDrag: { id: number; control: NonNullable<ScenePick["control"]> } | null = null;
  let leverAngle = 0;
  let leverReleaseAngle = 0;
  let pressedControl: ScenePick["control"];
  let controlPressedAt = 0;
  const dragPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -FILM_ORIGIN.z);
  const dragPoint = new THREE.Vector3();
  let frameKey = "",
    shelfKey = "",
    activeRollKey = "",
    controller = new AbortController();
  let strip = new THREE.Group(),
    cartridge = new THREE.Group(),
    shelves = new THREE.Group();
  const rack = new THREE.Group();
  let rackPhase = 1, rackDirection = 1, rackChanged = false;
  let pendingShelf: SceneState | null = null;
  archive.add(rack);
  const bendable: {
    geometry: THREE.PlaneGeometry;
    x: number;
    y: number;
    z: number;
  }[] = [];
  const mouseLean = new THREE.Vector2(),
    cameraBase = new THREE.Vector3();
  const orbit = new THREE.Vector2();
  const cameraOrbit = new THREE.Spherical();
  const viewerAim = new THREE.Vector3();
  const viewerOffset = new THREE.Vector3();
  const cameraTarget = new THREE.Vector3();
  const projectedControl = new THREE.Vector3();
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
      if (!(node instanceof THREE.Mesh) && !(node instanceof THREE.Line)) return;
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
  const leftWallX = -14.5;
  box(archive, [27, 0.4, 17], [-1, -0.42, 0], woodMaterial);
  const wall = mesh(
    new THREE.PlaneGeometry(32, 15),
    new THREE.MeshStandardMaterial({ color: "#29291f", roughness: 1 }),
    archive,
    0,
    5.5,
    -5,
  );
  wall.receiveShadow = true;
  const sideWall = mesh(new THREE.PlaneGeometry(15, 15), wall.material,
    archive, leftWallX, 5.5, 2.5);
  sideWall.rotation.y = Math.PI / 2;
  // The back rack is real geometry; the cartridges cast shadows onto its ledges.
  for (const y of [0.18, 3.01]) {
    box(rack, [14.6, 0.18, 1.45], [0, y, -3.25], woodMaterial);
    box(rack, [14.6, 0.25, 0.12], [0, y - 0.1, -2.5], materials.black);
    box(rack, [14.45, .035, .035], [0, y + .05, -2.425], materials.brass);
    box(rack, [14.35, .16, .065], [0, y + .17, -3.92], woodMaterial);
    for (let slot = 0; slot < 7; slot++) {
      const number = canvas(192, 64, 2);
      number.context.fillStyle = "#3c2c1e"; number.context.fillRect(0, 0, 192, 64);
      number.context.fillStyle = "#d9bd84"; number.context.font = "26px Georgia"; number.context.textAlign = "center";
      number.context.fillText(String(slot + (y > 1 ? 1 : 8)).padStart(2, "0"), 96, 42);
      mesh(new THREE.PlaneGeometry(.38, .126), new THREE.MeshStandardMaterial({ map: texture(number.element), roughness: .72 }),
        rack, collectionSlot(slot).x, y - .08, -2.432);
    }
  }
  for (const x of [-7.1, 7.1]) {
    box(rack, [0.19, 6.2, 0.7], [x, 2.7, -3.9], woodMaterial);
    for (const y of [.18, 3.01]) {
      box(rack, [.32, .4, .11], [x, y + .12, -3.49], materials.black);
      for (const dy of [-.09, .15]) {
        const pin = mesh(new THREE.CylinderGeometry(.045, .045, .015, 12), materials.brass, rack, x, y + dy, -3.42);
        pin.rotation.x = Math.PI / 2;
      }
    }
  }
  // A quiet leather work surface frames the instruments without tinting photographs.
  const leather = new THREE.MeshStandardMaterial({ color: "#30221b", roughness: .98 });
  box(archive, [9.1, .018, 4.9], [-.4, -.208, .7], leather);
  for (const z of [-1.67, 3.07])
    for (let i = 0; i < 62; i++) box(archive, [.052, .003, .007], [-4.75 + i * .14, -.196, z], materials.brass);
  // Poly Haven's Mantel Clock 01 (CC0), bundled with its original material maps.
  const clockLight = new THREE.SpotLight("#ffdab0", 15, 5.5, .46, .85, 2);
  clockLight.position.set(6.3, 2.05, -.15);
  clockLight.target.position.set(8.6, .3, -2.55);
  const clockLoader = new GLTFLoader().register((parser) => {
    // Embedded images use the existing img-src policy via TextureLoader.
    parser.textureLoader = new THREE.TextureLoader(parser.options.manager);
    return { name: "PhotoAllClockTextures" };
  });
  clockLoader.load(mantelClockUrl, ({ scene: clock }) => {
    if (disposed) {
      release(clock);
      return;
    }
    clock.position.set(8.6, 0, -2.55);
    clock.scale.setScalar(6.5);
    clock.rotation.y = THREE.MathUtils.degToRad(-25);
    clock.position.y = -.215 - new THREE.Box3().setFromObject(clock, true).min.y;
    clock.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      node.castShadow = !node.name.endsWith("_glass");
      node.receiveShadow = node.castShadow;
    });
    archive.add(clock, clockLight, clockLight.target);
    host.dataset.clock = "ready";
    wake();
  }, undefined, () => { host.dataset.clock = "unavailable"; });
  clockLoader.load(collectionCameraUrl, ({ scene: prop }) => {
    if (disposed) { release(prop); return; }
    prop.scale.setScalar(18);
    prop.rotation.y = THREE.MathUtils.degToRad(23);
    const bounds = new THREE.Box3().setFromObject(prop, true);
    const center = bounds.getCenter(new THREE.Vector3());
    prop.position.set(-9 - center.x, -.215 - bounds.min.y, -2.1 - center.z);
    prop.traverse(node => { if (node instanceof THREE.Mesh) {
      node.castShadow = !node.name.toLowerCase().includes("glass"); node.receiveShadow = true;
      for (const mat of Array.isArray(node.material) ? node.material : [node.material])
        for (const value of Object.values(mat)) if (value instanceof THREE.Texture)
          value.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    } });
    archive.add(prop); host.dataset.cameraProp = "ready"; wake();
  }, undefined, () => { host.dataset.cameraProp = "unavailable"; });
  const propLight = new THREE.SpotLight("#ffdab0", 28, 8, .55, .9, 2);
  propLight.position.set(-7, 4.5, 1); propLight.target.position.set(-9, .7, -2.1);
  archive.add(propLight, propLight.target);
  archive.add(strip, cartridge);
  rack.add(shelves);

  function fillShelf(next: SceneState) {
    release(shelves); rack.remove(shelves); shelves = new THREE.Group(); rack.add(shelves);
    next.shelf.forEach((roll, i) => {
      const object = makeCartridge(roll), slot = collectionSlot(i);
      object.position.set(slot.x, slot.y, slot.z); shelves.add(object);
    });
    host.dataset.shelfId = next.shelfId;
    host.dataset.shelfCount = String(next.shelf.length);
  }

  function makeCartridge(roll: DarkroomRoll, closeUp = false) {
    const group = new THREE.Group();
    group.userData.rollId = roll.key;
    const label = canvas(1024, 512, Math.min(closeUp ? 2 : 1.25, maxTextureSize / 1024));
    paintRollLabel(label.context, roll);
    mountFilmCassette(group, mesh, texture(label.element), {
      mouth: { ...DARKROOM_FILM.exit, height: DARKROOM_FILM.height },
      bodyHeight: DARKROOM_FILM.bodyHeight,
      labelLight: .16,
    });
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
    new THREE.MeshBasicMaterial({
      map: sheetTexture,
      toneMapped: false,
      fog: false,
      side: THREE.DoubleSide,
    }),
    archive,
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
  function screw(parent: THREE.Object3D, x: number, y: number, z: number) {
    const head = mesh(new THREE.CylinderGeometry(.025, .025, .014, 16), materials.brass, parent, x, y, z);
    head.rotation.x = Math.PI / 2;
    box(parent, [.032, .004, .003], [x, y, z + .009], materials.black);
  }
  const viewer = new THREE.Group();
  viewer.name = "desktop-slide-viewer";
  archive.add(viewer);
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
  for (const x of [-1.04, 1.04]) for (const y of [-.76, .76]) screw(viewerFace, x, y, .412);
  for (let i = 0; i < 8; i++) {
    box(viewerFace, [.1, .018, .008], [-.53 + i * .15, -.75, .413], materials.black);
    box(viewer, [.012, .018, .65], [1.18, .19 + i * .035, -.05], materials.felt);
  }
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
  const stepKeys = (["previous", "next"] as const).map((control, i) => {
    const key = mesh(new THREE.CylinderGeometry(0.093, 0.093, 0.045, 24),
      i ? materials.brass : materials.shell, viewerFace, 0.66 + i * 0.29, -0.71, 0.44);
    key.rotation.x = Math.PI / 2;
    key.userData.control = control;
    const arrow = new THREE.Shape();
    const direction = i ? 1 : -1;
    arrow.moveTo(direction * .036, 0);
    arrow.lineTo(-direction * .023, .031);
    arrow.lineTo(-direction * .023, -.031);
    arrow.closePath();
    const symbol = mesh(new THREE.ShapeGeometry(arrow),
      new THREE.MeshBasicMaterial({ color: i ? "#261c14" : "#f2e2c8", toneMapped: false }),
      key, 0, .023, 0);
    symbol.rotation.x = -Math.PI / 2;
    symbol.castShadow = false;
    return key;
  });
  for (let i = 0; i < 7; i++)
    box(
      viewer,
      [0.018, 0.055, 0.37],
      [-0.28 + i * 0.08, 0.18, 0.61],
      materials.felt,
    );
  const viewerGlow = new THREE.PointLight(0xffb68e, 0, 3, 2);
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
  const opticalX = FILM_ORIGIN.x + opticalDistance;
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
  archive.add(optical);
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
  // Recessed seams, fasteners and film guides sit outside the image aperture.
  for (const x of [-1.015, 1.015]) for (const y of [-.85, .85]) screw(optical, x, y, .282);
  for (const y of [-.815, .815]) {
    box(optical, [2.28, .026, .055], [0, y, -.08], materials.brass);
    box(optical, [2.12, .013, .02], [0, y, -.045], materials.felt);
  }
  const guideMarks = canvas(768, 64, 2);
  guideMarks.context.strokeStyle = "#b99d6b";
  guideMarks.context.fillStyle = "#d4bc89";
  guideMarks.context.font = "18px monospace";
  guideMarks.context.fillText("PHOTO ALL    PRECISION FILM READER", 50, 23);
  for (let i = 0; i < 37; i++) {
    const x = 36 + i * 19;
    guideMarks.context.beginPath(); guideMarks.context.moveTo(x, 61);
    guideMarks.context.lineTo(x, i % 6 ? 49 : 37); guideMarks.context.stroke();
  }
  const graduations = mesh(new THREE.PlaneGeometry(1.65, .14), new THREE.MeshBasicMaterial({
    map: texture(guideMarks.element), transparent: true, toneMapped: false, depthWrite: false,
  }), optical, 0, .815, .28);
  graduations.castShadow = false;
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
  crank.userData.control = "lever";
  optical.add(crank);
  // Bolt the rotating axle to the housing, in front of the film path.
  box(optical, [.31, .18, .16], [1.19, -.25, .165], enamel);
  const bearing = mesh(new THREE.CylinderGeometry(.123, .123, .105, 24),
    materials.brass, optical, 1.3, -.25, .22);
  bearing.rotation.x = Math.PI / 2;
  for (let i = 0; i < 12; i++) {
    const angle = i / 12 * Math.PI * 2;
    const tooth = box(optical, [.025, .04, .022], [1.3 + Math.cos(angle) * .13, -.25 + Math.sin(angle) * .13, .27], materials.shell);
    tooth.rotation.z = angle - Math.PI / 2;
  }
  const hub = mesh(
    new THREE.CylinderGeometry(0.095, 0.095, 0.09, 24),
    materials.shell,
    crank, 0, 0, .045,
  );
  hub.rotation.x = Math.PI / 2;
  box(crank, [0.055, 0.37, 0.06], [0, -0.16, 0.02], materials.shell);
  const leverGrip = mesh(
    new THREE.SphereGeometry(0.12, 24, 18),
    new THREE.MeshStandardMaterial({ color: "#a63b2d", roughness: 0.32 }),
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
    ctx.fillStyle = "#f2e2c8";
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
    if (state) acrylic.update(state.frames.photos, state.frames.start, state.frames.index, sheetImages);
    wake();
  }
  function buildStrip() {
    controller.abort();
    controller = new AbortController();
    const signal = controller.signal;
    release(strip);
    archive.remove(strip);
    strip = new THREE.Group();
    archive.add(strip);
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
    const sourceQueue: (() => Promise<void>)[] = [];
    const cameraQueue: (() => Promise<void>)[] = [];
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
      let exactReady = false;
      const load = async (quality: "source" | "camera") => {
        if (exactReady) return;
        try {
          const blob = await photoBlob(
            photo,
            quality === "source" ? imageWidth : BROWSE_PREVIEW_SIZE,
            false,
            signal,
            current.revisions[photo.id] || 0,
            quality,
          );
          if (signal.aborted || disposed || exactReady) return;
          const bitmap = await createImageBitmap(blob);
          if (signal.aborted || disposed || exactReady) {
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
          mat.map?.dispose();
          mat.map = texture(image.element);
          mat.color.set("#ffffff");
          mat.needsUpdate = true;
          sheetImages.set(photo.id, image.element);
          if (quality === "source") {
            exactReady = true;
            events.ready(++loading);
          }
          drawSheet();
        } catch (error) {
          if (quality === "source" && !signal.aborted && !disposed) {
            loadErrors++;
            host.dataset.photoErrors = String(loadErrors);
          }
        }
      };
      if (i === frames.index) sourceQueue.unshift(() => load("source"));
      else sourceQueue.push(() => load("source"));
      if (isRaw(photo)) cameraQueue.push(() => load("camera"));
    });
    const drain = (queue: (() => Promise<void>)[], workers: number) => {
      for (let i = 0; i < Math.min(workers, queue.length); i++)
        void (async () => {
          while (queue.length && !signal.aborted && !disposed)
            await queue.shift()!();
        })();
    };
    // A RAW roll keeps one source slot free for opening the selected frame.
    drain(cameraQueue, 2);
    drain(sourceQueue, frames.photos.some(isRaw) ? 1 : 2);
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
        const guide = darkroomFilmGuide(distance, opticalProgress);
        const rise = Math.sin(distance * .36) * .035 * soften;
        const depth = -Math.sin(distance * .42) * .2 * soften;
        positions.setXYZ(
          i,
          x,
          piece.y +
            (0.5 - v) * original.height +
            THREE.MathUtils.lerp(rise, opticalY - FILM_ORIGIN.y, guide),
          piece.z + THREE.MathUtils.lerp(depth, opticalZ - FILM_ORIGIN.z, guide),
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
    const environmentGoal = environment === state.environment ? 1 : 0;
    const transitionDuration = environmentGoal === 0 ? .66 : .82;
    const transitionStep = Math.min(dt, .05) / transitionDuration;
    environmentPhase = state.reduced ? environmentGoal : THREE.MathUtils.clamp(
      environmentPhase + Math.sign(environmentGoal - environmentPhase) * transitionStep, 0, 1);
    const changingSet = environmentPhase === 0 && environment !== state.environment;
    if (environmentPhase === 0 && environment !== state.environment) {
      environment = state.environment;
      if (state.reduced) environmentPhase = 1;
      zoom = 1; orbit.set(0, 0); events.zoom(1);
    }
    const archivePhase = environment === "archive" ? environmentPhase : 0;
    archive.visible = archivePhase > 0;
    const withdraw = 1 - THREE.MathUtils.smootherstep(archivePhase, 0, 1);
    archive.position.set(-.55 * withdraw, -.32 * withdraw, -.8 * withdraw);
    const visibility = .5 - .5 * Math.cos(Math.PI * environmentPhase);
    renderer.domElement.style.opacity = String(visibility);
    // Both sets meet at the same warm grey and identical vignette at the handoff.
    const galleryLight = environment === "acrylic" ? (1 + visibility) / 2 : (1 - visibility) / 2;
    host.parentElement?.style.setProperty("--dr-gallery-light", String(galleryLight));
    acrylic.animate(environment === "acrylic" ? environmentPhase : 0);
    for (const lamp of [hemi,key,rim,fill]) lamp.visible = environment === "archive";
    const lightGoal = Number(state.neutral);
    if (lightPhase === undefined || state.reduced) lightPhase = lightGoal;
    else lightPhase += Math.sign(lightGoal - lightPhase) * Math.min(Math.abs(lightGoal - lightPhase), Math.min(dt,.05) / .8);
    const blend = THREE.MathUtils.smootherstep(lightPhase, 0, 1);
    key.color.lerpColors(warmKey, neutralWhite, blend);
    rim.color.lerpColors(warmRim, neutralRim, blend);
    hemi.color.lerpColors(warmFill, neutralFill, blend);
    clockLight.color.lerpColors(warmProp, neutralFill, blend);
    propLight.color.copy(clockLight.color);
    acrylic.light(blend);
    renderer.toneMappingExposure = 1.18 + .02 * blend;
    const background = scene.background as THREE.Color;
    if (environment === "acrylic") background.set("#babbb4");
    else background.lerpColors(warmRoom, coolRoom, blend);
    scene.fog!.color.copy(scene.background as THREE.Color);
    host.dataset.environment = environment;
    host.dataset.sceneTransition = environmentPhase < 1 || environment !== state.environment ? "moving" : "idle";
    if (rackPhase < 1 && pendingShelf) {
      rackPhase = state.reduced ? 1 : Math.min(1, rackPhase + dt / .72);
      if (rackPhase >= .5 && !rackChanged) { fillShelf(pendingShelf); rackChanged = true; }
      const ease = (t: number) => t * t * (3 - 2 * t);
      rack.position.x = rackPhase < .5 ? -rackDirection * 19 * ease(rackPhase * 2)
        : rackDirection * 19 * (1 - ease((rackPhase - .5) * 2));
      if (rackPhase === 1) { pendingShelf = null; events.shelfBusy(false); }
    }
    host.dataset.shelfMotion = rackPhase < 1 ? "moving" : "idle";
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
    strip.visible = motion.film > 0.001;
    const slot = state.shelf.findIndex((item) => item.key === state!.roll?.key);
    const origin = collectionSlot(Math.max(0, slot));
    home.set(origin.x, origin.y, origin.z);
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
    // Withdraw the outgoing instrument before the next one enters the table.
    const viewerGoal = state.parts.viewer && opticalProgress === 0 ? motion.paper : 0;
    const opticalGoal = state.parts.optical && viewerProgress === 0 ? motion.travel : 0;
    viewerProgress = approach(viewerProgress, viewerGoal, 0.45);
    opticalProgress = approach(opticalProgress, opticalGoal, 0.55);
    if (strip.position.x !== lastFeed || opticalProgress !== lastGuide) {
      lastFeed = strip.position.x;
      lastGuide = opticalProgress;
      setPositions(lastFeed);
    }
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
    const pressTime = Math.max(0, Math.min(1, (now - controlPressedAt) / 240));
    const press = state.reduced ? 0 : Math.sin(pressTime * Math.PI);
    const leverReturn = state.reduced ? 0 : leverReleaseAngle * (1 - pressTime) ** 2;
    crank.rotation.z = controlDrag?.control === "lever" ? leverAngle
      : pressedControl === "lever" ? (leverReleaseAngle ? leverReturn : -press * .48) : 0;
    rollers.forEach((roller) => {
      roller.rotation.y = strip.position.x / 0.04;
    });
    const slideGoal = state.parts.viewer && viewerProgress > 0.7 ? 1 : 0;
    slideProgress = approach(slideProgress, slideGoal, 0.8);
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
    screenLight = screenTarget;
    const backlight = screenLight;
    viewerImageMaterial.color.setScalar(backlight);
    viewerGlow.intensity = backlight * 1.2;
    stepKeys.forEach((key) => {
      key.position.z = 0.44 - (key.userData.control === pressedControl ? 0.029 * press : 0);
    });
    if (state.stage === "shelf" && progress === 0 && !atShelf) {
      atShelf = true;
      events.returnReady();
    }
    const focus = state.stage === "table"
      ? (state.parts.optical ? opticalProgress : state.parts.viewer ? viewerProgress : 0)
        * THREE.MathUtils.smoothstep(motion.film, .25, 1)
      : 0;
    const focusOptical = state.parts.optical;
    viewerAim.set(focusOptical ? opticalX : viewer.position.x, focusOptical ? opticalY + .02 : .88,
      focusOptical ? opticalZ + .28 : 2.95);
    viewerOffset.set(focusOptical ? 0 : -.39, focusOptical ? .36 : 1.4, focusOptical ? 5.1 : 4.55)
      .multiplyScalar(Math.max(1, 1.28 / camera.aspect));
    cameraTarget.copy(desiredAim).lerp(viewerAim, focus);
    cameraBase.copy(desiredCamera).sub(desiredAim);
    if (state.stage === "shelf") cameraBase.multiplyScalar(Math.max(1, 1.65 / camera.aspect));
    cameraBase.lerp(viewerOffset, focus);
    if (environment === "acrylic") {
      cameraTarget.set(.25,1.18,0);
      cameraBase.set(3.15,2.15,12.8).multiplyScalar(Math.max(1,1.75/camera.aspect));
    }
    cameraOrbit.setFromVector3(cameraBase);
    cameraOrbit.theta += orbit.x;
    cameraOrbit.phi = THREE.MathUtils.clamp(cameraOrbit.phi + orbit.y, .63, 1.63);
    cameraOrbit.radius /= zoom;
    cameraBase.setFromSpherical(cameraOrbit).add(cameraTarget);
    if (!state.reduced && !orbitDrag && focus < 1) {
      cameraBase.x += mouseLean.x * 0.13;
      cameraBase.y += mouseLean.y * 0.07;
    }
    const cameraStep = changingSet ? 1 : step;
    camera.position.lerp(cameraBase, orbitDrag ? 1 : cameraStep);
    aim.lerp(cameraTarget, cameraStep);
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
    host.dataset.viewerFocus = focus.toFixed(4);
    host.dataset.orbit = orbit.toArray().map((angle) => angle.toFixed(4)).join(",");
    function controlLocation(object: THREE.Object3D) {
      object.getWorldPosition(projectedControl).project(camera);
      return [(projectedControl.x + 1) * host.clientWidth / 2,
        (1 - projectedControl.y) * host.clientHeight / 2].map((px) => Math.round(px)).join(",");
    }
    host.dataset.lever = opticalProgress === 1 ? controlLocation(leverGrip) : "";
    host.dataset.previousKey = viewerProgress === 1 ? controlLocation(stepKeys[0]) : "";
    host.dataset.nextKey = viewerProgress === 1 ? controlLocation(stepKeys[1]) : "";
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
      lightPhase !== lightGoal ||
      environmentPhase < 1 || environment !== state.environment ||
      rackPhase < 1 ||
      progress !== target ||
      Math.abs(feed - desiredFeed) > 0.0001 ||
      Math.abs(opticalProgress - opticalGoal) > 0.00001 ||
      Math.abs(sheetProgress - (state.parts.sheet ? motion.paper : 0)) >
        0.00001 ||
      Math.abs(viewerProgress - viewerGoal) > 0.00001 ||
      (state.parts.viewer && opticalProgress === 0 && viewerGoal !== motion.paper) ||
      (state.parts.optical && viewerProgress === 0 && opticalGoal !== motion.travel) ||
      Math.abs(slideProgress - slideGoal) > 0.00001 ||
      (viewer.visible && Math.abs(viewer.position.x - viewerX) > 0.001) ||
      camera.position.distanceToSquared(cameraBase) > 0.00001 ||
      aim.distanceToSquared(cameraTarget) > 0.00001 ||
      (!!pressedControl && !state.reduced && pressTime < 1);
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
    if (environmentPhase !== 1 || environment !== state?.environment) return undefined;
    const groups = environment === "acrylic" ? [acrylic.root] :
      state?.stage === "shelf"
        ? [shelves]
        : [
            strip,
            cartridge,
            ...(viewer.visible ? [viewer] : []),
            ...(optical.visible ? [optical] : []),
          ];
    if (environment === "archive" && state?.stage === "shelf" && (progress > 0.0001 || rackPhase < 1)) return undefined;
    for (const hit of ray.intersectObjects(groups, true)) {
      if (
        hit.object.parent === strip &&
        revealPlane.distanceToPoint(hit.point) < 0
      )
        continue;
      let node: THREE.Object3D | null = hit.object;
      while (node) {
        const control: ScenePick["control"] = node.userData.control;
        if (control && state?.stage === "table" && progress === 1 &&
          (control === "lever" ? state.parts.optical && opticalProgress === 1
            : state.parts.viewer && viewerProgress === 1))
          return { control };
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
  let down = { id: -1, x: 0, y: 0 };
  const freeFilm = () =>
    environment === "archive" && environmentPhase === 1 &&
    state?.stage === "table" &&
    progress === 1 &&
    !state.parts.viewer &&
    !state.parts.optical &&
    !state.parts.sheet &&
    viewerProgress === 0 &&
    opticalProgress === 0 &&
    sheetProgress === 0;
  const pointerDown = (event: PointerEvent) => {
    if (event.button === 2 && state?.stage !== "inspect" && !drag && !controlDrag) {
      orbitDrag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      renderer.domElement.setPointerCapture(event.pointerId);
      host.style.cursor = "grabbing";
      event.preventDefault();
      return;
    }
    if (event.button !== 0 || orbitDrag) return;
    down = { id: event.pointerId, x: event.clientX, y: event.clientY };
    const hit = hits(event);
    if (hit?.control) {
      controlDrag = { id: event.pointerId, control: hit.control };
      leverAngle = 0;
      renderer.domElement.setPointerCapture(event.pointerId);
      host.style.cursor = hit.control === "lever" ? "grabbing" : "pointer";
      event.preventDefault();
      return;
    }
    if (
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
  const releasePointer = (id: number) => {
    if (renderer.domElement.hasPointerCapture(id))
      renderer.domElement.releasePointerCapture(id);
  };
  const pointerUp = (event: PointerEvent) => {
    if (event.button === 2 && orbitDrag?.id === event.pointerId) {
      orbitDrag = null;
      releasePointer(event.pointerId);
      host.style.cursor = "default";
      wake();
      return;
    }
    if (event.button !== 0 || down.id !== event.pointerId) return;
    down.id = -1;
    if (controlDrag?.id === event.pointerId) {
      const { control } = controlDrag;
      controlDrag = null;
      releasePointer(event.pointerId);
      host.style.cursor = control === "lever" ? "grab" : "pointer";
      const dx = event.clientX - down.x, dy = event.clientY - down.y;
      if (control === "lever" || hits(event)?.control === control) {
        const delta = control === "lever" ? darkroomLeverStep(dx, dy) : control === "next" ? 1 : -1;
        pressedControl = control;
        leverReleaseAngle = Math.hypot(dx, dy) >= 6 ? leverAngle : 0;
        controlPressedAt = performance.now();
        events.pick({ control, controlDelta: delta });
      }
      wake();
      return;
    }
    if (drag?.id === event.pointerId) {
      const moved = drag.moved;
      feed = desiredFeed;
      drag = null;
      releasePointer(event.pointerId);
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
    if (orbitDrag?.id === event.pointerId) {
      orbit.x = THREE.MathUtils.clamp(orbit.x - (event.clientX - orbitDrag.x) * .005, -.7, .7);
      orbit.y = THREE.MathUtils.clamp(orbit.y + (event.clientY - orbitDrag.y) * .005, -.5, .5);
      orbitDrag.x = event.clientX;
      orbitDrag.y = event.clientY;
      wake();
      return;
    }
    if (controlDrag?.id === event.pointerId) {
      if (controlDrag.control === "lever") {
        const dx = event.clientX - down.x, dy = event.clientY - down.y;
        leverAngle = THREE.MathUtils.clamp((Math.abs(dy) >= Math.abs(dx) ? -dy : dx) * .016, -.85, .85);
        wake();
      }
      return;
    }
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
      hit?.control === "lever" || (freeFilm() && hit?.film) ? "grab" : hit ? "pointer" : "default";
    mouseLean.copy(pointer);
    wake();
  };
  const pointerLeave = () => {
    if (drag || orbitDrag || controlDrag) return;
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
  const cancelPointer = (event: PointerEvent) => {
    if (down.id === event.pointerId) down.id = -1;
    if (orbitDrag?.id === event.pointerId) orbitDrag = null;
    if (controlDrag?.id === event.pointerId) controlDrag = null;
    if (drag?.id === event.pointerId) cancelDrag();
    host.style.cursor = "default";
    wake();
  };
  const suppressContextMenu = (event: Event) => event.preventDefault();
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
  renderer.domElement.addEventListener("pointercancel", cancelPointer);
  renderer.domElement.addEventListener("lostpointercapture", cancelPointer);
  renderer.domElement.addEventListener("contextmenu", suppressContextMenu);
  renderer.domElement.addEventListener("webglcontextlost", lost);
  renderer.domElement.addEventListener("wheel", wheel, { passive: false });
  document.addEventListener("visibilitychange", visibility);
  resize();
  return {
    resetZoom() {
      zoom = 1;
      orbit.set(0, 0);
      events.zoom(zoom);
      wake();
    },
    update(next) {
      if (disposed) return;
      if (state && (state.environment !== next.environment || state.parts.viewer !== next.parts.viewer || state.parts.optical !== next.parts.optical ||
        (state.stage === "shelf") !== (next.stage === "shelf"))) {
        zoom = 1;
        orbit.set(0, 0);
        events.zoom(zoom);
        if (controlDrag || orbitDrag) down.id = -1;
        controlDrag = orbitDrag = null;
      }
      if (
        drag &&
        (next.stage !== "table" ||
          next.parts.viewer ||
          next.parts.optical ||
          next.parts.sheet)
      )
        cancelDrag();
      const previousIndex = state?.frames.index;
      const previousShelf = state?.shelfId;
      const previousShelfIndex = state?.shelfIndex ?? 0;
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
      const shelfSignature = next.shelfId + ":" + next.shelf
        .map(cassetteSignature)
        .join("|");
      if (shelfKey !== shelfSignature) {
        shelfKey = shelfSignature;
        if (previousShelf && previousShelf !== next.shelfId && !next.reduced && next.stage === "shelf") {
          rackDirection = next.shelfIndex >= previousShelfIndex ? 1 : -1;
          rackPhase = 0; rackChanged = false; pendingShelf = next; events.shelfBusy(true);
        } else if (rackPhase < 1) pendingShelf = next;
        else fillShelf(next);
      }
      const activeSignature = next.roll
        ? cassetteSignature(next.roll)
        : "";
      if (activeRollKey !== activeSignature) {
        activeRollKey = activeSignature;
        release(cartridge);
        archive.remove(cartridge);
        cartridge = new THREE.Group();
        if (next.roll) cartridge.add(makeCartridge(next.roll, true));
        cartridge.position.copy(tablePosition);
        archive.add(cartridge);
        release(acrylic.cassette);
        acrylic.cassette.clear();
        if (next.roll) {
          const miniature = makeCartridge(next.roll, true);
          miniature.scale.setScalar(.55);
          acrylic.cassette.add(miniature);
        }
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
      } else if (previousIndex !== next.frames.index) drawSheet();
      acrylic.update(next.frames.photos, next.frames.start, next.frames.index, sheetImages);
      if (next.stage === "shelf") {
        desiredCamera.set(6.6, 5.1, 14.9);
        desiredAim.set(0, 2.15, -2.6);
      } else {
        desiredCamera.set(0.9, 6.2, 12.8);
        desiredAim.set(0.2, 0.5, 0.1);
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
      renderer.domElement.removeEventListener("pointercancel", cancelPointer);
      renderer.domElement.removeEventListener("lostpointercapture", cancelPointer);
      renderer.domElement.removeEventListener("contextmenu", suppressContextMenu);
      renderer.domElement.removeEventListener("webglcontextlost", lost);
      renderer.domElement.removeEventListener("wheel", wheel);
      acrylic.dispose();
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
  return creativeDarkroomEnabled && processing ? (
    <WetLab
      rolls={darkroomRolls(props.library, false)}
      revisions={props.revisions}
      stocks={props.library.film.stocks}
      onApply={props.onApply}
      onBack={() => setProcessing(false)}
    />
  ) : (
    <ArchiveDarkroom {...props} onProcess={creativeDarkroomEnabled ? () => setProcessing(true) : undefined} />
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
  onProcess?: () => void;
}) {
  const [cassetteSettings, setCassetteSettings] = useState<Record<string, CassetteAppearance>>(() => {
    try {
      return JSON.parse(saved(cassetteSettingsKey) || "{}") ?? {};
    } catch {
      return {};
    }
  });
  const rolls = useMemo(
    () => darkroomRolls(library).map((roll) => {
      const cassette = cassetteAppearance(cassetteSettings[roll.key]);
      return { ...roll, cassette, title: cassette.name || roll.title };
    }),
    [library.albums, library.photos, cassetteSettings],
  );
  const [rollId, setRollId] = useState(
    () => saved("photoall-darkroom-roll") || "",
  );
  const [stage, setStage] = useState<Stage>("shelf"),
    [cursor, setCursor] = useState(0);
  const [immersive, setImmersive] = useState(false);
  const immersiveRef = useRef(false);
  const ownsFullscreen = useRef(false);
  const fullscreenWork = useRef<Promise<void> | null>(null);
  const fullscreenActive = useRef(true);
  useEffect(() => {
    fullscreenActive.current = true;
    const syncBrowserFullscreen = () => {
      if (document.fullscreenElement || !immersiveRef.current) return;
      ownsFullscreen.current = immersiveRef.current = false;
      setImmersive(false);
    };
    document.addEventListener("fullscreenchange", syncBrowserFullscreen);
    return () => {
      fullscreenActive.current = false;
      document.removeEventListener("fullscreenchange", syncBrowserFullscreen);
      void Promise.resolve(fullscreenWork.current).then(async () => {
        if (!fullscreenActive.current && ownsFullscreen.current) {
          ownsFullscreen.current = false;
          await viewerFullscreen(false);
        }
      }).catch(() => {});
    };
  }, []);
  const toggleImmersive = () => {
    if (fullscreenWork.current) return;
    fullscreenWork.current = (async () => {
      if (immersiveRef.current) {
        if (ownsFullscreen.current) await viewerFullscreen(false);
        ownsFullscreen.current = immersiveRef.current = false;
      } else {
        const alreadyFullscreen = await viewerFullscreen();
        immersiveRef.current = alreadyFullscreen || await viewerFullscreen(true);
        ownsFullscreen.current = immersiveRef.current && !alreadyFullscreen;
      }
      if (fullscreenActive.current) setImmersive(immersiveRef.current);
    })().catch(() => {}).finally(() => { fullscreenWork.current = null; });
  };
  const [environment, setEnvironment] = useState<SceneState["environment"]>("archive");
  const archiveStage = useRef<Stage>("shelf");
  const [pixelSize, setPixelSize] = useState(false);
  const [photoZoom, setPhotoZoom] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [parts, setParts] = useState(() => {
    const viewer = saved("photoall-darkroom-viewer") === "true";
    return { viewer, optical: !viewer && saved("photoall-darkroom-optical") !== "false",
      sheet: saved("photoall-darkroom-sheet") === "true" };
  });
  const [viewerGuides, setViewerGuides] = useState(() => ({
    optical: saved("photoall-darkroom-guide-optical") === "true",
    viewer: saved("photoall-darkroom-guide-viewer") === "true",
  }));
  const activeViewer = parts.viewer ? "viewer" : parts.optical ? "optical" : null;
  const [returning, setReturning] = useState(false);
  const [query, setQuery] = useState("");
  const [storedShelves, setStoredShelves] = useState<unknown>(() => {
    try { return JSON.parse(saved(collectionKey) || "null"); } catch { return null; }
  });
  const collection = useMemo(() => collectionShelves(rolls.map(r => r.key), storedShelves), [rolls, storedShelves]);
  const [shelfId, setShelfId] = useState(() => saved("photoall-collection-active") || "");
  const activeShelf = collection.find(s => s.id === shelfId) ?? collection[0];
  const roll = rolls.find(item => activeShelf.rollKeys.includes(item.key) &&
    (item.key === rollId || (item.part === 1 && String(item.album.id) === rollId))) ||
    rolls.find(item => activeShelf.rollKeys.includes(item.key));
  const activeShelfIndex = collection.findIndex(s => s.id === activeShelf.id);
  const [shelfBusy, setShelfBusy] = useState(false);
  useEffect(() => {
    const serialized = JSON.stringify(collection);
    remember(collectionKey, serialized);
    // Keep automatic placements stable when more albums arrive during this session.
    setStoredShelves((current: unknown) => JSON.stringify(current) === serialized ? current : collection);
  }, [collection]);
  const selectShelf = (id: string) => {
    if (returning || shelfBusy || stage !== "shelf" || id === activeShelf.id) return;
    setQuery(""); setShelfId(id); remember("photoall-collection-active", id);
  };
  const addShelf = () => {
    const id = `shelf-${crypto.randomUUID()}`;
    setStoredShelves([...collection, { id, name: `胶片架 ${String(collection.length + 1).padStart(2, "0")}`, rollKeys: [] }]);
    selectShelf(id);
  };
  const moveToShelf = (key: string) => {
    setStoredShelves(moveCollectionRoll(collection, key, activeShelf.id));
    setQuery("");
  };
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
  const visible = useMemo(() => activeShelf.rollKeys.flatMap(key => {
    const item = rolls.find(r => r.key === key); return item ? [item] : [];
  }), [rolls, activeShelf]);
  const filtered = useMemo(() => visible.filter(item =>
    item.title.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim())), [visible, query]);
  const shelfThumbnails = useMemo(() => visible.map(cassetteThumbnail), [visible]);
  const currentState: SceneState = {
    environment,
    roll,
    shelf: visible,
    shelfId: activeShelf.id,
    shelfIndex: activeShelfIndex,
    frames,
    stage,
    neutral,
    reduced,
    revisions,
    parts,
  };
  const togglePart = (part: "sheet" | "viewer" | "optical") => {
    setParts((value) => {
      const next = part === "sheet" ? { ...value, sheet: !value.sheet } : darkroomViewerParts(value, part);
      if (part === "sheet") remember("photoall-darkroom-sheet", String(next.sheet));
      else {
        remember("photoall-darkroom-optical", String(next.optical));
        remember("photoall-darkroom-viewer", String(next.viewer));
      }
      return next;
    });
  };
  const saveCassette = (appearance: CassetteFields) => {
    if (!roll) return;
    const next = { ...cassetteSettings, [roll.key]: cassetteAppearance(appearance) };
    setCassetteSettings(next);
    remember(cassetteSettingsKey, JSON.stringify(next));
  };
  const dismissViewerGuide = () => {
    if (!activeViewer || viewerGuides[activeViewer]) return;
    setViewerGuides({ ...viewerGuides, [activeViewer]: true });
    remember(`photoall-darkroom-guide-${activeViewer}`, "true");
  };
  const advanceViewer = (delta: number) => {
    setCursor((index) => Math.min(Math.max(0, (roll?.photos.length ?? 1) - 1), Math.max(0, index + delta)));
    if (stage === "table") dismissViewerGuide();
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
    if (returning || shelfBusy) return;
    clickSound();
    setRollId(id);
    remember("photoall-darkroom-roll", String(id));
    setCursor(0);
    setStage("table");
  };
  const stow = () => {
    clickSound();
    if (environment === "acrylic") setEnvironment("archive");
    setReturning(!!room.current && !error);
    setStage("shelf");
  };
  const viewFrame = (index: number) => {
    clickSound();
    setCursor(index);
    setStage("inspect");
  };
  const selectFrame = (index: number) => {
    if (environment === "acrylic") {
      clickSound(); setCursor(index); setStage("table"); return;
    }
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
    if (selection.controlDelta) {
      clickSound();
      advanceViewer(selection.controlDelta);
      return;
    }
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
        shelfBusy: setShelfBusy,
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
    visible,
    activeShelf.id,
    library,
    parts,
    environment,
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
            ".dr-parts[open], .dr-cassette-settings[open]",
          );
        if (menu) {
          menu.open = false;
          return;
        }
        if (immersiveRef.current) {
          toggleImmersive();
          return;
        }
        if (stage === "inspect") setStage("table");
        else if (stage === "table") stow();
        else onBack();
      }
      if (event.key.toLowerCase() === "f" && !event.repeat) {
        event.preventDefault();
        toggleImmersive();
      }
      if (
        stage !== "shelf" &&
        ["ArrowLeft", "ArrowRight"].includes(event.key)
      ) {
        event.preventDefault();
        advanceViewer(event.key === "ArrowLeft" ? -1 : 1);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [stage, roll, onBack, activeViewer, viewerGuides, environment]);
  return (
    <section
      className={`darkroom dr-environment-${environment} dr-stage-${stage} ${immersive ? "dr-immersive" : ""} ${neutral ? "dr-neutral" : ""} ${error ? "dr-failed" : ""}`}
      role="region"
      aria-label="独立胶片收藏室"
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
            胶片收藏室<small>PHOTO ALL · COLLECTION</small>
          </span>
        </div>
        <div className="dr-utilities">
          <select className="dr-environment-select" aria-label="收藏室场景" value={environment}
            onChange={event => {
              const next=event.target.value as SceneState["environment"];
              setEnvironment(next);
              if(next==="acrylic" && !roll && visible[0]) {setRollId(visible[0].key);setCursor(0);}
              if(next==="acrylic") {
                archiveStage.current=stage;
                setStage("table");
              } else {
                setStage(archiveStage.current);
              }
            }}>
            <option value="archive">胡桃木收藏室</option>
            <option value="acrylic">亚克力胶片展廊</option>
          </select>
          <button aria-pressed={immersive}
            aria-label={immersive ? "退出暗房全屏沉浸" : "暗房全屏沉浸"}
            title={immersive ? "退出全屏沉浸 · F / Esc" : "全屏沉浸 · F"}
            onClick={(event) => { event.currentTarget.blur(); toggleImmersive(); }}>
            {immersive ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            <span>{immersive ? "退出沉浸" : "全屏沉浸"}</span>
          </button>
          {creativeDarkroomEnabled && onProcess && (
            <button aria-label="进入创作暗房" onClick={onProcess}>
              <FlaskConical size={16} />
              <span>创作暗房</span>
            </button>
          )}
          <button
            className="dr-camera-zoom"
            aria-label="重置暗房镜头距离"
            title="滚轮拉近拉远 · 右键拖动视角 · 点击复位"
            onClick={() => room.current?.resetZoom()}
          >
            <Maximize2 size={14} />
            <span>{Math.round(zoom * 100)}%</span>
          </button>
          {roll && (
            <details className="dr-cassette-settings">
              <summary aria-label="自定义胶卷暗盒">
                <Film size={16} /><span>暗盒样式</span><ChevronDown size={12} />
              </summary>
              <form className="dr-parts-menu dr-cassette-form"
                key={JSON.stringify([roll.key, roll.cassette?.name, roll.cassette?.ink])} onSubmit={(event) => {
                event.preventDefault();
                const values = new FormData(event.currentTarget);
                saveCassette({ style: values.get("style"), name: values.get("name"), ink: values.get("ink") });
                event.currentTarget.closest("details")?.removeAttribute("open");
              }}>
                <label>卷名<input name="name" maxLength={56} placeholder={roll.album.name} defaultValue={roll.cassette?.name} /></label>
                <label>暗盒款式<select name="style" value={roll.cassette?.style ?? "photo-all"}
                  onChange={(event) => saveCassette({ ...roll.cassette, style: event.currentTarget.value })}>
                  {Object.entries(CASSETTE_PRESETS).map(([id, preset]) => <option key={id} value={id}>{preset.label}</option>)}
                </select></label>
                <label className="dr-cassette-ink">文字颜色<input type="color" name="ink" defaultValue={roll.cassette?.ink ?? "#f2e2c8"} /></label>
                <div className="dr-cassette-actions">
                  <button type="button" onClick={() => saveCassette({})}>恢复默认</button>
                  <button type="submit">保存暗盒</button>
                </div>
              </form>
            </details>
          )}
          <details className="dr-parts" hidden={environment !== "archive"}>
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
          <button aria-label="退出胶片收藏室" title="退出暗房" onClick={onBack}>
            <X size={19} />
          </button>
        </div>
      </header>
      {environment === "archive" && stage === "table" && activeViewer && current && !error && (
        <div className="dr-viewer-controls" role="group" aria-label={activeViewer === "optical" ? "胶片观片器翻片" : "电子观片器翻片"}>
          <output className="dr-viewer-count">FRAME {String(frames.index + 1).padStart(2, "0")} / {frames.photos.length}</output>
          {!viewerGuides[activeViewer] && (
            <div className="dr-viewer-guide">
              <p role="status">{frames.photos.length < 2 ? "本卷只有一张照片。" : activeViewer === "optical"
                ? "点按或向下拨动机身右侧的红色拉杆，换到下一帧。向上拨动回到上一帧。"
                : "按机身右下角的金色三角键，换到下一帧。左侧三角键回到上一帧。"}</p>
              <button onClick={dismissViewerGuide}>知道了</button>
            </div>
          )}
        </div>
      )}
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
      {environment === "archive" && stage === "shelf" && (
        <div className="dr-intro">
          <span>THE PERSONAL ARCHIVE</span>
          <h1>{activeShelf.name}</h1>
          <p>
            {visible.length ? `${visible.length} / ${COLLECTION_CAPACITY} 卷 · 选一卷，展开收藏。`
              : "空架已备好，收纳你的下一卷。"}
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
                reusePreview
                sourceScale={!pixelSize && isRaw(current) ? 1 : undefined}
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
              <div className="dr-shelf-toolbar" role="group" aria-label="收藏架管理">
                <button aria-label="上一个胶片架" disabled={returning || shelfBusy || activeShelfIndex === 0}
                  onClick={() => selectShelf(collection[activeShelfIndex - 1].id)}><ChevronLeft size={16} /></button>
                <label className="dr-shelf-select"><span>收藏架</span>
                  <select aria-label="选择胶片架" disabled={returning || shelfBusy} value={activeShelf.id}
                    onChange={event => selectShelf(event.target.value)}>
                    {collection.map(s => <option key={s.id} value={s.id}>{s.name} · {s.rollKeys.length}/{COLLECTION_CAPACITY}</option>)}
                  </select>
                </label>
                <button aria-label="下一个胶片架" disabled={returning || shelfBusy || activeShelfIndex === collection.length - 1}
                  onClick={() => selectShelf(collection[activeShelfIndex + 1].id)}><ChevronRight size={16} /></button>
                <span className="dr-shelf-spacer" />
                <button aria-label="新建胶片架" disabled={returning || shelfBusy} onClick={addShelf}><Plus size={15} />新建胶片架</button>
                <details className="dr-shelf-transfer" key={activeShelf.id}>
                  <summary aria-label="收纳胶卷到此架"><Boxes size={15} />收纳胶卷<ChevronDown size={12} /></summary>
                  <div className="dr-transfer-menu">
                    <p>{visible.length >= COLLECTION_CAPACITY ? "本架已满，请新建或切换胶片架。" : "从其他架移入，保留原片与编辑。"}</p>
                    {rolls.filter(r => !activeShelf.rollKeys.includes(r.key)).map(r =>
                      <button key={r.key} disabled={returning || shelfBusy || visible.length >= COLLECTION_CAPACITY}
                        onClick={() => moveToShelf(r.key)}><Film size={14} /><span>{r.title}<small>{collection.find(s => s.rollKeys.includes(r.key))?.name}</small></span><Plus size={14} /></button>)}
                    {!rolls.some(r => !activeShelf.rollKeys.includes(r.key)) && <p>其他架暂无胶卷，新导入的图集会自动收纳。</p>}
                  </div>
                </details>
              </div>
              <div className="dr-dock-heading">
                <div>
                  <Film size={15} />
                  <span>{returning ? "正在收回卷架" : shelfBusy ? "正在切换收藏架" : "本架胶卷"}</span>
                  <b>{visible.length}</b>
                </div>
                <label className="dr-search">
                  <Search size={14} />
                  <input
                    aria-label="搜索暗房胶卷"
                    placeholder="搜索本架胶卷"
                    disabled={returning}
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                    }}
                  />
                </label>
              </div>
              <div
                className="dr-roll-list"
                role="group"
                aria-label="暗房胶卷选择"
              >
                {filtered.map((item) => (
                  <button
                    className={`dr-roll-choice ${item.key === roll?.key ? "selected" : ""}`}
                    key={item.key}
                    aria-label={`展开胶卷 ${item.title}`}
                    disabled={returning || shelfBusy}
                    onClick={() => chooseRoll(item.key)}
                  >
                    <span className="dr-mini-canister" aria-hidden="true">
                      <img src={shelfThumbnails[visible.indexOf(item)]} alt="" draggable={false} />
                    </span>
                    <span>
                      {item.title}
                      <small>{item.photos.length} 帧</small>
                    </span>
                    <ArrowRight size={14} />
                  </button>
                ))}
                {!filtered.length && (
                  <div className="dr-empty">
                    {visible.length ? "没有匹配的胶卷" : "从「收纳胶卷」移入收藏，或返回图集导入照片。"}
                    {!rolls.length && <button onClick={onBack}>返回图集</button>}
                  </div>
                )}
              </div>
              <div className="dr-dock-bottom">
                <span>共 {collection.length} 架 · {rolls.length} 卷收藏</span>
                <span>{visible.length === COLLECTION_CAPACITY ? "本架已满 · 可新建胶片架" : `还有 ${COLLECTION_CAPACITY - visible.length} 个空位`}</span>
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
