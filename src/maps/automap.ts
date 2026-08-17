import { TiledMcpError } from "../errors.js";
import type {
  JsonObject,
  JsonValue,
} from "../formats/json.js";
import {
  expectArray,
  expectInteger,
  expectObject,
  expectString,
} from "../formats/json.js";
import { hashToUnit } from "./generate.js";
import {
  GID_FLAGS_MASK,
  GID_FLIP_HORIZONTAL,
  GID_FLIP_VERTICAL,
  GID_DIAGONAL_OR_HEX_60,
  GID_HEX_120,
  GID_ID_MASK,
  decodeGid,
  type MapOrientation,
} from "./gid.js";

/*
 * Native AutoMapping: a deterministic port of the tile-layer core of Tiled
 * 1.12.2's rule engine (`src/tiled/automapper.cpp` in the Tiled sources).
 *
 * Delegating to Tiled itself is impossible headlessly — `tiled --evaluate`
 * can obtain a `TileMap` only through `tiled.open()` (throws "Editor not
 * available" without the GUI) or `MapFormat.read()` (returns a detached map,
 * on which `autoMap()` throws) — `tests/automapCanary.test.ts` keeps both
 * probes executable. So the rule semantics are reimplemented here, against
 * the 1.12.2 sources, for a restricted profile that fails closed everywhere
 * the port would otherwise have to guess:
 *
 *   - Rules maps must be finite TMJ, same orientation and tile size as the
 *     target. Legacy `regions*` layers (pre-1.9 rules) are rejected.
 *   - Only tile-layer outputs are supported. Object-layer outputs, output
 *     layers carrying custom properties (which Tiled would copy onto the
 *     target), and output layers missing from the target map (which Tiled
 *     would create) are all rejected with actionable errors.
 *   - Where Tiled logs a warning and silently ignores the construct — an
 *     unknown property, an unrecognized layer name — this port errors, since
 *     a silently dropped `outpt_Ground` typo is exactly the failure mode the
 *     warnings exist to catch and no warning channel reaches the client.
 *   - Tiled draws rule/output randomness from `std::random_device`; this
 *     port derives it from a caller-supplied seed hashed with the match
 *     coordinates (`hashToUnit`), so the same inputs always produce the
 *     same plan. The probability semantics are unchanged; only the entropy
 *     source is.
 *   - `MatchType` is read from a tile's own property, matching Tiled when no
 *     project file is loaded; class-inherited MatchType members are not
 *     resolved.
 */

/** The four visual-transform GID flag bits, Tiled's `Cell::VisualFlags`. */
const VISUAL_FLAGS = GID_FLAGS_MASK;

export interface AutomapOptions {
  deleteTiles: boolean;
  matchOutsideMap: boolean;
  overflowBorder: boolean;
  wrapBorder: boolean;
  matchInOrder: boolean;
  autoMappingRadius: number;
}

/**
 * Per-rule options. `skipChance` is stored inverted from the user-facing
 * `Probability` property, exactly as `AutoMapper::checkRuleOptions` does.
 */
export interface AutomapRuleOptions {
  skipChance: number;
  modX: number;
  modY: number;
  offsetX: number;
  offsetY: number;
  noOverlappingOutput: boolean;
  disabled: boolean;
  ignoreLock: boolean;
}

export interface AutomapRuleOptionsArea {
  left: number;
  top: number;
  right: number;
  bottom: number;
  options: Partial<AutomapRuleOptions>;
}

export type AutomapRuleCell =
  | {
      kind: "tile";
      /** Base GID re-expressed in the target map's GID space. */
      baseGid: number;
      /** The cell's visual-transform flag bits (high GID bits). */
      flags: number;
    }
  | { kind: "empty" }
  | { kind: "nonEmpty" }
  | { kind: "other" }
  | { kind: "negate" }
  | { kind: "ignore" };

interface AutomapInputLayerGrid {
  cells: ReadonlyArray<AutomapRuleCell | null>;
  strictEmpty: boolean;
  flagsMask: number;
}

interface AutomapInputConditions {
  layerName: string;
  listYes: AutomapInputLayerGrid[];
  listNo: AutomapInputLayerGrid[];
}

interface AutomapInputSet {
  name: string;
  layers: AutomapInputConditions[];
}

interface AutomapOutputLayerGrid {
  cells: ReadonlyArray<AutomapRuleCell | null>;
  targetLayerName: string;
}

interface AutomapOutputSet {
  name: string;
  layers: AutomapOutputLayerGrid[];
  probability: number;
}

export interface AutomapRulesMapModel {
  rulesMapPath: string;
  width: number;
  height: number;
  options: AutomapOptions;
  defaultRuleOptions: AutomapRuleOptions;
  ruleOptionsAreas: AutomapRuleOptionsArea[];
  inputSets: AutomapInputSet[];
  outputSets: AutomapOutputSet[];
  inputLayerNames: ReadonlySet<string>;
  outputTileLayerNames: ReadonlySet<string>;
}

/**
 * One tileset slot of the rules map, resolved by the caller (which owns all
 * I/O). `targetFirstGid` is the target map's firstgid for the same tileset
 * file, or null when the target does not bind that file — in which case only
 * MatchType-special tiles from the slot may appear in rule layers.
 */
export interface AutomapTilesetSlot {
  firstGid: number;
  targetFirstGid: number | null;
  tileCount: number;
  /** Raw `MatchType` tile property values by local id. */
  matchTypes: ReadonlyMap<number, string>;
  /** How to name the tileset in errors (path, or embedded name). */
  label: string;
  embedded: boolean;
}

export interface AutomapTargetLayer {
  name: string;
  locked: boolean;
  original: Uint32Array;
  working: Uint32Array;
}

export interface AutomapBudget {
  maxRules: number;
  maxMatchOperations: number;
}

const DEFAULT_RULE_OPTIONS: AutomapRuleOptions = {
  skipChance: 0,
  modX: 1,
  modY: 1,
  offsetX: 0,
  offsetY: 0,
  noOverlappingOutput: false,
  disabled: false,
  ignoreLock: false,
};

interface PropertyEntry {
  name: string;
  type: string;
  value: JsonValue | undefined;
}

function readProperties(
  value: JsonValue | undefined,
  context: string,
): PropertyEntry[] {
  if (value === undefined) {
    return [];
  }
  return expectArray(value, context).map(
    (raw, index) => {
      const entry = expectObject(
        raw,
        `${context}[${index}]`,
      );
      const type =
        entry.type === undefined
          ? "string"
          : expectString(
              entry.type,
              `${context}[${index}].type`,
            );
      return {
        name: expectString(
          entry.name,
          `${context}[${index}].name`,
        ),
        type,
        value: entry.value,
      };
    },
  );
}

function expectBoolProperty(
  entry: PropertyEntry,
  context: string,
): boolean {
  if (
    entry.type !== "bool" ||
    typeof entry.value !== "boolean"
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} property ${JSON.stringify(entry.name)} must be a bool.`,
      { property: entry.name, type: entry.type },
    );
  }
  return entry.value;
}

function expectIntProperty(
  entry: PropertyEntry,
  context: string,
): number {
  if (
    entry.type !== "int" ||
    typeof entry.value !== "number" ||
    !Number.isSafeInteger(entry.value)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} property ${JSON.stringify(entry.name)} must be an int.`,
      { property: entry.name, type: entry.type },
    );
  }
  return entry.value;
}

