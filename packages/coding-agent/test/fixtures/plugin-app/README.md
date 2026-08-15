# Remote plugin application prototype

Run both processes from the repository root:

```bash
packages/coding-agent/test/fixtures/plugin-app/run.sh
```

## Layout

```text
lib/                 Reusable plugin and transport library
  api.ts             Service tokens, plugins, RemoteState, RPC cancellation
  client.ts          Typed client proxies and replicated state
  session.ts         Session service host and lifecycle
  protocol.ts        Generic JSON wire messages
  transport.ts       TCP and loopback transports

model-app/           Example application built on the library
  services.ts        Shared model service contract
  plugins.ts         Session and client plugin halves
  providers.ts       Application-specific provider composition
  tui/               Client-local commands, views, and rendering
  run-session.ts     Session process entry point
  run-tui.ts         TUI process entry point
```

The library knows nothing about models, providers, commands, or TUI components. The application knows nothing about snapshots, RPC request IDs, cancellation messages, or TCP framing.

## Plugin author model

1. Define a typed service token in `model-app/services.ts`.
2. In `plugin.session()`, create remote state and provide the service implementation.
3. In `plugin.client()`, use the typed proxy and register client-local UI.
4. Add the plugin to the application's plugin list.

Remote state and ordinary method arguments/results must be JSON-serializable. `RpcOptions` are transport metadata and travel out of band.

## Disconnect contract

- A client disconnect removes its state subscription and aborts its in-flight RPC calls. The session continues so another client can reconnect.
- A session disconnect rejects pending and future client RPC calls. The client keeps its last snapshot as stale display data and exposes `store.connection` as disconnected.
- Reconnection creates a new transport and client and starts from a fresh authoritative snapshot. Replay and automatic reconnect are intentionally outside this prototype.
- The application decides when an unattended session should exit, for example immediately, after an idle timeout, or never.
