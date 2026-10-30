// SPDX-License-Identifier: GPL-3.0-or-later
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type Recipe = Record<string, string | number>;
export type Photo = {
  id: number;
  name: string;
  path: string;
  width: number;
  height: number;
  render_width?: number;
  render_height?: number;
  captured: number;
  time_source: string;
  score: number;
  group_id: string;
  duplicate_of: number | null;
  decision: string;
  recipe: Recipe;
  committed_recipe?: Recipe;
  digest: string;
  album_ids: number[];
  features: {
    color?: string;
    tone?: string;
    brightness?: string;
    lightness?: number;
    saturation?: number;
    contrast?: number;
    palette?: string[];
    content?: {
      label: string;
      score: number;
      candidates: { label: string; score: number }[];
      model: string;
    } | null;
  };
};
export type Album = {
  id: number;
  name: string;
  created: number;
  count: number;
  trashed_at?: number | null;
  purge_at?: number | null;
};
export type Layer = {
  photo_id: number;
  visible: boolean;
  opacity: number;
  blend: string;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  recipe: Recipe;
};
export type CompositeDocument = {
  id?: number;
  album_id?: number;
  name: string;
  width: number;
  height: number;
  layers: Layer[];
};
export type Facets = {
  color?: string;
  tone?: string;
  brightness?: string;
  content?: string;
  date?: string;
  saturation?: string;
  contrast?: string;
  orientation?: string;
  format?: string;
  resolution?: string;
  quality?: string;
  style?: string;
  film?: string;
};
export type Library = {
  photos: Photo[];
  albums: Album[];
  trash_albums?: Album[];
  composites: CompositeDocument[];
  filters: {
    items: Record<
      string,
      {
        label: string;
        group: string;
        source: string;
        license: string;
        ready: boolean;
      }
    >;
    count: number;
    attribution: string;
    source: string;
    mode: string;
  };
  film: {
    engine: string;
    mode: string;
    revision: string;
    attribution: string;
    source: string;
    stocks: Record<
      string,
      { label: string; family: string; paper: string; ready: boolean }
    >;
  };
  history: { undo: number; redo: number };
  recognition: {
    ready: boolean;
    model: string;
    labels: Record<string, string>;
  };
  capabilities: { raw: boolean; raw_backend: string | null; heic: boolean };
  defaults: Recipe;
  styles: Record<string, string>;
  templates: Record<string, string>;
};
export type Job = {
  id: string;
  status: "running" | "done" | "error" | "cancelled";
  cancellable?: boolean;
  cancel_requested?: boolean;
  done: number;
  total: number;
  error?: string;
  result?: {
    imported?: number;
    analyzed?: number;
    outputs?: string[];
    errors: { name?: string; path?: string; error: string }[];
  };
};
export function mergeLibraryRecipes(
  loaded: Library,
  live: Library,
  atRequest: Map<number, number>,
  current: Map<number, number>,
): Library {
  const latest = new Map(live.photos.map((p) => [p.id, p]));
  const newer = loaded.photos.some(
    (p) => (current.get(p.id) || 0) > (atRequest.get(p.id) || 0),
  );
  return {
    ...loaded,
    history: newer ? live.history : loaded.history,
    photos: loaded.photos.map((p) =>
      (current.get(p.id) || 0) > (atRequest.get(p.id) || 0) && latest.has(p.id)
        ? {
            ...p,
            recipe: latest.get(p.id)!.recipe,
            committed_recipe:
              latest.get(p.id)!.committed_recipe ?? p.committed_recipe,
          }
        : p,
    ),
  };
}
type Connection = { port: number; token: string };
type PreviewTask = {
  key: string;
  controller: AbortController;
  consumers: number;
  load: (signal: AbortSignal) => Promise<Blob>;
  promise: Promise<Blob>;
  resolve: (blob: Blob) => void;
  reject: (error: unknown) => void;
  started?: boolean;
  releaseTimer?: ReturnType<typeof setTimeout>;
};

// One shared queue for thumbnails, filmstrip and editor: remounting a view reuses pixels.
export class PreviewPool {
  private cache = new Map<string, Blob>();
  private flights = new Map<string, PreviewTask>();
  private queue: PreviewTask[] = [];
  private active = 0;
  private bytes = 0;
  constructor(
    private concurrency = 3,
    private maxBytes = 64 * 1024 * 1024,
  ) {}

