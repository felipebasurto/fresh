import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isServiceId, type ServiceId } from "@earendil-works/pi-protocol";
import { generateServiceId } from "@earendil-works/pi-server";
import lockfile from "proper-lockfile";

const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 25;
const LOCK_WAIT_MS = 30_000;
const SERVICE_ID_FILE = "service-id";

export interface ExperimentalServiceProfile {
	readonly serviceId: ServiceId;
	release(): Promise<void>;
}

/** Lock one experimental service directory and load or create its stable identity. */
export async function acquireExperimentalServiceProfile(directory: string): Promise<ExperimentalServiceProfile> {
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
		return { serviceId: await loadOrCreateServiceId(directory), release };
	} catch (error) {
		try {
			await release();
		} catch (releaseError) {
			throw new AggregateError([error, releaseError], "Service profile loading and lock release failed");
		}
		throw error;
	}
}

async function loadOrCreateServiceId(directory: string): Promise<ServiceId> {
	const path = join(directory, SERVICE_ID_FILE);
	try {
		const value = (await readFile(path, "utf8")).trim();
		if (!isServiceId(value)) throw new Error(`Invalid experimental service identity in ${path}`);
		return value;
	} catch (error) {
		if (!isErrorCode(error, "ENOENT")) throw error;
	}

	const serviceId = generateServiceId();
	await writeFile(path, serviceId, { encoding: "utf8", mode: 0o600, flag: "wx" });
	return serviceId;
}

function isErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
