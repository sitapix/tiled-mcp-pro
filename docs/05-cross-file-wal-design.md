# Cross-File WAL Transaction Design (M2)

Status: **S1 (storage core), S2 (wire layer), S3 (create+attach coupling admission), and
S4A (pre-state-consistent pin coupling admission) are implemented**; decision points D1–D5
in section 6 all passed as recommended. The S4A implementation finding: all members are
validated against, and atomically committed from, the same pre-state, so a member's pin on
another member's target is safe as long as it equals that member's own base revision (i.e.
the shared pre-state) — applying the members in any serial order over the pre-state yields
the committed result, so "plan pin rewriting" is not needed, and the preview check narrows
from "forbid coupling" to "reject only when a pin disagrees with the member's pre-state".
S4B (merging multiple plans on the same file) **remains excluded**: a single
`tiled_preview_edits` plan already carries multi-operation batches on one file, and the
complexity of chained prospective pins has no corresponding value. Implementation entry
points: `DocumentStore.commitTransaction` / `recoverTransactions`
(src/storage/documentStore.ts, src/storage/transactions.ts) and
`ChangeSetRegistry.previewTransaction` + `MapService.applyTransaction`
(src/changeSets.ts, src/maps/mapService.ts); tests are
tests/transactions.test.ts (step-by-step crash injection), tests/transactionWire.test.ts,
and tests/transactionCreateAttach.test.ts.

## 1. Goals and non-goals

**Goal**: one approved multi-document commit either lands on disk in full or not at all;
after the process crashes at any point during the commit, startup reconciliation can restore
the project to either "fully before commit" or "fully after commit", and the recovery
actions are machine-verifiable and explainable to the operator.

Typical scenarios (ordered by value):

1. A batch of **mutually independent** approved change sets committed atomically (edits to
   several maps, or a map edit plus an edit to an unrelated tileset) — "all-or-nothing
   batch apply".
2. `tiled_create_tileset` + `tiled_add_tileset_to_map` as an atomic combination
   (create-and-attach). Feasibility rests on the create plan's `expectedRevision` being the
   SHA-256 of the prospective TSJ bytes, which lets the attach plan pin the new tileset's
   exact revision ahead of time.
3. `tiled_update_tile` + a map edit that depends on the new tileset revision (change the
   metadata and update the map in step) — requires "plan pin rewriting" semantics, at
   significantly higher complexity.

**Non-goals**:

- Does not change the operational premise of `filesystemThreatModelContract` v1:
  non-cooperating writers inside the commit window remain unsupported. Cross-file atomicity
  holds only under the same premise under which single-file atomicity holds.
- No cross-process distributed coordination, and no promises for network/cloud filesystems.
- No general nested transactions or savepoints.

## 2. Existing invariants that must hold

- The single-document commit path (CAS + checkpoint + same-directory rename/hard-link
  promotion + project file lock) is unchanged verbatim; a transaction is a composition
  layer on top of it, not a replacement.
- Every net-change target gets a checkpoint before it is written (transaction members
  inherit this one by one).
- The change set preview→approve→apply boundary and the anti-ABA digest mechanism are
  unchanged; a transaction must never become a channel for bypassing per-member approval.
- The startup reconciliation pattern for `.tiledmcp` internal state (scan → classify →
  auto-resolve/leave for adjudication) carries over.

## 3. Options compared

### Option A (recommended): redo journal + content-addressed staging + ordered per-file promotion

- The transaction manifest lives at `.tiledmcp/transactions/<uuid>.json`, with fields:
  `{version, id, state: "prepared" | "committed", createdAt, label,
  entries: [{path, kind: "replace" | "create" | "delete",
  expectedRevision | expectedAbsent, afterRevision | afterAbsent,
  contentObjectHash?, checkpointId}]}`.
- New content is staged as **content-addressed objects** (directly reusing the checkpoint
  store's object storage and GC-root mechanism: a prepared transaction manifest is a new
  GC-root category).
- Commit protocol:
  1. Take the existing project file lock on all targets in canonical path order (total
     order → no deadlock).
  2. Per-target CAS re-check (replace/delete verify the current revision; create verifies
     absence).
  3. Per-target before-state checkpoint (reusing the existing prepare mechanism; the
     manifest associates the transaction id as a label convention).
  4. Staged content objects are written to disk and fsynced.
  5. **Commit point**: the transaction manifest lands atomically with `state:"committed"`
     (single-file tmp + fsync + rename). A crash before this point → roll back; a crash
     after → roll forward.
  6. Per-target promotion (replace via rename, create via hard-link no-replace, delete via
     checkpoint-first unlink — all three are existing mechanisms).
  7. Delete the transaction manifest (the terminal state is "no manifest"), and mark the
     checkpoints committed.
