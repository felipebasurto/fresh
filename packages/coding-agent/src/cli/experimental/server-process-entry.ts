#!/usr/bin/env node
import { consumeInternalProcessRole } from "./internal-process.ts";
import { runExperimentalServerProcess } from "./server-process.ts";

const role = consumeInternalProcessRole();
if (role !== "server") throw new Error("Server entrypoint requires an internal server invocation");

void runExperimentalServerProcess(process.argv.slice(2)).catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
