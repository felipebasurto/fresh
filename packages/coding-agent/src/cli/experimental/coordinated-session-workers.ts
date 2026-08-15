import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { JsonlSessionMetadata } from "@earendil-works/pi-agent-core";
import type { HostedHarnessHandle } from "@earendil-works/pi-server";
import Type, { type Static } from "typebox";
import { Check } from "typebox/value";
import type { CoordinatorServer, CoordinatorServerEvent } from "./coordinator-client.ts";
import { spawnInternalProcess } from "./internal-process-launcher.ts";
import {
	SESSION_WORKER_CONTROL_ADDRESS_ENV,
	SESSION_WORKER_CONTROL_TOKEN_ENV,
	SESSION_WORKER_COORDINATED_ENV,
	SESSION_WORKER_PEER_ID_ENV,
	SESSION_WORKER_SESSION_KEY_ENV,
} from "./session-worker.ts";

const WORKER_STARTUP_TIMEOUT_MS = 15_000;
const WORKER_SHUTDOWN_TIMEOUT_MS = 10_000;
const WORKER_DISCOVERY_TIMEOUT_MS = 5_000;

const JsonlSessionMetadataSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	createdAt: Type.Integer(),
	storageVersion: Type.Integer(),
	cwd: Type.String(),
	path: Type.String(),
	modifiedAt: Type.Number(),
	parentSessionId: Type.Optional(Type.String()),
	legacyParentSessionPath: Type.Optional(Type.String()),
});

const WorkerMessageSchema = Type.Union([
	Type.Object({
		type: Type.Literal("worker_ready"),
		token: Type.String(),
		sessionKey: Type.String(),
		sessionId: Type.String(),
		pid: Type.Integer({ minimum: 1 }),
		metadata: JsonlSessionMetadataSchema,
	}),
	Type.Object({
		type: Type.Literal("worker_failed"),
		token: Type.String(),
		sessionKey: Type.String(),
		message: Type.String(),
	}),
]);
type WorkerMessage = Static<typeof WorkerMessageSchema>;

interface WorkerRecord {
	readonly peerId: string;
	readonly metadata: JsonlSessionMetadata;
	readonly pid: number;
	readonly terminated: Promise<Error | undefined>;
	resolveTerminated(error: Error | undefined): void;
	expectedStop: boolean;
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
export class CoordinatedSessionWorkers {
	readonly workerPids = new Map<string, number>();
	readonly #coordinator: CoordinatorServer;
	readonly #sessionDir: string;
	readonly #workersBySession = new Map<string, WorkerRecord>();
	readonly #workersByPeer = new Map<string, WorkerRecord>();
	readonly #pending = new Map<string, PendingLaunch>();
	readonly #removeListener: () => void;
	#discoveryPeers?: Set<string>;
	#resolveDiscovery?: () => void;
	#detached = false;
	#shuttingDown = false;

	constructor(coordinator: CoordinatorServer, sessionDir: string) {
		this.#coordinator = coordinator;
		this.#sessionDir = sessionDir;
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
		if (existing) return { terminated: existing.terminated, close: async () => {} };
		const pending = this.#pending.get(metadata.path);
		if (pending) {
			const worker = await pending.promise;
			return { terminated: worker.terminated, close: async () => {} };
		}
		const worker = await this.#launch(metadata);
		return { terminated: worker.terminated, close: async () => {} };
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
					[SESSION_WORKER_COORDINATED_ENV]: "1",
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
		child.once("error", (error) => this.#failPending(sessionKey, error));
		child.once("exit", (code, signal) => this.#childExited(pending, code, signal));
		return promise;
	}

	#handleCoordinatorEvent(event: CoordinatorServerEvent): void {
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
		if (event.type !== "message" || !Check(WorkerMessageSchema, event.payload)) return;
		const message: WorkerMessage = event.payload;
		if (message.type === "worker_failed") {
			const pending = this.#pending.get(message.sessionKey);
			if (pending?.peerId === event.from && pending.token === message.token) {
				this.#failPending(message.sessionKey, new Error(`Session worker failed: ${message.message}`));
			}
			return;
		}
		this.#recordReadyWorker(event.from, message);
	}

	#recordReadyWorker(peerId: string, message: Extract<WorkerMessage, { type: "worker_ready" }>): void {
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
			terminated,
			resolveTerminated,
			expectedStop: false,
		};
		this.#workersBySession.set(message.sessionKey, worker);
		this.#workersByPeer.set(peerId, worker);
		this.workerPids.set(message.sessionId, message.pid);
		if (pending) {
			this.#pending.delete(message.sessionKey);
			clearTimeout(pending.timer);
			pending.resolve(worker);
		}
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
		if (pending.child.exitCode === null && pending.child.signalCode === null) pending.child.kill("SIGKILL");
		pending.reject(error);
	}

	#removeWorker(worker: WorkerRecord, error: Error | undefined): void {
		if (this.#workersByPeer.get(worker.peerId) !== worker) return;
		this.#workersByPeer.delete(worker.peerId);
		this.#workersBySession.delete(worker.metadata.path);
		if (this.workerPids.get(worker.metadata.id) === worker.pid) this.workerPids.delete(worker.metadata.id);
		worker.resolveTerminated(error);
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
		this.#pending.clear();
		this.#workersByPeer.clear();
		this.#workersBySession.clear();
		this.workerPids.clear();
		this.#discoveryPeers = undefined;
		this.#resolveDiscovery?.();
		this.#resolveDiscovery = undefined;
	}
}
