// SPDX-License-Identifier: GPL-3.0-or-later
// Film-contact-sheet workspace implemented for Photo All's shared catalog and render pipeline.
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Columns2,
  Film,
  Grid2X2,
  Heart,
  Keyboard,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Moon,
  Redo2,
  SlidersHorizontal,
  Sun,
  Trash2,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  Photo,
  photoBlob,
  reviewStep,
  viewerFullscreen,
  decodedPreviews,
  photoPreviewFamily,
  photoDimensions,
  VariantMode,
  applyVariantPreference,
  resolveVariantSelection,
} from "./model";
import { Picture } from "./Preview";
import { FilmTable } from "./FilmTable";

type Layout = "sheet" | "single" | "compare";
export function Lighttable({
  photos: sourcePhotos,
  variantMode = "all",
  onVariantMode,
  initialId,
  startCompare,
  revisions,
  filmNames,
  history,
  onDecision,
  onUndo,
  onRedo,
  onEdit,
  onExit,
  onRemove,
  saveRef,
}: {
  photos: Photo[];
  variantMode?: VariantMode;
  onVariantMode?: (mode: VariantMode) => void;
  initialId?: number;
  startCompare: boolean;
  revisions: Record<number, number>;
  filmNames: Record<string, string>;
  history: { undo: number; redo: number };
  onDecision: (id: number, decision: string) => Promise<void>;
  onUndo: () => Promise<void>;
  onRedo: () => Promise<void>;
  onEdit: (photo: Photo) => void;
  onExit: () => void;
  onRemove?: (id: number) => Promise<void>;
  saveRef: React.MutableRefObject<null | (() => Promise<void>)>;
}) {
  const photos = useMemo(
    () => applyVariantPreference(sourcePhotos, variantMode),
    [sourcePhotos, variantMode],
  );
  const ids = photos.map((p) => p.id);
  const [layout, setLayout] = useState<Layout>(
    startCompare && photos.length > 1
      ? "compare"
      : initialId
        ? "single"
        : "sheet",
  );
  const [currentId, setCurrentId] = useState(
    resolveVariantSelection(sourcePhotos, photos, initialId) ?? -1,
  );
  const [immersive, setImmersive] = useState(true),
    [controls, setControls] = useState(true),
    [light, setLight] = useState(false),
    [help, setHelp] = useState(false);
  const [fullscreen, setFullscreen] = useState(false),
    [fullscreenReady, setFullscreenReady] = useState(false);
  const [filmBorders, setFilmBorders] = useState(() => {
    try {
      return localStorage.getItem("photoall-film-borders") !== "off";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("photoall-film-borders", filmBorders ? "on" : "off");
    } catch {}
  }, [filmBorders]);
  const [zoom, setZoom] = useState(1),
    [pan, setPan] = useState({ x: 0, y: 0 });
  const [marks, setMarks] = useState<Record<number, string>>({}),
    [pendingCount, setPendingCount] = useState(0),
    [error, setError] = useState("");
  const [menu, setMenu] = useState<{ id: number; x: number; y: number } | null>(
    null,
  );
  const previousIds = useRef(ids);
  const root = useRef<HTMLDivElement>(null),
    queue = useRef<Promise<void>>(Promise.resolve());
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false),
    failure = useRef({ version: 0, error: new Error("保存失败") });
  const fullscreenWork = useRef<Promise<void>>(Promise.resolve()),
    fullscreenDesired = useRef(false);
  const previousFullscreen = useRef<boolean | null>(null),
    fullscreenRef = useRef(false),
    hoverHUD = useRef(false),
    focusHUD = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
      undefined,
    ),
    lastWake = useRef(0);
  const immersionInitialized = useRef(false);
  const callbacks = useRef({
    onDecision,
    onUndo,
    onRedo,
    onEdit,
    onExit,
    onRemove,
  });
  callbacks.current = { onDecision, onUndo, onRedo, onEdit, onExit, onRemove };
  const shownId =
    resolveVariantSelection(
      sourcePhotos,
      photos,
      currentId,
      previousIds.current,
    ) ?? -1;
  useEffect(() => {
    if (currentId !== shownId) {
      setCurrentId(shownId);
      setPan({ x: 0, y: 0 });
    }
    previousIds.current = ids;
  }, [ids.join(","), shownId]);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest(".lt-thumb-menu")) setMenu(null);
    };
    window.addEventListener("pointerdown", dismiss);
    return () => window.removeEventListener("pointerdown", dismiss);
  }, [menu]);
  const current = photos.find((p) => p.id === shownId);
  const index = ids.indexOf(shownId),
    decision = (photo: Photo) => marks[photo.id] || photo.decision;
  const wake = useCallback(() => {
    const now = performance.now();
    setControls(true);
    if (now - lastWake.current < 100) return;
    lastWake.current = now;
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (!hoverHUD.current && !focusHUD.current) setControls(false);
    }, 1800);
  }, []);
  const flush = useCallback(async () => {
    const version = failure.current.version;
    let task: Promise<void>;
    do {
      task = queue.current;
      await task;
    } while (task !== queue.current);
    if (failure.current.version !== version) throw failure.current.error;
  }, []);
  useEffect(() => {
    saveRef.current = async () => {
      closingRef.current = true;
      setClosing(true);
      try {
        await flush();
      } catch (e) {
        closingRef.current = false;
        setClosing(false);
        throw e;
      }
    };
    return () => {
      saveRef.current = null;
    };
  }, [saveRef, flush]);
  useEffect(() => {
    if (immersive && immersionInitialized.current) {
      clearTimeout(hideTimer.current);
      hoverHUD.current = false;
      focusHUD.current = false;
      root.current?.focus();
      setControls(false);
    } else if (immersive) wake();
    else {
      clearTimeout(hideTimer.current);
      setControls(true);
    }
    immersionInitialized.current = true;
  }, [immersive, wake]);
  useEffect(() => {
    let disposed = false;
    const previousFocus = document.activeElement as HTMLElement | null;
    root.current?.focus();
    fullscreenWork.current = viewerFullscreen()
      .then((value) => {
        previousFullscreen.current = value;
        fullscreenRef.current = value;
        fullscreenDesired.current = value;
        if (!disposed) {
          setFullscreen(value);
          setFullscreenReady(true);
        }
      })
      .catch((e) => {
        if (!disposed) setError(e.message);
      });
    const changed = () => {
      fullscreenRef.current = !!document.fullscreenElement;
      fullscreenDesired.current = fullscreenRef.current;
      setFullscreen(fullscreenRef.current);
    };
    document.addEventListener("fullscreenchange", changed);
    return () => {
      disposed = true;
      clearTimeout(hideTimer.current);
      document.removeEventListener("fullscreenchange", changed);
      void fullscreenWork.current
        .then(async () => {
          if (
            previousFullscreen.current !== null &&
            fullscreenRef.current !== previousFullscreen.current
          )
            fullscreenRef.current = await viewerFullscreen(
              previousFullscreen.current,
            );
        })
        .catch(() => {});
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);
  useEffect(() => {
    if (layout === "sheet") return;
    const controller = new AbortController();
    [photos[index - 1], photos[index + 1]].filter(Boolean).forEach(
      (photo) =>
        void decodedPreviews
          .read(
            photoPreviewFamily(
              photo,
              false,
              revisions[photo.id] || 0,
              "source",
            ),
            1024,
            (signal) =>
              photoBlob(
                photo,
                1024,
                false,
                signal,
                revisions[photo.id] || 0,
                "source",
              ),
            controller.signal,
            photoDimensions({
              ...photo,
              recipe: photo.committed_recipe ?? photo.recipe,
            }),
          )
          .catch(() => {}),
    );
    return () => controller.abort();
  }, [shownId, layout]);
  const enqueue = (work: () => Promise<void>) => {
    if (closingRef.current) return Promise.resolve();
    setPendingCount((n) => n + 1);
    setError("");
    const task = queue.current
      .catch(() => {})
      .then(work)
      .catch((e) => {
        failure.current = {
          version: failure.current.version + 1,
          error: e instanceof Error ? e : new Error(String(e)),
        };
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setPendingCount((n) => n - 1));
    queue.current = task;
    return task;
  };
  const mark = (value: string) => {
    if (!current || closingRef.current) return;
    const id = current.id;
    setMarks((old) => ({ ...old, [id]: value }));
    if (layout !== "sheet") setCurrentId(reviewStep(ids, id, 1, undefined));
    void enqueue(async () => {
      try {
        await callbacks.current.onDecision(id, value);
      } catch (e) {
        setMarks((old) => {
          const next = { ...old };
          if (next[id] === value) delete next[id];
          return next;
        });
        setCurrentId(id);
        throw e;
      }
      setMarks((old) => {
        const next = { ...old };
        if (next[id] === value) delete next[id];
        return next;
      });
    });
    if (!immersive) wake();
  };
  const move = (delta: number) => {
    setCurrentId(reviewStep(ids, shownId, delta, undefined));
    setPan({ x: 0, y: 0 });
    if (!immersive) wake();
  };
  const changeLayout = (next: Layout) => {
    setLayout(next);
    setPan({ x: 0, y: 0 });
    setZoom(1);
    if (!immersive) wake();
  };
  const toggleFullscreen = async () => {
    if (closingRef.current) return;
    const target = !fullscreenDesired.current;
    fullscreenDesired.current = target;
    fullscreenWork.current = fullscreenWork.current
      .then(async () => {
        const value = await viewerFullscreen(target);
        fullscreenRef.current = value;
        setFullscreen(value);
      })
      .catch((e) => {
        fullscreenDesired.current = fullscreenRef.current;
        setError(e instanceof Error ? e.message : String(e));
      });
    await fullscreenWork.current;
  };
  const finish = async (edit = false) => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    try {
      await flush();
      await fullscreenWork.current;
      if (
        previousFullscreen.current !== null &&
        fullscreenRef.current !== previousFullscreen.current
      ) {
        fullscreenRef.current = await viewerFullscreen(
          previousFullscreen.current,
        );
      }
      if (edit && current) callbacks.current.onEdit(current);
      else callbacks.current.onExit();
    } catch (e) {
      closingRef.current = false;
      setClosing(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (closingRef.current) {
        event.preventDefault();
        return;
      }
      if (event.defaultPrevented) return;
      if (event.key === "Escape" && menu) {
        event.preventDefault();
        setMenu(null);
        return;
      }
      // The table owns Escape while its optical loupe is open. Listener order
      // can change as the child updates its pointer position.
      if (
        event.key === "Escape" &&
        root.current?.querySelector(".ft-magnifier")
      )
        return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (fullscreenRef.current) void toggleFullscreen();
        else void finish();
        return;
      }
      if ((event.target as HTMLElement).matches("input,select,textarea"))
        return;
      const letter = event.key.toLowerCase();
      if (
        (event.ctrlKey || event.metaKey) &&
        (letter === "z" || letter === "y")
      ) {
        event.preventDefault();
        void enqueue(() =>
          letter === "y" || event.shiftKey
            ? callbacks.current.onRedo()
            : callbacks.current.onUndo(),
        );
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (
        [
          "ArrowLeft",
          "ArrowRight",
          " ",
          "f",
          "i",
          "g",
          "e",
          "c",
          "p",
          "x",
          "u",
          "?",
        ].includes(letter) ||
        event.key.startsWith("Arrow")
      )
        event.preventDefault();
      if (event.key === "ArrowLeft") move(-1);
      if (event.key === "ArrowRight") move(1);
      if (letter === "p") mark("keep");
      if (letter === "x") mark("reject");
      if (letter === "u") mark("pending");
      if (letter === "f" && fullscreenReady) void toggleFullscreen();
      if (letter === "i") setImmersive((v) => !v);
      if (letter === "g") changeLayout("sheet");
      if (letter === "e") changeLayout("single");
      if (letter === "c" && ids.length > 1) changeLayout("compare");
      if (letter === "?") setHelp((v) => !v);
      if (event.code === "Space") {
        setControls(true);
        clearTimeout(hideTimer.current);
      }
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === "Space") wake();
    };
    window.addEventListener("keydown", key);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("keyup", up);
    };
  });
  const dragging = useRef<{
    x: number;
    y: number;
    px: number;
    py: number;
    pointer: number;
  } | null>(null);
  const image = (photo: Photo, pinnedFrame = false) => (
    <div className={`lt-pane ${pinnedFrame ? "reference" : ""}`} key={photo.id}>
      <div
        className="lt-loupe"
        onDoubleClick={() => {
          setZoom((v) => (v === 1 ? 2 : 1));
          setPan({ x: 0, y: 0 });
        }}
        onPointerDown={(e) => {
          if (zoom <= 1 || e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          dragging.current = {
            x: e.clientX,
            y: e.clientY,
            px: pan.x,
            py: pan.y,
            pointer: e.pointerId,
          };
        }}
        onPointerMove={(e) => {
          const drag = dragging.current;
          if (drag && e.currentTarget.hasPointerCapture(e.pointerId))
            setPan({
              x: drag.px + e.clientX - drag.x,
              y: drag.py + e.clientY - drag.y,
            });
        }}
        onPointerUp={() => {
          dragging.current = null;
        }}
        onPointerCancel={() => {
          dragging.current = null;
        }}
      >
        <div
          className="lt-image-transform"
          style={{
            transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})`,
          }}
        >
          <Picture
            photo={photo}
            revision={revisions[photo.id]}
            quality="source"
            sourceScale={zoom}
            eager
          />
        </div>
      </div>
      <div className="lt-pane-caption">
        <span>
          {pinnedFrame ? "参考帧 · " : ""}
          {photo.name}
        </span>
        <span>{filmNames[String(photo.recipe.film_stock)] || "原生显影"}</span>
        <b className={decision(photo)}>
          {decision(photo) === "keep"
            ? "精选"
            : decision(photo) === "reject"
              ? "排除"
              : "待选"}
        </b>
      </div>
    </div>
  );
  const hudVisible = !immersive || controls || help;
  const hudEvents = {
    onPointerEnter: () => {
      hoverHUD.current = true;
      setControls(true);
      clearTimeout(hideTimer.current);
    },
    onPointerLeave: () => {
      hoverHUD.current = false;
      lastWake.current = 0;
      wake();
    },
  };
  return createPortal(
    <div
      ref={root}
      className={`lighttable ${immersive ? "immersive" : ""} ${hudVisible ? "hud-visible" : "hud-hidden"} ${light ? "backlit" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="电子观片台"
      aria-busy={closing}
      data-ready={fullscreenReady}
      inert={closing}
      tabIndex={-1}
      onPointerMove={(e) => {
        hoverHUD.current = !!(e.target as HTMLElement).closest(".lt-hud");
        const bounds = e.currentTarget.getBoundingClientRect(),
          edge = e.clientY - bounds.top < 18 || bounds.bottom - e.clientY < 18;
        if (hoverHUD.current || edge) wake();
      }}
      onFocusCapture={(e) => {
        focusHUD.current =
          !!(e.target as HTMLElement).closest(".lt-hud") &&
          (e.target as HTMLElement).matches(":focus-visible");
        if (focusHUD.current) setControls(true);
      }}
      onBlurCapture={(e) => {
        focusHUD.current =
          !!(e.relatedTarget as HTMLElement | null)?.closest(".lt-hud") &&
          !!(e.relatedTarget as HTMLElement | null)?.matches(":focus-visible");
        if (!focusHUD.current) {
          if (immersive && !hoverHUD.current) setControls(false);
        }
      }}
    >
      <header className="lt-header lt-hud" {...hudEvents}>
        <div className="lt-brand">
          <Film size={22} />
          <div>
            <h2>电子观片台</h2>
            <span>PHOTO ALL · LIGHTTABLE</span>
          </div>
        </div>
        <div className="lt-layouts">
          <button
            aria-label="胶片接触表"
            aria-pressed={layout === "sheet"}
            onClick={() => changeLayout("sheet")}
          >
            <Grid2X2 size={15} />
            胶片台
          </button>
          <button
            aria-label="单张观片"
            aria-pressed={layout === "single"}
            onClick={() => changeLayout("single")}
          >
            <Maximize2 size={15} />
            放大
          </button>
          <button
            aria-label="并排观片"
            aria-pressed={layout === "compare"}
            disabled={photos.length < 2}
            onClick={() => changeLayout("compare")}
          >
            <Columns2 size={15} />
            胶卷连排
          </button>
        </div>
        <div className="lt-header-actions">
          <select
            aria-label="观片格式偏好"
            title="同目录同名的 RAW 与 JPEG 只显示优先格式；保留独立照片"
            value={variantMode}
            disabled={!onVariantMode}
            onChange={(event) =>
              onVariantMode?.(event.target.value as VariantMode)
            }
          >
            <option value="all">全部</option>
            <option value="raw">RAW优先</option>
            <option value="jpeg">JPEG优先</option>
          </select>
          <span className="lt-save-state">
            {pendingCount ? (
              <>
                <LoaderCircle className="spin" size={12} />
                保存中
              </>
            ) : (
              <>
                <Check size={12} />
                本地保存
              </>
            )}
          </span>
          <button
            title="撤销观片操作"
            disabled={!history.undo || !!pendingCount}
            onClick={() => void enqueue(() => callbacks.current.onUndo())}
          >
            <Undo2 size={16} />
          </button>
          <button
            title="重做观片操作"
            disabled={!history.redo || !!pendingCount}
            onClick={() => void enqueue(() => callbacks.current.onRedo())}
          >
            <Redo2 size={16} />
          </button>
          <button
            aria-label="观片台背光开关"
            aria-pressed={light}
            onClick={() => setLight((v) => !v)}
          >
            {light ? <Sun size={16} /> : <Moon size={16} />}
            {light ? "关灯" : "开灯"}
          </button>
          <button
            aria-label="切换沉浸模式"
            aria-pressed={immersive}
            onClick={() => setImmersive((v) => !v)}
          >
            {immersive ? "沉浸中" : "沉浸"}
          </button>
          <button
            aria-label="观片台全屏"
            title="全屏观片"
            aria-pressed={fullscreen}
            disabled={!fullscreenReady}
            onClick={() => void toggleFullscreen()}
          >
            {fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
          <button
            aria-label="胶片边框开关"
            aria-pressed={filmBorders}
            onClick={() => setFilmBorders((v) => !v)}
          >
            <Film size={14} />
            边框
          </button>
          <button aria-label="退出观片台" onClick={() => void finish()}>
            <X size={19} />
          </button>
        </div>
      </header>
      <div className={`lt-stage layout-${layout}`}>
        <button
          className={`lt-corner-heart ${current && decision(current) === "keep" ? "is-kept" : ""}`}
          aria-label="观片收藏"
          aria-pressed={!!current && decision(current) === "keep"}
          disabled={!current || closing}
          onClick={() =>
            mark(current && decision(current) === "keep" ? "pending" : "keep")
          }
        >
          <Heart
            size={21}
            fill={
              current && decision(current) === "keep" ? "currentColor" : "none"
            }
          />
        </button>
        <FilmTable
          key={layout === "compare" ? "roll" : "desk"}
          roll={layout === "compare"}
          decorated={filmBorders}
          photos={photos}
          currentId={shownId}
          revisions={revisions}
          filmNames={filmNames}
          decision={decision}
          onSelect={setCurrentId}
          onOpen={(photo) => {
            setCurrentId(photo.id);
            setLayout("single");
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}
          active={layout !== "single"}
          light={light}
          onLight={() => setLight((v) => !v)}
        />
        {layout === "single" && (
          <div className="lt-display">{current && image(current)}</div>
        )}
        {!photos.length && (
          <div className="lt-empty">
            这个观片范围没有照片。
            <button onClick={() => void finish()}>返回图集</button>
          </div>
        )}
      </div>
      <footer className="lt-footer lt-hud" {...hudEvents}>
        <div className="lt-tools">
          <div className="lt-navigation">
            <button
              aria-label="观片上一张"
              disabled={
                !current || reviewStep(ids, shownId, -1, undefined) === shownId
              }
              onClick={() => move(-1)}
            >
              <ArrowLeft size={17} />
            </button>
            <span>
              {index + 1} <small>/ {photos.length}</small>
            </span>
            <button
              aria-label="观片下一张"
              disabled={
                !current || reviewStep(ids, shownId, 1, undefined) === shownId
              }
              onClick={() => move(1)}
            >
              <ArrowRight size={17} />
            </button>
          </div>
          <div className="lt-zoom">
            <button
              title="观片缩小"
              disabled={layout !== "single" || zoom <= 1}
              onClick={() => {
                setZoom((v) => Math.max(1, v - 0.25));
                setPan({ x: 0, y: 0 });
              }}
            >
              <ZoomOut size={16} />
            </button>
            <button
              title="观片适合画面"
              disabled={layout !== "single"}
              onClick={() => {
                setZoom(1);
                setPan({ x: 0, y: 0 });
              }}
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              title="观片放大"
              disabled={layout !== "single" || zoom >= 3}
              onClick={() => setZoom((v) => Math.min(3, v + 0.25))}
            >
              <ZoomIn size={16} />
            </button>
          </div>
          <div className="lt-final-actions">
            <button onClick={() => setHelp((v) => !v)} aria-label="观片快捷键">
              <Keyboard size={17} />
            </button>
            <button onClick={() => void finish(true)} disabled={!current}>
              <SlidersHorizontal size={16} />
              编辑此张
            </button>
          </div>
        </div>
        {!!photos.length && (
          <div className="lt-strip">
            {photos
              .slice(Math.max(0, index - 8), Math.min(photos.length, index + 9))
              .map((photo) => (
                <button
                  key={photo.id}
                  className={photo.id === shownId ? "active" : ""}
                  aria-label={`跳转观片 ${photo.name}`}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setMenu({
                      id: photo.id,
                      x: Math.max(
                        12,
                        Math.min(window.innerWidth - 240, e.clientX),
                      ),
                      y: Math.max(
                        12,
                        Math.min(window.innerHeight - 96, e.clientY),
                      ),
                    });
                  }}
                  onClick={() => {
                    setCurrentId(photo.id);
                    setPan({ x: 0, y: 0 });
                  }}
                >
                  <Picture
                    photo={photo}
                    revision={revisions[photo.id]}
                    size={220}
                  />
                  <i className={decision(photo)} />
                </button>
              ))}
          </div>
        )}
        <div className="lt-footnote">
          <span>
            {photos.filter((p) => decision(p) === "keep").length} 张精选 ·{" "}
            {photos.filter((p) => decision(p) === "reject").length} 张排除
          </span>
          <span>← → 翻片 · F 全屏 · I 沉浸 · 空格唤出工具 · Esc 返回</span>
        </div>
      </footer>
      {menu && (
        <div
          className="lt-thumb-menu"
          role="menu"
          aria-label="观片照片操作"
          style={{ left: menu.x, top: menu.y }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            role="menuitem"
            disabled={!onRemove}
            onClick={() => {
              const id = menu.id;
              setMenu(null);
              void enqueue(async () => {
                await callbacks.current.onRemove?.(id);
              });
            }}
          >
            <Trash2 size={15} />
            删除照片
          </button>
          <small>保留原文件，可撤销</small>
        </div>
      )}
      {help && (
        <div className="lt-help" role="note" aria-label="观片快捷键说明">
          <strong>把注意力留给照片</strong>
          <p>
            G 胶片接触表　E 单张　C 胶卷连排
            <br />L 背光开关　V 圆形放大镜　0 全台
            <br />P 精选　X 排除　U 待定
            <br />← / → 翻片　F 全屏　I 沉浸
            <br />
            Ctrl+Z 撤销　Ctrl+Shift+Z 重做
            <br />
            胶卷连排中拖动或滚轮左右滑动；Ctrl+滚轮缩放。
            <br />
            沉浸时移动鼠标或按空格唤出工具。
          </p>
          <button onClick={() => setHelp(false)}>知道了</button>
        </div>
      )}
      {error && (
        <div className="lt-error" role="alert">
          {error}
          <button aria-label="关闭观片错误" onClick={() => setError("")}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}
