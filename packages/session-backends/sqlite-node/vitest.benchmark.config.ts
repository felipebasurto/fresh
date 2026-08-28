import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const chordIndex = fileURLToPath(new URL("../../chord/src/index.ts", import.meta.url));
const telemetryIndex = fileURLToPath(new URL("../../telemetry/src/index.ts", import.meta.url));
const aiIndex = fileURLToPath(new URL("../../ai/src/index.ts", import.meta.url));
const agentIndex = fileURLToPath(new URL("../../agent/src/index.ts", import.meta.url));
const agentSessionTesting = fileURLToPath(
	new URL("../../agent/src/harness/session/testing/index.ts", import.meta.url),
);

export default defineConfig({
	test: {
		environment: "node",
		benchmark: {
			include: ["benchmark/session/**/*.bench.ts"],
			reporters: ["verbose"],
		},
	},
	resolve: {
		alias: [
			{ find: /^@earendil-works\/chord$/, replacement: chordIndex },
			{ find: /^@earendil-works\/pi-telemetry$/, replacement: telemetryIndex },
			{ find: /^@earendil-works\/pi-agent-core\/session\/testing$/, replacement: agentSessionTesting },
			{ find: /^@earendil-works\/pi-agent-core$/, replacement: agentIndex },
			{ find: /^@earendil-works\/pi-ai$/, replacement: aiIndex },
		],
	},
});
