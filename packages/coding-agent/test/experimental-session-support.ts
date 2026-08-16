import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Entry, type JsonlSessionMetadata, JsonlSessionRepo } from "@earendil-works/pi-agent-core";
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

export async function readExperimentalSessionState(
	sessionsRoot: string,
	sessionId: string,
): Promise<{
	branch: Entry[];
	model: { provider: string; modelId: string } | undefined;
}> {
	const fileSystem = new NodeExecutionEnv({ cwd: process.cwd() });
	const repo = new JsonlSessionRepo({ fileSystem, sessionsRoot });
	let session: Awaited<ReturnType<JsonlSessionRepo["open"]>> | undefined;
	try {
		const matches = (await repo.list()).filter((metadata) => metadata.id === sessionId);
		if (matches.length !== 1) throw new Error(`Expected one Session ${sessionId}, found ${matches.length}`);
		session = await repo.open(matches[0]!);
		const [branch, configuration] = await Promise.all([
			session.findEntriesOnBranch({ order: "oldestFirst" }),
			session.getRegister("lane.config", "main"),
		]);
		return { branch, model: configuration?.value.model };
	} finally {
		await session?.close();
		await repo.close();
		await fileSystem.cleanup();
	}
}
