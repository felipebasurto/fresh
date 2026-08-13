import { encodeClientMessage } from "@earendil-works/pi-protocol";
import { afterEach, expect, test } from "vitest";
import type { ByteConnection, ByteConnectionHandler } from "../src/connection.ts";
import { PiServer } from "../src/server.ts";
import { ProtocolTestClient, TestServerService, type WireChannel } from "../src/testing/index.ts";

let server: PiServer | undefined;

function connect(): ProtocolTestClient {
	server = new PiServer(new TestServerService(), { listeners: [], serviceId: "service-1" });
	let handler: ByteConnectionHandler;
	let client: ProtocolTestClient;
	let closed = false;
	const connection: ByteConnection = {
		get closed() {
			return closed;
		},
		async send(chunk) {
			client.receive(chunk);
		},
		close(finalChunk) {
			if (finalChunk) client.receive(finalChunk);
			closed = true;
			client.markClosed();
		},
	};
	const channel: WireChannel = {
		async send(chunk) {
			handler.onData(chunk);
		},
		async sendFragmented(chunk, splitAt) {
			handler.onData(chunk.subarray(0, splitAt));
			handler.onData(chunk.subarray(splitAt));
		},
		async close() {
			closed = true;
			handler.onClose();
			client.markClosed();
		},
	};
	client = new ProtocolTestClient(channel);
	handler = server.accept(connection);
	return client;
}

afterEach(async () => {
	await server?.close();
	server = undefined;
});

test("requires hello as the first message", async () => {
	const client = connect();
	await client.sendMessage({
		type: "request",
		id: "request-1",
		serviceId: "service-1",
		call: { method: "list", args: [] },
	});
	await expect(client.next((message) => message.type === "hello_error")).resolves.toMatchObject({
		type: "hello_error",
		error: { code: "invalid_request" },
	});
	await client.waitForClose();
});

test("rejects unsupported protocol versions", async () => {
	const client = connect();
	await expect(client.hello(2)).resolves.toMatchObject({ type: "hello_error", error: { code: "version" } });
	await client.waitForClose();
});

test("accepts fragmented hello and request frames", async () => {
	const client = connect();
	const hello = encodeClientMessage({ type: "hello", version: 1 });
	const helloResponse = client.next((message) => message.type === "hello");
	await client.sendFragmentedMessage({ type: "hello", version: 1 }, Math.floor(hello.byteLength / 2));
	await expect(helloResponse).resolves.toMatchObject({ type: "hello", serviceId: "service-1" });

	const response = client.next((message) => message.type === "response");
	const request = {
		type: "request" as const,
		id: "request-1",
		serviceId: "service-1",
		call: { method: "list" as const, args: [] as [] },
	};
	const frame = encodeClientMessage(request);
	await client.sendFragmentedMessage(request, Math.floor(frame.byteLength / 2));
	await expect(response).resolves.toMatchObject({ ok: true, result: [] });
});
