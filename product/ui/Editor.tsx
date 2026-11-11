// SPDX-License-Identifier: GPL-3.0-or-later
// Workspace tools write recipes; pixels, export and undo stay in the shared engine.
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Crop,
  Palette,
  CircleDot,
  Film,
  Aperture,
  Layers,
  Undo2,
  Redo2,
  RotateCw,
  FlipHorizontal,
  FlipVertical,
  Minus,
  Plus,
  Maximize2,
  Download,
  Heart,
  X,
  CheckCheck,
  SlidersHorizontal,
  ArrowUp,
  ArrowDown,
  Eye,
  EyeOff,
  Search,
  SquareSlash,
  Sun,
  Moon,
  Frame,
  Spline,
  Focus,
  Sparkles,
} from "lucide-react";
import {
  Photo,
  Recipe,
  Library,
  photoDimensions,
  filterBlob,
  geometrySignature,
  FilterLayer,
  filterLayers,
  filtersPatch,
  newFilterLayer,
  styleLabel,
  selectFilterPreset,
} from "./model";
import { Comparison, Picture } from "./Preview";
import { FilmControls, NumericValue } from "./Film";
import { BorderControls, BorderPreview } from "./Borders";

type Point = { x: number; y: number };
export type CropRect = Point & { w: number; h: number };
type CurvePoint = [number, number];
type Operation = Point & Record<string, string | number>;
type Tool =
  | "move"
  | "composition"
  | "adjust"
  | "filters"
  | "tone"
  | "curves"
  | "color"
  | "detail"
  | "retouch"
  | "local"
  | "film"
  | "border"
  | "raw";
const clamp = (v: number, low = 0, high = 1) =>
  Math.max(low, Math.min(high, v));
const number = (r: Recipe, name: string, fallback = 0) =>
  Number(r[name] ?? fallback);
const parse = <T,>(value: string | number | undefined, fallback: T): T => {
  try {
    return value === undefined ? fallback : JSON.parse(String(value));
  } catch {
    return fallback;
  }
};
// Python round(), used by the engine for crop pixel edges, rounds ties to even.
const pixelRound = (value: number) => {
  const base = Math.floor(value),
    fraction = value - base;
  return fraction === 0.5 ? base + (base % 2) : Math.round(value);
};
export function geometryToSource(
  x: number,
  y: number,
  width: number,
  height: number,
  r: Recipe,
): Point {
  const turns = number(r, "quarter_turns"),
    tw = turns % 2 ? height : width,
    th = turns % 2 ? width : height;
  const left = Math.min(tw - 1, pixelRound(number(r, "crop_x") * tw));
  const top = Math.min(th - 1, pixelRound(number(r, "crop_y") * th));
  const right = Math.min(
    tw,
    Math.max(
      left + 1,
      pixelRound((number(r, "crop_x") + number(r, "crop_w", 1)) * tw),
    ),
  );
  const bottom = Math.min(
    th,
    Math.max(
      top + 1,
      pixelRound((number(r, "crop_y") + number(r, "crop_h", 1)) * th),
    ),
  );
  const px = left + x * (right - left) - tw / 2,
    py = top + y * (bottom - top) - th / 2;
  const angle = (number(r, "straighten") * Math.PI) / 180;
  const c = Math.abs(Math.cos(angle)),
    s = Math.abs(Math.sin(angle));
  const scale = angle
    ? Math.max(c + (s * th) / tw, c + (s * tw) / th) *
      (1 + 2 / Math.max(1, Math.min(tw, th)))
    : 1;
  let u = ((Math.cos(angle) * px - Math.sin(angle) * py) / scale + tw / 2) / tw;
  let v = ((Math.sin(angle) * px + Math.cos(angle) * py) / scale + th / 2) / th;
  if (number(r, "flip_x")) u = 1 - u;
  if (number(r, "flip_y")) v = 1 - v;
  for (let i = 0; i < turns; i++) [u, v] = [v, 1 - u];
  return { x: u, y: v };
}
export function aspectCrop(
  rect: CropRect,
  aspect: number,
  width: number,
  height: number,
): CropRect {
  let w = clamp(rect.w, 0.01, 1),
    h = clamp(rect.h, 0.01, 1);
  if (aspect > 0) {
    const ratio = (aspect * height) / width;
    if (w / h > ratio) w = h * ratio;
    else h = w / ratio;
    if (w < 0.01) {
      w = 0.01;
      h = w / ratio;
    }
    if (h < 0.01) {
      h = 0.01;
      w = h * ratio;
    }
    w = clamp(w, 0.01, 1);
    h = clamp(h, 0.01, 1);
  }
  return {
    x: clamp(rect.x + (rect.w - w) / 2, 0, 1 - w),
    y: clamp(rect.y + (rect.h - h) / 2, 0, 1 - h),
    w,
    h,
  };
}
export function moveCurvePoint(
  points: CurvePoint[],
  index: number,
  x: number,
  y: number,
): CurvePoint[] {
  const margin =
    index > 0 && index < points.length - 1
      ? Math.min(0.002, (points[index + 1][0] - points[index - 1][0]) / 3)
      : 0;
  return points.map((point, i) =>
    i !== index
      ? [...point]
      : [
          index === 0
            ? 0
            : index === points.length - 1
              ? 1
              : clamp(
                  x,
                  points[index - 1][0] + margin,
                  points[index + 1][0] - margin,
                ),
          clamp(y),
        ],
  ) as CurvePoint[];
}
export function appendOperations<T extends Point>(old: T[], stamps: T[]): T[] {
  return [
    ...old,
    ...stamps.filter(
      (p) =>
        Number.isFinite(p.x) &&
        Number.isFinite(p.y) &&
        p.x >= 0 &&
        p.x <= 1 &&
        p.y >= 0 &&
        p.y <= 1,
    ),
  ].slice(0, 256);
}
export function historyShortcut(
  key: string,
  control: boolean,
  shift: boolean,
): "undo" | "redo" | null {
  if (!control) return null;
  if (key.toLowerCase() === "z") return shift ? "redo" : "undo";
  return key.toLowerCase() === "y" ? "redo" : null;
}
export function geometryInteractionReady(
  live: Recipe,
  committed: Recipe,
  rendered: string | undefined,
  ready: boolean,
  uncropped: boolean,
) {
  if (!ready || geometrySignature(live) !== geometrySignature(committed))
    return false;
  const expected = geometrySignature(
    uncropped
      ? { ...committed, crop_x: 0, crop_y: 0, crop_w: 1, crop_h: 1 }
      : committed,
  );
  return expected === rendered;
}
const cropFrom = (r: Recipe): CropRect => ({
  x: number(r, "crop_x"),
  y: number(r, "crop_y"),
  w: number(r, "crop_w", 1),
  h: number(r, "crop_h", 1),
});
const fullCrop = { crop_x: 0, crop_y: 0, crop_w: 1, crop_h: 1 };
const neutralCurve = "[[0,0],[1,1]]";
export const editorTools: {
  id: Tool;
  label: string;
  shortcut?: string;
  icon: React.ComponentType<{ size?: number }>;
}[] = [
  { id: "composition", label: "构图", shortcut: "C", icon: Crop },
  {
    id: "adjust",
    label: "调节",
    shortcut: "L / U / S",
    icon: SlidersHorizontal,
  },
  { id: "filters", label: "滤镜", shortcut: "K", icon: Palette },
  { id: "film", label: "胶片模拟", shortcut: "G", icon: Film },
  { id: "border", label: "片边", shortcut: "B", icon: Frame },
  { id: "raw", label: "RAW 显影", shortcut: "R", icon: Aperture },
];

export function editorToolShortcut(key: string): Tool | null {
  return (
    editorTools.find(({ shortcut }) =>
      shortcut?.split(" / ").includes(key.toUpperCase()),
    )?.id ?? null
  );
}

const adjustmentPanels = [
  { id: "tone", label: "光线", hint: "曝光 / 明暗", icon: Sun },
  { id: "color", label: "色彩", hint: "白平衡 / 饱和", icon: Palette },
  {
    id: "levels",
    label: "色阶与伽马",
    hint: "黑白场 / 中间调",
    icon: SlidersHorizontal,
  },
  { id: "curves", label: "曲线", hint: "RGB / 通道", icon: Spline },
  { id: "mixer", label: "混色器 HSL", hint: "分色调整", icon: CircleDot },
  { id: "detail", label: "细节", hint: "锐化 / 降噪", icon: Focus },
  {
    id: "effects",
    label: "效果",
    hint: "清晰度 / 去雾 / 暗角",
    icon: Sparkles,
  },
] as const;

type AdjustmentId = (typeof adjustmentPanels)[number]["id"];

