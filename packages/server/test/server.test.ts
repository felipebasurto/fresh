import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerMessageDecoder } from "@earendil-works/pi-protocol";
import { afterEach, expect, test } from "vitest";
import type { ByteConnection } from "../src/connection.ts";
import { PiServer } from "../src/index.ts";
import type { PiServerListener } from "../src/listener.ts";
import { TestServerHost } from "../src/testing/index.ts";
import { createUnixServer } from "../src/transports/unix/index.ts";

const host = new TestServerHost();

let server: PiServer | undefined;
let tempDirectory: string | undefined;

async function makeSocketPath(): Promise<string> {
	tempDirectory = await mkdtemp(join(tmpdir(), "pss-"));
	return join(tempDirectory, "server.sock");
}

afterEach(async () => {
	await server?.close();
	if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
	server = undefined;
	tempDirectory = undefined;
});

test("requires explicit listeners and a canonical UUIDv4 server identity", () => {
	expect(() => Reflect.construct(PiServer, [host, {}])).toThrow(/listeners/);
	expect(() => new PiServer(host, { listeners: [], serverId: "" })).toThrow(/serverId/);
	expect(() => new PiServer(host, { listeners: [], serverId: "invalid-server" })).toThrow(/serverId/);
});

test("rejects Unix socket paths that cannot fit in sockaddr_un", () => {
	expect(() =>
		createUnixServer(host, { path: `/tmp/${"x".repeat(512)}`, serverId: "00000000-0000-4000-8000-000000000001" }),
	).toThrow(/too long/);
});

test("rejects an overlong derived private Unix bind path", async () => {
	const maxLength = process.platform === "linux" ? 107 : 103;
	const suffixLength = Buffer.byteLength("/tmp//s");
	const path = `/tmp/${"x".repeat(maxLength - suffixLength)}/s`;
	server = createUnixServer(host, { path, serverId: "00000000-0000-4000-8000-000000000001" });

	await expect(server.start()).rejects.toThrow(/private Unix bind path.*too long/);
});

test("rejects concurrent start calls without leaking the Unix listener", async () => {
	const path = await makeSocketPath();
	server = createUnixServer(host, { path, serverId: "00000000-0000-4000-8000-000000000001" });
	const starting = server.start();
	await expect(server.start()).rejects.toThrow(/starting/);
	await starting;
	await server.close();
	await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
});

test("handshake timeout closes with a final hello_error frame", async () => {
	let resolveClosed: (() => void) | undefined;
	const closed = new Promise<void>((resolve) => {
		resolveClosed = resolve;
	});
	class TimedOutConnection implements ByteConnection {
		closed = false;
		finalChunk?: Uint8Array;

		send(): Promise<void> {
			return Promise.reject(new Error("handshake timeout must use the terminal close frame"));
		}

		close(finalChunk?: Uint8Array): void {
			this.finalChunk = finalChunk;
			this.closed = true;
			resolveClosed?.();
		}
	}
	const core = new PiServer(host, {
		listeners: [],
		serverId: "00000000-0000-4000-8000-000000000001",
		maxFrameLength: 1024,
		handshakeTimeoutMs: 10,
	});
	const connection = new TimedOutConnection();
	core.accept(connection);

	await closed;
	expect(connection.closed).toBe(true);
	expect(connection.finalChunk).toBeInstanceOf(Uint8Array);
	const messages = new ServerMessageDecoder().push(connection.finalChunk!);
	expect(messages).toMatchObject([{ type: "hello_error", error: { code: "invalid_request" } }]);
	await core.close();
});

test("rejects timeout values above Node's maximum timer delay", () => {
	const path = "/tmp/pi-server-timeout-test.sock";
	expect(() =>
		createUnixServer(host, {
			path,
			serverId: "00000000-0000-4000-8000-000000000001",
			handshakeTimeoutMs: 2_147_483_648,
		}),
	).toThrow(/handshakeTimeoutMs/);
	expect(() =>
		createUnixServer(host, {
			path,
			serverId: "00000000-0000-4000-8000-000000000001",
			gracefulCloseTimeoutMs: 2_147_483_648,
		}),
	).toThrow(/gracefulCloseTimeoutMs/);
});

test("rejects pending-byte limits smaller than one maximum frame", async () => {
	const path = await makeSocketPath();
	expect(() =>
		createUnixServer(host, {
			path,
			serverId: "00000000-0000-4000-8000-000000000001",
			maxFrameLength: 128,
			maxPendingBytes: 131,
		}),
	).toThrow(/maxPendingBytes/);
});

test("rejects close and closed when listener shutdown fails", async () => {
	const failure = new Error("listener close failed");
	const listener: PiServerListener = {
		start: async () => {},
		close: async () => {
			throw failure;
		},
	};
	const core = new PiServer(host, {
		listeners: [listener],
		serverId: "00000000-0000-4000-8000-000000000001",
	});
	await core.start();

	await expect(core.close()).rejects.toBe(failure);
	await expect(core.closed).rejects.toBe(failure);
});