function expectFloatProperty(
  entry: PropertyEntry,
  context: string,
): number {
  if (
    (entry.type !== "float" &&
      entry.type !== "int") ||
    typeof entry.value !== "number" ||
    !Number.isFinite(entry.value)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} property ${JSON.stringify(entry.name)} must be a float.`,
      { property: entry.name, type: entry.type },
    );
  }
  return entry.value;
}

function nameIs(
  entry: PropertyEntry,
  option: string,
): boolean {
  return (
    entry.name.toLowerCase() ===
    option.toLowerCase()
  );
}

/**
 * The shared rule-option properties accepted on the rules map itself and on
 * `rule_options` rectangles, ported from `checkRuleOptions`. Returns false
 * when the entry names none of them.
 */
function applyRuleOptionEntry(
  entry: PropertyEntry,
  context: string,
  options: Partial<AutomapRuleOptions>,
): boolean {
  if (nameIs(entry, "Probability")) {
    options.skipChance =
      1 - expectFloatProperty(entry, context);
    return true;
  }
  if (nameIs(entry, "ModX")) {
    options.modX = Math.max(
      1,
      expectNonNegativeIntProperty(entry, context),
    );
    return true;
  }
  if (nameIs(entry, "ModY")) {
    options.modY = Math.max(
      1,
      expectNonNegativeIntProperty(entry, context),
    );
    return true;
  }
  if (nameIs(entry, "OffsetX")) {
    options.offsetX = expectIntProperty(
      entry,
      context,
    );
    return true;
  }
  if (nameIs(entry, "OffsetY")) {
    options.offsetY = expectIntProperty(
      entry,
      context,
    );
    return true;
  }
  if (nameIs(entry, "NoOverlappingOutput")) {
    options.noOverlappingOutput =
      expectBoolProperty(entry, context);
    return true;
  }
  if (nameIs(entry, "Disabled")) {
    options.disabled = expectBoolProperty(
      entry,
      context,
    );
    return true;
  }
  if (nameIs(entry, "IgnoreLock")) {
    options.ignoreLock = expectBoolProperty(
      entry,
      context,
    );
    return true;
  }
  return false;
}

function expectNonNegativeIntProperty(
  entry: PropertyEntry,
  context: string,
): number {
  const value = expectIntProperty(entry, context);
  if (value < 0) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} property ${JSON.stringify(entry.name)} must not be negative.`,
      { property: entry.name, value },
    );
  }
  return value;
}

interface FlatLayer {
  object: JsonObject;
  context: string;
}

/**
 * Flattens the layer tree the way `Map::allLayers()` presents it: group
 * containers contribute their children, not themselves; image layers carry
 * no automapping meaning and are skipped, as Tiled does.
 */
function flattenLayers(
  layers: JsonValue[],
  context: string,
  out: FlatLayer[],
): void {
  for (const [index, raw] of layers.entries()) {
    const layer = expectObject(
      raw,
      `${context}[${index}]`,
    );
    const type = expectString(
      layer.type,
      `${context}[${index}].type`,
    );
    if (type === "group") {
      flattenLayers(
        expectArray(
          layer.layers ?? [],
          `${context}[${index}].layers`,
        ),
        `${context}[${index}].layers`,
        out,
      );
      continue;
    }
    if (type === "imagelayer") {
      continue;
    }
    out.push({
      object: layer,
      context: `${context}[${index}]`,
    });
  }
}

function decodeRuleLayerGrid(
  layer: JsonObject,
  context: string,
  rulesMapPath: string,
  width: number,
  height: number,
  slots: readonly AutomapTilesetSlot[],
  orientation: MapOrientation,
): Array<AutomapRuleCell | null> {
  if ("chunks" in layer) {
    throw new TiledMcpError(
      "UNSUPPORTED_MAP_PROFILE",
      `${context} is chunked; rules maps must be finite.`,
      { path: rulesMapPath },
    );
  }
  const layerWidth = expectInteger(
    layer.width,
    `${context}.width`,
  );
  const layerHeight = expectInteger(
    layer.height,
    `${context}.height`,
  );
  if (
    layerWidth !== width ||
    layerHeight !== height
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${context} is ${layerWidth}x${layerHeight} but the rules map is ${width}x${height}.`,
      { path: rulesMapPath },
    );
  }
  const data = expectArray(
    layer.data,
    `${context}.data`,
  );
  if (data.length !== width * height) {
    throw new TiledMcpError(
      "INVALID_TILE_DATA",
      `${context}.data length does not match width × height.`,
      {
        expected: width * height,
        actual: data.length,
      },
    );
  }
  const cells: Array<AutomapRuleCell | null> = [];
  for (const [index, raw] of data.entries()) {
    const gid = expectInteger(
      raw,
      `${context}.data[${index}]`,
    );
    if (gid === 0) {
      cells.push(null);
      continue;
    }
    // Validates the flag bits and rejects flags-on-empty.
    decodeGid(gid, orientation);
    const baseGid = (gid & GID_ID_MASK) >>> 0;
    const flags = (gid & GID_FLAGS_MASK) >>> 0;
    let slot: AutomapTilesetSlot | undefined;
    for (const candidate of slots) {
      if (
        candidate.firstGid <= baseGid &&
        (slot === undefined ||
          candidate.firstGid > slot.firstGid)
      ) {
        slot = candidate;
      }
    }
    if (slot === undefined) {
      throw new TiledMcpError(
        "GID_OUT_OF_RANGE",
        `${context} holds GID ${baseGid}, which no tileset in ${rulesMapPath} covers.`,
        { gid: baseGid, path: rulesMapPath },
      );
    }
    const localId = baseGid - slot.firstGid;
    if (localId >= slot.tileCount) {
      throw new TiledMcpError(
        "GID_OUT_OF_RANGE",
        `${context} holds GID ${baseGid}, which is past the end of ${slot.label}.`,
        {
          gid: baseGid,
          localId,
          tileCount: slot.tileCount,
        },
      );
    }
    const matchType = slot.matchTypes.get(localId);
    switch (matchType) {
      case "Empty":
        cells.push({ kind: "empty" });
        continue;
      case "NonEmpty":
        cells.push({ kind: "nonEmpty" });
        continue;
      case "Other":
        cells.push({ kind: "other" });
        continue;
      case "Negate":
        cells.push({ kind: "negate" });
        continue;
      case "Ignore":
        cells.push({ kind: "ignore" });
        continue;
      default:
        break;
    }
    if (slot.embedded) {
      throw new TiledMcpError(
        "UNSUPPORTED_FORMAT",
        `${context} uses tile ${localId} of the embedded tileset ${JSON.stringify(slot.label)} as a regular tile; only MatchType-special tiles may come from embedded tilesets, because a regular tile cannot be re-expressed in the target map's GID space. Reference the tileset externally instead.`,
        { path: rulesMapPath, localId },
      );
    }
    if (slot.targetFirstGid === null) {
      throw new TiledMcpError(
        "TILESET_NOT_FOUND",
        `${context} uses tile ${localId} of ${slot.label}, which the target map does not reference. Attach it with tiled_add_tileset_to_map before automapping.`,
        {
          path: rulesMapPath,
          tileset: slot.label,
          localId,
        },
      );
    }
    cells.push({
      kind: "tile",
      baseGid: slot.targetFirstGid + localId,
      flags,
    });
  }
  return cells;
}

