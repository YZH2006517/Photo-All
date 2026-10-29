// SPDX-License-Identifier: GPL-3.0-or-later
import React from "react";
import { Film, Check, Sparkles } from "lucide-react";
import { Library, Photo, Recipe } from "./model";

export function FilmControls({
  photo,
  catalog,
  update,
  disabled,
}: {
  photo: Photo;
  catalog: Library["film"];
  update: (patch: Recipe) => void;
  disabled: boolean;
}) {
  const current = String(photo.recipe.film_stock || "none");
  const families = [
    ...new Set(Object.values(catalog.stocks).map((stock) => stock.family)),
  ];
  const ready = Object.values(catalog.stocks).filter(
    (stock) => stock.ready,
  ).length;
  const range = (key: string, label: string) => (
    <label className="slider-row">
      <span>
        {label}
        <output>{Math.round(Number(photo.recipe[key] || 0) * 100)}%</output>
      </span>
      <input
        aria-label={label}
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={Number(photo.recipe[key] || 0)}
        disabled={disabled || current === "none"}
        onChange={(e) => update({ [key]: Number(e.target.value) })}
      />
    </label>
  );
  return (
    <div className="film-controls">
      <div className="film-engine-card">
        <span>
          <Film size={18} />
        </span>
        <div>
          <strong>胶片暗房</strong>
            <small>spektrafilm · 胶片色彩</small>
        </div>
        <b>{ready} 款</b>
      </div>
      <p className="film-description">
        胶片负片、相纸与扫描色彩，由官方光谱模型生成
        LUT，在当前基础调色之后应用。
      </p>
      <label className="field-label">
        胶片型号
        <select
          aria-label="胶片型号"
          value={current}
          onChange={(e) => update({ film_stock: e.target.value })}
          disabled={disabled}
        >
          <option value="none">关闭胶片模拟</option>
          {families.map((family) => (
            <optgroup label={family} key={family}>
              {Object.entries(catalog.stocks)
                .filter(([, stock]) => stock.family === family)
                .map(([id, stock]) => (
                  <option key={id} value={id} disabled={!stock.ready}>
                    {stock.label}
                    {stock.ready ? "" : " · 未准备"}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </label>
      <div className="film-quick-picks">
        {[
          "kodak_portra_400",
          "kodak_gold_200",
          "fujifilm_pro_400h",
          "kodak_vision3_500t",
        ]
          .filter((id) => catalog.stocks[id])
          .map((id) => (
            <button
              key={id}
              disabled={disabled || !catalog.stocks[id].ready}
              className={current === id ? "active" : ""}
              onClick={() => update({ film_stock: id })}
            >
              <span
                className={`film-stock-swatch ${id.startsWith("fuji") ? "fuji" : id.includes("vision") ? "cinema" : ""}`}
              >
                {current === id ? <Check size={14} /> : <Film size={14} />}
              </span>
              <span>{catalog.stocks[id].label}</span>
            </button>
          ))}
      </div>
      <div className="film-adjustments">
        {range("film_strength", "胶片强度")}
        {range("film_grain", "附加颗粒")}
        {range("film_halation", "附加光晕")}
      </div>
      <div className="film-provenance">
        <Sparkles size={13} />
        <p>
          色彩：spektrafilm by Andrea Volpato
          <br />
          颗粒、光晕：Photo All 的确定性附加效果
          <br />
          色彩配置 / LUT：CC BY-SA 4.0
        </p>
      </div>
      {!ready && (
        <p className="film-description">
          胶片资源未准备。请在产品目录运行 <code>python film.py --setup</code>
          ，完成后重启软件。
        </p>
      )}
    </div>
  );
}
