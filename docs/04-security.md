# TiledMCP Pro Filesystem Threat Model

> **Status: Frozen v1 (direct filesystem backend).** What this document freezes is the trust
> boundary of the current filesystem backend; it does not mean every local attack surface has
> been eliminated. The authoritative machine values are returned by
> `tiled_get_capabilities.filesystemThreatModelContract`; its
> `name` is `tiled-mcp-direct-filesystem-threat-model` and its `version` is `1`.
> Any semantic change to any v1 field or value must bump the version.

The contract's `scope` covers only the project-asset JSON document targets committed by the
direct backend. `.tiledmcp` server-internal state — locks, checkpoint manifests,
content-addressed objects, and the asset registry — is explicitly outside this scope; it is
governed by the checkpoint, asset identity, and other contracts and implementation rules, and
the write semantics of internal metadata must not be derived from this document's document
promotion guarantees.

## 1. Supported deployment model

v1 targets one explicitly configured local project root directory, and requires:

- all cooperating writers use one and the same canonical project-relative POSIX path for the
  same logical target, and follow TiledMCP Pro's lock protocol;
- the project lives on a local filesystem that supports same-filesystem atomic `rename`, hard
  links, file `fsync`, and directory `fsync`; distributed/network filesystem semantics have
  not been validated;
- the project root and its parent directories are not actively swapped out mid-operation by a
  malicious process running with the same privileges;
- the Tiled GUI, sync programs, and other writers that do not honor the locks do not save
  concurrently with an existing-target commit.

These are preconditions the operator must sign off on. The server propagates actual syscall
failures, but it does not probe or prove that the underlying filesystem truly implements the
declared atomicity, locking, or durability semantics — and in particular it does not validate
distributed filesystems.

If a deployment must withstand an equally privileged malicious local process, the direct
filesystem backend is not enough. Use containers, OS sandboxing such as `openat2` with
descriptor-relative path policies, or force all writes through a
FUSE/write broker; these backends are not implemented yet.

## 2. Guaranteed boundaries

| Scope | v1 guarantee |
|---|---|
| Revision | SHA-256 of the exact raw bytes of an existing file; not a generation — an ABA that restores identical bytes is still the same revision |
| Same-process writers | Serialized by a mutex keyed on the canonical project path |
| Cooperating cross-process writers | Lock file + final full SHA-256 check inside the lock; stale locks fail closed, never auto-preempted |
| Existing-target promotion | Staged write in the same directory plus `fsync`, then replacement via an unconditional atomic `rename` |
| Missing-target promotion | Staged write in the same directory plus `fsync`, then atomic no-replace via hard link; `EEXIST` always rejects |
| Static paths | Rejects non-canonical paths, escapes, pre-existing symlinks, and non-regular files; reads the final component with no-follow where the platform supports it |
| Post-promotion failure | Subsequent durability failures are downgraded to a warning only when this call has installed the target and the SHA-256 of the read-back bytes matches the proposed revision |
| Visibility | Single-path old-or-new visibility; no cross-file atomic snapshot or transaction is promised |

These guarantees hold only while the operational conditions of section 1 hold.

## 3. Explicitly not guaranteed

### 3.1 Existing-target CAS against non-cooperating writers

The sequence of an existing-target commit is:

```text
final full-byte SHA-256 check
        |
        |  non-cooperative writer can save here
        v
unconditional rename(temp, target)
```

Portable Node `fs` has no atomic primitive for "replace only if the target still matches a
given SHA-256". Plain `rename`, `renameat2(RENAME_NOREPLACE)`, and hard links cannot add that
predicate to an existing target. Therefore:

- different bytes already visible before the final check return `REVISION_CONFLICT`;
- a non-cooperating save that lands after the final check completes and before the `rename`
  can still be overwritten;
- a successful promotion only proves that the event happened; it is not a lease that the
  target is still that revision at response time;
- when current state is needed it must be re-read; a successful response or a change-set
  replay must not be relied on.

`tiled_create_map` does not use this existing-target path. Its hard-link no-replace gives a
stronger guarantee against the race where another process creates the target first: even if
the external bytes are identical, it is never claimed as this call's success.

### 3.2 Path check-to-use race

`lstat`, `realpath`, and final-component no-follow can reject static symlinks, but they cannot
turn a chain of plain Node path APIs into a descriptor-relative sandbox. An equally privileged
malicious process that swaps an intermediate parent directory after the check may change the
actual namespace target of a subsequent `open`, `rename`, or `link`. v1 explicitly lists this
kind of hostile parent swap as unsupported, rather than claiming path canonicalization has
solved it.

### 3.3 Other non-guarantees

- no target inode/metadata CAS is provided;
- no cross-file atomicity is provided — map + TSJ + image remains a `non-atomic-read-set`;
- no durability guarantee across all filesystems/hardware after abnormal power loss;
- no validation of distributed filesystem lock, hard-link, rename, or `fsync` semantics;
- no mediated writer backend is provided.

## 4. Locks and hardlink aliases