function Histogram({
  image,
  version,
}: {
  image: HTMLImageElement | null;
  version: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, 280, 72);
    if (!image) return;
    const probe = document.createElement("canvas");
    probe.width = 128;
    probe.height = 80;
    const read = probe.getContext("2d", { willReadFrequently: true })!;
    read.drawImage(image, 0, 0, 128, 80);
    const data = read.getImageData(0, 0, 128, 80).data;
    const bins = Array.from({ length: 3 }, () => Array<number>(64).fill(0));
    for (let i = 0; i < data.length; i += 4)
      for (let c = 0; c < 3; c++) bins[c][data[i + c] >> 2]++;
    const peak = Math.max(1, ...bins.flat());
    ["#dd987e", "#a4bb91", "#87a9d0"].forEach((color, c) => {
      context.fillStyle = color;
      context.globalAlpha = 0.58;
      context.beginPath();
      context.moveTo(0, 72);
      bins[c].forEach((v, i) =>
        context.lineTo((i / 63) * 280, 72 - Math.sqrt(v / peak) * 68),
      );
      context.lineTo(280, 72);
      context.fill();
    });
  }, [image, version]);
  return (
    <div className="ew-histogram">
      <div>
        <span>RGB 直方图</span>
        <small>屏幕预览</small>
      </div>
      <canvas ref={canvas} width={280} height={72} />
      <footer>
        <span>阴影</span>
        <span>中间调</span>
        <span>高光</span>
      </footer>
    </div>
  );
}

function CurveEditor({
  value,
  color,
  onChange,
}: {
  value: string;
  color: string;
  onChange: (value: string) => void;
}) {
  const [points, setPoints] = useState<CurvePoint[]>(
    parse(value, [
      [0, 0],
      [1, 1],
    ]),
  );
  const [selected, setSelected] = useState(0);
  const drag = useRef<number | null>(null);
  const live = useRef(points);
  live.current = points;
  useEffect(() => {
    if (drag.current === null)
      setPoints(
        parse(value, [
          [0, 0],
          [1, 1],
        ]),
      );
  }, [value]);
  const coordinate = (e: React.PointerEvent<SVGSVGElement>) => {
    const bounds = e.currentTarget.getBoundingClientRect();
    return {
      x: clamp((e.clientX - bounds.left) / bounds.width),
      y: clamp(1 - (e.clientY - bounds.top) / bounds.height),
    };
  };
  return (
    <div className="ew-curve">
      <svg
        viewBox="0 0 256 256"
        role="application"
        aria-label="分段线性曲线编辑器"
        onDoubleClick={(e) => {
          if (points.length >= 16) return;
          const bounds = e.currentTarget.getBoundingClientRect(),
            x = clamp((e.clientX - bounds.left) / bounds.width, 0.003, 0.997),
            y = clamp(1 - (e.clientY - bounds.top) / bounds.height);
          if (points.some((p) => Math.abs(p[0] - x) < 0.005)) return;
          const next = [...points, [x, y] as CurvePoint].sort(
            (a, b) => a[0] - b[0],
          );
          setPoints(next);
          setSelected(next.findIndex((p) => p[0] === x));
          onChange(JSON.stringify(next));
        }}
        onPointerMove={(e) => {
          if (drag.current !== null) {
            const p = coordinate(e);
            const next = moveCurvePoint(live.current, drag.current, p.x, p.y);
            live.current = next;
            setPoints(next);
          }
        }}
        onPointerUp={(e) => {
          if (drag.current !== null) {
            drag.current = null;
            onChange(JSON.stringify(live.current));
            e.currentTarget.releasePointerCapture(e.pointerId);
          }
        }}
        onPointerCancel={() => {
          drag.current = null;
          setPoints(
            parse(value, [
              [0, 0],
              [1, 1],
            ]),
          );
        }}
      >
        <rect width="256" height="256" fill="#15191e" />
        {[64, 128, 192].map((n) => (
          <path
            key={n}
            d={`M${n} 0V256M0 ${n}H256`}
            stroke="#333a42"
            strokeWidth="1"
          />
        ))}
        <path d="M0 256L256 0" stroke="#555d68" strokeDasharray="4 4" />
        <polyline
          points={points
            .map((p) => `${p[0] * 256},${(1 - p[1]) * 256}`)
            .join(" ")}
          fill="none"
          stroke={color}
          strokeWidth="2"
        />
        {points.map((p, i) => (
          <circle
            key={i}
            cx={p[0] * 256}
            cy={(1 - p[1]) * 256}
            r={selected === i ? 6 : 4.5}
            fill={selected === i ? color : "#171c22"}
            stroke={color}
            strokeWidth="2"
            onPointerDown={(e) => {
              e.preventDefault();
              setSelected(i);
              drag.current = i;
              e.currentTarget.ownerSVGElement!.setPointerCapture(e.pointerId);
            }}
          />
        ))}
      </svg>
      <div className="ew-curve-meta">
        <div className="ew-curve-values">
          输入{" "}
          <NumericValue
            label="曲线输入"
            value={(points[selected]?.[0] || 0) * 255}
            min={0}
            max={255}
            step={1}
            disabled={selected === 0 || selected === points.length - 1}
            onChange={(x) => {
              const next = moveCurvePoint(
                points,
                selected,
                x / 255,
                points[selected][1],
              );
              setPoints(next);
              onChange(JSON.stringify(next));
            }}
          />
          输出{" "}
          <NumericValue
            label="曲线输出"
            value={(points[selected]?.[1] || 0) * 255}
            min={0}
            max={255}
            step={1}
            onChange={(y) => {
              const next = moveCurvePoint(
                points,
                selected,
                points[selected][0],
                y / 255,
              );
              setPoints(next);
              onChange(JSON.stringify(next));
            }}
          />
        </div>
        <button
          disabled={selected === 0 || selected === points.length - 1}
          onClick={() => {
            const next = points.filter((_, i) => i !== selected);
            setPoints(next);
            setSelected(0);
            onChange(JSON.stringify(next));
          }}
        >
          删除控制点
        </button>
      </div>
      <small>双击添加，拖动调整 · 线性插值，最多 16 点</small>
    </div>
  );
}

function FilterThumbnail({
  photo,
  id,
  revision,
}: {
  photo: Photo;
  id: string;
  revision: number;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = "",
      started = false;
    setUrl("");
    setFailed(false);
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting) || started) return;
        started = true;
        observer.disconnect();
        filterBlob(photo, id, 180, controller.signal, revision)
          .then((blob) => {
            if (controller.signal.aborted) return;
            objectUrl = URL.createObjectURL(blob);
            setUrl(objectUrl);
          })
          .catch(() => {
            if (!controller.signal.aborted) setFailed(true);
          });
      },
      {
        root: host.current?.closest(".ew-inspector-scroll"),
        rootMargin: "60px",
      },
    );
    if (host.current) observer.observe(host.current);
    return () => {
      controller.abort();
      observer.disconnect();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [photo.id, id, revision]);
  return (
    <span className="ew-filter-thumbnail" ref={host}>
      {url ? (
        <img src={url} alt="" draggable={false} />
      ) : (
        <small>{failed ? "预览不可用" : "预览"}</small>
      )}
    </span>
  );
}

type FilterPreset = {
  key: string;
  kind: FilterLayer["kind"];
  id: string;
  label: string;
  group: string;
  ready: boolean;
};

