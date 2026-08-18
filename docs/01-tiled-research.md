# Tiled Research Report

> Research date: 2026-07-23. The latest stable release at that time is **Tiled 1.12.2** (released 2026-05-27).
> Purpose: provide the data-model, file-format, and ecosystem grounding for designing a Tilemap MCP server.

## 1. What Tiled is

[Tiled](https://www.mapeditor.org) is a widely used open-source general-purpose Tilemap editor (implemented in Qt/C++) for building 2D game levels: orthogonal, isometric, and hexagonal maps are all supported. Its file formats (TMX/TMJ) have a mature cross-engine ecosystem; Godot, Unity, Phaser, Bevy, Defold, GameMaker, and others can integrate through official features, community importers, or Tiled export formats, but the exact format and feature coverage must be confirmed per engine and plugin version.

## 2. Core data model

```
Project (.tiled-project)               Optional project-level configuration: asset directories, custom types, compatibility, etc.
    ├── may reference World (.world)   Multiple maps organized by global pixel coordinates
    └── may reference Map / Tileset / Template assets

World (.world) ──references──> Map (.tmx / .tmj)
Map                                      Map: orientation, dimensions, tile size
├── Tileset reference (firstgid + source) → external .tsx/.tsj (or embedded)
└── Layer tree (Groups may nest)
    ├── Tile Layer                     GID array (chunk list for infinite maps)
    ├── Object Layer                   Freely placed objects
    ├── Image Layer                    A single background/foreground image
    └── Group Layer                    Layer folder (properties propagate to child layers)
```

Project, World, and Map do not form a strict ownership tree: a map can exist independently of any Project or World; a World references maps by file name, while a Project mainly provides project-level discovery and configuration.

### 2.1 Map

The key fields are as follows. Most TMX XML attributes and TMJ JSON fields share the same all-lowercase names, but the exact nesting and encodings should still be handled per the respective format reference:

- `orientation`: `orthogonal` / `isometric` / `staggered` (staggered isometric) / `hexagonal` (staggered hexagonal) / `oblique` (new in 1.12)
- `width`, `height` (in tiles), `tilewidth`, `tileheight` (in pixels)
- `renderorder`: `right-down` (default) / `right-up` / `left-down` / `left-up`; currently implemented only for orthogonal maps — other orientations should not rely on this field
- `infinite`: infinite-map switch (layer data becomes chunk storage)
- `staggeraxis` (`x`/`y`), `staggerindex` (`odd`/`even`): used by staggered/hexagonal
- `hexsidelength`: hexagon side length (hexagonal only)
- `skewx` / `skewy`: oblique only (1.12+)
- `nextlayerid`, `nextobjectid`: **editor-maintained auto-increment ID counters; a writer must maintain them correctly, or Tiled will produce ID conflicts after opening the file**
- `backgroundcolor`, `parallaxoriginx/y`, `compressionlevel`, `class`

Documentation: <https://doc.mapeditor.org/en/stable/reference/tmx-map-format/#map>

### 2.2 Layer (4 kinds, nestable as a tree)

| Kind | JSON `type` | Notes |
|---|---|---|
| Tile Layer | `tilelayer` | GID array; supports flip bits |
| Object Layer | `objectgroup` | free objects; `draworder`: `topdown` (default) / `index` |
| Image Layer | `imagelayer` | single image; `repeatx`/`repeaty` (1.8+), `transparentcolor` |
| Group Layer | `group` | layer folder; visibility/opacity/offset/tint propagate to child layers, parallax multiplies per layer |

Fields common to all layers: `id`, `name`, `class`, `opacity`, `visible`, `locked`, `tintcolor`, `offsetx/y`, `parallaxx/y`, `properties`, plus the blend mode `mode` added in 1.12 (13 values: `normal`/`add`/`multiply`/`screen`/`overlay`, etc.).

### 2.3 Object

Common fields: `id`, `name`, `type` (i.e. class), `x`, `y`, `width`, `height`, `rotation` (degrees), `visible`, `opacity` (1.12+), `gid` (tile object), `template`, `properties`.

Shape kinds:

- **Rectangle** (default, no shape child element, origin at the top-left corner)
- **Ellipse** `ellipse`, **Point** `point`, **Capsule** `capsule` (new in 1.12)
- **Polygon/polyline** `polygon` / `polyline`: `points` are coordinate pairs relative to the object position (a `[{x,y},...]` array in JSON); a polygon is closed with ≥3 points, a polyline is open with ≥2 points
- **Text** `text`: the TMJ object keeps `width`/`height` at the top level; content and
  styling live in a nested `text` object. `text.text` is the body; `fontfamily`
  defaults to `sans-serif`, `pixelsize` defaults to 16, `color` defaults to
  `#000000`; `bold/italic/underline/strikeout/wrap` default to `false`, `kerning`
  defaults to `true`; `halign` defaults to `left`, `valign` defaults to `top`.
  `halign` may be `left/center/right/justify`, `valign` may be `top/center/bottom`;
  in `#AARRGGBB` the alpha comes first. The file format defaults to `wrap:false`,
  but the Tiled UI/scripting often exports `wrap:true` explicitly for newly created
  TextData; an automated writer must choose explicitly rather than mixing the two sets of defaults
- **Tile Object**: an object carrying a `gid`; freely scalable and rotatable, with the anchor determined by the tileset's `objectalignment`

Object-to-object references: a custom property of type `object` stores the target object's `id` (e.g. "switch → door").

### 2.4 Template (object templates) and World

- **Template** (`.tx`/`.tj`): a single object stored as a standalone file for reuse; the tileset reference must precede the object, and embedded tilesets are not supported. Properties modified on an instance are marked overridden and do not follow template updates.
- **World** (`.world`, JSON): `maps[]` stitches multiple maps together by global pixel coordinates (`fileName`, `x`, `y`); `patterns[]` supports batch mapping by file-name regex. The scripting API can operate on worlds since 1.11.

## 3. File formats

### 3.1 File type overview

| Content | XML | JSON |
|---|---|---|
| Map | `.tmx` | `.tmj` (`"type": "map"`) |
| Tileset | `.tsx` | `.tsj` (`"type": "tileset"`) |
| Template | `.tx` | `.tj` (`"type": "template"`) |
| World | — | `.world` (`"type": "world"`) |

TMX and TMJ correspond broadly in data semantics, but the serialized structures are not mechanically field-for-field equivalent: TMX uses XML attributes/child elements, TMJ uses JSON fields/arrays, and a few fields and encoding forms differ. A tileset can be embedded in the map or referenced externally (the default since 1.0, and recommended): a TMJ map usually stores only `{"firstgid": 1, "source": "tileset.tsj"}`, while TMX uses the corresponding `<tileset firstgid="…" source="…"/>`.

### 3.2 Tile Layer data encodings

- **CSV**: plain-text comma-separated GIDs (TMX `encoding="csv"`; in JSON, simply an array of unsigned integers)
- **base64**: decodes to a **little-endian array of 32-bit unsigned integers**, optionally compressed with `gzip` / `zlib` / `zstd` (1.3+)

### 3.3 GID and flip bits (the most important pitfall)

GID 0 = empty cell. A GID belongs to "the tileset with the largest `firstgid` not greater than it"; `local id = GID - firstgid`. The top 4 bits of the 32-bit GID are flag bits:

```c
FLIPPED_HORIZONTALLY_FLAG  = 0x80000000;  // horizontal flip
FLIPPED_VERTICALLY_FLAG    = 0x40000000;  // vertical flip
FLIPPED_DIAGONALLY_FLAG    = 0x20000000;  // diagonal flip (on hexagonal maps: rotate 60°)
ROTATED_HEXAGONAL_120_FLAG = 0x10000000;  // rotate 120° (hexagonal only)
```

When reading, **all 4 bits must be cleared at once** (the official docs specifically warn that bit 29 must be cleared even on non-hex maps). Because the high bits are occupied, flipped tiles appear in JSON as very large integers (e.g. `2147483649` = tile 1 + horizontal flip).

Documentation: <https://doc.mapeditor.org/en/stable/reference/global-tile-ids/>

### 3.4 Infinite maps and chunks

With `infinite: true`, tile layer data becomes `chunks[]` (each chunk has `x`, `y`, `width`, `height`, `data`; coordinates may be negative), with `startx`/`starty` recording the content bounds. 16×16 is a common default chunk size, not a format constraint; a writer must preserve the existing chunk layout and must not assume or force a re-slice to a fixed size.

## 4. Tileset details

### 4.1 Two kinds of tileset

- **Atlas-based** (Based on Tileset Image): a single image cut by `tilewidth`/`tileheight`, with `margin` and `spacing` supported; `tilecount` and `columns` record the dimensions.
- **Image collection** (Collection of Images): each tile carries its own `image` (sizes may all differ); 1.9+ can crop by sub-rectangle.

Other fields: `objectalignment` (tile-object anchor, 9 positions), `tilerendersize`, `fillmode`, `grid` (for isometric tilesets), `tileoffset` (rendering pixel offset), `transformations` (declares the allowed flip variants `hflip`/`vflip`/`rotate`/`preferuntransformed`).

### 4.2 Per-tile capabilities

- **Animation**: `animation: [{tileid, duration}, ...]`, duration in milliseconds, a single linear loop
- **Collision shapes**: one `objectgroup` per tile, containing rectangle/ellipse/polygon collision objects (Tile Collision Editor)
- **Probability**: `probability` (default 1), used by the random brush/terrain brush
- **Custom properties**: arbitrary properties

### 4.3 Wang Sets / Terrain (the terrain system)

Tiled's terrain brush is based on Wang tiles, with three matching types:

| Type | Matching | Tiles needed for a complete 2-terrain set |
|---|---|---|
| `corner` | by the 4 corners | 16 |
| `edge` | by the 4 edges (roads/fences) | 16 |
| `mixed` | corners and edges together | 256 |

- `wangcolor`: up to 254 colors per set, each with `name`, `color`, `tile` (representative tile), `probability`
- `wangtile`: `tileid` + `wangid` (8 color indices, **clockwise starting from top: top, top-right, right, bottom-right, bottom, bottom-left, left, top-left**; 0 = unset)
- The legacy `terraintypes` is deprecated, replaced by Wang sets

Documentation: <https://doc.mapeditor.org/en/stable/manual/terrain/>

## 5. The custom property system

- property `type` has 9 kinds: `string` (default) / `int` / `float` / `bool` / `color` / `file` / `object` (value is an object id) / `class` (nested structure, 1.9+) / `list` (1.12+); `propertytype` names the custom type
- `list` may contain multiple values of the same type, and nested list/class combinations must also be covered; a reader/writer cannot implement only the legacy 8 property kinds
- Properties can attach to: map, tileset, tile, wangset, wangcolor, layer, object
- **Custom types** (class/enum) are defined in the Project and can be exported as `propertytypes.json`: an enum has `storageType` (string/int), `values`, `valuesAsFlags`; a class has `members`, `color`, `useAs` (array of applicable scopes)
- Pitfall: class-typed properties **serialize only the members that have been modified**

## 6. Tiled's automation capabilities

### 6.1 JavaScript scripting API

<https://www.mapeditor.org/docs/scripting/> — the capabilities are very complete (can create/modify assets, register custom formats/commands/tools, operate on worlds), but it runs inside the Qt JS engine embedded in the Tiled process, not as a standalone Node.js library that can be linked directly.

This does not mean automation requires a resident Tiled. Tiled 1.9+ supports one-shot commands:

```bash
tiled --evaluate script.js [args...]
```

This mode instantiates no UI and exits after running the script; the script can still load, modify, and save maps and tilesets. Only scenarios that need interactive editor state, live tools, or UI require a resident extension plus IPC. The MCP should prefer the one-shot adapter and keep a GUI/IPC bridge as a later optional capability.

### 6.2 Command line

```bash
tiled --export-map [format] <source> <target>      # map format conversion/export
tiled --export-tileset [format] <source> <target>
tiled --export-formats                             # list the formats the current install actually supports
tiled --evaluate <script.js> [args...]             # run a script once, then exit
tmxrasterizer [options] <map|world> <image>        # render a map or world to an image
```

The available export formats depend on the Tiled version, build, and enabled plugins; the MCP should read `--export-formats` at runtime and must not hardcode a format list. Image outputs such as PNG should not be assumed to be `--export-map` formats; use `tmxrasterizer`, which ships with Tiled and can render the supported map formats and worlds. Headless deployment additionally requires validating the Qt platform plugin per target system, but `--evaluate` itself does not require a resident GUI.

### 6.3 AutoMapping

A "rule map" describes input-layer → output-layer pattern replacements (automatic road laying, wall corners, terrain transitions). The command line has no standalone `--automap` parameter, but the scripting API provides `TileMap.autoMap()`; the MCP can load a map, run the rules, and save through a one-shot `--evaluate`, with no resident editor.

Wang editing likewise has an official scripting backend: `TileLayer.wangEdit()` can set corner/edge colors, enable neighbor correction, and apply the result. A home-grown matcher remains a viable alternative backend when Tiled-free operation, determinism, or testability matters, but it should not be the only implementation path in a first version.

API: <https://www.mapeditor.org/docs/scripting/classes/TileMap.html#auto-map>, <https://www.mapeditor.org/docs/scripting/interfaces/TileLayerWangEdit.html>

## 7. The third-party read/write library ecosystem

Core conclusion: **the ecosystem is "read-heavy, write-light"** — the vast majority of libraries target game-runtime loading (read-only).

| Ecosystem | Representative library | Read | Write | Notes |
|---|---|---|---|---|
| **TypeScript** | [@kayahr/tiled](https://www.npmjs.com/package/@kayahr/tiled) | ✅ | ✅(JSON) | TS types + JSON Schema + type guards; usable as a local helper or fork starting point, not as the source of truth for a 1.12 Schema |
| Python | pytiled-parser | ✅(TMX+TMJ) | ❌ | clean read-side model; the write side uses the built-in `json` |
| Python | pytmx | ✅ | ❌ | the most popular, but explicitly no save |
| C++ | tmxlite / Tileson | ✅ | ❌ | for runtime loading |
| C++ | libtiled (used by Tiled itself) | ✅ | ✅ | the only library that reliably writes TMX, but drags in a Qt dependency |
| Rust | rs-tiled / bevy_ecs_tiled | ✅ | ❌ | mature Bevy ecosystem |

`@kayahr/tiled`'s currently published version is still `0.0.1`; its types and strict Schema snapshot do not cover several Tiled 1.12 fields/capabilities, for example `oblique`, layer `mode`, object `capsule` and `opacity`, and `list` properties; strict validation may also reject fields added in the future. The write-back base should therefore use lenient raw JSON plus its own typed view, and pass unknown fields through verbatim.

Apart from libtiled, the ecosystem lacks a mature, general-purpose standalone TMX(XML) writing library. TMJ is standard JSON and better suited as the MCP's direct read/write format in the first phase; TMX writing and compatibility conversion can be delegated to the Tiled CLI or `--evaluate`. Whether a target engine reads TMJ directly, and which Tiled features it can cover, still needs to be confirmed per importer/exporter.

## 8. Analysis of existing comparable MCPs (competitors)

This research sampled several Tiled MCPs on GitHub. Judging by the public versions and feature descriptions at research time, most are still in early iteration; stars, versions, pricing models, and feature coverage may all change and should be re-verified before implementation:

| Project | Architecture | Tool surface at research time | Observations and items to verify |
|---|---|---|---|
| [chrisgliddon/tiled-mcp](https://github.com/chrisgliddon/tiled-mcp) | TS, direct file read/write | ~27 tools, `tiled_{action}_{resource}` naming, with readOnly/destructive annotations | In the researched version TMX was read-only; no terrain/World/Template coverage found |
| [youichi-uda/tiled-mcp-pro-public](https://github.com/youichi-uda/tiled-mcp-pro-public) | MCP↔WebSocket↔Tiled extension↔scripting API | 122 tools / 12 categories, including Terrain/Export/Analysis | The researched version depends on a resident Tiled; the large tool surface raises selection and contract-maintenance cost, and the public/paid boundary needs re-checking |
| [pujan1/tiled-mcp](https://github.com/pujan1/tiled-mcp) | TS, direct read/write | 16 tools, deliberately minimal | The researched version writes TMJ only; no standalone object/property tools found |
| [hoberobin/tiled-mcp](https://github.com/hoberobin/tiled-mcp) (npm `tiled-mcp`) | TS, direct read/write + **semantic tile registry** | place/fill/replace/validation | The researched version was 0.1.0; the approach of mapping semantic names such as `grass`/`water` to GIDs is worth adopting |

### Differentiation opportunities (coverage gaps in this sample)

1. **Wang terrain auto-tiling**: limited coverage in the sample; prefer wrapping the official `wangEdit()` / `autoMap()`, with a deterministic home-grown algorithm as an optional backend
2. **World / Template / Project / custom property types**: limited coverage in the sample
3. **TMX(XML) write support**: direct write-back capability is limited; a Tiled one-shot adapter can provide reliable conversion
4. **Validation and visualization**: GID out-of-range checks, map PNG previews, semantic tile naming
5. **Engine export integration**: export the available formats via the Tiled CLI, and generate images with `tmxrasterizer`
6. **A proper Resources/Prompts layering**: the sampled implementations are Tools-first

## 9. Key reference links

- TMX format reference: <https://doc.mapeditor.org/en/stable/reference/tmx-map-format/>
- JSON format reference: <https://doc.mapeditor.org/en/stable/reference/json-map-format/>
- GID and flip bits: <https://doc.mapeditor.org/en/stable/reference/global-tile-ids/>
- Terrain manual: <https://doc.mapeditor.org/en/stable/manual/terrain/>
- AutoMapping: <https://doc.mapeditor.org/en/stable/manual/automapping/>
- Scripting API: <https://www.mapeditor.org/docs/scripting/>
- Scripting command-line mode: <https://doc.mapeditor.org/en/stable/reference/scripting/#command-line>
- Command-line export: <https://doc.mapeditor.org/en/stable/manual/export/>
- Image export and `tmxrasterizer`: <https://doc.mapeditor.org/en/stable/manual/export-image/>
- Official library list: <https://doc.mapeditor.org/en/stable/reference/support-for-tmx-maps/>
- MCP design conventions: <https://www.philschmid.de/mcp-best-practices>, <https://github.com/awslabs/mcp/blob/main/DESIGN_GUIDELINES.md>
