// SPDX-License-Identifier: GPL-3.0-or-later
// This panel persists frame settings; preview and export share the Python composer.
import React, { useEffect, useRef, useState } from "react";
import { Check, LoaderCircle, RotateCcw } from "lucide-react";
import { Photo, Recipe, api, borderBlob } from "./model";
import { NumericValue } from "./Film";
import { Picture } from "./Preview";

export const borderStyles = [
  {
    id: "none",
    name: "无片边",
    paper: "#f5f2eb",
    ink: "#373d37",
    accent: "#ad8255",
  },
  {
    id: "film35",
    name: "经典 35mm",
    paper: "#141712",
    ink: "#c9a36b",
    accent: "#c9a36b",
  },
  {
    id: "negative",
    name: "暖棕负片",
    paper: "#542e1e",
    ink: "#deb784",
    accent: "#deb784",
  },
  {
    id: "slide",
    name: "幻灯片框",
    paper: "#e6e0d0",
    ink: "#4c4e44",
    accent: "#9b794c",
  },
  {
    id: "film_bw",
    name: "黑白 35mm",
    paper: "#181a18",
    ink: "#d1cdc0",
    accent: "#d1cdc0",
  },
  {
    id: "medium120",
    name: "120 中画幅",
    paper: "#171b18",
    ink: "#cbb48b",
    accent: "#cbb48b",
  },
  {
    id: "scan",
    name: "实扫毛边",
    paper: "#151b17",
    ink: "#d4c69e",
    accent: "#d4c69e",
  },
  {
    id: "instant",
    name: "即影即有",
    paper: "#f1ece1",
    ink: "#4d5049",
    accent: "#9b794c",
  },
  {
    id: "gallery",
    name: "画廊留白",
    paper: "#faf8f2",
    ink: "#333c36",
    accent: "#9c8660",
  },
  {
    id: "postcard",
    name: "旅行明信片",
    paper: "#e6dfcf",
    ink: "#484e43",
    accent: "#907a51",
  },
  {
    id: "cinema",
    name: "宽幕黑边",
    paper: "#101311",
    ink: "#e4dfd1",
    accent: "#c5a675",
  },
  {
    id: "archive",
    name: "档案卡片",
    paper: "#e9e5d9",
    ink: "#3f4c42",
    accent: "#8e744c",
  },
] as const;
type BorderSettings = {
  style: string;
  width: number;
  text_scale: number;
  font: string;
  background: string;
  ink: string;
  accent: string;
  date_mode: string;
  date_text: string;
  roll_name: string;
  signature: string;
  info_mode: string;
  info_text: string;
  frame_number: string;
  show_roll: boolean;
  show_camera: boolean;
  show_lens: boolean;
  show_exposure: boolean;
  edge_code: boolean;
};
const defaults: BorderSettings = {
  style: "none",
  width: 0.065,
  text_scale: 1,
  font: "mono",
  background: "",
  ink: "",
  accent: "",
  date_mode: "auto",
  date_text: "",
  roll_name: "",
  signature: "",
  info_mode: "auto",
  info_text: "",
  frame_number: "",
  show_roll: true,
  show_camera: true,
  show_lens: false,
  show_exposure: true,
  edge_code: true,
};
export function borderSettings(recipe: Recipe): BorderSettings {
  try {
    return { ...defaults, ...JSON.parse(String(recipe.border || "{}")) };
  } catch {
    return { ...defaults };
  }
}
type Info = {
  date: string;
  date_source: string;
  camera: string;
  lens: string;
  exposure: string;
  roll_name: string;
  frame: string;
};

