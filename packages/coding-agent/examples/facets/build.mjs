import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleFacets } from "@earendil-works/chord/bundler";

const directory = dirname(fileURLToPath(import.meta.url));
const result = await bundleFacets({
	plugin: { id: "@pi/example-bundled", version: "1" },
	entries: {
		session: join(directory, "session.ts"),
		tui: join(directory, "tui.ts"),
	},
	outdir: join(directory, "dist"),
	sourceMap: true,
});

console.log(result.manifestPath);
