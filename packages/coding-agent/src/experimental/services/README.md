# Experimental client/server service slices

`server-builtins.ts` and `session-builtins.ts` are the separate provider allowlists; `builtins.ts` combines them only for presentation hosts and tests, so the server router does not load Session contracts. A token in that inventory is either implemented end to end or registered with an explicit `ServiceSliceNotImplemented` provider. Framed callers receive the stable `service_not_implemented` code. Keyed services hydrate as an empty directory until their owning feature spawns an instance.

| Scope | Service | Current slice | Continuation point |
|---|---|---|---|
| server | `SessionDirectory` | replicated state implemented; `events` declared | implement `RemoteEvents` delivery, then publish semantic directory changes |
| server | `SessionManagement` | create, remove, attach, detach implemented | add authenticated workspace authorization |
| session | `Models` | state, selection, thinking, refresh implemented | move provider/auth composition behind plugin facets |
| session | `Chat` | prompt and durable `requestAbort` implemented; queue, resume, compaction, and navigation contracts declared | replace each explicit throwing provider member with its Harness adapter slice |
| session | `Accounts` | state declared; mutations throw | connect the local credential service to the presentation-safe facade |
| session | `Transcript` | revisioned snapshot/events contract declared; both operations throw | implement snapshot/event gap handling and remove the compatibility lane watch |

`RemoteEvents` currently has contract types and provider member classification only. `remoteEvents()`, local listeners, remote listeners, and emission deliberately throw `ServiceSliceNotImplemented`; there are no event delivery frames yet. `ServerServices.connection` and `SessionServices.attachment` are implemented local control states.

The question dialog, diff review, Git, indexing-job, and canvas examples in `packages/agent/docs/plugins.md` are extension patterns, not built-in coding-agent services. Private references, trace carriers, flow control, the plugin kernel, and host facet contexts remain protocol/host infrastructure slices rather than presentation service tokens.
