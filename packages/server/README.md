# @earendil-works/pi-server

Experimental local server for the new durable Session and Agent Harness interfaces.

The current slice supports two client operations:

- `list` calls `SessionRepo.list()` without opening sessions.
- `attach` finds the requested metadata, passes it to the host, and retains the returned Harness handle in the server.

A Session permits one attached client connection at a time. Repeating `attach` from that connection is idempotent; another connection receives `session_in_use`. Losing the connection releases its attachment lease. The host decides when zero client demand and Harness activity permit worker retirement. Server shutdown closes every hosted Harness, releasing its Session writer ownership.

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

Server and worker lifecycle is managed outside the public Pi protocol. The replaceable application server converts connection attachments into private demand updates; the worker combines generation-tagged demand with authoritative Harness activity. The experimental coordinator only supplies stable routing and reports generic server-generation connection changes.
