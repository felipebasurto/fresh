import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { PiServer } from "../../server/src/server.ts";
import { createUnixListener } from "../../server/src/transports/unix/listener.ts";
import { discoverUnixServices } from "../src/unix.ts";

const tempDirectories = new Set<string>();
const servers = new Set<PiServer>();
const rawServers = new Set<Server>();
const rawSockets = new Set<Socket>();
const children = new Set<ChildProcess>();

async function makeDirectory(): Promise<string> {
	const directory = await mkdtemp(join("/tmp", "pc-"));
	tempDirectories.add(directory);
	return directory;
}

function serviceId(value: number): string {
	return value.toString(16).padStart(32, "0");
}

async function startServer(
	directory: string,
	fileServiceId: string,
	reportedServiceId = fileServiceId,
): Promise<PiServer> {
	const path = join(directory, `${fileServiceId}.sock`);
	const server = new PiServer(
		{
			sessions: { list: async () => [], open: async () => Promise.reject(new Error("unused")) },
			createHarness: async () => Promise.reject(new Error("unused")),
		},
		{ listeners: [createUnixListener({ path })], serviceId: reportedServiceId },
	);
	servers.add(server);
	await server.start();
	return server;
}

async function startSilentSocket(
	path: string,
	connections?: { active: number; maximum: number; total: number },
): Promise<void> {
	const server = createServer((socket) => {
		rawSockets.add(socket);
		if (connections) {
			connections.active += 1;
			connections.maximum = Math.max(connections.maximum, connections.active);
			connections.total += 1;
		}
		socket.once("close", () => {
			rawSockets.delete(socket);
			if (connections) connections.active -= 1;
		});
	});
	rawServers.add(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, resolve);
	});
}

afterEach(async () => {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	await Promise.all([...children].map((child) => (child.exitCode === null ? once(child, "exit") : undefined)));
	children.clear();
	await Promise.all([...servers].map((server) => server.close()));
	servers.clear();
	for (const socket of rawSockets) socket.destroy();
	rawSockets.clear();
	await Promise.all(
		[...rawServers].map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
				}),
		),
	);
	rawServers.clear();
	await Promise.all([...tempDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
	tempDirectories.clear();
});

describe("discoverUnixServices", () => {
	test("returns no routes when the server directory is missing", async () => {
		const directory = join(await makeDirectory(), "missing");
		await expect(discoverUnixServices({ directory })).resolves.toEqual([]);
	});

	test("discovers reachable services in service ID order", async () => {
		const directory = await makeDirectory();
		const first = serviceId(1);
		const second = serviceId(2);
		await startServer(directory, second);
		await startServer(directory, first);

		await expect(discoverUnixServices({ directory })).resolves.toEqual([
			{ serviceId: first, path: join(directory, `${first}.sock`) },
			{ serviceId: second, path: join(directory, `${second}.sock`) },
		]);
	});

	test("ignores malformed entries, non-sockets, and mismatched services", async () => {
		const directory = await makeDirectory();
		await writeFile(join(directory, `${serviceId(1)}.sock`), "not a socket");
		await writeFile(join(directory, "not-a-service.sock"), "ignored");
		await mkdir(join(directory, `${serviceId(2)}.sock`));
		await startServer(directory, serviceId(3), serviceId(4));

		await expect(discoverUnixServices({ directory })).resolves.toEqual([]);
	});

	test("ignores stale sockets without deleting them", async () => {
		const directory = await makeDirectory();
		const id = serviceId(1);
		const path = join(directory, `${id}.sock`);
		const child = fork(new URL("fixtures/stale-socket-server.mjs", import.meta.url), [path], {
			stdio: ["ignore", "ignore", "inherit", "ipc"],
		});
		children.add(child);
		await once(child, "message");
		child.kill("SIGKILL");
		await once(child, "exit");
		children.delete(child);

		await expect(discoverUnixServices({ directory })).resolves.toEqual([]);
		expect((await lstat(path)).isSocket()).toBe(true);
	});

	test("times out an unresponsive socket without deleting it", async () => {
		const directory = await makeDirectory();
		const id = serviceId(1);
		const path = join(directory, `${id}.sock`);
		await startSilentSocket(path);

		await expect(discoverUnixServices({ directory, timeoutMs: 20 })).resolves.toEqual([]);
		expect((await lstat(path)).isSocket()).toBe(true);
	});

	test("limits concurrent probes to 16", async () => {
		const directory = await makeDirectory();
		const connections = { active: 0, maximum: 0, total: 0 };
		for (let index = 1; index <= 20; index++) {
			await startSilentSocket(join(directory, `${serviceId(index)}.sock`), connections);
		}

		const discovery = discoverUnixServices({ directory, timeoutMs: 100 });
		await expect.poll(() => connections.active).toBe(16);
		expect(connections.maximum).toBe(16);
		await expect(discovery).resolves.toEqual([]);
		expect(connections.total).toBe(20);
	});

	test("ignores an endpoint that closes before its handshake", async () => {
		const directory = await makeDirectory();
		const id = serviceId(1);
		const path = join(directory, `${id}.sock`);
		const server = createServer((socket) => socket.destroy());
		rawServers.add(server);
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(path, resolve);
		});

		await expect(discoverUnixServices({ directory })).resolves.toEqual([]);
	});

	test("propagates unexpected filesystem errors", async () => {
		const directory = await makeDirectory();
		const file = join(directory, "not-a-directory");
		await writeFile(file, "content");

		await expect(discoverUnixServices({ directory: file })).rejects.toMatchObject({ code: "ENOTDIR" });
	});
});
