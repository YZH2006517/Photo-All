// SPDX-License-Identifier: GPL-3.0-or-later
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowDownToLine,
  ArrowUp,
  ArrowDown,
  Plus,
  Eye,
  EyeOff,
  Trash2,
  Layers,
  Undo2,
  Redo2,
  Check,
  LoaderCircle,
} from "lucide-react";
import {
  api,
  compositeBlob,
  CompositeDocument,
  Layer,
  Photo,
  pickFolder,
} from "./model";

const blends: Record<string, string> = {
  normal: "正常",
  multiply: "正片叠底",
  screen: "滤色",
  overlay: "叠加",
  darken: "变暗",
  lighten: "变亮",
};

export function Composite({
  initial,
  photos,
  saveRef,
  onSaved,
  onBack,
  onExport,
  notify,
}: {
  initial: CompositeDocument;
  photos: Photo[];
  saveRef: React.MutableRefObject<null | (() => Promise<void>)>;
  onSaved: (doc: CompositeDocument) => void;
  onBack: () => void;
  onExport: (doc: CompositeDocument, folder: string) => Promise<void>;
  notify: (s: string) => void;
}) {
  const [document, setDocument] = useState(initial),
    docRef = useRef(initial);
  const [active, setActive] = useState(Math.max(0, initial.layers.length - 1)),
    [picker, setPicker] = useState(false);
  const [url, setUrl] = useState(""),
    [previewing, setPreviewing] = useState(false),
    [error, setError] = useState("");
  const [saving, setSaving] = useState(false),
    [dirty, setDirty] = useState(!initial.id),
    [exporting, setExporting] = useState(false);
  const history = useRef<CompositeDocument[]>([]),
    future = useRef<CompositeDocument[]>([]),
    lastSaved = useRef(initial.id ? JSON.stringify(initial) : ""),
    inflight = useRef<Promise<void> | null>(null);
  const callbacks = useRef({ onSaved, notify });
  callbacks.current = { onSaved, notify };
  const replace = (next: CompositeDocument, record = true) => {
    if (record) {
      history.current = [...history.current.slice(-29), docRef.current];
      future.current = [];
    }
    docRef.current = next;
    setDocument(next);
    setDirty(JSON.stringify(next) !== lastSaved.current);
  };
  const save = useCallback(async function persist(): Promise<void> {
    if (inflight.current) {
      await inflight.current;
      return persist();
    }
    const snapshot = docRef.current,
      serialized = JSON.stringify(snapshot);
    if (serialized === lastSaved.current) return;
    setSaving(true);
    const task = (async () => {
      const saved = await api<CompositeDocument>("/composites", snapshot);
      lastSaved.current = JSON.stringify(saved);
      const current =
        JSON.stringify(docRef.current) === serialized
          ? saved
          : { ...docRef.current, id: saved.id };
      docRef.current = current;
      setDocument(current);
      setDirty(JSON.stringify(current) !== lastSaved.current);
      callbacks.current.onSaved(saved);
    })();
    inflight.current = task;
    try {
      await task;
    } finally {
      inflight.current = null;
      setSaving(false);
    }
    if (JSON.stringify(docRef.current) !== lastSaved.current) return persist();
  }, []);
  useEffect(() => {
    saveRef.current = save;
    return () => {
      saveRef.current = null;
    };
  }, [save, saveRef]);
  useEffect(() => {
    if (!dirty) return;
    const timer = setTimeout(
      () =>
        save().catch((e) =>
          callbacks.current.notify(`合成未保存：${e.message}`),
        ),
      750,
    );
    return () => clearTimeout(timer);
  }, [document, dirty, save]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setPreviewing(true);
      setError("");
      compositeBlob(document, controller.signal)
        .then((blob) => {
          if (!controller.signal.aborted) {
            setUrl(URL.createObjectURL(blob));
            setPreviewing(false);
          }
        })
        .catch((e) => {
          if (!controller.signal.aborted) {
            setError(e.message);
            setPreviewing(false);
          }
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [document]);
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );
  const layer = document.layers[active];
  const patch = (patch: Partial<Layer>, record = true) =>
    replace(
      {
        ...docRef.current,
        layers: docRef.current.layers.map((l, i) =>
          i === active ? { ...l, ...patch } : l,
        ),
      },
      record,
    );
  const move = (delta: number) => {
    const next = [...document.layers];
    const index = active + delta;
    if (index < 0 || index >= next.length) return;
    [next[active], next[index]] = [next[index], next[active]];
    replace({ ...document, layers: next });
    setActive(index);
  };
  const back = async () => {
    try {
      await save();
      onBack();
    } catch (e) {
      notify(`合成未保存：${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const undo = () => {
    const previous = history.current.pop();
    if (previous) {
      future.current.push(docRef.current);
      replace({ ...previous, id: docRef.current.id }, false);
      setActive(Math.max(0, Math.min(active, previous.layers.length - 1)));
    }
  };
  const redo = () => {
    const next = future.current.pop();
    if (next) {
      history.current.push(docRef.current);
      replace({ ...next, id: docRef.current.id }, false);
      setActive(Math.max(0, Math.min(active, next.layers.length - 1)));
    }
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        (event.target as HTMLElement).matches(
          'input:not([type="range"]),select,textarea',
        )
      )
        return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
      }
      if (event.key === "Escape") void back();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty || inflight.current) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const drag = useRef<{
    x: number;
    y: number;
    layerX: number;
    layerY: number;
    ratio: number;
  } | null>(null);
  const down = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!layer || !layer.visible || event.button !== 0) return;
    const image = event.currentTarget.querySelector("img");
    if (!image) return;
    const rect = image.getBoundingClientRect();
    history.current = [...history.current.slice(-29), docRef.current];
    future.current = [];
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      layerX: layer.x,
      layerY: layer.y,
      ratio: document.width / rect.width,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const slider = (
    key: "opacity" | "scale" | "rotation" | "x" | "y",
    label: string,
    min: number,
    max: number,
    step: number,
  ) => (
    <label className="slider-row" key={key}>
      <span>
        {label}
        <output>
          {key === "opacity"
            ? Math.round(layer[key] * 100) + "%"
            : Math.round(layer[key] * 100) / 100}
        </output>
      </span>
      <input
        type="range"
        aria-label={`图层${label}`}
        min={min}
        max={max}
        step={step}
        value={layer[key]}
        onChange={(e) => patch({ [key]: Number(e.target.value) })}
      />
    </label>
  );
  return (
    <section className="composite-workspace">
      <div className="editor-top">
        <button
          className="back-button"
          aria-label="返回图集照片"
          onClick={back}
        >
          <ArrowLeft size={17} />
          返回照片
        </button>
        <div className="editor-title">
          <h2>多图层合成</h2>
          <span>本地合成 · float32 sRGB · 原图只读</span>
        </div>
        <div className="composite-top-actions">
          <span className="composite-save-status">
            {saving ? (
              <LoaderCircle size={13} className="spin" />
            ) : (
              <Check size={13} />
            )}{" "}
            {saving ? "保存中" : dirty ? "有未保存修改" : "已保存"}
          </span>
          <button
            className="button secondary"
            onClick={() =>
              save()
                .then(() => notify("合成已保存"))
                .catch((e) => notify(e.message))
            }
          >
            保存合成
          </button>
          <button
            className="button primary"
            disabled={exporting}
            onClick={async () => {
              setExporting(true);
              try {
                await save();
                const folder = await pickFolder();
                if (folder) await onExport(docRef.current, folder);
              } catch (e) {
                notify(e instanceof Error ? e.message : String(e));
              } finally {
                setExporting(false);
              }
            }}
          >
            <ArrowDownToLine size={15} />
            导出 16-bit PNG
          </button>
        </div>
      </div>
      <div className="composite-body">
        <div className="composite-center">
          <div className="composite-canvas-heading">
            <input
              aria-label="合成名称"
              value={document.name}
              maxLength={80}
              onChange={(e) => replace({ ...document, name: e.target.value })}
            />
            <span>
              {document.width} × {document.height}
            </span>
            <button
              title="撤销合成修改"
              onClick={undo}
              disabled={!history.current.length}
            >
              <Undo2 size={16} />
              撤销
            </button>
            <button
              title="重做合成修改"
              onClick={redo}
              disabled={!future.current.length}
            >
              <Redo2 size={16} />
              重做
            </button>
          </div>
          <div
            className="composite-preview"
            onPointerDown={down}
            onPointerMove={(e) => {
              const d = drag.current;
              if (d)
                patch(
                  {
                    x: Math.round(d.layerX + (e.clientX - d.x) * d.ratio),
                    y: Math.round(d.layerY + (e.clientY - d.y) * d.ratio),
                  },
                  false,
                );
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
          >
            {url && <img alt="合成画布" src={url} draggable={false} />}{" "}
            {!url && previewing && <LoaderCircle className="spin" size={28} />}
            {previewing && url && (
              <span className="preview-status">正在更新预览…</span>
            )}
            {error && (
              <span className="composite-error" role="alert">
                {error}
              </span>
            )}
          </div>
          <div className="composite-hint">
            <Layers size={14} /> 选中图层后拖动画面移动位置，透明区域将保留到
            PNG。
          </div>
          {picker && (
            <div className="layer-picker">
              <div>
                <strong>从当前图集添加图层</strong>
                <button onClick={() => setPicker(false)}>完成</button>
              </div>
              {photos.map((p) => (
                <button
                  key={p.id}
                  disabled={document.layers.length >= 24}
                  onClick={() => {
                    const next: Layer = {
                      photo_id: p.id,
                      visible: true,
                      opacity: 1,
                      blend: "normal",
                      x: 0,
                      y: 0,
                      scale: 1,
                      rotation: 0,
                      recipe: { ...p.recipe },
                    };
                    replace({
                      ...document,
                      layers: [...document.layers, next],
                    });
                    setActive(document.layers.length);
                  }}
                >
                  <Plus size={13} />
                  {p.name}
                </button>
              ))}
            </div>
          )}
        </div>
        <aside className="composite-inspector">
          <div className="composite-layer-title">
            <span>
              <Layers size={16} /> 图层 <b>{document.layers.length}</b>
            </span>
            <button
              title="添加照片图层"
              onClick={() => setPicker(!picker)}
              disabled={document.layers.length >= 24}
            >
              <Plus size={18} />
            </button>
          </div>
          <div className="layers-list">
            {document.layers
              .map((l, index) => ({ l, index }))
              .reverse()
              .map(({ l, index }) => (
                <div
                  className={`layer-row ${active === index ? "active" : ""}`}
                  key={index}
                >
                  <button
                    aria-label={`${l.visible ? "隐藏" : "显示"}图层 ${index + 1}`}
                    onClick={() =>
                      replace({
                        ...document,
                        layers: document.layers.map((p, i) =>
                          i === index ? { ...p, visible: !p.visible } : p,
                        ),
                      })
                    }
                  >
                    {l.visible ? <Eye size={15} /> : <EyeOff size={15} />}
                  </button>
                  <button
                    className="layer-name"
                    onClick={() => setActive(index)}
                  >
                    <span>
                      {photos.find((p) => p.id === l.photo_id)?.name || "照片"}
                    </span>
                    <small>
                      {blends[l.blend]} · {Math.round(l.opacity * 100)}%
                    </small>
                  </button>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                </div>
              ))}
          </div>
          <div className="layer-order">
            <button
              title="图层上移"
              onClick={() => move(1)}
              disabled={active >= document.layers.length - 1}
            >
              <ArrowUp size={15} />
            </button>
            <button
              title="图层下移"
              onClick={() => move(-1)}
              disabled={active <= 0}
            >
              <ArrowDown size={15} />
            </button>
            <button
              title="删除当前图层"
              disabled={!layer}
              onClick={() => {
                replace({
                  ...document,
                  layers: document.layers.filter((_, i) => i !== active),
                });
                setActive(Math.max(0, active - 1));
              }}
            >
              <Trash2 size={15} />
            </button>
          </div>
          {layer ? (
            <div className="layer-settings">
              <label className="field-label">
                混合模式
                <select
                  aria-label="图层混合模式"
                  value={layer.blend}
                  onChange={(e) => patch({ blend: e.target.value })}
                >
                  {Object.entries(blends).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {slider("opacity", "透明度", 0, 1, 0.01)}
              {slider("scale", "缩放", 0.05, 5, 0.01)}
              {slider("rotation", "旋转", -180, 180, 1)}
              {slider("x", "水平位置", -document.width, document.width, 1)}
              {slider("y", "垂直位置", -document.height, document.height, 1)}
              <button
                className="reset-link"
                onClick={() =>
                  patch({
                    x: 0,
                    y: 0,
                    scale: 1,
                    rotation: 0,
                    opacity: 1,
                    blend: "normal",
                  })
                }
              >
                重置此图层
              </button>
            </div>
          ) : (
            <p className="layer-empty">点击 + 添加一张照片</p>
          )}
          <p className="composite-engine-note">
            独立实现的合成工作区
            <br />
            参考 Compositor 图层工作流，当前支持 6 种混合模式。
          </p>
        </aside>
      </div>
    </section>
  );
}
