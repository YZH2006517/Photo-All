import React from "../product/node_modules/react/index.js";
import { renderToStaticMarkup } from "../product/node_modules/react-dom/server.node.js";
import { describe, expect, it } from "vitest";
import { Albums } from "../product/ui/Albums";

describe("album-local RAW/JPEG cover preference", () => {
  const photos = [
    { id: 1, name: "cross.jpg", path: "C:/shoot/cross.jpg", album_ids: [1] },
    { id: 2, name: "cross.NEF", path: "C:/shoot/cross.NEF", album_ids: [2] },
    { id: 3, name: "paired.NEF", path: "C:/shoot/paired.NEF", album_ids: [1] },
    { id: 4, name: "paired.jpg", path: "C:/shoot/paired.jpg", album_ids: [1] },
  ].map((photo) => ({
    ...photo,
    decision: "pending",
    features: {},
    recipe: {},
  }));
  for (const [variantMode, ids, count] of [
    ["all", [1, 3, 4, 2], 3],
    ["raw", [1, 3, 2], 2],
    ["jpeg", [1, 4, 2], 2],
  ] as const) {
    it(`renders ${variantMode} within each album without hiding an unpaired member`, () => {
      const seen: number[] = [];
      const html = renderToStaticMarkup(
        React.createElement(Albums, {
          library: {
            photos,
            albums: [
              { id: 1, name: "JPEG album", count: 3 },
              { id: 2, name: "RAW album", count: 1 },
            ],
            trash_albums: [],
          } as any,
          variantMode,
          open: () => {},
          create: async () => {},
          busy: false,
          review: () => {},
          removeAlbum: () => {},
          restoreAlbum: () => {},
          Picture: ({ photo }: any) => {
            seen.push(photo.id);
            return React.createElement("span", null, photo.name);
          },
        }),
      );
      expect(seen).toEqual(ids);
      expect(html).toContain(`class="album-count">${count} 张照片`);
    });
  }
});
