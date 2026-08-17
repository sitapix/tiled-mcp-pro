import { TiledMcpError } from "../errors.js";
import { decodeGid } from "../maps/gid.js";
import {
  MAX_ISOMETRIC_RENDER_PIXELS,
  type IsometricRenderLayer,
} from "./isometricPreview.js";
import { type NativePreviewAtlas } from "./mapPreview.js";

/**
 * Composites the tile layers of one oblique region with the exact Tiled
 * 1.12.2 ObliqueRenderer placement, verified pixel-for-pixel against
 * tmxrasterizer output. The renderer is OrthogonalRenderer plus a plain
 * shear (skewx/tileHeight, skewy/tileWidth) between pixel and screen
 * space, and because grid corners sit at tile-size multiples, every cell
 * anchor lands on an integer:
 *
 *   anchorX = x * tileWidth  + skewX * (y + 1)
 *   anchorY = (y + 1) * tileHeight + skewY * x
 *
 * (the bottom-left grid corner, sheared). The tile image itself is NOT
 * sheared — it draws axis-aligned, bottom-left anchored, which is what
 * gives oblique maps their look. The canvas is the axis-aligned bounding
 * box of the region's four sheared pixel-rect corners, matching
 * `ObliqueRenderer::boundingRect`'s `toAlignedRect()`, so a full-map
 * render is byte-comparable with tmxrasterizer. Cells paint in row-major
 * (right-down) order; the caller asserts the map declares that order,
 * because unsheared images from different rows can overlap once skewY is
 * non-zero and paint order then shows. Flip semantics: H/V mirror the
 * sample; the anti-diagonal rotation flag fails closed like the
 * isometric profile.
 */
