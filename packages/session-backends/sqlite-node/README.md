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

The default layout creates one `{sessionId}.sqlite` file per Session under `directory`; path-safe encoding for arbitrary explicit IDs is tracked by WP07. Pass `databasePath` to place multiple Sessions in one supported shared container. Open Sessions own separate SQLite connections; repository listing, deletion, and closed-source forks open temporary connections.

The backend provides the Session repository, storage implementation, writer leases, branch projections, and maintained statistics. WP07 tracks transaction-local fence enforcement, deletion fencing, and path safety. The package does not currently export a search service or FTS index; search is the separate S3 projection.
