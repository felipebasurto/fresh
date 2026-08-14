import { expect, test, vi } from "vitest";
import { requestServerDrain, ServerControlTimeoutError } from "../src/control.ts";
import { MemoryByteServer } from "./support.ts";

test("launcher control resolves after the drain acknowledgement", async () => {
	const server = new MemoryByteServer();
	const draining = requestServerDrain({
		serviceId: "00000000000000000000000000000001",
		transportFactory: (handlers) => server.connect(handlers),
	});
	await server.waitForMessages(2);
	expect(server.messages[1]).toEqual({
		type: "request",
		id: "control-1",
		serviceId: "00000000000000000000000000000001",
		call: { method: "drain", args: [] },
	});

	server.send({
		type: "response",
		id: "control-1",
		ok: true,
		result: {},
	});
	await expect(draining).resolves.toBeUndefined();
	expect(server.clientCloseCount).toBe(1);
});

test("fails a control request that does not complete within its total timeout", async () => {
	vi.useFakeTimers();
	try {
		const server = new MemoryByteServer();
		const draining = requestServerDrain({
			serviceId: "00000000000000000000000000000001",
			transportFactory: (handlers) => server.connect(handlers),
			timeoutMs: 25,
		});
		await server.waitForMessages(2);
		const observed = draining.then(
			() => undefined,
			(error: unknown) => error,
		);

		await vi.advanceTimersByTimeAsync(25);
		const thrown = await observed;
		expect(thrown).toBeInstanceOf(ServerControlTimeoutError);
		expect(thrown).toMatchObject({ timeoutMs: 25 });
		expect(server.clientCloseCount).toBe(1);
	} finally {
		vi.useRealTimers();
	}
});

test("validates the control timeout", async () => {
	const server = new MemoryByteServer();
	await expect(
		requestServerDrain({
			serviceId: "00000000000000000000000000000001",
			transportFactory: (handlers) => server.connect(handlers),
			timeoutMs: 0,
		}),
	).rejects.toThrow(/timeoutMs/);
});
