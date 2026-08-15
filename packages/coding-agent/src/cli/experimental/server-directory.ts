import { chmod, lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolvePath } from "../../utils/paths.ts";

export const ENV_SERVER_DIR = "PI_SERVER_DIR";

export function resolveExperimentalServerDirectory(directory?: string): string {
	return resolvePath(directory ?? process.env[ENV_SERVER_DIR] ?? join(homedir(), ".pi", "server"));
}

export async function ensurePrivateServerDirectory(directory: string): Promise<void> {
	if (typeof process.getuid !== "function") throw new Error("Unix socket directory requires a POSIX user ID");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const stats = await lstat(directory);
	if (!stats.isDirectory()) throw new Error(`Unix socket directory is not a directory: ${directory}`);
	if (stats.uid !== process.getuid()) {
		throw new Error(`Unix socket directory is not owned by the current user: ${directory}`);
	}
	await chmod(directory, 0o700);
}
