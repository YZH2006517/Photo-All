// SPDX-License-Identifier: GPL-3.0-or-later
import React, { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, RotateCcw, Search } from "lucide-react";
import { type FilmSpectralControl, Library, Photo, Recipe, filmSelectionPatch, spectralRecipe } from "./model";

export function numericEntry(
  draft: string,
  previous: number,
  min: number,
  max: number,
) {
  const parsed = draft.trim() ? Number(draft) : NaN;
  return Number.isFinite(parsed)
    ? Math.max(min, Math.min(max, parsed))
    : previous;
}

export function numericText(value: number, step: number) {
  const decimals = (String(step).split(".")[1] || "").length;
  return value.toLocaleString("en-US", {
    useGrouping: false,
    minimumFractionDigits: decimals,
    maximumFractionDigits: 12,
  });
}

// A draft stays local until Enter or blur so each typed edit is one history step.
export function NumericValue({
  value,
  label,
  min,
  max,
  step = 0.01,
  disabled,
  onChange,
  unit = "",
}: {
  value: number;
  label: string;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  onChange: (value: number) => void;
  unit?: string;
}) {
  const format = (v: number) => numericText(v, step);
  const [draft, setDraft] = useState(format(value));
  const editing = useRef(false),
    cancelled = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(format(value));
  }, [value, step]);
  return (
    <span className="numeric-value">
      <input
        type="text"
        inputMode="decimal"
        aria-label={`${label}数值`}
        title={`输入${label}（${min}–${max}）`}
        value={draft}
        disabled={disabled}
        onFocus={() => {
          editing.current = true;
          cancelled.current = false;
        }}
        onChange={(e) => setDraft(e.target.value)}
        onPointerDown={(e) => e.stopPropagation()}
        onBlur={() => {
          editing.current = false;
          if (cancelled.current) {
            cancelled.current = false;
            return;
          }
          const next = numericEntry(draft, value, min, max);
          setDraft(format(next));
          if (next !== value) onChange(next);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            cancelled.current = true;
            setDraft(format(value));
            e.currentTarget.blur();
          }
        }}
      />
      {unit && <span>{unit}</span>}
    </span>
  );
}

