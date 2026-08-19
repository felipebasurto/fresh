# @earendil-works/pi-server

Experimental local server for the new durable Session and Agent Harness interfaces.

The current slice supports Session discovery, creation, multi-presentation attachment, prompting, and optional main-lane observation. `RoutedSessionHandle.attachClient()` returns a presentation-scoped capability whose optional `watch()` supplies an authoritative snapshot plus buffered events. The server owns each attachment's single watch ID, starts delivery only after the client has received the snapshot, and removes the watch when that attachment is released.

- `list` calls the host's private Session catalog without opening Sessions and projects presentation-safe summaries.
- `create` asks the host to persist an optional Session ID; private workspace and working-directory data are server-derived.
- `attach` finds the requested metadata, passes it to the host, and retains the returned routed Session handle in the server.
- `prompt` executes one serializable prompt through the requesting presentation's attachment capability.
- `watch`, `startWatch`, and `stopWatch` provide snapshot-first lane observation when supported by the host.

A Session may have multiple presentation attachments. Repeating `attach` from one connection is idempotent; every successful attachment has a server-generated `attachmentId`. Session requests carry `{ serverId, sessionId, attachmentId }`, and the server rejects stale or mismatched routes. Losing a connection rejects its local responses but releases its attachment only after admitted prompts settle. The host decides when zero presentation demand and worker-local Harness activity permit worker retirement. Server shutdown closes every routed Session handle, releasing its worker and Session writer ownership.

```ts
import { randomUUID } from "node:crypto";
import { MemorySessionRepo, type Session } from "@earendil-works/pi-agent-core";
import {
  type RoutedSessionHandle,
  type PiServerHost,
} from "@earendil-works/pi-server";
import { createUnixServer, getUnixSocketPath } from "@earendil-works/pi-server/unix";

async function startServer(
  openRoutedSession: (session: Session) => Promise<RoutedSessionHandle>,
) {
  const sessions = new MemorySessionRepo();
  const host: PiServerHost = {
    sessions: {
      list: () => sessions.list(),
      async create({ id }) {
        const session = await sessions.create({ id });
        try {
          return session.metadata;
        } finally {
          await session.close();
        }
      },
    },
    async openSession(metadata) {
      const session = await sessions.open(metadata);
      try {
        return await openRoutedSession(session);
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

Applications supply a private Session catalog and a routed Session factory. The server projects catalog records to summaries before transport; the host receives the repository's concrete metadata and owns acquiring the worker-local Session and Harness. Failures are cleaned up in that worker. Neither an open JavaScript Session nor a Harness crosses the process boundary.

`serverId` is a logical identity supplied by the launcher, not a socket address. The Unix preset requires an explicit physical `path`; `getUnixSocketPath()` derives one from a caller-selected directory. Choose a short, private runtime directory rather than deriving the route from an unbounded home-directory path. A long-lived launcher can reuse the same ID and path when replacing a server process.

`PiServer` composes authenticated transports through `PiServerListener`. The Unix submodule provides `createUnixListener()` and `createUnixServer()`. Low-level CBOR framing and validation come from `@earendil-works/pi-protocol`.

Server and worker lifecycle is managed outside the public Pi protocol. The replaceable application server converts connection attachments into private demand updates; the worker combines generation-tagged demand with authoritative Harness activity. The experimental coordinator only supplies stable routing and reports generic server-generation connection changes.
