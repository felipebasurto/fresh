import { isAbsolute } from "node:path";
import {
	AgentHarness,
	type AgentHarness as AgentHarnessInstance,
	type JsonlSessionMetadata,
	JsonlSessionRepo,
	type Session,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { ModelRuntime } from "../../core/model-runtime.ts";

// Prototype-only process control. Agent operations will use the shared
// transport-independent protocol rather than additional ad hoc IPC messages.
export type SessionWorkerCommand = { type: "shutdown" };
export type SessionWorkerEvent =
	| { type: "ready"; sessionId: string; pid: number }
	| { type: "failed"; message: string };

function send(event: SessionWorkerEvent): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!process.send) {
			reject(new Error("Session worker requires an IPC channel"));
			return;
		}
		process.send(event, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

function parseMetadata(value: string | undefined): JsonlSessionMetadata {
	if (value === undefined) throw new Error("Session worker requires session metadata");
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (error) {
		throw new Error("Session worker received invalid session metadata", { cause: error });
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Session worker received invalid session metadata");
	}
	const candidate = parsed as Record<string, unknown>;
	if (
		typeof candidate.id !== "string" ||
		candidate.id.length === 0 ||
		!Number.isSafeInteger(candidate.createdAt) ||
		!Number.isSafeInteger(candidate.storageVersion) ||
		typeof candidate.cwd !== "string" ||
		!isAbsolute(candidate.cwd) ||
		typeof candidate.path !== "string" ||
		!isAbsolute(candidate.path) ||
		typeof candidate.modifiedAt !== "number" ||
		!Number.isFinite(candidate.modifiedAt) ||
		(candidate.parentSessionId !== undefined && typeof candidate.parentSessionId !== "string") ||
		(candidate.legacyParentSessionPath !== undefined && typeof candidate.legacyParentSessionPath !== "string")
	) {
		throw new Error("Session worker received invalid session metadata");
	}
	return candidate as unknown as JsonlSessionMetadata;
}

async function closeResources(resources: {
	harness?: AgentHarnessInstance;
	session?: Session<JsonlSessionMetadata>;
	repo: JsonlSessionRepo;
	executionEnv: NodeExecutionEnv;
}): Promise<void> {
	const errors: unknown[] = [];
	try {
		if (resources.harness) await resources.harness.close();
		else await resources.session?.close();
	} catch (error) {
		errors.push(error);
	}
	try {
		await resources.repo.close();
	} catch (error) {
		errors.push(error);
	}
	try {
		await resources.executionEnv.cleanup();
	} catch (error) {
		errors.push(error);
	}
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, "Session worker cleanup failed");
}

async function run(): Promise<void> {
	const sessionDir = process.argv[2];
	if (!sessionDir || !isAbsolute(sessionDir)) throw new Error("Session worker requires an absolute session directory");
	const metadata = parseMetadata(process.argv[3]);
	const sessionId = metadata.id;

	const executionEnv = new NodeExecutionEnv({ cwd: metadata.cwd });
	const repo = new JsonlSessionRepo({ fileSystem: executionEnv, sessionsRoot: sessionDir });
	let session: Session<JsonlSessionMetadata> | undefined;
	let harness: AgentHarnessInstance | undefined;
	try {
		session = await repo.open(metadata);
		const modelRuntime = await ModelRuntime.create();
		const model = modelRuntime.getAvailableSnapshot()[0];
		if (!model) throw new Error("Session worker could not find a configured model");
		({ harness } = await AgentHarness.create({ session, models: modelRuntime, model, tools: [], resources: {} }));
	} catch (error) {
		try {
			await closeResources({ harness, session, repo, executionEnv });
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "Session worker startup and cleanup failed");
		}
		throw error;
	}

	let closing: Promise<void> | undefined;
	const close = (): Promise<void> => {
		closing ??= closeResources({ harness, repo, executionEnv });
		return closing;
	};
	const closeAndExit = (): void => {
		void close().then(
			() => process.exit(0),
			(error: unknown) => {
				console.error(error);
				process.exit(1);
			},
		);
	};

	process.on("message", (message: SessionWorkerCommand) => {
		if (message?.type === "shutdown") closeAndExit();
	});
	process.once("disconnect", closeAndExit);
	process.once("SIGTERM", closeAndExit);
	process.once("SIGINT", closeAndExit);

	try {
		await send({ type: "ready", sessionId, pid: process.pid });
	} catch (error) {
		try {
			await close();
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "Session worker readiness and cleanup failed");
		}
		throw error;
	}
}

void run().catch(async (error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	await send({ type: "failed", message }).catch(() => {});
	process.exit(1);
});
