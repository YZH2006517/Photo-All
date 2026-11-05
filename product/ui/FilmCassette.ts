// SPDX-License-Identifier: GPL-3.0-or-later
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

export const CASSETTE_PRESETS = {
  "photo-all": { label: "Photo All · 135", body: "#49322b" },
  portra: { label: "Kodak Portra 400", body: "#715333" },
  gold: { label: "Kodak Gold 200", body: "#ac7b35" },
  ektar: { label: "Kodak Ektar 100", body: "#624039" },
  fuji: { label: "Fujicolor PRO 400H", body: "#293e31" },
};
export type CassetteStyle = keyof typeof CASSETTE_PRESETS;
export type CassetteAppearance = { style: CassetteStyle; name: string; ink: string };
export type CassetteFields = { [Field in keyof CassetteAppearance]?: unknown };

export function cassetteAppearance(value?: CassetteFields | null): CassetteAppearance {
  const style = value?.style;
  return {
    style: typeof style === "string" && Object.hasOwn(CASSETTE_PRESETS, style) ? style as CassetteStyle : "photo-all",
    name: typeof value?.name === "string" ? Array.from(value.name.trim()).slice(0, 28).join("") : "",
    ink: typeof value?.ink === "string" && /^#[0-9a-f]{6}$/i.test(value.ink) ? value.ink.toLowerCase() : "#f2e2c8",
  };
}

type Mouth = { x: number; y: number; z: number; height: number };
const cassetteMouth: Mouth = { x: .37, y: .421, z: .069, height: .706 };
export function cassetteGeometry(mouth = cassetteMouth, bodyHeight = .76) {
  return { mouth, scale: [mouth.x / cassetteMouth.x, bodyHeight / .76, mouth.z / cassetteMouth.z] as const };
}

export function paintCassette(
  ctx: CanvasRenderingContext2D, appearance: CassetteAppearance, body: string,
  title: string, note: string, archival = false,
) {
  const { style, ink, name } = appearance;
  const block = (color: string, x: number, y: number, w: number, h: number) => {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  };
  const print = (value: string, y: number, size: number, color: string, x = 512, serif = false, width = 482) => {
    ctx.fillStyle = color;
    ctx.font = `bold ${size}px ${serif ? 'Georgia, "Microsoft YaHei", serif' : '"Arial Narrow", "Segoe UI", sans-serif'}`;
    ctx.fillText(value, x, y, width);
  };
  ctx.textAlign = "center";
  block(body, 0, 0, 1024, 512);
  if (style === "photo-all") {
    block("#211a17", 0, 0, 1024, 55);
    block("#211a17", 0, 461, 1024, 51);
    block("#ac8060", 0, 55, 1024, 3);
    block("#ac8060", 0, 457, 1024, 3);
    print("Photo All", 135, 53, "#f2e2c8", 512, true);
    print(name || title, 280, 65, ink, 512, true);
    print(note, 397, 31, "#c5a788");
  } else if (style === "gold") {
    block(archival ? "#ac7b35" : "#edb42d", 0, 0, 1024, 512);
    print("KODAK  /  GOLD", 97, 44, "#632b20");
    print("200", 282, 167, "#282017");
    print("35 mm  /  COLOR PRINT FILM", 352, 28, "#282017");
    print(name || note, 438, 31, !name && ink === "#f2e2c8" ? "#282017" : ink);
  } else if (style === "fuji") {
    block("#25372c", 0, 0, 1024, 225);
    block("#5e4169", 0, 225, 1024, 60);
    block("#3c6749", 0, 285, 1024, 195);
    block("#293e31", 0, 480, 1024, 32);
    block("#efe7d2", 374, 78, 57, 124);
    print("36", 139, 37, "#23251f", 402);
    print("135", 179, 24, "#23251f", 402);
    print("PRO 400H", 180, 76, "#f2da71", 546, false, 225);
    print("COLOR NEGATIVE FILM", 265, 34, "#fff5e9", 512, false, 314);
    print("FUJICOLOR", 355, 59, "#fff5e9", 512, false, 315);
    print("Professional", 405, 41, "#f4ead9", 512, true, 278);
    print(name || note, 457, 29, ink, 512, false, 323);
  } else {
    block(archival ? "#a47e3e" : "#e3ae32", 0, 0, 1024, 133);
    print("KODAK  /  PROFESSIONAL", 85, 37, "#2c2319");
    print("COLOR NEGATIVE FILM", 204, 29, "#e8ddcb");
    print(style === "portra" ? "PORTRA 400" : "EKTAR 100", 318, 73,
      style === "portra" ? (archival ? "#ca8d74" : "#e37967") : "#f1eadd");
    print(name || note, 427, 31, ink);
  }
  for (let row = 0; row < 2; row++)
    for (let col = 0; col < 6; col++)
      block((col + row * 2) % 3 ? "#a8a094" : "#282321", 804 + col * 24, 294 + row * 49, 21, 44);
  if (archival) {
    // Sparse, deterministic marks on the printed wrap.
    for (let i = 0; i < 120; i++)
      block(i % 2 ? "#e6ba9118" : "#12030220", (i * 217) % 1024, (i * 79) % 512, 1 + i % 4, 1);
  }
}

