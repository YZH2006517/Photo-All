import { describe, expect, it } from "vitest";
import {
  darkroomRolls,
  darkroomFramePage,
  darkroomMotion,
  darkroomPerforations,
  DARKROOM_FILM,
  DARKROOM_DURATION,
  darkroomZoom,
  darkroomFeed,
  darkroomScreenPower,
} from "../product/ui/Darkroom";
import type { Album, Photo } from "../product/ui/model";

const album = (id: number, trashed_at: number | null = null) =>
  ({ id, name: `卷 ${id}`, created: id, count: 99, trashed_at }) as Album;
const photo = (
  id: number,
  album_ids: number[],
  captured = id,
  path = `C:/photos/${id}.jpg`,
) =>
  ({
    id,
    album_ids,
    captured,
    path,
    name: path.split("/").at(-1),
    width: 600,
    height: 400,
    recipe: {},
    features: {},
    digest: String(id),
    decision: "pending",
  }) as Photo;

describe("independent darkroom roll data", () => {
  it("derives real membership and excludes trashed albums without changing library data", () => {
    const library = {
      albums: [album(1), album(2, 123), album(3)],
      photos: [photo(1, [1, 2], 4), photo(2, [1], 2), photo(1, [1, 2], 4)],
    };
    const original = JSON.stringify(library);
    const rolls = darkroomRolls(library);
    expect(rolls.map((roll) => roll.album.id)).toEqual([1, 3]);
    expect(rolls[0].photos.map((p) => p.id)).toEqual([2, 1]);
    expect(rolls[1].photos).toEqual([]);
    expect(JSON.stringify(library)).toBe(original);
  });
  it("prefers JPEG for RAW pairs but preserves unpaired RAW photos", () => {
    const rolls = darkroomRolls({
      albums: [album(1)],
      photos: [
        photo(1, [1], 1, "C:/photos/A.NEF"),
        photo(2, [1], 1, "C:/photos/A.JPG"),
        photo(3, [1], 2, "C:/photos/B.NEF"),
      ],
    });
    expect(rolls[0].photos.map((p) => p.id)).toEqual([2, 3]);
  });
  it("splits each album into 36-frame rolls without omissions or library mutation", () => {
    const photos = Array.from({ length: 73 }, (_, i) => photo(i + 1, [1]));
    const library = { albums: [album(1)], photos },
      before = JSON.stringify(library);
    const rolls = darkroomRolls(library);
    expect(rolls.map((r) => r.photos.length)).toEqual([36, 36, 1]);
    expect(rolls.map((r) => r.key)).toEqual(["1:1", "1:2", "1:3"]);
    expect(rolls.flatMap((r) => r.photos.map((p) => p.id))).toEqual(
      photos.map((p) => p.id),
    );
    expect(rolls.every((r) => r.album.id === 1)).toBe(true);
    expect(JSON.stringify(library)).toBe(before);
    expect(
      darkroomRolls({ albums: [album(1)], photos: photos.slice(0, 13) })[0]
        .photos,
    ).toHaveLength(13);
    expect(
      darkroomRolls({ albums: [album(1)], photos: photos.slice(0, 36) }),
    ).toHaveLength(1);
  });
  it("contains every frame in a 36-frame strip and safely bounds selection", () => {
    const photos = Array.from({ length: 36 }, (_, i) => photo(i + 1, [1]));
    const strip = darkroomFramePage(photos, 31);
    expect(strip.photos).toHaveLength(36);
    expect(strip.start).toBe(0);
    expect(strip.pages).toBe(1);
    expect(darkroomFramePage(photos, 999).index).toBe(35);
    expect(darkroomFramePage(photos, -3).index).toBe(0);
  });
  it("handles empty rolls and invalid cursor values without invalid pages", () => {
    expect(darkroomFramePage([], 50)).toMatchObject({
      photos: [],
      start: 0,
      index: 0,
      page: 0,
      pages: 1,
    });
    expect(darkroomFramePage([photo(1, [1])], NaN)).toMatchObject({
      index: 0,
      page: 0,
      pages: 1,
    });
  });
});