- Startup reconciliation gains a transaction scan (before the existing checkpoint
  reconciliation):
  - `prepared` manifest: the commit point was not crossed → **roll back**: targets are
    untouched (promotion never started), so delete the manifest and orphaned staged
    objects; member checkpoints go through the existing prepared reconciliation.
  - `committed` manifest: **roll forward**: check the current revision per target —
    targets already equal to afterRevision are skipped; targets still equal to
    expectedRevision replay promotion (staged objects are content-addressed, so replay is
    idempotent); targets equal to neither (externally written inside the crash window) →
    that target is marked conflict and enters a manual flow like prepared-checkpoint
    adjudication, while the remaining targets roll forward as usual — the atomicity promise
    degrades here to disclosure (consistent with the threat model's
    non-cooperating-writer boundary).
  - Roll-forward complete → delete the manifest.

### Option B: undo log (write targets first, before-images as rollback backstop)

The commit point comes after the last target is written; crash recovery runs in the
rollback direction. Drawbacks: the commit point is not a single atomic action (it depends
on the compound fact "everything has been written"), the recovery semantics compose more
awkwardly with the existing create/delete mechanisms, and reconciliation must distinguish
"target N was half-written". Not recommended.

### Option C: generation directory switch

Whole-directory generations plus a symbolic switch. Conflicts with the project principles
of "preserve untouched files' original bytes, zero extra state outside `.tiledmcp`", and
the workspace semantics are opaque to external tools. Excluded.

## 4. Wire contract design (recommended shape)

**Compose existing approved change sets, rather than a new nested operation language:**

- New preview tool `tiled_preview_transaction`: input
  `{changeSetIds: [2..16 existing, not-yet-applied change set ids]}`.
- Validation: members must be document-commit plans (`mapEdit` / `tilesetEdit` /
  `tilesetCreate` / `fileDelete`); target paths must be pairwise distinct (same-file
  batches go through a single plan with multiple operations, plans are not merged); a
  member's pin on another member's target must equal that member's base revision (shared
  pre-state consistency, S4A), and attaching a tileset created in the same transaction
  must pin its prospective revision exactly (scenario 2). Checkpoint-class plans and
  restore-class plans are excluded.
- Returns a `transaction` change set: a domain-separated digest freezes every member's
  plan digest and target pin set, and `expectedRevision` uses an aggregate digest
  (SHA-256 of the ordered `{path, revision}` pairs, consistent with the batch prune
  aggregate-pin precedent).
- apply: runs the section 3 protocol; the response returns a per-target commit result
  array plus the transaction id.
- Member change sets **transfer ownership** at transaction preview (applying a member
  individually and applying the transaction are mutually exclusive, preventing double
  commit); transaction expiry releases the members.

## 5. Budgets and boundaries

- Member count 2..16; total staged bytes ≤ 64 MiB (matching the dependency-aggregation
  cap).
- Transaction manifests count against the checkpoint store quota system (staged objects
  share the pool with before objects; prepared transactions are GC roots).
- At most 4 pending transaction change sets at any one time.

## 6. Decision points requiring sign-off

| # | Decision | Recommendation |
|---|---|---|
| D1 | Option A (redo journal + roll-forward) vs Option B (undo log + rollback) | A |
| D2 | Wire shape: compose existing change sets vs a new nested operation language | Compose existing change sets |
| D3 | Whether V1 includes scenario 2 (create+attach coupling admission) | Include (high value, pin statically verifiable) |
| D4 | When committed roll-forward finds a single target clobbered by an external write: block the whole transaction for manual adjudication vs mark that target conflict alone and roll the rest forward | Per-target conflict + disclosure |
| D5 | Member ownership: transaction preview locks members (mutually exclusive with individual apply) | Lock |

## 7. Implementation slices (after approval)

1. **S1 storage core**: transaction manifest read/write/validation, staged objects reusing
   the checkpoint store, the commit protocol, and startup reconciliation
   (rollback/roll-forward/conflict classification), all with crash-injection tests (a kill
   point inserted between every protocol step, replaying reconciliation). No wire changes.
2. **S2 wire**: `tiled_preview_transaction` + the `transaction` change set kind + apply
   dispatch + member ownership + contracts/docs/guide; includes scenario 1.
3. **S3 scenario 2**: create+attach coupling validation and end-to-end tests.
4. **S4 (optional, separate sign-off)**: scenario 3 (pin rewriting) and same-file
   multi-plan merging.
