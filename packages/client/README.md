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
  serverId: "01234567-89ab-4def-8123-456789abcdef",
  transportFactory,
});
const sessions = await client.listSessions();
const attachment = await client.attachSession(sessions[0].id);
```

The client verifies that the physical endpoint reports the expected logical `serverId`. Every list and attach request carries that ID again so the final server can reject misdelivery.

`attachSession()` currently returns only `{ sessionId }`. Remote Session and Harness methods will be added directly from the new shared interfaces in a later slice. The client does not reconnect or replay requests automatically. After disconnection, call `reconnect()` and explicitly repeat safe control-plane actions.

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

Malformed entries, non-sockets, stale or unresponsive endpoints, and server-ID mismatches are ignored. Discovery is read-only and probes at most 16 sockets concurrently. Unexpected filesystem and socket errors reject discovery. The caller must choose a short, private directory because Unix socket path limits are substantially lower than normal filesystem path limits.
Pass `timeoutMs` to override the default probe timeout.

`PiClientOptions.maxFrameLength` bounds protocol payloads. `maxPendingBytes` bounds queued Unix transport output. Configure matching limits on both peers.
