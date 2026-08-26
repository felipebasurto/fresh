# @earendil-works/pi-server

Experimental local server for the new durable Session and Agent Harness interfaces.

The current slice supports server- and Session-scoped plugin-service routing, multi-presentation attachment, prompting, and optional main-lane observation. `RoutedServerServiceHost.attachClient()` creates one connection-scoped server service endpoint with narrow attachment-management capabilities. `RoutedSessionHandle.attachClient()` returns a presentation-scoped Session capability. Its optional `invokeService()` forwards an opaque service/member envelope to the selected Session endpoint; the server validates the attachment route but does not load the plugin contract. Its optional `watch()` supplies an authoritative snapshot plus buffered events.

- server service calls and subscriptions route opaquely through the connection's `RoutedServerServiceAttachment`;
- the application-owned `SessionDirectory` projects the private catalog into replicated presentation-safe state;
- the application-owned `SessionManagement` creates, removes, attaches, and detaches Sessions without exposing route IDs in business results;
- attachment changes are published out of band after the router installs or clears the live route;
- the compatibility `list`, `create`, and `attach` operations remain available to low-level clients during migration;
- `prompt` executes one serializable prompt through the requesting presentation's attachment capability.
- unknown Session service calls route through `invokeService` without server-side business-payload decoding;
- service subscription updates remain scoped to the requesting attachment;
- `watch`, `startWatch`, and `stopWatch` provide snapshot-first lane observation when supported by the host.

A Session may have multiple presentation attachments. Repeating `attach` from one connection is idempotent; every successful attachment has a server-generated `attachmentId` delivered only as routing control data. Session requests carry `{ serverId, sessionId, attachmentId }`, and the server rejects stale or mismatched routes. Losing a connection rejects its local responses but releases its attachment only after admitted prompts settle. The host decides when zero presentation demand and worker-local Harness activity permit worker retirement. Server shutdown closes every routed Session handle, releasing its worker and Session writer ownership.

```ts
import { randomUUID } from "node:crypto";
import { MemorySessionRepo, type Session } from "@earendil-works/pi-agent-core";
import {
  type RoutedSessionHandle,
  type ServerHost,
} from "@earendil-works/pi-server";
import { createUnixServer, getUnixSocketPath } from "@earendil-works/pi-server/unix";

async function startServer(
  openRoutedSession: (session: Session) => Promise<RoutedSessionHandle>,
) {
  const sessions = new MemorySessionRepo();
  const host: ServerHost = {
    sessions: {
      list: (context) => sessions.list(undefined, context),
      async create({ id }, context) {
        const session = await sessions.create({ id }, context);
        try {
          return session.metadata;
        } finally {
          await session.close(context);
        }
      },
    },
    async openSession(metadata, context) {
      const session = await sessions.open(metadata, context);
      try {
        return await openRoutedSession(session);
      } catch (error) {
        try {
          await session.close(context);
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

`Server` composes authenticated transports through `ServerListener`. The Unix submodule provides `createUnixListener()` and `createUnixServer()`. Low-level CBOR framing and validation come from `@earendil-works/pi-protocol`.

Server and worker lifecycle is managed outside the public Pi protocol. The replaceable application server converts connection attachments into private demand updates; the worker combines generation-tagged demand with authoritative Harness activity. The experimental coordinator only supplies stable routing and reports generic server-generation connection changes.
