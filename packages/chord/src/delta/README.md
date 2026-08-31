# Chord Delta

Chord Delta synchronizes one mutable JSON value from an authoritative producer
to an ordered replica. It is available from `@earendil-works/chord/delta`.

A change is represented by an `Op`: a small JSON tuple that replaces the root,
sets or deletes a value, updates a string, or splices an array. `flush()` returns
`Op[]`; `apply()` replays those operations on a replica.

```ts
import { apply, track } from "@earendil-works/chord/delta";

const tracker = track({ output: "", entries: [] as string[] });
let replica = apply(undefined, tracker.flush());

tracker.state.output += "done\n";
tracker.state.entries.push("result");
replica = apply(replica, tracker.flush());
```

The first `flush()` returns a complete snapshot. Each later `flush()` returns the
changes needed to transform the previously published value into the current
value. `flush()` returns `[]` when the value has not changed.

## Producing changes

Read and mutate `tracker.state` as a normal object:

```ts
tracker.state.status = "running";
tracker.state.settings.theme = "dark";
tracker.state.messages.push(message);
delete tracker.state.retry;
```

Only the value at flush time is published. Intermediate assignments are not:

```ts
tracker.state.status = "starting";
tracker.state.status = "running";
tracker.flush(); // publishes only "running"
```

Replacing an object or array is also valid. Delta compares its properties and
elements with the previously published value:

```ts
tracker.state.settings = {
	...plainSettings,
	theme: "dark",
};
```

Unchanged properties produce no operations. Changed nested strings and arrays
still use the compact forms described below.

### Strings

Appending text produces an append operation:

```ts
tracker.state.output += "next line\n";
```

Moving a bounded text window forward produces a front-truncate followed by an
append when the old suffix exactly matches the new prefix:

```ts
tracker.state.output = tracker.state.output.slice(200) + nextChunk;
```

An unrelated replacement produces a normal set operation.

### Arrays

Use normal array methods:

```ts
tracker.state.messages.push(first);
tracker.state.messages.push(second);
tracker.state.messages.splice(3, 1, replacement);
```

All `push()` calls before one flush are published as one tail splice. Changes to
older elements remain separate, regardless of whether they happen before or
after the pushes. Changes to newly pushed elements are included in the pushed
values.

Front or middle insertion, removal, sorting, reversing, `fill()`, and
`copyWithin()` are supported. These operations can require comparison or
replacement of a larger array region than a tail append.

Sparse arrays are not supported. Writing beyond the next index throws. Increasing
`length` creates explicit `null` elements; decreasing it removes elements.

`fill(object)` copies the object independently into each affected position.
`copyWithin()` likewise separates duplicated objects. This keeps tracked state a
tree rather than creating shared mutable array elements.

### Optional properties

Optional object properties use absence. They do not require `null`:

```ts
type Settings = { label?: string; count: number };
const tracker = track<Settings>({ count: 0 });

tracker.state.label = "active";
tracker.state.label = undefined; // deletes label
// `delete tracker.state.label` is equivalent
```

`undefined` is accepted only as assignment syntax for deleting an object
property. It is not a JSON value. Initial and assigned objects cannot contain own
`undefined` values, and array elements cannot be `undefined`. Use `null` when an
array position or explicit empty value must remain present.

## State ownership

The object passed to `track()` becomes tracker-owned. The same applies to objects
later assigned into state or inserted into arrays.

After insertion, retained references may be read or reused, but must not be
mutated directly:

```ts
const item = { status: "new" };
tracker.state.item = item;

tracker.state.item.status = "ready"; // tracked
item.status = "broken"; // unsupported: bypasses tracking
```

Perform mutations through `tracker.state`. Do not put a proxy read from
`tracker.state` back into tracked state. Mutate it in place or construct a
replacement from plain data.

Tracked state must be a mutable JSON tree:

- strings, booleans, finite numbers, `null`, arrays, and plain objects;
- no cycles or one mutable object stored at multiple locations;
- no sparse arrays, accessors, frozen objects, symbols, classes, functions,
  `Map`, or `Set`.

Do not keep a child proxy across an array operation that changes indices. Read
the child again from its new index.

## Operation formats

Delta has two operation formats.

### `Op`: decoded operations

`track().flush()` returns `Op[]`, and `apply()` accepts `Op[]`. Every path is an
inline array.

| Tuple | Meaning |
| --- | --- |
| `["r", value]` | Replace the complete value. |
| `["s", path, value]` | Set a property or array element. |
| `["d", path]` | Delete an object property. |
| `["a", path, text]` | Append to a string. |
| `["t", path, count]` | Remove UTF-16 code units from a string's front. |
| `["p", path, index, remove, items]` | Splice an array. |

### `WireOp`: encoded operations

`WireOp[]` is the transport and storage form. `encoder()` replaces repeated
paths with numeric IDs and may omit a path when it equals the preceding path in
the same batch. `decoder()` restores inline paths.

```ts
import { apply, decoder, encoder, track } from "@earendil-works/chord/delta";

const tracker = track({ output: "" });
const enc = encoder();
const dec = decoder();
let replica: { output: string } | undefined;

const send = () => {
	const wire = enc.encode(tracker.flush()); // Op[] -> WireOp[]
	replica = apply(replica, dec.decode(wire)); // WireOp[] -> Op[]
};
```

Use one encoder and decoder per ordered stream. Numeric path IDs remain valid
across batches. Omitted paths never carry across a batch boundary. A complete
snapshot resets both path dictionaries, allowing replay to start there. Do not
pass `WireOp[]` directly to `apply()`.

## Tracker lifecycle

```ts
tracker.flush(); // publish changes since the previous flush
tracker.rebase(); // make the next flush a complete snapshot
tracker.discard(); // accept current changes without publishing them
tracker.state = replacement; // replace the root; next flush is complete
```

`discard()` intentionally prevents current changes from reaching existing
replicas. Use it only when those replicas do not need the discarded changes.

`apply()` adopts object and array payloads from its input batch. Do not freeze a
batch before applying it, and do not apply one in-memory batch to multiple
replicas unless each replica receives its own clone. A serialized and decoded
batch is already detached.

## Limits

- Delta assumes one authoritative writer and ordered delivery. Sequence numbers,
  gap detection, retries, and persistence policy belong to the surrounding
  protocol or storage format.
- Object identity is not replicated. State must have tree structure rather than
  aliases or cycles.
- Object key insertion order is not replicated. Do not compare or hash replicas
  using serialized key order.
- Array operations that change indices may publish a wider array region than a
  tail append.
- Object-valued keys named `__proto__`, `constructor`, or `prototype` can be read
  and serialized, but cannot be mutated through that key. Replace the nearest
  ordinarily named parent instead.
