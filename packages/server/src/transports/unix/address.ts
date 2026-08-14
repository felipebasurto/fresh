import { join } from "node:path";
import { validateUnixSocketPath } from "./listener.ts";

/** Derive the local Unix socket path for one logical service identity. */
export function getUnixSocketPath(serviceId: string, serverDirectory: string): string {
	if (!/^[0-9a-f]{32}$/.test(serviceId)) {
		throw new TypeError("Unix serviceId must be 32 lowercase hexadecimal characters");
	}
	const path = join(serverDirectory, `${serviceId}.sock`);
	validateUnixSocketPath(path, "PiServer Unix socket path");
	return path;
}
