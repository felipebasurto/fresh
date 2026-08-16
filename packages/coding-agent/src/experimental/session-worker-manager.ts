import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { JsonlSessionMetadata } from "@earendil-works/pi-agent-core";
import { createRpcClient } from "@earendil-works/pi-protocol";
import type { HostedHarnessAttachment, HostedHarnessHandle } from "@earendil-works/pi-server";
import { Check } from "typebox/value";
import type { CoordinatorConnection, CoordinatorConnectionEvent } from "./coordinator.ts";
import { spawnInternalProcess } from "./process.ts";
import {
	SESSION_WORKER_CONTROL_ADDRESS_ENV,
	SESSION_WORKER_CONTROL_TOKEN_ENV,
	SESSION_WORKER_PEER_ID_ENV,
	SESSION_WORKER_SESSION_KEY_ENV,
	type SessionWorkerEvent,
	SessionWorkerEventSchema,
	type SessionWorkerOperationCall,
	SessionWorkerOperations,
	type WorkerOperationResponse,
	type WorkerOperationScope,
} from "./session-worker.ts";

const WORKER_STARTUP_TIMEOUT_MS = 15_000;
const WORKER_SHUTDOWN_TIMEOUT_MS = 10_000;
const WORKER_DISCOVERY_TIMEOUT_MS = 5_000;
const WORKER_DEMAND_TIMEOUT_MS = 5_000;

interface WorkerRecord {
	readonly peerId: string;
	readonly metadata: JsonlSessionMetadata;
	readonly pid: number;
	readonly token: string;
	readonly terminated: Promise<Error | undefined>;
	resolveTerminated(error: Error | undefined): void;
	attachmentId?: string;
	expectedStop: boolean;
	stopping: boolean;
}

interface PendingDemand {
	readonly attachmentId: string | null;
	readonly requestId: string;
	readonly timer: NodeJS.Timeout;
	readonly worker: WorkerRecord;
	resolve(): void;
	reject(error: Error): void;
}

interface PendingWorkerOperation {
	readonly worker: WorkerRecord;
	readonly scope: WorkerOperationScope;
	resolve(result: unknown): void;
	reject(error: Error): void;
}

interface PendingLaunch {
	readonly sessionKey: string;
	readonly peerId: string;
	readonly token: string;
	readonly child: ChildProcess;
	readonly timer: NodeJS.Timeout;
	readonly promise: Promise<WorkerRecord>;
	resolve(worker: WorkerRecord): void;
	reject(error: Error): void;
}

/** Session and process bookkeeping owned by one replaceable Pi server process. */
export class SessionWorkerManager {
	readonly workerPids = new Map<string, number>();
	readonly #coordinator: Pick<
		CoordinatorConnection,
		"controlPath" | "serverConnectionId" | "wasReplaced" | "onEvent" | "send" | "broadcast"
	>;
	readonly #sessionDir: string;
	readonly #workersBySession = new Map<string, WorkerRecord>();
	readonly #workersByPeer = new Map<string, WorkerRecord>();
	readonly #pending = new Map<string, PendingLaunch>();
	readonly #pendingDemand = new Map<string, PendingDemand>();
	readonly #pendingOperations = new Map<string, PendingWorkerOperation>();
	readonly #removeListener: () => void;
	readonly #onWorkerCountChanged: ((count: number) => void) | undefined;
	#discoveryPeers?: Set<string>;
	#resolveDiscovery?: () => void;
	#detached = false;
	#shuttingDown = false;

	constructor(
		coordinator: Pick<
			CoordinatorConnection,
			"controlPath" | "serverConnectionId" | "wasReplaced" | "onEvent" | "send" | "broadcast"
		>,
		sessionDir: string,
		onWorkerCountChanged?: (count: number) => void,
	) {
		this.#coordinator = coordinator;
		this.#sessionDir = sessionDir;
		this.#onWorkerCountChanged = onWorkerCountChanged;
		this.#removeListener = coordinator.onEvent((event) => this.#handleCoordinatorEvent(event));
	}