Lock keys come from the canonical project path, not from the inode. Two distinct paths never
automatically share a lock, even when they are the same hardlink inode. The supported
cooperating-writer model therefore requires "one canonical project path per logical target".
If a project deliberately points multiple hardlink aliases at the same TMJ/TSJ, callers must
serialize externally as a whole; TiledMCP Pro's path locks must not be interpreted as inode
locks.

Stale locks always fail closed. Before deleting one manually, confirm that the original
PID/writer is no longer active; the PID liveness check is not a lease, and never automatically
decides that a lock has safely expired.

## 5. Change sets and dependency semantics

- a change set pins the map revision, dependency revisions, plan digest, connection, and TTL;
- apply recomputes the plan and re-checks these pins, but the multiple dependencies and the
  map commit are not one atomic read set;
- replaying the same `changeSetId` after success returns the first cached result and does not
  re-validate current on-disk state;
- an external writer can still change a dependency after the last dependency re-check;
- therefore, whenever a "current" conclusion is needed, re-read the map summary/dependencies
  instead of treating replay as a query.

## 6. Operational checklist

Before performing any existing-target commit:

1. Confirm the project lives on a local filesystem satisfying the v1 atomicity and `fsync`
   semantics;
2. Pause Tiled autosave, file synchronizers, and other non-cooperating writers;
3. Ensure the same logical file is not being edited through another hardlink alias;
4. Do not run the direct backend in an untrusted shared-writable directory;
5. After a successful commit, re-read the revision when later decisions depend on current
   state;
6. Monitor stale locks, prepared checkpoints, and the quota reported by
   `checkpointCapabilities.storagePolicy`; quota/GC belongs to the
   `.tiledmcp` internal-state contract, not to this document's document-target scope.

If items 2–4 cannot be satisfied, treat the current backend as read-only, or deploy a
mandatory write mediator.

## 7. Relationship to other contracts

- `safetyStatus` retains only the JSON lexical-fidelity summary; the filesystem safety
  boundary is governed by this v1 contract;
- `mapCreationCapabilities` further freezes the create-map no-replace special case;
- `assetIdentityContract` describes only the opaque ID/registry and does not treat file
  identity as a write CAS; the registry is server-internal state explicitly excluded from
  this contract;
- `snapshotConsistency:"non-atomic-read-set"` continues to describe cross-file reads;
- `applicationErrorContract` describes the application-error wire and does not widen this
  threat model's guarantees.

## 8. Relationship to checkpoint rolling retention

Checkpoint retention belongs to the `.tiledmcp` internal-state contract this document
explicitly excludes, but before it deletes a recovery point it still depends on this
document's cooperating-writer and safe regular-target-read preconditions. It is disabled by
default; only the process startup configuration
`--checkpoint-retain-per-target N` /
`TILEDMCP_CHECKPOINT_RETAIN_PER_TARGET=N` constitutes standing approval,
and `N` is at least 2.

Enabling it does not widen the direct backend's guarantees. The automatic policy handles only
v2 `rolling` existing-file committed manifests carrying a durable ordinal; legacy,
protected/create, and prepared manifests are always retained. It still takes the
checkpoint-store lock inside the current target lock, re-reads the target, and requires the
revision to equal the newest rolling checkpoint's `afterRevision`. Any non-cooperating target
write, internal state drift, or failed full-inventory or object hash/size verification makes
the round delete zero entries. The revision is still bytes identity only, not a generation;
ordering comes from the internal durable ordinal, and is never derived from SHA-256,
wall clock, mtime, UUID, or label.

Retention does not run under quota pressure or inside `ensureCapacity()`. A new checkpoint
must first be fully published and durably marked committed; the round is skipped when the
target promotion carried a durability warning. This way, a failed new write or quota check
never deletes old recovery points first, and no `store → target` reverse lock order is
introduced. The manifest
unlink is an independent destructive commit point, followed by a checkpoint-directory fsync to
confirm durability; GC/lock failures after it are reported in the bounded result of the
successful
document mutation, and must not be interpreted as the target write being safely retryable.

## 9. Explicit committed checkpoint batch prune

`tiled_preview_checkpoint_prune_batch` belongs to the `.tiledmcp` internal-state deletion
contract and does not widen section 2's project-asset document-promotion guarantees. Nor is it
automatic retention: the caller must explicitly supply 2..32 UUIDs from the current checkpoint
listing; the server first lowercase-normalizes them and rejects post-normalization
duplicates, and never auto-selects victims by ordinal, createdAt, label, storage pressure, or
any other heuristic. The batch is ordered by canonical checkpoint ID; the preview must present
this execution order, the complete member manifest
pins, and the non-atomic/partially-committable warning to the approver.

Apply first validates the plan, then canonicalizes and deduplicates the member target paths
and acquires **all** target mutex/file locks in a deterministic path order, and only then
acquires the single checkpoint-store lock. The same target is locked only once, and every
batch uses the same target ordering; no target lock may be acquired in reverse inside the
store lock. This ordering prevents cooperative
retention or another checkpoint writer from modifying the plan members between the pre-check
and the deletion. It is still a path lock,
not an inode lock; section 4's hardlink-alias operational preconditions apply equally.

