import { isAbsolute } from "node:path";
import { isServerId } from "@earendil-works/pi-protocol";
import { startExperimentalCoordinatedServer } from "./runtime.ts";

/** Run an automatically activated server until its client and Session demand disappears. */
export async function runExperimentalServerProcess(args: readonly string[]): Promise<void> {
	const [directory, serverId, sessionDir] = args;
	if (!directory || !isAbsolute(directory)) throw new Error("Internal server requires an absolute server directory");
	if (!isServerId(serverId)) throw new Error("Internal server requires a canonical server ID");
	if (!sessionDir || !isAbsolute(sessionDir))
		throw new Error("Internal server requires an absolute Session directory");

	const runtime = await startExperimentalCoordinatedServer({
		directory,
		serverId,
		sessionDir,
		keepAlive: false,
	});
	const close = (): void => {
		void runtime.close().catch(() => {});
	};
	process.once("SIGINT", close);
	process.once("SIGTERM", close);
	try {
		await runtime.closed;
	} finally {
		process.off("SIGINT", close);
		process.off("SIGTERM", close);
		await runtime.close();
	}
}
