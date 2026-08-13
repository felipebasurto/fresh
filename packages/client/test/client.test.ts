import { ProtocolValidationError } from "@earendil-works/pi-protocol";
import { describe, expect, test, vi } from "vitest";
import { PiClient, PiClientDisposedError, PiDisconnectedError } from "../src/index.ts";
import { MemoryByteServer } from "./support.ts";

async function connectClient(
	server: MemoryByteServer,
	serviceId = "00000000000000000000000000000001",
): Promise<PiClient> {
	return PiClient.connect({ serviceId, transportFactory: (handlers) => server.connect(handlers) });
}

test("requires a 128-bit service identity", () => {
	expect(() => new PiClient({ serviceId: "invalid-service", transportFactory: () => Promise.reject() })).toThrow(
		/serviceId/,
	);
});

describe("PiClient list and attach", () => {
	test("connects only to the expected logical service", async () => {
		const matching = new MemoryByteServer();
		const client = await connectClient(matching);
		expect(client.hello).toMatchObject({
			serviceId: "00000000000000000000000000000001",
			connectionId: "connection-1",
		});
		await client.dispose();

		const wrong = new MemoryByteServer("00000000000000000000000000000002");
		await expect(connectClient(wrong)).rejects.toBeInstanceOf(ProtocolValidationError);
	});

	test("addresses list and attach requests to the configured service", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const listing = client.listSessions();
		await vi.waitFor(() => expect(server.messages).toHaveLength(2));
		expect(server.messages[1]).toEqual({
			type: "request",
			id: "request-1",
			serviceId: "00000000000000000000000000000001",
			call: { method: "list", args: [] },
		});
		server.send({
			type: "response",
			id: "request-1",
			ok: true,
			result: [{ id: "session-1", createdAt: 1, storageVersion: 1 }],
		});
		await expect(listing).resolves.toEqual([{ id: "session-1", createdAt: 1, storageVersion: 1 }]);

		const attaching = client.attachSession("session-1");
		await vi.waitFor(() => expect(server.messages).toHaveLength(3));
		expect(server.messages[2]).toMatchObject({
			type: "request",
			serviceId: "00000000000000000000000000000001",
			call: { method: "attach", args: ["session-1"] },
		});
		server.send({
			type: "response",
			id: "request-2",
			ok: true,
			result: { sessionId: "session-1" },
		});
		await expect(attaching).resolves.toEqual({ sessionId: "session-1" });
		await client.dispose();
	});

	test("correlates out-of-order responses", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const first = client.listSessions();
		const second = client.attachSession("session-1");
		await vi.waitFor(() => expect(server.messages).toHaveLength(3));
		server.send({
			type: "response",
			id: "request-2",
			ok: true,
			result: { sessionId: "session-1" },
		});
		server.send({
			type: "response",
			id: "request-1",
			ok: true,
			result: [],
		});
		await expect(Promise.all([first, second])).resolves.toEqual([[], { sessionId: "session-1" }]);
		await client.dispose();
	});

	test("exposes bounded server errors", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const attaching = client.attachSession("missing");
		await vi.waitFor(() => expect(server.messages).toHaveLength(2));
		server.send({
			type: "response",
			id: "request-1",
			ok: false,
			error: { code: "session_not_found", message: "Unknown session" },
		});
		await expect(attaching).rejects.toMatchObject({ code: "session_not_found" });
		await client.dispose();
	});

	test("rejects pending requests after disconnect or disposal", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const listing = client.listSessions();
		server.disconnect();
		await expect(listing).rejects.toBeInstanceOf(PiDisconnectedError);
		await client.dispose();
		await expect(client.listSessions()).rejects.toBeInstanceOf(PiClientDisposedError);
	});
});
