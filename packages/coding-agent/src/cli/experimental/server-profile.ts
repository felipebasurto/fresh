import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isServerId, type ServerId } from "@earendil-works/pi-protocol";
import lockfile from "proper-lockfile";

const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 25;
const LOCK_WAIT_MS = 30_000;
const SERVER_ID_FILE = "server-id";

export interface ExperimentalServerProfile {
	readonly serverId: ServerId;
	release(): Promise<void>;
}

/** Lock one experimental server profile and load or create its stable identity. */
export async function acquireExperimentalServerProfile(directory: string): Promise<ExperimentalServerProfile> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const release = await lockfile.lock(directory, {
		realpath: false,
		lockfilePath: join(directory, ".launcher.lock"),
		stale: LOCK_STALE_MS,
		update: LOCK_STALE_MS / 3,
		retries: {
			factor: 1,
			minTimeout: LOCK_RETRY_MS,
			maxTimeout: LOCK_RETRY_MS,
			maxRetryTime: LOCK_WAIT_MS,
		},
	});
	try {
		return { serverId: await loadOrCreateServerId(directory), release };
	} catch (error) {
		try {
			await release();
		} catch (releaseError) {
			throw new AggregateError([error, releaseError], "Server profile loading and lock release failed");
		}
		throw error;
	}
}

async function loadOrCreateServerId(directory: string): Promise<ServerId> {
	const path = join(directory, SERVER_ID_FILE);
	try {
		const value = (await readFile(path, "utf8")).trim();
		if (!isServerId(value)) throw new Error(`Invalid experimental server identity in ${path}`);
		return value;
	} catch (error) {
		if (!isErrorCode(error, "ENOENT")) throw error;
	}

	const serverId = randomUUID();
	await writeFile(path, serverId, { encoding: "utf8", mode: 0o600, flag: "wx" });
	return serverId;
}

function isErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
