// SPDX-License-Identifier: GPL-3.0-or-later
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import {
  Aperture,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FolderPlus,
  Grid2X2,
  Heart,
  ImagePlus,
  Images,
  LoaderCircle,
  Maximize2,
  Plus,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Undo2,
  Redo2,
  X,
  ZoomIn,
  ZoomOut,
  PanelRightClose,
  PanelRightOpen,
  CheckCheck,
  Layers,
  Film,
  Trash2,
  PanelLeftOpen,
  PanelLeftClose,
} from "lucide-react";
import {
  api,
  Photo,
  Recipe,
  Library,
  Job,
  selectPhotos,
  exportIds,
  recommendIds,
  isRaw,
  dateLabel,
  styleLabel,
  pickFiles,
  pickFolder,
  persistRecipes,
  guardDesktopClose,
  Album,
  Facets,
  CompositeDocument,
  classifyPhotos,
  mergeLibraryRecipes,
  reviewPhotos,
  albumSelectionPhotos,
  VariantMode,
  applyVariantPreference,
  expandVariantScope,
} from "./model";
import { Albums, Classification } from "./Albums";
import { Composite } from "./Composite";
import { Picture } from "./Preview";
import { EditorWorkspace } from "./Editor";
import { Lighttable } from "./Lighttable";
import "./style.css";

const spring = { type: "spring" as const, stiffness: 330, damping: 32 };
const EMPTY: Library = {
  photos: [],
  albums: [],
  composites: [],
  film: {
    engine: "",
    mode: "",
    revision: "",
    attribution: "",
    source: "",
    stocks: {},
  },
  history: { undo: 0, redo: 0 },
  recognition: { ready: false, model: "", labels: {} },
  capabilities: { raw: false, raw_backend: null, heic: false },
  defaults: {},
  styles: {},
  templates: {},
};

