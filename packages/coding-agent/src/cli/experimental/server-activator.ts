import { join } from "node:path";
import { PiClient, PiDisconnectedError, PiServerError } from "@earendil-works/pi-client";
import { createUnixTransportFactory, type UnixServerRoute } from "@earendil-works/pi-client/unix";
import type { ServerId } from "@earendil-works/pi-protocol";
import { getUnixSocketPath } from "@earendil-works/pi-server/unix";
import lockfile from "proper-lockfile";
import { spawnInternalProcess, terminateInternalProcess } from "./internal-process-launcher.ts";
import { ensurePrivateServerDirectory } from "./server-directory.ts";
import { acquireExperimentalServerProfile } from "./server-profile.ts";

const ACTIVATION_TIMEOUT_MS = 10_000;
const ACTIVATION_RETRY_MS = 10;

export interface ActivatedExperimentalServer {
	readonly client: PiClient;
	readonly route: UnixServerRoute;
}

export interface ActivateExperimentalServerOptions {
	readonly directory: string;
	readonly requestedServerId?: ServerId | string;
	readonly sessionDir: string;
}

/** Ensure the selected logical server is reachable, launching the current Pi installation if needed. */
export async function activateExperimentalServer(
	options: ActivateExperimentalServerOptions,
): Promise<ActivatedExperimentalServer> {
	await ensurePrivateServerDirectory(options.directory);
	const profile = await acquireExperimentalServerProfile(options.directory, options.requestedServerId);
	const serverId = profile.serverId;
	await profile.release();
	const route = { serverId, path: getUnixSocketPath(serverId, options.directory) };
	const release = await acquireExperimentalServerActivation(options.directory, serverId);
	try {
		const existing = await connect(route);
		if (existing) return { client: existing, route };
		const child = spawnInternalProcess("server", [options.directory, serverId, options.sessionDir]);
		let spawnError: Error | undefined;
		child.once("error", (error) => {
			spawnError = error;
		});
		try {
			const deadline = Date.now() + ACTIVATION_TIMEOUT_MS;
			while (true) {
				const client = await connect(route);
				if (client) return { client, route };
				if (spawnError) throw new Error("Failed to automatically activate Pi server", { cause: spawnError });
				if (child.exitCode !== null || child.signalCode !== null) {
					throw new Error("Automatically activated Pi server exited during startup");
				}
				if (Date.now() >= deadline) throw new Error("Timed out waiting for automatically activated Pi server");
				await new Promise<void>((resolve) => setTimeout(resolve, ACTIVATION_RETRY_MS));
			}
		} catch (error) {
			await terminateInternalProcess(child);
			throw error;
		}
	} finally {
		await release();
	}
}

export function acquireExperimentalServerActivation(
	directory: string,
	serverId: ServerId,
): Promise<() => Promise<void>> {
	return lockfile.lock(join(directory, `activation-${serverId}`), {
		realpath: false,
		stale: ACTIVATION_TIMEOUT_MS * 2,
		update: ACTIVATION_TIMEOUT_MS,
		retries: {
			retries: Math.ceil(ACTIVATION_TIMEOUT_MS / 25),
			factor: 1,
			minTimeout: 25,
			maxTimeout: 25,
			maxRetryTime: ACTIVATION_TIMEOUT_MS,
		},
	});
}

async function connect(route: UnixServerRoute): Promise<PiClient | undefined> {
	const client = new PiClient({
		serverId: route.serverId,
		transportFactory: createUnixTransportFactory({ path: route.path }),
	});
	try {
		await client.connect();
		return client;
	} catch (error) {
		await client.dispose();
		if (error instanceof PiDisconnectedError || (error instanceof PiServerError && error.code === "version")) {
			return undefined;
		}
		let current = error;
		const seen = new Set<unknown>();
		while (current instanceof Error && !seen.has(current)) {
			seen.add(current);
			if (
				"code" in current &&
				["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT"].includes(String(current.code))
			) {
				return undefined;
			}
			current = current.cause;
		}
		throw error;
	}
}