function FilterControls({
  photo,
  revision,
  catalog,
  update,
  disabled,
}: {
  photo: Photo;
  revision: number;
  catalog?: Library["filters"];
  update: (patch: Recipe) => void;
  disabled: boolean;
}) {
  const host = useRef<HTMLDivElement>(null),
    layers = filterLayers(photo.recipe);
  const [selectedUid, setSelectedUid] = useState<string | null>(
    () => layers.at(-1)?.uid ?? null,
  );
  const [draftIndex, setDraftIndex] = useState(layers.length),
    [tab, setTab] = useState<"filters" | "favorites">("filters");
  const [query, setQuery] = useState(""),
    [searchOpen, setSearchOpen] = useState(false);
  const [closed, setClosed] = useState<Record<string, boolean>>({}),
    [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem("photoall-filter-favorites-v1") || "[]",
      );
      return Array.isArray(saved)
        ? saved.filter((v) => typeof v === "string")
        : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(
        "photoall-filter-favorites-v1",
        JSON.stringify(favorites),
      );
    } catch {}
  }, [favorites]);
  useEffect(() => {
    if (selectedUid && !layers.some((layer) => layer.uid === selectedUid))
      setSelectedUid(null);
  }, [layers.map((layer) => layer.uid).join("|")]);
  const presets: FilterPreset[] = [
    ...Object.entries(styleLabel)
      .filter(([id]) => id !== "natural")
      .map(([id, label]) => ({
        key: `style:${id}`,
        kind: "style" as const,
        id,
        label,
        group: "基础风格",
        ready: true,
      })),
    ...Object.entries(catalog?.items || {}).map(([id, item]) => ({
      key: `lut:${id}`,
      kind: "lut" as const,
      id,
      label: item.label,
      group: item.group,
      ready: item.ready,
    })),
  ];
  const index = layers.findIndex((layer) => layer.uid === selectedUid),
    active = layers[index];
  const activeKey = active ? `${active.kind}:${active.id}` : "";
  const current = presets.find((preset) => preset.key === activeKey);
  useEffect(() => {
    if (!current) return;
    const group = tab === "favorites" ? "我的收藏" : current.group;
    setClosed((old) => ({ ...old, [group]: false }));
    setExpanded((old) => ({ ...old, [group]: true }));
  }, [activeKey, tab]);
  const name = (layer: FilterLayer) =>
    presets.find((preset) => preset.key === `${layer.kind}:${layer.id}`)
      ?.label || layer.id;
  const save = (next: FilterLayer[]) => update(filtersPatch(next));
  const choose = (preset: FilterPreset) => {
    const next = selectFilterPreset(
      layers,
      selectedUid,
      preset.kind,
      preset.id,
      draftIndex,
    );
    setSelectedUid(next.uid);
    if (next.layers !== layers) save(next.layers);
  };
  const original = () => {
    if (index >= 0) {
      save(layers.filter((_, i) => i !== index));
      setDraftIndex(index);
    }
    setSelectedUid(null);
  };
  const remove = () => {
    const next = layers.filter((_, i) => i !== index);
    save(next);
    setSelectedUid(next[Math.min(index, next.length - 1)]?.uid ?? null);
    setDraftIndex(next.length);
  };
  const move = (offset: number) => {
    const next = [...layers];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    save(next);
  };
  const toggleFavorite = (key: string) =>
    setFavorites((old) =>
      old.includes(key) ? old.filter((item) => item !== key) : [...old, key],
    );
  const selectLayer = (layer: FilterLayer) => {
    setSelectedUid(layer.uid);
    const preset = presets.find(
      (item) => item.key === `${layer.kind}:${layer.id}`,
    );
    if (!preset) return;
    const group =
      tab === "favorites" && favorites.includes(preset.key)
        ? "我的收藏"
        : preset.group;
    if (tab === "favorites" && !favorites.includes(preset.key))
      setTab("filters");
    setClosed((old) => ({ ...old, [group]: false }));
    setExpanded((old) => ({ ...old, [group]: true }));
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        [
          ...(host.current?.querySelectorAll<HTMLElement>(
            "[data-preset-key]",
          ) || []),
        ]
          .find((node) => node.dataset.presetKey === preset.key)
          ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }),
    );
  };
  const filtered = presets.filter(
    (preset) =>
      (tab !== "favorites" || favorites.includes(preset.key)) &&
      `${preset.label} ${preset.group}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase().trim()),
  );
  const groups =
    tab === "favorites"
      ? ["我的收藏"]
      : [...new Set(filtered.map((preset) => preset.group))];
  const strength = () =>
    active && (
      <label className="fb-intensity" key="strength">
        <span>
          强度
          <NumericValue
            label="当前滤镜强度"
            value={active.strength * 100}
            min={0}
            max={100}
            step={1}
            disabled={disabled || !active.enabled}
            onChange={(value) =>
              save(
                layers.map((layer, i) =>
                  i === index ? { ...layer, strength: value / 100 } : layer,
                ),
              )
            }
          />
        </span>
        <input
          type="range"
          aria-label="当前滤镜强度"
          min={0}
          max={1}
          step={0.01}
          value={active.strength}
          disabled={disabled || !active.enabled}
          onChange={(e) =>
            save(
              layers.map((layer, i) =>
                i === index
                  ? { ...layer, strength: Number(e.target.value) }
                  : layer,
              ),
            )
          }
        />
      </label>
    );
  return (
    <div className="filter-browser" ref={host} aria-label="滤镜浏览器">
      <div className="fb-top">
        <div className="fb-tabs" role="tablist" aria-label="滤镜资源">
          <button
            role="tab"
            aria-selected={tab === "filters"}
            onClick={() => setTab("filters")}
          >
            滤镜
          </button>
          <button
            role="tab"
            aria-selected={tab === "favorites"}
            onClick={() => setTab("favorites")}
          >
            收藏
          </button>
          <button
            aria-label="搜索滤镜"
            title="搜索滤镜"
            onClick={() => {
              if (searchOpen) setQuery("");
              setSearchOpen((v) => !v);
            }}
          >
            <Search size={15} />
          </button>
        </div>
        <div className="fb-layer-strip" role="group" aria-label="已叠加的滤镜">
          {layers.map((layer, i) => (
            <button
              className={`fb-layer-chip ${selectedUid === layer.uid ? "selected" : ""} ${layer.enabled ? "" : "is-disabled"}`}
              key={layer.uid}
              aria-label={`选择滤镜层 ${i + 1} ${name(layer)}`}
              aria-pressed={selectedUid === layer.uid}
              title={`${name(layer)} · ${Math.round(layer.strength * 100)}%`}
              onClick={() => selectLayer(layer)}
            >
              <FilterThumbnail
                photo={photo}
                id={layer.kind === "style" ? `style:${layer.id}` : layer.id}
                revision={revision}
              />
              <span>{i + 1}</span>
              {!layer.enabled && <EyeOff size={13} />}
            </button>
          ))}
          <button
            className={`fb-add-layer ${selectedUid === null ? "selected" : ""}`}
            title="新建滤镜层，再从下方选择"
            aria-label="新增滤镜层"
            aria-pressed={selectedUid === null}
            disabled={disabled || layers.length >= 16}
            onClick={() => {
              setSelectedUid(null);
              setDraftIndex(layers.length);
            }}
          >
            <Plus size={24} />
          </button>
        </div>
        <div className="fb-layer-actions">
          <span>
            {active
              ? `${index + 1}/${layers.length} · ${name(active)}`
              : layers.length >= 16
                ? "最多叠加 16 层"
                : "选择预设，新建一层"}
          </span>
          {active && (
            <>
              <button
                aria-label="当前滤镜提前应用"
                title="更早应用"
                disabled={disabled || index === 0}
                onClick={() => move(-1)}
              >
                <ArrowLeft size={14} />
              </button>
              <button
                aria-label="当前滤镜延后应用"
                title="更晚应用"
                disabled={disabled || index === layers.length - 1}
                onClick={() => move(1)}
              >
                <ArrowRight size={14} />
              </button>
              <button
                aria-label="当前滤镜开关"
                title={active.enabled ? "暂时关闭此层" : "启用此层"}
                aria-pressed={active.enabled}
                disabled={disabled}
                onClick={() =>
                  save(
                    layers.map((layer, i) =>
                      i === index
                        ? { ...layer, enabled: !layer.enabled }
                        : layer,
                    ),
                  )
                }
              >
                {active.enabled ? <Eye size={14} /> : <EyeOff size={14} />}
              </button>
              <button
                aria-label="移除当前滤镜层"
                title="移除此层"
                disabled={disabled}
                onClick={remove}
              >
                <X size={14} />
              </button>
            </>
          )}
        </div>
        {searchOpen && (
          <input
            className="fb-search"
            aria-label="搜索滤镜名称"
            placeholder="搜索名称或分组"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
      </div>
      {tab === "favorites" && !filtered.length && (
        <div className="fb-empty">
          <Heart size={22} />
          <p>收藏喜欢的滤镜</p>
          <small>点击预设右上角的爱心，在这里快速找到它。</small>
        </div>
      )}
      {groups.map((group, groupIndex) => {
        const entries = filtered.filter(
          (preset) => tab === "favorites" || preset.group === group,
        );
        if (!entries.length) return null;
        const more = entries.length > 7 && !expanded[group];
        const visible = more ? entries.slice(0, 6) : entries;
        type Tile = FilterPreset | { key: "original" | "more"; label: string };
        const tiles: Tile[] = [
          ...(groupIndex === 0
            ? [{ key: "original" as const, label: "原图" }]
            : []),
          ...visible,
          ...(more ? [{ key: "more" as const, label: "展开更多" }] : []),
        ];
        const rows = Array.from(
          { length: Math.ceil(tiles.length / 4) },
          (_, i) => tiles.slice(i * 4, i * 4 + 4),
        );
        return (
          <section
            className="fb-group"
            key={group}
            aria-label={`滤镜分组 ${group}`}
          >
            <button
              className="fb-group-title"
              aria-expanded={!closed[group]}
              onClick={() =>
                setClosed((old) => ({ ...old, [group]: !old[group] }))
              }
            >
              <span className={`fb-group-icon tone-${groupIndex % 5}`}>
                <Film size={16} />
              </span>
              <strong>{group}</strong>
              <ChevronDown
                size={15}
                className={closed[group] ? "" : "is-open"}
              />
            </button>
            {!closed[group] && (
              <div className="fb-group-body">
                {rows.map((row, rowIndex) => (
                  <React.Fragment key={rowIndex}>
                    <div className="fb-grid">
                      {row.map((tile) => {
                        if (tile.key === "original")
                          return (
                            <button
                              className={`fb-choice fb-original ${!active ? "selected" : ""}`}
                              key="original"
                              aria-label="当前层使用原图"
                              title="只移除当前层，保留其他滤镜"
                              disabled={disabled}
                              onClick={original}
                            >
                              <span className="fb-original-art">
                                <SquareSlash size={24} />
                              </span>
                              <span>原图</span>
                            </button>
                          );
                        if (tile.key === "more")
                          return (
                            <button
                              className="fb-choice fb-more"
                              key="more"
                              aria-label={`展开更多 ${group}`}
                              onClick={() =>
                                setExpanded((old) => ({
                                  ...old,
                                  [group]: true,
                                }))
                              }
                            >
                              <span className="fb-more-art">
                                <FilterThumbnail
                                  photo={photo}
                                  id={
                                    entries[6].kind === "style"
                                      ? `style:${entries[6].id}`
                                      : entries[6].id
                                  }
                                  revision={revision}
                                />
                                <b>+{entries.length - visible.length}</b>
                              </span>
                              <span>展开更多</span>
                            </button>
                          );
                        const preset = tile as FilterPreset,
                          selected = activeKey === preset.key;
                        return (
                          <div
                            className={`fb-tile ${selected ? "selected" : ""}`}
                            key={preset.key}
                          >
                            <button
                              className="fb-choice"
                              data-preset-key={preset.key}
                              aria-label={`选择滤镜 ${preset.label}`}
                              aria-pressed={selected}
                              disabled={
                                disabled ||
                                !preset.ready ||
                                (!active && layers.length >= 16)
                              }
                              title={preset.label}
                              onClick={() => choose(preset)}
                            >
                              <FilterThumbnail
                                photo={photo}
                                id={
                                  preset.kind === "style"
                                    ? `style:${preset.id}`
                                    : preset.id
                                }
                                revision={revision}
                              />
                              <span>{preset.label}</span>
                            </button>
                            <button
                              className={`fb-favorite ${favorites.includes(preset.key) ? "saved" : ""}`}
                              aria-label={`${favorites.includes(preset.key) ? "取消收藏" : "收藏"}滤镜 ${preset.label}`}
                              aria-pressed={favorites.includes(preset.key)}
                              title={
                                favorites.includes(preset.key)
                                  ? "取消收藏"
                                  : "收藏"
                              }
                              onClick={() => toggleFavorite(preset.key)}
                            >
                              <Heart
                                size={11}
                                fill={
                                  favorites.includes(preset.key)
                                    ? "currentColor"
                                    : "none"
                                }
                              />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                    {row.some((tile) => tile.key === activeKey) && strength()}
                  </React.Fragment>
                ))}
                {expanded[group] && entries.length > 7 && (
                  <button
                    className="fb-collapse"
                    onClick={() =>
                      setExpanded((old) => ({ ...old, [group]: false }))
                    }
                  >
                    收起更多
                  </button>
                )}
              </div>
            )}
          </section>
        );
      })}
      {tab === "filters" && !groups.length && (
        <p className="fb-empty">没有匹配的滤镜</p>
      )}
    </div>
  );
}

export type EditorWorkspaceProps = {
  photo: Photo;
  photos: Photo[];
  revisions: Record<number, number>;
  busy: boolean;
  saving: boolean;
  film: Library["film"];
  filters?: Library["filters"];
  capabilities: Library["capabilities"];
  history: { undo: number; redo: number };
  onPatch: (patch: Recipe) => void;
  onOpen: (photo: Photo) => void;
  onBack: () => void;
  onReview: () => void;
  onComposite: () => void;
  layerContent?: React.ReactNode;
  onLeaveLayers?: () => Promise<void>;
  onExport: () => void;
  theme?: "light" | "dark";
  onToggleTheme?: () => void;
  onUndo: () => Promise<void>;
  onRedo: () => Promise<void>;
  onKeep: () => void;
  onSync: () => void;
  onFlush?: () => Promise<void>;
};

export function EditorWorkspace(props: EditorWorkspaceProps) {
  const {
    photo,
    photos,
    revisions,
    busy,
    saving,
    film,
    filters,
    capabilities,
    history,
    onPatch,
    onOpen,
    onBack,
    onReview,
    onComposite,
    layerContent,
    onLeaveLayers,
    onExport,
    theme = "light",
    onToggleTheme,
    onUndo,
    onRedo,
    onKeep,
    onSync,
    onFlush,
  } = props;
  const recipe = photo.recipe,
    revision = revisions[photo.id] || 0;
  const [tool, setTool] = useState<Tool>("adjust"),
    [compare, setCompare] = useState(false),
    [zoom, setZoom] = useState(1),
    [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [bounds, setBounds] = useState({ width: 800, height: 600 }),
    [image, setImage] = useState<HTMLImageElement | null>(null),
    [histVersion, setHistVersion] = useState(0);
  const [openAdjustments, setOpenAdjustments] = useState<Set<AdjustmentId>>(
    () => new Set(["tone"]),
  );
  const adjustmentScroll = useRef<HTMLDivElement>(null);
  const pendingAdjustment = useRef<AdjustmentId | null>(null);
  const [borderSize, setBorderSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [crop, setCrop] = useState<CropRect>(cropFrom(recipe)),
    [aspect, setAspect] = useState("free"),
    [curveChannel, setCurveChannel] = useState("rgb"),
    [band, setBand] = useState(0);
  const [retouchType, setRetouchType] = useState<"clone" | "heal">("heal"),
    [radius, setRadius] = useState(0.035),
    [strength, setStrength] = useState(0.8),
    [feather, setFeather] = useState(0.7);
  const [localExposure, setLocalExposure] = useState(0.5),
    [localSaturation, setLocalSaturation] = useState(1),
    [anchor, setAnchor] = useState<Point | null>(null);
  const [cursor, setCursor] = useState<Point | null>(null),
    [stamps, setStamps] = useState<Point[]>([]),
    [note, setNote] = useState("");
  const viewport = useRef<HTMLDivElement>(null),
    overlay = useRef<HTMLDivElement>(null);
  const cropDrag = useRef<{
    point: Point;
    rect: CropRect;
    handle: string;
  } | null>(null);
  const panDrag = useRef<{ x: number; y: number; origin: Point } | null>(null);
  const stroke = useRef<{
    operations: Operation[];
    points: Point[];
    first: Point;
    last: Point;
  } | null>(null);
  const cropLive = useRef(crop);
  cropLive.current = crop;
  const raw = /\.(dng|nef|arw|cr2|cr3|raf|rw2|orf|pef)$/i.test(photo.path);
  const turns = number(recipe, "quarter_turns"),
    geometricWidth = turns % 2 ? photo.height : photo.width,
    geometricHeight = turns % 2 ? photo.width : photo.height;
  const dimensions =
    tool === "composition"
      ? { width: geometricWidth, height: geometricHeight }
      : tool === "border" && borderSize
        ? borderSize
        : photoDimensions(photo);
  const fit = Math.min(
    (bounds.width - 72) / dimensions.width,
    (bounds.height - 72) / dimensions.height,
  );
  const frameWidth = Math.max(1, dimensions.width * fit),
    frameHeight = Math.max(1, dimensions.height * fit);
  const brush = tool === "local" || tool === "retouch";
  const activeIndex = photos.findIndex((p) => p.id === photo.id);
  useLayoutEffect(() => {
    const id = pendingAdjustment.current;
    const scroll = adjustmentScroll.current;
    if (tool !== "adjust" || !scroll || !id) return;
    pendingAdjustment.current = null;
    const header = scroll.querySelector<HTMLElement>(`#ew-adjust-${id}`);
    if (header) scroll.scrollTop = header.offsetTop;
  }, [tool, openAdjustments]);
  useLayoutEffect(() => {
    const element = viewport.current!;
    const measure = () =>
      setBounds({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setPan({ x: 0, y: 0 });
    setZoom(1);
    setCrop(cropFrom(photo.recipe));
    setAnchor(null);
    setImage(null);
    setBorderSize(null);
    setStamps([]);
    setNote("");
    stroke.current = null;
  }, [photo.id]);
  useEffect(() => {
    if (!cropDrag.current) setCrop(cropFrom(recipe));
  }, [photo.id, recipe.crop_x, recipe.crop_y, recipe.crop_w, recipe.crop_h]);
  const patch = (value: Recipe) => {
    if (!busy) onPatch(value);
  };
  const fitView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };
  const canvasReady = () => {
    const previews = viewport.current?.querySelectorAll<HTMLElement>(
      ".comparison-edited, .spectral-interactive-preview",
    );
    return Array.from(previews ?? []).some((preview) =>
      geometryInteractionReady(
        recipe,
        photo.committed_recipe ?? recipe,
        preview.dataset.renderedGeometry,
        preview.dataset.geometryReady === "true",
        tool === "composition",
      ),
    );
  };
  const requireReady = () => {
    if (canvasReady()) return true;
    setNote("正在加载与当前方向和裁剪一致的画面，请稍候再操作。");
    return false;
  };
  const toggleCompare = async () => {
    if (!compare) {
      try {
        await onFlush?.();
      } catch (error) {
        setNote(String(error));
        return;
      }
    }
    setCompare((v) => !v);
  };
  const applyCrop = () => {
    if (!requireReady()) return;
    patch({ crop_x: crop.x, crop_y: crop.y, crop_w: crop.w, crop_h: crop.h });
    setTool("adjust");
    setNote("裁剪已保存；原始像素始终保留。");
  };
  const chooseTool = async (id: Tool) => {
    if (layerContent) {
      try {
        await onLeaveLayers?.();
      } catch (error) {
        setNote(String(error));
        return;
      }
    }
    if (id === "composition" || id === "local" || id === "retouch") {
      try {
        await onFlush?.();
      } catch (error) {
        setNote(String(error));
        return;
      }
      if (id === "composition") {
        setCrop(cropFrom(recipe));
        setAspect("free");
        setCompare(false);
        fitView();
      }
    }
    setTool(id);
    setNote("");
    viewport.current?.focus({ preventScroll: true });
  };
  const performHistory = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    }
  };
  const range = (
    key: string,
    label: string,
    min: number,
    max: number,
    step = 0.01,
    fallback = 0,
  ) => (
    <label className="ew-range" key={key}>
      <span>
        {label}
        <NumericValue
          label={label}
          value={number(recipe, key, fallback)}
          min={
            key === "white_point"
              ? Math.max(min, number(recipe, "black_point") + 0.011)
              : min
          }
          max={
            key === "black_point"
              ? Math.min(max, number(recipe, "white_point", 1) - 0.011)
              : max
          }
          step={step}
          disabled={busy}
          onChange={(value) => patch({ [key]: value })}
        />
        <button
          type="button"
          title={`重置${label}`}
          aria-label={`重置${label}`}
          onClick={() => patch({ [key]: fallback })}
        >
          ↺
        </button>
      </span>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={number(recipe, key, fallback)}
        disabled={busy}
        onChange={(e) => {
          let value = Number(e.target.value);
          if (key === "black_point")
            value = Math.min(value, number(recipe, "white_point", 1) - 0.011);
          if (key === "white_point")
            value = Math.max(value, number(recipe, "black_point") + 0.011);
          patch({ [key]: value });
        }}
      />
    </label>
  );
  const localRange = (
    label: string,
    value: number,
    change: (v: number) => void,
    min: number,
    max: number,
    step = 0.01,
  ) => (
    <label className="ew-range">
      <span>
        {label}
        <NumericValue
          label={label}
          value={value}
          min={min}
          max={max}
          step={step}
          disabled={busy}
          onChange={change}
        />
      </span>
      <input
        aria-label={label}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={busy}
        onChange={(e) => change(Number(e.target.value))}
      />
    </label>
  );
  const reset = (values: Recipe) => (
    <button
      className="ew-section-reset"
      disabled={busy}
      onClick={() => patch(values)}
    >
      重置本组参数
    </button>
  );
  const normalized = (e: React.PointerEvent) => {
    const rect = overlay.current!.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height,
    };
  };
  const valid = (p: Point) =>
    Number.isFinite(p.x) &&
    Number.isFinite(p.y) &&
    p.x >= 0 &&
    p.x <= 1 &&
    p.y >= 0 &&
    p.y <= 1;
  const createStamp = (point: Point, first: Point): Operation | null => {
    if (!valid(point)) return null;
    if (tool === "local")
      return {
        ...point,
        radius,
        exposure: localExposure,
        saturation: localSaturation,
        feather,
      };
    const nearby =
      ((radius * Math.min(photo.width, photo.height)) / photo.width) * 2.5;
    const source = anchor
      ? { x: anchor.x + point.x - first.x, y: anchor.y + point.y - first.y }
      : {
          x: clamp(point.x + (point.x + nearby <= 1 ? nearby : -nearby)),
          y: point.y,
        };
    if (!valid(source)) return null;
    return {
      ...point,
      type: retouchType,
      sx: source.x,
      sy: source.y,
      radius,
      strength,
    };
  };
  const startPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    if (busy || e.button !== 0) return;
    if ((tool === "composition" || brush) && !requireReady()) return;
    viewport.current?.focus({ preventScroll: true });
    const p = normalized(e);
    if (tool === "composition") {
      const handle = (e.target as HTMLElement).dataset.handle || "new";
      cropDrag.current = { point: p, rect: { ...crop }, handle };
      e.currentTarget.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (!brush) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const source = geometryToSource(
      p.x,
      p.y,
      photo.width,
      photo.height,
      recipe,
    );
    if (e.altKey && tool === "retouch") {
      if (valid(source)) {
        setAnchor(source);
        setNote(
          `取样源 ${Math.round(source.x * 100)}%, ${Math.round(source.y * 100)}%`,
        );
      }
      return;
    }
    if (tool === "retouch" && retouchType === "clone" && !anchor) {
      setNote("按住 Alt 点击画面，先设置仿制取样源。");
      return;
    }
    const field = tool === "local" ? "local_adjustments" : "retouch",
      old = parse<Operation[]>(recipe[field], []);
    if (old.length >= 256) {
      setNote("已达到 256 个笔触点，请撤销或清空该工具后继续。");
      return;
    }
    const operation = createStamp(source, source);
    stroke.current = {
      operations: operation ? [operation] : [],
      points: operation ? [p] : [],
      first: source,
      last: source,
    };
    setStamps(operation ? [p] : []);
  };
  const movePointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = normalized(e);
    setCursor(p);
    if ((cropDrag.current || stroke.current) && !canvasReady()) {
      cropDrag.current = null;
      stroke.current = null;
      setStamps([]);
      setCrop(cropFrom(recipe));
      setNote("画面几何已改变，本次未保存的拖动已取消。");
      return;
    }
    if (cropDrag.current) {
      const { point, rect, handle } = cropDrag.current,
        dx = p.x - point.x,
        dy = p.y - point.y;
      let next: CropRect;
      if (handle === "move")
        next = {
          ...rect,
          x: clamp(rect.x + dx, 0, 1 - rect.w),
          y: clamp(rect.y + dy, 0, 1 - rect.h),
        };
      else {
        let x1 = rect.x,
          x2 = rect.x + rect.w,
          y1 = rect.y,
          y2 = rect.y + rect.h;
        if (handle === "new") {
          x1 = point.x;
          y1 = point.y;
          x2 = p.x;
          y2 = p.y;
        } else {
          if (handle.includes("w")) x1 = p.x;
          if (handle.includes("e")) x2 = p.x;
          if (handle.includes("n")) y1 = p.y;
          if (handle.includes("s")) y2 = p.y;
        }
        const x = clamp(Math.min(x1, x2), 0, 0.99),
          y = clamp(Math.min(y1, y2), 0, 0.99);
        next = {
          x,
          y,
          w: clamp(Math.abs(x2 - x1), 0.01, 1 - x),
          h: clamp(Math.abs(y2 - y1), 0.01, 1 - y),
        };
        const a =
          aspect === "original"
            ? geometricWidth / geometricHeight
            : Number(aspect);
        if (Number.isFinite(a) && a > 0)
          next = aspectCrop(next, a, geometricWidth, geometricHeight);
      }
      cropLive.current = next;
      setCrop(next);
      return;
    }
    const active = stroke.current;
    if (!active) return;
    const point = geometryToSource(p.x, p.y, photo.width, photo.height, recipe),
      shorter = Math.min(photo.width, photo.height);
    const distance = Math.hypot(
      ((point.x - active.last.x) * photo.width) / shorter,
      ((point.y - active.last.y) * photo.height) / shorter,
    );
    const spacing = Math.max(0.001, radius * 0.4),
      count = Math.min(
        256 - active.operations.length,
        Math.floor(distance / spacing),
      );
    if (!count) return;
    const from = active.last;
    for (let i = 1; i <= count; i++) {
      const t = (i * spacing) / distance,
        position = {
          x: from.x + (point.x - from.x) * t,
          y: from.y + (point.y - from.y) * t,
        },
        operation = createStamp(position, active.first);
      if (operation) {
        active.operations.push(operation);
        active.points.push(p);
      }
    }
    active.last = point;
    setStamps([...active.points]);
  };
  const endPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((cropDrag.current || stroke.current) && !canvasReady()) {
      cropDrag.current = null;
      stroke.current = null;
      setStamps([]);
      setCrop(cropFrom(recipe));
      setNote("画面尚未就绪，本次拖动未保存。");
      if (e.currentTarget.hasPointerCapture(e.pointerId))
        e.currentTarget.releasePointerCapture(e.pointerId);
      return;
    }
    if (cropDrag.current) {
      cropDrag.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId))
        e.currentTarget.releasePointerCapture(e.pointerId);
      return;
    }
    const active = stroke.current;
    stroke.current = null;
    if (active && active.operations.length) {
      const field = tool === "local" ? "local_adjustments" : "retouch";
      const old = parse<Operation[]>(recipe[field], []),
        next = appendOperations(old, active.operations);
      patch({ [field]: JSON.stringify(next) });
      setNote(
        `已保存 ${next.length - old.length} 个${tool === "local" ? "局部调整" : "修复"}笔触点 · 可撤销`,
      );
    }
    setStamps([]);
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const activeTool = editorTools.find((t) => t.id === tool) || editorTools[1];
  const neutralGeometry = {
    ...fullCrop,
    quarter_turns: 0,
    flip_x: 0,
    flip_y: 0,
    straighten: 0,
  };
  const hsl = parse<
      { band: number; hue: number; saturation: number; luminance: number }[]
    >(recipe.hsl, []),
    bandValue = hsl.find((v) => v.band === band) || {
      band,
      hue: 0,
      saturation: 0,
      luminance: 0,
    };
  const hslChange = (name: "hue" | "saturation" | "luminance", value: number) =>
    patch({
      hsl: JSON.stringify(
        [
          ...hsl.filter((v) => v.band !== band),
          { ...bandValue, [name]: value },
        ].sort((a, b) => a.band - b.band),
      ),
    });
  const panel = (section: Tool | AdjustmentId = tool) => {
    switch (section) {
      case "border":
        return <BorderControls photo={photo} onPatch={patch} disabled={busy} />;
      case "composition":
        return (
          <>
            <p className="ew-description">
              旋转、翻转与拉直后，在画面上拖动裁剪框。Enter 应用裁剪，Esc 退出。
            </p>
            <div className="ew-transform-buttons">
              <button
                aria-label="顺时针旋转90度"
                onClick={() => {
                  patch({ quarter_turns: (turns + 1) % 4, ...fullCrop });
                  setCrop(cropFrom(fullCrop));
                  setAspect("free");
                }}
              >
                <RotateCw size={19} />
                顺时针 90°
              </button>
              <button
                aria-label="水平翻转"
                onClick={() => patch({ flip_x: 1 - number(recipe, "flip_x") })}
              >
                <FlipHorizontal size={19} />
                水平翻转
              </button>
              <button
                aria-label="垂直翻转"
                onClick={() => patch({ flip_y: 1 - number(recipe, "flip_y") })}
              >
                <FlipVertical size={19} />
                垂直翻转
              </button>
            </div>
            {range("straighten", "水平校正", -45, 45, 0.1)}
            <p className="ew-description">
              拉直正值为逆时针；旋转 90° 会重置裁剪框。
            </p>
            <h3>裁剪画框</h3>
            <label className="ew-field">
              裁剪比例
              <select
                aria-label="裁剪比例"
                value={aspect}
                onChange={(e) => {
                  const value = e.target.value;
                  setAspect(value);
                  if (value !== "free")
                    setCrop(
                      aspectCrop(
                        crop,
                        value === "original"
                          ? geometricWidth / geometricHeight
                          : Number(value),
                        geometricWidth,
                        geometricHeight,
                      ),
                    );
                }}
              >
                <option value="free">自由比例</option>
                <option value="original">原图比例</option>
                <option value="1">1 : 1</option>
                <option value={4 / 3}>4 : 3</option>
                <option value={3 / 2}>3 : 2</option>
                <option value={16 / 9}>16 : 9</option>
              </select>
            </label>
            <div className="ew-crop-readout">
              <strong>
                {Math.max(1, Math.round(crop.w * geometricWidth))} ×{" "}
                {Math.max(1, Math.round(crop.h * geometricHeight))}
              </strong>
              <span>应用后的像素尺寸</span>
            </div>
            <div className="ew-actions">
              <button
                className="primary"
                aria-label="应用裁剪"
                onClick={applyCrop}
              >
                <Check size={15} />
                应用裁剪
              </button>
              <button
                onClick={() => {
                  setCrop(cropFrom(recipe));
                  setTool("adjust");
                }}
              >
                取消
              </button>
            </div>
            <button
              className="ew-section-reset"
              onClick={() => {
                patch(fullCrop);
                setCrop(cropFrom(fullCrop));
              }}
            >
              重置裁剪
            </button>
            <button
              className="ew-section-reset"
              disabled={busy}
              onClick={() => {
                patch(neutralGeometry);
                setCrop(cropFrom(fullCrop));
                setAspect("free");
              }}
            >
              重置构图
            </button>
          </>
        );
      case "tone":
        return (
          <>
            {range("exposure", "亮度曝光", -2, 2)}
            {range("contrast", "对比度", 0.5, 1.5, 0.01, 1)}
            {range("highlights", "高光", -1, 1)}
            {range("shadows", "阴影", -1, 1)}
            {range("whites", "白色色阶", -1, 1)}
            {range("blacks", "黑色色阶", -1, 1)}
            <div className="ew-actions">
              <button
                onClick={() =>
                  patch({ shadows: 0.22, highlights: -0.25, contrast: 1.05 })
                }
              >
                柔和动态
              </button>
              <button
                onClick={() =>
                  patch({ contrast: 1.16, blacks: -0.12, whites: 0.12 })
                }
              >
                鲜明层次
              </button>
            </div>
            {reset({
              exposure: 0,
              contrast: 1,
              highlights: 0,
              shadows: 0,
              whites: 0,
              blacks: 0,
            })}
          </>
        );
      case "levels":
        return (
          <>
            {range("black_point", "黑场", 0, 0.9)}
            {range("white_point", "白场", 0.1, 1, 0.01, 1)}
            {range("gamma", "中间调伽马", 0.2, 5, 0.01, 1)}
            {reset({
              black_point: 0,
              white_point: 1,
              gamma: 1,
            })}
          </>
        );
      case "curves":
        return (
          <>
            <div className="ew-segmented">
              {["rgb", "r", "g", "b"].map((c) => (
                <button
                  key={c}
                  aria-label={`曲线通道 ${c.toUpperCase()}`}
                  className={curveChannel === c ? "active" : ""}
                  onClick={() => setCurveChannel(c)}
                >
                  {c.toUpperCase()}
                </button>
              ))}
            </div>
            <CurveEditor
              key={photo.id + curveChannel}
              value={String(recipe["curve_" + curveChannel] || neutralCurve)}
              color={
                { rgb: "#dfd4b9", r: "#e69a8a", g: "#a7c7a2", b: "#93b9e2" }[
                  curveChannel
                ] || "#fff"
              }
              onChange={(value) => patch({ ["curve_" + curveChannel]: value })}
            />
            <div className="ew-actions">
              <button
                onClick={() =>
                  patch({
                    ["curve_" + curveChannel]:
                      "[[0,0],[0.25,0.18],[0.75,0.82],[1,1]]",
                  })
                }
              >
                柔和 S 曲线
              </button>
              <button
                onClick={() =>
                  patch({ ["curve_" + curveChannel]: neutralCurve })
                }
              >
                重置通道
              </button>
            </div>
            {reset({
              curve_rgb: neutralCurve,
              curve_r: neutralCurve,
              curve_g: neutralCurve,
              curve_b: neutralCurve,
            })}
          </>
        );
      case "color":
        return (
          <>
            {range("temperature", "冷暖", -1, 1)}
            {range("tint", "色调 · 绿 / 洋红", -1, 1)}
            {range("saturation", "饱和度", 0, 2, 0.01, 1)}
            {range("vibrance", "自然饱和度", -1, 1)}
            {reset({ temperature: 0, tint: 0, saturation: 1, vibrance: 0 })}
          </>
        );
      case "mixer":
        return (
          <>
            <div className="ew-bands">
              {["红", "橙", "黄", "绿", "青", "蓝", "紫", "洋红"].map(
                (label, i) => (
                  <button
                    key={i}
                    aria-label={`HSL ${label}`}
                    title={label}
                    className={band === i ? "active" : ""}
                    style={{
                      background: [
                        "#c45a59",
                        "#c79155",
                        "#c3b661",
                        "#7b9b65",
                        "#68a6a3",
                        "#6e89b7",
                        "#9674a9",
                        "#b0779f",
                      ][i],
                    }}
                    onClick={() => setBand(i)}
                  />
                ),
              )}
            </div>
            {localRange(
              "分色色相",
              bandValue.hue,
              (v) => hslChange("hue", v),
              -30,
              30,
              1,
            )}
            {localRange(
              "分色饱和度",
              bandValue.saturation,
              (v) => hslChange("saturation", v),
              -1,
              1,
            )}
            {localRange(
              "分色明亮度",
              bandValue.luminance,
              (v) => hslChange("luminance", v),
              -1,
              1,
            )}
            {reset({ hsl: "[]" })}
          </>
        );
      case "detail":
        return (
          <>
            {range("sharpen", "锐化强度", 0, 2)}
            {range("sharpen_radius", "锐化半径", 0.3, 5, 0.1, 1)}
            {range("denoise", "降噪", 0, 1)}
            <div className="ew-actions">
              <button
                onClick={() => {
                  setZoom(1 / Math.max(0.01, fit));
                  setPan({ x: 0, y: 0 });
                }}
              >
                查看 100% 像素
              </button>
            </div>
            {reset({ sharpen: 0, sharpen_radius: 1, denoise: 0 })}
          </>
        );
      case "effects":
        return (
          <>
            {range("clarity", "清晰度", -1, 1)}
            {range("dehaze", "去雾", -1, 1)}
            {range("vignette", "暗角", -1, 1)}
            {reset({ clarity: 0, dehaze: 0, vignette: 0 })}
          </>
        );
      case "retouch":
      case "local":
        return (
          <>
            {tool === "retouch" && (
              <>
                <div className="ew-segmented">
                  <button
                    className={retouchType === "heal" ? "active" : ""}
                    onClick={() => setRetouchType("heal")}
                  >
                    修复
                  </button>
                  <button
                    className={retouchType === "clone" ? "active" : ""}
                    onClick={() => setRetouchType("clone")}
                  >
                    仿制
                  </button>
                </div>
                <p className="ew-description">
                  Alt 点击设置取样源，拖动涂抹。修复使用取样纹理与局部色调匹配。
                </p>
              </>
            )}
            {localRange("笔刷半径", radius, setRadius, 0.005, 0.2, 0.005)}
            {tool === "retouch" ? (
              localRange("笔刷强度", strength, setStrength, 0, 1)
            ) : (
              <>
                {localRange("局部曝光", localExposure, setLocalExposure, -2, 2)}
                {localRange(
                  "局部饱和度",
                  localSaturation,
                  setLocalSaturation,
                  0,
                  2,
                )}
                {localRange("笔刷羽化", feather, setFeather, 0, 1)}
              </>
            )}
            <div className="ew-brush-status">
              <CircleDot size={15} />
              <span>
                {
                  parse<Operation[]>(
                    recipe[tool === "local" ? "local_adjustments" : "retouch"],
                    [],
                  ).length
                }{" "}
                / 256 个源坐标笔触点
              </span>
            </div>
            <p className="ew-description">
              一次拖动只保存一个撤销步骤。旋转、裁剪后仍映射回源像素。
            </p>
            <button
              className="ew-section-reset"
              onClick={() =>
                patch({
                  [tool === "local" ? "local_adjustments" : "retouch"]: "[]",
                })
              }
            >
              清空{tool === "local" ? "局部调整" : "修复笔触"}
            </button>
          </>
        );
      case "filters":
        return (
          <FilterControls
            key={photo.id}
            photo={photo}
            revision={revision}
            catalog={filters}
            update={patch}
            disabled={busy}
          />
        );
      case "film":
        return (
          <FilmControls
            photo={photo}
            catalog={film}
            update={patch}
            disabled={busy}
          />
        );
      case "raw":
        return raw ? (
          <>
            <div className="ew-engine-label">
              <i />
              {capabilities.raw_backend || "RAW 引擎未连接"}
            </div>
            <label className="ew-field">
              白平衡
              <select
                aria-label="RAW 白平衡"
                disabled={!capabilities.raw || busy}
                value={String(recipe.raw_wb || "camera")}
                onChange={(e) => patch({ raw_wb: e.target.value })}
              >
                <option value="camera">相机白平衡</option>
                <option value="auto">自动白平衡</option>
                <option value="custom">自定义色温</option>
              </select>
            </label>
            {range("raw_exposure", "RAW 曝光", -5, 5, 0.1)}
            {recipe.raw_wb === "custom" && (
              <>
                {range("raw_temperature", "RAW 色温", 2000, 25000, 100, 6500)}
                {range("raw_tint", "RAW 绿色倍率", 0.2, 5, 0.05, 1)}
              </>
            )}
            {range("raw_highlights", "RAW 高光压缩", 0, 100, 1)}
            {range("raw_denoise", "RAW 降噪", 0, 100, 1)}
            {range("raw_sharpen", "RAW 锐化", 0, 300, 1)}
            <p className="ew-description">
              显影以原生 16-bit TIFF 进入浮点流水线；屏幕只在最终显示时量化。
            </p>
          </>
        ) : (
          <div className="ew-empty">
            <Aperture size={32} />
            <h3>当前为已显影图片</h3>
            <p>
              选择相机 RAW
              后，可以调整传感器显影参数。当前照片的全部精度仍保留在通用调色与导出流水线中。
            </p>
          </div>
        );
    }
  };
  return (
    <section
      className={`editor-workspace ${layerContent ? "editing-layers" : ""}`}
      aria-label="高精度照片编辑器"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (layerContent) return;
        if (
          (e.target as HTMLElement).closest(
            'input:not([type="range"]),select,textarea,[contenteditable="true"]',
          )
        )
          return;
        const history = historyShortcut(
          e.key,
          e.ctrlKey || e.metaKey,
          e.shiftKey,
        );
        if (history) {
          e.preventDefault();
          e.stopPropagation();
          if (!busy) void performHistory(history === "undo" ? onUndo : onRedo);
          return;
        }
        if ((e.target as HTMLElement).closest("input,button")) return;
        if (e.ctrlKey || e.metaKey) return;
        const key = e.key.toLowerCase();
        const shortcutTool = editorToolShortcut(key);
        if (
          !shortcutTool &&
          !["f", "+", "=", "-", "enter", "escape"].includes(key)
        )
          return;
        e.preventDefault();
        e.stopPropagation();
        if (shortcutTool) {
          if (shortcutTool === "adjust") {
            const id = key === "u" ? "curves" : key === "s" ? "color" : "tone";
            pendingAdjustment.current = id;
            setOpenAdjustments(
              (open) =>
                new Set(key === "s" ? [...open, id, "mixer"] : [...open, id]),
            );
          }
          void chooseTool(shortcutTool);
        } else if (key === "f") fitView();
        else if (key === "+" || key === "=")
          setZoom((z) => clamp(z * 1.25, 0.1, 20));
        else if (key === "-") setZoom((z) => clamp(z / 1.25, 0.1, 20));
        else if (key === "enter" && tool === "composition") applyCrop();
        else if (key === "escape") {
          stroke.current = null;
          cropDrag.current = null;
          setStamps([]);
          setCrop(cropFrom(recipe));
          setTool("adjust");
        }
      }}
    >
      <header className="ew-document-bar">
        <button className="ew-back" onClick={onBack}>
          <ArrowLeft size={17} />
          照片库
        </button>
        <span className="ew-document-divider" />
        <div className="ew-document-title">
          <strong>{photo.name}</strong>
          <small>
            {photo.width.toLocaleString()} × {photo.height.toLocaleString()} ·{" "}
            {raw ? "RAW" : "RGB"} · 浮点非破坏编辑
          </small>
        </div>
        <span className={`ew-save-state ${saving ? "saving" : ""}`}>
          {saving ? "正在保存配方…" : busy ? "正在本机处理…" : "调整已自动保存"}
        </span>
        {onToggleTheme && (
          <button
            className="ew-theme-toggle"
            aria-label={theme === "dark" ? "切换浅色模式" : "切换深色模式"}
            title={theme === "dark" ? "切换浅色模式" : "切换深色模式"}
            onClick={onToggleTheme}
          >
            {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        )}
        <div className="ew-history">
          <button
            aria-label="撤销上次修改"
            title="撤销 Ctrl+Z"
            disabled={busy || !history.undo}
            onClick={() => void performHistory(onUndo)}
          >
            <Undo2 size={17} />
          </button>
          <button
            aria-label="重做上次修改"
            title="重做 Ctrl+Shift+Z"
            disabled={busy || !history.redo}
            onClick={() => void performHistory(onRedo)}
          >
            <Redo2 size={17} />
          </button>
        </div>
        <button
          className={photo.decision === "keep" ? "ew-kept" : ""}
          title="保留照片"
          aria-label="保留照片"
          onClick={onKeep}
        >
          <Heart
            size={17}
            fill={photo.decision === "keep" ? "currentColor" : "none"}
          />
        </button>
        <button className="ew-export" disabled={busy} onClick={onExport}>
          <Download size={16} />
          导出作品
        </button>
      </header>
      <div className="ew-options">
        <span>
          <activeTool.icon size={16} />
          <strong>{layerContent ? "图层合成" : activeTool.label}</strong>
        </span>
        {tool === "composition" ? (
          <>
            <small>拖动边角调整 · Enter 应用</small>
            <button aria-label="应用裁剪工具" onClick={applyCrop}>
              <Check size={14} />
              应用
            </button>
            <button
              onClick={() => {
                setTool("adjust");
                setCrop(cropFrom(recipe));
              }}
            >
              <X size={14} />
              取消
            </button>
          </>
        ) : (
          <small>
            {brush
              ? "源像素笔刷 · 抬起鼠标时保存"
              : "拖动画布平移 · 滚轮缩放 · F 适合画布"}
          </small>
        )}
        <div className="ew-options-spacer" />
        <button
          className={compare ? "active" : ""}
          aria-pressed={compare}
          onClick={() => void toggleCompare()}
        >
          对比原图
        </button>
        <button onClick={onReview}>阅片台</button>
        <button onClick={onComposite}>
          <Layers size={14} />
          图层合成
        </button>
      </div>
      <div className="ew-body">
        <nav className="ew-toolrail" aria-label="编辑工具">
          {editorTools.map(({ id, label, shortcut, icon: Icon }) => (
            <button
              key={id}
              aria-label={label}
              title={label + (shortcut ? ` · ${shortcut}` : "")}
              className={!layerContent && tool === id ? "active" : ""}
              aria-pressed={!layerContent && tool === id}
              onClick={() => chooseTool(id)}
            >
              <Icon size={20} />
              <span>
                {id === "raw" ? "RAW" : label.split("与")[0].slice(0, 2)}
              </span>
            </button>
          ))}
          <button
            aria-label="打开图层合成"
            title="图层合成"
            className={layerContent ? "active" : ""}
            aria-pressed={!!layerContent}
            onClick={onComposite}
          >
            <Layers size={20} />
            <span>图层</span>
          </button>
        </nav>
        {layerContent && <div className="ew-layer-content">{layerContent}</div>}
        <main className="ew-canvas-column">
          <div
            className={`ew-canvas ${tool !== "composition" && !brush ? "is-hand" : ""}`}
            ref={viewport}
            tabIndex={0}
            aria-label="编辑画布"
            onWheel={(e) => {
              if ((e.target as HTMLElement).closest("input")) return;
              setZoom((z) => clamp(z * (e.deltaY > 0 ? 0.9 : 1.1), 0.1, 20));
            }}
            onPointerDown={(e) => {
              if (tool === "composition" || brush || e.button !== 0) return;
              if (
                (e.target as HTMLElement).closest(
                  'button,input,select,textarea,[contenteditable="true"],[role="slider"],svg,.ew-interaction,.compare-slider',
                )
              )
                return;
              e.preventDefault();
              viewport.current?.focus({ preventScroll: true });
              panDrag.current = { x: e.clientX, y: e.clientY, origin: pan };
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (panDrag.current)
                setPan({
                  x: panDrag.current.origin.x + e.clientX - panDrag.current.x,
                  y: panDrag.current.origin.y + e.clientY - panDrag.current.y,
                });
            }}
            onPointerUp={(e) => {
              panDrag.current = null;
              if (e.currentTarget.hasPointerCapture(e.pointerId))
                e.currentTarget.releasePointerCapture(e.pointerId);
            }}
            onPointerCancel={() => {
              panDrag.current = null;
            }}
          >
            <div
              className="ew-image-frame"
              style={{
                width: frameWidth,
                height: frameHeight,
                transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})`,
              }}
            >
              {tool === "border" ? (
                <BorderPreview photo={photo} onSize={setBorderSize} />
              ) : (
                <Comparison
                  photo={photo}
                  revision={revision}
                  active={compare && tool !== "composition"}
                  viewScale={zoom}
                  uncropped={tool === "composition"}
                  onLoaded={(img) => {
                    setImage(img);
                    setHistVersion((v) => v + 1);
                  }}
                />
              )}
              {(tool === "composition" || brush) && (
                <div
                  className={`ew-interaction ${tool === "composition" ? "crop-mode" : "brush-mode"}`}
                  ref={overlay}
                  aria-label={
                    tool === "composition" ? "裁剪画框" : "源坐标笔刷画布"
                  }
                  onPointerDown={startPointer}
                  onPointerMove={movePointer}
                  onPointerUp={endPointer}
                  onPointerCancel={() => {
                    cropDrag.current = null;
                    stroke.current = null;
                    setStamps([]);
                  }}
                  onPointerLeave={() => setCursor(null)}
                >
                  {tool === "composition" ? (
                    <div
                      className="ew-crop-rect"
                      data-handle="move"
                      style={{
                        left: `${crop.x * 100}%`,
                        top: `${crop.y * 100}%`,
                        width: `${crop.w * 100}%`,
                        height: `${crop.h * 100}%`,
                      }}
                    >
                      <i className="ew-third vertical first" />
                      <i className="ew-third vertical second" />
                      <i className="ew-third horizontal first" />
                      <i className="ew-third horizontal second" />
                      {["nw", "ne", "sw", "se"].map((h) => (
                        <b
                          key={h}
                          data-handle={h}
                          className={`ew-crop-handle ${h}`}
                        />
                      ))}
                      <span>
                        {Math.round(crop.w * geometricWidth)} ×{" "}
                        {Math.round(crop.h * geometricHeight)}
                      </span>
                    </div>
                  ) : (
                    <svg
                      className="ew-brush-overlay"
                      width="100%"
                      height="100%"
                    >
                      <g
                        stroke="white"
                        strokeWidth={1 / zoom}
                        fill="rgba(207,190,151,.2)"
                      >
                        {stamps.map((p, i) => (
                          <circle
                            key={i}
                            cx={p.x * frameWidth}
                            cy={p.y * frameHeight}
                            r={
                              (radius *
                                Math.min(photo.width, photo.height) *
                                frameWidth) /
                              dimensions.width
                            }
                          />
                        ))}
                      </g>
                      {cursor && (
                        <circle
                          cx={cursor.x * frameWidth}
                          cy={cursor.y * frameHeight}
                          r={
                            (radius *
                              Math.min(photo.width, photo.height) *
                              frameWidth) /
                            dimensions.width
                          }
                          fill="none"
                          stroke="white"
                          strokeWidth={1 / zoom}
                        />
                      )}
                    </svg>
                  )}
                </div>
              )}
            </div>
            {note && (
              <div className="ew-canvas-note" role="status">
                {note}
              </div>
            )}
            <div className="ew-zoom-controls">
              <button
                title="缩小"
                onClick={() => setZoom((z) => clamp(z / 1.25, 0.1, 20))}
              >
                <Minus size={15} />
              </button>
              <button className="ew-zoom-number" onClick={fitView}>
                {Math.round(zoom * fit * 100)}%
              </button>
              <button
                title="放大"
                onClick={() => setZoom((z) => clamp(z * 1.25, 0.1, 20))}
              >
                <Plus size={15} />
              </button>
              <span />
              <button title="适合画布" onClick={fitView}>
                <Maximize2 size={15} />
              </button>
              <button
                title="100% 原始像素"
                onClick={() => {
                  setZoom(1 / Math.max(0.01, fit));
                  setPan({ x: 0, y: 0 });
                }}
              >
                1:1
              </button>
            </div>
          </div>
          <div className="ew-filmstrip">
            <button
              aria-label="上一张照片"
              disabled={activeIndex <= 0}
              onClick={() => onOpen(photos[activeIndex - 1])}
            >
              <ArrowLeft size={16} />
            </button>
            <div className="ew-filmstrip-items">
              {photos
                .slice(
                  Math.max(0, activeIndex - 5),
                  Math.max(12, activeIndex + 6),
                )
                .map((p) => (
                  <button
                    key={p.id}
                    className={p.id === photo.id ? "active" : ""}
                    aria-label={`编辑 ${p.name}`}
                    title={p.name}
                    onClick={() => onOpen(p)}
                  >
                    <Picture photo={p} revision={revisions[p.id]} size={220} />
                    <span>{p.name}</span>
                    {p.decision === "keep" && (
                      <Heart size={10} fill="currentColor" />
                    )}
                  </button>
                ))}
            </div>
            <button
              aria-label="下一张照片"
              disabled={activeIndex < 0 || activeIndex >= photos.length - 1}
              onClick={() => onOpen(photos[activeIndex + 1])}
            >
              <ArrowRight size={16} />
            </button>
          </div>
        </main>
        <aside
          className={`ew-inspector${tool === "adjust" ? " ew-adjust-inspector" : ""}`}
          aria-label="编辑参数"
        >
          {tool === "adjust" ? (
            <>
              <div className="ew-adjust-dock">
                <Histogram image={image} version={histVersion} />
                <h2>
                  <SlidersHorizontal size={15} aria-hidden="true" />
                  调节
                </h2>
              </div>
              <div
                className="ew-inspector-scroll ew-adjust-stack"
                ref={adjustmentScroll}
              >
                {adjustmentPanels.map(({ id, label, hint, icon: Icon }) => {
                  const expanded = openAdjustments.has(id);
                  return (
                    <section className="ew-adjust-group" key={id}>
                      <h3>
                        <button
                          type="button"
                          id={`ew-adjust-${id}`}
                          aria-expanded={expanded}
                          aria-controls={`ew-adjust-${id}-controls`}
                          onClick={() =>
                            setOpenAdjustments((open) => {
                              const next = new Set(open);
                              if (expanded) next.delete(id);
                              else next.add(id);
                              return next;
                            })
                          }
                        >
                          <Icon size={15} aria-hidden="true" />
                          <span>{label}</span>
                          <small aria-hidden="true">{hint}</small>
                          <ChevronDown size={13} aria-hidden="true" />
                        </button>
                      </h3>
                      <div
                        className="ew-adjust-group-body"
                        id={`ew-adjust-${id}-controls`}
                        hidden={!expanded}
                      >
                        {expanded && panel(id)}
                      </div>
                    </section>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="ew-inspector-scroll" key={tool}>
              {tool !== "filters" && tool !== "border" && (
                <Histogram image={image} version={histVersion} />
              )}
              {tool !== "filters" && (
                <div className="ew-inspector-heading">
                  <div>
                    <small>DEVELOP</small>
                    <h2>{activeTool.label}</h2>
                  </div>
                  <activeTool.icon size={20} />
                </div>
              )}
              <div className="ew-panel-controls">{panel()}</div>
            </div>
          )}
          <footer className="ew-inspector-footer">
            <button disabled={busy} onClick={onSync}>
              <CheckCheck size={15} />
              同步到本组
            </button>
            <span>32-bit 浮点 · 16-bit 无损导出</span>
          </footer>
        </aside>
      </div>
      <footer className="ew-statusbar">
        <span>
          <i />
          原图只读 · 本机处理
        </span>
        <span>
          {dimensions.width.toLocaleString()} ×{" "}
          {dimensions.height.toLocaleString()} 像素
        </span>
        <span>
          {activeIndex + 1} / {photos.length} 张
        </span>
        <span>
          {busy ? "处理中" : saving ? "保存中" : "配方已保存"}
          <Check size={11} />
        </span>
      </footer>
    </section>
  );
}