type AddMesh = (geometry: THREE.BufferGeometry, material: THREE.Material,
  parent: THREE.Object3D, x?: number, y?: number, z?: number) => THREE.Mesh;

/** Shared 135 cassette geometry. The archival version uses the animated strip as its leader. */
export function mountFilmCassette(group: THREE.Group, mesh: AddMesh, label: THREE.Texture,
  options: { leader?: THREE.Material; mouth?: Mouth; bodyHeight?: number; labelLight?: number } = {}) {
  const model = new THREE.Group();
  const { mouth, scale } = cassetteGeometry(options.mouth, options.bodyHeight);
  model.scale.set(...scale);
  group.add(model);
  const printed = new THREE.MeshStandardMaterial({
    map: label, roughness: .83, metalness: .08,
    ...(options.labelLight ? { emissive: "#ffffff", emissiveMap: label, emissiveIntensity: options.labelLight } : {}),
  });
  const shell = new THREE.MeshStandardMaterial({ color: "#49423b", roughness: .65, metalness: .55 });
  const rim = new THREE.MeshStandardMaterial({ color: "#938373", roughness: .62, metalness: .54 });
  const plastic = new THREE.MeshStandardMaterial({ color: "#251e19", roughness: .92 });
  const cylinder = (r: number, h: number, y: number, material: THREE.Material) =>
    mesh(new THREE.CylinderGeometry(r, r, h, 48), material, model, 0, y, 0);
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, material: THREE.Material) =>
    mesh(new RoundedBoxGeometry(w, h, d, 2, Math.min(.01, d / 4)), material, model, x, y, z);
  mesh(new THREE.CylinderGeometry(.282, .282, .76, 56, 1, true, -Math.PI), printed, model, 0, .426, 0);
  for (const y of [.036, .817]) {
    cylinder(.299, .052, y, shell);
    mesh(new THREE.TorusGeometry(.286, .01, 8, 64), rim, model, 0, y + .025, 0).rotation.x = Math.PI / 2;
  }
  cylinder(.141, .028, .849, plastic);
  cylinder(.087, .085, .904, plastic);
  cylinder(.075, .02, .013, plastic);
  for (const z of [-.048, .048]) box(.126, .038, .042, 0, .959, z, plastic);
  const slotY = mouth.y / scale[1], slotHeight = mouth.height / scale[1];
  for (const z of [.027, .111]) {
    box(.164, slotHeight + .035, .048, .288, slotY, z, shell);
    box(.164, slotHeight, .009, .288, slotY, z + (z < .069 ? .027 : -.027), plastic);
  }
  for (const sign of [-1, 1]) box(.164, .02, .13, .288, slotY + sign * (slotHeight / 2 + .01), .069, shell);
  if (options.leader)
    mesh(new THREE.PlaneGeometry(.22, .706), options.leader, model, .454, .421, .069);
  return [printed, shell, rim, plastic];
}
