#!/usr/bin/env node
import { consumeInternalProcessRole } from "./internal-process.ts";
import { runSessionWorkerProcess } from "./session-worker-process.ts";

const role = consumeInternalProcessRole();
if (role !== "session-worker") {
	throw new Error("Session worker entrypoint requires an internal session-worker invocation");
}

void runSessionWorkerProcess(process.argv.slice(2)).catch(() => process.exit(1));
