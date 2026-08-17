# @earendil-works/pi-client

Transport-neutral client for Pi Session discovery, creation, attachment, and prompting.

```ts
import { PiClient, type ByteTransportFactory } from "@earendil-works/pi-client";

const transportFactory: ByteTransportFactory = async (handlers) => {
  // Connect using WebSocket, Unix socket, or another ordered byte transport.
  return {
    async send(chunk) {
      // Deliver bytes in invocation order and honor backpressure.
    },
    close() {},
  };
};

const client = await PiClient.connect({
  serverId: "01234567-89ab-4def-8123-456789abcdef",
  transportFactory,
});
const session = await client.createSession({ cwd: "/workspace" });
const attachment = await client.attachSession(session.id);
const watch = await client.watchSession(attachment.sessionId);
await watch.start((event) => {
  if (event.type === "message_update" && event.frame.type === "text_delta") {
    process.stdout.write(event.frame.delta);
  }
});
const result = await client.promptSession(attachment.sessionId, "Summarize this session");
await watch.dispose();
```

The client verifies that the physical endpoint reports the expected logical `serverId`. Every Session request carries that ID again so the final server can reject misdelivery.

`createSession()` creates durable Session metadata without attaching or opening a Harness; pass `id` to request an exact ID or omit it to generate one. `attachSession()` returns only `{ sessionId }`; the attachment is exclusive to that client connection. `promptSession()` accepts the protocol's serializable Harness prompt overloads and returns a structural `RunResult`.

`watchSession()` creates a main-lane watch and returns its authoritative snapshot without starting event delivery. Install the listener with `await watch.start(listener)`; this then flushes events buffered after the snapshot and continues with live events while `promptSession()` is pending. `watch.dispose()` stops server delivery and waits for already-received listener work. A disconnected watch is stale and cannot be reused after reconnection.

On disconnect or disposal, pending prompts reject locally, but accepted work may still complete remotely before the attachment is released. The client never reconnects or replays requests automatically. After disconnection, call `reconnect()` and explicitly repeat only operations known to be safe.

The experimental local coordinator only provides a stable endpoint and relays traffic. Replaceable server processes own session and worker lifecycle outside the public client protocol.

Call transport handlers as follows:

- `handlers.onData(chunk)` for inbound bytes;
- `handlers.onClose()` for an orderly terminal close;
- `handlers.onError(error)` for transport failures.

A transport factory creates a fresh authenticated connection for each attempt. Requests are correlated by ID, and server failures are exposed as `PiServerError`.

## Unix-domain sockets

Node.js and Bun consumers can use the separate Unix transport:

```ts
import { PiClient } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";

const client = new PiClient({
  serverId: "01234567-89ab-4def-8123-456789abcdef",
  transportFactory: createUnixTransportFactory({ path: "/tmp/pi.sock" }),
});
await client.connect();
```

Unix discovery scans an explicit physical-route directory, derives each expected server ID from its filename, and verifies it through the existing handshake:

```ts
import { discoverUnixServers } from "@earendil-works/pi-client/unix";

const routes = await discoverUnixServers({ directory: "/run/user/1000/pi" });
// [{ serverId: "...", path: "/run/user/1000/pi/<serverId>.sock" }]
```

Malformed entries, non-sockets, stale or unresponsive endpoints, and server-ID mismatches are ignored. Discovery is read-only and probes at most 16 sockets concurrently. Unexpected filesystem and socket errors reject discovery.
Pass `timeoutMs` to override the default probe timeout.

`PiClientOptions.maxFrameLength` bounds protocol payloads. `maxPendingBytes` bounds queued Unix transport output. Configure matching limits on both peers.
