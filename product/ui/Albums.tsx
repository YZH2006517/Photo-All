// SPDX-License-Identifier: GPL-3.0-or-later
import React, { useMemo, useState } from "react";
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
  create,
  Picture,
  busy,
  review,
  removeAlbum,
  restoreAlbum,
  trash = false,
  variantMode = "all",
  onVariantMode,
}: {
  library: Library;
  open: (album: Album) => void;
  create: (name: string) => Promise<void>;
  Picture: React.ComponentType<PictureProps>;
  busy: boolean;
  review: () => void;
  removeAlbum: (album: Album) => void;
  restoreAlbum: (album: Album) => void;
  trash?: boolean;
  variantMode?: VariantMode;
  onVariantMode?: (mode: VariantMode) => void;
}) {
  const albums = trash ? library.trash_albums || [] : library.albums;
  const visiblePhotoCount = applyVariantPreference(
    library.photos,
    variantMode,
  ).length;
  const [creating, setCreating] = useState(false),
    [name, setName] = useState(""),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
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
      <div className="page-heading">
        <div>
          <div className="eyebrow">A PLACE FOR EVERY STORY</div>
          <h1>{trash ? "回收站" : "图集"}</h1>
          <p>
            {trash
              ? "删除的图集保留 30 天，可随时恢复；到期清除图集记录，磁盘原片保留。"
              : "把同一段故事放在一起，再慢慢找到它的颜色。"}
          </p>
        </div>
        <div className="album-home-actions">
          <button
            className="album-lighttable-entry"
            aria-label="首页电子观片台"
            disabled={busy || trash || !library.photos.length}
            onClick={review}
          >
            <Film size={24} />
            <span>
              电子观片台
              <small>{visiblePhotoCount} 张显示照片 · 胶卷与光影</small>
            </span>
            <ArrowUpRight size={16} />
          </button>
          <span className="album-home-total">
            {String(albums.length).padStart(2, "0")}
            <small>COLLECTIONS</small>
          </span>
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
        <span>
          <FolderPlus size={14} />{" "}
          {trash ? "30 天内可恢复" : "新建图集后，导入一个文件夹开始整理"}
        </span>
      </div>
      <div className="album-grid">
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
            <small>一组照片，一个新的故事</small>
          </button>
        )}
        {trash && !albums.length && (
          <div className="trash-empty">
            <Trash2 size={32} />
            <strong>回收站是空的</strong>
            <span>已删除的图集会在这里保留 30 天</span>
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
            <div className="album-tile" key={album.id}>
              <motion.button
                key={album.id}
                className="album-card"
                aria-label={
                  trash ? `恢复图集 ${album.name}` : `打开图集 ${album.name}`
                }
                onClick={() => (trash ? restoreAlbum(album) : open(album))}
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
            </div>
          );
        })}
      </div>
      <div className="album-home-note">
        <Palette size={18} />
        <span>
          用颜色寻找共鸣
          <small>日期、主色、冷暖、亮度与内容，可以一起筛选。</small>
        </span>
      </div>
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
            <div className="eyebrow">A NEW COLLECTION</div>
            <h2>给这组故事，一个名字。</h2>
            <p>创建后可以导入整个文件夹，保留原片位置。</p>
            <label className="field-label">
              图集名称
              <input
                aria-label="图集名称"
                autoFocus
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：秋日散步"
                required
              />
            </label>
            {error && <p role="alert">{error}</p>}
            <button
              className="button primary"
              type="submit"
              disabled={!name.trim() || saving}
            >
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
