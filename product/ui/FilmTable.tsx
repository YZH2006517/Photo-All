// SPDX-License-Identifier: GPL-3.0-or-later
// Virtual transparency table. Lighting and the loupe affect display only.
import React, {
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Archive,
  Grid2X2,
  Hand,
  Minus,
  Pause,
  Play,
  Plus,
  Search,
  Sun,
  X,
} from "lucide-react";
import {
  Photo,
  FilmTableFrame,
  FilmTableView,
  filmTableLayout,
  filmRollLayout,
  filmTableZoom,
  filmLoupeTransform,
  filmRefractionMap,
  photoDimensions,
  resizeFilmFrame,
  filmDockTransform,
  filmRollPlayback,
} from "./model";
import { Picture, sourceSize } from "./Preview";

type Point = { x: number; y: number };
export const FILM_DRAG_TYPE = "application/x-photoall-film";
type Saved = {
  layout?: number;
  auto?: boolean;
  frames: Record<number, Point>;
  view: FilmTableView;
  brightness: number;
  scales?: Record<number, number>;
  placed?: number[];
};
const finite = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n);
function loadDesk(key: string): Saved | null {
  try {
    const all = JSON.parse(
        localStorage.getItem("photoall-film-desks-v1") || "{}",
      ),
      saved = all[key];
    if (
      !saved ||
      !finite(saved.view?.x) ||
      !finite(saved.view?.y) ||
      !finite(saved.view?.scale) ||
      saved.view.scale < 0.15 ||
      saved.view.scale > 3
    )
      return null;
    return {
      ...saved,
      placed: Array.isArray(saved.placed)
        ? saved.placed.filter(
            (id: unknown) => Number.isSafeInteger(id) && Number(id) > 0,
          )
        : undefined,
      frames: Object.fromEntries(
        Object.entries(saved.frames || {}).filter(
          ([, p]: [string, any]) => finite(p.x) && finite(p.y),
        ),
      ),
      brightness: finite(saved.brightness)
        ? Math.max(40, Math.min(160, saved.brightness))
        : 100,
      scales: Object.fromEntries(
        Object.entries(saved.scales || {}).filter(
          ([, value]) => finite(value) && value >= 0.3 && value <= 4,
        ),
      ),
    };
  } catch {
    return null;
  }
}
function saveDesk(key: string, saved: Saved) {
  try {
    const all = JSON.parse(
      localStorage.getItem("photoall-film-desks-v1") || "{}",
    );
    delete all[key];
    all[key] = saved;
    localStorage.setItem(
      "photoall-film-desks-v1",
      JSON.stringify(Object.fromEntries(Object.entries(all).slice(-8))),
    );
  } catch {
    /* A full or unavailable display cache must not prevent photo editing. */
  }
}