function Studio() {
  const [library, setLibrary] = useState<Library>(EMPTY),
    libraryRef = useRef(EMPTY);
  const [connected, setConnected] = useState(false),
    [error, setError] = useState("");
  const [mode, setMode] = useState<
    "albums" | "trash" | "library" | "editor" | "composite" | "lighttable"
  >("albums");
  const [reviewScope, setReviewScope] = useState<{
    ids: number[];
    initialId?: number;
    compare: boolean;
    back: "albums" | "library" | "editor";
    albums?: number[] | null;
  }>({ ids: [], compare: false, back: "library" });
  const lighttableSave = useRef<null | (() => Promise<void>)>(null);
  const [reviewPicker, setReviewPicker] = useState(false),
    [reviewAlbums, setReviewAlbums] = useState<number[]>([]);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    ids: number[];
  } | null>(null);
  const [albumId, setAlbumId] = useState<number | null>(null),
    [facets, setFacets] = useState<Facets>({});
  const [drawerOpen, setDrawerOpen] = useState(false);
  const sidebar = useRef<HTMLElement>(null);
  const drawerOpenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drawerCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drawerPointerInside = useRef(false);
  const drawerHoverSuppressed = useRef(false);
  const clearDrawerTimers = useCallback(() => {
    if (drawerOpenTimer.current) clearTimeout(drawerOpenTimer.current);
    if (drawerCloseTimer.current) clearTimeout(drawerCloseTimer.current);
    drawerOpenTimer.current = null;
    drawerCloseTimer.current = null;
  }, []);
  const closeDrawer = useCallback(() => {
    clearDrawerTimers();
    drawerHoverSuppressed.current = true;
    setDrawerOpen(false);
  }, [clearDrawerTimers]);
  const scheduleDrawerClose = useCallback(() => {
    clearDrawerTimers();
    drawerCloseTimer.current = setTimeout(() => {
      drawerCloseTimer.current = null;
      if (
        !drawerPointerInside.current &&
        !sidebar.current?.contains(document.activeElement)
      )
        setDrawerOpen(false);
    }, 350);
  }, [clearDrawerTimers]);
  useEffect(() => clearDrawerTimers, [clearDrawerTimers]);
  const [folderMode, setFolderMode] = useState("single");
  const [variantMode, setVariantMode] = useState<VariantMode>(() => {
    try {
      const saved = localStorage.getItem("photoall-variant-mode");
      return saved === "raw" || saved === "jpeg" ? saved : "all";
    } catch {
      return "all";
    }
  });
  const changeVariantMode = (next: VariantMode) => {
    setVariantMode(next);
    setSelected([]);
    setLimit(48);
    try {
      localStorage.setItem("photoall-variant-mode", next);
    } catch {
      /* A storage limit must not block viewing. */
    }
  };
  const [composite, setComposite] = useState<CompositeDocument | null>(null),
    [batchStyle, setBatchStyle] = useState("film");
  const compositeSave = useRef<null | (() => Promise<void>)>(null);
  const [selected, setSelected] = useState<number[]>([]),
    [currentId, setCurrentId] = useState<number | null>(null);
  const [group, setGroup] = useState("all"),
    [filter, setFilter] = useState("all"),
    [search, setSearch] = useState(""),
    [sort, setSort] = useState("time");
  const [revisions, setRevisions] = useState<Record<number, number>>({}),
    [toast, setToast] = useState(""),
    [job, setJob] = useState<Job | null>(null);
  const [jobAction, setJobAction] = useState("");
  const [saving, setSaving] = useState(false);
  const [exportOpen, setExportOpen] = useState(false),
    [template, setTemplate] = useState("plain"),
    [exportSize, setExportSize] = useState(0),
    [format, setFormat] = useState("png");
  const [importMenu, setImportMenu] = useState(false),
    [limit, setLimit] = useState(48);
  const pending = useRef(new Map<number, Recipe>()),
    saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const editVersions = useRef(new Map<number, number>()),
    reloadVersion = useRef(0);
  const flushing = useRef<Promise<void> | null>(null),
    mounted = useRef(true);
  const notify = useCallback((message: string) => setToast(message), []);
  const jobRef = useRef(job);
  jobRef.current = job;
  const install = (data: Library) => {
    libraryRef.current = data;
    setLibrary(data);
  };

  const flush = useCallback(async function savePending(): Promise<void> {
    clearTimeout(saveTimer.current);
    if (flushing.current) {
      await flushing.current;
      return savePending();
    }
    if (!pending.current.size) return;
    const edits = new Map(pending.current);
    pending.current.clear();
    setSaving(true);
    const task = persistRecipes(edits, pending.current, async (id, recipe) => {
      const saved = await api<{
        history: Library["history"];
        recipes?: Record<string, Recipe>;
      }>("/edit", {
        ids: [id],
        recipe,
      });
      const committed = saved.recipes?.[String(id)] ?? recipe;
      install({
        ...libraryRef.current,
        history: saved.history,
        photos: libraryRef.current.photos.map((photo) =>
          photo.id === id
            ? { ...photo, committed_recipe: { ...committed } }
            : photo,
        ),
      });
      setRevisions((r) => ({ ...r, [id]: (r[id] || 0) + 1 }));
    });
    flushing.current = task;
    try {
      await task;
    } finally {
      flushing.current = null;
      if (mounted.current) setSaving(false);
    }
    if (pending.current.size) return savePending();
  }, []);
  const reload = useCallback(async () => {
    await flush();
    const editsAtRequest = new Map(editVersions.current),
      request = ++reloadVersion.current;
    const data = await api<Library>("/library");
    if (request !== reloadVersion.current) return;
    data.photos = data.photos.map((photo) => ({
      ...photo,
      committed_recipe: { ...photo.recipe },
    }));
    install(
      mergeLibraryRecipes(
        data,
        libraryRef.current,
        editsAtRequest,
        editVersions.current,
      ),
    );
    setConnected(true);
    setError("");
  }, [flush]);
  const act = useCallback(
    async (action: () => Promise<void>) => {
      try {
        await action();
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error));
      }
    },
    [notify],
  );

  useEffect(() => {
    mounted.current = true;
    reload().catch((error) => setError(error.message));
    return () => {
      mounted.current = false;
      clearTimeout(saveTimer.current);
    };
  }, [reload]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 6500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (pending.current.size || flushing.current) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    guardDesktopClose(async () => {
      if (jobRef.current?.status === "running")
        throw new Error("正在处理照片，请等待导入或导出完成后关闭。");
      await flush();
      await compositeSave.current?.();
      await lighttableSave.current?.();
    }, notify)
      .then((cleanup) => {
        if (disposed) cleanup();
        else unlisten = cleanup;
      })
      .catch((reason) => notify(String(reason)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [flush, notify]);

  const albumPhotos = useMemo(
    () =>
      applyVariantPreference(
        library.photos.filter(
          (p) => albumId === null || p.album_ids.includes(albumId),
        ),
        variantMode,
      ),
    [library.photos, albumId, variantMode],
  );
  const scopePhotos = useMemo(
    () => selectPhotos(albumPhotos, group, filter, search, sort),
    [albumPhotos, group, filter, search, sort],
  );
  const photos = useMemo(
    () => classifyPhotos(scopePhotos, null, facets),
    [scopePhotos, facets],
  );
  const activeAlbum = library.albums.find((a) => a.id === albumId);
  const current = library.photos.find((p) => p.id === currentId) || null;
  const exportScope =
    mode === "editor" && current
      ? [current]
      : photos.filter((p) => selected.includes(p.id));
  const exportSelection = exportIds(exportScope, format);
  const visibleLibraryPhotos = useMemo(
    () => applyVariantPreference(library.photos, variantMode),
    [library.photos, variantMode],
  );
  const visibleAlbumCounts = useMemo(
    () =>
      new Map(
        library.albums.map((album) => [
          album.id,
          applyVariantPreference(
            library.photos.filter((photo) =>
              photo.album_ids.includes(album.id),
            ),
            variantMode,
          ).length,
        ]),
      ),
    [library.albums, library.photos, variantMode],
  );
  const kept = visibleLibraryPhotos.filter((p) => p.decision === "keep").length;
  const busy = job?.status === "running";
  const updateRecipe = (patch: Recipe) => {
    if (!current || busy) return;
    const photo = libraryRef.current.photos.find((p) => p.id === current.id)!;
    const recipe = { ...photo.recipe, ...patch };
    if (JSON.stringify(recipe) === JSON.stringify(photo.recipe)) return;
    editVersions.current.set(
      photo.id,
      (editVersions.current.get(photo.id) || 0) + 1,
    );
    install({
      ...libraryRef.current,
      photos: libraryRef.current.photos.map((p) =>
        p.id === photo.id ? { ...p, recipe } : p,
      ),
    });
    pending.current.set(photo.id, recipe);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => act(flush), 350);
  };
  const startJob = async (route: string, body: unknown) => {
    await flush();
    const result = await api<{ id: string }>(route, body);
    setJobAction(route);
    setJob({
      id: result.id,
      status: "running",
      done: 0,
      total: 0,
      cancellable: route === "/export" || route === "/import",
      cancel_requested: false,
    });
  };
  useEffect(() => {
    if (!job || job.status !== "running") return;
    let disposed = false;
    const timer = setInterval(
      () =>
        api<Job>("/jobs/" + job.id)
          .then(async (result) => {
            if (disposed) return;
            setJob(result);
            if (result.status === "done") {
              await reload();
              const details = result.result;
              if (details?.errors.length)
                notify(
                  `处理结束，${details.errors.length} 项失败：${details.errors[0].error}`,
                );
              else
                notify(
                  details?.analyzed !== undefined
                    ? `已分析 ${details.analyzed} 张照片`
                    : details?.outputs
                      ? `${details.outputs.length} 张作品已导出`
                      : `已导入 ${details?.imported || 0} 张照片`,
                );
            } else if (result.status === "error")
              notify(result.error || "处理失败");
            else if (result.status === "cancelled") {
              await reload();
              notify(
                jobAction === "/import"
                  ? `导入已终止，已新增 ${result.result?.imported || 0} 张；已完成导入的记录已保留。`
                  : `导出已终止，已完成 ${result.result?.outputs?.length || 0} 张；已完成文件保留。`,
              );
            }
          })
          .catch((error) => {
            if (!disposed) {
              setJob(null);
              notify(error.message);
            }
          }),
      500,
    );
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [job?.id, job?.status, jobAction, reload, notify]);
  const importPhotos = () =>
    act(async () => {
      setImportMenu(false);
      const paths = await pickFiles();
      if (paths.length) await startJob("/import", { paths, album_id: albumId });
    });
  const importFolder = () =>
    act(async () => {
      setImportMenu(false);
      const folder = await pickFolder();
      if (folder) await startJob("/import", { folder, album_id: albumId });
    });
  const decide = (ids: number[], decision: string) =>
    act(async () => {
      await flush();
      await api("/edit", { ids, decision });
      await reload();
    });
  const historyAction = async (direction: "undo" | "redo") => {
    await flush();
    const before = new Map(
      libraryRef.current.photos.map((p) => [p.id, JSON.stringify(p.recipe)]),
    );
    const result = await api<{ changed: boolean }>(`/${direction}`, {});
    await reload();
    if (result.changed)
      setRevisions((r) => ({
        ...r,
        ...Object.fromEntries(
          libraryRef.current.photos
            .filter((p) => before.get(p.id) !== JSON.stringify(p.recipe))
            .map((p) => [p.id, (r[p.id] || 0) + 1]),
        ),
      }));
    notify(
      result.changed
        ? direction === "undo"
          ? "已撤销上次修改"
          : "已重做上次修改"
        : direction === "undo"
          ? "没有可撤销的修改"
          : "没有可重做的修改",
    );
  };
  const undo = () => act(() => historyAction("undo"));
  const redo = () => act(() => historyAction("redo"));
  const openPhoto = (photo: Photo) => {
    setCurrentId(photo.id);
    setSelected([photo.id]);
    setMode("editor");
  };
  const openLighttable = () =>
    act(async () => {
      await flush();
      const home = mode === "albums";
      if (home) {
        setReviewPicker(true);
        return;
      }
      const chosen = home ? [] : photos.filter((p) => selected.includes(p.id));
      const scope = home
        ? selectPhotos(libraryRef.current.photos, "all", "all", "", "time")
        : chosen.length > 1
          ? chosen
          : photos;
      if (!scope.length) return;
      setReviewScope({
        ids: expandVariantScope(
          libraryRef.current.photos,
          scope.map((p) => p.id),
        ).map((p) => p.id),
        initialId: mode === "editor" ? current?.id : undefined,
        compare: chosen.length > 1,
        back: home ? "albums" : mode === "editor" ? "editor" : "library",
        albums: albumId === null ? null : [albumId],
      });
      if (home) {
        setAlbumId(null);
        setGroup("all");
        setFilter("all");
        setSearch("");
        setFacets({});
        setSelected([]);
      }
      setImportMenu(false);
      setExportOpen(false);
      setMode("lighttable");
    });
  const beginAlbumReview = () =>
    act(async () => {
      await flush();
      const scope = albumSelectionPhotos(
        selectPhotos(libraryRef.current.photos, "all", "all", "", "time"),
        reviewAlbums,
      );
      if (!scope.length) return;
      setReviewScope({
        ids: scope.map((p) => p.id),
        compare: false,
        back: "albums",
        albums: [...reviewAlbums],
      });
      setAlbumId(null);
      setGroup("all");
      setFilter("all");
      setSearch("");
      setFacets({});
      setSelected([]);
      setReviewPicker(false);
      setMode("lighttable");
    });
  const removeContextPhotos = () =>
    act(async () => {
      if (!contextMenu) return;
      const ids = contextMenu.ids;
      setContextMenu(null);
      await flush();
      await api("/remove", { ids, album_id: albumId });
      await reload();
      setSelected((old) => old.filter((id) => !ids.includes(id)));
      notify(`已移除 ${ids.length} 张照片，可撤销；原文件保留`);
    });
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!(event.target as HTMLElement).closest(".photo-context-menu"))
        setContextMenu(null);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
        setReviewPicker(false);
      }
    };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", key);
    };
  }, []);
  const select = (photo: Photo, event: React.MouseEvent) =>
    setSelected((old) =>
      event.ctrlKey || event.metaKey
        ? old.includes(photo.id)
          ? old.filter((id) => id !== photo.id)
          : [...old, photo.id]
        : [photo.id],
    );
  const changeScope = (scope: string, decision = "all") => {
    if (mode === "composite") {
      act(async () => {
        await compositeSave.current?.();
        setMode("library");
        setAlbumId(null);
        setGroup(scope);
        setFilter(decision);
        setFacets({});
        setSelected([]);
      });
      return;
    }
    setAlbumId(null);
    setFacets({});
    setGroup(scope);
    setFilter(decision);
    setSelected([]);
    setLimit(48);
    setMode("library");
  };
  const showAlbums = () =>
    act(async () => {
      await flush();
      await compositeSave.current?.();
      setMode("albums");
      setSelected([]);
      setImportMenu(false);
    });
  const openAlbum = (album: Album) =>
    act(async () => {
      await flush();
      await compositeSave.current?.();
      setAlbumId(album.id);
      setFacets({});
      setGroup("all");
      setFilter("all");
      setSearch("");
      setSelected([]);
      setLimit(48);
      setMode("library");
    });
  const createAlbum = async (name: string) => {
    const album = await api<Album>("/albums", { name });
    await reload();
    setAlbumId(album.id);
    setFacets({});
    setGroup("all");
    setFilter("all");
    setSearch("");
    setSelected([]);
    setMode("library");
  };
  const trashAlbum = (album: Album) =>
    act(async () => {
      await flush();
      await api(`/albums/${album.id}/trash`, {});
      await reload();
      setSelected([]);
      notify(`“${album.name}”已移入回收站，30 天内可恢复。`);
    });
  const restoreAlbum = (album: Album) =>
    act(async () => {
      await api(`/albums/${album.id}/restore`, {});
      await reload();
      notify(`已恢复图集“${album.name}”`);
    });
  const showTrash = () =>
    act(async () => {
      await flush();
      await compositeSave.current?.();
      setMode("trash");
      closeDrawer();
      setSelected([]);
    });
  const beginComposite = (existing?: CompositeDocument) =>
    act(async () => {
      await flush();
      const candidates = photos.filter((p) => selected.includes(p.id));
      if (!existing && !candidates.length) {
        notify("请先选择需要合成的照片");
        return;
      }
      if (!existing && candidates.length > 24) {
        notify("第一版合成最多支持 24 个图层，请减少选片数量");
        return;
      }
      const first = candidates[0],
        width = 2400,
        height = first
          ? Math.max(
              16,
              Math.min(3200, Math.round((width * first.height) / first.width)),
            )
          : 1600;
      setComposite(
        existing || {
          name: (activeAlbum?.name || "照片") + " · 合成",
          album_id: albumId ?? undefined,
          width,
          height,
          layers: candidates.map((p) => ({
            photo_id: p.id,
            visible: true,
            opacity: 1,
            blend: "normal",
            x: 0,
            y: 0,
            scale: 1,
            rotation: 0,
            recipe: { ...p.recipe },
          })),
        },
      );
      setMode("composite");
    });
  const applyBatch = () =>
    act(async () => {
      const ids = photos
        .filter((p) => selected.includes(p.id))
        .map((p) => p.id);
      if (!ids.length) return;
      await flush();
      const filmId = batchStyle.startsWith("film:")
        ? batchStyle.slice(5)
        : null;
      await api("/edit", {
        ids,
        recipe_patch: filmId
          ? {
              style: "natural",
              film_stock: filmId,
              film_strength: 1,
              film_grain: 0,
              film_halation: 0,
            }
          : { style: batchStyle, film_stock: "none" },
      });
      await reload();
      setRevisions((r) => ({
        ...r,
        ...Object.fromEntries(ids.map((id) => [id, (r[id] || 0) + 1])),
      }));
      notify(
        `已给 ${ids.length} 张照片应用${filmId ? library.film.stocks[filmId].label : styleLabel[batchStyle]}`,
      );
    });
  const recommend = () => {
    const ids = recommendIds(photos);
    if (ids.length) decide(ids, "keep");
    else notify("当前范围没有待选的非重复照片");
  };
  const applyGroup = () =>
    act(async () => {
      if (!current) return;
      await flush();
      const ids = photos.map((p) => p.id);
      await api("/edit", { ids, recipe: current.recipe });
      await reload();
      setRevisions((r) => ({
        ...r,
        ...Object.fromEntries(ids.map((id) => [id, (r[id] || 0) + 1])),
      }));
      notify(`配方已同步至本组 ${ids.length} 张；可逐张微调`);
    });
  const exportPhotos = () =>
    act(async () => {
      const ids = [...exportSelection];
      if (!ids.length) {
        notify("请先勾选要导出的照片；RAW 母版仅支持 RAW 原片。");
        return;
      }
      await flush();
      const folder = await pickFolder();
      if (!folder) return;
      await startJob("/export", {
        ids,
        folder,
        template,
        size: exportSize,
        format,
        folder_mode: folderMode,
        ...(albumId !== null ? { album_ids: [albumId] } : {}),
      });
      setExportOpen(false);
    });
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && drawerOpen) {
        closeDrawer();
        return;
      }
      if (reviewPicker || contextMenu) {
        if (event.key === "Escape") {
          event.preventDefault();
          setReviewPicker(false);
          setContextMenu(null);
        }
        return;
      }
      if (mode === "composite" || mode === "lighttable" || mode === "editor")
        return;
      if (event.defaultPrevented) return;
      if (
        (event.target as HTMLElement).matches(
          'input:not([type="range"]),select,textarea',
        )
      )
        return;
      if (event.key === "Escape") {
        setExportOpen(false);
        setMode("library");
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
      }
      if (
        (event.target as HTMLElement).matches(
          'input,select,textarea,[role="slider"]',
        )
      )
        return;
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  return (
    <MotionConfig
      reducedMotion="user"
      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
    >
      {reviewPicker && (
        <div className="modal-backdrop" onClick={() => setReviewPicker(false)}>
          <section
            className="review-album-picker"
            role="dialog"
            aria-modal="true"
            aria-label="选择观片图集"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="review-picker-title">
              <Film size={26} />
              <div>
                <h2>选择要展示的图集</h2>
                <p>只展示勾选的照片，同一原片不会重复出现。</p>
              </div>
              <button
                aria-label="关闭图集选择"
                onClick={() => setReviewPicker(false)}
              >
                <X size={18} />
              </button>
            </div>
            <div className="review-album-options">
              {library.albums.map((album) => (
                <label key={album.id}>
                  <input
                    type="checkbox"
                    aria-label={album.name}
                    checked={reviewAlbums.includes(album.id)}
                    disabled={!album.count}
                    onChange={(e) =>
                      setReviewAlbums((old) =>
                        e.target.checked
                          ? [...old, album.id]
                          : old.filter((id) => id !== album.id),
                      )
                    }
                  />
                  <Images size={20} />
                  <span>
                    {album.name}
                    <small>{album.count} 张照片</small>
                  </span>
                </label>
              ))}
            </div>
            <div className="review-picker-footer">
              <span>
                已选择{" "}
                {albumSelectionPhotos(library.photos, reviewAlbums).length}{" "}
                张照片
              </span>
              <button
                className="button primary"
                disabled={
                  !albumSelectionPhotos(library.photos, reviewAlbums).length
                }
                onClick={beginAlbumReview}
              >
                开始观片
                <ArrowRight size={15} />
              </button>
            </div>
          </section>
        </div>
      )}
      {contextMenu && (
        <div
          className="photo-context-menu"
          role="menu"
          style={{ position: "fixed", left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            role="menuitem"
            disabled={!!busy}
            onClick={removeContextPhotos}
          >
            <X size={15} />
            {albumId === null ? "从图库移除" : "从图集中移除"}
          </button>
          <small>保留磁盘原文件 · 可以撤销</small>
        </div>
      )}
      {mode === "lighttable" && (
        <Lighttable
          photos={reviewPhotos(library.photos, reviewScope.ids).filter(
            (p) =>
              !reviewScope.albums?.length ||
              p.album_ids.some((a) => reviewScope.albums!.includes(a)),
          )}
          initialId={reviewScope.initialId}
          startCompare={reviewScope.compare}
          revisions={revisions}
          filmNames={Object.fromEntries(
            Object.entries(library.film.stocks).map(([id, stock]) => [
              id,
              stock.label,
            ]),
          )}
          history={library.history}
          saveRef={lighttableSave}
          onDecision={async (id, decision) => {
            await api("/edit", { ids: [id], decision });
            await reload();
          }}
          onUndo={() => historyAction("undo")}
          onRedo={() => historyAction("redo")}
          onEdit={openPhoto}
          variantMode={variantMode}
          onVariantMode={changeVariantMode}
          onRemove={async (id) => {
            await flush();
            await api("/remove", {
              ids: [id],
              ...(reviewScope.albums?.length
                ? { album_ids: reviewScope.albums }
                : {}),
            });
            await reload();
            setSelected((old) => old.filter((p) => p !== id));
          }}
          onExit={() =>
            setMode(
              reviewScope.back === "editor" &&
                !photos.some((p) => p.id === currentId)
                ? "library"
                : reviewScope.back,
            )
          }
        />
      )}
      <div
        className={`app-shell ${drawerOpen ? "drawer-open" : "drawer-closed"}`}
        inert={mode === "lighttable" || reviewPicker}
        aria-hidden={mode === "lighttable" || reviewPicker ? true : undefined}
      >
        <button
          className="sidebar-scrim"
          aria-label="关闭导航抽屉"
          aria-hidden={!drawerOpen}
          tabIndex={drawerOpen ? 0 : -1}
          onClick={closeDrawer}
        />
        <aside
          ref={sidebar}
          className={`sidebar ${drawerOpen ? "is-open" : "is-closed"}`}
          onPointerEnter={(e) => {
            if (e.pointerType !== "mouse") return;
            drawerPointerInside.current = true;
            clearDrawerTimers();
            if (drawerHoverSuppressed.current) return;
            drawerOpenTimer.current = setTimeout(() => {
              drawerOpenTimer.current = null;
              if (drawerPointerInside.current) setDrawerOpen(true);
            }, 120);
          }}
          onPointerLeave={(e) => {
            if (e.pointerType !== "mouse") return;
            drawerPointerInside.current = false;
            drawerHoverSuppressed.current = false;
            scheduleDrawerClose();
          }}
          onFocusCapture={(e) => {
            clearDrawerTimers();
            if ((e.target as HTMLElement).matches(":focus-visible")) {
              drawerHoverSuppressed.current = false;
              setDrawerOpen(true);
            }
          }}
          onBlurCapture={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node | null))
              return;
            if (!drawerPointerInside.current) {
              drawerHoverSuppressed.current = false;
              scheduleDrawerClose();
            }
          }}
          onClick={(e) => {
            if (
              (e.target as HTMLElement).closest(
                ".nav-item,.album-nav-item,.album-list .album,.brand,.workspace-switch",
              )
            )
              closeDrawer();
          }}
        >
          <button
            className="drawer-toggle"
            aria-label={drawerOpen ? "收起导航" : "展开导航"}
            aria-expanded={drawerOpen}
            onClick={() => {
              clearDrawerTimers();
              drawerHoverSuppressed.current = true;
              setDrawerOpen((v) => !v);
            }}
          >
            {drawerOpen ? (
              <PanelLeftClose size={20} />
            ) : (
              <PanelLeftOpen size={20} />
            )}
          </button>
          <a
            className="brand"
            href="#"
            onClick={(event) => {
              event.preventDefault();
              showAlbums();
            }}
          >
            <span className="brand-icon">
              <Aperture size={24} strokeWidth={1.6} />
            </span>
            <span>
              Photo All<small>YOUR MOMENTS, REFINED.</small>
            </span>
          </a>
          <button className="workspace-switch" onClick={showAlbums}>
            <span className="workspace-avatar">P</span>
            <span>
              我的工作空间<small>本地照片库</small>
            </span>
            <ChevronDown size={14} />
          </button>
          <div className="nav-label">照片库</div>
          <button
            title="图集"
            className={`nav-item ${mode === "albums" ? "active" : ""}`}
            onClick={showAlbums}
          >
            <Images size={18} />
            <span>图集</span>
            <b>{library.albums.length}</b>
          </button>
          {[
            ["all", "全部照片", Images, visibleLibraryPhotos.length],
            ["keep", "精选作品", Heart, kept],
            [
              "duplicates",
              "重复照片",
              Copy,
              visibleLibraryPhotos.filter((p) => p.duplicate_of).length,
            ],
          ].map(([id, label, Icon, count]) => {
            const I = Icon as typeof Images;
            return (
              <button
                key={String(id)}
                title={String(label)}
                className={`nav-item ${mode === "library" && albumId === null && group === "all" && filter === id ? "active" : ""}`}
                onClick={() => changeScope("all", String(id))}
              >
                <I size={18} />
                <span>{String(label)}</span>
                <b>{String(count)}</b>
              </button>
            );
          })}
          <button
            className={`nav-item ${mode === "trash" ? "active" : ""}`}
            title="回收站"
            aria-label="打开回收站"
            onClick={showTrash}
          >
            <Trash2 size={18} />
            <span>回收站</span>
            <b>{library.trash_albums?.length || 0}</b>
          </button>
          <div className="nav-label album-label">
            我的图集 <span>{library.albums.length}</span>
          </div>
          <div className="album-list">
            {library.albums.length ? (
              library.albums.map((album) => (
                <button
                  key={album.id}
                  className={`album ${mode !== "albums" && albumId === album.id ? "active" : ""}`}
                  onClick={() => openAlbum(album)}
                >
                  <span className="album-mark">
                    <Images size={16} />
                  </span>
                  <span>
                    {album.name}
                    <small>
                      {visibleAlbumCounts.get(album.id) ?? album.count} 张照片
                    </small>
                  </span>
                  <ChevronRight size={13} />
                </button>
              ))
            ) : (
              <p className="sidebar-empty">
                新建图集后，导入文件夹
                <br />
                按颜色和内容整理。
              </p>
            )}
          </div>
          <div className="local-note">
            <ShieldCheck size={18} />
            <div>
              美好，留在你的设备里<small>本地处理 · 原图保持只读</small>
            </div>
          </div>
          <div className="sidebar-bottom">
            <span className="online-dot" /> 本地引擎
            {library.capabilities.raw ? "已就绪" : "待连接"}
            <span className="version">0.9.1</span>
          </div>
        </aside>

        <main className={`main ${mode === "editor" ? "editor-mode" : ""}`}>
          {mode !== "editor" && (
            <header className="topbar">
              <div className="breadcrumb">
                工作空间 <ChevronRight size={12} />
                <button onClick={showAlbums} aria-label="返回全部图集">
                  图集
                </button>
                {mode !== "albums" && mode !== "trash" && (
                  <>
                    <ChevronRight size={12} />
                    <strong>
                      {mode === "composite"
                        ? "多图层合成"
                        : activeAlbum?.name || "全部照片"}
                    </strong>
                  </>
                )}
              </div>
              <div className="top-actions">
                <span className="save-state">
                  {saving ? (
                    <LoaderCircle size={13} className="spin" />
                  ) : (
                    <Check size={13} />
                  )}{" "}
                  {saving ? "正在保存" : "本地保存"}
                </span>
                <button
                  className="history-button"
                  title="撤销上次修改"
                  aria-label="撤销上次修改"
                  onClick={undo}
                  disabled={
                    !connected ||
                    !!busy ||
                    mode === "composite" ||
                    (!library.history.undo && !pending.current.size && !saving)
                  }
                >
                  <Undo2 size={17} />
                  撤销
                </button>
                <button
                  className="history-button"
                  title="重做上次修改 · Ctrl+Shift+Z / Ctrl+Y"
                  aria-label="重做上次修改"
                  onClick={redo}
                  disabled={
                    !connected ||
                    !!busy ||
                    mode === "composite" ||
                    !library.history.redo ||
                    !!pending.current.size ||
                    saving
                  }
                >
                  <Redo2 size={17} />
                  重做
                </button>
                <span className="top-divider" />
                <div className="import-wrap">
                  <button
                    className="button secondary"
                    onClick={() => setImportMenu(!importMenu)}
                    disabled={
                      !connected ||
                      !!busy ||
                      albumId === null ||
                      mode === "albums" ||
                      mode === "trash" ||
                      mode === "composite"
                    }
                  >
                    <Plus size={16} />
                    导入照片
                    <ChevronDown size={12} />
                  </button>
                  <AnimatePresence>
                    {importMenu && (
                      <motion.div
                        className="dropdown"
                        initial={{ opacity: 0, y: -5 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -5 }}
                      >
                        <button onClick={importPhotos}>
                          <ImagePlus size={16} />
                          选择照片
                        </button>
                        <button onClick={importFolder}>
                          <FolderPlus size={16} />
                          导入文件夹
                        </button>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
                <button
                  className="button primary"
                  disabled={
                    !exportScope.length ||
                    !!busy ||
                    mode === "albums" ||
                    mode === "trash" ||
                    mode === "composite"
                  }
                  onClick={() => setExportOpen(true)}
                >
                  <ArrowDownToLine size={15} />
                  导出作品
                </button>
              </div>
            </header>
          )}
          {error && (
            <div className="connection-error">
              <span>{error}</span>
              <button
                onClick={() => reload().catch((e) => setError(e.message))}
              >
                重试连接
              </button>
            </div>
          )}
          <AnimatePresence mode="wait">
            {mode === "albums" || mode === "trash" ? (
              <Albums
                key={mode}
                trash={mode === "trash"}
                variantMode={variantMode}
                onVariantMode={changeVariantMode}
                removeAlbum={trashAlbum}
                restoreAlbum={restoreAlbum}
                library={library}
                open={openAlbum}
                create={createAlbum}
                Picture={Picture}
                busy={!connected || busy}
                review={openLighttable}
              />
            ) : mode === "lighttable" ? null : mode === "composite" &&
              composite ? (
              <Composite
                key={composite.id || "new-composite"}
                initial={composite}
                photos={
                  composite.album_id
                    ? library.photos.filter((p) =>
                        p.album_ids.includes(composite.album_id!),
                      )
                    : albumPhotos
                }
                saveRef={compositeSave}
                onSaved={(doc) =>
                  install({
                    ...libraryRef.current,
                    composites: [
                      doc,
                      ...libraryRef.current.composites.filter(
                        (c) => c.id !== doc.id,
                      ),
                    ],
                  })
                }
                onBack={() => setMode("library")}
                onExport={async (document, folder) =>
                  startJob("/composite-export", { document, folder })
                }
                notify={notify}
              />
            ) : mode === "library" ? (
              <motion.section
                className="library-view"
                key={`library-${albumId ?? "all"}`}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.22 }}
              >
                <div className="page-heading">
                  <div>
                    <div className="eyebrow">
                      A LITTLE LESS CHAOS. A LITTLE MORE BEAUTY.
                    </div>
                    <h1>
                      {activeAlbum
                        ? activeAlbum.name
                        : filter === "keep"
                          ? "值得留下的瞬间"
                          : filter === "duplicates"
                            ? "相似中的唯一"
                            : group === "all"
                              ? "每一刻，都值得好好收藏。"
                              : dateLabel(
                                  photos[0]?.captured || Date.now() / 1000,
                                ) + " · 拍摄故事"}
                    </h1>
                    <p>
                      {photos.length
                        ? `${photos.length} 张照片，${new Set(photos.map((p) => p.group_id)).size} 组故事。把选择、风格与出片，放在同一个地方。`
                        : "从一组照片开始，让灵感自然发生。"}
                    </p>
                  </div>
                  <span className="heading-symbol">
                    <Aperture size={44} strokeWidth={0.7} />
                  </span>
                </div>
                <Classification
                  photos={scopePhotos}
                  facets={facets}
                  onChange={(next) => {
                    setFacets(next);
                    setSelected([]);
                    setLimit(48);
                  }}
                  recognition={library.recognition}
                  styles={library.styles}
                  stocks={library.film.stocks}
                  busy={!!busy}
                  count={photos.length}
                  select={() => setSelected(photos.map((p) => p.id))}
                  analyze={(semantic) =>
                    act(() =>
                      startJob("/analyze", {
                        ids: albumPhotos.map((p) => p.id),
                        semantic,
                      }),
                    )
                  }
                />
                <div className="library-toolbar">
                  <select
                    className="variant-preference"
                    aria-label="图集格式偏好"
                    title="同目录同名 RAW+JPEG 只显示优先格式；未配对照片保留"
                    value={variantMode}
                    onChange={(e) =>
                      changeVariantMode(e.target.value as VariantMode)
                    }
                  >
                    <option value="all">全部格式</option>
                    <option value="raw">RAW 优先</option>
                    <option value="jpeg">JPEG 优先</option>
                  </select>
                  <div className="segmented">
                    <button
                      className={filter === "all" ? "selected" : ""}
                      onClick={() => setFilter("all")}
                    >
                      全部照片
                    </button>
                    <button
                      className={filter === "keep" ? "selected" : ""}
                      onClick={() => setFilter("keep")}
                    >
                      已精选 <span>{kept}</span>
                    </button>
                    <button
                      className={filter === "pending" ? "selected" : ""}
                      onClick={() => setFilter("pending")}
                    >
                      待整理
                    </button>
                  </div>
                  <div className="tools-right">
                    <button
                      className="button secondary"
                      onClick={openLighttable}
                      disabled={!!busy || !photos.length}
                    >
                      <Film size={16} />
                      电子观片台
                    </button>
                    <label className="search">
                      <Search size={15} />
                      <input
                        aria-label="搜索照片"
                        placeholder="寻找一张照片…"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                      />
                    </label>
                    <select
                      aria-label="照片排序"
                      value={sort}
                      onChange={(event) => setSort(event.target.value)}
                    >
                      <option value="time">拍摄时间</option>
                      <option value="score">质量评分</option>
                    </select>
                    <button className="icon-button selected" title="网格视图">
                      <Grid2X2 size={17} />
                    </button>
                  </div>
                </div>
                {!albumPhotos.length ? (
                  <div className="empty-library">
                    <div className="empty-art">
                      <div className="paper paper-back" />
                      <div className="paper paper-front">
                        <Aperture size={65} strokeWidth={0.8} />
                        <span>A NEW STORY</span>
                      </div>
                      <motion.span
                        className="empty-spark"
                        animate={{ y: [0, -8, 0], rotate: [0, 8, 0] }}
                        transition={{ repeat: Infinity, duration: 5 }}
                      >
                        <Sparkles size={22} />
                      </motion.span>
                    </div>
                    <h2>下一组作品，从这里开始。</h2>
                    <p>
                      为这个图集导入 JPEG、PNG 或相机 RAW。
                      <br />
                      自动分组，自由选片，慢慢找到属于你的风格。
                    </p>
                    <button
                      className="button primary"
                      onClick={importFolder}
                      disabled={!connected || albumId === null}
                    >
                      <Plus size={16} />
                      导入文件夹
                    </button>
                    <span className="empty-footnote">
                      照片不会上传 · 每一次调整都可以撤销
                    </span>
                  </div>
                ) : !photos.length ? (
                  <div className="no-results">
                    <Search size={30} />
                    <h2>还没有符合条件的照片</h2>
                    <p>试试其他关键词或筛选条件。</p>
                    <button
                      className="button secondary"
                      onClick={() => {
                        setSearch("");
                        setFilter("all");
                      }}
                    >
                      清除筛选
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="collection-label">
                      <span>{activeAlbum?.name || "最近的记忆"}</span>
                      <span>{photos.length} PHOTOGRAPHS</span>
                    </div>
                    <motion.div className="photo-grid">
                      <AnimatePresence initial={false} mode="popLayout">
                        {photos.slice(0, limit).map((photo, index) => (
                          <motion.article
                            key={photo.id}
                            layout="position"
                            transition={{
                              layout: {
                                duration: 0.2,
                                ease: [0.22, 1, 0.36, 1],
                              },
                              opacity: { duration: 0.16 },
                              y: { duration: 0.2 },
                            }}
                            exit={{ opacity: 0, scale: 0.98 }}
                            initial={{ opacity: 0, y: 16 }}
                            animate={{ opacity: 1, y: 0 }}
                            className={`photo-card ${selected.includes(photo.id) ? "is-selected" : ""}`}
                            onClick={(event) => select(photo, event)}
                            onDoubleClick={() => openPhoto(photo)}
                            onContextMenu={(event) => {
                              event.preventDefault();
                              const ids = selected.includes(photo.id)
                                ? selected
                                : [photo.id];
                              setSelected(ids);
                              setContextMenu({
                                x: Math.max(
                                  8,
                                  Math.min(
                                    event.clientX,
                                    window.innerWidth - 270,
                                  ),
                                ),
                                y: Math.max(
                                  8,
                                  Math.min(
                                    event.clientY,
                                    window.innerHeight - 130,
                                  ),
                                ),
                                ids,
                              });
                            }}
                            tabIndex={0}
                            aria-label={`照片 ${photo.name}`}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") openPhoto(photo);
                            }}
                          >
                            <div className="card-image">
                              <Picture
                                photo={photo}
                                revision={revisions[photo.id]}
                              />
                              <span className="select-check">
                                {selected.includes(photo.id) && (
                                  <Check size={12} />
                                )}
                              </span>
                              {isRaw(photo) && (
                                <span className="file-badge">RAW</span>
                              )}
                              {photo.duplicate_of && (
                                <span className="duplicate-badge">
                                  <Copy size={11} />
                                  重复
                                </span>
                              )}
                              <button
                                className={`favorite ${photo.decision === "keep" ? "favorited" : ""}`}
                                aria-label={`${photo.decision === "keep" ? "取消精选" : "精选"} ${photo.name}`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  decide(
                                    [photo.id],
                                    photo.decision === "keep"
                                      ? "pending"
                                      : "keep",
                                  );
                                }}
                                disabled={!!busy}
                              >
                                <Heart
                                  size={16}
                                  fill={
                                    photo.decision === "keep"
                                      ? "currentColor"
                                      : "none"
                                  }
                                />
                              </button>
                              <div className="card-hover">
                                <span>
                                  {photo.width} × {photo.height}
                                </span>
                                <button
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    openPhoto(photo);
                                  }}
                                >
                                  编辑照片 <ArrowRight size={13} />
                                </button>
                              </div>
                            </div>
                            <div className="card-caption">
                              <span title={photo.name}>{photo.name}</span>
                              <span className="quality">
                                <i
                                  className={photo.score >= 65 ? "good" : ""}
                                />
                                {photo.score}
                              </span>
                            </div>
                            <div className="card-subtitle">
                              <span>{dateLabel(photo.captured)}</span>
                              <span>
                                {photo.decision === "reject"
                                  ? "已排除"
                                  : photo.decision === "keep"
                                    ? "精选作品"
                                    : photo.recipe.style === "natural"
                                      ? "待发现的美好"
                                      : styleLabel[String(photo.recipe.style)]}
                              </span>
                            </div>
                          </motion.article>
                        ))}
                      </AnimatePresence>
                    </motion.div>
                    {photos.length > limit && (
                      <button
                        className="load-more button secondary"
                        onClick={() => setLimit(limit + 48)}
                      >
                        再看 48 张
                      </button>
                    )}
                  </>
                )}
                <footer className="library-footer">
                  <span>
                    <ShieldCheck size={13} /> 原图只读，灵感自由。
                  </span>
                  <span>
                    {library.capabilities.raw
                      ? "RawTherapee RAW Engine"
                      : "RAW 引擎未连接"}
                    <span className="footer-dot">·</span>PHOTO ALL STUDIO
                  </span>
                </footer>
              </motion.section>
            ) : (
              current && (
                <EditorWorkspace
                  key={current.id}
                  photo={current}
                  photos={photos}
                  revisions={revisions}
                  busy={!!busy}
                  saving={saving}
                  film={library.film}
                  capabilities={library.capabilities}
                  history={library.history}
                  onPatch={updateRecipe}
                  onOpen={openPhoto}
                  onBack={() =>
                    act(async () => {
                      await flush();
                      setMode("library");
                    })
                  }
                  onReview={openLighttable}
                  onComposite={() => beginComposite()}
                  onExport={() => setExportOpen(true)}
                  onUndo={undo}
                  onRedo={redo}
                  onKeep={() =>
                    decide(
                      [current.id],
                      current.decision === "keep" ? "pending" : "keep",
                    )
                  }
                  onSync={applyGroup}
                  onFlush={flush}
                />
              )
            )}
          </AnimatePresence>
          <AnimatePresence>
            {selected.length > 0 && mode === "library" && (
              <motion.div
                className="selection-bar"
                initial={{ y: 80, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: 80, opacity: 0 }}
                transition={spring}
              >
                <span className="selection-count">{selected.length}</span>
                <span>张已选择</span>
                <span className="toolbar-line" />
                <select
                  aria-label="批量滤镜"
                  value={batchStyle}
                  onChange={(e) => setBatchStyle(e.target.value)}
                  disabled={!!busy}
                >
                  <optgroup label="创意风格">
                    {Object.entries(styleLabel).map(([id, label]) => (
                      <option key={id} value={id}>
                        {label}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="spektrafilm 胶片">
                    {Object.entries(library.film.stocks).map(([id, stock]) => (
                      <option
                        key={id}
                        value={"film:" + id}
                        disabled={!stock.ready}
                      >
                        {stock.label}
                      </option>
                    ))}
                  </optgroup>
                </select>
                <button onClick={applyBatch} disabled={!!busy}>
                  <Sparkles size={15} />
                  应用滤镜
                </button>
                <button
                  onClick={() => decide(selected, "keep")}
                  disabled={!!busy}
                >
                  <Heart size={15} />
                  保留
                </button>
                <button
                  onClick={() => decide(selected, "reject")}
                  disabled={!!busy}
                >
                  <X size={15} />
                  排除
                </button>
                <button
                  onClick={() => {
                    const photo = library.photos.find(
                      (p) => p.id === selected[0],
                    );
                    if (photo) openPhoto(photo);
                  }}
                >
                  <SlidersHorizontal size={15} />
                  开始编辑
                </button>
                <button title="取消选择" onClick={() => setSelected([])}>
                  <X size={14} />
                </button>
              </motion.div>
            )}
          </AnimatePresence>
          {photos.length > 0 && mode === "library" && !selected.length && (
            <button
              className="recommend-button"
              onClick={recommend}
              disabled={!!busy}
            >
              <Sparkles size={16} />
              帮我初选 <span>按清晰度与曝光推荐</span>
            </button>
          )}
        </main>

        <AnimatePresence>
          {busy && (
            <motion.div
              className="job-toast"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
            >
              <LoaderCircle className="spin" size={17} />
              <div>
                <strong>
                  {jobAction === "/import"
                    ? "正在导入照片"
                    : jobAction === "/export"
                      ? "正在导出作品"
                      : "让美好，慢慢呈现"}
                </strong>
                <span>
                  {job!.total
                    ? `正在处理 ${job!.done} / ${job!.total}`
                    : jobAction === "/import" && job!.done
                      ? `已处理 ${job!.done} 张 · 持续扫描文件夹`
                      : "正在准备本地处理…"}
                </span>
              </div>
              {job?.cancellable && (
                <button
                  className="job-cancel"
                  aria-label={jobAction === "/import" ? "终止导入" : "终止导出"}
                  disabled={job.cancel_requested}
                  onClick={() =>
                    act(async () => {
                      const result = await api<Job>(
                        `/jobs/${job.id}/cancel`,
                        {},
                      );
                      setJob(result);
                    })
                  }
                >
                  {job.cancel_requested
                    ? "正在终止…"
                    : jobAction === "/import"
                      ? "终止导入"
                      : "终止导出"}
                </button>
              )}
              <div className="job-progress">
                <motion.i
                  animate={{
                    width: `${job!.total ? (job!.done / job!.total) * 100 : 12}%`,
                  }}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <AnimatePresence>
          {toast && (
            <motion.div
              className="toast"
              role="status"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 15 }}
            >
              <Check size={16} />
              <span>{toast}</span>
              <button onClick={() => setToast("")} aria-label="关闭提示">
                <X size={14} />
              </button>
            </motion.div>
          )}
        </AnimatePresence>
        <AnimatePresence>
          {exportOpen && (
            <motion.div
              className="modal-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setExportOpen(false)}
            >
              <motion.div
                role="dialog"
                aria-modal="true"
                aria-label="导出作品"
                className="export-modal"
                initial={{ opacity: 0, y: 30, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 15, scale: 0.98 }}
                transition={spring}
                onClick={(event) => event.stopPropagation()}
              >
                <div className="export-preview">
                  <span className="eyebrow">MADE TO BE SHARED.</span>
                  {format === "tiff16" ? (
                    <div className="master-preview">
                      <Aperture size={64} strokeWidth={0.8} />
                      <h2>RAW MASTER</h2>
                      <p>
                        全分辨率 · 16-bit · sRGB
                        <br />
                        只应用 RAW 专业显影参数
                      </p>
                    </div>
                  ) : (
                    <div className={`template-preview template-${template}`}>
                      {exportScope[0] && (
                        <Picture
                          photo={exportScope[0]!}
                          revision={revisions[exportScope[0]!.id]}
                        />
                      )}
                    </div>
                  )}
                  <p>给这一组故事，一个漂亮的落点。</p>
                </div>
                <div className="export-settings">
                  <button
                    className="modal-close icon-button"
                    aria-label="关闭导出"
                    onClick={() => setExportOpen(false)}
                  >
                    <X size={18} />
                  </button>
                  <h2>把美好，带走。</h2>
                  <p>
                    {mode === "editor"
                      ? "仅导出当前照片"
                      : `仅导出勾选的 ${exportScope.length} 张照片`}
                  </p>
                  <label className="field-label">
                    导出格式
                    <select
                      aria-label="导出格式"
                      value={format}
                      onChange={(event) => setFormat(event.target.value)}
                    >
                      <option value="png">PNG · 16-bit 无损，包含调色</option>
                      <option value="tiff">TIFF · 16-bit 无损，包含调色</option>
                      <option value="webp">WebP · 8-bit 无损编码</option>
                      <option value="jpeg">JPEG · 8-bit 有损，分享文件</option>
                      <option value="original">
                        原始文件 · 字节复制，不应用修改
                      </option>
                      <option value="tiff16">16-bit TIFF · RAW 显影母版</option>
                    </select>
                  </label>
                  {format !== "tiff16" && format !== "original" ? (
                    <>
                      <label className="field-label">
                        画面模板
                        <select
                          value={template}
                          onChange={(event) => setTemplate(event.target.value)}
                        >
                          <option value="plain">原比例 · 简洁原片</option>
                          <option value="frame">方形留白 · 画廊感</option>
                          <option value="portrait">竖版留白 · 故事封面</option>
                        </select>
                      </label>
                      <label className="field-label">
                        长边 / 画布宽度
                        <select
                          value={exportSize}
                          onChange={(event) =>
                            setExportSize(Number(event.target.value))
                          }
                        >
                          <option value={0}>原始尺寸 · 不缩小</option>
                          {[1200, 2400, 4000, 6000, 12000].map((size) => (
                            <option key={size} value={size}>
                              {size.toLocaleString()} px
                            </option>
                          ))}
                        </select>
                      </label>
                    </>
                  ) : (
                    <div className="export-explanation">
                      {format === "original"
                        ? "完整复制原始文件与原有元数据，不应用调色或模板；另附当前配方。"
                        : "仅导出当前范围内的 RAW 文件。完整保留原生引擎的 16-bit 显影结果与 PP3，不包含基础调色、胶片与留白模板。"}
                    </div>
                  )}
                  <label className="export-folder-choice">
                    <input
                      type="checkbox"
                      aria-label="全部导出到同一个文件夹"
                      checked={folderMode === "single"}
                      onChange={(e) =>
                        setFolderMode(e.target.checked ? "single" : "album")
                      }
                    />
                    <span>
                      全部导出到同一个文件夹
                      <small>
                        取消后按图集创建子文件夹；每张照片仅导出一份。
                      </small>
                    </span>
                  </label>
                  <div className="export-summary">
                    <ShieldCheck size={16} />
                    <span>
                      原图不会被覆盖，重名自动编号。
                      <br />
                      当前将导出 {exportSelection.length} 张照片。
                    </span>
                  </div>
                  <button
                    className="button primary export-confirm"
                    onClick={exportPhotos}
                    disabled={!!busy || !exportSelection.length}
                  >
                    <ArrowDownToLine size={16} />
                    选择位置并导出
                    <ArrowRight size={15} />
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}

createRoot(document.getElementById("root")!).render(<Studio />);
