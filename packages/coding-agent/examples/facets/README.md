# Experimental bundled facets

This example builds one plugin into independent `session` and `tui` facet bundles. The Session-worker facet provides a remote greeting service. The TUI facet contributes `/facet-hello` and calls that service.

From the repository root:

```bash
node --conditions=source packages/coding-agent/examples/facets/build.mjs
```

The build script is plain JavaScript and imports the public `@earendil-works/chord/bundler` entry. The `source` condition selects workspace source in a repository checkout; an installed Chord package uses its compiled `import` export. Node's built-in erasable TypeScript support executes the selected workspace source, while esbuild compiles the facet entries. Neither path uses tsx or jiti.

The build prints the manifest path. Configure the server with that path:

```bash
PI_EXPERIMENTAL=1 \
PI_EXPERIMENTAL_FACET_BUNDLE="$PWD/packages/coding-agent/examples/facets/dist/chord-facets.json" \
./pi-test.sh server
```

The server selects the `tui` artifact and sends it to clients during the protocol handshake. The manifest path is stored in the logical server profile, so later automatically activated server generations retain the selection after an idle server retires. Set `PI_EXPERIMENTAL_FACET_BUNDLE=` explicitly when starting a generation to clear it. The client therefore needs no plugin configuration:

```bash
PI_EXPERIMENTAL=1 ./pi-test.sh client
```

Run `/facet-hello Armin` in the TUI. Chord loads `session` in the Session worker and the server-selected `tui` artifact in the presentation. After editing and rebuilding the facets, run `/reload` in each connected TUI that should cut over to the new presentation generation. The command also reloads the attached Session-worker generation and updates the server artifact advertised to future clients. Rebuilding produces content-addressed files; repeated `FacetLoader.load()` calls use fresh module generations suitable for `FacetHost.reload()`.
