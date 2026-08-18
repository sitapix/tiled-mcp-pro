import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { withProject } from "./support/project.js";

/**
 * The native AutoMapping engine, exercised through `planAutomap` against
 * fixture rules maps.
 *
 * Every assertion here was written against the semantics of Tiled 1.12.2's
 * `src/tiled/automapper.cpp`, which `src/maps/automap.ts` ports. There is no
 * CLI cross-check — headless Tiled cannot automap (see
 * `tests/automapCanary.test.ts`) — so this suite is the fidelity evidence:
 * each test encodes what the upstream engine would do for the same rules.
 *
 * Tile vocabulary (fixtures/floorplan/interior.tsj, firstgid 1):
 * wood=1 stone=2 brick=3 window=4 door=5 rug=6 barrel=7 table=8.
 * The embedded "AutoMap Rules" tileset sits at firstgid 9 with the real
 * automap-tiles ids: Negate=9 Ignore=10 NonEmpty=11 Empty=12 Other=13.
 */

const FIXTURE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "floorplan",
);

const MAP_PATH = "maps/level.tmj";
const RULES_PATH = "maps/rules.tmj";
const TILESET_PATH = "maps/interior.tsj";
const GROUND_ID = 1;
const DECO_ID = 2;

const WOOD = 1;
const STONE = 2;
const BRICK = 3;
const BARREL = 7;
const TABLE = 8;
const NEGATE = 9;
const IGNORE = 10;
const NON_EMPTY = 11;
const EMPTY = 12;
const OTHER = 13;

interface PlanOp {
  type: string;
  layerId: number;
  cells: Array<{
    x: number;
    y: number;
    tile: { localId: number } | null;
  }>;
}

interface Plan {
  operations: PlanOp[];
}

interface Service {
  getSummary(mapPath: string): Promise<unknown>;
  getRegion(input: unknown): Promise<unknown>;
  planAutomap(input: {
    mapPath: string;
    rulesPath?: string;
    seed?: number;
    expectedMapRevision: string;
    expectedDependencyRevisions: Record<
      string,
      string
    >;
  }): Promise<Plan>;
  applyEdits(plan: Plan): Promise<unknown>;
}

interface Summary {
  revision: string;
  tilesets: Array<{
    assetId: string;
    revision: string;
  }>;
}

const json = (value: unknown): Buffer =>
  Buffer.from(
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );

function tlayer(
  id: number,
  name: string,
  width: number,
  height: number,
  data: number[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    name,
    type: "tilelayer",
    width,
    height,
    opacity: 1,
    visible: true,
    x: 0,
    y: 0,
    data,
    ...extra,
  };
}

function mapDocument(
  width: number,
  height: number,
  layers: unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    compressionlevel: -1,
    width,
    height,
    infinite: false,
    nextlayerid: layers.length + 1,
    nextobjectid: 1,
    orientation: "orthogonal",
    renderorder: "right-down",
    tiledversion: "1.12.2",
    tilewidth: 16,
    tileheight: 16,
    type: "map",
    version: "1.10",
    tilesets: [
      { firstgid: 1, source: "interior.tsj" },
    ],
    layers,
    ...extra,
  };
}

const AUTOMAP_TILESET = {
  firstgid: 9,
  name: "AutoMap Rules",
  tilewidth: 16,
  tileheight: 16,
  tilecount: 5,
  columns: 5,
  tiles: [
    { id: 0, properties: [matchType("Negate")] },
    { id: 1, properties: [matchType("Ignore")] },
    {
      id: 2,
      properties: [matchType("NonEmpty")],
    },
    { id: 3, properties: [matchType("Empty")] },
    { id: 4, properties: [matchType("Other")] },
  ],
};

function matchType(value: string): {
  name: string;
  type: string;
  value: string;
} {
  return { name: "MatchType", type: "string", value };
}

function rulesDocument(
  width: number,
  height: number,
  layers: unknown[],
  properties: Array<Record<string, unknown>> = [],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return mapDocument(width, height, layers, {
    tilesets: [
      { firstgid: 1, source: "interior.tsj" },
      AUTOMAP_TILESET,
    ],
    ...(properties.length > 0
      ? { properties }
      : {}),
    ...extra,
  });
}

const bool = (
  name: string,
  value: boolean,
): Record<string, unknown> => ({
  name,
  type: "bool",
  value,
});

const int = (
  name: string,
  value: number,
): Record<string, unknown> => ({
  name,
  type: "int",
  value,
});

const float = (
  name: string,
  value: number,
): Record<string, unknown> => ({
  name,
  type: "float",
  value,
});

