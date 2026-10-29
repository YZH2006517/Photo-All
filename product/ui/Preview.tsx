// SPDX-License-Identifier: GPL-3.0-or-later
import React, {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ChevronsLeftRight, LoaderCircle } from "lucide-react";
import {
  Photo,
  photoBlob,
  splitPosition,
  photoDimensions,
  photoPreviewFamily,
  decodedPreviews,
  DecodedPreview,
  geometrySignature,
} from "./model";

// Decode enough source pixels for the physical screen area; stop at the source
// rather than manufacturing detail when the requested footprint exceeds 4096.
export function sourceSize(pixels: number) {
  return [512, 1024, 2048, 4096].find((bucket) => bucket >= pixels) ?? 0;
}

export const Picture = memo(function Picture({
  photo,
  size = 480,
  revision = 0,
  original = false,
  onLoaded,
  className = "",
  eager = false,
  quality = "preview",
  sourceScale,
  uncropped = false,
}: {
  photo: Photo;
  size?: number;
  revision?: number;
  original?: boolean;
  onLoaded?: (image: HTMLImageElement) => void;
  className?: string;
  eager?: boolean;
  quality?: "preview" | "source";
  sourceScale?: number;
  uncropped?: boolean;
}) {
  const frame = useRef<HTMLDivElement>(null);
  // The GET renderer reads the catalog. Optimistic slider/crop values must not
  // be used as cache labels until their save acknowledgement advances revision.
  const committed = useRef({ id: photo.id, revision, recipe: photo.recipe });
  if (
    committed.current.id !== photo.id ||
    committed.current.revision !== revision
  )
    committed.current = { id: photo.id, revision, recipe: photo.recipe };
  const requestedPhoto = {
    ...photo,
    recipe: photo.committed_recipe ?? committed.current.recipe,
  };
  const nativeDimensions = photoDimensions(
    uncropped
      ? {
          ...requestedPhoto,
          recipe: {
            ...requestedPhoto.recipe,
            crop_x: 0,
            crop_y: 0,
            crop_w: 1,
            crop_h: 1,
          },
        }
      : requestedPhoto,
  );
  const family = photoPreviewFamily(
    requestedPhoto,
    original,
    revision,
    quality,
    uncropped,
  );
  const [visible, setVisible] = useState(
      eager || !!decodedPreviews.peek(family, size),
    ),
    [display, setDisplay] = useState<{
      photoId: number;
      asset: DecodedPreview;
      geometry: string;
    } | null>(null),
    [loaded, setLoaded] = useState<{ url: string; geometry: string } | null>(
      null,
    ),
    [error, setError] = useState("");
  const held = useRef(new Set<DecodedPreview>());
  const [sourcePixels, setSourcePixels] = useState(0);
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element || quality !== "source" || sourceScale === undefined) return;
    const measure = () =>
      setSourcePixels(
        Math.max(element.clientWidth, element.clientHeight) *
          sourceScale *
          window.devicePixelRatio,
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [quality, sourceScale]);
  const requestedSize =
    quality === "source" && sourceScale !== undefined
      ? sourceSize(sourcePixels)
      : size;
  const cached = decodedPreviews.peek(family, requestedSize);
  const requestedGeometry = geometrySignature(
    uncropped
      ? { ...requestedPhoto.recipe, crop_x: 0, crop_y: 0, crop_w: 1, crop_h: 1 }
      : requestedPhoto.recipe,
  );
  const shown =
    visible || quality !== "source"
      ? cached || (display?.photoId === photo.id ? display.asset : undefined)
      : undefined;
  const url = shown?.url || "";
  const shownGeometry = cached ? requestedGeometry : display?.geometry || "";
  const geometryReady =
    !!url && loaded?.url === url && loaded.geometry === requestedGeometry;
  const loading =
    visible &&
    !error &&
    !(
      quality === "source" &&
      sourceScale !== undefined &&
      !sourcePixels &&
      shown
    ) &&
    !decodedPreviews.sufficient(family, requestedSize);
  useLayoutEffect(() => {
    if (shown && !held.current.has(shown)) {
      decodedPreviews.retain(shown);
      held.current.add(shown);
    }
    for (const asset of [...held.current])
      if (asset !== shown) {
        decodedPreviews.release(asset);
        held.current.delete(asset);
      }
  }, [shown]);
  useEffect(
    () => () => {
      for (const asset of held.current) decodedPreviews.release(asset);
      held.current.clear();
    },
    [],
  );
  useEffect(() => {
    if (eager) {
      setVisible(true);
      return;
    }
    if (!frame.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const intersecting = entries.some((e) => e.isIntersecting);
        if (quality === "source") setVisible(intersecting);
        else if (intersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: quality === "source" ? "80px" : "200px" },
    );
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, [eager, quality]);
  useEffect(() => {
    if (quality === "source" && sourceScale !== undefined && !sourcePixels)
      return;
    if (!visible) {
      if (quality === "source") {
        setDisplay(null);
      }
      return;
    }
    const controller = new AbortController();
    setError("");
    decodedPreviews
      .read(
        family,
        requestedSize,
        (signal) =>
          photoBlob(
            requestedPhoto,
            requestedSize,
            original,
            signal,
            revision,
            quality,
            uncropped,
          ),
        controller.signal,
        nativeDimensions,
      )
      .then((asset) => {
        if (controller.signal.aborted) return;
        if (!held.current.has(asset)) {
          decodedPreviews.retain(asset);
          held.current.add(asset);
        }
        setDisplay({ photoId: photo.id, asset, geometry: requestedGeometry });
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setError(reason.message);
        }
      });
    return () => {
      controller.abort();
    };
  }, [visible, family, requestedSize, quality, sourcePixels > 0]);
  return (
    <div
      ref={frame}
      className={`picture ${loading ? "loading" : ""} ${className}`}
      data-quality={quality}
      data-source-size={quality === "source" ? requestedSize : undefined}
      data-geometry-ready={geometryReady ? "true" : "false"}
      data-rendered-geometry={loaded?.url === url ? loaded.geometry : undefined}
    >
      {url && (
        <img
          key={url}
          src={url}
          alt={photo.name}
          draggable={false}
          decoding="async"
          onLoad={(e) => {
            // A replaced <img> can still dispatch an old load event. Only the
            // currently selected, decoded URL may acknowledge screen geometry.
            if (
              frame.current?.querySelector("img") !== e.currentTarget ||
              e.currentTarget.currentSrc !== url ||
              !e.currentTarget.naturalWidth
            )
              return;
            setLoaded({ url, geometry: shownGeometry });
            onLoaded?.(e.currentTarget);
          }}
        />
      )}
      {!url && visible && loading && (
        <LoaderCircle className="spin" size={20} />
      )}
      {url && loading && (
        <span className="picture-refresh">
          <LoaderCircle className="spin" size={12} />
        </span>
      )}
      {error && (
        <span className="picture-error" title={error}>
          预览暂不可用
          <br />
          <small>{error.slice(0, 65)}</small>
        </span>
      )}
    </div>
  );
});

