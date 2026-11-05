import { describe, it, expect } from "vitest";
import {
  newMix,
  addDose,
  creativeRecipe,
  creativePatch,
  restoreMix,
  dragDial,
  SERUMS,
  processAction,
  processTimeline,
  orbitView,
  developmentStep,
} from "../product/ui/WetLab";
const base = {
  exposure: 0.3,
  contrast: 1.1,
  temperature: 0.1,
  saturation: 0.9,
  film_stock: "none",
  film_strength: 1,
  crop_x: 0.12,
  crop_y: 0.04,
  crop_w: 0.6,
  crop_h: 0.8,
  raw_exposure: 0.4,
  border: "saved",
  filter_stack: "[]",
};
describe("creative darkroom recipe controls", () => {
  it("keeps contrast inside the same bounds accepted by the precision engine", () => {
    for (const contrast of [0.5, 1.5])
      for (const timer of [0, 1]) {
        const recipe = creativeRecipe(
          { ...base, contrast },
          { ...addDose(newMix(), "soft", 1), timer },
        );
        expect(Number(recipe.contrast)).toBeGreaterThanOrEqual(0.5);
        expect(Number(recipe.contrast)).toBeLessThanOrEqual(1.5);
      }
  });
  it("starts neutral and does not modify unrelated recipe fields", () => {
    const r = creativeRecipe(base, newMix());
    expect(r).toEqual(base);
    const mixed = creativeRecipe(base, addDose(newMix(), "warm", 0.5));
    for (const key of [
      "crop_x",
      "crop_y",
      "crop_w",
      "crop_h",
      "raw_exposure",
      "border",
      "filter_stack",
    ])
      expect(mixed[key]).toBe(base[key as keyof typeof base]);
  });
  it("clamps doses and total cup capacity including invalid input", () => {
    let m = newMix();
    for (const item of SERUMS) m = addDose(m, item.id, 100);
    expect(
      Object.values(m.doses).reduce((a, b) => a + b, 0),
    ).toBeLessThanOrEqual(2.4 + 1e-8);
    expect(addDose(m, "warm", NaN)).toEqual(m);
    expect(addDose(newMix(), "warm", -5)).toEqual(newMix());
  });
  it("shows a monotonic warm/cool and density response", () => {
    const warm = creativeRecipe(base, addDose(newMix(), "warm", 0.8));
    const cool = creativeRecipe(base, addDose(newMix(), "cyan", 0.8));
    expect(Number(warm.temperature)).toBeGreaterThan(Number(cool.temperature));
    expect(creativeRecipe(base, { ...newMix(), timer: 0.9 })).toEqual(
      creativeRecipe(base, { ...newMix(), timer: 0.1 }),
    );
  });
  it("uses an explicit film base for grain and halation", () => {
    const m = addDose({ ...newMix(), stock: "kodak_portra_400" }, "grain", 0.6);
    const r = creativeRecipe(base, m);
    expect(r.film_stock).toBe("kodak_portra_400");
    expect(Number(r.film_grain)).toBeGreaterThan(0);
    expect(
      creativeRecipe(base, addDose(newMix(), "grain", 0.6)).film_stock,
    ).toBe("none");
  });
  it("saves only touched controls and keeps source geometry out of the patch", () => {
    expect(creativePatch(base, newMix())).toEqual({});
    const patch = creativePatch(base, addDose(newMix(), "warm", 0.5));
    expect(patch.temperature).toBeDefined();
    expect(patch.crop_x).toBeUndefined();
    expect(patch.raw_exposure).toBeUndefined();
    expect(patch.border).toBeUndefined();
  });
  it("drags a dial through the wrap boundary without a sudden jump", () => {
    expect(dragDial(0.5, 179, -179)).toBeCloseTo(0.5 + 2 / 270, 8);
    expect(dragDial(0.5, -179, 179)).toBeCloseTo(0.5 - 2 / 270, 8);
    expect(dragDial(0.99, 0, 90)).toBe(1);
    expect(dragDial(0.01, 90, 0)).toBe(0);
  });
  it("sanitizes stored creative drafts instead of restoring process timers", () => {
    const m = restoreMix({
      stock: "bogus",
      timer: Infinity,
      warmth: -4,
      concentration: 100,
      doses: { warm: 10, cyan: -2, unknown: 1 },
    });
    expect(m.stock).toBe("inherit");
    expect(m.timer).toBe(0.5);
    expect(m.warmth).toBe(0);
    expect(m.concentration).toBe(1);
    expect(m.doses.warm).toBe(1);
    expect(m.doses.cyan).toBe(0);
    expect(m.doses).not.toHaveProperty("unknown");
  });
});

