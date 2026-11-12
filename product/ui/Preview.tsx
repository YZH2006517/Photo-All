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
  BROWSE_PREVIEW_SIZE,
  geometrySignature,
  Recipe,
  liveRecipeKey,
  isRaw,
  api,
  EditorPreviewSession,
  editorPreviewBlob,
} from "./model";
import { LivePreview } from "./LivePreview";

// Decode enough source pixels for the physical screen area; stop at the source
// rather than manufacturing detail when the requested footprint exceeds 4096.
export function sourceSize(pixels: number) {
  return [512, 1024, 2048, 4096].find((bucket) => bucket >= pixels) ?? 0;
}

export const Picture = memo(function Picture({
  photo,
  size = BROWSE_PREVIEW_SIZE,
  revision = 0,
  original = false,
  onLoaded,
  className = "",
  eager = false,
  quality = "preview",
  reusePreview = false,
  sourceScale,
  uncropped = false,
  editorSession,
  deferNative = false,
}: {
  photo: Photo;
  size?: number;
  revision?: number;
  original?: boolean;
  onLoaded?: (image: HTMLImageElement, recipe?: Recipe) => void;
  className?: string;
  eager?: boolean;
  quality?: "preview" | "source";
  reusePreview?: boolean;
  sourceScale?: number;
  uncropped?: boolean;
  editorSession?: EditorPreviewSession;
  deferNative?: boolean;
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
  // The editor POST carries the full live recipe. Its request, cache entry
  // and decoded-frame acknowledgement must all identify that same recipe.
  // Catalog-backed GET requests below still need the saved recipe.
  const requestedPhoto = editorSession ? { ...photo, committed_recipe: undefined } : {
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
  const [visible, setVisible] = useState(eager),
    [display, setDisplay] = useState<{
      photoId: number;
      asset: DecodedPreview;
      geometry: string;
      recipe: Recipe;
    } | null>(null),
    [loaded, setLoaded] = useState<{ url: string; geometry: string } | null>(
      null,
    ),
    [browseVersion, refreshBrowse] = useState(0),
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
  const cached = visible ? decodedPreviews.peek(family, requestedSize, requestedSize !== 0) : undefined;
  const previous = display?.photoId === photo.id ? display : null;
  const spectralEdit = !original && !!requestedPhoto.recipe.film_advanced;
  const cameraFallback = quality === "source" && isRaw(requestedPhoto);
  const browseQuality = cameraFallback ? "camera" : "preview";
  const canUseBrowse = ((reusePreview || cameraFallback) && quality === "source")
    || (spectralEdit && quality === "preview" && requestedSize <= 640);
  const browseFamily = photoPreviewFamily(requestedPhoto, original || spectralEdit, revision, browseQuality, uncropped);
  const previewFamily = photoPreviewFamily(requestedPhoto, original, revision, "preview", uncropped);
  const editedBrowse = visible && canUseBrowse && !cached && !previous
    ? decodedPreviews.peek(previewFamily, BROWSE_PREVIEW_SIZE)
    : undefined;
  const provisional = visible && canUseBrowse && !cached && !previous
    ? editedBrowse || (browseFamily !== previewFamily
        ? decodedPreviews.peek(browseFamily, BROWSE_PREVIEW_SIZE)
        : undefined)
    : undefined;
  const showingOriginalProxy = !!provisional && spectralEdit && !editedBrowse;
  const showingCamera = !!provisional && cameraFallback && !editedBrowse;
  const requestedGeometry = geometrySignature(
    uncropped
      ? { ...requestedPhoto.recipe, crop_x: 0, crop_y: 0, crop_w: 1, crop_h: 1 }
      : requestedPhoto.recipe,
  );
  const shown = visible ? cached || previous?.asset || provisional : undefined;
  const url = shown?.url || "";
  const shownGeometry = cached ? requestedGeometry : display?.geometry || "";
  const acknowledged = useRef<{ url: string; geometry: string } | null>(null);
  const acknowledge = (image: HTMLImageElement) => {
    if (
      frame.current?.querySelector("img") !== image ||
      (image.currentSrc || image.src) !== url ||
      !image.complete ||
      !image.naturalWidth ||
      provisional
    )
      return;
    if (
      acknowledged.current?.url === url &&
      acknowledged.current.geometry === shownGeometry
    )
      return;
    acknowledged.current = { url, geometry: shownGeometry };
    setLoaded({ url, geometry: shownGeometry });
    onLoaded?.(image, cached ? requestedPhoto.recipe : display?.recipe);
  };
  // A decoded cache hit can be complete as soon as React attaches the element.
  // Acknowledge it even when the native load event preceded our handler.
  useLayoutEffect(() => {
    const image = frame.current?.querySelector("img");
    if (image) acknowledge(image);
  }, [url, shownGeometry]);
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
  }, [shown, display?.asset, browseVersion]);
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
      (entries) => setVisible(entries[entries.length - 1].isIntersecting),
      { rootMargin: quality === "source" ? "80px" : "200px" },
    );
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, [eager, quality]);
  useEffect(() => {
    if (!visible || !canUseBrowse || cached || previous || editedBrowse) return;
    const controller = new AbortController();
    decodedPreviews.read(
      browseFamily,
      BROWSE_PREVIEW_SIZE,
      (signal) => photoBlob(requestedPhoto, BROWSE_PREVIEW_SIZE, original || spectralEdit,
        signal, revision, browseQuality, uncropped),
      controller.signal,
      nativeDimensions,
    ).then((asset) => {
      if (controller.signal.aborted) return;
      if (!held.current.has(asset)) {
        decodedPreviews.retain(asset);
        held.current.add(asset);
      }
      refreshBrowse((value) => value + 1);
    }).catch(() => { /* The main render reports any persistent image error. */ });
    return () => controller.abort();
  }, [visible, canUseBrowse, browseFamily, !!cached, !!previous, !!editedBrowse]);
  useEffect(() => {
    if (quality === "source" && sourceScale !== undefined && !sourcePixels)
      return;
    if (!visible) {
      setDisplay(null);
      return;
    }
    if (deferNative) return;
    const controller = new AbortController();
    setError("");
    const load = () => { decodedPreviews
      .read(
        family,
        requestedSize,
        (signal) =>
          editorSession ? editorPreviewBlob(requestedPhoto, editorSession, requestedSize, signal, uncropped) : photoBlob(
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
        setDisplay({
          photoId: photo.id,
          asset,
          geometry: requestedGeometry,
          recipe: { ...requestedPhoto.recipe },
        });
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setError(reason.message);
        }
      }); };
    // The small spectral worker responds first. Start full-resolution refinement
    // only after the gesture settles; never substitute its pixels into export.
    const delay = editorSession ? window.setTimeout(load, 1800) : undefined;
    if (!editorSession) load();
    return () => {
      clearTimeout(delay);
      controller.abort();
    };
  }, [visible, family, requestedSize, quality, sourcePixels > 0, editorSession?.generation, deferNative]);
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
            acknowledge(e.currentTarget);
          }}
        />
      )}
      {!url && visible && loading && (
        <LoaderCircle className="spin" size={20} />
      )}
      {url && ((loading && !reusePreview) || showingOriginalProxy || showingCamera) && (
        <span className={`picture-refresh${showingOriginalProxy || showingCamera ? " picture-refresh-labeled" : ""}`}>
          {loading && <LoaderCircle className="spin" size={12} />}
          {showingCamera ? <span>机内暂览</span> : showingOriginalProxy && <span>原图暂览</span>}
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

function SpectralPreview({photo, session, exact, uncropped, onDraftSettled}: {
  photo: Photo; session: EditorPreviewSession; exact: string; uncropped: boolean;
  onDraftSettled: (generation: number) => void;
}) {
  const [asset,setAsset]=useState<{url:string;geometry:string;key:string}|null>(null);
  const [busy,setBusy]=useState(true);
  const urlRef=useRef('');
  const key=liveRecipeKey(photo.recipe);
  const geometry=geometrySignature(uncropped ? {...photo.recipe,crop_x:0,crop_y:0,crop_w:1,crop_h:1} : photo.recipe);
  useEffect(()=>{
    if(key===exact){setBusy(false);return;}
    const controller=new AbortController();
    let refineTimer:ReturnType<typeof setTimeout>|undefined;
    setBusy(true);
    const show=async(blob:Blob)=>{
        if(controller.signal.aborted)return;
        const url=URL.createObjectURL(blob), image=new Image();image.src=url;
        try{await image.decode();}catch(error){URL.revokeObjectURL(url);throw error;}
        if(controller.signal.aborted){URL.revokeObjectURL(url);return;}
        const old=urlRef.current;urlRef.current=url;
        setAsset({url,geometry,key});setBusy(false);
        if(old)URL.revokeObjectURL(old);
    };
    const timer=window.setTimeout(()=>{
      void editorPreviewBlob(photo,session,640,controller.signal,uncropped).then(async blob=>{
        await show(blob);
        if (!controller.signal.aborted) onDraftSettled(session.generation);
        if(!controller.signal.aborted && Math.min(Number(photo.recipe.crop_w??1),Number(photo.recipe.crop_h??1))>=.5)refineTimer=setTimeout(()=>{
          // Fill a normal desktop viewport while the native pixel grid is being
          // refined. This job yields to any new gesture; the fast worker stays warm.
          void editorPreviewBlob(photo,session,1200,controller.signal,uncropped).then(show).catch(()=>{});
        },300);
      }).catch(()=>{if(!controller.signal.aborted){setBusy(false);onDraftSettled(session.generation);}});
    },100);
    return ()=>{clearTimeout(timer);clearTimeout(refineTimer);controller.abort();};
  },[key,session.id,session.generation,uncropped,exact,onDraftSettled]);
  useEffect(()=>()=>{if(urlRef.current)URL.revokeObjectURL(urlRef.current);},[]);
  const active=asset?.geometry===geometry && key!==exact;
  return <>
    {active && <img className="spectral-interactive-preview" src={asset.url} alt="光谱交互预览" draggable={false}
      data-preview-key={asset.key} data-rendered-geometry={asset.geometry} data-geometry-ready="true" />}
    {key!==exact && <span className="live-preview-note">{busy?'光谱预览更新中':'交互预览 · 原尺寸细化中'}</span>}
  </>;
}

export function Comparison({
  photo,
  revision = 0,
  active,
  onLoaded,
  uncropped = false,
  viewScale=1,
}: {
  photo: Photo;
  revision?: number;
  active: boolean;
  onLoaded: (image: HTMLImageElement) => void;
  uncropped?: boolean;
  viewScale?: number;
}) {
  const surface = useRef<HTMLDivElement>(null),
    frame = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 }),
    [position, setPosition] = useState(0.5),
    [readyOriginal, setReadyOriginal] = useState("");
  const [exact, setExact] = useState("");
  const [settledDraft, setSettledDraft] = useState(-1);
  const previewSession=useRef(crypto.randomUUID());
  const liveKey=liveRecipeKey(photo.recipe);
  const renderKey=JSON.stringify([liveKey,uncropped]);
  const generation=useRef({key:renderKey,value:0});
  if(generation.current.key!==renderKey)generation.current={key:renderKey,value:generation.current.value+1};
  const session={id:previewSession.current,generation:generation.current.value};
  const latestSession=useRef(session);latestSession.current=session;
  const hadSpectral=useRef(false);
  if(photo.recipe.film_advanced)hadSpectral.current=true;
  useEffect(()=>{
    if(hadSpectral.current)void api('/editor-preview',{id:photo.id,preview_session:session.id,
      generation:session.generation,cancel:true}).catch(()=>{});
  },[photo.id,renderKey]);
  useEffect(()=>()=>{
    void api('/editor-preview',{id:photo.id,preview_session:latestSession.current.id,
      generation:latestSession.current.generation+1,cancel:true}).catch(()=>{});
  },[photo.id]);
  const acknowledgedPhoto = {
    ...photo,
    recipe: photo.committed_recipe ?? photo.recipe,
  };
  const geometry = geometrySignature(acknowledgedPhoto.recipe);
  // A cached image can acknowledge in the child's layout effect on the same
  // commit as a geometry change. Match that acknowledgement to its geometry.
  const originalKey = `${photo.id}/${geometry}/${!!uncropped}`;
  const originalReady = readyOriginal === originalKey;
  const markOriginalReady = useCallback(
    (_image: HTMLImageElement, recipe?: Recipe) => {
      if (recipe && geometrySignature(recipe) === geometry) setReadyOriginal(originalKey);
    },
    [geometry, originalKey],
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
          size={0}
          eager
          reusePreview
          editorSession={photo.recipe.film_advanced ? session : undefined}
            deferNative={!!photo.recipe.film_advanced && exact !== liveKey && settledDraft !== session.generation}
          onLoaded={(image, recipe) => {
            setExact(
              liveRecipeKey(recipe ?? photo.committed_recipe ?? photo.recipe),
            );
            onLoaded(image);
          }}
          className="comparison-edited"
          quality="source"
          uncropped={uncropped}
        />
        {!photo.recipe.film_advanced && !photo.committed_recipe?.film_advanced &&
          <LivePreview photo={photo} exact={exact} uncropped={uncropped} sourceSize={0} viewScale={viewScale} />}
        {photo.recipe.film_advanced && <SpectralPreview photo={photo} session={session} exact={exact} uncropped={uncropped} onDraftSettled={setSettledDraft} />}
        {active && (
          <>
            <div
              className={`comparison-original ${originalReady ? "ready" : ""}`}
            >
              <Picture
                photo={photo}
                original
                revision={revision}
                size={0}
                eager
                onLoaded={markOriginalReady}
                quality="source"
                uncropped={uncropped}
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