/** An 8x6 target: Ground carries `ground`, Deco carries `deco`. */
function targetMap(
  ground: number[],
  deco?: number[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return mapDocument(8, 6, [
    tlayer(GROUND_ID, "Ground", 8, 6, ground),
    tlayer(
      DECO_ID,
      "Deco",
      8,
      6,
      deco ?? new Array(48).fill(0),
      extra,
    ),
  ]);
}

function grid48(
  cells: Record<number, number>,
): number[] {
  const data = new Array(48).fill(0);
  for (const [index, value] of Object.entries(
    cells,
  )) {
    data[Number(index)] = value;
  }
  return data;
}

async function fixtureFiles(): Promise<
  Record<string, Buffer>
> {
  return {
    [TILESET_PATH]: await readFile(
      join(FIXTURE_DIR, "interior.tsj"),
    ),
    "maps/tiles.png": await readFile(
      join(FIXTURE_DIR, "tiles.png"),
    ),
  };
}

async function plan(
  service: Service,
  extra: Record<string, unknown> = {},
): Promise<Plan> {
  const summary = (await service.getSummary(
    MAP_PATH,
  )) as Summary;
  return service.planAutomap({
    mapPath: MAP_PATH,
    rulesPath: RULES_PATH,
    expectedMapRevision: summary.revision,
    expectedDependencyRevisions:
      Object.fromEntries(
        summary.tilesets.map((tileset) => [
          tileset.assetId,
          tileset.revision,
        ]),
      ),
    ...extra,
  });
}

/** The plan's writes on one layer as "x,y" -> local id (null erases). */
function writes(
  planned: Plan,
  layerId: number,
): Map<string, number | null> {
  const map = new Map<string, number | null>();
  for (const op of planned.operations) {
    if (op.layerId !== layerId) {
      continue;
    }
    for (const cell of op.cells) {
      map.set(
        `${cell.x},${cell.y}`,
        cell.tile === null
          ? null
          : cell.tile.localId,
      );
    }
  }
  return map;
}

describe("automap", () => {
  it("applies a rule at every match, keeps rule geometry, treats Ignore as no condition, and respects map bounds", async () => {
    // 3x1 rule: wood, then an Ignore connector, then a barrel two cells
    // right of the match. Ignore keeps the region coherent and adds no
    // condition on the middle cell.
    await withProject(
      {
        files: {
          ...(await fixtureFiles()),
          [MAP_PATH]: json(
            targetMap(
              grid48({
                0: WOOD,
                [2 * 8 + 3]: WOOD,
                [4 * 8 + 6]: WOOD,
                1: STONE,
                [2 * 8 + 4]: BRICK,
              }),
            ),
          ),
          [RULES_PATH]: json(
            rulesDocument(3, 1, [
              tlayer(1, "input_Ground", 3, 1, [
                WOOD,
                IGNORE,
                0,
              ]),
              tlayer(2, "output_Deco", 3, 1, [
                0,
                0,
                BARREL,
              ]),
            ]),
          ),
        },
        prefix: "tiledmcp-automap",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        const planned = await plan(service);
        await service.applyEdits(planned);

        const deco = writes(planned, DECO_ID);
        // Matches at (0,0) and (3,2) place barrels two cells right; the
        // wood at (6,4) cannot host the 3-wide rule inside the 8-wide map,
        // so it produces nothing (MatchOutsideMap defaults to false).
        expect(
          [...deco.entries()].sort(),
        ).toEqual([
          ["2,0", BARREL - 1],
          ["5,2", BARREL - 1],
        ]);

        const region = (await service.getRegion({
          mapPath: MAP_PATH,
          layerId: DECO_ID,
          x: 0,
          y: 0,
          width: 8,
          height: 6,
        })) as {
          rows: Array<
            Array<{ localId: number } | null>
          >;
        };
        expect(region.rows[0]?.[2]?.localId).toBe(
          BARREL - 1,
        );
        expect(region.rows[2]?.[5]?.localId).toBe(
          BARREL - 1,
        );
        expect(
          region.rows.flat().filter(Boolean),
        ).toHaveLength(2);
      },
    );
  });

  it("ORs input indexes, ORs same-name alternatives, and ANDs inputnot conditions", async () => {
    // input1/input2 are alternative sets: wood OR stone matches. The
    // inputnot_Deco layer vetoes cells whose Deco already holds a barrel.
    await withProject(
      {
        files: {
          ...(await fixtureFiles()),
          [MAP_PATH]: json(
            targetMap(
              grid48({
                0: WOOD,
                1: STONE,
                2: BRICK,
                3: WOOD,
              }),
              grid48({ 3: BARREL }),
            ),
          ),
          [RULES_PATH]: json(
            rulesDocument(1, 1, [
              tlayer(1, "input1_Ground", 1, 1, [
                WOOD,
              ]),
              tlayer(2, "input2_Ground", 1, 1, [
                STONE,
              ]),
              tlayer(3, "inputnot1_Deco", 1, 1, [
                BARREL,
              ]),
              tlayer(4, "inputnot2_Deco", 1, 1, [
                BARREL,
              ]),
              tlayer(5, "output_Deco", 1, 1, [
                TABLE,
              ]),
            ]),
          ),
        },
        prefix: "tiledmcp-automap",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        const planned = await plan(service);
        // Wood at 0 and stone at 1 match; brick at 2 matches neither
        // index; wood at 3 is vetoed by its barrel.
        expect(
          [...writes(planned, DECO_ID).keys()].sort(),
        ).toEqual(["0,0", "1,0"]);
      },
    );
  });

  it("Empty matches empty cells on input and erases on output", async () => {
    await withProject(
      {
        files: {
          ...(await fixtureFiles()),
          [MAP_PATH]: json(
            targetMap(
              grid48({ 0: WOOD, 1: WOOD }),
              grid48({ 0: BARREL, 5: BARREL }),
            ),
          ),
          [RULES_PATH]: json(
            rulesDocument(3, 1, [
              // Rule 1 (cell 0): wood under a barrel -> erase the barrel.
              // Rule 2 (cell 2): empty Ground -> stone floor.
              tlayer(1, "input_Ground", 3, 1, [
                WOOD,
                0,
                EMPTY,
              ]),
              tlayer(2, "input_Deco", 3, 1, [
                BARREL,
                0,
                0,
              ]),
              tlayer(3, "output_Deco", 3, 1, [
                EMPTY,
                0,
                0,
              ]),
              tlayer(4, "output_Ground", 3, 1, [
                0,
                0,
                STONE,
              ]),
            ]),
          ),
        },
        prefix: "tiledmcp-automap",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        const planned = await plan(service);
        // The barrel over wood at (0,0) is erased; the barrel at (5,0)
        // sits on wood-less ground, whose cell Rule 2 turns to stone, so
        // it stays.
        expect(
          [...writes(planned, DECO_ID).entries()],
        ).toEqual([["0,0", null]]);
        const ground = writes(planned, GROUND_ID);
        // Every empty Ground cell gains stone; the two wood cells do not.
        expect(ground.size).toBe(48 - 2);
        expect(ground.get("0,0")).toBeUndefined();
        expect(ground.get("1,0")).toBeUndefined();
        expect(ground.get("2,0")).toBe(STONE - 1);
      },
    );
  });

  it("NonEmpty, Other, and Negate follow the upstream matcher", async () => {
    await withProject(
      {
        files: {
          ...(await fixtureFiles()),
          [MAP_PATH]: json(
            targetMap(
              // Row 0 probes Other with [wood, X] pairs starting at even x:
              // (0,1)=stone matches, (2,3)=wood does not, (4,5)=empty does
              // (Other excludes only the used tiles, and Empty is unused).
              grid48({
                0: WOOD,
                1: STONE,
                2: WOOD,
                3: WOOD,
                4: WOOD,
                [8 + 0]: BRICK,
              }),
            ),
          ),
          [RULES_PATH]: json(
            rulesDocument(2, 1, [
              // [wood, Other] -> barrel on Deco under the wood. Other means
              // "none of the tiles this rule uses on this layer", so stone
              // and empty qualify and wood does not.
              tlayer(1, "input_Ground", 2, 1, [
                WOOD,
                OTHER,
              ]),
              tlayer(2, "output_Deco", 2, 1, [
                BARREL,
                0,
              ]),
            ]),
          ),
        },
        prefix: "tiledmcp-automap",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        const planned = await plan(service);
        // [wood, stone] at x=0 and [wood, empty] at x=4 match; [wood, wood]
        // at x=2,3 does not. x=3 gives [wood, wood] too.
        expect(
          [...writes(planned, DECO_ID).keys()].sort(),
        ).toEqual(["0,0", "4,0"]);
      },
    );
  });

  it("NonEmpty matches any content and Negate inverts a condition", async () => {
    await withProject(
      {
        files: {
          ...(await fixtureFiles()),
          [MAP_PATH]: json(
            targetMap(
              grid48({ 0: WOOD, 1: BRICK }),
            ),
          ),
          [RULES_PATH]: json(
            rulesDocument(3, 1, [
              // Rule 1 (cell 0): NonEmpty -> rug. Rule 2 (cell 2): wood
              // plus Negate on a second same-name layer -> table everywhere
              // Ground is NOT wood (empty included). Both layers are
              // `input_Ground`, so the Negate lands in the same condition
              // list as the wood, which is what makes it invert it.
              tlayer(1, "input_Ground", 3, 1, [
                NON_EMPTY,
                0,
                WOOD,
              ]),
              tlayer(2, "input_Ground", 3, 1, [
                0,
                0,
                NEGATE,
              ]),
              tlayer(3, "output_Deco", 3, 1, [
                6,
                0,
                0,
              ]),
              tlayer(4, "output_Deco", 3, 1, [
                0,
                0,
                TABLE,
              ]),
            ]),
          ),
        },
        prefix: "tiledmcp-automap",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        const planned = await plan(service);
        const deco = writes(planned, DECO_ID);
        // Rule 1 puts rugs on the non-empty cells; rule 2 applies after it
        // in rule order and tables every non-wood cell, overwriting the
        // brick cell's rug. Only the wood cell keeps its rug.
        expect(deco.get("0,0")).toBe(6 - 1);
        expect(deco.get("1,0")).toBe(TABLE - 1);
        expect(deco.get("2,0")).toBe(TABLE - 1);
        expect(deco.get("0,1")).toBe(TABLE - 1);
        expect(deco.size).toBe(48);
      },
    );
  });

  it("AutoEmpty makes an empty input cell a hard empty condition", async () => {
    await withProject(
      {
        files: {
          ...(await fixtureFiles()),
          [MAP_PATH]: json(
            targetMap(
              // (0,0)-(1,0): wood then empty -> should match.
              // (3,0)-(4,0): wood then stone -> must not match.
              grid48({
                0: WOOD,
                3: WOOD,
                4: STONE,
              }),
            ),
          ),
          [RULES_PATH]: json(
            rulesDocument(2, 1, [
              tlayer(
                1,
                "input_Ground",
                2,
                1,
                [WOOD, 0],
                {
                  properties: [
                    bool("AutoEmpty", true),
                  ],
                },
              ),
              // A second condition layer keeps the empty cell inside the
              // rule's input region -- AutoEmpty only binds cells the
              // region covers, exactly as upstream.
              tlayer(2, "input_Marks", 2, 1, [
                0,
                IGNORE,
              ]),
              tlayer(3, "output_Deco", 2, 1, [
                BARREL,
                0,
              ]),
            ]),
          ),
        },
        prefix: "tiledmcp-automap",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        const planned = await plan(service);
        expect(
          [...writes(planned, DECO_ID).keys()].sort(),
        ).toEqual(["0,0"]);
      },
    );
  });

  it("weighted output indexes are seed-deterministic and probability 0 excludes an index", async () => {
    const files = async (): Promise<
      Record<string, Buffer>
    > => ({
      ...(await fixtureFiles()),
      [MAP_PATH]: json(
        targetMap(new Array(48).fill(WOOD)),
      ),
      [RULES_PATH]: json(
        rulesDocument(1, 1, [
          tlayer(1, "input_Ground", 1, 1, [WOOD]),
          tlayer(2, "output1_Deco", 1, 1, [
            BARREL,
          ]),
          tlayer(3, "output2_Deco", 1, 1, [
            TABLE,
          ]),
        ]),
      ),
    });
    await withProject(
      { files: await files(), prefix: "tiledmcp-automap" },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        const first = await plan(service, {
          seed: 7,
        });
        const again = await plan(service, {
          seed: 7,
        });
        expect(again.operations).toEqual(
          first.operations,
        );
        const other = await plan(service, {
          seed: 8,
        });
        expect(other.operations).not.toEqual(
          first.operations,
        );
        const chosen = new Set(
          writes(first, DECO_ID).values(),
        );
        // 48 draws at even odds: both outcomes appear.
        expect(chosen).toEqual(
          new Set([BARREL - 1, TABLE - 1]),
        );
      },
    );
    // Probability 0 on output2 removes it from the draw entirely.
    await withProject(
      {
        files: {
          ...(await files()),
          [RULES_PATH]: json(
            rulesDocument(1, 1, [
              tlayer(1, "input_Ground", 1, 1, [
                WOOD,
              ]),
              tlayer(2, "output1_Deco", 1, 1, [
                BARREL,
              ]),
              tlayer(
                3,
                "output2_Deco",
                1,
                1,
                [TABLE],
                {
                  properties: [
                    float("Probability", 0),
                  ],
                },
              ),
            ]),
          ),
        },
        prefix: "tiledmcp-automap",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        const planned = await plan(service, {
          seed: 7,
        });
        expect(
          new Set(
            writes(planned, DECO_ID).values(),
          ),
        ).toEqual(new Set([BARREL - 1]));
      },
    );
  });

  it("map-level Probability 0 disables every rule, failing closed as a no-op", async () => {
    await withProject(
      {
        files: {
          ...(await fixtureFiles()),
          [MAP_PATH]: json(
            targetMap(grid48({ 0: WOOD })),
          ),
          [RULES_PATH]: json(
            rulesDocument(
              1,
              1,
              [
                tlayer(1, "input_Ground", 1, 1, [
                  WOOD,
                ]),
                tlayer(2, "output_Deco", 1, 1, [
                  BARREL,
                ]),
              ],
              [float("Probability", 0)],
            ),
          ),
        },
        prefix: "tiledmcp-automap",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        await expect(
          plan(service),
        ).rejects.toMatchObject({
          code: "PLAN_NO_CHANGES",
        });
      },
    );
  });

  it("MatchInOrder lets later rules see earlier rules' output; concurrent mode does not", async () => {
    const files = async (
      matchInOrder: boolean,
    ): Promise<Record<string, Buffer>> => ({
      ...(await fixtureFiles()),
      [MAP_PATH]: json(
        targetMap(
          grid48({ 0: WOOD, [5 * 8 + 5]: STONE }),
        ),
      ),
      [RULES_PATH]: json(
        rulesDocument(
          3,
          1,
          [
            // Rule A (cell 0): wood -> stone on Ground.
            // Rule B (cell 2): stone -> barrel on Deco.
            tlayer(1, "input_Ground", 3, 1, [
              WOOD,
              0,
              STONE,
            ]),
            tlayer(2, "output_Ground", 3, 1, [
              STONE,
              0,
              0,
            ]),
            tlayer(3, "output_Deco", 3, 1, [
              0,
              0,
              BARREL,
            ]),
          ],
          matchInOrder
            ? [bool("MatchInOrder", true)]
            : [],
        ),
      ),
    });
    await withProject(
      {
        files: await files(true),
        prefix: "tiledmcp-automap",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        const planned = await plan(service);
        // Rule A turned (0,0) to stone before rule B matched, so both the
        // original stone and the fresh one carry barrels.
        expect(
          [...writes(planned, DECO_ID).keys()].sort(),
        ).toEqual(["0,0", "5,5"]);
      },
    );
    await withProject(
      {
        files: await files(false),
        prefix: "tiledmcp-automap",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        const planned = await plan(service);
        // Concurrent matching sees the original Ground, so only the
        // original stone cell hosts a barrel.
        expect([
          ...writes(planned, DECO_ID).keys(),
        ]).toEqual(["5,5"]);
      },
    );
  });

  it("NoOverlappingOutput drops applications overlapping the same rule's output", async () => {
    const files = async (
      noOverlap: boolean,
    ): Promise<Record<string, Buffer>> => ({
      ...(await fixtureFiles()),
      [MAP_PATH]: json(
        targetMap(
          grid48({ 0: WOOD, 1: WOOD, 2: WOOD }),
        ),
      ),
      [RULES_PATH]: json(
        rulesDocument(
          2,
          1,
          [
            tlayer(1, "input_Ground", 2, 1, [
              WOOD,
              WOOD,
            ]),
            tlayer(2, "output_Deco", 2, 1, [
              BARREL,
              BARREL,
            ]),
          ],
          noOverlap
            ? [bool("NoOverlappingOutput", true)]
            : [],
        ),
      ),
    });
    await withProject(
      {
        files: await files(true),
        prefix: "tiledmcp-automap",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        const planned = await plan(service);
        // The match at x=0 wrote cells 0-1; the match at x=1 would overlap
        // cell 1 and is dropped whole.
        expect(
          [...writes(planned, DECO_ID).keys()].sort(),
        ).toEqual(["0,0", "1,0"]);
      },
    );
    await withProject(
      {
        files: await files(false),
        prefix: "tiledmcp-automap",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        const planned = await plan(service);
        expect(
          [...writes(planned, DECO_ID).keys()].sort(),
        ).toEqual(["0,0", "1,0", "2,0"]);
      },
    );
  });

  it("ModX and OffsetX stride the match grid", async () => {
    const files = async (
      properties: Array<Record<string, unknown>>,
    ): Promise<Record<string, Buffer>> => ({
      ...(await fixtureFiles()),
      [MAP_PATH]: json(
        targetMap(
          grid48(
            Object.fromEntries(
              Array.from({ length: 8 }, (_, x) => [
                x,
                WOOD,
              ]),
            ),
          ),
        ),
      ),
      [RULES_PATH]: json(
        rulesDocument(
          1,
          1,
          [
            tlayer(1, "input_Ground", 1, 1, [
              WOOD,
            ]),
            tlayer(2, "output_Deco", 1, 1, [
              BARREL,
            ]),
          ],
          properties,
        ),
      ),
    });
    await withProject(
      {
        files: await files([int("ModX", 2)]),
        prefix: "tiledmcp-automap",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        const planned = await plan(service);
        expect(
          [...writes(planned, DECO_ID).keys()].sort(),
        ).toEqual(["0,0", "2,0", "4,0", "6,0"]);
      },
    );
    await withProject(
      {
        files: await files([
          int("ModX", 2),
          int("OffsetX", 1),
        ]),
        prefix: "tiledmcp-automap",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        const planned = await plan(service);
        expect(
          [...writes(planned, DECO_ID).keys()].sort(),
        ).toEqual(["1,0", "3,0", "5,0", "7,0"]);
      },
    );
  });

  it("WrapBorder matches and writes across the seam", async () => {
    await withProject(
      {
        files: {
          ...(await fixtureFiles()),
          [MAP_PATH]: json(
            mapDocument(4, 1, [
              tlayer(GROUND_ID, "Ground", 4, 1, [
                WOOD,
                STONE,
                STONE,
                WOOD,
              ]),
              tlayer(
                DECO_ID,
                "Deco",
                4,
                1,
                [0, 0, 0, 0],
              ),
            ]),
          ),
          [RULES_PATH]: json(
            rulesDocument(
              2,
              1,
              [
                tlayer(1, "input_Ground", 2, 1, [
                  WOOD,
                  WOOD,
                ]),
                tlayer(2, "output_Deco", 2, 1, [
                  BARREL,
                  BARREL,
                ]),
              ],
              [bool("WrapBorder", true)],
            ),
          ),
        },
        prefix: "tiledmcp-automap",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        const planned = await plan(service);
        // The only wood pair is (3,0)-(0,0) across the seam; its output
        // wraps to exactly those two cells.
        expect(
          [...writes(planned, DECO_ID).keys()].sort(),
        ).toEqual(["0,0", "3,0"]);
      },
    );
  });

  it("locked output layers are skipped unless IgnoreLock", async () => {
    const files = async (
      properties: Array<Record<string, unknown>>,
    ): Promise<Record<string, Buffer>> => ({
      ...(await fixtureFiles()),
      [MAP_PATH]: json(
        targetMap(grid48({ 0: WOOD }), undefined, {
          locked: true,
        }),
      ),
      [RULES_PATH]: json(
        rulesDocument(
          1,
          1,
          [
            tlayer(1, "input_Ground", 1, 1, [
              WOOD,
            ]),
            tlayer(2, "output_Deco", 1, 1, [
              BARREL,
            ]),
          ],
          properties,
        ),
      ),
    });
    await withProject(
      {
        files: await files([]),
        prefix: "tiledmcp-automap",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        await expect(
          plan(service),
        ).rejects.toMatchObject({
          code: "PLAN_NO_CHANGES",
        });
      },
    );
    await withProject(
      {
        files: await files([
          bool("IgnoreLock", true),
        ]),
        prefix: "tiledmcp-automap",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        const planned = await plan(service);
        expect([
          ...writes(planned, DECO_ID).keys(),
        ]).toEqual(["0,0"]);
      },
    );
  });

  it("DeleteTiles erases output layers under input content before rules run", async () => {
    await withProject(
      {
        files: {
          ...(await fixtureFiles()),
          [MAP_PATH]: json(
            targetMap(
              grid48({ 0: WOOD, 1: WOOD }),
              grid48({ 1: BARREL, 5: BARREL }),
            ),
          ),
          [RULES_PATH]: json(
            rulesDocument(
              1,
              1,
              [
                tlayer(1, "input_Ground", 1, 1, [
                  WOOD,
                ]),
                tlayer(2, "output_Deco", 1, 1, [
                  TABLE,
                ]),
              ],
              [bool("DeleteTiles", true)],
            ),
          ),
        },
        prefix: "tiledmcpautomap",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        const planned = await plan(service);
        const deco = writes(planned, DECO_ID);
        // Tables land on the wood cells (the erasure under (1,0) is then
        // overwritten); the barrel at (5,0) sits outside any input content
        // and survives untouched.
        expect([...deco.entries()].sort()).toEqual(
          [
            ["0,0", TABLE - 1],
            ["1,0", TABLE - 1],
          ],
        );
        expect(deco.has("5,0")).toBe(false);
      },
    );
  });

  it("walks rules.txt with comments, includes, and map name filters", async () => {
    await withProject(
      {
        files: {
          ...(await fixtureFiles()),
          [MAP_PATH]: json(
            targetMap(
              grid48({ 0: WOOD, 1: STONE }),
            ),
          ),
          "maps/rules.txt": [
            "# barrels on wood",
            "ruleA.tmj",
            "[town*]",
            "ruleB.tmj",
            "[*]",
            "more.txt",
            "",
          ].join("\n"),
          "maps/more.txt": "ruleC.tmj\n",
          "maps/ruleA.tmj": json(
            rulesDocument(1, 1, [
              tlayer(1, "input_Ground", 1, 1, [
                WOOD,
              ]),
              tlayer(2, "output_Deco", 1, 1, [
                BARREL,
              ]),
            ]),
          ),
          "maps/ruleB.tmj": json(
            rulesDocument(1, 1, [
              tlayer(1, "input_Ground", 1, 1, [
                WOOD,
              ]),
              tlayer(2, "output_Deco", 1, 1, [
                TABLE,
              ]),
            ]),
          ),
          "maps/ruleC.tmj": json(
            rulesDocument(1, 1, [
              tlayer(1, "input_Ground", 1, 1, [
                STONE,
              ]),
              tlayer(2, "output_Deco", 1, 1, [6]),
            ]),
          ),
        },
        prefix: "tiledmcp-automap",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        const planned = await plan(service, {
          rulesPath: "maps/rules.txt",
        });
        const deco = writes(planned, DECO_ID);
        // ruleA applied (barrel on wood); ruleB is behind [town*], which
        // level.tmj does not match; ruleC came through the include after
        // [*] reset the filter (rug on stone).
        expect([...deco.entries()].sort()).toEqual(
          [
            ["0,0", BARREL - 1],
            ["1,0", 6 - 1],
          ],
        );
      },
    );
  });

  it("defaults rulesPath to rules.txt beside the map", async () => {
    await withProject(
      {
        files: {
          ...(await fixtureFiles()),
          [MAP_PATH]: json(
            targetMap(grid48({ 0: WOOD })),
          ),
          "maps/rules.txt": "ruleA.tmj\n",
          "maps/ruleA.tmj": json(
            rulesDocument(1, 1, [
              tlayer(1, "input_Ground", 1, 1, [
                WOOD,
              ]),
              tlayer(2, "output_Deco", 1, 1, [
                BARREL,
              ]),
            ]),
          ),
        },
        prefix: "tiledmcp-automap",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        const summary = (await service.getSummary(
          MAP_PATH,
        )) as Summary;
        const planned = await service.planAutomap({
          mapPath: MAP_PATH,
          expectedMapRevision: summary.revision,
          expectedDependencyRevisions:
            Object.fromEntries(
              summary.tilesets.map((tileset) => [
                tileset.assetId,
                tileset.revision,
              ]),
            ),
        });
        expect([
          ...writes(planned, DECO_ID).keys(),
        ]).toEqual(["0,0"]);
      },
    );
  });

  it("fails closed across the unsupported profile", async () => {
    const cases: Array<{
      code: string;
      rules: unknown;
      rulesPath?: string;
      extraFiles?: Record<string, unknown>;
    }> = [
      {
        // Pre-1.9 regions layer.
        code: "UNSUPPORTED_FORMAT",
        rules: rulesDocument(1, 1, [
          tlayer(1, "regions", 1, 1, [WOOD]),
          tlayer(2, "input_Ground", 1, 1, [
            WOOD,
          ]),
          tlayer(3, "output_Deco", 1, 1, [
            BARREL,
          ]),
        ]),
      },
      {
        // Object-layer output.
        code: "UNSUPPORTED_FORMAT",
        rules: rulesDocument(1, 1, [
          tlayer(1, "input_Ground", 1, 1, [
            WOOD,
          ]),
          {
            id: 2,
            name: "output_Things",
            type: "objectgroup",
            objects: [],
            opacity: 1,
            visible: true,
            x: 0,
            y: 0,
          },
        ]),
      },
      {
        // Output layer carrying a property Tiled would copy over.
        code: "UNSUPPORTED_FORMAT",
        rules: rulesDocument(1, 1, [
          tlayer(1, "input_Ground", 1, 1, [
            WOOD,
          ]),
          tlayer(
            2,
            "output_Deco",
            1,
            1,
            [BARREL],
            {
              properties: [
                bool("copied", true),
              ],
            },
          ),
        ]),
      },
      {
        // Unknown map property, which Tiled would only warn about.
        code: "INVALID_ARGUMENT",
        rules: rulesDocument(
          1,
          1,
          [
            tlayer(1, "input_Ground", 1, 1, [
              WOOD,
            ]),
            tlayer(2, "output_Deco", 1, 1, [
              BARREL,
            ]),
          ],
          [bool("DeleteTilesx", true)],
        ),
      },
      {
        // Unrecognized layer name.
        code: "INVALID_ARGUMENT",
        rules: rulesDocument(1, 1, [
          tlayer(1, "notes", 1, 1, [WOOD]),
          tlayer(2, "input_Ground", 1, 1, [
            WOOD,
          ]),
          tlayer(3, "output_Deco", 1, 1, [
            BARREL,
          ]),
        ]),
      },
      {
        // Output layer the target map lacks.
        code: "LAYER_NOT_FOUND",
        rules: rulesDocument(1, 1, [
          tlayer(1, "input_Ground", 1, 1, [
            WOOD,
          ]),
          tlayer(2, "output_Missing", 1, 1, [
            BARREL,
          ]),
        ]),
      },
      {
        // Regular tile from a tileset the target does not reference.
        code: "TILESET_NOT_FOUND",
        rules: {
          ...rulesDocument(1, 1, [
            tlayer(1, "input_Ground", 1, 1, [
              20,
            ]),
            tlayer(2, "output_Deco", 1, 1, [
              BARREL,
            ]),
          ]),
          tilesets: [
            {
              firstgid: 1,
              source: "interior.tsj",
            },
            {
              firstgid: 20,
              source: "extra.tsj",
            },
            AUTOMAP_TILESET,
          ],
        },
        extraFiles: {
          "maps/extra.tsj": null,
        },
      },
      {
        // Regular tile from an embedded tileset.
        code: "UNSUPPORTED_FORMAT",
        rules: {
          ...rulesDocument(1, 1, [
            tlayer(1, "input_Ground", 1, 1, [
              30,
            ]),
            tlayer(2, "output_Deco", 1, 1, [
              BARREL,
            ]),
          ]),
          tilesets: [
            {
              firstgid: 1,
              source: "interior.tsj",
            },
            AUTOMAP_TILESET,
            {
              firstgid: 30,
              name: "inline",
              tilecount: 1,
              tilewidth: 16,
              tileheight: 16,
              columns: 1,
            },
          ],
        },
      },
      {
        // TMX rules maps are out of profile.
        code: "UNSUPPORTED_FORMAT",
        rules: rulesDocument(1, 1, [
          tlayer(1, "input_Ground", 1, 1, [
            WOOD,
          ]),
          tlayer(2, "output_Deco", 1, 1, [
            BARREL,
          ]),
        ]),
        rulesPath: "maps/rules.tmx",
      },
      {
        // Orientation mismatch with the target.
        code: "UNSUPPORTED_MAP_PROFILE",
        rules: {
          ...rulesDocument(1, 1, [
            tlayer(1, "input_Ground", 1, 1, [
              WOOD,
            ]),
            tlayer(2, "output_Deco", 1, 1, [
              BARREL,
            ]),
          ]),
          orientation: "isometric",
        },
      },
    ];
    for (const testCase of cases) {
      await withProject(
        {
          files: {
            ...(await fixtureFiles()),
            [MAP_PATH]: json(
              targetMap(grid48({ 0: WOOD })),
            ),
            [testCase.rulesPath ?? RULES_PATH]:
              json(testCase.rules),
            ...(testCase.extraFiles?.[
              "maps/extra.tsj"
            ] !== undefined
              ? {
                  "maps/extra.tsj": await readFile(
                    join(
                      FIXTURE_DIR,
                      "interior.tsj",
                    ),
                  ),
                }
              : {}),
          },
          prefix: "tiledmcp-automap",
        },
        async (harness) => {
          const service =
            harness.service as unknown as Service;
          await expect(
            plan(service, {
              rulesPath:
                testCase.rulesPath ?? RULES_PATH,
            }),
            `expected ${testCase.code}`,
          ).rejects.toMatchObject({
            code: testCase.code,
          });
        },
      );
    }
  });

  it("rejects a rules.txt that includes itself", async () => {
    await withProject(
      {
        files: {
          ...(await fixtureFiles()),
          [MAP_PATH]: json(
            targetMap(grid48({ 0: WOOD })),
          ),
          "maps/rules.txt": "rules.txt\n",
        },
        prefix: "tiledmcp-automap",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        await expect(
          plan(service, {
            rulesPath: "maps/rules.txt",
          }),
        ).rejects.toMatchObject({
          code: "INVALID_ARGUMENT",
        });
      },
    );
  });

  it("fails closed when the rules change nothing", async () => {
    await withProject(
      {
        files: {
          ...(await fixtureFiles()),
          [MAP_PATH]: json(
            targetMap(
              grid48({ 0: WOOD }),
              grid48({ 0: BARREL }),
            ),
          ),
          [RULES_PATH]: json(
            rulesDocument(1, 1, [
              tlayer(1, "input_Ground", 1, 1, [
                WOOD,
              ]),
              tlayer(2, "output_Deco", 1, 1, [
                BARREL,
              ]),
            ]),
          ),
        },
        prefix: "tiledmcp-automap",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        await expect(
          plan(service),
        ).rejects.toMatchObject({
          code: "PLAN_NO_CHANGES",
        });
      },
    );
  });
});
