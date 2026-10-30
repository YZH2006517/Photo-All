import { describe, expect, it } from "vitest";

describe("precision editor workspace contracts", () => {
  it("offers a single composition tool and omits retired advanced tool entries", async () => {
    const { editorTools } = await import("../product/ui/Editor");
    expect(editorTools.map(({ id, label }) => [id, label])).toEqual([
      ["composition", "构图"],
      ["adjust", "调节"],
      ["filters", "滤镜"],
      ["film", "胶片模拟"],
      ["raw", "RAW 显影"],
    ]);
  });
  it("routes keyboard tools through the simplified tool set", async () => {
    const { editorToolShortcut } = await import("../product/ui/Editor");
    expect(editorToolShortcut("C")).toBe("composition");
    expect(editorToolShortcut("h")).toBeNull();
    expect(editorToolShortcut("l")).toBe("adjust");
    expect(editorToolShortcut("u")).toBe("adjust");
    expect(editorToolShortcut("s")).toBe("adjust");
    expect(editorToolShortcut("k")).toBe("filters");
    expect(editorToolShortcut("g")).toBe("film");
    expect(editorToolShortcut("r")).toBe("raw");
    expect(editorToolShortcut("b")).toBeNull();
  });
  it("provides the independent editing workspace", async () => {
    const { EditorWorkspace } = await import("../product/ui/Editor");
    expect(typeof EditorWorkspace).toBe("function");
  });
  it("maps the cropped and rotated view back to original source coordinates", async () => {
    const { geometryToSource } = await import("../product/ui/Editor");
    expect(geometryToSource(0.25, 0.75, 400, 200, {})).toEqual({
      x: 0.25,
      y: 0.75,
    });
    expect(geometryToSource(0, 0, 400, 200, { quarter_turns: 1 })).toEqual({
      x: 0,
      y: 1,
    });
    expect(
      geometryToSource(0.5, 0.5, 400, 200, {
        crop_x: 0.25,
        crop_y: 0.1,
        crop_w: 0.5,
        crop_h: 0.5,
      }),
    ).toEqual({ x: 0.5, y: 0.35 });
    const flipped = geometryToSource(0.2, 0.7, 400, 200, {
      flip_x: 1,
      flip_y: 1,
    });
    expect(flipped.x).toBeCloseTo(0.8);
    expect(flipped.y).toBeCloseTo(0.3);
  });
  it("uses the backend pixel-edge rounding including half-to-even ties", async () => {
    const { geometryToSource } = await import("../product/ui/Editor");
    expect(
      geometryToSource(0, 0, 10, 10, {
        crop_x: 0.25,
        crop_y: 0.15,
        crop_w: 0.5,
        crop_h: 0.5,
      }),
    ).toEqual({ x: 0.2, y: 0.2 });
  });
  it("fits an aspect crop inside source bounds and preserves the ratio in pixels", async () => {
    const { aspectCrop } = await import("../product/ui/Editor");
    const crop = aspectCrop({ x: 0.1, y: 0.2, w: 0.8, h: 0.7 }, 1, 400, 200);
    expect(crop.w * 400).toBeCloseTo(crop.h * 200);
    expect(crop.x).toBeGreaterThanOrEqual(0);
    expect(crop.x + crop.w).toBeLessThanOrEqual(1);
  });
  it("keeps tiny crop drags inside the backend minimum one-percent range", async () => {
    const { aspectCrop } = await import("../product/ui/Editor");
    const crop = aspectCrop(
      { x: 0.998, y: 0.998, w: 0.002, h: 0.002 },
      0,
      400,
      200,
    );
    expect(crop.w).toBeGreaterThanOrEqual(0.01);
    expect(crop.h).toBeGreaterThanOrEqual(0.01);
    expect(crop.x + crop.w).toBeLessThanOrEqual(1);
    expect(crop.y + crop.h).toBeLessThanOrEqual(1);
  });
  it("keeps curve anchors fixed in x and serializes strictly ordered linear points", async () => {
    const { moveCurvePoint } = await import("../product/ui/Editor");
    expect(
      moveCurvePoint(
        [
          [0, 0],
          [0.5, 0.5],
          [1, 1],
        ],
        0,
        0.2,
        0.1,
      )[0],
    ).toEqual([0, 0.1]);
    const points = moveCurvePoint(
      [
        [0, 0],
        [0.5, 0.5],
        [0.6, 0.6],
        [1, 1],
      ],
      1,
      0.8,
      0.9,
    );
    expect(points[1][0]).toBeLessThan(points[2][0]);
  });
  it("rejects brush stamps outside source bounds and bounds operations to 256", async () => {
    const { appendOperations } = await import("../product/ui/Editor");
    const old = Array.from({ length: 255 }, () => ({ x: 0.2, y: 0.2 }));
    expect(
      appendOperations(old, [
        { x: -0.2, y: 0.2 },
        { x: 0.3, y: 0.4 },
        { x: 0.4, y: 0.4 },
      ]),
    ).toHaveLength(256);
    expect(appendOperations([], [{ x: NaN, y: 0.2 }])).toEqual([]);
  });
  it("owns undo and redo keyboard shortcuts when the global editor handler is bypassed", async () => {
    const { historyShortcut } = await import("../product/ui/Editor");
    expect(historyShortcut("z", true, false)).toBe("undo");
    expect(historyShortcut("z", true, true)).toBe("redo");
    expect(historyShortcut("y", true, false)).toBe("redo");
    expect(historyShortcut("z", false, false)).toBeNull();
  });
  it("requires both the saved geometry and the pixels actually on screen before editing coordinates", async () => {
    const { geometryInteractionReady } = await import("../product/ui/Editor");
    const before = { quarter_turns: 0 },
      after = { quarter_turns: 1 };
    const signature = JSON.stringify([1, 0, 0, 0, 0, 0, 1, 1]);
    expect(
      geometryInteractionReady(after, before, signature, true, false),
    ).toBe(false);
    expect(
      geometryInteractionReady(
        after,
        after,
        JSON.stringify([0, 0, 0, 0, 0, 0, 1, 1]),
        true,
        false,
      ),
    ).toBe(false);
    expect(
      geometryInteractionReady(after, after, signature, false, false),
    ).toBe(false);
    expect(geometryInteractionReady(after, after, signature, true, false)).toBe(
      true,
    );
    expect(
      geometryInteractionReady(
        { ...after, crop_w: 0.5 },
        { ...after, crop_w: 0.5 },
        signature,
        true,
        true,
      ),
    ).toBe(true);
  });
});

describe("direct numeric entry", () => {
  it("accepts finite typed values, clamps limits and leaves invalid input unchanged", async () => {
    const { numericEntry } = await import("../product/ui/Film");
    expect(numericEntry("0.37", 0.2, -1, 1)).toBe(0.37);
    expect(numericEntry("99", 0.2, -1, 1)).toBe(1);
    expect(numericEntry("-9", 0.2, -1, 1)).toBe(-1);
    for (const invalid of ["", " ", "NaN", "Infinity", "oops"])
      expect(numericEntry(invalid, 0.2, -1, 1)).toBe(0.2);
  });
});

it("preserves typed precision beyond a slider step in the numeric readout", async () => {
  const { numericText } = await import("../product/ui/Film");
  expect(numericText(0.371, 0.01)).toBe("0.371");
  expect(numericText(0.911, 0.01)).toBe("0.911");
  expect(numericText(0.3, 0.01)).toBe("0.30");
  expect(numericText(6500, 100)).toBe("6500");
});