  read(
    key: string,
    load: (signal: AbortSignal) => Promise<Blob>,
    signal?: AbortSignal,
  ): Promise<Blob> {
    if (signal?.aborted)
      return Promise.reject(new DOMException("Cancelled", "AbortError"));
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return Promise.resolve(cached);
    }
    let task = this.flights.get(key);
    if (!task) {
      let resolve!: (value: Blob) => void, reject!: (reason: unknown) => void;
      const promise = new Promise<Blob>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      task = {
        key,
        load,
        promise,
        resolve,
        reject,
        controller: new AbortController(),
        consumers: 0,
      };
      this.flights.set(key, task);
      this.queue.push(task);
    }
    const request = task;
    clearTimeout(request.releaseTimer);
    request.consumers++;
    const result = new Promise<Blob>((resolve, reject) => {
      let settled = false;
      const finish = (error: unknown, blob?: Blob) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        request.consumers--;
        if (!request.consumers && this.flights.get(key) === request) {
          const cancel = () => {
            if (!request.consumers && this.flights.get(key) === request) {
              this.flights.delete(key);
              request.controller.abort();
            }
          };
          if (request.started) request.releaseTimer = setTimeout(cancel, 120);
          else cancel();
        }
        if (error) reject(error);
        else resolve(blob!);
      };
      const abort = () => finish(new DOMException("Cancelled", "AbortError"));
      signal?.addEventListener("abort", abort, { once: true });
      request.promise.then(
        (blob) => finish(null, blob),
        (error) => finish(error),
      );
    });
    this.pump();
    return result;
  }

  private pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const task = this.queue.shift()!;
      if (task.controller.signal.aborted) {
        task.reject(new DOMException("Cancelled", "AbortError"));
        continue;
      }
      this.active++;
      task.started = true;
      task
        .load(task.controller.signal)
        .then((blob) => {
          if (!task.controller.signal.aborted && blob.size <= this.maxBytes) {
            this.cache.set(task.key, blob);
            this.bytes += blob.size;
            while (this.bytes > this.maxBytes) {
              const key = this.cache.keys().next().value!;
              this.bytes -= this.cache.get(key)!.size;
              this.cache.delete(key);
            }
          }
          task.resolve(blob);
        }, task.reject)
        .finally(() => {
          clearTimeout(task.releaseTimer);
          if (this.flights.get(task.key) === task)
            this.flights.delete(task.key);
          this.active--;
          this.pump();
        });
    }
  }
}
const previews = new PreviewPool();