describe("physical darkroom actions", () => {
  it("pours before closing and agitating, and drains only afterwards", () => {
    expect(processTimeline(0.12).phase).toBe("pour");
    expect(processTimeline(0.04).cupTravel).toBe(0);
    expect(processTimeline(0.15).lidOpen).toBe(1);
    expect(processTimeline(0.18).transfer).toBeGreaterThan(0);
    expect(processTimeline(0.23).lidOpen).toBe(1);
    expect(processTimeline(0.29).cupReturn).toBe(1);
    expect(processTimeline(0.26).phase).toBe("seal");
    expect(processTimeline(0.5).phase).toBe("agitate");
    expect(processTimeline(0.86).phase).toBe("drain");
    expect(processTimeline(0.86).lidOpen).toBe(1);
    expect(processTimeline(1).phase).toBe("done");
    expect(processTimeline(0.12).agitate).toBe(0);
    expect(processTimeline(0.5).lidOpen).toBe(0);
    expect(processTimeline(0).drain).toBe(0);
  });
  it("physical agitation and bath exposure alter actual recipe parameters", () => {
    const start = newMix(),
      shaken = processAction(start, "agitation", 0.6),
      soaked = processAction(shaken, "bath", 0.6);
    expect(Number(creativeRecipe(base, shaken).contrast)).toBeGreaterThan(
      Number(creativeRecipe(base, start).contrast),
    );
    expect(Number(creativeRecipe(base, soaked).exposure)).toBeGreaterThan(
      Number(creativeRecipe(base, shaken).exposure),
    );
    expect(start.agitation).toBe(0);
    expect(start.bath).toBe(0);
    expect(processAction(soaked, "bath", 100).bath).toBe(1);
    expect(processAction(soaked, "bath", NaN)).toEqual(soaked);
    expect(restoreMix({ ...soaked, agitation: 100, bath: -4 })).toMatchObject({
      agitation: 1,
      bath: 0,
    });
  });
});

it("keeps immersion exposure within the precision engine range", () => {
  const result = creativeRecipe(
    { ...base, exposure: 2 },
    processAction(newMix(), "bath", 1),
  );
  expect(Number(result.exposure)).toBeLessThanOrEqual(2);
});

describe("timed development and bounded camera", () => {
  it("setting time alone never changes the photo, development changes it gradually", () => {
    const planned = { ...newMix(), timer: 0.9 };
    expect(creativeRecipe(base, planned)).toEqual(base);
    const half = developmentStep(planned, 0, 0.5, 0.9),
      done = developmentStep(half, 0.5, 1, 0.9);
    expect(Number(creativeRecipe(base, half).contrast)).toBeGreaterThan(
      base.contrast,
    );
    expect(Number(creativeRecipe(base, done).contrast)).toBeGreaterThan(
      Number(creativeRecipe(base, half).contrast),
    );
    expect(developmentStep(newMix(), 0, 1, 0.9).development).toBeGreaterThan(
      developmentStep(newMix(), 0, 1, 0.1).development,
    );
    expect(developmentStep(done, 0.5, 0.5, 0.9)).toEqual(done);
  });
  it("bounds middle-button viewing angles and ignores invalid input", () => {
    expect(orbitView({ yaw: 0, pitch: 0 }, 10000, 10000)).toEqual({
      yaw: 0.32,
      pitch: 0.18,
    });
    expect(orbitView({ yaw: 0, pitch: 0 }, -10000, -10000)).toEqual({
      yaw: -0.32,
      pitch: -0.18,
    });
    expect(orbitView({ yaw: 0, pitch: 0 }, NaN, Infinity)).toEqual({
      yaw: 0,
      pitch: 0,
    });
  });
});