Before the first manifest unlink, the core authoritatively re-reads every selected member
inside these locks, checking each one for a regular/no-follow file, raw SHA-256, size,
complete metadata, canonical path, and `committed` status. Any member
already deleted by retention/another prune, or any bytes/path/status drift, makes the entire
batch delete zero entries.
This pin barrier deliberately does not read the stored-before blob, and does not require
global inventory/object completeness: what the operator approved are these exact manifests,
and an unrelated corrupt entry must not become a global DoS that blocks a remedial prune.
A missing/corrupt blob only means that recovery point may no longer be restorable; the other
prepared/committed manifests still serve as roots in the final GC. A selected member that has
drifted to prepared fails closed via the status/CAS.

No atomicity is provided across manifests. After passing the barrier, members are `unlink`ed
one by one in canonical ID order, with a checkpoint-directory fsync immediately after each,
stopping at the first member CAS/unlink/fsync/post-delete failure:

- no unlink has succeeded yet: a zero-deletion application error is returned, and
  list/preview can be re-run;
- at least one unlink succeeded: a bounded `partial` or `completed` success is returned and
  cached, with `outcomes` explicitly distinguishing `deleted`, `failed`, and `not-attempted`;
- fsync fails after an unlink: that member is deleted but its durability is unconfirmed, and
  it must not be retried as if it "did not happen";
- a concurrent or later replay of the same `changeSetId` only returns the first cached
  result, and never proceeds with not-attempted members;
- a single fail-closed GC runs only after all manifests have been successfully deleted and
  individually fsynced; on partial,
  GC is not-run, and orphaned objects are left for a later full sweep.

A batch change set is therefore not a durable job, a lease, or a resume token. When the
response is lost but the process is still alive, a replay of the same ID retrieves the cached
result; after a process restart or TTL expiry the old ID no longer exists, and the client must
re-enumerate the on-disk facts and build a new proposal for the IDs that still exist — it must
not treat missing as proof that this batch was deleted. A true all-or-nothing cross-manifest
transaction would require a persistent WAL/tombstone/staging plus the corresponding GC-root
rules; the current
interface makes no such promise.

## 10. Human adjudication of ambiguous prepared checkpoints

Human adjudication changes only `.tiledmcp` internal state and does not widen section 2's
guarantees for project-asset promotion. The interface is deliberately split into
`tiled_preview_prepared_checkpoint_commit` and
`tiled_preview_prepared_checkpoint_abandon`; there is no generic
`force:true` that could be attached to other tools. Both require the client to present the
current bounded proposal, the conflict classification, the permanent effects, and the expiry
to the operator, then call the
unified apply with the `changeSetId` returned by the proposal and the action-specific
`expectedRevision`.

The safety state matrix is:

- create target missing and existing target exact-before are machine-proven as
  write-did-not-land, and can only go through the existing safe discard;
- existing target exact-after is advanced automatically by startup reconcile after a service
  restart;
- only create target exact-after may be committed or abandoned at the operator's choice;
- create target unrelated, existing target missing, and existing target unrelated can only
  be abandoned;
- symlinks, non-regular files, out-of-bounds/internal paths, over-limit sizes, unreadable
  targets, and read races are all rejected.

The preview pins the manifest's raw SHA-256/size, its complete metadata including
version/retention, the target's strict absence or the raw revision/size from a safe nofollow
regular bounded read, and the conflict classification. Commit and abandon use different hash
domains; one kind of approval cannot be rewritten into the other. Apply re-verifies all pins
in `target mutex → target file lock → checkpoint-store lock` order; any manifest
or target drift fails before the first mutation. This CAS is still bytes identity, not an
inode/generation lease; non-cooperating writers and the ABA boundary remain governed by
sections 1 and 3.

Commit accepts only a prepared create whose target revision exactly equals `afterRevision`,
and pins the current size as the apply CAS. It does not modify
project files, does not delete checkpoint objects, and does not run GC; it only atomically
replaces the manifest with a committed one; this committed manifest keeps only an internal
audit record, and the current restore does not interpret
`before.existed:false` as deleting the target. The rename is the commit point, followed by a
checkpoint-directory fsync. An fsync, observer, or lock-release failure after the rename
must be reported as a bounded success with `manifestCommitted:true,durability:"unconfirmed"`.
The client must not treat it as "did not happen" and replay a new approval.

Abandon keeps the current project file, yet permanently unlinks the prepared recovery point;
the fail-closed orphan GC runs only after the directory fsync. It does not read the
stored-before object, so that object being missing or corrupt does not block an explicit
abandonment; a global inventory blocker still makes the GC delete zero entries. Any sync,
observer, GC, or lock-release failure after the unlink still reports `manifestDeleted:true`.
The same change set only replays the first cached result exactly, and never resumes; after a
restart or expiry, re-enumeration is required. Claiming a broader provenance, deleting target
project assets, persistent authorization,
and a generic force are all outside this permission model.