function parseLayerNameParts(
  ruleMapLayerName: string,
): {
  role: "input" | "inputnot" | "output" | null;
  setName: string;
  layerName: string;
} | null {
  const underscore =
    ruleMapLayerName.indexOf("_");
  if (underscore === -1) {
    return null;
  }
  const layerName = ruleMapLayerName.slice(
    underscore + 1,
  );
  let setName = ruleMapLayerName.slice(
    0,
    underscore,
  );
  const lowered = setName.toLowerCase();
  let role: "input" | "inputnot" | "output" | null =
    null;
  if (lowered.startsWith("output")) {
    role = "output";
    setName = setName.slice(6);
  } else if (lowered.startsWith("inputnot")) {
    role = "inputnot";
    setName = setName.slice(8);
  } else if (lowered.startsWith("input")) {
    role = "input";
    setName = setName.slice(5);
  }
  return { role, setName, layerName };
}

export interface ParseAutomapRulesMapInput {
  document: JsonObject;
  rulesMapPath: string;
  slots: readonly AutomapTilesetSlot[];
  orientation: MapOrientation;
  tileWidth: number;
  tileHeight: number;
}

export function parseAutomapRulesMap(
  input: ParseAutomapRulesMapInput,
): AutomapRulesMapModel {
  const {
    document,
    rulesMapPath,
    slots,
    orientation,
  } = input;
  const width = expectInteger(
    document.width,
    `${rulesMapPath}.width`,
  );
  const height = expectInteger(
    document.height,
    `${rulesMapPath}.height`,
  );

  const options: AutomapOptions = {
    deleteTiles: false,
    matchOutsideMap: false,
    overflowBorder: false,
    wrapBorder: false,
    matchInOrder: false,
    autoMappingRadius: 0,
  };
  const defaultRuleOptions: AutomapRuleOptions = {
    ...DEFAULT_RULE_OPTIONS,
  };
  let noOverlappingRules = false;
  let noOverlappingOutputSet = false;

  const mapContext = `${rulesMapPath} map`;
  for (const entry of readProperties(
    document.properties,
    `${rulesMapPath}.properties`,
  )) {
    if (nameIs(entry, "DeleteTiles")) {
      options.deleteTiles = expectBoolProperty(
        entry,
        mapContext,
      );
    } else if (nameIs(entry, "MatchOutsideMap")) {
      options.matchOutsideMap =
        expectBoolProperty(entry, mapContext);
    } else if (nameIs(entry, "OverflowBorder")) {
      options.overflowBorder =
        expectBoolProperty(entry, mapContext);
    } else if (nameIs(entry, "WrapBorder")) {
      options.wrapBorder = expectBoolProperty(
        entry,
        mapContext,
      );
    } else if (
      nameIs(entry, "AutomappingRadius")
    ) {
      options.autoMappingRadius =
        expectNonNegativeIntProperty(
          entry,
          mapContext,
        );
    } else if (
      nameIs(entry, "NoOverlappingRules")
    ) {
      noOverlappingRules = expectBoolProperty(
        entry,
        mapContext,
      );
    } else if (nameIs(entry, "MatchInOrder")) {
      options.matchInOrder = expectBoolProperty(
        entry,
        mapContext,
      );
    } else {
      const partial: Partial<AutomapRuleOptions> =
        {};
      if (
        !applyRuleOptionEntry(
          entry,
          mapContext,
          partial,
        )
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `${rulesMapPath} has unknown map property ${JSON.stringify(entry.name)}; Tiled would ignore it with a warning, but a typo here silently changes what the rules do, so it is rejected. Remove it or fix its name.`,
          { path: rulesMapPath, property: entry.name },
        );
      }
      if (
        partial.noOverlappingOutput !== undefined
      ) {
        noOverlappingOutputSet = true;
      }
      Object.assign(defaultRuleOptions, partial);
    }
  }
  if (options.overflowBorder || options.wrapBorder) {
    options.matchOutsideMap = true;
  }
  if (!noOverlappingOutputSet) {
    defaultRuleOptions.noOverlappingOutput =
      noOverlappingRules;
  }

  const flat: FlatLayer[] = [];
  flattenLayers(
    expectArray(
      document.layers,
      `${rulesMapPath}.layers`,
    ),
    `${rulesMapPath}.layers`,
    flat,
  );

  const inputSets: AutomapInputSet[] = [];
  const outputSets: AutomapOutputSet[] = [];
  const ruleOptionsAreas: AutomapRuleOptionsArea[] =
    [];
  const inputLayerNames = new Set<string>();
  const outputTileLayerNames = new Set<string>();

  for (const { object: layer, context } of flat) {
    const ruleMapLayerName = expectString(
      layer.name,
      `${context}.name`,
    );
    const type = expectString(
      layer.type,
      `${context}.type`,
    );
    if (ruleMapLayerName.startsWith("//")) {
      continue;
    }
    if (
      ruleMapLayerName
        .toLowerCase()
        .startsWith("regions")
    ) {
      throw new TiledMcpError(
        "UNSUPPORTED_FORMAT",
        `${rulesMapPath} uses the pre-1.9 'regions' rule format (layer ${JSON.stringify(ruleMapLayerName)}); only the Tiled 1.9+ format is supported. Delete the regions layers and use MatchType tiles instead, per the Tiled automapping manual.`,
        {
          path: rulesMapPath,
          layerName: ruleMapLayerName,
        },
      );
    }
    if (
      ruleMapLayerName.toLowerCase() ===
      "rule_options"
    ) {
      if (type !== "objectgroup") {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `${rulesMapPath}: 'rule_options' layers must be object layers.`,
          { path: rulesMapPath },
        );
      }
      if (orientation !== "orthogonal") {
        throw new TiledMcpError(
          "UNSUPPORTED_FORMAT",
          `${rulesMapPath} has a 'rule_options' layer on a ${orientation} map; the pixel-to-tile projection of options rectangles is only supported on orthogonal maps.`,
          { path: rulesMapPath, orientation },
        );
      }
      for (const rawObject of expectArray(
        layer.objects ?? [],
        `${context}.objects`,
      )) {
        const mapObject = expectObject(
          rawObject,
          `${context}.objects[]`,
        );
        const isPlainRectangle =
          mapObject.gid === undefined &&
          mapObject.ellipse !== true &&
          mapObject.point !== true &&
          mapObject.polygon === undefined &&
          mapObject.polyline === undefined &&
          mapObject.text === undefined;
        if (
          !isPlainRectangle ||
          (typeof mapObject.rotation ===
            "number" &&
            mapObject.rotation !== 0)
        ) {
          throw new TiledMcpError(
            "UNSUPPORTED_FORMAT",
            `${rulesMapPath}: only unrotated rectangle objects are supported on 'rule_options' layers; Tiled would skip this object with a warning, silently dropping its options.`,
            { path: rulesMapPath },
          );
        }
        const px = readFiniteNumber(
          mapObject.x,
          `${context}.objects[].x`,
        );
        const py = readFiniteNumber(
          mapObject.y,
          `${context}.objects[].y`,
        );
        const pw = readFiniteNumber(
          mapObject.width ?? 0,
          `${context}.objects[].width`,
        );
        const ph = readFiniteNumber(
          mapObject.height ?? 0,
          `${context}.objects[].height`,
        );
        // objectTileRect: pixel bounds to tile space, then the smallest
        // aligned rect containing them (QRectF::toAlignedRect).
        const area: AutomapRuleOptionsArea = {
          left: Math.floor(px / input.tileWidth),
          top: Math.floor(py / input.tileHeight),
          right:
            Math.ceil(
              (px + pw) / input.tileWidth,
            ) - 1,
          bottom:
            Math.ceil(
              (py + ph) / input.tileHeight,
            ) - 1,
          options: {},
        };
        const objectContext = `${rulesMapPath} rule_options object`;
        for (const entry of readProperties(
          mapObject.properties,
          `${context}.objects[].properties`,
        )) {
          if (
            !applyRuleOptionEntry(
              entry,
              objectContext,
              area.options,
            )
          ) {
            throw new TiledMcpError(
              "INVALID_ARGUMENT",
              `${rulesMapPath} rule_options object has unknown property ${JSON.stringify(entry.name)}.`,
              {
                path: rulesMapPath,
                property: entry.name,
              },
            );
          }
        }
        ruleOptionsAreas.push(area);
      }
      continue;
    }

    const parts = parseLayerNameParts(
      ruleMapLayerName,
    );
    if (parts === null) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${rulesMapPath}: did you forget an underscore in layer ${JSON.stringify(ruleMapLayerName)}? Prefix the name with // to comment the layer out.`,
        {
          path: rulesMapPath,
          layerName: ruleMapLayerName,
        },
      );
    }
    const { role, setName, layerName } = parts;
    if (role === "input" || role === "inputnot") {
      if (type !== "tilelayer") {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `${rulesMapPath}: 'input_*' and 'inputnot_*' layers must be tile layers.`,
          {
            path: rulesMapPath,
            layerName: ruleMapLayerName,
          },
        );
      }
      inputLayerNames.add(layerName);
      const grid: AutomapInputLayerGrid = {
        cells: decodeRuleLayerGrid(
          layer,
          context,
          rulesMapPath,
          width,
          height,
          slots,
          orientation,
        ),
        strictEmpty: false,
        flagsMask: VISUAL_FLAGS,
      };
      const layerContext = `${rulesMapPath} layer ${JSON.stringify(ruleMapLayerName)}`;
      for (const entry of readProperties(
        layer.properties,
        `${context}.properties`,
      )) {
        if (
          nameIs(entry, "StrictEmpty") ||
          nameIs(entry, "AutoEmpty")
        ) {
          grid.strictEmpty = expectBoolProperty(
            entry,
            layerContext,
          );
        } else if (
          nameIs(entry, "IgnoreHorizontalFlip")
        ) {
          if (
            expectBoolProperty(entry, layerContext)
          ) {
            grid.flagsMask =
              (grid.flagsMask &
                ~GID_FLIP_HORIZONTAL) >>>
              0;
          }
        } else if (
          nameIs(entry, "IgnoreVerticalFlip")
        ) {
          if (
            expectBoolProperty(entry, layerContext)
          ) {
            grid.flagsMask =
              (grid.flagsMask &
                ~GID_FLIP_VERTICAL) >>>
              0;
          }
        } else if (
          nameIs(entry, "IgnoreDiagonalFlip")
        ) {
          if (
            expectBoolProperty(entry, layerContext)
          ) {
            grid.flagsMask =
              (grid.flagsMask &
                ~GID_DIAGONAL_OR_HEX_60) >>>
              0;
          }
        } else if (
          nameIs(entry, "IgnoreHexRotate120")
        ) {
          if (
            expectBoolProperty(entry, layerContext)
          ) {
            grid.flagsMask =
              (grid.flagsMask & ~GID_HEX_120) >>>
              0;
          }
        } else {
          throw new TiledMcpError(
            "INVALID_ARGUMENT",
            `${layerContext} has unknown property ${JSON.stringify(entry.name)}; Tiled would ignore it with a warning, but a typo here silently changes what the rule matches, so it is rejected.`,
            {
              path: rulesMapPath,
              property: entry.name,
            },
          );
        }
      }
      let inputSet = inputSets.find(
        (candidate) => candidate.name === setName,
      );
      if (inputSet === undefined) {
        inputSet = { name: setName, layers: [] };
        inputSets.push(inputSet);
      }
      let conditions = inputSet.layers.find(
        (candidate) =>
          candidate.layerName === layerName,
      );
      if (conditions === undefined) {
        conditions = {
          layerName,
          listYes: [],
          listNo: [],
        };
        inputSet.layers.push(conditions);
      }
      if (role === "inputnot") {
        conditions.listNo.push(grid);
      } else {
        conditions.listYes.push(grid);
      }
      continue;
    }
    if (role === "output") {
      if (type === "objectgroup") {
        throw new TiledMcpError(
          "UNSUPPORTED_FORMAT",
          `${rulesMapPath} layer ${JSON.stringify(ruleMapLayerName)} is an object-layer output; only tile-layer outputs are supported.`,
          {
            path: rulesMapPath,
            layerName: ruleMapLayerName,
          },
        );
      }
      if (type !== "tilelayer") {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `${rulesMapPath}: 'output_*' layers must be tile or object layers.`,
          {
            path: rulesMapPath,
            layerName: ruleMapLayerName,
          },
        );
      }
      outputTileLayerNames.add(layerName);
      let outputSet = outputSets.find(
        (candidate) => candidate.name === setName,
      );
      if (outputSet === undefined) {
        outputSet = {
          name: setName,
          layers: [],
          probability: 1,
        };
        outputSets.push(outputSet);
      }
      const layerContext = `${rulesMapPath} layer ${JSON.stringify(ruleMapLayerName)}`;
      for (const entry of readProperties(
        layer.properties,
        `${context}.properties`,
      )) {
        if (nameIs(entry, "Probability")) {
          outputSet.probability =
            expectFloatProperty(
              entry,
              layerContext,
            );
        } else {
          throw new TiledMcpError(
            "UNSUPPORTED_FORMAT",
            `${layerContext} has custom property ${JSON.stringify(entry.name)}, which Tiled would copy onto the target layer when the rule matches; property-copying outputs are not supported. Remove the property.`,
            {
              path: rulesMapPath,
              property: entry.name,
            },
          );
        }
      }
      outputSet.layers.push({
        cells: decodeRuleLayerGrid(
          layer,
          context,
          rulesMapPath,
          width,
          height,
          slots,
          orientation,
        ),
        targetLayerName: layerName,
      });
      continue;
    }
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${rulesMapPath}: layer ${JSON.stringify(ruleMapLayerName)} is not recognized as a valid layer for automapping; Tiled would ignore it with a warning. Prefix the name with // to comment it out.`,
      {
        path: rulesMapPath,
        layerName: ruleMapLayerName,
      },
    );
  }

  if (inputSets.length === 0) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${rulesMapPath} has no input_<name> or inputnot_<name> layer.`,
      { path: rulesMapPath },
    );
  }
  if (outputSets.length === 0) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${rulesMapPath} has no output_<name> layer.`,
      { path: rulesMapPath },
    );
  }
  for (const inputSet of inputSets) {
    inputSet.layers.sort((a, b) =>
      a.layerName < b.layerName
        ? -1
        : a.layerName > b.layerName
          ? 1
          : 0,
    );
  }

  return {
    rulesMapPath,
    width,
    height,
    options,
    defaultRuleOptions,
    ruleOptionsAreas,
    inputSets,
    outputSets,
    inputLayerNames,
    outputTileLayerNames,
  };
}

