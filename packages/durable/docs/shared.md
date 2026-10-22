# Shared utilities

Durable provides standalone utilities used by its session and task runtime. They do not require an open Harness.

| Import | Contents |
|---|---|
| `@arc/durable` | JSON values and copying, draft types, replicated state |
| `@arc/durable/context` | Cancellation, typed inherited values and telemetry |
| `@arc/durable/delta` | Draft tracking, revisions, change operations and replay |
| `@arc/durable/output` | Bounded text output, UTF-8 boundaries and progress buffering |
| `@arc/durable/sqlite` | Database contracts, schema validation and migrations |
| `@arc/durable/sqlite/node` | Node SQLite database adapter |
| `@arc/durable/sqlite/cloudflare` | Cloudflare Durable Object SQLite adapter |

`storage/sqlite` stores session records on top of the database adapters. It is separate from the lower-level `sqlite` entry points.

## Prepare and replay a change

Prepare a candidate, then adopt it after the surrounding operation succeeds. An abandoned candidate does not change the current revision.

```ts
import assert from "node:assert/strict";
import { track, applyImmutable } from "@arc/durable/delta";

const revisions = track({ items: [] as string[] });
const edit = revisions.beginChange();
edit.state.items.push("ready");
const candidate = edit.prepare();
assert.deepEqual(revisions.value.items, []);
assert.deepEqual(applyImmutable(candidate.base, candidate.ops), { items: ["ready"] });
revisions.adopt(candidate);
assert.deepEqual(revisions.value.items, ["ready"]);
```

Operations represent whole-value replacement, path set/delete, text append/front-trim, array splice and array permutation. Preserve operation order when storing or replaying changes. Treat committed values and operation payloads as immutable. Draft insertions copy their inputs.

## Observe state

`replicatedState(initial)` creates local state with synchronous draft changes. A subscription receives initial hydration before updates. Asynchronous listeners are delivered in order with a bounded pending queue; slow listeners may receive coalesced values.

`replicatedState(source)` attaches to a source snapshot and subsequent numbered frames. Dispose the attachment when its owner leaves. This contract is local observation, not a network transport.

## Carry context

Use `BACKGROUND_CONTEXT` for work with no parent. Use `withAbortSignal()` to combine cancellation with a parent, `withoutAbortSignal()` for an operation that must finish despite its caller cancelling, and `withTelemetry()` to supply an explicit span. Contexts also carry typed values through `createContextKey()` and `withContextValue()`.

`awaitWithContext()` stops waiting when cancelled. It does not itself undo work or cancel a promise that ignores the signal.

## Bound output

`boundOutput()` and `OutputBuffer` enforce byte and line limits with head or tail retention. `Progress` limits publication frequency and output volume. The runtime retains complete tool output separately where the tool contract supplies a spill file.

## Use SQLite adapters

The async database contract supplies `exec`, `run`, `get`, `all`, `transaction` and `close`. The Node implementation uses synchronous SQLite internally and an operation queue to isolate transactions. A temporary transaction executor expires when its callback completes. Use that executor inside the callback; awaiting an operation on the outer database there can wait on the transaction itself.

The Cloudflare adapter accepts a SQLite-backed Durable Object's storage. The platform host owns that storage. Opening this adapter does not deploy a worker, add RPC or supervise processes.
