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
import { Grid2X2, Hand, Minus, Plus, Search, Sun, X } from "lucide-react";
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
} from "./model";
import { Picture, sourceSize } from "./Preview";

type Point = { x: number; y: number };
type Saved = {
  frames: Record<number, Point>;
  view: FilmTableView;
  brightness: number;
  scales?: Record<number, number>;
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
  const [size, setSize] = useState({ width: 1440, height: 940 }),
    [hand, setHand] = useState(false),
    [limit, setLimit] = useState(96),
    [moving, setMoving] = useState(false);
  const viewport = useRef<HTMLDivElement>(null),
    fitted = useRef(!!initial),
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
  const desk = useRef({ positions, view, brightness, scales });
  desk.current = { positions, view, brightness, scales };
  const shown = photos.slice(0, limit),
    columns = Math.min(
      8,
      Math.max(3, Math.ceil(Math.sqrt(Math.min(shown.length, 24) * 2))),
    );
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
            columns,
            decorated,
          ),
    [aspectKey, columns, decorated, roll],
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
      frames: desk.current.positions,
      view: desk.current.view,
      brightness: desk.current.brightness,
      scales: desk.current.scales,
    });
  const fit = (arranged: FilmTableFrame[] = frames) => {
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
      1.3,
      Math.max(
        0.15,
        Math.min(
          (size.width - 140) / (maxX - minX),
          (size.height - 300) / (maxY - minY),
        ),
      ),
    );
    setView({
      scale,
      x: (size.width - (maxX - minX) * scale) / 2 - minX * scale,
      y: 130 + (size.height - 300 - (maxY - minY) * scale) / 2 - minY * scale,
    });
  };
  useEffect(() => {
    if (!active || !fitted.current || drag.current) return;
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
  }, [currentId, active, limit]);
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
  useEffect(() => {
    if (active && !fitted.current && size.width) {
      fit(base);
      fitted.current = true;
    }
  }, [active, size.width, size.height]);
  useEffect(() => {
    if (!active) setLoupe(false);
  }, [active]);
  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      if (pendingMove.current) pendingMove.current();
      remember();
    },
    [key],
  );
  useEffect(() => {
    const timer = setTimeout(remember, 300);
    return () => clearTimeout(timer);
  }, [view, positions, brightness, scales]);
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
  ) => setView((old) => constrainView(filmTableZoom(old, point, scale)));
  const showLoupe = () => {
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
        }}
        tabIndex={lens ? undefined : 0}
        aria-hidden={lens ? true : undefined}
        aria-label={lens ? undefined : `观片 ${photo.name}`}
        onPointerDown={
          lens
            ? undefined
            : (e) => {
                if (e.button !== 0) return;
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
                      ? { x: view.x, y: view.y }
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
      className={`film-table ${decorated ? "" : "is-plain"} ${roll ? "is-roll" : ""} ${light ? "lamp-on" : "lamp-off"} ${loupe ? "loupe-active" : ""} ${hand ? "hand-mode" : ""} ${moving ? "is-moving" : ""}`}
      data-light={light ? "on" : "off"}
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
        e.currentTarget.focus();
        if (loupe) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = {
          pointer: e.pointerId,
          start: { x: e.clientX, y: e.clientY },
          origin: { x: view.x, y: view.y },
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
        drag.current = null;
        setMoving(false);
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = null;
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
        className="ft-world"
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
              {frames.filter(visibleInLens).map((f) => film(f, true))}
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
        <button
          aria-label="一键平铺胶片"
          onClick={() => {
            setPositions({});
            setScales({});
            fit(base);
          }}
        >
          <Grid2X2 size={14} />
          一键平铺
        </button>
        <div className="ft-tool-divider" />
        <button aria-label="桌面缩小" onClick={() => zoom(view.scale / 1.2)}>
          <Minus size={13} />
        </button>
        <button aria-label="桌面适合全台" onClick={() => fit()}>
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
      <div className="ft-instruction">
        {loupe
          ? "移动鼠标查看细节 · V / Esc 收起放大镜"
          : roll
            ? "一卷光影 · 拖动或滚轮左右滑动 · Ctrl+滚轮缩放 · V 放大镜"
            : `${light ? "灯箱已开启" : "按 L 打开背光"} · 拖动胶片自由摆放 · 拖动空白平移 · 滚轮缩放 · V 放大镜`}
      </div>
    </div>
  );
}