/**
 * Reads the per-tile `MatchType` property values from a tileset's `tiles`
 * member. The property lookup is by exact name, matching Tiled's
 * case-sensitive property map; class-inherited values are not resolved,
 * which matches Tiled when no project file is loaded.
 */
export function readTileMatchTypes(
  tiles: JsonValue | undefined,
  context: string,
): ReadonlyMap<number, string> {
  const matchTypes = new Map<number, string>();
  if (tiles === undefined) {
    return matchTypes;
  }
  for (const [index, raw] of expectArray(
    tiles,
    `${context}.tiles`,
  ).entries()) {
    const tile = expectObject(
      raw,
      `${context}.tiles[${index}]`,
    );
    const id = expectInteger(
      tile.id,
      `${context}.tiles[${index}].id`,
    );
    if (tile.properties === undefined) {
      continue;
    }
    for (const rawProperty of expectArray(
      tile.properties,
      `${context}.tiles[${index}].properties`,
    )) {
      const property = expectObject(
        rawProperty,
        `${context}.tiles[${index}].properties[]`,
      );
      if (
        property.name === "MatchType" &&
        typeof property.value === "string"
      ) {
        matchTypes.set(id, property.value);
      }
    }
  }
  return matchTypes;
}

/**
 * Compiles a rules.txt `[map name filter]` into an anchored, case-insensitive
 * regular expression, following Qt's wildcard grammar as
 * `AutomappingManager::loadRulesFile` uses it: `*` and `?` wildcards plus
 * `[abc]` / `[!abc]` character classes.
 */
