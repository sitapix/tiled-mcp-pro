# Infinite Map Editing Design (M2)

Status: **implemented** (S1 core + S2 wiring + S3 contract; covered by
tests/chunkedCellView.test.ts and tests/infiniteMapRead.test.ts). Corresponds to the
approved work item "infinite map editing (chunk-preserving write-back)".
All semantics are verified against the Tiled 1.12.2 source
(src/libtiled/tilelayer.{h,cpp}, maptovariantconverter.cpp).

## 1. Chunk semantics in Tiled 1.12.2 (source-code findings)

- In-memory chunks are a 16×16 (`CHUNK_SIZE`) grid; `setCell` locates the chunk with
  the bit operation `x >> CHUNK_BITS`, floor-aligned for negative coordinates.
- **Rebucketing on save**: `sortedChunksToWrite(chunkSize)` rebuckets all non-empty
  cells into aligned rects per `map.chunkSize()` (`editorsettings.chunksize`, default
  16×16); **empty chunks are never written out**; negative coordinates achieve floor
  alignment via a modulo correction; the result is sorted by `compareRectPos`
  (y first, then x).
- The layer-level `width/height/startx/starty` are written from `localBounds()` —
  maintained as the union of chunk-aligned rects (grow-only, never shrinking; a fresh
  load→save equals the union of the non-empty chunk rects).
- The reader accepts arbitrary chunk rects (alignment is not required), so
  "preserving the original chunk boundaries" is not a behavior of Tiled itself:
  **Tiled normalizes the chunk structure on every save**.

## 2. Decisions

| # | Decision | Conclusion |
|---|---|---|
| D1 | Serialization of a written chunked layer | **Normalized write-back** (semantic-for-semantic with a Tiled load→save): all non-empty cells are rebucketed with floor alignment per `editorsettings.chunksize` (default 16×16), empty chunks are dropped, chunks are sorted (y,x), and `startx/starty/width/height` are recomputed as the union of the non-empty chunk rects. Per-cell semantics are unchanged; layers that are not written remain preserved byte for byte. The M2 roadmap's earlier "preserve original chunk boundaries" wording is corrected to this decision per the source evidence, and the correction is disclosed |
| D2 | V1 operation surface | Chunked tile layers allow `setTiles` and `stampPattern` (explicit cell sets, inherently bounded); `floodFill`/`copyRegion`/`replaceTiles`/`resizeMap` continue to fail closed for chunked layers (to be enabled separately later); object, layer-member, and map-root property operations do not touch tile data and are enabled after a per-operation audit |
| D3 | Writing outside existing chunks | Rebucketing covers this naturally: new cells land in aligned new chunks; no separate allocation protocol is needed |
| D4 | Encoded chunks | Re-encode chunk by chunk using the layer-level `encoding`/`compression`, never transcoding; a net no-op write restores the original bytes (consistent with the finite encoded-layer precedent) |
| D5 | Budgets | Existing budgets carry over: ≤4,096 chunks per layer, overlapping chunks fail closed, a 100,000 cellWrites cap, read-side decode budgets unchanged; a chunk count over the limit after rebucketing fails closed |

## 3. Implementation slices

1. **S1 core** (tileData.ts pure functions + tests): `createChunkedCellView`
   (per-chunk decode → sparse `Map<"x,y", gid>` + read/write interface + dirty flag)
   and `serializeChunkedCells` (rebucket → sort → per-chunk encode → bounds),
   with round-trip tests covering negative coordinates, non-aligned input chunks,
   encoded chunks, and net no-ops.
2. **S2 wiring**: `planEdits` enables `allowInfinite` for infinite maps,
   `validateAndSummarizeOperations` gates per operation per D2; the source patch for
   an affected chunked layer replaces `chunks` and the four bounds members; summary
   counts (cellWrites/nonEmpty) are based on the sparse view.
3. **S3 contract**: capabilities (`tileDataReadCapabilities.infiniteMaps` and the
   new `chunkedWriteProfile` string), guide/README/spec/architecture, flipping the
   semantics of the existing "infinite is never editable" tests, both verification
   gates.
