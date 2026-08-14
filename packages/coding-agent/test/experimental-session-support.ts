import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type JsonlSessionMetadata, JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

export async function createExperimentalSessions(
	sessionsRoot: string,
	ids: readonly string[],
	cwd = process.cwd(),
): Promise<JsonlSessionMetadata[]> {
	const fileSystem = new NodeExecutionEnv({ cwd });
	const repo = new JsonlSessionRepo({ fileSystem, sessionsRoot });
	const metadata: JsonlSessionMetadata[] = [];
	try {
		for (const id of ids) {
			const session = await repo.create({ id, cwd });
			metadata.push(session.metadata);
			await session.close();
		}
		return metadata;
	} finally {
		await repo.close();
		await fileSystem.cleanup();
	}
}

export async function configureExperimentalWorkerModel(agentDir: string): Promise<void> {
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "test-key" } }), {
		mode: 0o600,
	});
}
