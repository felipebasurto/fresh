# @earendil-works/pi-server

Experimental local server for the new durable Session and Agent Harness interfaces.

The current slice supports two client operations:

- `list` calls `SessionRepo.list()` without opening sessions.
- `attach` finds the requested metadata, calls `SessionRepo.open()`, creates an `AgentHarness`, and retains that Harness in the server.

The separate launcher-control operation `drain` closes hosted Harnesses, acknowledges successful cleanup, and closes that server generation. It does not transfer hosted-session state, and the server does not decide whether a replacement should start. Clients explicitly reconnect and reattach after replacement.

Concurrent attachments to one session reuse one hosted Harness. Attachment is a one-shot acquisition request, so losing the client connection does not close the Harness. Server shutdown closes every hosted Harness, releasing its Session writer ownership.

```ts
import { MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { generateServiceId, type PiServerHost } from "@earendil-works/pi-server";
import { createUnixServer } from "@earendil-works/pi-server/unix";

const sessions = new MemorySessionRepo();
const host: PiServerHost = {
  sessions,
  async createHarness(session) {
    return createApplicationHarness({ session });
  },
};

const server = createUnixServer(host, {
  serviceId: generateServiceId(),
});
await server.start();
```

Applications supply the repository and Harness factory. `serviceId` is a logical identity supplied by the launcher, not a socket address. `generateServiceId()` creates an in-memory 128-bit identity. The Unix preset defaults to `~/.pi/server/<serviceId>.sock`; pass `path` to override it. A long-lived launcher can reuse the same ID and path when replacing a server process.

`PiServer` composes authenticated transports through `PiServerListener`. The Unix submodule provides `createUnixListener()` and `createUnixServer()`. Low-level CBOR framing and validation come from `@earendil-works/pi-protocol`.

`ServerControlRpc` is administrative but is not itself an authorization mechanism. A transport exposing it must trust every connected peer as an administrator or authenticate control access separately. The experimental local launcher enforces mode `0600` on its Unix socket and therefore trusts same-user peers.
