# @earendil-works/chord

Chord is an application-composition runtime for systems assembled from
plugins/extensions. It provides facets, services, replicated state, and a
pluggable remote-service boundary. It is developed as a standalone package in
the Pi monorepo, but it is not a Pi package: it does not depend on any other Pi
workspace package and can be used by unrelated applications.

## What Chord is for

A single application feature may need to run in several environments: for
example, an agent worker, a terminal UI, and a remote WebUI.  Chord provides the
generic machinery to write such extensions in a way that is both delightful for
humans as well as agents.

The design has a few connected pieces:

- **Plugins** are synchronous setup units that declare the services they provide
  and require. After every plugin has declared its shape, a host validates the
  complete dependency graph, binds services, activates providers before consumers,
  and disposes resources in reverse dependency order.  These units are called
  *facets*.

- **Facets** are parts of a plugin.  Each facet is bundled up separately and runs
  in the process or environment where it's supposed to run.  You can use facets
  to split a plugin into separate pieces that need to be loaded into different
  processes and environments (think backend, browser, TUI etc.)

- **Services** are typed, stable tokens with either one provider (**singleton**)
  or dynamic keyed instances (**keyed**).  A service can be process-local, with
  an unrestricted JavaScript contract, or remotely exposable. Consumers retain a
  stable facade while a provider disconnects or is replaced.

- **Replicated state** exposes authoritative state to local and remote
  connected consumers.  Replicas become ready from a complete snapshot, apply
  ordered updates, and become unready on disconnect or replacement until they
  are rehydrated.

- **Remote connections** carry logical service calls and subscriptions through
  an application-supplied adapter. Chord requires strict-JSON arguments,
  results, snapshots, updates, and catalogues, but does not prescribe framing,
  routing, transport, or an application wire envelope. Symmetric RPC peers are
  planned as one optional implementation of this boundary.

- **Context** Chord provides a Go-like context system for cancellation and
  invocation-scoped application values. Applications can carry permissions or
  telemetry through those values without Chord depending on either.

The current runtime exports service tokens, singleton and keyed providers,
remote bindings, replicated state, facet hosts, and facet loaders from
`@earendil-works/chord`. All public functions are collected in
`@earendil-works/chord/api`, while all public types are collected in
`@earendil-works/chord/types`; both are re-exported from the main entry point.
Chord-owned identifiers use the `chord.*` namespace and its reserved service
prefix is `$chord.*`.

See [PLANNING.md](PLANNING.md) for the broader RPC, generation-loading, and
bundling architecture.