describe("darkroom physical choreography", () => {
  it("feeds the whole film out of the cassette rather than revealing stationary pictures", () => {
    expect(darkroomFeed(12, 0)).toBe(-12);
    expect(darkroomFeed(12, 0.25)).toBe(-9);
    expect(darkroomFeed(12, 0.75)).toBe(-3);
    expect(darkroomFeed(12, 1)).toBe(0);
    expect(darkroomFeed(12, 1, -2)).toBe(-2);
    expect(darkroomFeed(12, 0, -2)).toBe(-12);
  });
  it("keeps the electronic screen completely off until a loaded slide has seated", () => {
    expect(darkroomScreenPower(0, true)).toBe(0);
    expect(darkroomScreenPower(0.99, true)).toBe(0);
    expect(darkroomScreenPower(1, false)).toBe(0);
    expect(darkroomScreenPower(1, true)).toBe(1);
  });
  it("plays the existing choreography at 125 percent speed", () => {
    expect(DARKROOM_DURATION).toBeCloseTo(4.8 / 1.25, 10);
  });
  it("zooms in and out with a mouse wheel without escaping safe camera distances", () => {
    expect(darkroomZoom(1, -120)).toBeGreaterThan(1);
    expect(darkroomZoom(1, 120)).toBeLessThan(1);
    expect(darkroomZoom(1, 0)).toBe(1);
    expect(darkroomZoom(1, -1e9)).toBeLessThanOrEqual(1.8);
    expect(darkroomZoom(1, 1e9)).toBeGreaterThanOrEqual(0.65);
    expect(darkroomZoom(NaN, NaN)).toBe(1);
  });
  it("lands the cassette before any film appears and introduces the paper later", () => {
    for (let i = 0; i <= 100; i++) {
      const motion = darkroomMotion(i / 100);
      if (motion.travel < 1) expect(motion.film).toBe(0);
      if (motion.film > 0) expect(motion.travel).toBe(1);
      if (motion.paper > 0) expect(motion.travel).toBe(1);
    }
    expect(darkroomMotion(0.32)).toMatchObject({
      travel: 1,
      film: 0,
      paper: 0,
    });
    expect(darkroomMotion(0.6).film).toBeGreaterThan(0);
    expect(darkroomMotion(0.6).paper).toBe(0);
    expect(darkroomMotion(1)).toMatchObject({ travel: 1, film: 1, paper: 1 });
  });
  it("can reverse the same path and safely clamps invalid progress", () => {
    expect(darkroomMotion(0)).toMatchObject({ travel: 0, film: 0, paper: 0 });
    expect(darkroomMotion(NaN)).toEqual(darkroomMotion(0));
    expect(darkroomMotion(-1)).toEqual(darkroomMotion(0));
    expect(darkroomMotion(9)).toEqual(darkroomMotion(1));
    const reverse = Array.from({ length: 101 }, (_, i) =>
      darkroomMotion(1 - i / 100),
    );
    expect(
      reverse.every((value, i) => !i || value.film <= reverse[i - 1].film),
    ).toBe(true);
  });
  it("places continuous sprocket holes on one global grid across all frame boundaries", () => {
    const positions = darkroomPerforations(
      DARKROOM_FILM.leader + 6 * DARKROOM_FILM.cell,
    );
    expect(positions.length).toBeGreaterThan(48);
    for (let i = 1; i < positions.length; i++)
      expect(positions[i] - positions[i - 1]).toBeCloseTo(
        DARKROOM_FILM.pitch,
        10,
      );
    expect(DARKROOM_FILM.height).toBeLessThan(DARKROOM_FILM.bodyHeight);
    expect(DARKROOM_FILM.frameWidth / DARKROOM_FILM.frameHeight).toBeCloseTo(
      1.5,
      8,
    );
  });
});
