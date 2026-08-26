# @earendil-works/pi-protocol

Runtime-neutral schemas, types, CBOR encoding, and byte-stream framing for the experimental Pi protocol.

Protocol version `3` carries the current server- and Session-scoped facet-service slice:

- a version handshake that identifies the logical `serverId`;
- explicit server and Session request targets;
- contract-agnostic service calls with optional keyed-instance identity;
- singleton and keyed-service subscription snapshots plus ordered state, spawn, and close updates;
- correlated responses, request cancellation, out-of-band attachment updates, attachment-scoped events, and bounded protocol errors.

The transport carries `{ serviceId, instance?, member, args }` calls. A server target contains `{ serverId }`; a Session target contains `{ serverId, sessionId, attachmentId }`. Keyed addresses contain an application key and provider-owned generation so delayed calls cannot reach a replacement instance. Service subscriptions return a complete member/state snapshot before update delivery starts. Service updates carry state, keyed spawn/close, temporary unavailability, and complete singleton replacement; there is no remote service-event member kind. Session-directory state and management results contain no working directory, owner, storage, or parent metadata. Management `attach()` and `detach()` return no routing identifiers; the server publishes the selected live route in an out-of-band `attachment` message. `prompt()` targets that exact route. The real `Session` and `AgentHarness` remain process-local. Disconnecting releases only that presentation's attachment after admitted work settles.

`PromptArguments` contains one serializable `AgentLane.prompt()` overload. `PromptMessage` is the protocol's closed set of built-in message DTOs; application-defined `AgentMessage` extensions are not accepted implicitly. `RunResult` is the wire-safe structural equivalent of the Harness result and contains no JavaScript `Error` instances.

The temporary `ServiceRpc` manifest still backs low-level client compatibility methods while those features migrate to services. Experimental presentations consume server-owned `SessionDirectory` and `SessionManagement` plus provider-generated Session service catalogues; there is no handwritten worker service inventory. `Models` has an implemented provider. `Chat` is wired to `AgentLane`; `Accounts` and revisioned `Transcript` retain placeholder providers while those features are completed. Session service calls route opaquely to the attached worker, where the provider validates and invokes them.

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

All schemas reject unknown object properties. Schema violations, malformed CBOR, and invalid framing throw `ProtocolValidationError`. Transports must preserve byte order. Peer authentication and authenticated service contexts are not implemented by the experimental transport.

Default limits are 16 MiB per CBOR payload/frame, 1,000,000 array elements or map entries, and 64 nested item levels. The protocol is experimental and has no compatibility guarantees.