export function BorderPreview({
  photo,
  onSize,
  className = "",
}: {
  photo: Photo;
  onSize?: (value: { width: number; height: number }) => void;
  className?: string;
}) {
  const [asset, setAsset] = useState<{ id: number; url: string } | null>(null),
    [busy, setBusy] = useState(true),
    [error, setError] = useState("");
  const onSizeRef = useRef(onSize);
  const previewSession = useRef(crypto.randomUUID());
  const previousStyle = useRef("");
  onSizeRef.current = onSize;
  const key = JSON.stringify(photo.recipe);
  useEffect(() => {
    const controller = new AbortController();
    let objectURL = "";
    let published = false;
    const style=borderSettings(photo.recipe).style;
    const delay=previousStyle.current===style ? 100 : 0;
    previousStyle.current=style;
    setBusy(true);
    setError("");
    const timer = window.setTimeout(() => {
      void borderBlob(photo, controller.signal, previewSession.current)
        .then(async (blob) => {
          if (controller.signal.aborted) return;
          objectURL = URL.createObjectURL(blob);
          const image=new Image();image.src=objectURL;
          await image.decode();
          if(controller.signal.aborted){URL.revokeObjectURL(objectURL);return;}
          published = true;
          setAsset({ id: photo.id, url: objectURL });
        })
        .catch((e) => {
          if (!controller.signal.aborted) {
            setError(String(e));
            setBusy(false);
          }
        });
    }, delay);
    return () => {
      clearTimeout(timer);
      controller.abort();
      if (objectURL && !published) URL.revokeObjectURL(objectURL);
    };
  }, [photo.id, key]);
  useEffect(()=>()=>{if(asset?.url)URL.revokeObjectURL(asset.url);},[asset?.url]);
  return (
    <div
      className={`border-preview ${className}`}
      aria-label="片边导出预览"
      aria-busy={busy}
    >
      {asset?.id === photo.id && (
        <img
          src={asset.url}
          alt="片边效果"
          draggable={false}
          onLoad={(e) => {
            setBusy(false);
            const image = e.currentTarget;
            onSizeRef.current?.({
              width: image.naturalWidth,
              height: image.naturalHeight,
            });
          }}
        />
      )}
      {busy && (
        <span className="border-preview-status">
          <LoaderCircle size={15} className="spin" />
          正在更新片边
        </span>
      )}
      {error && (
        <span className="border-preview-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export function BorderControls({
  photo,
  onPatch,
  disabled = false,
}: {
  photo: Photo;
  onPatch: (patch: Recipe) => void;
  disabled?: boolean;
}) {
  const config = borderSettings(photo.recipe),
    preset = borderStyles.find((v) => v.id === config.style) || borderStyles[0];
  const [info, setInfo] = useState<Info | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setInfo(null);
    void api<Info>("/border-info", { id: photo.id }, controller.signal)
      .then(setInfo)
      .catch(() => {});
    return () => controller.abort();
  }, [photo.id]);
  const update = (patch: Partial<BorderSettings>) =>
    onPatch({ border: JSON.stringify({ ...config, ...patch }) });
  const field = (
    label: string,
    key: "roll_name" | "signature" | "date_text" | "info_text" | "frame_number",
    placeholder = "",
    limit = 120,
  ) => (
    <label className="border-field">
      {label}
      <input
        aria-label={label}
        type="text"
        value={config[key]}
        maxLength={limit}
        placeholder={placeholder}
        onChange={(e) =>
          update({ [key]: e.target.value.replace(/[\r\n\t]/g, " ") })
        }
      />
    </label>
  );
  return (
    <fieldset className="border-controls" disabled={disabled}>
      <div className="border-style-grid" role="group" aria-label="导出片边样式">
        {borderStyles.map((item) => (
          <button
            type="button"
            key={item.id}
            aria-label={`片边样式 ${item.name}`}
            aria-pressed={config.style === item.id}
            className={`border-style-card ${config.style === item.id ? "selected" : ""}`}
            onClick={() => update({ style: item.id })}
          >
            <span
              className={`border-mini border-mini-${item.id}`}
              style={
                {
                  "--frame-paper": item.paper,
                  "--frame-ink": item.ink,
                } as React.CSSProperties
              }
            >
              <i>
                <Picture photo={photo} size={160} />
              </i>
              <b />
              {config.style === item.id && <Check size={13} />}
            </span>
            <span>{item.name}</span>
          </button>
        ))}
      </div>
      {config.style !== "none" && (
        <>
          <div className="border-section-title">边框与排版</div>
          {["film35", "negative", "film_bw", "medium120"].includes(
            config.style,
          ) ? (
            <p className="border-info">
              采用真实胶片片宽与孔距比例；竖片自动转为侧边片边。
            </p>
          ) : (
            <div className="border-range">
              <span>边宽</span>
              <NumericValue
                value={config.width * 100}
                min={2.5}
                max={18}
                step={0.5}
                label="片边宽度"
                unit="%"
                onChange={(value) => update({ width: value / 100 })}
              />
              <input
                aria-label="片边宽度"
                type="range"
                min={2.5}
                max={18}
                step={0.5}
                value={config.width * 100}
                onChange={(e) =>
                  update({ width: Number(e.target.value) / 100 })
                }
              />
            </div>
          )}
          {["film35", "negative", "film_bw"].includes(config.style) && (
            <label className="border-check">
              <input
                type="checkbox"
                checked={config.edge_code}
                onChange={(e) => update({ edge_code: e.target.checked })}
              />
              边缘编号条码<small>示意</small>
            </label>
          )}
          <div className="border-range">
            <span>字号</span>
            <NumericValue
              value={config.text_scale * 100}
              min={60}
              max={160}
              step={5}
              label="片边字号"
              unit="%"
              onChange={(value) => update({ text_scale: value / 100 })}
            />
            <input
              aria-label="片边字号"
              type="range"
              min={60}
              max={160}
              step={5}
              value={config.text_scale * 100}
              onChange={(e) =>
                update({ text_scale: Number(e.target.value) / 100 })
              }
            />
          </div>
          <div className="border-colors">
            {(
              [
                ["background", "片边底色", preset.paper],
                ["ink", "文字颜色", preset.ink],
                ["accent", "强调色", preset.accent],
              ] as const
            ).map(([key, label, fallback]) => (
              <label key={key}>
                <input
                  aria-label={label}
                  type="color"
                  value={config[key] || fallback}
                  onChange={(e) => update({ [key]: e.target.value })}
                />
                <span>{label}</span>
              </label>
            ))}
            <button
              type="button"
              title="恢复样式默认颜色"
              aria-label="恢复片边默认颜色"
              onClick={() => update({ background: "", ink: "", accent: "" })}
            >
              <RotateCcw size={14} />
            </button>
          </div>
          <label className="border-field">
            字体
            <select
              aria-label="片边字体"
              value={config.font}
              onChange={(e) => update({ font: e.target.value })}
            >
              <option value="mono">等宽 · 胶片编号</option>
              <option value="sans">简洁 · 无衬线</option>
              <option value="serif">典雅 · 衬线</option>
            </select>
          </label>
          <div className="border-section-title">卷名与签名</div>
          <label className="border-check">
            <input
              type="checkbox"
              checked={config.show_roll}
              onChange={(e) => update({ show_roll: e.target.checked })}
            />
            显示卷名
          </label>
          {config.show_roll &&
            field("卷名", "roll_name", info?.roll_name || "留空使用图集名称")}
          {field("签名", "signature", "你的名字 / 摄影工作室")}
          {field("胶片编号", "frame_number", info?.frame || "自动编号", 24)}
          <div className="border-section-title">拍摄日期</div>
          <label className="border-field">
            日期来源
            <select
              aria-label="片边日期来源"
              value={config.date_mode}
              onChange={(e) => update({ date_mode: e.target.value })}
            >
              <option value="auto">自动读取</option>
              <option value="custom">自定义日期</option>
              <option value="none">不显示日期</option>
            </select>
          </label>
          {config.date_mode === "custom"
            ? field("拍摄日期", "date_text", "2026.11.02", 60)
            : config.date_mode === "auto" && (
                <p className="border-info">
                  {info?.date || "未读取到日期"}
                  {info?.date && info.date_source !== "exif"
                    ? " · 使用文件时间"
                    : ""}
                </p>
              )}
          <div className="border-section-title">胶片上的拍摄信息</div>
          <label className="border-field">
            信息来源
            <select
              aria-label="片边信息来源"
              value={config.info_mode}
              onChange={(e) => update({ info_mode: e.target.value })}
            >
              <option value="auto">自动读取 EXIF</option>
              <option value="custom">自定义文字</option>
              <option value="none">不显示拍摄信息</option>
            </select>
          </label>
          {config.info_mode === "custom"
            ? field(
                "拍摄信息",
                "info_text",
                "50mm · f/2 · 1/250s · ISO 400",
                240,
              )
            : config.info_mode === "auto" && (
                <>
                  {(
                    [
                      ["show_camera", "相机"],
                      ["show_lens", "镜头"],
                      ["show_exposure", "焦距 / 光圈 / 快门 / ISO"],
                    ] as const
                  ).map(([key, label]) => (
                    <label className="border-check" key={key}>
                      <input
                        type="checkbox"
                        checked={config[key]}
                        onChange={(e) => update({ [key]: e.target.checked })}
                      />
                      {label}
                    </label>
                  ))}
                  <p className="border-info">
                    {[info?.camera, info?.exposure]
                      .filter(Boolean)
                      .join(" · ") || "缺失的拍摄参数不会虚构，可改为自定义。"}
                  </p>
                </>
              )}
        </>
      )}
      <p className="border-note">
        片边保存在当前照片中。导出选择“按照片片边设置”即可；原始文件和 RAW
        母版不添加片边。
      </p>
    </fieldset>
  );
}
