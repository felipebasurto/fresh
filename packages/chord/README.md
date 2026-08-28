# @earendil-works/chord

Chord is an application-composition runtime for systems assembled from
plugins/extensions.  It is built on services, replicated state, and automatic
RPC.  It is being developed as a standalone package in the Pi monorepo, but it
is not a Pi package: it does not depend on any other Pi workspace package and is
built to also be usable by unrelated applications.

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

- **RPC** connects two symmetric peers over an application-supplied duplex
  transport.  Either peer may provide and consume services.  Remote calls,
  state snapshots, updates, catalogues, and control messages use strict JSON and
  support cancellation.

- **Context** Chord provides a Go-like context system for cancellation and
  invocation-scoped application values. Applications can carry permissions or
  telemetry through those values without Chord depending on either.

Chord bundles application-declared plugin-module facets into independently
loadable Node ESM artifacts.

See [PLANNING.md](PLANNING.md) for the architecture, implementation order,
migration boundary, and conformance criteria.