function FilmValue({ field, value, disabled, change, scale = 1 }: {
  field: FilmSpectralControl;
  value: string | number;
  disabled: boolean;
  change: (value: string | number) => void;
  scale?: number;
}) {
  if ("options" in field) {
    return (
      <label className="film-property">
        <span>{field.label}</span>
        <select aria-label={field.label} value={String(value)} disabled={disabled} onChange={(event) => change(event.target.value)}>
          {Object.entries(field.options).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </label>
    );
  }
  return (
    <div className="film-parameter">
      <div className="film-parameter-heading">
        <span>{field.label}</span>
        <NumericValue label={field.label} min={field.min * scale} max={field.max * scale}
          step={Number((field.step * scale).toFixed(6))} value={Number(value) * scale}
          unit={field.unit} disabled={disabled} onChange={(next) => change(next / scale)} />
        <button type="button" aria-label={`重置${field.label}`} disabled={disabled || value === field.default}
          onClick={() => change(field.default)}><RotateCcw size={12} /></button>
      </div>
      <input type="range" aria-label={field.label} min={field.min} max={field.max} step={field.step}
        value={Number(value)} disabled={disabled} onChange={(event) => change(event.target.valueAsNumber)} />
    </div>
  );
}

const paperLabels: Record<string, string> = {
  kodak_portra_endura: "Kodak Professional Portra Endura",
  fujifilm_crystal_archive_typeii: "Fujifilm Crystal Archive Type II",
  kodak_2383: "Kodak Vision 2383",
};
const quickFields: FilmSpectralControl[] = [
  { key: "film_strength", label: "胶片强度", min: 0, max: 1, step: .01, default: .8, unit: "%" },
  { key: "film_grain", label: "附加颗粒", min: 0, max: 1, step: .01, default: .35, unit: "%" },
  { key: "film_halation", label: "附加光晕", min: 0, max: 1, step: .01, default: .15, unit: "%" },
];

export function FilmControls({ photo, catalog, update, disabled }: {
  photo: Photo;
  catalog: Library["film"];
  update: (patch: Recipe) => void;
  disabled: boolean;
}) {
  const radioName = useId();
  const [query, setQuery] = useState("");
  const [stockOpen, setStockOpen] = useState(true);
  const advanced = spectralRecipe(photo.recipe);
  const spectral = catalog.spectral;
  const current = String(advanced?.stock ?? photo.recipe.film_stock ?? "none");
  const stocks = advanced ? spectral?.stocks ?? {} : catalog.stocks;
  const active = stocks[current];
  const groups = Object.entries(stocks).reduce<Map<string, [string, typeof active][]>>((result, entry) => {
    const [id, stock] = entry;
    if (query && !`${stock.label} ${stock.family} ${id}`.toLowerCase().includes(query.trim().toLowerCase())) return result;
    const family = stock.family === "电影负片" || stock.family === "增感负片" || stock.family === "反转片"
      ? stock.family : "彩色负片";
    const list = result.get(family) ?? [];
    list.push(entry);
    return result.set(family, list);
  }, new Map());
  const setAdvanced = (changes: Recipe) => {
    const next = { ...advanced, ...changes };
    if (next.process === "negative" && spectral?.stocks[String(next.stock)]?.family === "反转片")
      next.stock = "kodak_portra_400";
    update({ film_advanced: JSON.stringify(next) });
  };
  const chooseStock = (id: string) => {
    if (advanced) setAdvanced({ stock: id });
    else update(filmSelectionPatch(id, photo.recipe));
  };
  const selectMode = (mode: "quick" | "advanced") => {
    if ((mode === "advanced") === !!advanced) return;
    setQuery("");
    if (mode === "quick") {
      update({ film_advanced: "", ...(catalog.stocks[current] ? { film_stock: current } : {}) });
    } else {
      const stock = spectral?.stocks[current] ? current : "kodak_portra_400";
      update({ film_advanced: JSON.stringify({ stock }),
        ...(current === "none" ? { film_strength: .8 } : {}) });
    }
  };
  const isScan = advanced?.process === "scan"
    || ((!advanced?.process || advanced.process === "auto") && active?.family === "反转片");
  const isNegative = advanced?.process === "negative";
  const isSlideScan = isScan && active?.family === "反转片";
  const paperId = String(advanced?.paper || active?.paper || "kodak_portra_endura");
  const paperControl = spectral?.groups["冲印"]?.find((field) => field.key === "paper");
  const paperName = paperControl && "options" in paperControl
    ? paperControl.options[paperId] : paperLabels[paperId];
  const fieldLocked = (group: string, key: string) => disabled || !spectral?.ready
    || (isScan && (["冲印", "预闪"].includes(group) || (group === "放大机滤色" && !isSlideScan)))
    || (isScan && key === "enlarger_light")
    || (key.startsWith("negative_base_") && !isNegative)
    || (isNegative && (["耦合剂", "光晕", "颗粒"].includes(group)
      || ["film_ev", "film_gamma", "film_fast", "film_slow", "film_exhaustion", "film_format",
        "scene_light", "scene_mode", "scene_kelvin", "film_light", "film_mode", "film_kelvin"].includes(key)))
    || (key.endsWith("_kelvin") && advanced?.[key.replace("_kelvin", "_mode")] !== "kelvin")
    || (["scene_light", "film_light", "scan_light"].includes(key) && advanced?.[key.replace("_light", "_mode")] === "kelvin")
    || (["filter_c", "filter_m", "filter_y"].includes(key) && advanced?.neutral !== "manual")
    || (key.startsWith("preflash_") && advanced?.preflash !== "on")
    || (group === "耦合剂" && key !== "couplers" && advanced?.couplers === "off")
    || (group === "光晕" && key !== "halation" && advanced?.halation !== "on")
    || (group === "颗粒" && key !== "grain" && advanced?.grain !== "on");
  const stockChoice = (id: string, label: string, unavailable = false) => (
    <label className="film-stock-choice" key={id}>
      <input type="radio" name={radioName} aria-label={label} checked={current === id}
        disabled={disabled || unavailable || (isNegative && stocks[id]?.family === "反转片")} onChange={() => chooseStock(id)} />
      <span className="film-stock-row">
        <span className="film-stock-indicator" aria-hidden="true"><Check size={12} /></span>
        <span className="film-stock-name">{label}</span>
      </span>
    </label>
  );
  return (
    <div className="film-controls film-workspace">
      <div className="film-mode" role="group" aria-label="胶片引擎">
        <button type="button" aria-pressed={!advanced} disabled={disabled} onClick={() => selectMode("quick")}>快速预设</button>
        <button type="button" aria-pressed={!!advanced} disabled={disabled || !spectral?.ready}
          onClick={() => selectMode("advanced")}>光谱工艺</button>
      </div>
      <div className="film-current">
        <strong>{active?.label || "胶片模拟关闭"}</strong>
        <small>{active ? <><span>{active.family}</span>
          {isScan ? " · 直接扫描" : paperName && <> · <span>{paperName}</span></>}</> : "选择片种开始"}</small>
      </div>
      {advanced && <p className="film-engine-note">Spektrafilm 光谱渲染 · 停止调节后刷新预览</p>}
      {isNegative && <p className="film-engine-note">使用未反相的负片扫描。片基参考为 0 时自动估计，也可输入未曝光片基的 RGB 读数。</p>}
      {!spectral?.ready && <p className="film-engine-note">光谱工艺需要完整的 Spektrafilm 运行时。</p>}
      <section className="film-group">
        <button className="film-group-toggle" type="button" aria-expanded={stockOpen} onClick={() => setStockOpen(!stockOpen)}>
          <ChevronDown size={14} />片种列表<span>{Object.keys(stocks).length}</span>
        </button>
        {stockOpen && <div className="film-stock-browser">
          <label className="film-search"><Search size={13} /><input aria-label="搜索片种" placeholder="搜索片种或系列"
            value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <fieldset className="film-catalog" aria-label="胶片型号">
            {!advanced && !query && stockChoice("none", "关闭胶片模拟")}
            {[...groups].map(([family, entries]) => (
              <div className="film-stock-group" role="group" aria-label={family} key={family}>
                <div className="film-stock-family">{family} <small>{entries.length}</small></div>
                {entries.map(([id, stock]) => stockChoice(id, stock.label, !advanced && !catalog.stocks[id]?.ready))}
              </div>
            ))}
            {!groups.size && <p className="film-engine-note">没有匹配的片种</p>}
          </fieldset>
        </div>}
      </section>
      {!advanced ? <section className="film-properties" aria-label="胶片调节">
        {quickFields.map((field) => <FilmValue key={field.key} field={field} scale={100}
          value={Number(photo.recipe[field.key] ?? field.default)} disabled={disabled || current === "none"}
          change={(value) => update({ [field.key]: value })} />)}
      </section> : <>
        <section className="film-properties" aria-label="胶片混合">
          <FilmValue field={quickFields[0]} scale={100} value={isNegative ? 1 : Number(photo.recipe.film_strength ?? .8)}
            disabled={disabled || isNegative} change={(value) => update({ film_strength: value })} />
        </section>
        {Object.entries(spectral?.groups ?? {}).map(([group, fields]) => (
          <details className="film-group" key={group}>
            <summary className="film-group-toggle"><ChevronDown size={14} />{group}<span>{fields.length}</span></summary>
            <section className="film-properties" aria-label={group}>
              {fields.map((field) => <FilmValue key={field.key} field={field}
                scale={"unit" in field && field.unit === "%" ? 100 : 1}
                value={advanced[field.key] ?? field.default} disabled={fieldLocked(group, field.key)}
                change={(value) => setAdvanced({ [field.key]: value })} />)}
            </section>
          </details>
        ))}
      </>}
      <details className="film-provenance">
        <summary>引擎与授权</summary>
        <p>{catalog.attribution}</p>
      </details>
    </div>
  );
}
