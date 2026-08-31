# @earendil-works/pi-protocol

Runtime-neutral schemas, types, CBOR encoding, and byte-stream framing for the experimental Pi protocol.

Protocol version `8` carries the current server- and Session-scoped facet-service slice, including operation-based replicated state and Session-branch plugin preparation:

- a version handshake that identifies the logical `serverId`;
- explicit server and Session request targets;
- contract-agnostic service calls with optional keyed-instance identity;
- singleton and keyed-service subscription snapshots plus ordered operation-based state, spawn, and close updates;
- correlated responses, request cancellation, out-of-band attachment updates, attachment-scoped events, and bounded protocol errors.

The transport carries `{ serviceId, instance?, member, args }` calls. A server target contains `{ serverId }`; a Session target contains `{ serverId, sessionId, attachmentId }`. Keyed addresses contain an application key and provider-owned generation so delayed calls cannot reach a replacement instance. Service subscriptions return a complete member/state snapshot before update delivery starts. Service updates carry state, keyed spawn/close, temporary unavailability, and complete singleton replacement; there is no remote service-event member kind. Session-directory state and management results are opaque application service data, not protocol DTOs. Management `attach()` and `detach()` return no routing identifiers; the server publishes the selected live route in an out-of-band `attachment` message. The real `Session` and `AgentHarness` remain process-local. Disconnecting releases only that presentation's attachment after admitted service calls settle.

Experimental presentations consume server-owned `SessionDirectory` and `SessionManagement` plus provider-generated Session service catalogues; there is no handwritten worker service inventory. `Models` has an implemented provider. `AgentController` is the presentation-safe command facade over the worker-owned main `AgentLane`. `Transcript` publishes through ordinary tracked Chord state. Chord flushes decoded operations behind the state API; each client subscription owns one stateful encoder and decoder per replicated member so hydration bases and path dictionaries remain independent. Session service calls and updates route opaquely to the attached worker, where the provider validates and invokes them. The protocol does not define Agent, lane, transcript-entry, branch, model, or plugin business schemas.

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

All control schemas reject unknown object properties, and codecs recursively reject non-JSON opaque service payloads, including non-finite numbers, byte arrays, `undefined`, prototypes, and cycles. Schema violations, malformed CBOR, and invalid framing throw `ProtocolValidationError`. Transports must preserve byte order. Peer authentication and authenticated service contexts are not implemented by the experimental transport.

Default limits are 16 MiB per CBOR payload/frame, 1,000,000 array elements or map entries, and 64 nested item levels. The protocol is experimental and has no compatibility guarantees.
