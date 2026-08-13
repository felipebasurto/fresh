# @earendil-works/pi-server

Experimental local server for the new durable Session and Agent Harness interfaces.

The current slice supports two control-plane operations:

- `list` calls `SessionRepo.list()` without opening sessions.
- `attach` finds the requested metadata, calls `SessionRepo.open()`, creates an `AgentHarness`, and retains that Harness in the server.

Concurrent attachments to one session reuse one hosted Harness. Losing a client connection removes its attachment but does not close the Harness. Server shutdown closes every hosted Harness, releasing its Session writer ownership.

```ts
import { MemorySessionRepo } from "@earendil-works/pi-agent-core";
import type { PiServerService } from "@earendil-works/pi-server";
import { createUnixServer } from "@earendil-works/pi-server/unix";

const sessions = new MemorySessionRepo();
const service: PiServerService = {
  sessions,
  async createHarness(session) {
    return createApplicationHarness({ session });
  },
};

const server = createUnixServer(service, {
  path: "/tmp/pi/server.sock",
  serviceId: loadStableServiceId(),
});
await server.start();
```

Applications supply the repository and Harness factory. `serviceId` is a logical identity supplied by the installation or server profile, not a socket address.

`PiServer` composes authenticated transports through `PiServerListener`. The Unix submodule provides `createUnixListener()` and `createUnixServer()`. Low-level CBOR framing and validation come from `@earendil-works/pi-protocol`.