export function compileAutomapMapNameFilter(
  pattern: string,
  context: string,
): RegExp {
  let regex = "";
  let index = 0;
  while (index < pattern.length) {
    const ch = pattern[index] as string;
    if (ch === "*") {
      regex += ".*";
    } else if (ch === "?") {
      regex += ".";
    } else if (ch === "[") {
      let cursor = index + 1;
      let negated = false;
      if (pattern[cursor] === "!") {
        negated = true;
        cursor += 1;
      }
      let body = "";
      while (
        cursor < pattern.length &&
        pattern[cursor] !== "]"
      ) {
        body += escapeForCharacterClass(
          pattern[cursor] as string,
        );
        cursor += 1;
      }
      if (
        cursor >= pattern.length ||
        body === ""
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `${context} has a malformed map name filter ${JSON.stringify(`[${pattern}]`)}.`,
          { pattern },
        );
      }
      regex += `[${negated ? "^" : ""}${body}]`;
      index = cursor;
    } else {
      regex += escapeForRegExp(ch);
    }
    index += 1;
  }
  return new RegExp(`^${regex}$`, "iu");
}

function escapeForRegExp(ch: string): string {
  return /[.*+?^${}()|[\]\\]/u.test(ch)
    ? `\\${ch}`
    : ch;
}

function escapeForCharacterClass(
  ch: string,
): string {
  return /[\\\]^-]/u.test(ch) ? `\\${ch}` : ch;
}

