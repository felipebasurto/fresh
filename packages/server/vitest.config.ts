import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
	},
	resolve: {
		alias: {
			"@earendil-works/pi-agent-core": fileURLToPath(new URL("../agent/src/index.ts", import.meta.url)),
			"@earendil-works/pi-ai": fileURLToPath(new URL("../ai/src/index.ts", import.meta.url)),
			"@earendil-works/pi-telemetry": fileURLToPath(new URL("../telemetry/src/index.ts", import.meta.url)),
			"@earendil-works/pi-protocol": fileURLToPath(new URL("../protocol/src/index.ts", import.meta.url)),
		},
	},
});