export function renderObliqueTiles(input: {
  tileWidth: number;
  tileHeight: number;
  skewX: number;
  skewY: number;
  region: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  layers: readonly IsometricRenderLayer[];
  atlases: readonly NativePreviewAtlas[];
  scale: number;
}): {
  rgba: Buffer;
  width: number;
  height: number;
  originPixel: { x: number; y: number };
} {
  const {
    tileWidth,
    tileHeight,
    skewX,
    skewY,
    region,
    scale,
  } = input;

  // The region's pixel rect, sheared at its four corners. Corner
  // coordinates are tile-size multiples, so the sheared values are exact
  // integers: shearX * (ty * tileHeight) === skewX * ty.
  const left = region.x * tileWidth;
  const top = region.y * tileHeight;
  const right = left + region.width * tileWidth;
  const bottom =
    top + region.height * tileHeight;
  const shearedX = (x: number, ty: number): number =>
    x + skewX * ty;
  const shearedY = (y: number, tx: number): number =>
    y + skewY * tx;
  const minX = Math.min(
    shearedX(left, region.y),
    shearedX(left, region.y + region.height),
  );
  const maxX = Math.max(
    shearedX(right, region.y),
    shearedX(right, region.y + region.height),
  );
  const minY = Math.min(
    shearedY(top, region.x),
    shearedY(top, region.x + region.width),
  );
  const maxY = Math.max(
    shearedY(bottom, region.x),
    shearedY(bottom, region.x + region.width),
  );
  const width = (maxX - minX) * scale;
  const height = (maxY - minY) * scale;
  if (
    width * height >
    MAX_ISOMETRIC_RENDER_PIXELS
  ) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `The render would exceed ${MAX_ISOMETRIC_RENDER_PIXELS} pixels; shrink the region, the scale, or the skew.`,
      { limit: MAX_ISOMETRIC_RENDER_PIXELS },
    );
  }
  const canvas = Buffer.alloc(width * height * 4);

  const atlasFor = (
    baseGid: number,
  ): {
    atlas: NativePreviewAtlas;
    localId: number;
  } => {
    for (const atlas of input.atlases) {
      if (
        baseGid >= atlas.firstGid &&
        baseGid < atlas.firstGid + atlas.tileCount
      ) {
        return {
          atlas,
          localId: baseGid - atlas.firstGid,
        };
      }
    }
    throw new TiledMcpError(
      "GID_OUT_OF_RANGE",
      `GID ${baseGid} does not fall inside any loaded tileset range.`,
      { gid: baseGid },
    );
  };

  for (const layer of input.layers) {
    for (let y = 0; y < region.height; y += 1) {
      for (
        let x = 0;
        x < region.width;
        x += 1
      ) {
        const gid =
          layer.gids[y * region.width + x]!;
        if (gid === 0) {
          continue;
        }
        const mapX = region.x + x;
        const mapY = region.y + y;
        const decoded = decodeGid(
          gid,
          "oblique",
        );
        if (
          decoded.transform.kind ===
            "orthogonal" &&
          decoded.transform.flipD
        ) {
          throw new TiledMcpError(
            "UNSUPPORTED_RENDER_FEATURE",
            "Anti-diagonally flipped cells are outside the oblique render profile.",
            {
              feature:
                "oblique-antidiagonal-flip",
              layerId: layer.id,
              x: mapX,
              y: mapY,
            },
          );
        }
        const flipH =
          decoded.transform.kind === "orthogonal"
            ? decoded.transform.flipH
            : false;
        const flipV =
          decoded.transform.kind === "orthogonal"
            ? decoded.transform.flipV
            : false;
        const { atlas, localId } = atlasFor(
          decoded.baseGid,
        );
        if (localId >= atlas.geometry.tileCount) {
          throw new TiledMcpError(
            "GID_OUT_OF_RANGE",
            `Local tile ${localId} does not exist in ${atlas.assetId}.`,
            {
              assetId: atlas.assetId,
              localId,
            },
          );
        }
        const column =
          localId % atlas.geometry.columns;
        const row = Math.floor(
          localId / atlas.geometry.columns,
        );
        const sourceLeft =
          atlas.geometry.margin +
          column *
            (atlas.geometry.tileWidth +
              atlas.geometry.spacing);
        const sourceTop =
          atlas.geometry.margin +
          row *
            (atlas.geometry.tileHeight +
              atlas.geometry.spacing);
        const anchorX =
          mapX * tileWidth +
          skewX * (mapY + 1);
        const anchorY =
          (mapY + 1) * tileHeight +
          skewY * mapX;
        const destLeft =
          (anchorX - minX) * scale;
        const destTop =
          (anchorY - tileHeight - minY) * scale;
        const alphaScale = layer.opacity;
        for (
          let py = 0;
          py < tileHeight * scale;
          py += 1
        ) {
          const sampleY = flipV
            ? tileHeight -
              1 -
              Math.floor(py / scale)
            : Math.floor(py / scale);
          const canvasY = destTop + py;
          if (canvasY < 0 || canvasY >= height) {
            continue;
          }
          for (
            let px = 0;
            px < tileWidth * scale;
            px += 1
          ) {
            const sampleX = flipH
              ? tileWidth -
                1 -
                Math.floor(px / scale)
              : Math.floor(px / scale);
            const canvasX = destLeft + px;
            if (
              canvasX < 0 ||
              canvasX >= width
            ) {
              continue;
            }
            const sourceIndex =
              ((sourceTop + sampleY) *
                atlas.geometry.imageWidth +
                sourceLeft +
                sampleX) *
              4;
            const alpha =
              (atlas.rgba[sourceIndex + 3]! /
                255) *
              alphaScale;
            if (alpha <= 0) {
              continue;
            }
            const destIndex =
              (canvasY * width + canvasX) * 4;
            const inverse = 1 - alpha;
            for (
              let channel = 0;
              channel < 3;
              channel += 1
            ) {
              canvas[destIndex + channel] =
                Math.round(
                  atlas.rgba[
                    sourceIndex + channel
                  ]! *
                    alpha +
                    canvas[
                      destIndex + channel
                    ]! *
                      inverse,
                );
            }
            canvas[destIndex + 3] = Math.round(
              255 * alpha +
                canvas[destIndex + 3]! *
                  inverse,
            );
          }
        }
      }
    }
  }
  return {
    rgba: canvas,
    width,
    height,
    originPixel: {
      x: (shearedX(left, region.y) - minX) * scale,
      y: (shearedY(top, region.x) - minY) * scale,
    },
  };
}
