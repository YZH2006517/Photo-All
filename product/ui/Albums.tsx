// SPDX-License-Identifier: GPL-3.0-or-later
import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import {
  Plus,
  Images,
  ArrowUpRight,
  X,
  Sparkles,
  Palette,
  FolderPlus,
  Film,
  SlidersHorizontal,
  ChevronDown,
  Trash2,
  RotateCcw,
} from "lucide-react";
import {
  Album,
  Photo,
  Facets,
  Library,
  localDate,
  facetCounts,
  facetKeys,
  VariantMode,
  applyVariantPreference,
} from "./model";

export const colorLabels: Record<string, string> = {
  red: "红色",
  orange: "橙色",
  yellow: "黄色",
  green: "绿色",
  cyan: "青色",
  blue: "蓝色",
  purple: "紫色",
  pink: "粉色",
  black: "黑色",
  white: "白色",
  gray: "灰色",
};
export const colorSwatches: Record<string, string> = {
  red: "#d96d64",
  orange: "#dba569",
  yellow: "#d3c474",
  green: "#8fa18a",
  cyan: "#89b8b1",
  blue: "#83a3c4",
  purple: "#a297bd",
  pink: "#cd9caf",
  black: "#3e4245",
  white: "#efeee8",
  gray: "#a1a4a2",
};

type PictureProps = {
  photo: Photo;
  size?: number;
  revision?: number;
  className?: string;
};

