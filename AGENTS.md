# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Commands

```bash
pnpm verify                     # typecheck + build + contract:check + full suite (the gate)
pnpm typecheck                  # tsc --noEmit; there is no ESLint/Prettier in this repo
pnpm build                      # tsc -p tsconfig.build.json -> dist/
pnpm test                       # pretest hook runs contract:check + build first, then vitest
npx vitest run tests/foo.test.ts        # one file, skipping the slow pretest hook
npx vitest run -t "substring of test name"
pnpm test:stdio                 # rebuilds dist/ and runs tests/stdio.test.ts alone
pnpm contract:generate          # rewrite contracts/ + docs/generated/ after a surface change
pnpm run verify:tiled-1.12.2    # pnpm verify with TILEDMCP_REQUIRE_TILED_1_12_2=1
```

Run the server against a project: `node dist/index.js --project-dir /abs/path` (or `pnpm dev`
for the tsx path).

Tests that cross-check against real Tiled gate on `hasTiledCli` from `tests/support/tiledCli.ts`
and skip when it is absent. `TILEDMCP_REQUIRE_TILED_1_12_2=1` makes them hard failures instead,
which is the only difference between `pnpm verify` and `pnpm run verify:tiled-1.12.2`. Point at a
non-standard install with `TILED_CLI_PATH` / `TILED_RASTERIZER_PATH`.

## Architecture

`src/boot.ts` wires five things over one transport: `ProjectPathResolver` (sandbox) →
`DocumentStore` (bytes, revisions, checkpoints) → `MapService` (all reads and planners) →
`TiledCliAdapter` (optional external binaries) → `wireTiledMcpServer` (tool registration);
`src/index.ts` is the thin stdio bin around it. The sandbox root comes from
`--project-dir`/`TILED_PROJECT_DIR`, or, when absent, from the client's first MCP root: the
boot connects a dependency-free server shell through `src/gatedTransport.ts` (which buffers
all non-handshake traffic), answers `initialize`, calls `roots/list`, wires the tools, then
releases the gate — failing closed if the client supplies no root. Startup runs
`store.recoverTransactions()` and `store.reconcilePreparedCheckpoints()` before serving, and
writes both reports to stderr. stdout is MCP protocol only.

### The write pipeline

This is the invariant the whole codebase is built around, and it spans four modules:

1. A `plan*` method on `MapService` reads pinned documents, validates, and returns a plan.
2. `ChangeSetRegistry` (`src/changeSets.ts`) stores the plan under a `changeset:<sha256>` id
   with a TTL, a content digest, and the map plus full dependency revisions it was built from.
3. The client approves and calls `tiled_apply_change_set`.
4. An `apply*` method re-derives the plan from the pinned bytes, compares it against the stored
   digest, takes the `KeyedMutex` lock, re-checks the raw-byte revision (a CAS against
   cooperating writers), commits a content-addressed checkpoint, then atomically replaces.

`tiled_create_map` and `tiled_create_checkpoint` are the only tools that write without this
loop. Anything new that mutates project bytes goes through it.

`ChangeSetPlan` (`src/changeSets.ts`) is a discriminated union of 17 kinds: `mapEdit`,
`tilesetEdit`, `tilesetPropertyEdit`, `tilesetCreate`, `embeddedTilesetEdit`, `fileDelete`,
`worldEdit`, `wangEdit`, `fileExport`, `propertyTypeEdit`, `tileNameEdit`, `transaction`, and
five checkpoint kinds. `src/planKinds.ts` maps each to its applier through a
`{[K in ChangeSetPlan["kind"]]: ...}` registry, so adding a plan kind without wiring an applier
is a compile error rather than a runtime fallthrough.

### Source-preserving writes

Edits never re-serialize a document. `src/formats/jsonSourcePatch.ts` applies surgical byte
edits (`JsonObjectMemberPatch`, `JsonArrayInsertion`, `JsonArrayDeletion`, `JsonArrayMove`) so
BOM, CRLF, indentation, key order, number lexemes, and unknown fields survive outside the
touched span. Tile edits patch one layer's `data` member; object edits patch one `objects`
array. When a plan nets out to no change, apply must leave the file byte-identical and report
`changed: false`. Round-trip tests assert exact bytes, so a convenient
`JSON.stringify(doc)` will fail them.

### Storage invariants (`src/storage/`)

