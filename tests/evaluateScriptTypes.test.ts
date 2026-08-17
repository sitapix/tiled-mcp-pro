import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTerrainPaintScript } from "../src/maps/terrainPaint.js";
import { AUTOMAP_CANARY_SCRIPT } from "./support/automapCanaryScript.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

/**
 * Typechecks the server-authored `tiled --evaluate` scripts against the
 * official @mapeditor/tiled-api declarations (published from the same
 * sources as Tiled's scripting docs, versioned with Tiled). The scripts
 * are built as strings, so nothing else would notice when a Tiled
 * release renames or removes an API they drive — this fails the suite
 * the day the declarations drop `wangEdit`, `mapFormat`, `autoMap`, or
 * any other member the scripts touch.
 *
 * The working directory lives under node_modules/.cache rather than the
 * OS tmpdir so tsc's node-style resolution of the `types` entry walks up
 * into this repo's node_modules.
 */

const WORK_DIR = join(
  process.cwd(),
  "node_modules",
  ".cache",
  "tiledmcp-evaluate-script-types",
);

// Local identifiers stay untyped (the scripts are plain JS), so strict
// implicit-any is off; every property access on values that *originate
// from the API globals* is still checked, which is the drift signal.
const TSCONFIG = {
  compilerOptions: {
    noEmit: true,
    strict: false,
    lib: ["ES2020"],
    types: ["@mapeditor/tiled-api"],
  },
  include: ["*.ts"],
};

describe("evaluate script typechecking", () => {
  beforeAll(async () => {
    await rm(WORK_DIR, {
      recursive: true,
      force: true,
    });
    await mkdir(WORK_DIR, { recursive: true });
    await writeFile(
      join(WORK_DIR, "tsconfig.json"),
      JSON.stringify(TSCONFIG, null, 2),
    );
    await writeFile(
      join(WORK_DIR, "terrainPaint.ts"),
      buildTerrainPaintScript({
        sourcePath: "/project/map.tmj",
        outputPath: "/staging/out.tmj",
        layerId: 1,
        tilesetIndex: 0,
        wangSetIndex: 0,
        corners: [{ x: 0, y: 0, colorIndex: 1 }],
      }),
    );
    await writeFile(
      join(WORK_DIR, "automapCanary.ts"),
      AUTOMAP_CANARY_SCRIPT,
    );
  });

  afterAll(async () => {
    await rm(WORK_DIR, {
      recursive: true,
      force: true,
    });
  });

  it("matches the official @mapeditor/tiled-api declarations", async () => {
    const tscBin = join(
      dirname(
        require.resolve("typescript/package.json"),
      ),
      "bin",
      "tsc",
    );
    try {
      await execFileAsync(
        process.execPath,
        [tscBin, "-p", WORK_DIR],
        { timeout: 120_000 },
      );
    } catch (error) {
      const failure = error as {
        stdout?: string;
        stderr?: string;
      };
      expect.fail(
        "evaluate scripts no longer typecheck against " +
          "@mapeditor/tiled-api:\n" +
          `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
      );
    }
  });
});
