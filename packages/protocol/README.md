# @earendil-works/pi-protocol

Runtime-neutral schemas, types, CBOR encoding, and byte-stream framing for the experimental Pi protocol.

Protocol version `2` contains the first routed Session-operation slice:

- a version handshake that identifies the logical `serverId`;
- explicit server and Session request targets;
- a service RPC manifest with Session discovery, attachment, prompting, and lane-watch operations;
- correlated responses, attachment-scoped lane events, and bounded protocol errors.

The manifest generates typed client methods and validated endpoint dispatch. The transport carries contract-agnostic `{ serviceId, member, args }` calls. A server target contains `{ serverId }`; a Session target contains `{ serverId, sessionId, attachmentId }`. `list()` and `create()` return presentation-safe `SessionSummary` values containing no working directory, owner, storage, or parent metadata. The server derives private creation fields from authenticated workspace context. `attach()` creates or selects one presentation attachment and returns its Session and attachment IDs. `prompt()` targets that exact live attachment. The real `Session` and `AgentHarness` remain process-local. Disconnecting releases only that presentation's attachment after admitted work settles.

`PromptArguments` contains one serializable `AgentLane.prompt()` overload. `PromptMessage` is the protocol's closed set of built-in message DTOs; application-defined `AgentMessage` extensions are not accepted implicitly. `RunResult` is the wire-safe structural equivalent of the Harness result and contains no JavaScript `Error` instances.

A lane watch uses three RPCs so snapshot ordering does not depend on response/event scheduling: `watch()` creates a buffering watch and returns its authoritative snapshot, `startWatch()` flushes buffered events and begins live delivery, and `stopWatch()` releases it. Events carry their watch ID. Streaming message updates carry compact assistant-message frames rather than cumulative partial messages. Reconnection creates a new watch and snapshot rather than replaying old events.

Server and worker lifecycle is intentionally outside this public protocol. The experimental local coordinator is only an opaque message router; each replaceable server process owns the private lifecycle protocol.

Each wire frame consists of a four-byte unsigned big-endian payload length followed by one definite-length CBOR item. `encodeClientMessage()` and `encodeServerMessage()` validate and encode complete frames. `ClientMessageDecoder` and `ServerMessageDecoder` accept arbitrary stream fragmentation and coalescing.

```ts
import {
  PROTOCOL_VERSION,
  encodeClientMessage,
  ServerMessageDecoder,
  type ClientHello,
} from "@earendil-works/pi-protocol";

const hello: ClientHello = { type: "hello", version: PROTOCOL_VERSION };
transport.send(encodeClientMessage(hello));

const decoder = new ServerMessageDecoder({ maxFrameLength: 1024 * 1024 });
for (const message of decoder.push(incomingChunk)) handleServerMessage(message);
decoder.end();
```

All schemas reject unknown object properties. Schema violations, malformed CBOR, and invalid framing throw `ProtocolValidationError`. Transports authenticate peers before passing protocol bytes and must preserve byte order.

Default limits are 16 MiB per CBOR payload/frame, 1,000,000 array elements or map entries, and 64 nested item levels. The protocol is experimental and has no compatibility guarantees.
