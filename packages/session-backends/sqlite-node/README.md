# @earendil-works/pi-session-backend-sqlite-node

Node `node:sqlite` Session backend for `@earendil-works/pi-agent-core`.

```ts
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import {
  createNodeSqliteFactory,
  SqliteSessionRepo,
} from "@earendil-works/pi-session-backend-sqlite-node";

const repository = new SqliteSessionRepo({
  directory: "/var/lib/pi/sessions",
  databaseFactory: createNodeSqliteFactory(),
});

const session = await repository.create({}, BACKGROUND_CONTEXT);
const main = await session.createBranch("main", null, BACKGROUND_CONTEXT);
await main.appendMessage(
  { role: "user", content: "hello", timestamp: Date.now() },
  BACKGROUND_CONTEXT,
);
await session.close(BACKGROUND_CONTEXT);
await repository.close(BACKGROUND_CONTEXT);
```

The default layout currently creates one `{sessionId}.sqlite` file per Session under `directory`; WP07 replaces that direct interpolation with path-safe encoding for arbitrary explicit IDs. Pass `databasePath` to place multiple Sessions in one supported shared container. Open Sessions own separate SQLite connections. A fork of a source open in the same repository queues on that source; WP07 adds an independent read-only WAL snapshot for a source owned by another process, including a live Session worker.

The host lifecycle, not this backend, guarantees one writable owner per Session. Directly opening the same Session for writes in another process is unsupported; read-only listing and fork-source access may overlap the worker. The backend provides atomic storage, branch projections, and maintained statistics. WP07 removes the current storage-layer writer lease and adds the read-only live-fork path, repository-local deletion reservation, physical/path safety, and complete close draining. The package does not currently export a search service or FTS index; search is the separate S3 projection.