	get trackedSessions(): readonly JsonlSessionMetadata[] {
		return [...this.#workersBySession.values()].map((worker) => worker.metadata);
	}

	async discover(peerIds: ReadonlySet<string>): Promise<void> {
		if (this.#detached) return;
		const undiscovered = new Set(
			[...peerIds].filter((peerId) => !this.#workersByPeer.has(peerId) && !this.#pendingPeer(peerId)),
		);
		if (undiscovered.size === 0) return;
		this.#discoveryPeers = undiscovered;
		const discovered = new Promise<void>((resolve) => {
			this.#resolveDiscovery = resolve;
		});
		await this.#coordinator.broadcast({ type: "discover_workers" });
		let timer: NodeJS.Timeout | undefined;
		await Promise.race([
			discovered,
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, WORKER_DISCOVERY_TIMEOUT_MS);
				timer.unref();
			}),
		]);
		if (timer) clearTimeout(timer);
		this.#discoveryPeers = undefined;
		this.#resolveDiscovery = undefined;
	}

	async createHarness(metadata: JsonlSessionMetadata): Promise<HostedHarnessHandle> {
		if (this.#detached || this.#shuttingDown) throw new Error("Experimental server is shutting down");
		const existing = this.#workersBySession.get(metadata.path);
		if (existing) return this.#hostedHandle(existing);
		const pending = this.#pending.get(metadata.path);
		if (pending) return this.#hostedHandle(await pending.promise);
		return this.#hostedHandle(await this.#launch(metadata));
	}

	#hostedHandle(worker: WorkerRecord): HostedHarnessHandle {
		const operations = createRpcClient(SessionWorkerOperations, (call) => this.#invoke(worker, call));
		return {
			terminated: worker.terminated,
			attachClient: () => this.#attachClient(worker),
			prompt: (prompt) => operations.prompt(prompt),
			close: () => this.#stopWorker(worker),
		};
	}

	async #attachClient(worker: WorkerRecord): Promise<HostedHarnessAttachment> {
		if (this.#detached || this.#shuttingDown || worker.stopping) {
			throw new Error("Experimental Session worker is stopping");
		}
		if (this.#workersByPeer.get(worker.peerId) !== worker) {
			throw new Error("Experimental Session worker is no longer available");
		}
		if (worker.attachmentId !== undefined) throw new Error("Experimental Session is already attached");
		const attachmentId = randomUUID();
		worker.attachmentId = attachmentId;
		try {
			await this.#applyDemand(worker, attachmentId);
		} catch (error) {
			if (worker.attachmentId === attachmentId) worker.attachmentId = undefined;
			throw error;
		}
		let released = false;
		return {
			release: async () => {
				if (released) return;
				released = true;
				if (this.#detached || worker.attachmentId !== attachmentId) return;
				try {
					await this.#applyDemand(worker, null);
				} catch (error) {
					if (!this.#detached && !this.#coordinator.wasReplaced) throw error;
				} finally {
					if (worker.attachmentId === attachmentId) worker.attachmentId = undefined;
				}
			},
		};
	}

	async #applyDemand(worker: WorkerRecord, attachmentId: string | null): Promise<void> {
		if (worker.stopping || this.#workersByPeer.get(worker.peerId) !== worker) {
			throw new Error("Experimental Session worker is stopping");
		}
		const requestId = randomUUID();
		let resolve!: () => void;
		let reject!: (error: Error) => void;
		const applied = new Promise<void>((resolvePromise, rejectPromise) => {
			resolve = resolvePromise;
			reject = rejectPromise;
		});
		const timer = setTimeout(
			() => this.#rejectDemand(requestId, new Error("Session worker demand update timed out")),
			WORKER_DEMAND_TIMEOUT_MS,
		);
		timer.unref();
		const pending = { attachmentId, requestId, timer, worker, resolve, reject };
		this.#pendingDemand.set(requestId, pending);
		try {
			await this.#coordinator.send(worker.peerId, {
				type: "session_demand",
				serverConnectionId: this.#coordinator.serverConnectionId,
				requestId,
				attachmentId,
			});
		} catch (error) {
			this.#rejectDemand(requestId, error instanceof Error ? error : new Error(String(error)));
		}
		return applied;
	}

	/** Worker operations have no wall-clock timeout: completion, disconnect, replacement, or shutdown settles them. */
	#invoke(worker: WorkerRecord, call: SessionWorkerOperationCall): Promise<unknown> {
		if (this.#detached || this.#shuttingDown || worker.stopping) {
			return Promise.reject(new Error("Experimental Session worker is stopping"));
		}
		if (this.#workersByPeer.get(worker.peerId) !== worker || worker.attachmentId === undefined) {
			return Promise.reject(new Error("Experimental Session worker has no active attachment"));
		}
		const requestId = randomUUID();
		const scope: WorkerOperationScope = {
			serverConnectionId: this.#coordinator.serverConnectionId,
			attachmentId: worker.attachmentId,
		};
		let resolve!: (result: unknown) => void;
		let reject!: (error: Error) => void;
		const result = new Promise<unknown>((resolvePromise, rejectPromise) => {
			resolve = resolvePromise;
			reject = rejectPromise;
		});
		this.#pendingOperations.set(requestId, { worker, scope, resolve, reject });
		void this.#coordinator
			.send(worker.peerId, { type: "operation", requestId, scope, call })
			.catch((error: unknown) =>
				this.#rejectOperation(requestId, error instanceof Error ? error : new Error(String(error))),
			);
		return result;
	}

	async #stopWorker(worker: WorkerRecord): Promise<void> {
		if (this.#detached || this.#workersByPeer.get(worker.peerId) !== worker) return;
		this.#rejectWorkerOperations(worker, new Error("Session worker is stopping"));
		if (!worker.stopping) {
			worker.stopping = true;
			worker.expectedStop = true;
			await this.#coordinator.send(worker.peerId, { type: "shutdown" }).catch(() => {});
		}
		await worker.terminated;
	}

	async shutdown(): Promise<void> {
		if (this.#detached || this.#shuttingDown) return;
		this.#shuttingDown = true;
		for (const pending of this.#pending.values()) {
			void this.#coordinator.send(pending.peerId, { type: "shutdown" }).catch(() => {});
		}
		const workers = [...this.#workersBySession.values()];
		for (const worker of workers) {
			worker.expectedStop = true;
			worker.stopping = true;
			void this.#coordinator.send(worker.peerId, { type: "shutdown" }).catch(() => {});
		}
		const finished = Promise.all([
			...workers.map((worker) => worker.terminated),
			...[...this.#pending.values()].map((pending) => {
				if (pending.child.exitCode !== null || pending.child.signalCode !== null) return Promise.resolve();
				return new Promise<void>((resolve) => pending.child.once("exit", () => resolve()));
			}),
		]).then(() => undefined);
		let timer: NodeJS.Timeout | undefined;
		const timedOut = new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(true), WORKER_SHUTDOWN_TIMEOUT_MS);
			timer.unref();
		});
		if ((await Promise.race([finished.then(() => false), timedOut])) === true) {
			for (const worker of workers) {
				try {
					process.kill(worker.pid, "SIGKILL");
				} catch (error) {
					if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
				}
			}
			for (const pending of this.#pending.values()) pending.child.kill("SIGKILL");
			await finished;
		}
		if (timer) clearTimeout(timer);
		this.#detachState();
	}

	/** Forget workers without stopping them when this server is replaced. */
	detach(): void {
		if (this.#detached) return;
		this.#detached = true;
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Experimental server was replaced"));
		}
		for (const requestId of [...this.#pendingOperations.keys()]) {
			this.#rejectOperation(requestId, new Error("Experimental server was replaced during a worker operation"));
		}
		this.#detachState();
	}

	#launch(metadata: JsonlSessionMetadata): Promise<WorkerRecord> {
		const sessionKey = metadata.path;
		const peerId = `worker-${randomUUID()}`;
		const token = randomUUID();
		let child: ChildProcess;
		try {
			child = spawnInternalProcess("session-worker", [this.#sessionDir, JSON.stringify(metadata)], {
				env: {
					[SESSION_WORKER_CONTROL_ADDRESS_ENV]: this.#coordinator.controlPath,
					[SESSION_WORKER_CONTROL_TOKEN_ENV]: token,
					[SESSION_WORKER_SESSION_KEY_ENV]: Buffer.from(sessionKey).toString("base64url"),
					[SESSION_WORKER_PEER_ID_ENV]: peerId,
				},
			});
		} catch (error) {
			return Promise.reject(error);
		}
		let resolve!: (worker: WorkerRecord) => void;
		let reject!: (error: Error) => void;
		const promise = new Promise<WorkerRecord>((resolvePromise, rejectPromise) => {
			resolve = resolvePromise;
			reject = rejectPromise;
		});
		const timer = setTimeout(
			() => this.#failPending(sessionKey, new Error("Session worker startup timed out")),
			WORKER_STARTUP_TIMEOUT_MS,
		);
		timer.unref();
		const pending = { sessionKey, peerId, token, child, timer, promise, resolve, reject };
		this.#pending.set(sessionKey, pending);
		this.#notifyWorkerCountChanged();
		child.once("error", (error) => this.#failPending(sessionKey, error));
		child.once("exit", (code, signal) => this.#childExited(pending, code, signal));
		return promise;
	}

	#handleCoordinatorEvent(event: CoordinatorConnectionEvent): void {
		if (this.#detached) return;
		if (event.type === "peer_disconnected") {
			this.#markDiscovered(event.peerId);
			const worker = this.#workersByPeer.get(event.peerId);
			if (worker) {
				this.#removeWorker(
					worker,
					worker.expectedStop
						? undefined
						: new Error(`Session worker ${worker.metadata.id} disconnected unexpectedly`),
				);
			}
			const pending = this.#pendingPeer(event.peerId);
			if (pending) this.#failPending(pending.sessionKey, new Error("Session worker disconnected during startup"));
			return;
		}
		if (event.type !== "message") return;
		if (!Check(SessionWorkerEventSchema, event.payload)) {
			if (
				typeof event.payload === "object" &&
				event.payload !== null &&
				"type" in event.payload &&
				event.payload.type === "operation_response"
			) {
				const worker = this.#workersByPeer.get(event.from);
				if (worker)
					this.#rejectWorkerOperations(worker, new Error("Session worker returned an invalid operation response"));
			}
			return;
		}
		const message: SessionWorkerEvent = event.payload;
		if (message.type === "worker_failed") {
			const pending = this.#pending.get(message.sessionKey);
			if (pending?.peerId === event.from && pending.token === message.token) {
				this.#failPending(message.sessionKey, new Error(`Session worker failed: ${message.message}`));
			}
			return;
		}
		if (message.type === "demand_applied" || message.type === "demand_rejected") {
			const pending = this.#pendingDemand.get(message.requestId);
			if (
				!pending ||
				pending.worker.peerId !== event.from ||
				pending.worker.token !== message.token ||
				pending.worker.metadata.path !== message.sessionKey ||
				(message.type === "demand_applied" && pending.attachmentId !== message.attachmentId)
			) {
				return;
			}
			this.#pendingDemand.delete(message.requestId);
			clearTimeout(pending.timer);
			if (message.type === "demand_applied") pending.resolve();
			else pending.reject(new Error(`Session worker rejected demand: ${message.message}`));
			return;
		}
		if (message.type === "operation_response") {
			this.#handleOperationResponse(event.from, message.token, message.sessionKey, message.response);
			return;
		}
		this.#recordReadyWorker(event.from, message);
	}

	#handleOperationResponse(
		peerId: string,
		token: string,
		sessionKey: string,
		response: WorkerOperationResponse,
	): void {
		const pending = this.#pendingOperations.get(response.requestId);
		if (!pending) return;
		if (
			pending.worker.peerId !== peerId ||
			pending.worker.token !== token ||
			pending.worker.metadata.path !== sessionKey ||
			response.scope.serverConnectionId !== pending.scope.serverConnectionId ||
			response.scope.attachmentId !== pending.scope.attachmentId
		) {
			this.#rejectOperation(
				response.requestId,
				new Error("Session worker returned a mismatched operation response"),
			);
			return;
		}
		this.#pendingOperations.delete(response.requestId);
		if (response.type === "operation_error") {
			pending.reject(new Error(`Session worker operation failed: ${response.message}`));
		} else {
			pending.resolve(response.result);
		}
	}

	#recordReadyWorker(peerId: string, message: Extract<SessionWorkerEvent, { type: "worker_ready" }>): void {
		if (
			message.sessionKey !== message.metadata.path ||
			message.sessionId !== message.metadata.id ||
			!isAbsolute(message.metadata.cwd) ||
			!isAbsolute(message.metadata.path)
		) {
			return;
		}
		this.#markDiscovered(peerId);
		const existing = this.#workersBySession.get(message.sessionKey);
		if (existing && existing.peerId !== peerId) {
			void this.#coordinator.send(peerId, { type: "shutdown" }).catch(() => {});
			return;
		}
		const pending = this.#pending.get(message.sessionKey);
		if (
			pending &&
			(pending.peerId !== peerId || pending.token !== message.token || pending.child.pid !== message.pid)
		) {
			return;
		}
		if (existing) return;
		let resolveTerminated!: (error: Error | undefined) => void;
		const terminated = new Promise<Error | undefined>((resolve) => {
			resolveTerminated = resolve;
		});
		const worker: WorkerRecord = {
			peerId,
			metadata: message.metadata,
			pid: message.pid,
			token: message.token,
			terminated,
			resolveTerminated,
			expectedStop: false,
			stopping: false,
		};
		this.#workersBySession.set(message.sessionKey, worker);
		this.#workersByPeer.set(peerId, worker);
		this.workerPids.set(message.sessionId, message.pid);
		if (pending) {
			this.#pending.delete(message.sessionKey);
			clearTimeout(pending.timer);
			pending.resolve(worker);
		}
		this.#notifyWorkerCountChanged();
	}

	#childExited(pending: PendingLaunch, code: number | null, signal: NodeJS.Signals | null): void {
		if (this.#pending.get(pending.sessionKey) === pending) {
			this.#failPending(
				pending.sessionKey,
				new Error(`Session worker exited before readiness (${signal ?? code ?? "unknown"})`),
			);
			return;
		}
		const worker = this.#workersByPeer.get(pending.peerId);
		if (worker) {
			this.#removeWorker(
				worker,
				worker.expectedStop
					? undefined
					: new Error(`Session worker ${worker.metadata.id} exited unexpectedly (${signal ?? code ?? "unknown"})`),
			);
		}
	}

	#failPending(sessionKey: string, error: Error): void {
		const pending = this.#pending.get(sessionKey);
		if (!pending) return;
		this.#pending.delete(sessionKey);
		clearTimeout(pending.timer);
		this.#notifyWorkerCountChanged();
		if (pending.child.exitCode === null && pending.child.signalCode === null) pending.child.kill("SIGKILL");
		pending.reject(error);
	}

	#rejectDemand(requestId: string, error: Error): void {
		const pending = this.#pendingDemand.get(requestId);
		if (!pending) return;
		this.#pendingDemand.delete(requestId);
		clearTimeout(pending.timer);
		pending.reject(error);
	}

	#rejectOperation(requestId: string, error: Error): void {
		const pending = this.#pendingOperations.get(requestId);
		if (!pending) return;
		this.#pendingOperations.delete(requestId);
		pending.reject(error);
	}

	#rejectWorkerOperations(worker: WorkerRecord, error: Error): void {
		for (const [requestId, pending] of this.#pendingOperations) {
			if (pending.worker === worker) this.#rejectOperation(requestId, error);
		}
	}

	#removeWorker(worker: WorkerRecord, error: Error | undefined): void {
		if (this.#workersByPeer.get(worker.peerId) !== worker) return;
		this.#rejectWorkerOperations(worker, new Error("Session worker disconnected during an operation"));
		for (const pending of [...this.#pendingDemand.values()]) {
			if (pending.worker === worker) {
				this.#rejectDemand(pending.requestId, new Error("Session worker disconnected during demand update"));
			}
		}
		this.#workersByPeer.delete(worker.peerId);
		this.#workersBySession.delete(worker.metadata.path);
		if (this.workerPids.get(worker.metadata.id) === worker.pid) this.workerPids.delete(worker.metadata.id);
		worker.resolveTerminated(error);
		this.#notifyWorkerCountChanged();
	}

	#notifyWorkerCountChanged(): void {
		this.#onWorkerCountChanged?.(this.#workersBySession.size + this.#pending.size);
	}

	#pendingPeer(peerId: string): PendingLaunch | undefined {
		return [...this.#pending.values()].find((pending) => pending.peerId === peerId);
	}

	#markDiscovered(peerId: string): void {
		if (!this.#discoveryPeers?.delete(peerId) || this.#discoveryPeers.size !== 0) return;
		this.#resolveDiscovery?.();
	}

	#detachState(): void {
		this.#removeListener();
		for (const requestId of [...this.#pendingOperations.keys()]) {
			this.#rejectOperation(requestId, new Error("Experimental server detached during a worker operation"));
		}
		for (const pending of [...this.#pendingDemand.values()]) {
			this.#pendingDemand.delete(pending.requestId);
			clearTimeout(pending.timer);
			pending.resolve();
		}
		this.#pending.clear();
		this.#workersByPeer.clear();
		this.#workersBySession.clear();
		this.workerPids.clear();
		this.#discoveryPeers = undefined;
		this.#resolveDiscovery?.();
		this.#resolveDiscovery = undefined;
	}
}
