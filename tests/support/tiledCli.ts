import { spawnSync } from "node:child_process";

/**
 * Where the Tiled CLI lives for this run. Honours TILED_CLI_PATH so a
 * non-standard install can be pointed at without editing tests.
 */
export const TILED_CLI_PATH =
  process.env.TILED_CLI_PATH ?? "tiled";

/**
 * Whether the Tiled CLI is actually runnable here, probed once per worker.
 *
 * Tests that cross-check our output against real Tiled must gate on this with
 * `it.skipIf(!hasTiledCli)`. The previous idiom -- catching ENOENT from the
 * export and returning -- reported those tests as PASSED on machines with no
 * Tiled installed, so a conformance check that never ran looked identical to
 * one that ran and succeeded.
 */
/**
 * The Qt platform plugin to run Tiled under.
 *
 * `offscreen` is the right default on Linux: it is what CI wants and what
 * `TiledCliAdapter` itself falls back to. But not every Tiled build ships the
 * offscreen plugin -- the macOS `Tiled.app` bundle carries only `cocoa`, and
 * asking it for `offscreen` aborts with SIGABRT. Worse, `--version` prints
 * before Qt initialises the platform plugin, so the probe below passed while
 * every actual export aborted: 4 conformance tests failed rather than
 * skipped. On darwin the variable therefore stays unset (cocoa runs CLI work
 * fine in a login session); a caller-supplied value still wins everywhere.
 *
 * Must stay declared above {@link hasTiledCli}'s initialiser: `probe()` is
 * hoisted but this binding is not, so declaring it below leaves it in the
 * temporal dead zone when the probe runs -- and probe's `try/catch` would
 * swallow the ReferenceError as "no Tiled installed".
 */
const QT_QPA_PLATFORM =
  process.env.QT_QPA_PLATFORM ??
  (process.platform === "darwin" ? undefined : "offscreen");

export const hasTiledCli: boolean = probe() !== null;

/**
 * Whether the installed CLI is exactly Tiled 1.12.2 — the version the
 * byte-parity fixtures were generated against. Tiled stamps its own
 * version into exported files (`tiledversion="1.12.1"` from a 1.12.1
 * install), so byte-for-byte comparisons against any other version fail
 * on the stamp alone and prove nothing about the serializer. Tests that
 * assert byte equality with real CLI output gate on this; the
 * verify:tiled-1.12.2 preflight still hard-fails on an inexact version
 * before any test can skip, so the hard gate keeps its meaning.
 */
export const hasExactTiled1122: boolean =
  probe() === "1.12.2";

function probe(): string | null {
  try {
    const result = spawnSync(
      TILED_CLI_PATH,
      ["--version"],
      {
        env: {
          ...process.env,
          // C.UTF-8, not C: under a non-UTF-8 locale Qt warns on stderr
          // ("Detected locale \"C\" ... is not UTF-8"), which the strict
          // integration preflight rejects as unexpected stderr.
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          ...(QT_QPA_PLATFORM === undefined
            ? {}
            : { QT_QPA_PLATFORM }),
        },
        timeout: 30_000,
      },
    );
    if (
      result.error !== undefined ||
      result.status !== 0
    ) {
      return null;
    }
    const match = /Tiled\s+(\S+)/u.exec(
      String(result.stdout),
    );
    return match?.[1] ?? "unknown";
  } catch {
    return null;
  }
}

/** Environment the CLI needs to run headless and locale-stable. */
export const TILED_CLI_ENV = {
  ...process.env,
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  QT_QPA_PLATFORM,
} as const;