export function FilmTable({
  photos,
  currentId,
  revisions,
  filmNames,
  decision,
  onSelect,
  onOpen,
  active,
  light,
  onLight,
  roll = false,
  decorated = true,
  intro = true,
  onIntroComplete,
  onMotionChange,
  reveal = 0,
  incomingId = null,
  onDeskChange,
}: {
  photos: Photo[];
  currentId: number;
  revisions: Record<number, number>;
  filmNames: Record<string, string>;
  decision: (photo: Photo) => string;
  onSelect: (id: number) => void;
  onOpen: (photo: Photo) => void;
  active: boolean;
  light: boolean;
  onLight: () => void;
  roll?: boolean;
  decorated?: boolean;
  intro?: boolean;
  onIntroComplete?: () => void;
  onMotionChange?: (busy: boolean) => void;
  reveal?: number;
  incomingId?: number | null;
  onDeskChange?: (ids: number[]) => void;
}) {
  const key = useMemo(
    () =>
      String(photos.reduce((hash, p) => (hash * 31 + p.id) | 0, 17)) +
      ":" +
      photos.length +
      (roll ? ":roll" : ":desk"),
    [photos.map((p) => p.id).join(",")],
  );
  const initial = useMemo(() => loadDesk(key), [key]);
  const [positions, setPositions] = useState<Record<number, Point>>(
      initial?.frames || {},
    ),
    [view, setView] = useState<FilmTableView>(
      initial?.view || { x: 0, y: 0, scale: 1 },
    );
  const [brightness, setBrightness] = useState(initial?.brightness || 100),
    [loupe, setLoupe] = useState(false),
    [magnification, setMagnification] = useState(3),
    [center, setCenter] = useState<Point>({ x: 400, y: 300 });
  const [scales, setScales] = useState<Record<number, number>>(
    initial?.scales || {},
  );
  const [lensSize, setLensSize] = useState(150);
  const [placed, setPlaced] = useState<number[] | null>(
    initial?.placed ?? null,
  );
  const [returning, setReturning] = useState<number[]>([]);
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [zoneHover, setZoneHover] = useState(false);
  const returnFlights = useRef(new Map<number, Animation>());
  const deskChange = useRef(onDeskChange);
  deskChange.current = onDeskChange;
  const [motion, setMotion] = useState<
    "waiting" | "entering" | "stowing" | "stowed" | "idle"
  >(
    !roll && initial?.placed?.length === 0
      ? "stowed"
      : !roll && intro
        ? "waiting"
        : "idle",
  );
  const [playing, setPlaying] = useState(false);
  const world = useRef<HTMLDivElement>(null);
  const flights = useRef<Animation[]>([]),
    playback = useRef<Animation | null>(null);
  const entered = useRef(false),
    motionCallbacks = useRef({ onIntroComplete, onMotionChange });
  const lastSelection = useRef({ currentId, reveal, active });
  motionCallbacks.current = { onIntroComplete, onMotionChange };
  const reducedMotion = () =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [size, setSize] = useState({ width: 1440, height: 940 }),
    [hand, setHand] = useState(false),
    [limit, setLimit] = useState(96),
    [moving, setMoving] = useState(false);
  const viewport = useRef<HTMLDivElement>(null),
    fitted = useRef(!!initial && initial.layout === 3),
    raf = useRef(0),
    pendingMove = useRef<(() => void) | null>(null);
  const drag = useRef<{
    id?: number;
    pointer: number;
    start: Point;
    origin: Point;
    scale: number;
    resize?: {
      id: number;
      factor: number;
      width: number;
      height: number;
      sx: number;
      sy: number;
    };
  } | null>(null);
  const desk = useRef({ positions, view, brightness, scales, placed });
  desk.current = { positions, view, brightness, scales, placed };
  // Snapshot the composited position before cancel, so pausing never jumps.
  const pausePlayback = (paused = true) => {
    const animation = playback.current;
    if (animation && world.current) {
      const matrix = new DOMMatrixReadOnly(
        getComputedStyle(world.current).transform,
      );
      const next = { ...desk.current.view, x: matrix.m41, y: matrix.m42 };
      desk.current.view = next;
      world.current.style.transform = `translate(${next.x}px,${next.y}px) scale(${next.scale})`;
      animation.cancel();
      playback.current = null;
      setView(next);
    }
    if (paused) setPlaying(false);
  };
  const cancelFlight = () => {
    flights.current.forEach((animation) => animation.cancel());
    flights.current = [];
  };
  const cancelReturns = () => {
    returnFlights.current.forEach((animation) => animation.cancel());
    returnFlights.current.clear();
    setReturning([]);
  };
  const stopMotion = () => {
    pausePlayback();
    cancelFlight();
    if (motion !== "idle" && motion !== "stowed") setMotion("idle");
  };
  const autoLayout = useRef(
    initial?.auto ?? !Object.keys(initial?.frames || {}).length,
  );
  const placedSet = useMemo(
    () => (placed === null ? null : new Set(placed)),
    [placed],
  );
  const shown = photos.filter(
    (photo, index) =>
      index < limit ||
      placedSet?.has(photo.id) ||
      positions[photo.id] !== undefined,
  );
  const table = viewport.current,
    root = table?.closest(".lighttable");
  const header = root?.querySelector<HTMLElement>(".lt-header");
  const footer = root?.querySelector<HTMLElement>(".lt-footer");
  const toolbar = table?.querySelector<HTMLElement>(".ft-toolbar");
  let origin = 0;
  for (
    let parent: HTMLElement | null = table;
    parent && parent !== root;
    parent = parent.offsetParent as HTMLElement | null
  )
    origin -= parent.offsetTop;
  const top = Math.max(
    24,
    header ? origin + header.offsetTop + header.offsetHeight + 18 : 110,
    toolbar ? toolbar.offsetTop + toolbar.offsetHeight + 18 : 160,
  );
  const bottom = Math.min(
    size.height - 24,
    footer ? origin + footer.offsetTop - 20 : size.height - 190,
  );
  const area = {
    x: 48,
    y: top,
    width: Math.max(240, size.width - 96),
    height: Math.max(120, bottom - top),
  };
  const aspectKey = shown
    .map((p) => {
      const d = photoDimensions(p);
      return `${p.id}:${d.width}:${d.height}`;
    })
    .join(",");
  const base = useMemo(
    () =>
      roll
        ? filmRollLayout(
            shown.map((p) => ({ ...p, ...photoDimensions(p) })),
            decorated,
          )
        : filmTableLayout(
            shown.map((p) => ({ ...p, ...photoDimensions(p) })),
            area,
            decorated,
          ),
    [aspectKey, area.width, area.height, decorated, roll],
  );
  const rollHeight = decorated ? 260 : 200;
  const frames = base.map((frame) =>
    roll
      ? frame
      : resizeFilmFrame(
          { ...frame, ...positions[frame.id] },
          scales[frame.id] || 1,
          decorated,
        ),
  );
  const visibleFrames = frames.filter(
    (frame) => roll || placedSet === null || placedSet.has(frame.id),
  );
  const zoneWidth = Math.min(720, Math.max(280, size.width * 0.55));
  const zoneHeight = 44;
  const zoneLeft = (size.width - zoneWidth) / 2;
  const zoneBottom = Math.min(
    size.height - 4,
    footer ? origin + footer.offsetTop + 2 : size.height - 170,
  );
  const overStowZone = (x: number, y: number) => {
    const rect = viewport.current?.getBoundingClientRect();
    if (!rect) return false;
    const u = (x - rect.left - size.width / 2) / (zoneWidth / 2),
      v = (zoneBottom - (y - rect.top)) / zoneHeight;
    return Math.abs(u) <= 1 && v >= 0 && v <= 1 && u * u + v * v <= 1;
  };
  const dockBounds = () => {
    const table = viewport.current!,
      root = table.closest(".lighttable")!;
    const footer = root.querySelector<HTMLElement>(".lt-footer");
    const strip = root.querySelector<HTMLElement>(".lt-strip");
    const origin = root.getBoundingClientRect();
    return {
      x:
        origin.left +
        (footer ? footer.offsetLeft + footer.offsetWidth / 2 : size.width / 2) -
        28,
      y:
        origin.top +
        (footer && strip
          ? footer.offsetTop + strip.offsetTop + strip.offsetHeight / 2
          : size.height - 72) -
        20,
      width: 56,
      height: 40,
    };
  };
  const stowOne = (id: number) => {
    if (returning.includes(id)) return;
    autoLayout.current = false;
    setLoupe(false);
    setPlaced((old) =>
      (old ?? visibleFrames.map((frame) => frame.id)).filter(
        (value) => value !== id,
      ),
    );
    setReturning((old) => [...old, id]);
  };
  const placeOne = (id: number, client: Point) => {
    const photo = photos.find((photo) => photo.id === id);
    if (!photo || roll) return;
    stopMotion();
    returnFlights.current.get(id)?.cancel();
    returnFlights.current.delete(id);
    setReturning((old) => old.filter((value) => value !== id));
    autoLayout.current = false;
    setLoupe(false);
    setMotion("idle");
    const currentView =
      visibleFrames.length || returning.length
        ? desk.current.view
        : { x: 0, y: 0, scale: 1 };
    if (!visibleFrames.length) setView(currentView);
    const original =
      base.find((frame) => frame.id === id) ||
      filmTableLayout(
        [{ ...photo, ...photoDimensions(photo) }],
        1,
        decorated,
      )[0];
    const factor = visibleFrames.some((frame) => frame.id === id)
      ? scales[id] || 1
      : Math.max(
          0.3,
          Math.min(
            4,
            Math.min(
              240 / original.width,
              (area.height * 0.8) / original.height,
            ) / currentView.scale,
          ),
        );
    const resized = resizeFilmFrame(
      { ...original, x: 0, y: 0 },
      factor,
      decorated,
    );
    const bounds = viewport.current!.getBoundingClientRect();
    const x = Math.max(
      area.x,
      Math.min(
        area.x + area.width - resized.width * currentView.scale,
        client.x - bounds.left - (resized.width * currentView.scale) / 2,
      ),
    );
    const y = Math.max(
      area.y,
      Math.min(
        area.y + area.height - resized.height * currentView.scale,
        client.y - bounds.top - (resized.height * currentView.scale) / 2,
      ),
    );
    setPositions((old) => {
      const next = { ...old };
      // Pin existing photos before materialising a previously unseen source.
      for (const frame of visibleFrames)
        if (!next[frame.id]) {
          const source = base.find((candidate) => candidate.id === frame.id)!;
          next[frame.id] = { x: source.x, y: source.y };
        }
      next[id] = {
        x: (x - currentView.x) / currentView.scale - resized.x,
        y: (y - currentView.y) / currentView.scale - resized.y,
      };
      return next;
    });
    setScales((old) => ({ ...old, [id]: factor }));
    setPlaced((old) => [
      ...new Set([...(old ?? visibleFrames.map((frame) => frame.id)), id]),
    ]);
    onSelect(id);
  };
  const panRoll = (x: number, scale = view.scale) => {
    const left = base[0]?.x || 40,
      right = base.length
        ? base[base.length - 1].x + base[base.length - 1].width
        : left;
    return (right - left) * scale < size.width - 100
      ? (size.width - (right + left) * scale) / 2
      : Math.max(
          size.width - 50 - right * scale,
          Math.min(50 - left * scale, x),
        );
  };
  const constrainView = (next: FilmTableView): FilmTableView =>
    roll
      ? {
          ...next,
          x: panRoll(next.x, next.scale),
          y: size.height / 2 - 30 - (40 + rollHeight / 2) * next.scale,
        }
      : next;
  const available = new Map(photos.map((p) => [p.id, p]));
  useEffect(() => {
    if (roll) setView((old) => constrainView(old));
  }, [decorated]);
  const remember = () =>
    saveDesk(key, {
      layout: 3,
      auto: autoLayout.current,
      frames: desk.current.positions,
      view: desk.current.view,
      brightness: desk.current.brightness,
      scales: desk.current.scales,
      placed: desk.current.placed ?? undefined,
    });
  const fit = (arranged: FilmTableFrame[] = visibleFrames) => {
    if (!arranged.length) return;
    if (roll) {
      const scale = Math.max(
        0.2,
        Math.min(
          2.4,
          (size.height - 320) / rollHeight,
          (size.width - 100) / (arranged[0].width * 2.1),
        ),
      );
      setView({
        scale,
        x: panRoll(50 - arranged[0].x * scale, scale),
        y:
          130 +
          (size.height - 320 - rollHeight * scale) / 2 -
          arranged[0].y * scale,
      });
      return;
    }
    const minX = Math.min(...arranged.map((f) => f.x)),
      minY = Math.min(...arranged.map((f) => f.y)),
      maxX = Math.max(...arranged.map((f) => f.x + f.width)),
      maxY = Math.max(...arranged.map((f) => f.y + f.height));
    const scale = Math.min(
      3,
      area.width / (maxX - minX),
      area.height / (maxY - minY),
    );
    setView({
      scale,
      x: area.x + (area.width - (maxX - minX) * scale) / 2 - minX * scale,
      y: area.y + (area.height - (maxY - minY) * scale) / 2 - minY * scale,
    });
  };
  const spread = () => {
    pausePlayback();
    cancelFlight();
    cancelReturns();
    setPlaced(null);
    setLoupe(false);
    autoLayout.current = true;
    setPositions({});
    setScales({});
    fit(base);
    setMotion(roll ? "idle" : "entering");
  };
  // Opening waits for visible source pixels, with a bounded fallback for slow disks.
  useEffect(() => {
    if (!active || roll || motion !== "waiting" || entered.current) return;
    const start = performance.now();
    const ready = () => {
      if (!fitted.current) return;
      // Let the existing modal entrance finish before launching individual frames.
      if (!reducedMotion() && performance.now() - start < 260) return;
      const nodes = [
        ...(world.current?.querySelectorAll<HTMLElement>(
          '.lt-contact-frame:not([data-shelved="true"])',
        ) || []),
      ];
      const visible = nodes.filter((node) => {
        const r = node.getBoundingClientRect();
        return (
          r.right > 0 &&
          r.left < size.width &&
          r.bottom > 0 &&
          r.top < size.height
        );
      });
      if (
        performance.now() - start < 4000 &&
        (!visible.length ||
          visible.some((n) => n.querySelector(".picture.loading")))
      )
        return;
      entered.current = true;
      motionCallbacks.current.onIntroComplete?.();
      setMotion("entering");
    };
    const timer = setInterval(ready, 80);
    ready();
    return () => clearInterval(timer);
  }, [active, roll, motion, size.width, size.height]);
  useEffect(() => {
    motionCallbacks.current.onMotionChange?.(
      active &&
        (motion !== "idle" || draggedId !== null || returning.length > 0),
    );
    return () => motionCallbacks.current.onMotionChange?.(false);
  }, [motion, active, draggedId, returning.length]);
  useEffect(() => {
    if (active && !roll)
      deskChange.current?.(visibleFrames.map((frame) => frame.id));
  }, [active, roll, visibleFrames.map((frame) => frame.id).join(",")]);
  useLayoutEffect(() => {
    for (const [id, animation] of returnFlights.current)
      if (!returning.includes(id)) {
        animation.cancel();
        returnFlights.current.delete(id);
      }
    for (const id of returning) {
      if (returnFlights.current.has(id)) continue;
      const node = world.current?.querySelector<HTMLElement>(
        `.lt-contact-frame[data-photo-id="${id}"]`,
      );
      if (!node || reducedMotion()) {
        setReturning((old) => old.filter((value) => value !== id));
        continue;
      }
      const delta = filmDockTransform(
        node.getBoundingClientRect(),
        dockBounds(),
      );
      const animation = node.animate(
        [
          { transform: "translate(0px,0px) scale(1,1)", opacity: 1 },
          {
            transform: `translate(${delta.x / view.scale}px,${delta.y / view.scale}px) scale(${delta.scaleX},${delta.scaleY})`,
            opacity: 0,
          },
        ],
        { duration: 460, easing: "cubic-bezier(.4,0,.65,1)", fill: "forwards" },
      );
      returnFlights.current.set(id, animation);
      void animation.finished
        .then(() => setReturning((old) => old.filter((value) => value !== id)))
        .catch(() => {});
    }
  }, [returning]);
  useLayoutEffect(() => {
    if (!active || !["entering", "stowing"].includes(motion)) return;
    const stow = motion === "stowing";
    if (reducedMotion()) {
      if (stow) setPlaced([]);
      setMotion(stow ? "stowed" : "idle");
      return;
    }
    const table = viewport.current!,
      root = table.closest(".lighttable")!;
    const nodes = [
      ...(world.current?.querySelectorAll<HTMLElement>(
        '.lt-contact-frame:not([data-shelved="true"])',
      ) || []),
    ];
    const screen = table.getBoundingClientRect();
    const dock = dockBounds();
    const animations = nodes.map((node, index) => {
      const rect = node.getBoundingClientRect();
      const delta = filmDockTransform(rect, dock);
      const folded = {
        transform: `translate(${delta.x / view.scale}px,${delta.y / view.scale}px) scale(${delta.scaleX},${delta.scaleY})`,
        opacity: 0,
      };
      const flat = { transform: "translate(0px,0px) scale(1,1)", opacity: 1 };
      const visible =
        rect.right > screen.left &&
        rect.left < screen.right &&
        rect.bottom > screen.top &&
        rect.top < screen.bottom;
      return node.animate(stow ? [flat, folded] : [folded, flat], {
        duration: visible ? (stow ? 480 : 780) : 1,
        delay: visible ? Math.min(index, 18) * (stow ? 7 : 17) : 0,
        easing: stow
          ? "cubic-bezier(.55,0,.8,.35)"
          : "cubic-bezier(.16,1,.3,1)",
        fill: "both",
      });
    });
    flights.current = animations;
    let cancelled = false;
    void Promise.all(animations.map((a) => a.finished))
      .then(() => {
        if (!cancelled) {
          if (stow) setPlaced([]);
          setMotion(stow ? "stowed" : "idle");
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      cancelFlight();
    };
  }, [motion, active]);
  useEffect(() => {
    if (!active || !roll || !playing || !world.current) return;
    const track = filmRollPlayback(desk.current.view, base, size.width);
    if (!track) {
      setPlaying(false);
      return;
    }
    const node = world.current,
      current = desk.current.view;
    const transform = (x: number) =>
      `translate(${x}px,${current.y}px) scale(${current.scale})`;
    const animation = node.animate(
      [
        { transform: transform(track.start) },
        { transform: transform(track.end) },
      ],
      { duration: track.duration, easing: "linear", fill: "forwards" },
    );
    playback.current = animation;
    animation.onfinish = () => {
      const next = { ...desk.current.view, x: track.end };
      desk.current.view = next;
      node.style.transform = transform(track.end);
      setView(next);
      if (photos.length > limit) setLimit((n) => n + 96);
      else setPlaying(false);
    };
    return () => {
      animation.onfinish = null;
      if (playback.current === animation) pausePlayback(false);
    };
  }, [playing, active, roll, limit, size.width, size.height, decorated]);
  useEffect(() => {
    const hide = () => {
      if (document.hidden) pausePlayback();
    };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, []);
  useEffect(() => {
    pausePlayback();
  }, [photos.map((p) => p.id).join(",")]);
  useEffect(() => {
    if (!active && motion !== "waiting") stopMotion();
  }, [active]);
  useEffect(() => {
    if (!active || !fitted.current || drag.current) return;
    const previous = lastSelection.current;
    lastSelection.current = { currentId, reveal, active };
    if (
      playing &&
      previous.currentId === currentId &&
      previous.reveal === reveal &&
      previous.active === active
    )
      return;
    pausePlayback();
    if (!roll && placedSet && !placedSet.has(currentId)) return;
    const index = photos.findIndex((p) => p.id === currentId);
    if (index >= limit) {
      setLimit(Math.ceil((index + 1) / 96) * 96);
      return;
    }
    const frame = frames.find((f) => f.id === currentId);
    if (!frame) return;
    const x = frame.x * view.scale + view.x,
      y = frame.y * view.scale + view.y;
    if (
      x < 20 ||
      x + frame.width * view.scale > size.width - 20 ||
      y < 150 ||
      y + frame.height * view.scale > size.height - 190
    )
      setView((old) => ({
        ...old,
        x: roll
          ? panRoll(
              size.width / 2 - (frame.x + frame.width / 2) * old.scale,
              old.scale,
            )
          : size.width / 2 - (frame.x + frame.width / 2) * old.scale,
        y: roll
          ? old.y
          : (size.height - 60) / 2 - (frame.y + frame.height / 2) * old.scale,
      }));
  }, [currentId, active, limit, reveal]);
  useLayoutEffect(() => {
    if (!active || !viewport.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      }),
    );
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, [active]);
  useEffect(() => {
    const table = viewport.current;
    if (!active || !table) return;
    const wheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest(".ft-toolbar")) return;
      event.preventDefault();
      stopMotion();
      autoLayout.current = false;
      if (roll && !event.ctrlKey && !event.metaKey) {
        setView((old) => ({
          ...old,
          x: panRoll(old.x - (event.deltaX || event.deltaY), old.scale),
        }));
        return;
      }
      const bounds = table.getBoundingClientRect();
      setView((old) =>
        constrainView(
          filmTableZoom(
            old,
            { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
            old.scale * Math.exp(-event.deltaY * 0.0015),
          ),
        ),
      );
    };
    table.addEventListener("wheel", wheel, { passive: false });
    return () => table.removeEventListener("wheel", wheel);
  }, [
    active,
    base.map((f) => f.id).join(","),
    size.width,
    size.height,
    roll,
    decorated,
  ]);
  useLayoutEffect(() => {
    if (
      active &&
      size.width &&
      (!fitted.current || (!roll && autoLayout.current))
    ) {
      fit(visibleFrames);
      fitted.current = true;
    }
  }, [active, area.width, area.height, area.y, aspectKey, decorated]);
  useEffect(() => {
    if (!active) setLoupe(false);
  }, [active]);
  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      cancelFlight();
      returnFlights.current.forEach((animation) => animation.cancel());
      returnFlights.current.clear();
      pausePlayback();
      if (pendingMove.current) pendingMove.current();
      remember();
    },
    [key],
  );
  useEffect(() => {
    const timer = setTimeout(remember, 300);
    return () => clearTimeout(timer);
  }, [view, positions, brightness, scales, placed]);
  const schedule = (work: () => void) => {
    pendingMove.current = work;
    if (!raf.current)
      raf.current = requestAnimationFrame(() => {
        raf.current = 0;
        const next = pendingMove.current;
        pendingMove.current = null;
        next?.();
      });
  };
  const zoom = (
    scale: number,
    point: Point = { x: size.width / 2, y: size.height / 2 },
  ) => {
    autoLayout.current = false;
    stopMotion();
    setView((old) => constrainView(filmTableZoom(old, point, scale)));
  };
  const showLoupe = () => {
    stopMotion();
    const frame = frames.find((f) => f.id === currentId);
    if (!loupe && frame)
      setCenter({
        x: (frame.x + frame.width / 2) * view.scale + view.x,
        y: (frame.y + frame.height / 2) * view.scale + view.y,
      });
    setLoupe((v) => !v);
  };
  useEffect(() => {
    if (!active) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape" && loupe) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setLoupe(false);
        return;
      }
      if (
        (event.target as HTMLElement).matches("input,select,textarea") ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
      )
        return;
      const key = event.key.toLowerCase();
      if (key === "v") {
        event.preventDefault();
        showLoupe();
      }
      if (key === "l") {
        event.preventDefault();
        onLight();
      }
      if (key === "0") {
        event.preventDefault();
        stopMotion();
        fit();
      }
      if (key === "+" || key === "=") {
        event.preventDefault();
        zoom(view.scale * 1.2);
      }
      if (key === "-") {
        event.preventDefault();
        zoom(view.scale / 1.2);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });
  const radius = Math.max(
    70,
    Math.min(lensSize, size.width * 0.2, size.height * 0.24),
  );
  const opticalId = "film-optics-" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const refraction = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext("2d")!,
      field = context.createImageData(128, 128);
    field.data.set(filmRefractionMap(128));
    context.putImageData(field, 0, 0);
    return canvas.toDataURL();
  }, []);
  // Keep the whole lens on the glass while sampling the point under the cursor.
  const lensCenter = {
    x: Math.max(radius + 12, Math.min(size.width - radius - 12, center.x)),
    y: Math.max(radius + 12, Math.min(size.height - radius - 12, center.y)),
  };
  const guard = 40;
  const lensView = filmLoupeTransform(
    view,
    center,
    magnification,
    radius + guard,
  );
  const visibleInLens = (f: FilmTableFrame) => {
    const x = f.x * view.scale + view.x,
      y = f.y * view.scale + view.y,
      pad = (radius + guard) / magnification;
    return (
      x <= center.x + pad &&
      x + f.width * view.scale >= center.x - pad &&
      y <= center.y + pad &&
      y + f.height * view.scale >= center.y - pad
    );
  };
  const film = (frame: FilmTableFrame, lens = false) => {
    const photo = available.get(frame.id)!;
    const displayed = roll || placedSet === null || placedSet.has(photo.id);
    const isReturning = returning.includes(photo.id);
    const stock = String(photo.recipe.film_stock || "none");
    const label =
      stock !== "none"
        ? (filmNames[stock] || stock).replace(/柯达|富士/g, "").toUpperCase()
        : "PHOTO ALL · 35mm";
    const number = String(
      photos.findIndex((p) => p.id === photo.id) + 1,
    ).padStart(2, "0");
    return (
      <article
        key={photo.id}
        className={`ft-film ${lens ? "ft-lens-film" : "lt-contact-frame"} ${photo.id === currentId ? "active" : ""} ${decision(photo)}`}
        style={{
          left: frame.x,
          top: frame.y,
          width: frame.width,
          height: frame.height,
          visibility: !displayed && !isReturning ? "hidden" : undefined,
          pointerEvents: !displayed || isReturning ? "none" : undefined,
        }}
        tabIndex={lens ? undefined : displayed ? 0 : -1}
        aria-hidden={lens || !displayed ? true : undefined}
        aria-label={lens ? undefined : `观片 ${photo.name}`}
        data-photo-id={photo.id}
        data-shelved={!displayed}
        onPointerDown={
          lens
            ? undefined
            : (e) => {
                if (e.button !== 0) return;
                stopMotion();
                e.preventDefault();
                e.currentTarget.focus({ preventScroll: true });
                e.stopPropagation();
                onSelect(photo.id);
                if (loupe) return;
                e.currentTarget.setPointerCapture(e.pointerId);
                drag.current = {
                  id: hand || roll ? undefined : photo.id,
                  pointer: e.pointerId,
                  start: { x: e.clientX, y: e.clientY },
                  origin:
                    hand || roll
                      ? { x: desk.current.view.x, y: desk.current.view.y }
                      : positions[photo.id] ||
                        base.find((f) => f.id === photo.id)!,
                  scale: view.scale,
                };
                setMoving(true);
              }
        }
        onDoubleClick={
          lens
            ? undefined
            : () => {
                if (!loupe) onOpen(photo);
              }
        }
        onKeyDown={
          lens
            ? undefined
            : (e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onOpen(photo);
                }
              }
        }
      >
        {decorated && (
          <div className="ft-rail ft-rail-top">
            <span>{label}</span>
            <b>{number}</b>
          </div>
        )}
        <div
          className="ft-emulsion"
          style={{ height: frame.height - (decorated ? 60 : 0) }}
        >
          <Picture
            photo={photo}
            size={sourceSize(
              Math.max(frame.width, frame.height - (decorated ? 60 : 0)) *
                view.scale *
                window.devicePixelRatio *
                (lens ? magnification : 1),
            )}
            revision={revisions[photo.id]}
            eager={lens}
            quality="source"
          />
          {decorated && <div className="ft-gloss" />}
        </div>
        {decorated && (
          <div className="ft-rail ft-rail-bottom">
            <span>{number}A　▸</span>
            <i />
            <b>{number}</b>
          </div>
        )}
        {!lens && decorated && (
          <span className="ft-film-decision">
            {decision(photo) === "keep"
              ? "●"
              : decision(photo) === "reject"
                ? "×"
                : ""}
          </span>
        )}
        {!lens &&
          !roll &&
          displayed &&
          photo.id === currentId &&
          !loupe &&
          !hand &&
          (["nw", "ne", "sw", "se"] as const).map((corner) => (
            <button
              key={corner}
              className={`ft-resize-handle ${corner}`}
              data-corner={corner}
              aria-label={`调整照片尺寸 ${photo.name} ${corner}`}
              title="拖动缩放这张照片"
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                stopMotion();
                e.preventDefault();
                e.stopPropagation();
                e.currentTarget.setPointerCapture(e.pointerId);
                drag.current = {
                  pointer: e.pointerId,
                  start: { x: e.clientX, y: e.clientY },
                  origin: { x: frame.x, y: frame.y },
                  scale: view.scale,
                  resize: {
                    id: photo.id,
                    factor: scales[photo.id] || 1,
                    width: frame.width,
                    height: frame.height,
                    sx: corner.endsWith("e") ? 1 : -1,
                    sy: corner.startsWith("s") ? 1 : -1,
                  },
                };
                setMoving(true);
              }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onDoubleClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onKeyDown={(e) => {
                if (
                  [
                    "ArrowLeft",
                    "ArrowRight",
                    "ArrowUp",
                    "ArrowDown",
                    "Home",
                  ].includes(e.key)
                ) {
                  e.preventDefault();
                  e.stopPropagation();
                  setScales((old) => ({
                    ...old,
                    [photo.id]:
                      e.key === "Home"
                        ? 1
                        : Math.max(
                            0.3,
                            Math.min(
                              4,
                              (old[photo.id] || 1) +
                                (["ArrowRight", "ArrowUp"].includes(e.key)
                                  ? 0.1
                                  : -0.1),
                            ),
                          ),
                  }));
                }
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                }
              }}
            />
          ))}
      </article>
    );
  };
  return (
    <div
      ref={viewport}
      hidden={!active}
      className={`film-table motion-${motion} ${incomingId !== null && !roll ? "accepting-photo" : ""} ${decorated ? "" : "is-plain"} ${roll ? "is-roll" : ""} ${light ? "lamp-on" : "lamp-off"} ${loupe ? "loupe-active" : ""} ${hand ? "hand-mode" : ""} ${moving ? "is-moving" : ""}`}
      data-light={light ? "on" : "off"}
      data-motion={motion}
      data-playing={playing}
      data-visible-photos={visibleFrames.length}
      onDragOver={(event) => {
        if (roll || !event.dataTransfer.types.includes(FILM_DRAG_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        if (
          roll ||
          !event.dataTransfer.types.includes(FILM_DRAG_TYPE) ||
          (event.target as HTMLElement).closest(".ft-toolbar")
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        const id = Number(event.dataTransfer.getData(FILM_DRAG_TYPE));
        if (Number.isSafeInteger(id))
          placeOne(id, { x: event.clientX, y: event.clientY });
      }}
      style={
        {
          "--ft-transmission": light ? brightness / 100 : 0.12,
          backgroundColor: light
            ? `rgb(${Math.min(255, Math.round(182 + brightness * 0.52))},${Math.min(255, Math.round(185 + brightness * 0.52))},${Math.min(255, Math.round(182 + brightness * 0.52))})`
            : undefined,
        } as React.CSSProperties
      }
      onPointerDown={(e) => {
        if (
          e.button !== 0 ||
          (e.target as HTMLElement).closest(".ft-toolbar,.ft-film")
        )
          return;
        e.preventDefault();
        stopMotion();
        e.currentTarget.focus();
        if (loupe) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = {
          pointer: e.pointerId,
          start: { x: e.clientX, y: e.clientY },
          origin: { x: desk.current.view.x, y: desk.current.view.y },
          scale: view.scale,
        };
        setMoving(true);
      }}
      tabIndex={-1}
      onPointerMove={(e) => {
        if ((e.target as HTMLElement).closest(".ft-toolbar")) return;
        const bounds = e.currentTarget.getBoundingClientRect(),
          point = { x: e.clientX - bounds.left, y: e.clientY - bounds.top };
        if (loupe) schedule(() => setCenter(point));
        const session = drag.current;
        if (!session) return;
        const dx = e.clientX - session.start.x,
          dy = e.clientY - session.start.y;
        if (Math.abs(dx) + Math.abs(dy) > 1) autoLayout.current = false;
        if (
          session.id !== undefined &&
          Math.abs(dx) + Math.abs(dy) > 5 &&
          !roll
        ) {
          setDraggedId(session.id);
          setZoneHover(overStowZone(e.clientX, e.clientY));
        }
        if (session.resize) {
          const r = session.resize;
          const distance =
            (2 * (dx * r.sx * r.width + dy * r.sy * r.height)) /
            (session.scale * (r.width * r.width + r.height * r.height));
          schedule(() =>
            setScales((old) => ({
              ...old,
              [r.id]: Math.max(0.3, Math.min(4, r.factor * (1 + distance))),
            })),
          );
        } else if (session.id !== undefined)
          schedule(() =>
            setPositions((old) => ({
              ...old,
              [session.id!]: {
                x: session.origin.x + dx / session.scale,
                y: session.origin.y + dy / session.scale,
              },
            })),
          );
        else
          schedule(() =>
            setView((old) => ({
              ...old,
              x: roll
                ? panRoll(session.origin.x + dx, old.scale)
                : session.origin.x + dx,
              y: roll ? old.y : session.origin.y + dy,
            })),
          );
      }}
      onPointerUp={(e) => {
        if (pendingMove.current) {
          pendingMove.current();
          pendingMove.current = null;
        }
        const session = drag.current;
        if (
          session?.id !== undefined &&
          Math.hypot(e.clientX - session.start.x, e.clientY - session.start.y) >
            5 &&
          !roll &&
          overStowZone(e.clientX, e.clientY)
        )
          stowOne(session.id);
        drag.current = null;
        setDraggedId(null);
        setZoneHover(false);
        setMoving(false);
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDraggedId(null);
        setZoneHover(false);
        setMoving(false);
      }}
    >
      <div className="ft-ruler ft-ruler-top" />
      <div className="ft-ruler ft-ruler-left" />
      <span className="ft-table-caption">
        PHOTO ALL　/　TRANSPARENCY VIEWER　/　
        {light ? "BACKLIGHT ON" : "BACKLIGHT OFF"}
      </span>
      <div
        ref={world}
        className="ft-world"
        inert={motion === "stowed" || motion === "waiting"}
        style={{
          transform: `translate(${view.x}px,${view.y}px) scale(${view.scale})`,
        }}
      >
        {roll && decorated && base.length > 0 && (
          <div
            className="ft-roll-shadow"
            style={{
              left: base[0].x - 24,
              top: 40,
              width:
                base[base.length - 1].x +
                base[base.length - 1].width -
                base[0].x +
                48,
              height: rollHeight,
            }}
          />
        )}
        {roll && decorated && base.length > 0 ? (
          <div
            className="ft-roll-strip"
            style={{
              left: base[0].x - 24,
              top: 40,
              width:
                base[base.length - 1].x +
                base[base.length - 1].width -
                base[0].x +
                48,
              height: rollHeight,
            }}
          >
            <div
              className="ft-roll-inner"
              style={{ left: 24 - base[0].x, top: -40 }}
            >
              <div
                className="ft-roll-leader"
                style={{ left: base[0].x - 24, top: 40, height: rollHeight }}
              />
              <div
                className="ft-roll-leader end"
                style={{
                  left: base[base.length - 1].x + base[base.length - 1].width,
                  top: 40,
                  height: rollHeight,
                }}
              />
              {frames.map((f) => film(f))}
            </div>
          </div>
        ) : (
          frames.map((f) => film(f))
        )}
      </div>
      {loupe && (
        <div
          className="ft-magnifier"
          aria-label="圆形光学放大镜"
          role="img"
          style={{
            left: lensCenter.x - radius,
            top: lensCenter.y - radius,
            width: radius * 2,
            height: radius * 2,
          }}
        >
          <svg
            width="0"
            height="0"
            aria-hidden="true"
            className="ft-filter-definitions"
          >
            <defs>
              <filter
                id={opticalId}
                filterUnits="userSpaceOnUse"
                x="0"
                y="0"
                width={radius * 2 + guard * 2}
                height={radius * 2 + guard * 2}
                colorInterpolationFilters="sRGB"
              >
                <feImage
                  href={refraction}
                  x={guard}
                  y={guard}
                  width={radius * 2}
                  height={radius * 2}
                  preserveAspectRatio="none"
                  result="refraction"
                />
                <feDisplacementMap
                  in="SourceGraphic"
                  in2="refraction"
                  scale={radius * 0.12}
                  xChannelSelector="R"
                  yChannelSelector="G"
                />
              </filter>
            </defs>
          </svg>
          <div
            className="ft-optics"
            style={{ inset: -guard, filter: `url(#${opticalId})` }}
          >
            <div
              className="ft-lens-world"
              style={{
                transform: `translate(${lensView.x}px,${lensView.y}px) scale(${lensView.scale})`,
              }}
            >
              {visibleFrames.filter(visibleInLens).map((f) => film(f, true))}
            </div>
          </div>
          <div className="ft-lens-reflection" />
          <div className="ft-lens-edge" />
        </div>
      )}
      {loupe && (
        <div
          className="ft-loupe-rim"
          aria-hidden="true"
          style={{
            left: lensCenter.x - radius - 18,
            top: lensCenter.y - radius - 18,
            width: radius * 2 + 36,
            height: radius * 2 + 36,
          }}
        />
      )}
      <div
        className="ft-toolbar lt-hud"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button
          aria-label="拖动桌面"
          aria-pressed={hand}
          onClick={() => setHand((v) => !v)}
          title="切换手型，拖动桌面"
        >
          <Hand size={15} />
        </button>
        <button aria-label="一键平铺胶片" onClick={spread}>
          <Grid2X2 size={14} />
          一键平铺
        </button>
        {!roll && (
          <button
            aria-label="一键收纳胶片"
            aria-pressed={motion === "stowed"}
            disabled={
              !visibleFrames.length ||
              motion === "stowed" ||
              motion === "stowing"
            }
            onClick={() => {
              pausePlayback();
              cancelFlight();
              cancelReturns();
              setLoupe(false);
              setMotion("stowing");
            }}
          >
            <Archive size={14} />
            一键收纳
          </button>
        )}
        {roll && (
          <button
            aria-label={playing ? "暂停胶卷播放" : "播放胶卷"}
            aria-pressed={playing}
            disabled={!filmRollPlayback(view, base, size.width)}
            onClick={() => {
              if (playing) pausePlayback();
              else {
                setLoupe(false);
                setPlaying(true);
              }
            }}
          >
            {playing ? <Pause size={14} /> : <Play size={14} />}{" "}
            {playing ? "暂停" : "播放"}
          </button>
        )}
        <div className="ft-tool-divider" />
        <button aria-label="桌面缩小" onClick={() => zoom(view.scale / 1.2)}>
          <Minus size={13} />
        </button>
        <button
          aria-label="桌面适合全台"
          onClick={() => {
            stopMotion();
            fit();
          }}
        >
          {Math.round(view.scale * 100)}%
        </button>
        <button aria-label="桌面放大" onClick={() => zoom(view.scale * 1.2)}>
          <Plus size={13} />
        </button>
        <div className="ft-tool-divider" />
        <label className="ft-brightness">
          <Sun size={14} />
          <input
            aria-label="灯光亮度"
            type="range"
            min="40"
            max="160"
            step="1"
            value={brightness}
            onChange={(e) => setBrightness(Number(e.target.value))}
          />
          <output>{brightness}%</output>
        </label>
        <button
          aria-label="圆形放大镜"
          aria-pressed={loupe}
          onClick={showLoupe}
        >
          <Search size={14} />
          放大镜 <kbd>V</kbd>
        </button>
        {loupe && (
          <>
            <label className="ft-magnification">
              倍率
              <input
                aria-label="放大镜倍率"
                type="range"
                min="1"
                max="20"
                step="0.5"
                value={magnification}
                onChange={(e) => setMagnification(Number(e.target.value))}
              />
              <output>{magnification}×</output>
            </label>
            <label className="ft-lens-size">
              大小
              <input
                aria-label="放大镜大小"
                type="range"
                min="100"
                max="220"
                value={lensSize}
                onChange={(e) => setLensSize(Number(e.target.value))}
              />
              <output>{Math.round(radius * 2)}px</output>
            </label>
            <button aria-label="关闭圆形放大镜" onClick={() => setLoupe(false)}>
              <X size={14} />
            </button>
          </>
        )}
        {photos.length > limit && (
          <button onClick={() => setLimit((n) => n + 96)}>再摆 96 张</button>
        )}
      </div>
      {!roll && (
        <div
          className={`ft-stow-zone ${draggedId !== null ? "is-visible" : ""} ${zoneHover ? "is-targeted" : ""}`}
          style={{
            left: zoneLeft,
            top: zoneBottom - zoneHeight,
            width: zoneWidth,
            height: zoneHeight,
          }}
          aria-hidden={draggedId === null}
        >
          <Archive size={16} />
          <span>收纳</span>
        </div>
      )}
      <div className="ft-instruction">
        {loupe
          ? "移动鼠标查看细节 · V / Esc 收起放大镜"
          : roll
            ? "一卷光影 · 拖动或滚轮左右滑动 · Ctrl+滚轮缩放 · V 放大镜"
            : `${light ? "灯箱已开启" : "按 L 打开背光"} · 从底部拖入照片 · 拖到准备区上方收纳 · 滚轮缩放 · V 放大镜`}
      </div>
    </div>
  );
}
