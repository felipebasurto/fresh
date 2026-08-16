import type { JsonlSessionMetadata } from "@earendil-works/pi-agent-core";
import { describe, expect, test } from "vitest";
import type { CoordinatorConnectionEvent } from "../src/cli/experimental/coordinator.ts";
import { SessionWorkerManager } from "../src/cli/experimental/session-worker-manager.ts";

const metadata: JsonlSessionMetadata = {
	id: "session-1",
	createdAt: 1,
	storageVersion: 1,
	cwd: "/tmp",
	path: "/tmp/session-1.jsonl",
	modifiedAt: 1,
};

class FakeCoordinator {
	readonly controlPath = "/tmp/control.sock";
	readonly serverConnectionId = "server-generation-1";
	readonly wasReplaced = false;
	readonly sent: { peerId: string; payload: unknown }[] = [];
	readonly #listeners = new Set<(event: CoordinatorConnectionEvent) => void>();
	onSend?: (peerId: string, payload: Record<string, unknown>) => void;

	onEvent(listener: (event: CoordinatorConnectionEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async send(peerId: string, payload: unknown): Promise<void> {
		this.sent.push({ peerId, payload });
		this.onSend?.(peerId, asObject(payload));
	}

	async broadcast(payload: unknown): Promise<void> {
		if (asObject(payload).type !== "discover_workers") return;
		this.emit({
			type: "message",
			from: "worker-1",
			payload: {
				type: "worker_ready",
				token: "worker-token",
				sessionKey: metadata.path,
				sessionId: metadata.id,
				pid: 123,
				metadata,
			},
		});
	}

	emit(event: CoordinatorConnectionEvent): void {
		for (const listener of this.#listeners) listener(event);
	}
}

async function createAttachedWorker(): Promise<{
	coordinator: FakeCoordinator;
	workers: SessionWorkerManager;
	handle: Awaited<ReturnType<SessionWorkerManager["createHarness"]>>;
	release(): Promise<void>;
}> {
	const coordinator = new FakeCoordinator();
	const workers = new SessionWorkerManager(coordinator, "/tmp");
	await workers.discover(new Set(["worker-1"]));
	const handle = await workers.createHarness(metadata);
	coordinator.onSend = (peerId, payload) => {
		if (payload.type !== "session_demand") return;
		queueMicrotask(() =>
			coordinator.emit({
				type: "message",
				from: peerId,
				payload: {
					type: "demand_applied",
					token: "worker-token",
					sessionKey: metadata.path,
					requestId: payload.requestId,
					attachmentId: payload.attachmentId,
				},
			}),
		);
	};
	const attachment = await handle.attachClient!();
	return { coordinator, workers, handle, release: () => Promise.resolve(attachment.release()) };
}

describe("Session worker operations", () => {
	test("correlates prompt results to the worker generation and attachment", async () => {
		const { coordinator, workers, handle, release } = await createAttachedWorker();
		coordinator.onSend = (peerId, payload) => {
			if (payload.type !== "operation") return;
			const scope = asObject(payload.scope);
			queueMicrotask(() => {
				coordinator.emit({
					type: "message",
					from: peerId,
					payload: {
						type: "operation_response",
						token: "worker-token",
						sessionKey: metadata.path,
						response: {
							type: "operation_result",
							requestId: payload.requestId,
							scope,
							result: {
								ok: true,
								value: { kind: "completed", runId: "run-1", leafId: "leaf-1" },
							},
						},
					},
				});
			});
		};

		await expect(handle.prompt(["Hello"])).resolves.toEqual({
			ok: true,
			value: { kind: "completed", runId: "run-1", leafId: "leaf-1" },
		});
		const operation = coordinator.sent
			.map(({ payload }) => asObject(payload))
			.find(({ type }) => type === "operation");
		expect(operation).toMatchObject({
			scope: { serverConnectionId: "server-generation-1", attachmentId: expect.any(String) },
			call: { method: "prompt", args: [["Hello"]] },
		});
		workers.detach();
		await release();
	});

	test("rejects a correlated response with mismatched worker identity", async () => {
		const { coordinator, workers, handle, release } = await createAttachedWorker();
		coordinator.onSend = (peerId, payload) => {
			if (payload.type !== "operation") return;
			queueMicrotask(() =>
				coordinator.emit({
					type: "message",
					from: peerId,
					payload: {
						type: "operation_response",
						token: "wrong-token",
						sessionKey: metadata.path,
						response: {
							type: "operation_result",
							requestId: payload.requestId,
							scope: payload.scope,
							result: {
								ok: true,
								value: { kind: "completed", runId: "run-1", leafId: "leaf-1" },
							},
						},
					},
				}),
			);
		};

		await expect(handle.prompt(["Hello"])).rejects.toThrow(/mismatched operation response/);
		workers.detach();
		await release();
	});

	test("rejects a null request scope", async () => {
		const { coordinator, workers, handle, release } = await createAttachedWorker();
		coordinator.onSend = (peerId, payload) => {
			if (payload.type !== "operation") return;
			queueMicrotask(() =>
				coordinator.emit({
					type: "message",
					from: peerId,
					payload: {
						type: "operation_response",
						token: "worker-token",
						sessionKey: metadata.path,
						response: {
							type: "operation_result",
							requestId: payload.requestId,
							scope: null,
							result: {
								ok: true,
								value: { kind: "completed", runId: "run-1", leafId: "leaf-1" },
							},
						},
					},
				}),
			);
		};

		await expect(handle.prompt(["Hello"])).rejects.toThrow(/invalid operation response/);
		workers.detach();
		await release();
	});

	test("rejects pending prompts on replacement without stopping the worker", async () => {
		const { coordinator, workers, handle } = await createAttachedWorker();
		coordinator.onSend = () => {};
		const prompting = handle.prompt(["Hello"]);
		workers.detach();

		await expect(prompting).rejects.toThrow(/replaced during a worker operation/);
		expect(coordinator.sent.map(({ payload }) => asObject(payload).type)).not.toContain("shutdown");
		expect(workers.workerPids.size).toBe(0);
	});
});

function asObject(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Expected object");
	return value as Record<string, unknown>;
}
