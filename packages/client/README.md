# @earendil-works/pi-client

Transport-neutral client for the initial Pi `list` and `attach` protocol slice.

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
  serviceId: "0123456789abcdef0123456789abcdef",
  transportFactory,
});
const sessions = await client.listSessions();
const attachment = await client.attachSession(sessions[0].id);
```

The client verifies that the physical endpoint reports the expected logical `serviceId`. Every list and attach request carries that ID again so the final server can reject misdelivery.

`attachSession()` currently returns only `{ sessionId }`. Remote Session and Harness methods will be added directly from the new shared interfaces in a later slice. The client does not reconnect or replay requests automatically. After disconnection, call `reconnect()` and explicitly repeat safe control-plane actions.

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
  serviceId: "0123456789abcdef0123456789abcdef",
  transportFactory: createUnixTransportFactory({ path: "/tmp/pi.sock" }),
});
await client.connect();
```

Unix discovery scans `~/.pi/server/*.sock`, derives each expected service ID from its filename, and verifies it through the existing handshake:

```ts
import { discoverUnixServices } from "@earendil-works/pi-client/unix";

const routes = await discoverUnixServices();
// [{ serviceId: "...", path: "/home/me/.pi/server/<serviceId>.sock" }]
```

Malformed entries, non-sockets, stale or unresponsive endpoints, and service-ID mismatches are ignored. Discovery is read-only and probes at most 16 sockets concurrently. Unexpected filesystem and socket errors reject discovery. Pass `directory` or `timeoutMs` to override the defaults.

`PiClientOptions.maxFrameLength` bounds protocol payloads. `maxPendingBytes` bounds queued Unix transport output. Configure matching limits on both peers.
