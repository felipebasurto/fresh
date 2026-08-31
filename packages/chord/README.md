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

- **Delta tracking** records mutations to plain JSON as compact operations. It
  preserves append, front-truncation, and array-splice intent, supports durable
  base batches, and validates untrusted operations before applying them.

- **Remote service sources** advertise services available outside a facet host
  and open bindings for the services its facets require. Bindings carry logical
  calls and subscriptions through an application-supplied adapter. Chord
  requires strict-JSON arguments, results, snapshots, updates, and catalogues,
  but does not prescribe framing, routing, transport, or an application wire
  envelope. Symmetric RPC peers are planned as one optional implementation of
  this boundary.

- **Context** Chord provides a Go-like context system for cancellation and
  invocation-scoped application values. Applications can carry permissions or
  telemetry through those values without Chord depending on either.

The current runtime exports service tokens, singleton and keyed providers,
remote bindings, replicated state, facet hosts, and facet loaders from
`@earendil-works/chord`. Import public types and general runtime APIs from the
package root. Context constants and functions live in
`@earendil-works/chord/context` because their generic names should not pollute
the root API.
Chord-owned identifiers use the `chord.*` namespace and its reserved service
prefix is `$chord.*`.

## Tracking JSON deltas

Import the standalone delta primitive from `@earendil-works/chord/delta`:

```ts
import { apply, track } from "@earendil-works/chord/delta";

const changes = track({ output: "", count: 0 });
changes.flush(); // opening base batch
changes.state.output += "done\n";
changes.state.count += 1;

const ops = changes.flush();
const replica = apply({ output: "", count: 0 }, ops);
```

The first flush is always a complete base batch. Later flushes contain path-based
changes. String assignments preserve pure appends and rolling-window movement as
append and front-truncate operations; unrelated rewrites fall back to a set.

## Bundling and loading facets

`@earendil-works/chord/bundler` uses esbuild to turn ESM or TypeScript application
entries into independent, content-addressed CommonJS files. The package-level API
reads plugin identity and build configuration from `package.json`, then applies
facet path conventions supplied by the host application:

```json
{
  "name": "@example/my-plugin",
  "version": "1.0.0",
  "type": "module",
  "peerDependencies": {
    "@earendil-works/chord": "^0.84.4"
  },
  "chord": {
    "facets": {
      "worker": "./src/custom-worker.ts",
      "presentation": false
    }
  }
}
```

```ts
import { bundleFacetPackage } from "@earendil-works/chord/bundler";

await bundleFacetPackage({
	packagePath: "/path/to/my-plugin",
	outdir: "/application-owned/plugin-builds/my-plugin",
	defaultFacets: {
		worker: "src/worker.ts",
		presentation: "src/presentation.ts",
	},
});
```

Existing conventional files become entries unless `chord.facets` overrides or
disables them. Peer dependencies are externalized and resolved against the host
when loading. Chord never installs dependencies or runs package lifecycle
scripts. `bundleFacets()` remains available as the lower-level API for callers
that already have explicit plugin identity and entry mappings.

The output directory contains one `.cjs` file per entry plus
`chord-facets.json`. Load one application-selected entry through the Node-only
loader:

```ts
import { createFacetBundleLoader } from "@earendil-works/chord/node";

const loader = createFacetBundleLoader({
	manifestPath: "/application-owned/plugin-builds/my-plugin/chord-facets.json",
	entry: "worker",
	resolveExternal: (specifier) => import.meta.resolve(specifier),
});
const loaded = await loader.load();
```

Each `load()` verifies SHA-256 integrity and compiles the CommonJS body directly
with `node:vm` instead of putting the plugin into Node's CommonJS or ESM module
cache. Externals are resolved by the host and loaded through a restricted
`require`; esbuild lowers dynamic imports so they use the same path. Disposing a
retired generation releases the loader's facet references, making its compiled
code eligible for garbage collection once plugin-owned resources are also gone.

For transport to another Node host, `readFacetBundleArtifact()` packages one
verified manifest entry with its source, and `createFacetBundleArtifactLoader()`
materializes fresh temporary generations while resolving externals against the
receiving host.

To reload, load a candidate, pass its facets to `FacetHost.reload()`, dispose the
candidate on failure, and dispose the retired `LoadedFacets` only after a
successful cutover. Reload retains the host's existing shape-preservation rules.
The bundler writes a complete temporary directory before replacing the previous
output, so loaders do not observe partially built generations.

See [PLANNING.md](PLANNING.md) for the broader RPC and generation-loading
architecture.
