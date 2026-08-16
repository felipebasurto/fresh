import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isBunBinary } from "../../config.ts";
import { INTERNAL_PROCESS_ENV, type InternalProcessRole } from "./internal-process.ts";

export interface InternalProcessSpawnOptions {
	readonly entryUrl?: URL;
	readonly env?: NodeJS.ProcessEnv;
}

/** Spawn a detached Pi-owned process consistently across Node and compiled Bun. */
export function spawnInternalProcess(
	role: InternalProcessRole,
	args: readonly string[],
	options: InternalProcessSpawnOptions = {},
): ChildProcess {
	if (isBunBinary && options.entryUrl) {
		throw new Error("A compiled Bun executable cannot launch an external internal-process entrypoint");
	}
	const entryUrl = defaultEntryUrl(role, options.entryUrl);
	const child = spawn(
		process.execPath,
		isBunBinary
			? [...args]
			: [...(entryUrl.pathname.endsWith(".ts") ? ["--import", "tsx"] : []), fileURLToPath(entryUrl), ...args],
		{
			cwd: process.cwd(),
			detached: true,
			env: {
				...process.env,
				...options.env,
				[INTERNAL_PROCESS_ENV]: role,
			},
			stdio: "ignore",
			windowsHide: true,
		},
	);
	child.unref();
	return child;
}

/** Force a spawned internal process to exit and wait until it can no longer take ownership. */
export async function terminateInternalProcess(child: ChildProcess): Promise<void> {
	if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
	const terminated = new Promise<void>((resolve) => {
		child.once("exit", () => resolve());
		child.once("error", () => resolve());
	});
	child.kill("SIGKILL");
	await terminated;
}

function defaultEntryUrl(role: InternalProcessRole, override: URL | undefined): URL {
	if (override) return override;
	const javaScript = import.meta.url.endsWith(".js");
	if (role === "coordinator") {
		return new URL(javaScript ? "coordinator-process-entry.js" : "coordinator-process-entry.ts", import.meta.url);
	}
	if (role === "server") {
		return new URL(javaScript ? "server-process-entry.js" : "server-process-entry.ts", import.meta.url);
	}
	return new URL(javaScript ? "session-worker-process-entry.js" : "session-worker-process-entry.ts", import.meta.url);
}
