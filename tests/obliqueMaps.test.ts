import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import {
  serializeJsonDocument,
  type JsonObject,
} from "../src/formats/json.js";
import { serializeTmxMap } from "../src/maps/tmxWrite.js";
import { type MapService } from "../src/maps/mapService.js";
import { wireProject } from "./support/project.js";
import { TILED_CLI_ENV } from "./support/tiledCli.js";

const execFileAsync = promisify(execFile);

const MAP_PATH = "maps/oblique.tmj";
const RED: [number, number, number] = [192, 48, 48];
const GREEN: [number, number, number] = [48, 160, 48];

/**
 * tmxrasterizer ships beside the Tiled CLI; probed lazily so the parity
 * test skips rather than fails on machines without a Tiled install.
 */
const RASTERIZER_PATH =
  process.env.TILED_RASTERIZER_PATH ??
  "tmxrasterizer";
async function hasRasterizer(): Promise<boolean> {
  try {
    await execFileAsync(
      RASTERIZER_PATH,
      ["--version"],
      { env: { ...TILED_CLI_ENV }, timeout: 30_000 },
    );
    return true;
  } catch {
    return false;
  }
}

describe("oblique maps", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("renders skewX with the verified ObliqueRenderer placement", async () => {
    // 4x4 diagonal of red tiles, 16px grid, skewx=8 — the exact map the
    // shear formulas were pixel-verified against tmxrasterizer with.
    const harness = await createHarness(roots, {
      skewx: 8,
    });
    const rendered =
      await harness.service.renderOblique({
        mapPath: MAP_PATH,
        region: { x: 0, y: 0, width: 4, height: 4 },
      });
    expect(rendered.result).toMatchObject({
      pixelSize: { width: 96, height: 64 },
      projection: {
        orientation: "oblique",
        tileWidth: 16,
        tileHeight: 16,
        skewX: 8,
        skewY: 0,
        originPixel: { x: 0, y: 0 },
      },
      renderProfile: "oblique-tile-layers-v1",
    });
    const pixel = await pixelReader(rendered.png);
    // Cell (0,0): anchor (0*16 + 8*1, 1*16) = (8,16); image x 8..23, y 0..15.
    expect(pixel(12, 8)).toEqual([...RED, 255]);
    expect(pixel(4, 8)[3]).toBe(0);
    // Cell (1,1): anchor (16 + 8*2, 32) = (32,32); image x 32..47, y 16..31.
    expect(pixel(40, 24)).toEqual([...RED, 255]);
    expect(pixel(20, 24)[3]).toBe(0);
  });

  it("renders skewY and negative skew with translated origins", async () => {
    const skewY = await createHarness(
      roots,
      { skewy: 8 },
      "oblique-y",
    );
    const renderedY =
      await skewY.service.renderOblique({
        mapPath: MAP_PATH,
        region: { x: 0, y: 0, width: 4, height: 4 },
      });
    expect(renderedY.result).toMatchObject({
      pixelSize: { width: 64, height: 96 },
      projection: {
        skewX: 0,
        skewY: 8,
        originPixel: { x: 0, y: 0 },
      },
    });
    const pixelY = await pixelReader(renderedY.png);
    // Cell (1,1): anchor (16, 32 + 8*1) = (16,40); image y 24..39.
    expect(pixelY(24, 32)).toEqual([...RED, 255]);
    expect(pixelY(24, 8)[3]).toBe(0);

    const negative = await createHarness(
      roots,
      { skewx: -8 },
      "oblique-neg",
    );
    const renderedNegative =
      await negative.service.renderOblique({
        mapPath: MAP_PATH,
        region: { x: 0, y: 0, width: 4, height: 4 },
      });
    // Sheared corners reach x = -32, so the canvas grows left and the
    // origin translates to +32.
    expect(renderedNegative.result).toMatchObject({
      pixelSize: { width: 96, height: 64 },
      projection: {
        skewX: -8,
        originPixel: { x: 32, y: 0 },
      },
    });
    const pixelNegative = await pixelReader(
      renderedNegative.png,
    );
    // Cell (0,0): anchor (-8,16) + origin 32 => image x 24..39, y 0..15.
    expect(pixelNegative(30, 8)).toEqual([
      ...RED,
      255,
    ]);
    expect(pixelNegative(10, 8)[3]).toBe(0);
  });

  it("matches tmxrasterizer pixel for pixel on a full-map render", async () => {
    if (!(await hasRasterizer())) {
      return;
    }
    const harness = await createHarness(roots, {
      skewx: 8,
      skewy: 4,
    });
    const rendered =
      await harness.service.renderOblique({
        mapPath: MAP_PATH,
        region: { x: 0, y: 0, width: 4, height: 4 },
      });
    const rasterPath = join(
      harness.root,
      "raster.png",
    );
    const invocation = await execFileAsync(
      RASTERIZER_PATH,
      [join(harness.root, MAP_PATH), rasterPath],
      { env: { ...TILED_CLI_ENV }, timeout: 60_000 },
    );
    const rasterBytes = await readFile(
      rasterPath,
    );
    expect(
      rasterBytes
        .subarray(0, 4)
        .equals(
          Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        ),
      `tmxrasterizer produced ${rasterBytes.byteLength} bytes that are not a PNG; stderr: ${invocation.stderr.slice(0, 500)}`,
    ).toBe(true);
    const native = await sharp(rendered.png)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const raster = await sharp(rasterBytes)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect({
      width: native.info.width,
      height: native.info.height,
    }).toEqual({
      width: raster.info.width,
      height: raster.info.height,
    });
    expect(
      native.data.equals(raster.data),
      "native oblique render diverged from tmxrasterizer",
    ).toBe(true);
  });

  it("reports skew in the summary and stays editable", async () => {
    const harness = await createHarness(roots, {
      skewx: 8,
    });
    const summary =
      await harness.service.getSummary(MAP_PATH);
    expect(summary).toMatchObject({
      orientation: "oblique",
      skewX: 8,
      skewY: 0,
      editableProfile: "oblique-tmj-editable-core",
    });

    const assetId = Object.keys(
      summary.dependencyRevisions as Record<
        string,
        string
      >,
    )[0]!;
    const plan = await harness.service.planEdits(
      MAP_PATH,
      summary.revision as string,
      summary.dependencyRevisions as Record<
        string,
        string
      >,
      [
        {
          type: "setTiles",
          layerId: 1,
          cells: [
            {
              x: 1,
              y: 0,
              tile: {
                tileset: {
                  kind: "external",
                  assetId,
                },
                localId: 1,
              },
            },
          ],
        },
      ],
    );
    const result =
      await harness.service.applyEdits(plan);
    expect(result.changed).toBe(true);
    const document = JSON.parse(
      await readFile(
        join(harness.root, MAP_PATH),
        "utf8",
      ),
    ) as {
      layers: Array<{ data: number[] }>;
      skewx: number;
    };
    expect(document.layers[0]!.data[1]).toBe(2);
    expect(document.skewx).toBe(8);
  });

  it("creates oblique maps canonically and rejects bad shears", async () => {
    const harness = await createHarness(roots, {});
    await harness.service.createMap({
      mapPath: "maps/new-oblique.tmj",
      width: 3,
      height: 3,
      tileWidth: 16,
      tileHeight: 16,
      orientation: "oblique",
      skewX: 8,
      skewY: 0,
    });
    const created = JSON.parse(
      await readFile(
        join(harness.root, "maps/new-oblique.tmj"),
        "utf8",
      ),
    ) as JsonObject;
    expect(created.orientation).toBe("oblique");
    expect(created.skewx).toBe(8);
    // Zero skew is omitted, matching Tiled's canonical output.
    expect("skewy" in created).toBe(false);

    await expect(
      harness.service.createMap({
        mapPath: "maps/degenerate.tmj",
        width: 3,
        height: 3,
        tileWidth: 16,
        tileHeight: 16,
        orientation: "oblique",
        skewX: 16,
        skewY: 16,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      harness.service.createMap({
        mapPath: "maps/skewed-ortho.tmj",
        width: 3,
        height: 3,
        tileWidth: 16,
        tileHeight: 16,
        skewX: 8,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it("serializes oblique TMX headers in mapwriter.cpp attribute order", async () => {
    const harness = await createHarness(roots, {
      skewx: 8,
      skewy: -4,
    });
    const document = JSON.parse(
      await readFile(
        join(harness.root, MAP_PATH),
        "utf8",
      ),
    ) as JsonObject;
    const tmx = serializeTmxMap(
      document,
      MAP_PATH,
    );
    // skewx/skewy sit between infinite and nextlayerid, mirroring
    // mapwriter.cpp; zero-valued members would be omitted entirely.
    expect(tmx).toContain(
      'orientation="oblique"',
    );
    expect(tmx).toMatch(
      /infinite="0" skewx="8" skewy="-4" nextlayerid=/u,
    );

    const orthogonalWithSkew = {
      ...document,
      orientation: "orthogonal",
    };
    expect(() =>
      serializeTmxMap(
        orthogonalWithSkew,
        MAP_PATH,
      ),
    ).toThrowError(/skewx/u);
  });

  it("converts coordinates through the shear and fails closed on the degenerate case", async () => {
    const harness = await createHarness(roots, {
      skewx: 8,
    });
    const result =
      await harness.service.convertCoordinates({
        mapPath: MAP_PATH,
        conversions: [
          {
            from: "tile",
            to: "screen",
            point: { x: 1, y: 1 },
          },
          {
            from: "pixel",
            to: "screen",
            point: { x: 4, y: 8 },
          },
          {
            from: "screen",
            to: "pixel",
            point: { x: 20, y: 16 },
          },
        ],
      });
    expect(result.projection).toMatchObject({
      orientation: "oblique",
      skewX: 8,
      skewY: 0,
      tileSpace: "continuous",
      pixelSpace: "distinct-from-screen",
    });
    const conversions = result.conversions as Array<{
      output: { x: number; y: number };
    }>;
    // tile (1,1) -> pixel (16,16) -> shear x: 16 + (8/16)*16 = 24.
    expect(conversions[0]!.output).toEqual({
      x: 24,
      y: 16,
    });
    // pixel (4,8) -> x: 4 + 0.5*8 = 8.
    expect(conversions[1]!.output).toEqual({
      x: 8,
      y: 8,
    });
    // screen (20,16) -> pixel x: 20 - 0.5*16 = 12.
    expect(conversions[2]!.output).toEqual({
      x: 12,
      y: 16,
    });

    const degenerate = await createHarness(
      roots,
      { skewx: 16, skewy: 16 },
      "oblique-degenerate",
    );
    await expect(
      degenerate.service.convertCoordinates({
        mapPath: MAP_PATH,
        conversions: [
          {
            from: "tile",
            to: "screen",
            point: { x: 0, y: 0 },
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_MAP_PROFILE",
    });
  });
});

async function pixelReader(
  png: Buffer,
): Promise<
  (
    x: number,
    y: number,
  ) => [number, number, number, number]
> {
  const raw = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return (x, y) => {
    const index = (y * raw.info.width + x) * 4;
    return [
      raw.data[index]!,
      raw.data[index + 1]!,
      raw.data[index + 2]!,
      raw.data[index + 3]!,
    ];
  };
}

async function createHarness(
  roots: Set<string>,
  skew: { skewx?: number; skewy?: number },
  prefix = "oblique",
): Promise<{ root: string; service: MapService }> {
  const root = await mkdtemp(
    join(tmpdir(), `tiledmcp-${prefix}-`),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "tiles"));
  const tiles = await sharp({
    create: {
      width: 32,
      height: 16,
      channels: 4,
      background: {
        r: RED[0],
        g: RED[1],
        b: RED[2],
        alpha: 1,
      },
    },
  })
    .composite([
      {
        input: await sharp({
          create: {
            width: 16,
            height: 16,
            channels: 4,
            background: {
              r: GREEN[0],
              g: GREEN[1],
              b: GREEN[2],
              alpha: 1,
            },
          },
        })
          .png()
          .toBuffer(),
        left: 16,
        top: 0,
      },
    ])
    .png()
    .toBuffer();
  await writeFile(
    join(root, "tiles/oblique.png"),
    tiles,
  );
  await writeFile(
    join(root, "tiles/oblique.tsj"),
    serializeJsonDocument({
      columns: 2,
      image: "oblique.png",
      imageheight: 16,
      imagewidth: 32,
      margin: 0,
      name: "Oblique",
      spacing: 0,
      tilecount: 2,
      tiledversion: "1.12.2",
      tileheight: 16,
      tilewidth: 16,
      type: "tileset",
      version: "1.10",
    }),
  );
  const map: JsonObject = {
    compressionlevel: -1,
    height: 4,
    infinite: false,
    layers: [
      {
        data: [
          1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0,
          0, 0, 0, 1,
        ],
        height: 4,
        id: 1,
        name: "ground",
        opacity: 1,
        type: "tilelayer",
        visible: true,
        width: 4,
        x: 0,
        y: 0,
      },
    ],
    nextlayerid: 2,
    nextobjectid: 1,
    orientation: "oblique",
    renderorder: "right-down",
    ...(skew.skewx !== undefined && skew.skewx !== 0
      ? { skewx: skew.skewx }
      : {}),
    ...(skew.skewy !== undefined && skew.skewy !== 0
      ? { skewy: skew.skewy }
      : {}),
    tiledversion: "1.12.2",
    tileheight: 16,
    tilesets: [
      { firstgid: 1, source: "../tiles/oblique.tsj" },
    ],
    tilewidth: 16,
    type: "map",
    version: "1.10",
    width: 4,
  };
  await writeFile(
    join(root, MAP_PATH),
    serializeJsonDocument(map),
  );
  const { service } = await wireProject(root);
  return { root, service };
}
