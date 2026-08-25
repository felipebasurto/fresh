# Experimental client/server service slices

`server-builtins.ts` and `session-builtins.ts` are the separate provider allowlists; `builtins.ts` combines them only for presentation hosts and tests, so the server router does not load Session contracts. A token in that inventory is either implemented end to end or registered with an explicit `ServiceSliceNotImplemented` provider. Framed callers receive the stable `service_not_implemented` code. Keyed services hydrate as an empty directory until their owning feature spawns an instance.

| Scope | Service | Current slice | Continuation point |
|---|---|---|---|
| server | `SessionDirectory` | replicated state and semantic directory events implemented | add authenticated per-client projection when identity lands |
| server | `SessionManagement` | create, remove, attach, detach implemented | add authenticated workspace authorization |
| session | `Models` | state, selection, thinking, refresh implemented | move provider/auth composition behind plugin facets |
| session | `Chat` | prompt and durable `requestAbort` implemented; queue, resume, compaction, and navigation contracts declared | replace each explicit throwing provider member with its Harness adapter slice |
| session | `Accounts` | state declared; mutations throw | connect the local credential service to the presentation-safe facade |
| session | `Transcript` | revisioned events surface declared; snapshot throws and no Harness event producer is attached | implement snapshot/event gap handling and remove the compatibility lane watch |

`RemoteEvents` has local and remote ordered delivery, hydration-race buffering, keyed-instance routing, and no replay for late subscribers. `ServerServices.connection` and `SessionServices.attachment` are implemented local control states.

With `PI_EXPERIMENTAL=1`, an interactive `pi client` opens the service-only TUI. It lists the repository-backed `SessionDirectory`, creates or switches Sessions through `SessionManagement`, and selects from the attached worker's `Models` state without invoking Harness drive.

The Session worker assembles its built-in providers and `SessionWorkerRuntime.facets` atomically with `assembleFacetServices()` from `../facets.ts`. The service-only TUI activates its server and Session facets through `activateRemoteFacets()`. Facets use one `defineFacet()` shape and receive one environment containing the common service/lifecycle API plus host attributes. Synchronous setup-time `env.provide()`, `env.provideMany()`, `env.use()`, and `env.observe()` calls produce the internal dependency graph; setup does not repeat a declarative dependency list, and service handles remain disconnected until the complete graph validates. Providers activate before consumers, observations connect with their consuming facet, and disposal runs in reverse dependency order for the complete generation.

A facet always calls unqualified `env.use()` or `env.observe()`. Its facet kind and host select the local, connected-server, or selected-Session service source. Transport namespaces remain internal binding machinery rather than part of the facet environment. TUI facets own subscriptions to their remote replicated state and events; `ExperimentalClientTui` retains only terminal rendering, navigation, and action dispatch. The server provider remains directly assembled until its complete host environment exists. The question dialog, diff review, Git, indexing-job, and canvas examples in `packages/agent/docs/plugins.md` are extension patterns, not built-in coding-agent services. Private references, trace carriers, and flow control remain protocol/host infrastructure slices rather than presentation service tokens.