export type DecodedPreview = {
  url: string;
  width: number;
  height: number;
  image?: HTMLImageElement;
};
type DecodedEntry = {
  family: string;
  capacity: number;
  asset: DecodedPreview;
  refs: number;
  bytes: number;
};
type DecodedFlight = {
  family: string;
  size: number;
  controller: AbortController;
  consumers: number;
  promise: Promise<DecodedPreview>;
  timer?: ReturnType<typeof setTimeout>;
};
const capacity = (size: number) => (size === 0 ? Infinity : size);
async function decodePreview(blob: Blob): Promise<DecodedPreview> {
  const url = URL.createObjectURL(blob),
    image = new Image();
  image.src = url;
  try {
    await image.decode();
    return {
      url,
      image,
      width: image.naturalWidth,
      height: image.naturalHeight,
    };
  } catch (reason) {
    URL.revokeObjectURL(url);
    throw reason;
  }
}
// The byte budget covers idle decoded pixels. Displayed assets remain pinned
// until their Picture releases them; no view keeps all full-size RAWs alive.
export class DecodedPreviewPool {
  private entries = new Map<string, DecodedEntry>();
  private flights = new Set<DecodedFlight>();
  private bytes = 0;
  constructor(
    private maxBytes = 192 * 1024 * 1024,
    private decode: (blob: Blob) => Promise<DecodedPreview> = decodePreview,
    private dispose: (asset: DecodedPreview) => void = (asset) => {
      if (asset.image) asset.image.src = "";
      URL.revokeObjectURL(asset.url);
    },
  ) {}
  private find(family: string, size: number, fallback: boolean) {
    const candidates = [...this.entries.values()].filter(
      (e) => e.family === family,
    );
    return (
      candidates
        .filter((e) => e.capacity >= capacity(size))
        .sort((a, b) => a.capacity - b.capacity)[0] ||
      (fallback
        ? candidates.sort((a, b) => b.capacity - a.capacity)[0]
        : undefined)
    );
  }
  peek(
    family: string,
    size: number,
    fallback = true,
  ): DecodedPreview | undefined {
    const entry = this.find(family, size, fallback);
    if (!entry) return;
    this.entries.delete(entry.asset.url);
    this.entries.set(entry.asset.url, entry);
    return entry.asset;
  }
  sufficient(family: string, size: number) {
    return !!this.find(family, size, false);
  }
  retain(asset: DecodedPreview) {
    const entry = this.entries.get(asset.url);
    if (entry) entry.refs++;
  }
  release(asset: DecodedPreview) {
    const entry = this.entries.get(asset.url);
    if (entry) entry.refs = Math.max(0, entry.refs - 1);
    this.trim();
  }
  clear() {
    for (const entry of [...this.entries.values()])
      if (!entry.refs) this.remove(entry);
  }
  private remove(entry: DecodedEntry) {
    this.entries.delete(entry.asset.url);
    this.bytes -= entry.bytes;
    this.dispose(entry.asset);
  }
  private trim(protectedEntry?: DecodedEntry) {
    for (const entry of [...this.entries.values()]) {
      if (this.bytes <= this.maxBytes) break;
      if (!entry.refs && entry !== protectedEntry) this.remove(entry);
    }
  }
  read(
    family: string,
    size: number,
    load: (signal: AbortSignal) => Promise<Blob>,
    signal?: AbortSignal,
    nativeDimensions?: { width: number; height: number },
  ): Promise<DecodedPreview> {
    if (signal?.aborted)
      return Promise.reject(new DOMException("Cancelled", "AbortError"));
    const cached = this.peek(family, size, false);
    if (cached) return Promise.resolve(cached);
    let flight = [...this.flights]
      .filter(
        (f) =>
          f.family === family &&
          !f.controller.signal.aborted &&
          capacity(f.size) >= capacity(size),
      )
      .sort((a, b) => capacity(a.size) - capacity(b.size))[0];
    if (!flight) {
      const request: DecodedFlight = {
        family,
        size,
        controller: new AbortController(),
        consumers: 0,
        promise: null!,
      };
      this.flights.add(request);
      request.promise = (async () => {
        try {
          const blob = await load(request.controller.signal);
          if (request.controller.signal.aborted)
            throw new DOMException("Cancelled", "AbortError");
          const asset = await this.decode(blob);
          if (request.controller.signal.aborted) {
            this.dispose(asset);
            throw new DOMException("Cancelled", "AbortError");
          }
          const entry = {
            family,
            capacity:
              nativeDimensions &&
              asset.width === nativeDimensions.width &&
              asset.height === nativeDimensions.height
                ? Infinity
                : size || Math.max(asset.width, asset.height),
            asset,
            refs: 0,
            bytes: asset.width * asset.height * 4,
          };
          this.entries.set(asset.url, entry);
          this.bytes += entry.bytes;
          this.trim(entry);
          setTimeout(() => this.trim(), 0);
          return asset;
        } finally {
          clearTimeout(request.timer);
          this.flights.delete(request);
        }
      })();
      flight = request;
    }
    const request = flight;
    clearTimeout(request.timer);
    request.consumers++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (reason?: unknown, asset?: DecodedPreview) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        request.consumers--;
        if (!request.consumers && this.flights.has(request))
          request.timer = setTimeout(() => {
            if (!request.consumers) request.controller.abort();
          }, 120);
        if (reason) reject(reason);
        else resolve(asset!);
      };
      const abort = () => finish(new DOMException("Cancelled", "AbortError"));
      signal?.addEventListener("abort", abort, { once: true });
      request.promise.then(
        (asset) => finish(undefined, asset),
        (reason) => finish(reason),
      );
    });
  }
}
export const decodedPreviews = new DecodedPreviewPool();
const geometryKeys = [
  "quarter_turns",
  "flip_x",
  "flip_y",
  "straighten",
  "crop_x",
  "crop_y",
  "crop_w",
  "crop_h",
];
export function geometrySignature(recipe: Recipe) {
  return JSON.stringify(
    geometryKeys.map(
      (key) => recipe[key] ?? (key === "crop_w" || key === "crop_h" ? 1 : 0),
    ),
  );
}
export function photoDimensions(
  photo: Pick<Photo, "width" | "height" | "recipe">,
) {
  const rotated = Math.abs(Number(photo.recipe.quarter_turns || 0)) % 2 === 1;
  const width = rotated ? photo.height : photo.width,
    height = rotated ? photo.width : photo.height;
  // Match Python's rounded pixel edges, including ties-to-even at .5.
  const roundEdge = (value: number) =>
    value - Math.floor(value) === 0.5
      ? Math.floor(value) + (Math.floor(value) % 2)
      : Math.round(value);
  const left = Math.min(
      width - 1,
      roundEdge(Number(photo.recipe.crop_x || 0) * width),
    ),
    top = Math.min(
      height - 1,
      roundEdge(Number(photo.recipe.crop_y || 0) * height),
    );
  const right = Math.min(
      width,
      Math.max(
        left + 1,
        roundEdge(
          (Number(photo.recipe.crop_x || 0) +
            Number(photo.recipe.crop_w ?? 1)) *
            width,
        ),
      ),
    ),
    bottom = Math.min(
      height,
      Math.max(
        top + 1,
        roundEdge(
          (Number(photo.recipe.crop_y || 0) +
            Number(photo.recipe.crop_h ?? 1)) *
            height,
        ),
      ),
    );
  return {
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}
export function photoPreviewFamily(
  photo: Photo,
  original = false,
  revision = 0,
  quality: "preview" | "source" = "preview",
  uncropped = false,
) {
  const recipe = photo.committed_recipe ?? photo.recipe;
  return `${photo.id}/${photo.digest}/${quality}/${uncropped ? "uncropped" : "cropped"}/${original ? "original/" + geometrySignature(recipe) : JSON.stringify(recipe) + "/" + revision}`;
}
let session: Promise<Connection> | undefined;
export function connect(): Promise<Connection> {
  if (!session)
    session = isTauri()
      ? invoke<Connection>("connection")
      : Promise.resolve().then(() => {
          const hash = new URLSearchParams(location.hash.slice(1));
          const port = Number(hash.get("port")),
            token = hash.get("token");
          if (!port || !token)
            throw new Error(
              "请通过 start.cmd 启动桌面工作台；浏览器预览需要本地验证会话。",
            );
          return { port, token };
        });
  return session;
}
export async function api<T>(
  route: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const { port, token } = await connect();
  const response = await fetch(`http://127.0.0.1:${port}/api${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "本地处理失败");
  return value as T;
}
export function photoBlob(
  photo: Photo,
  size: number,
  original = false,
  signal?: AbortSignal,
  revision = 0,
  quality: "preview" | "source" = "preview",
  uncropped = false,
) {
  const key = `${photoPreviewFamily(photo, original, revision, quality, uncropped)}/${size}`;
  return previews.read(
    key,
    async (requestSignal) => {
      const { port, token } = await connect();
      const response = await fetch(
        `http://127.0.0.1:${port}/api/image/${photo.id}?size=${size}&quality=${quality}&original=${original ? 1 : 0}&uncropped=${uncropped ? 1 : 0}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: requestSignal,
        },
      );
      if (!response.ok)
        throw new Error((await response.json()).error || "预览生成失败");
      return response.blob();
    },
    signal,
  );
}
export function filterPreviewKey(photo: Photo, id: string, size = 240) {
  const recipe: Recipe = {
    ...(photo.committed_recipe ?? photo.recipe),
    style: id.startsWith("style:") ? id.slice(6) : "natural",
    filter_id: id.startsWith("style:") ? "none" : id,
    filter_strength: 1,
  };
  return `filter/${photoPreviewFamily({ ...photo, recipe, committed_recipe: recipe }, false, 0, "preview")}/${encodeURIComponent(id)}/${size}`;
}
export function filterBlob(
  photo: Photo,
  id: string,
  size = 240,
  signal?: AbortSignal,
  _revision = 0,
): Promise<Blob> {
  return previews.read(
    filterPreviewKey(photo, id, size),
    async (requestSignal) => {
      const { port, token } = await connect();
      const response = await fetch(
        `http://127.0.0.1:${port}/api/filter-preview/${photo.id}?filter_id=${encodeURIComponent(id)}&size=${size}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: requestSignal,
        },
      );
      if (!response.ok)
        throw Error((await response.json()).error || "滤镜预览生成失败");
      return response.blob();
    },
    signal,
  );
}
export async function compositeBlob(
  document: CompositeDocument,
  signal?: AbortSignal,
) {
  const { port, token } = await connect();
  const response = await fetch(
    `http://127.0.0.1:${port}/api/composite-preview`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(document),
      signal,
    },
  );
  if (!response.ok)
    throw Error((await response.json()).error || "合成预览失败");
  return response.blob();
}
export function classifyPhotos(
  photos: Photo[],
  albumId: number | null,
  facets: Facets,
) {
  return photos.filter(
    (p) =>
      (albumId === null || p.album_ids?.includes(albumId)) &&
      Object.entries(facets).every(
        ([key, value]) =>
          !value || facetValue(p, key as keyof Facets) === value,
      ),
  );
}
export const facetKeys = [
  "color",
  "tone",
  "brightness",
  "content",
  "date",
  "saturation",
  "contrast",
  "orientation",
  "format",
  "resolution",
  "quality",
  "style",
  "film",
] as const;
export function facetValue(photo: Photo, key: keyof Facets): string {
  if (key === "date") return localDate(photo.captured);
  if (key === "content") return photo.features?.content?.label || "unindexed";
  if (key === "saturation" || key === "contrast") {
    const value = photo.features?.[key];
    if (typeof value !== "number" || !Number.isFinite(value))
      return "unindexed";
    return value < (key === "saturation" ? 0.16 : 0.08)
      ? "low"
      : value >= (key === "saturation" ? 0.45 : 0.2)
        ? "high"
        : "balanced";
  }
  if (key === "orientation")
    return Math.abs(photo.width / photo.height - 1) < 0.05
      ? "square"
      : photo.width > photo.height
        ? "landscape"
        : "portrait";
  if (key === "format") {
    if (isRaw(photo)) return "raw";
    const extension = photo.path.split(".").pop()?.toLowerCase() || "";
    if (extension === "heif") return "heic";
    return extension === "jpg" || extension === "jpeg"
      ? "jpeg"
      : extension === "tif" || extension === "tiff"
        ? "tiff"
        : extension;
  }
  if (key === "resolution")
    return photo.width * photo.height >= 20e6
      ? "large"
      : photo.width * photo.height >= 8e6
        ? "medium"
        : "small";
  if (key === "quality")
    return photo.score >= 75 ? "high" : photo.score >= 45 ? "balanced" : "low";
  if (key === "style") return String(photo.recipe?.style || "natural");
  if (key === "film") return String(photo.recipe?.film_stock || "none");
  return photo.features?.[key] || "unindexed";
}
export function facetCounts(
  photos: Photo[],
  facets: Facets,
  key: keyof Facets,
): Record<string, number> {
  const scope = classifyPhotos(photos, null, { ...facets, [key]: "" });
  const counts: Record<string, number> = {};
  for (const photo of scope) {
    const value = facetValue(photo, key);
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}
export const splitPosition = (clientX: number, left: number, width: number) =>
  width > 0 ? Math.min(1, Math.max(0, (clientX - left) / width)) : 0.5;
export const localDate = (timestamp: number) => {
  const date = new Date(timestamp * 1000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
export async function pickFiles() {
  if (!isTauri()) throw new Error("请在桌面应用中使用系统文件选择器。");
  return invoke<string[]>("pick_photos");
}
export async function pickFolder() {
  if (!isTauri()) throw new Error("请在桌面应用中使用系统文件夹选择器。");
  return invoke<string | null>("pick_folder");
}
export function selectPhotos(
  photos: Photo[],
  group: string,
  filter: string,
  search: string,
  sort: string,
) {
  return photos
    .filter(
      (p) =>
        (group === "all" || p.group_id === group) &&
        (filter === "all" ||
          (filter === "duplicates"
            ? !!p.duplicate_of
            : p.decision === filter)) &&
        p.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
    )
    .sort((a, b) =>
      sort === "score" ? b.score - a.score : a.captured - b.captured,
    );
}
const raw = /\.(nef|dng|arw|cr2|cr3|raf|rw2|orf|pef)$/i;
export const isRaw = (photo: Photo) => raw.test(photo.path);
export type VariantMode = "all" | "raw" | "jpeg";

function variantKind(photo: Photo): "raw" | "jpeg" | undefined {
  return isRaw(photo)
    ? "raw"
    : /\.jpe?g$/i.test(photo.path)
      ? "jpeg"
      : undefined;
}

function variantPairKey(photo: Photo): string | undefined {
  if (!variantKind(photo)) return undefined;
  const normalized = photo.path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/"),
    dot = normalized.lastIndexOf(".");
  const directory = normalized.slice(0, slash + 1).replace(/\/{2,}/g, "/");
  const stem = normalized.slice(slash + 1, dot);
  return `${directory}\0${stem}`
    .normalize("NFC")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/ς/g, "σ");
}

function variantGroups(photos: Photo[]): Map<string, number> {
  const groups = new Map<string, number>();
  for (const photo of photos) {
    const key = variantPairKey(photo);
    if (key !== undefined)
      groups.set(key, (groups.get(key) || 0) | (isRaw(photo) ? 1 : 2));
  }
  return groups;
}

/** Hide only the non-preferred member type of a local RAW + JPEG pair. */
export function applyVariantPreference(
  photos: Photo[],
  mode: VariantMode,
): Photo[] {
  if (mode === "all") return photos;
  const groups = variantGroups(photos);
  return photos.filter((photo) => {
    const key = variantPairKey(photo);
    return (
      key === undefined || groups.get(key) !== 3 || variantKind(photo) === mode
    );
  });
}

/** Carry paired variants into a review scope so its display mode can be changed. */
export function expandVariantScope(source: Photo[], ids: number[]): Photo[] {
  const selected = new Set(ids),
    groups = variantGroups(source);
  const pairs = new Set<string>();
  for (const photo of source) {
    const key = variantPairKey(photo);
    if (selected.has(photo.id) && key !== undefined && groups.get(key) === 3)
      pairs.add(key);
  }
  return source.filter(
    (photo) => selected.has(photo.id) || pairs.has(variantPairKey(photo)!),
  );
}

/** Preserve review position when a preference hides the current capture variant. */
export function resolveVariantSelection(
  source: Photo[],
  visible: Photo[],
  currentId: number | undefined,
  previousIds: number[] = source.map((photo) => photo.id),
): number | undefined {
  const ids = new Set(visible.map((photo) => photo.id));
  if (currentId !== undefined && ids.has(currentId)) return currentId;
  const current = source.find((photo) => photo.id === currentId);
  const key = current && variantPairKey(current);
  if (key !== undefined) {
    const paired = visible.find(
      (photo) =>
        variantPairKey(photo) === key &&
        variantKind(photo) !== variantKind(current!),
    );
    if (paired) return paired.id;
  }
  const index = previousIds.indexOf(currentId!);
  for (let next = index + 1; next < previousIds.length; next++) {
    if (ids.has(previousIds[next])) return previousIds[next];
  }
  for (let previous = index - 1; previous >= 0; previous--) {
    if (ids.has(previousIds[previous])) return previousIds[previous];
  }
  return visible[0]?.id;
}
export function exportIds(photos: Photo[], format: string) {
  return [
    ...new Set(
      photos.filter((p) => format !== "tiff16" || isRaw(p)).map((p) => p.id),
    ),
  ];
}
export function recommendIds(photos: Photo[]) {
  const groups = new Map<string, Photo[]>();
  photos
    .filter((p) => p.decision === "pending" && !p.duplicate_of)
    .forEach((p) =>
      groups.set(p.group_id, [...(groups.get(p.group_id) || []), p]),
    );
  return [...groups.values()].flatMap((g) =>
    g
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.ceil(g.length / 3))
      .map((p) => p.id),
  );
}
export const dateLabel = (timestamp: number) =>
  new Date(timestamp * 1000).toLocaleDateString("zh-CN", {
    month: "long",
    day: "numeric",
  });
export const styleLabel: Record<string, string> = {
  natural: "原生质感",
  warm: "暖日胶片",
  cool: "清透冷调",
  film: "柔和胶片",
  mono: "经典黑白",
  cinema: "电影叙事",
  soft: "柔光人像",
  matte: "哑光日常",
  teal_orange: "青橙映像",
  vintage: "褪色记忆",
  highkey: "明亮空气",
  night: "蓝调夜色",
  autumn: "秋日琥珀",
  forest: "森林绿意",
  rose: "玫瑰微光",
  sepia: "棕褐旧照",
  cyanotype: "蓝晒印相",
};

export async function persistRecipes(
  batch: Map<number, Recipe>,
  pending: Map<number, Recipe>,
  save: (id: number, recipe: Recipe) => Promise<void>,
) {
  const remaining = new Map(batch);
  try {
    for (const [id, recipe] of batch) {
      await save(id, recipe);
      remaining.delete(id);
    }
  } catch (error) {
    for (const [id, recipe] of remaining) {
      if (!pending.has(id)) pending.set(id, recipe);
    }
    throw error;
  }
}

export type FilmTableView = { x: number; y: number; scale: number };
export function filmDockTransform(
  frame: { x: number; y: number; width: number; height: number },
  dock: { x: number; y: number; width: number; height: number },
) {
  return { x: dock.x - frame.x, y: dock.y - frame.y,
    scaleX: dock.width / Math.max(1, frame.width),
    scaleY: dock.height / Math.max(1, frame.height) };
}
export function filmRollPlayback(view: FilmTableView, frames: FilmTableFrame[], width: number) {
  if (!frames.length) return null;
  const left = frames[0].x, right = frames.at(-1)!.x + frames.at(-1)!.width;
  const end = width - 50 - right * view.scale, beginning = 50 - left * view.scale;
  if (end >= beginning) return null;
  const start = view.x <= end + .5 ? beginning : Math.max(end, Math.min(beginning, view.x));
  const speed = Math.max(48, Math.min(120, (right - left) * view.scale / frames.length / 6));
  return {start, end, duration: (start - end) / speed * 1000};
}
// SVG displacement uses neutral 128 in sRGB. The radius-squared field gives
// smoothly increasing refraction; separate RGB scales model edge dispersion.
export function filmRefractionMap(size = 128) {
  const width = Math.max(2, Math.min(512, Math.floor(size))),
    data = new Uint8ClampedArray(width * width * 4),
    half = (width - 1) / 2;
  for (let y = 0; y < width; y++)
    for (let x = 0; x < width; x++) {
      const u = (x - half) / half,
        v = (y - half) / half,
        k = Math.min(1, u * u + v * v),
        i = (y * width + x) * 4;
      data[i] = 128 + 127 * u * k;
      data[i + 1] = 128 + 127 * v * k;
      data[i + 2] = 128;
      data[i + 3] = 255;
    }
  return data;
}
export type FilmTableFrame = {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
};
export function resizeFilmFrame(
  frame: FilmTableFrame,
  scale: number,
  decorated = true,
): FilmTableFrame {
  const factor = Math.max(0.3, Math.min(4, scale));
  const width =
      (frame.width - (decorated ? 12 : 0)) * factor + (decorated ? 12 : 0),
    height =
      (frame.height - (decorated ? 60 : 0)) * factor + (decorated ? 60 : 0);
  return {
    ...frame,
    x: frame.x + (frame.width - width) / 2,
    y: frame.y + (frame.height - height) / 2,
    width,
    height,
  };
}
export function filmRollLayout(
  photos: { id: number; width: number; height: number }[],
  decorated = true,
): FilmTableFrame[] {
  let x = 40;
  return photos.map((p) => {
    const width =
        200 * Math.max(0.35, Math.min(3, p.width / Math.max(1, p.height))) +
        (decorated ? 12 : 0),
      frame = { id: p.id, x, y: 40, width, height: decorated ? 260 : 200 };
    x += width;
    return frame;
  });
}
export function filmTableLayout(
  photos: { id: number; width: number; height: number }[],
  columns: number | {width: number; height: number} = 8,
  decorated = true,
): FilmTableFrame[] {
  if (typeof columns !== 'number') {
    if (!photos.length) return [];
    const width = Math.max(240, columns.width);
    const height = Math.max(120, columns.height);
    let best: FilmTableFrame[] = [], bestScale = -1;
    // Keep the original equal-width frames, 28px column gaps and 48px row gaps.
    // Only the number of columns adapts; image and film rails scale together.
    for (let count = 1; count <= photos.length; count++) {
      const candidate = filmTableLayout(photos, count, decorated);
      const right = Math.max(...candidate.map(frame => frame.x + frame.width));
      const bottom = Math.max(...candidate.map(frame => frame.y + frame.height));
      const scale = Math.min(3, width / (right - 40), height / (bottom - 40));
      if (scale > bestScale) {
        bestScale = scale;
        best = candidate;
      }
    }
    return best;
  }
  const count = Math.max(1, Math.floor(columns)),
    width = 180,
    gap = 28;
  let y = 40;
  const frames: FilmTableFrame[] = [];
  for (let row = 0; row < photos.length; row += count) {
    const group = photos.slice(row, row + count),
      heights = group.map(
        (p) =>
          width / Math.max(0.35, Math.min(3, p.width / Math.max(1, p.height))) +
          (decorated ? 60 : 0),
      );
    group.forEach((p, i) =>
      frames.push({
        id: p.id,
        x: 40 + i * (width + gap),
        y,
        width,
        height: heights[i],
      }),
    );
    y += Math.max(...heights) + 48;
  }
  return frames;
}
export function filmTableZoom(
  view: FilmTableView,
  pointer: { x: number; y: number },
  scale: number,
): FilmTableView {
  const next = Math.max(0.15, Math.min(3, scale));
  return {
    x: pointer.x - ((pointer.x - view.x) * next) / view.scale,
    y: pointer.y - ((pointer.y - view.y) * next) / view.scale,
    scale: next,
  };
}
export function filmLoupeTransform(
  view: FilmTableView,
  pointer: { x: number; y: number },
  magnification: number,
  radius: number,
): FilmTableView {
  return {
    x: radius + (view.x - pointer.x) * magnification,
    y: radius + (view.y - pointer.y) * magnification,
    scale: view.scale * magnification,
  };
}

export function reviewPhotos(photos: Photo[], ids: number[]) {
  const available = new Map(photos.map((p) => [p.id, p]));
  return [...new Set(ids)].flatMap((id) =>
    available.has(id) ? [available.get(id)!] : [],
  );
}
export function albumSelectionPhotos(photos: Photo[], ids: number[]) {
  const selected = new Set(ids);
  return photos.filter((p) => p.album_ids.some((id) => selected.has(id)));
}
export function reviewStep(
  ids: number[],
  current: number,
  delta: number,
  skip?: number,
) {
  const index = ids.indexOf(current);
  if (index < 0) return ids[0];
  if (!delta) return current;
  for (let i = index + delta; i >= 0 && i < ids.length; i += delta) {
    if (ids[i] !== skip) return ids[i];
  }
  return current;
}
export function reviewPair(ids: number[], current: number, reference?: number) {
  if (ids.length < 2) return { current: ids[0], reference: undefined };
  const pinned = reference && ids.includes(reference) ? reference : ids[0];
  return {
    current:
      ids.includes(current) && current !== pinned
        ? current
        : ids.find((id) => id !== pinned)!,
    reference: pinned,
  };
}
export async function viewerFullscreen(enabled?: boolean): Promise<boolean> {
  if (isTauri())
    return invoke<boolean>("viewer_fullscreen", { enabled: enabled ?? null });
  if (enabled === true && !document.fullscreenElement)
    await document.documentElement.requestFullscreen();
  if (enabled === false && document.fullscreenElement)
    await document.exitFullscreen();
  return !!document.fullscreenElement;
}

export async function guardDesktopClose(
  save: () => Promise<void>,
  error: (message: string) => void,
) {
  if (!isTauri()) return () => {};
  return getCurrentWindow().onCloseRequested(
    createCloseHandler(
      save,
      () => invoke<void>("finish_close"),
      () => invoke<void>("exit_app"),
      error,
    ),
  );
}

export function createCloseHandler(
  save: () => Promise<void>,
  closeWindow: () => Promise<void>,
  exitApp: () => Promise<void>,
  report: (message: string) => void,
) {
  let closing = false;
  return async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (closing) return;
    closing = true;
    try {
      await save();
      try {
        await closeWindow();
      } catch {
        // Saving succeeded. A dead window dispatcher must not trap the user.
        await exitApp();
      }
    } catch (reason) {
      closing = false;
      report(reason instanceof Error ? reason.message : String(reason));
    }
  };
}
