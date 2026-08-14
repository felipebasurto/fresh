# @earendil-works/pi-protocol

Runtime-neutral schemas, types, CBOR encoding, and byte-stream framing for the experimental Pi protocol.

Protocol version `1` currently contains the first control-plane slice:

- a version handshake that identifies the logical `serviceId`;
- a service RPC manifest with `list()` and `attach(sessionId)`;
- a separate launcher-only server-control manifest with `drain()`;
- correlated responses and bounded protocol errors.

The manifest generates typed client methods and validated server dispatch. The wire uses generic `{ serviceId, method, args }` calls rather than a hand-written command union. `list()` returns the durable `SessionMetadata` values from `SessionRepo.list()`. `attach()` returns only the attached `sessionId`; the real `Session` and `AgentHarness` remain hosted by the server.

`drain()` tells one server generation to close its hosted Harnesses, acknowledges successful cleanup, and begins shutdown. It does not transfer hosted-session state. The server does not know whether another generation will replace it; replacement and explicit client reattachment belong to the launcher and clients.

Separating `ServerControlRpc` from `ServiceRpc` is an API boundary, not an authorization boundary. Transports exposing server control must authenticate the caller as an administrator. The experimental local launcher uses a mode-`0600` Unix socket and trusts same-user peers.

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