export function Albums({
  library,
  open,
  openLibrary,
  create,
  Picture,
  busy,
  review,
  darkroom,
  removeAlbum,
  restoreAlbum,
  purgeAlbum,
  restorePhoto,
  trash = false,
  variantMode = "all",
  onVariantMode,
}: {
  library: Library;
  open: (album: Album) => void;
  openLibrary: () => void;
  create: (name: string) => Promise<void>;
  Picture: React.ComponentType<PictureProps>;
  busy: boolean;
  review: () => void;
  darkroom?: () => void;
  removeAlbum: (album: Album) => void;
  restoreAlbum: (album: Album) => void;
  purgeAlbum: (album: Album) => Promise<void>;
  restorePhoto: (photo: Photo) => void;
  trash?: boolean;
  variantMode?: VariantMode;
  onVariantMode?: (mode: VariantMode) => void;
}) {
  const albums = trash ? library.trash_albums || [] : library.albums;
  const trashedPhotos = trash ? library.trash_photos ?? [] : [];
  const visiblePhotoCount = applyVariantPreference(
    library.photos,
    variantMode,
  ).length;
  const [creating, setCreating] = useState(false),
    [name, setName] = useState(""),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  const [purging, setPurging] = useState<Album | null>(null);
  useEffect(() => {
    if (!purging) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) {
        event.preventDefault();
        setPurging(null);
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [purging, saving]);
  const [menu, setMenu] = useState<{
    album: Album;
    x: number;
    y: number;
    trigger: HTMLElement;
  } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => {
      if (!(event.target as HTMLElement).closest(".album-context-menu"))
        setMenu(null);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setMenu(null);
        menu.trigger.focus();
      }
    };
    const dismiss = () => setMenu(null);
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [menu]);
  const context = (
    album: Album,
    trigger: HTMLElement,
    x: number,
    y: number,
  ) => {
    if (busy) return;
    const rect = trigger.getBoundingClientRect();
    setMenu({
      album,
      trigger,
      x: Math.max(8, Math.min(x || rect.left + 16, window.innerWidth - 216)),
      y: Math.max(8, Math.min(y || rect.bottom, window.innerHeight - 110)),
    });
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await create(name);
      setCreating(false);
      setName("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <motion.section
      className="albums-home library-view"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
    >
      <div className="page-heading albums-heading">
        <div>
          <h1>{trash ? "回收站" : "图集"}</h1>
          {trash && <p>保留 30 天 · 只清除软件记录，保留本地原片</p>}
        </div>
        <div className="album-home-actions">
          {!trash && darkroom && (
            <button
              className="album-darkroom-entry"
              aria-label="首页胶片收藏室"
              disabled={busy}
              onClick={darkroom}
            >
              <Film size={18} />
              <span>胶片收藏室</span>
              <ArrowUpRight size={15} />
            </button>
          )}
          <button
            className="album-lighttable-entry"
            aria-label="首页电子观片台"
            disabled={busy || trash || !library.photos.length}
            onClick={review}
          >
            <Film size={18} />
            <span>
              电子观片台
              <small>{visiblePhotoCount} 张照片</small>
            </span>
            <ArrowUpRight size={16} />
          </button>
        </div>
      </div>
      <div className="album-home-toolbar">
        <span>
          {trash ? "已删除图集" : "我的图集"} <b>{albums.length}</b>
        </span>
        {!trash && (
          <select
            className="variant-preference"
            aria-label="图集封面格式偏好"
            title="同一图集内的同目录同名 RAW 与 JPEG 仅显示优先格式"
            value={variantMode}
            disabled={busy || !onVariantMode}
            onChange={(e) => onVariantMode?.(e.target.value as VariantMode)}
          >
            <option value="all">全部格式</option>
            <option value="raw">RAW 优先</option>
            <option value="jpeg">JPEG 优先</option>
          </select>
        )}
      </div>
      <div className="album-grid">
        {!trash && !albums.length && visiblePhotoCount > 0 && (
          <button className="unfiled-photos" onClick={openLibrary}>
            <Images size={18} />
            <span>{visiblePhotoCount} 张未归档照片</span>
            <ArrowUpRight size={15} />
          </button>
        )}
        {!trash && (
          <button
            className="new-album-tile"
            aria-label="新建图集"
            disabled={busy}
            onClick={() => setCreating(true)}
          >
            <div className="new-album-art">
              <span>
                <Plus size={30} strokeWidth={1.1} />
              </span>
              <i />
              <i />
            </div>
            <strong>新建图集</strong>
          </button>
        )}
        {trash && !albums.length && !trashedPhotos.length && (
          <div className="trash-empty">
            <Trash2 size={32} />
            <strong>回收站是空的</strong>
            <span>从图库删除的照片可以在这里恢复，已删除的图集保留 30 天</span>
          </div>
        )}
        {albums.map((album, index) => {
          const photos = applyVariantPreference(
            library.photos.filter((p) => p.album_ids.includes(album.id)),
            variantMode,
          );
          const cover = photos
            .filter((p) => p.decision !== "reject")
            .slice(0, 3);
          if (!cover.length) cover.push(...photos.slice(0, 3));
          const palette = photos
            .flatMap((p) => p.features.palette || [])
            .slice(0, 5);
          return (
            <div
              className="album-tile"
              key={album.id}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const trigger =
                  event.currentTarget.querySelector<HTMLElement>(
                    ".album-card",
                  )!;
                context(album, trigger, event.clientX, event.clientY);
              }}
            >
              <motion.button
                key={album.id}
                className="album-card"
                aria-label={
                  trash ? `恢复图集 ${album.name}` : `打开图集 ${album.name}`
                }
                onClick={() => (trash ? restoreAlbum(album) : open(album))}
                onKeyDown={(event) => {
                  if (
                    event.key === "ContextMenu" ||
                    (event.shiftKey && event.key === "F10")
                  ) {
                    event.preventDefault();
                    event.stopPropagation();
                    context(album, event.currentTarget, 0, 0);
                  }
                }}
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(index * 0.04, 0.24) }}
                whileHover={{ y: -4 }}
              >
                <div className={`album-cover cover-${cover.length}`}>
                  <div className="album-cover-grid">
                    {cover.length ? (
                      cover.map((photo) => (
                        <Picture key={photo.id} photo={photo} size={600} />
                      ))
                    ) : (
                      <div className="album-empty-cover">
                        <Images size={38} strokeWidth={0.8} />
                        <span>等待第一张照片</span>
                      </div>
                    )}
                  </div>
                  <span className="album-count">
                    {trash ? album.count : photos.length} 张照片
                  </span>
                  <span className="album-enter">
                    <ArrowUpRight size={17} />
                  </span>
                </div>
                <div className="album-title">
                  <strong>{album.name}</strong>
                  <span className="album-palette">
                    {palette.map((c, i) => (
                      <i key={i} style={{ background: c }} />
                    ))}
                  </span>
                </div>
                <small>
                  {trash
                    ? `剩余 ${Math.max(0, Math.ceil(((album.purge_at || 0) * 1000 - Date.now()) / 86400000))} 天`
                    : photos.length
                      ? "整理与调色"
                      : "导入文件夹，开始整理"}{" "}
                  <span>本地图集</span>
                </small>
              </motion.button>
              <button
                className="album-trash-button"
                aria-label={
                  trash ? `还原图集 ${album.name}` : `删除图集 ${album.name}`
                }
                title={trash ? "恢复图集" : "移到回收站"}
                disabled={busy}
                onClick={() =>
                  trash ? restoreAlbum(album) : removeAlbum(album)
                }
              >
                {trash ? <RotateCcw size={16} /> : <Trash2 size={16} />}
              </button>
              {trash && (
                <button
                  className="album-purge-button"
                  aria-label={`彻底删除图集 ${album.name}`}
                  disabled={busy}
                  onClick={() => {
                    setError("");
                    setPurging(album);
                  }}
                >
                  <Trash2 size={14} />
                  彻底删除
                </button>
              )}
            </div>
          );
        })}
      </div>
      {!!trashedPhotos.length && (
        <section className="trash-photos" aria-label="已删除照片">
          <h2>已删除照片 <small>{trashedPhotos.length}</small></h2>
          <div className="trash-photo-list">
            {trashedPhotos.map((photo) => (
              <article key={photo.id} className="trash-photo-card">
                <Picture photo={photo} />
                <div className="trash-photo-caption">
                  <strong title={photo.name}>{photo.name}</strong>
                  <button type="button" className="icon-button" disabled={busy}
                    aria-label={`恢复照片 ${photo.name}`} title="恢复照片"
                    onClick={() => restorePhoto(photo)}>
                    <RotateCcw size={16} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
      {!trash && (
        <div className="album-home-note">
          <Palette size={18} />
          <span>
            用颜色寻找共鸣
            <small>日期、主色、冷暖、亮度与内容，可以一起筛选。</small>
          </span>
        </div>
      )}
      {menu &&
        createPortal(
          <div
            className="photo-context-menu album-context-menu"
            role="menu"
            aria-label="图集菜单"
            style={{ position: "fixed", left: menu.x, top: menu.y }}
            onContextMenu={(event) => event.preventDefault()}
          >
            <button
              role="menuitem"
              autoFocus
              disabled={busy}
              onClick={() => {
                const album = menu.album;
                setMenu(null);
                if (trash) restoreAlbum(album);
                else removeAlbum(album);
              }}
            >
              {trash ? <RotateCcw size={15} /> : <Trash2 size={15} />}
              {trash ? "恢复图集" : "移到回收站"}
            </button>
            {trash && (
              <button
                role="menuitem"
                disabled={busy}
                onClick={() => {
                  setPurging(menu.album);
                  setError("");
                  setMenu(null);
                }}
              >
                <Trash2 size={15} />
                彻底删除图集
              </button>
            )}
            <small>
              {trash ? "还原图集及照片成员" : "30 天内可恢复 · 保留原片"}
            </small>
          </div>,
          document.body,
        )}
      {purging && (
        <div className="modal-backdrop">
          <section
            className="album-create-modal purge-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-label="彻底删除图集确认"
          >
            <Trash2 size={24} />
            <h2>彻底移除“{purging.name}”？</h2>
            <p>
              仅删除软件内的图集及关联记录，
              <strong>不会删除电脑本地的照片文件</strong>，其他图集不受影响。
            </p>
            <p>移除后无法从回收站恢复。</p>
            {error && <p role="alert">{error}</p>}
            <div className="purge-actions">
              <button
                className="button secondary"
                autoFocus
                disabled={saving}
                onClick={() => setPurging(null)}
              >
                取消
              </button>
              <button
                className="button danger"
                disabled={saving}
                onClick={async () => {
                  setSaving(true);
                  setError("");
                  try {
                    await purgeAlbum(purging);
                    setPurging(null);
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                {saving ? "正在移除…" : "彻底删除图集"}
              </button>
            </div>
          </section>
        </div>
      )}
      {creating && (
        <div className="modal-backdrop">
          <form
            className="album-create-modal"
            role="dialog"
            aria-modal="true"
            aria-label="新建图集"
            onSubmit={submit}
          >
            <button
              type="button"
              className="modal-close icon-button"
              aria-label="取消新建"
              onClick={() => setCreating(false)}
              disabled={saving}
            >
              <X size={18} />
            </button>
            <span className="modal-album-icon">
              <Images size={30} strokeWidth={1.2} />
            </span>
            <h2>新建图集</h2>
            <label className="field-label">
              图集名称（可选）
              <input
                aria-label="图集名称"
                autoFocus
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="留空使用“未命名图集”"
              />
            </label>
            {error && <p role="alert">{error}</p>}
            <button className="button primary" type="submit" disabled={saving}>
              {saving ? "正在创建…" : "创建图集"}
              <ArrowUpRight size={16} />
            </button>
          </form>
        </div>
      )}
    </motion.section>
  );
}

export function Classification({
  photos,
  facets,
  onChange,
  recognition,
  analyze,
  select,
  busy,
  count,
  styles = {},
  stocks = {},
}: {
  photos: Photo[];
  facets: Facets;
  onChange: (next: Facets) => void;
  recognition: Library["recognition"];
  analyze: (semantic: boolean) => void;
  select: () => void;
  busy: boolean;
  count: number;
  styles?: Record<string, string>;
  stocks?: Library["film"]["stocks"];
}) {
  const [expanded, setExpanded] = useState(false);
  const counts = useMemo(
    () =>
      Object.fromEntries(
        facetKeys.map((key) => [key, facetCounts(photos, facets, key)]),
      ) as Record<keyof Facets, Record<string, number>>,
    [photos, facets],
  );
  const totals = useMemo(
    () =>
      Object.fromEntries(
        facetKeys.map((key) => [key, facetCounts(photos, {}, key)]),
      ) as Record<keyof Facets, Record<string, number>>,
    [photos],
  );
  const labels: Record<keyof Facets, Record<string, string>> = {
    date: Object.fromEntries(
      [...new Set(photos.map((p) => localDate(p.captured)))]
        .sort()
        .reverse()
        .map((d) => [d, d]),
    ),
    color: colorLabels,
    tone: { warm: "暖色调", cool: "冷色调", neutral: "中性色调" },
    brightness: { dark: "低调暗部", balanced: "均衡亮度", bright: "明亮高调" },
    content: {
      ...recognition.labels,
      uncertain: "待确认",
      unindexed: "未识图",
    },
    saturation: {
      low: "低饱和",
      balanced: "自然饱和",
      high: "高饱和",
      unindexed: "待分析",
    },
    contrast: {
      low: "柔和低反差",
      balanced: "均衡反差",
      high: "鲜明高反差",
      unindexed: "待分析",
    },
    orientation: { landscape: "横幅", portrait: "竖幅", square: "方形" },
    format: {
      raw: "RAW",
      jpeg: "JPEG",
      png: "PNG",
      tiff: "TIFF",
      webp: "WebP",
      bmp: "BMP",
      heic: "HEIC",
    },
    resolution: {
      large: "2000万像素以上",
      medium: "800–2000万像素",
      small: "800万像素以下",
    },
    quality: { high: "清晰度优先", balanced: "常规质量", low: "需人工检查" },
    style: { natural: "自然原色", ...styles },
    film: {
      none: "未套胶片",
      ...Object.fromEntries(
        Object.entries(stocks).map(([id, stock]) => [id, stock.label]),
      ),
    },
  };
  const titles: Record<keyof Facets, string> = {
    date: "日期",
    color: "主色",
    tone: "冷暖",
    brightness: "亮度",
    content: "内容",
    saturation: "饱和度",
    contrast: "对比度",
    orientation: "方向",
    format: "格式",
    resolution: "像素",
    quality: "质量",
    style: "风格",
    film: "胶片",
  };
  const active = facetKeys.filter((key) => facets[key]);
  const control = (key: keyof Facets) => (
    <label className="facet-field" key={key}>
      <span>{titles[key]}</span>
      <select
        aria-label={`按${titles[key]}分类`}
        value={facets[key] || ""}
        onChange={(e) => onChange({ ...facets, [key]: e.target.value })}
      >
        <option value="">
          全部{titles[key]} ·{" "}
          {Object.values(counts[key]).reduce((a, b) => a + b, 0)}
        </option>
        {Object.entries(labels[key])
          .filter(([id]) => totals[key][id] || facets[key] === id)
          .map(([id, label]) => (
            <option
              key={id}
              value={id}
              disabled={!counts[key][id] && facets[key] !== id}
            >
              {label} · {counts[key][id] || 0}
            </option>
          ))}
      </select>
    </label>
  );
  return (
    <section
      className={`classification-panel compact-classification ${expanded ? "is-expanded" : ""}`}
      aria-label="风格筛选"
    >
      <div className="classification-bar">
        <span className="classification-caption">
          <Palette size={16} />
          风格筛选
        </span>
        <div className="facet-quick">
          {(["color", "tone", "brightness", "content"] as const).map(control)}
        </div>
        <button
          className="facet-more"
          aria-label="更多筛选"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <SlidersHorizontal size={15} />
          <span>更多{active.length ? ` · ${active.length}` : ""}</span>
          <ChevronDown size={13} />
        </button>
        <button
          className="facet-recognize"
          aria-label="识图分类"
          disabled={busy || !photos.length || !recognition.ready}
          onClick={() => analyze(true)}
          title="本机识图分类"
        >
          <Sparkles size={14} />
          <span>识图</span>
        </button>
        <button
          className="facet-select"
          onClick={select}
          disabled={!count || busy}
        >
          选择 {count} 张
        </button>
      </div>
      {active.length > 0 && (
        <div className="facet-chips">
          {active.map((key) => (
            <button
              key={key}
              onClick={() => onChange({ ...facets, [key]: "" })}
            >
              {titles[key]}：{labels[key][facets[key]!] || facets[key]}
              <X size={11} />
            </button>
          ))}
          <button className="facet-clear" onClick={() => onChange({})}>
            清除全部
          </button>
        </div>
      )}
      {expanded && (
        <div className="facet-expanded">
          <div className="facet-controls">
            {facetKeys
              .filter(
                (key) =>
                  !["color", "tone", "brightness", "content"].includes(key),
              )
              .map(control)}
          </div>
          <div className="classification-footer">
            <span>{count} 张匹配 · 原片视觉分析 · 质量为启发式参考</span>
            <div>
              {photos.some(
                (p) => p.features.contrast === undefined || !p.features.color,
              ) && (
                <button disabled={busy} onClick={() => analyze(false)}>
                  补全视觉分析
                </button>
              )}
              <button onClick={() => onChange({})} disabled={!active.length}>
                清除分类
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
