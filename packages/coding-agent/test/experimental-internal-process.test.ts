import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { spawnInternalProcess } from "../src/cli/experimental/internal-process-launcher.ts";

const children = new Set<ChildProcess>();
const directories = new Set<string>();

afterEach(async () => {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = once(child, "exit");
			child.kill("SIGTERM");
			await exited;
		}
	}
	children.clear();
	await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })));
	directories.clear();
});

describe.skipIf(process.platform === "win32")("experimental internal process launcher", () => {
	test("starts the coordinator with the native runtime", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-internal-process-"));
		directories.add(directory);
		const publicPath = join(directory, "public.sock");
		const controlPath = join(directory, "control.sock");
		const child = spawnInternalProcess("coordinator", [publicPath, controlPath]);
		children.add(child);

		await expect.poll(() => canConnect(controlPath)).toBe(true);
		expect(child.pid).not.toBe(process.pid);
	});
});

function canConnect(path: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection(path);
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});
}
