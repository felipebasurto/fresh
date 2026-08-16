# @earendil-works/pi-protocol

Runtime-neutral schemas, types, CBOR encoding, and byte-stream framing for the experimental Pi protocol.

Protocol version `1` currently contains the first control-plane slice:

- a version handshake that identifies the logical `serverId`;
- a service RPC manifest with `list()` and `attach(sessionId)`;
- correlated responses and bounded protocol errors.

The manifest generates typed client methods and validated server dispatch. The wire uses generic `{ serverId, method, args }` calls rather than a hand-written command union. `list()` returns the durable `SessionMetadata` values from `SessionRepo.list()`. `attach()` exclusively binds that Session to the client connection and returns only its `sessionId`; the real `Session` and `AgentHarness` remain hosted by the server. Disconnecting releases the attachment.

The package also defines `PromptArguments`, a tuple containing a serializable `AgentLane.prompt()` overload. `PromptMessage` is the protocol's closed set of built-in message DTOs; application-defined `AgentMessage` extensions are not accepted implicitly. `RunResult` is the wire-safe structural equivalent of the Harness result and contains no JavaScript `Error` instances. These DTOs are not yet exposed through the service RPC manifest.

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