function readFiniteNumber(
  value: JsonValue | undefined,
  context: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value)
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${context} must be a finite number.`,
    );
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* The matcher.                                                        */
/* ------------------------------------------------------------------ */

interface MatchCell {
  baseGid: number;
  flags: number;
  flagsMask: number;
}

const EMPTY_MATCH_CELL: MatchCell = {
  baseGid: 0,
  flags: 0,
  flagsMask: VISUAL_FLAGS,
};

interface Rule {
  /** Packed cell indexes into the rules map grid. */
  inputRegion: number[];
  outputRegion: number[];
  inputLeft: number;
  inputTop: number;
  inputRight: number;
  inputBottom: number;
  options: AutomapRuleOptions;
  unconditionalOutput:
    | AutomapOutputLayerGrid[]
    | null;
  weightedOutputs: Array<{
    layers: AutomapOutputLayerGrid[];
    probability: number;
  }>;
}

interface CompiledPosition {
  x: number;
  y: number;
  anyOf: MatchCell[];
  noneOf: MatchCell[];
}

interface CompiledLayer {
  working: Uint32Array | null;
  positions: CompiledPosition[];
}

type CompiledInputSet = CompiledLayer[];

function compareMatchCell(
  a: MatchCell,
  b: MatchCell,
): number {
  if (a.baseGid !== b.baseGid) {
    return a.baseGid - b.baseGid;
  }
  if (a.flags !== b.flags) {
    return a.flags - b.flags;
  }
  return a.flagsMask - b.flagsMask;
}

function pushUniqueCell(
  cells: MatchCell[],
  cell: MatchCell,
): void {
  if (
    !cells.some(
      (candidate) =>
        compareMatchCell(candidate, cell) === 0,
    )
  ) {
    cells.push(cell);
  }
}

/**
 * `optimizeAnyNoneOf`: after deduplication, when specific tiles are wanted
 * the noneOf list is folded away; returns false when the position can never
 * match.
 */
function optimizeAnyNoneOf(position: {
  anyOf: MatchCell[];
  noneOf: MatchCell[];
}): boolean {
  position.noneOf.sort(compareMatchCell);
  position.noneOf = dedupeSorted(position.noneOf);
  if (position.anyOf.length > 0) {
    position.anyOf.sort(compareMatchCell);
    position.anyOf = dedupeSorted(position.anyOf);
    position.anyOf = position.anyOf.filter(
      (cell) =>
        !position.noneOf.some(
          (undesired) =>
            compareMatchCell(cell, undesired) ===
            0,
        ),
    );
    position.noneOf = [];
    if (position.anyOf.length === 0) {
      return false;
    }
  }
  return true;
}

function dedupeSorted(
  cells: MatchCell[],
): MatchCell[] {
  return cells.filter(
    (cell, index) =>
      index === 0 ||
      compareMatchCell(
        cell,
        cells[index - 1] as MatchCell,
      ) !== 0,
  );
}

class MatchBudget {
  private spent = 0;
  constructor(
    private readonly limit: number,
  ) {}

  charge(amount: number): void {
    this.spent += amount;
    if (this.spent > this.limit) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        `Automapping exceeded the matching work budget of ${this.limit} cell comparisons. Use fewer or smaller rules, or a smaller map.`,
        { limit: this.limit },
      );
    }
  }
}

export function runAutomap(input: {
  width: number;
  height: number;
  layers: ReadonlyMap<string, AutomapTargetLayer>;
  rulesMaps: readonly AutomapRulesMapModel[];
  seed: number;
  budget: AutomapBudget;
}): void {
  const { width, height, layers, seed } = input;
  const matchBudget = new MatchBudget(
    input.budget.maxMatchOperations,
  );
  let ruleSalt = 0;
  let totalRules = 0;
  for (const model of input.rulesMaps) {
    const rules = buildRules(model);
    totalRules += rules.length;
    if (totalRules > input.budget.maxRules) {
      throw new TiledMcpError(
        "RESULT_LIMIT_EXCEEDED",
        `Automapping exceeded the ${input.budget.maxRules}-rule budget.`,
        { limit: input.budget.maxRules },
      );
    }
    runRulesMap(
      model,
      rules,
      width,
      height,
      layers,
      seed,
      ruleSalt,
      matchBudget,
    );
    ruleSalt += rules.length;
  }
}

function buildRules(
  model: AutomapRulesMapModel,
): Rule[] {
  const { width, height } = model;
  const inRegion = new Uint8Array(width * height);
  const outRegion = new Uint8Array(width * height);
  for (const inputSet of model.inputSets) {
    for (const conditions of inputSet.layers) {
      for (const grid of [
        ...conditions.listYes,
        ...conditions.listNo,
      ]) {
        for (const [
          index,
          cell,
        ] of grid.cells.entries()) {
          if (cell !== null) {
            inRegion[index] = 1;
          }
        }
      }
    }
  }
  for (const outputSet of model.outputSets) {
    for (const grid of outputSet.layers) {
      for (const [
        index,
        cell,
      ] of grid.cells.entries()) {
        if (cell !== null) {
          outRegion[index] = 1;
        }
      }
    }
  }

  // Coherent regions: 8-way connected components of the union, sorted by
  // bounding-rect top-left (y first, then x), exactly as
  // `AutoMapper::setupRules` orders them.
  const combined = new Uint8Array(width * height);
  for (let index = 0; index < combined.length; index += 1) {
    if (
      inRegion[index] === 1 ||
      outRegion[index] === 1
    ) {
      combined[index] = 1;
    }
  }
  const visited = new Uint8Array(width * height);
  const components: number[][] = [];
  for (let start = 0; start < combined.length; start += 1) {
    if (
      combined[start] !== 1 ||
      visited[start] === 1
    ) {
      continue;
    }
    const component: number[] = [];
    const stack = [start];
    visited[start] = 1;
    while (stack.length > 0) {
      const p = stack.pop() as number;
      component.push(p);
      const px = p % width;
      const py = (p - px) / width;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) {
            continue;
          }
          const nx = px + dx;
          const ny = py + dy;
          if (
            nx < 0 ||
            ny < 0 ||
            nx >= width ||
            ny >= height
          ) {
            continue;
          }
          const np = ny * width + nx;
          if (
            combined[np] === 1 &&
            visited[np] !== 1
          ) {
            visited[np] = 1;
            stack.push(np);
          }
        }
      }
    }
    components.push(component);
  }
  const bounds = (
    cells: number[],
  ): {
    left: number;
    top: number;
    right: number;
    bottom: number;
  } => {
    let left = Number.POSITIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (const p of cells) {
      const x = p % width;
      const y = (p - x) / width;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
    return { left, top, right, bottom };
  };
  components.sort((a, b) => {
    const ba = bounds(a);
    const bb = bounds(b);
    return (
      ba.top - bb.top || ba.left - bb.left
    );
  });

  const rules: Rule[] = [];
  for (const component of components) {
    const inputRegion = component.filter(
      (p) => inRegion[p] === 1,
    );
    const outputRegion = component.filter(
      (p) => outRegion[p] === 1,
    );
    if (
      inputRegion.length === 0 ||
      outputRegion.length === 0
    ) {
      continue;
    }
    const inputBounds = bounds(inputRegion);
    const componentBounds = bounds(component);
    const options: AutomapRuleOptions = {
      ...model.defaultRuleOptions,
    };
    for (const area of model.ruleOptionsAreas) {
      const componentInsideArea =
        componentBounds.left >= area.left &&
        componentBounds.right <= area.right &&
        componentBounds.top >= area.top &&
        componentBounds.bottom <= area.bottom;
      if (componentInsideArea) {
        Object.assign(options, area.options);
      }
    }
    const outputInRegion = (
      grid: AutomapOutputLayerGrid,
    ): boolean =>
      outputRegion.some(
        (p) => grid.cells[p] != null,
      );
    let unconditionalOutput:
      | AutomapOutputLayerGrid[]
      | null = null;
    const weightedOutputs: Rule["weightedOutputs"] =
      [];
    for (const outputSet of model.outputSets) {
      const qualifying = outputSet.layers.filter(
        outputInRegion,
      );
      if (qualifying.length === 0) {
        continue;
      }
      if (outputSet.name === "") {
        unconditionalOutput = qualifying;
      } else if (outputSet.probability > 0) {
        weightedOutputs.push({
          layers: qualifying,
          probability: outputSet.probability,
        });
      }
    }
    rules.push({
      inputRegion: inputRegion.sort(
        (a, b) => a - b,
      ),
      outputRegion: outputRegion.sort(
        (a, b) => a - b,
      ),
      inputLeft: inputBounds.left,
      inputTop: inputBounds.top,
      inputRight: inputBounds.right,
      inputBottom: inputBounds.bottom,
      options,
      unconditionalOutput,
      weightedOutputs,
    });
  }
  return rules;
}

function collectCellsInRegion(
  grids: readonly AutomapInputLayerGrid[],
  region: readonly number[],
): MatchCell[] {
  const cells: MatchCell[] = [];
  for (const grid of grids) {
    for (const p of region) {
      const cell = grid.cells[p];
      if (cell == null) {
        continue;
      }
      if (cell.kind === "tile") {
        pushUniqueCell(cells, {
          baseGid: cell.baseGid,
          flags: cell.flags,
          flagsMask: grid.flagsMask,
        });
      } else if (cell.kind === "empty") {
        pushUniqueCell(cells, EMPTY_MATCH_CELL);
      }
    }
  }
  return cells;
}

/**
 * `AutoMapper::compileInputSet`: distills one input set into per-position
 * anyOf/noneOf lists over the target layers. Returns null when the set can
 * never match; `hasIgnore` keeps an otherwise-empty set alive as an
 * always-matching one.
 */
function compileInputSet(
  inputSet: AutomapInputSet,
  rule: Rule,
  model: AutomapRulesMapModel,
  layers: ReadonlyMap<string, AutomapTargetLayer>,
): CompiledInputSet | null {
  const compiled: CompiledInputSet = [];
  let hasIgnore = false;
  for (const conditions of inputSet.layers) {
    const target = layers.get(
      conditions.layerName,
    );
    const layer: CompiledLayer = {
      working: target ? target.working : null,
      positions: [],
    };
    let inputCells: MatchCell[] | null = null;
    const usedCells = (): MatchCell[] => {
      inputCells ??= collectCellsInRegion(
        conditions.listYes,
        rule.inputRegion,
      );
      return inputCells;
    };
    for (const p of rule.inputRegion) {
      const x = p % model.width;
      const y = (p - x) / model.width;
      let anyOf: MatchCell[] = [];
      let noneOf: MatchCell[] = [];
      let negate = false;
      for (const grid of conditions.listYes) {
        const cell = grid.cells[p];
        if (cell == null) {
          if (grid.strictEmpty) {
            anyOf.push({
              baseGid: 0,
              flags: 0,
              flagsMask: grid.flagsMask,
            });
          }
          continue;
        }
        switch (cell.kind) {
          case "tile":
            anyOf.push({
              baseGid: cell.baseGid,
              flags: cell.flags,
              flagsMask: grid.flagsMask,
            });
            break;
          case "empty":
            anyOf.push(EMPTY_MATCH_CELL);
            break;
          case "nonEmpty":
            noneOf.push(EMPTY_MATCH_CELL);
            break;
          case "other":
            noneOf.push(...usedCells());
            break;
          case "negate":
            negate = true;
            break;
          case "ignore":
            hasIgnore = true;
            break;
        }
      }
      for (const grid of conditions.listNo) {
        const cell = grid.cells[p];
        if (cell == null) {
          if (grid.strictEmpty) {
            noneOf.push({
              baseGid: 0,
              flags: 0,
              flagsMask: grid.flagsMask,
            });
          }
          continue;
        }
        switch (cell.kind) {
          case "tile":
            noneOf.push({
              baseGid: cell.baseGid,
              flags: cell.flags,
              flagsMask: grid.flagsMask,
            });
            break;
          case "empty":
            noneOf.push(EMPTY_MATCH_CELL);
            break;
          case "nonEmpty":
            anyOf.push(EMPTY_MATCH_CELL);
            break;
          case "other":
            anyOf.push(...usedCells());
            break;
          case "negate":
            negate = true;
            break;
          case "ignore":
            hasIgnore = true;
            break;
        }
      }
      if (negate) {
        [anyOf, noneOf] = [noneOf, anyOf];
      }
      const position = { anyOf, noneOf };
      if (!optimizeAnyNoneOf(position)) {
        return null;
      }
      if (layer.working === null) {
        // A missing target layer reads as all-empty; drop the set when
        // empty is not acceptable here.
        const emptyAllowed =
          (position.anyOf.length === 0 ||
            position.anyOf.some(
              (cell) => cell.baseGid === 0,
            )) &&
          !position.noneOf.some(
            (cell) => cell.baseGid === 0,
          );
        if (!emptyAllowed) {
          return null;
        }
      }
      if (
        position.anyOf.length > 0 ||
        position.noneOf.length > 0
      ) {
        layer.positions.push({
          x: x - rule.inputLeft,
          y: y - rule.inputTop,
          anyOf: position.anyOf,
          noneOf: position.noneOf,
        });
      }
    }
    if (layer.positions.length > 0) {
      compiled.push(layer);
    }
  }
  if (compiled.length === 0 && !hasIgnore) {
    return null;
  }
  return compiled;
}

type GetCell = (
  x: number,
  y: number,
  grid: Uint32Array | null,
) => number;

function makeGetCell(
  width: number,
  height: number,
  options: AutomapOptions,
): GetCell {
  if (options.wrapBorder) {
    return (x, y, grid) => {
      if (grid === null) {
        return 0;
      }
      const wx = ((x % width) + width) % width;
      const wy = ((y % height) + height) % height;
      return grid[wy * width + wx] as number;
    };
  }
  if (options.overflowBorder) {
    return (x, y, grid) => {
      if (grid === null) {
        return 0;
      }
      const bx = Math.min(
        Math.max(0, x),
        width - 1,
      );
      const by = Math.min(
        Math.max(0, y),
        height - 1,
      );
      return grid[by * width + bx] as number;
    };
  }
  return (x, y, grid) => {
    if (
      grid === null ||
      x < 0 ||
      y < 0 ||
      x >= width ||
      y >= height
    ) {
      return 0;
    }
    return grid[y * width + x] as number;
  };
}

function cellMatches(
  desired: MatchCell,
  cell: number,
): boolean {
  if (desired.baseGid === 0) {
    return cell === 0;
  }
  const cellBase = (cell & GID_ID_MASK) >>> 0;
  if (desired.baseGid !== cellBase) {
    return false;
  }
  const mask = desired.flagsMask;
  const desiredFlags =
    (desired.flags & mask) >>> 0;
  const cellFlags = (cell & mask) >>> 0;
  return desiredFlags === cellFlags;
}

function matchInputSet(
  compiled: CompiledInputSet,
  ox: number,
  oy: number,
  getCell: GetCell,
  budget: MatchBudget,
): boolean {
  for (const layer of compiled) {
    budget.charge(layer.positions.length);
    for (const position of layer.positions) {
      const cell = getCell(
        position.x + ox,
        position.y + oy,
        layer.working,
      );
      let anyMatch = position.anyOf.length === 0;
      for (const desired of position.anyOf) {
        if (cellMatches(desired, cell)) {
          anyMatch = true;
          break;
        }
      }
      if (!anyMatch) {
        return false;
      }
      for (const undesired of position.noneOf) {
        if (cellMatches(undesired, cell)) {
          return false;
        }
      }
    }
  }
  return true;
}

function runRulesMap(
  model: AutomapRulesMapModel,
  rules: Rule[],
  width: number,
  height: number,
  layers: ReadonlyMap<string, AutomapTargetLayer>,
  seed: number,
  ruleSaltBase: number,
  budget: MatchBudget,
): void {
  const { options } = model;
  const radius = options.autoMappingRadius;
  const applyLeft = -radius;
  const applyTop = -radius;
  const applyRight = width - 1 + radius;
  const applyBottom = height - 1 + radius;

  if (options.deleteTiles) {
    // Erase every output layer wherever any of this rules map's input
    // layers has content, clipped to the map.
    const erase = new Uint8Array(width * height);
    for (const name of model.inputLayerNames) {
      const layer = layers.get(name);
      if (layer === undefined) {
        continue;
      }
      for (let index = 0; index < erase.length; index += 1) {
        if (layer.working[index] !== 0) {
          erase[index] = 1;
        }
      }
    }
    for (const name of model.outputTileLayerNames) {
      const layer = layers.get(name);
      if (layer === undefined) {
        continue;
      }
      for (let index = 0; index < erase.length; index += 1) {
        if (erase[index] === 1) {
          layer.working[index] = 0;
        }
      }
    }
  }

  const getCell = makeGetCell(
    width,
    height,
    options,
  );

  const matchRule = (
    rule: Rule,
    ruleIndex: number,
    matched: (x: number, y: number) => void,
  ): void => {
    if (
      rule.unconditionalOutput === null &&
      rule.weightedOutputs.length === 0
    ) {
      return;
    }
    const compiledSets: CompiledInputSet[] = [];
    for (const inputSet of model.inputSets) {
      const compiled = compileInputSet(
        inputSet,
        rule,
        model,
        layers,
      );
      if (compiled !== null) {
        compiledSets.push(compiled);
      }
    }
    if (compiledSets.length === 0) {
      return;
    }
    const ruleWidth =
      rule.inputRight - rule.inputLeft;
    const ruleHeight =
      rule.inputBottom - rule.inputTop;
    let left = applyLeft - ruleWidth;
    let top = applyTop - ruleHeight;
    let right = applyRight;
    let bottom = applyBottom;
    if (!options.matchOutsideMap) {
      left = Math.max(left, 0);
      top = Math.max(top, 0);
      right = Math.min(
        right,
        width - ruleWidth - 1,
      );
      bottom = Math.min(
        bottom,
        height - ruleHeight - 1,
      );
    }
    if (left > right || top > bottom) {
      return;
    }
    // Truncated modulo on purpose: JS `%` matches the C++ arithmetic in
    // `AutoMapper::matchRule`, including its negative-left behavior.
    const startX =
      left +
      ((left + rule.options.offsetX) %
        rule.options.modX);
    const startY =
      top +
      ((top + rule.options.offsetY) %
        rule.options.modY);
    for (
      let y = startY;
      y <= bottom;
      y += rule.options.modY
    ) {
      for (
        let x = startX;
        x <= right;
        x += rule.options.modX
      ) {
        if (
          rule.options.skipChance !== 0 &&
          hashToUnit(
            seed,
            x,
            y,
            (ruleSaltBase + ruleIndex) * 2,
          ) < rule.options.skipChance
        ) {
          continue;
        }
        let anySetMatched = false;
        for (const compiled of compiledSets) {
          if (
            matchInputSet(
              compiled,
              x,
              y,
              getCell,
              budget,
            )
          ) {
            anySetMatched = true;
            break;
          }
        }
        if (anySetMatched) {
          matched(x, y);
        }
      }
    }
  };

  const applyRule = (
    rule: Rule,
    ruleIndex: number,
    matchX: number,
    matchY: number,
    appliedRegions: Map<string, Set<number>>,
  ): void => {
    const offsetX = matchX - rule.inputLeft;
    const offsetY = matchY - rule.inputTop;

    let chosen: AutomapOutputLayerGrid[] | null =
      null;
    if (rule.weightedOutputs.length === 1) {
      chosen = (
        rule.weightedOutputs[0] as {
          layers: AutomapOutputLayerGrid[];
        }
      ).layers;
    } else if (rule.weightedOutputs.length > 1) {
      let total = 0;
      for (const candidate of rule.weightedOutputs) {
        total += candidate.probability;
      }
      const draw =
        hashToUnit(
          seed,
          matchX,
          matchY,
          (ruleSaltBase + ruleIndex) * 2 + 1,
        ) * total;
      let cumulative = 0;
      for (const candidate of rule.weightedOutputs) {
        cumulative += candidate.probability;
        if (draw <= cumulative) {
          chosen = candidate.layers;
          break;
        }
      }
      chosen ??= (
        rule.weightedOutputs[
          rule.weightedOutputs.length - 1
        ] as { layers: AutomapOutputLayerGrid[] }
      ).layers;
    }

    const applied: AutomapOutputLayerGrid[] = [
      ...(rule.unconditionalOutput ?? []),
      ...(chosen ?? []),
    ];

    if (rule.options.noOverlappingOutput) {
      const regionsByLayer = new Map<
        string,
        Set<number>
      >();
      for (const grid of applied) {
        let region = regionsByLayer.get(
          grid.targetLayerName,
        );
        if (region === undefined) {
          region = new Set<number>();
          regionsByLayer.set(
            grid.targetLayerName,
            region,
          );
        }
        for (const p of rule.outputRegion) {
          if (grid.cells[p] != null) {
            const cx =
              (p % model.width) + offsetX;
            const cy =
              (p - (p % model.width)) /
                model.width +
              offsetY;
            // Coordinates can be negative under MatchOutsideMap; bias
            // before packing so distinct cells never collide.
            region.add(
              (cy + 0x800000) * 0x1000000 +
                (cx + 0x800000),
            );
          }
        }
      }
      for (const [
        name,
        region,
      ] of regionsByLayer) {
        const existing =
          appliedRegions.get(name);
        if (existing === undefined) {
          continue;
        }
        for (const packed of region) {
          if (existing.has(packed)) {
            return;
          }
        }
      }
      for (const [
        name,
        region,
      ] of regionsByLayer) {
        let existing = appliedRegions.get(name);
        if (existing === undefined) {
          existing = new Set<number>();
          appliedRegions.set(name, existing);
        }
        for (const packed of region) {
          existing.add(packed);
        }
      }
    }

    for (const grid of applied) {
      const target = layers.get(
        grid.targetLayerName,
      );
      if (target === undefined) {
        continue;
      }
      if (
        target.locked &&
        !rule.options.ignoreLock
      ) {
        continue;
      }
      for (const p of rule.outputRegion) {
        const cell = grid.cells[p];
        if (cell == null) {
          continue;
        }
        if (
          cell.kind !== "tile" &&
          cell.kind !== "empty"
        ) {
          continue;
        }
        const sx = p % model.width;
        const sy = (p - sx) / model.width;
        let dx = sx + offsetX;
        let dy = sy + offsetY;
        if (options.wrapBorder) {
          dx = ((dx % width) + width) % width;
          dy = ((dy % height) + height) % height;
        } else if (
          dx < 0 ||
          dy < 0 ||
          dx >= width ||
          dy >= height
        ) {
          continue;
        }
        target.working[dy * width + dx] =
          cell.kind === "tile"
            ? ((cell.baseGid | cell.flags) >>> 0)
            : 0;
      }
    }
  };

  if (options.matchInOrder) {
    for (const [
      ruleIndex,
      rule,
    ] of rules.entries()) {
      if (rule.options.disabled) {
        continue;
      }
      const appliedRegions = new Map<
        string,
        Set<number>
      >();
      matchRule(rule, ruleIndex, (x, y) => {
        applyRule(
          rule,
          ruleIndex,
          x,
          y,
          appliedRegions,
        );
      });
    }
  } else {
    // Concurrent mode: every rule matches against the state this rules map
    // started from, then outputs are applied in rule order.
    const matches: Array<Array<[number, number]>> =
      [];
    for (const [
      ruleIndex,
      rule,
    ] of rules.entries()) {
      const positions: Array<[number, number]> =
        [];
      if (!rule.options.disabled) {
        matchRule(rule, ruleIndex, (x, y) => {
          positions.push([x, y]);
        });
      }
      matches.push(positions);
    }
    for (const [
      ruleIndex,
      rule,
    ] of rules.entries()) {
      const appliedRegions = new Map<
        string,
        Set<number>
      >();
      for (const [x, y] of matches[
        ruleIndex
      ] as Array<[number, number]>) {
        applyRule(
          rule,
          ruleIndex,
          x,
          y,
          appliedRegions,
        );
      }
    }
  }
}
