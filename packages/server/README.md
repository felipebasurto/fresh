# @earendil-works/pi-server

Experimental local server for the new durable Session and Agent Harness interfaces.

The current slice supports two client operations:

- `list` calls `SessionRepo.list()` without opening sessions.
- `attach` finds the requested metadata, passes it to the host, and retains the returned Harness handle in the server.

The separate launcher-control operation `drain` closes hosted Harnesses, acknowledges successful cleanup, and closes that server generation. It does not transfer hosted-session state, and the server does not decide whether a replacement should start. Clients explicitly reconnect and reattach after replacement.

Concurrent attachments to one session reuse one hosted Harness. Attachment is a one-shot acquisition request, so losing the client connection does not close the Harness. Server shutdown closes every hosted Harness, releasing its Session writer ownership.

```ts
import { randomUUID } from "node:crypto";
import { MemorySessionRepo, type Session } from "@earendil-works/pi-agent-core";
import {
  type HostedHarnessHandle,
  type PiServerHost,
} from "@earendil-works/pi-server";
import { createUnixServer, getUnixSocketPath } from "@earendil-works/pi-server/unix";

async function startServer(
  createHarnessForSession: (session: Session) => Promise<HostedHarnessHandle>,
) {
  const sessions = new MemorySessionRepo();
  const host: PiServerHost = {
    sessions,
    async createHarness(metadata) {
      const session = await sessions.open(metadata);
      try {
        return await createHarnessForSession(session);
      } catch (error) {
        try {
          await session.close();
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Harness creation and Session cleanup failed",
          );
        }
        throw error;
      }
    },
  };

  const serverId = randomUUID();
  const server = createUnixServer(host, {
    serverId,
    path: getUnixSocketPath(serverId, "/run/user/1000/pi"),
  });
  await server.start();
  return server;
}
```

Applications supply a session catalog and a Harness factory. The server only calls `list()`; the host receives the repository's concrete metadata and owns opening the Session, creating the Harness, and cleaning up failed creation. This permits the host to perform those operations in a worker process without passing an open JavaScript Session across processes.

`serverId` is a logical identity supplied by the launcher, not a socket address. The Unix preset requires an explicit physical `path`; `getUnixSocketPath()` derives one from a caller-selected directory. Choose a short, private runtime directory rather than deriving the route from an unbounded home-directory path. A long-lived launcher can reuse the same ID and path when replacing a server process.

`PiServer` composes authenticated transports through `PiServerListener`. The Unix submodule provides `createUnixListener()` and `createUnixServer()`. Low-level CBOR framing and validation come from `@earendil-works/pi-protocol`.

`ServerControlRpc` is administrative but is not itself an authorization mechanism. A transport exposing it must trust every connected peer as an administrator or authenticate control access separately. The experimental local launcher enforces mode `0600` on its Unix socket and therefore trusts same-user peers.