`documentStore.ts` treats raw bytes as authoritative: `revision` is `sha256:<hex>` of the file
bytes, never of parsed JSON. `checkpoints.ts` is a content-addressed blob store with a manifest
per checkpoint, shared-blob refcounting, a byte quota, and a prepared→committed state machine
that startup reconciliation resolves. `transactions.ts` gives cross-file atomicity via a WAL
that rolls forward or back on restart. `fileLock.ts` + `keyedMutex.ts` serialize writers within
and across processes. Internal state lives under `.tiledmcp/` inside the project root.

### Fail closed

Where Tiled 1.12.2's behavior is ambiguous or unimplemented, this server errors rather than
approximating; `docs/03-architecture.md` and `docs/02-mcp-spec.md` record the source-level
reasoning per case. Practical consequences: staggered/hexagonal are read-only; isometric
and oblique are editable (storage is orthogonal; only the projection differs — oblique by
the skewx/skewy shear, with the degenerate `skewx*skewy == tilewidth*tileheight` case
rejected); templates, class properties, and out-of-profile XML
structure reject rather than guess. Preserve that stance when extending a planner. Every
observed GID is fully decoded and validated even on paths that are about to overwrite it.

### Module map

| Path | Role |
|---|---|
| `src/server.ts` | every tool registration, input schemas, result envelopes (~240 KB, one file by design) |
| `src/maps/mapService.ts` | the read and plan/apply surface the server calls |
| `src/maps/mapPrimitives.ts` | GID decode, layer-tree walks, tileset binding, shared validators |
| `src/maps/mapOperations.ts` | the 17 `tiled_preview_edits` operation planners |
| `src/maps/mapDomain.ts` | every numeric budget and limit as a named constant |
| `src/outputSchemas/` | closed Zod output schemas, mirroring the read/changeSet/semantic split |
| `src/project/assetRegistry.ts` | opaque `asset_<hex>` ids, backed by inode identity |
| `src/images/` | native PNG rendering (sharp): previews, sheets, isometric, hexagonal |
| `src/resources/guide.ts` | the `tiled://guide` resource text |
| `src/adapters/tiledCli.ts` | probes and drives `tiled` / `tmxrasterizer` when present |

Budgets belong in `mapDomain.ts`, not inline. If you add one, `tiled_get_capabilities` should
publish it.

## Changing the tool surface

Adding or editing a tool touches more than `server.ts`. In order:

1. Register with the local `register()` helper in `server.ts`. It validates the result against
   the declared output schema and checks that `isError` matches the presence of an
   `{ok: false}` envelope; a mismatch is swallowed into `INTERNAL_ERROR`, so a tool that
   "returns nothing useful" usually means a schema or envelope mismatch, not a thrown error.
2. Add the name to `TILED_MCP_CORE_TOOL_NAMES` or `TILED_MCP_OPTIONAL_TOOL_NAMES`. The two
   lists must stay disjoint and duplicate-free.
3. Give it a closed output schema in `src/outputSchemas/`. Schemas are exhaustive on purpose.
4. Name it in `src/resources/guide.ts` and `docs/02-mcp-spec.md`.
   `tests/toolSurfaceCoverage.test.ts` enforces both.
5. Add exactly one call example to `examples/mcp-calls.v1.json`, validated against the public
   input schema.
6. Run `pnpm contract:generate` to rebuild `contracts/*.json` and `docs/generated/`.
   `pnpm contract:check` is a drift gate inside `pretest`, so skipping this fails every
   subsequent test run. The generator drives a real in-memory MCP client over two capability
   profiles and never probes PATH.

New error codes must be added to the explicit allowlist in `src/errorRegistry.ts`. A
`TiledMcpError` constructed with an unlisted code silently degrades to `INTERNAL_ERROR` with
empty details, which is easy to misread as a bug elsewhere.

## Conventions

- ESM with `NodeNext`: relative imports carry the `.js` extension even from `.ts` sources.
- `tsconfig.json` runs `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
  `verbatimModuleSyntax`, `noUnusedLocals`, and `noUnusedParameters`. Optional properties often
  need an explicit `| undefined` when a value is forwarded rather than omitted.
- Read and preview paths must resolve assets with `persistIdentity: false` so `readOnlyHint`
  stays true; only apply paths pass `true`.
- No `Math.random` and no wall-clock in generators. Procedural tools hash their seed and
  coordinates so the same input yields the same bytes.
- Tests build their fixtures through `createProject` / `withProject` / `makeStore` in
  `tests/support/project.ts` rather than hand-rolling temp directories.
- `vitest.config.ts` sets a 30s timeout as a hang detector, not a performance budget.