export function Comparison({
  photo,
  revision = 0,
  active,
  onLoaded,
  scale = 1,
  uncropped = false,
}: {
  photo: Photo;
  revision?: number;
  active: boolean;
  onLoaded: (image: HTMLImageElement) => void;
  scale?: number;
  uncropped?: boolean;
}) {
  const surface = useRef<HTMLDivElement>(null),
    frame = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 }),
    [position, setPosition] = useState(0.5),
    [originalReady, setOriginalReady] = useState(false);
  const markOriginalReady = useCallback(() => setOriginalReady(true), []);
  const acknowledgedPhoto = {
    ...photo,
    recipe: photo.committed_recipe ?? photo.recipe,
  };
  const geometry = geometrySignature(acknowledgedPhoto.recipe);
  useLayoutEffect(
    () => setOriginalReady(false),
    [photo.id, geometry, uncropped],
  );
  useLayoutEffect(() => {
    const element = surface.current!;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setBounds({
        width: element.clientWidth || rect.width,
        height: element.clientHeight || rect.height,
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const dimensions = photoDimensions(
      uncropped
        ? {
            ...acknowledgedPhoto,
            recipe: {
              ...acknowledgedPhoto.recipe,
              crop_x: 0,
              crop_y: 0,
              crop_w: 1,
              crop_h: 1,
            },
          }
        : acknowledgedPhoto,
    ),
    ratio = dimensions.width / dimensions.height;
  const width = Math.min(bounds.width, bounds.height * ratio),
    height = width / ratio;
  const move = (clientX: number) => {
    const rect = frame.current!.getBoundingClientRect();
    setPosition(splitPosition(clientX, rect.left, rect.width));
  };
  return (
    <div ref={surface} className="comparison-surface">
      <div
        ref={frame}
        className={`comparison-frame ${active ? "comparison-active" : ""}`}
        style={
          {
            width,
            height,
            "--split": `${position * 100}%`,
          } as React.CSSProperties
        }
      >
        <Picture
          photo={photo}
          revision={revision}
          size={1600}
          eager
          onLoaded={onLoaded}
          className="comparison-edited"
          quality="source"
          uncropped={uncropped}
          sourceScale={scale}
        />
        {active && (
          <>
            <div
              className={`comparison-original ${originalReady ? "ready" : ""}`}
            >
              <Picture
                photo={photo}
                original
                revision={revision}
                size={1600}
                eager
                onLoaded={markOriginalReady}
                quality="source"
                uncropped={uncropped}
                sourceScale={scale}
              />
            </div>
            <span className="comparison-label before">
              {originalReady ? "原图" : "原图加载中…"}
            </span>
            <span className="comparison-label after">调整后</span>
            <button
              className="comparison-divider"
              role="slider"
              aria-label="原图对比分割线"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(position * 100)}
              aria-valuetext={`左侧原图 ${Math.round(position * 100)}%，右侧调整后`}
              aria-orientation="horizontal"
              onPointerDown={(e) => {
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                move(e.clientX);
              }}
              onPointerMove={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId))
                  move(e.clientX);
              }}
              onPointerUp={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId))
                  e.currentTarget.releasePointerCapture(e.pointerId);
              }}
              onDoubleClick={() => setPosition(0.5)}
              onKeyDown={(e) => {
                if (
                  ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)
                ) {
                  e.preventDefault();
                  e.stopPropagation();
                  setPosition((p) =>
                    e.key === "Home"
                      ? 0
                      : e.key === "End"
                        ? 1
                        : Math.max(
                            0,
                            Math.min(
                              1,
                              p + (e.key === "ArrowLeft" ? -0.02 : 0.02),
                            ),
                          ),
                  );
                }
              }}
            >
              <span>
                <ChevronsLeftRight size={19} />
              </span>
            </button>
          </>
        )}
      </div>
    </div>
  );
}
