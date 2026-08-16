/** Worker-local reconciliation of server-generation demand and Harness activity. */
export class WorkerLifecycle {
	readonly #enabled: boolean;
	readonly #initialDemandGraceMs: number;
	readonly #orphanDemandGraceMs: number;
	readonly #onRetire: () => void;
	readonly #demands = new Map<string, { attachmentId: string; timer?: NodeJS.Timeout }>();
	readonly #activeOperations = new Set<string>();
	#currentServerConnectionId: string | undefined;
	#initialTimer: NodeJS.Timeout | undefined;
	#demandInitialized: boolean;
	#retirementHolds = 0;
	#retiring = false;

	constructor(options: {
		enabled: boolean;
		initialServerConnectionId?: string;
		initialDemandGraceMs: number;
		orphanDemandGraceMs: number;
		onRetire(): void;
	}) {
		this.#enabled = options.enabled;
		this.#currentServerConnectionId = options.initialServerConnectionId;
		this.#initialDemandGraceMs = options.initialDemandGraceMs;
		this.#orphanDemandGraceMs = options.orphanDemandGraceMs;
		this.#onRetire = options.onRetire;
		this.#demandInitialized = !options.enabled;
		if (options.enabled) {
			this.#initialTimer = setTimeout(() => {
				this.#initialTimer = undefined;
				this.#demandInitialized = true;
				this.#reconcile();
			}, this.#initialDemandGraceMs);
			this.#initialTimer.unref();
		}
	}

	serverConnected(serverConnectionId: string): void {
		this.#currentServerConnectionId = serverConnectionId;
		const demand = this.#demands.get(serverConnectionId);
		if (demand?.timer) {
			clearTimeout(demand.timer);
			delete demand.timer;
		}
	}

	serverDisconnected(serverConnectionId: string): void {
		if (this.#currentServerConnectionId === serverConnectionId) this.#currentServerConnectionId = undefined;
		const demand = this.#demands.get(serverConnectionId);
		if (!demand || demand.timer) return;
		demand.timer = setTimeout(() => {
			if (this.#demands.get(serverConnectionId) !== demand) return;
			this.#demands.delete(serverConnectionId);
			this.#reconcile();
		}, this.#orphanDemandGraceMs);
		demand.timer.unref();
	}

	holdRetirement(): () => void {
		this.#retirementHolds += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#retirementHolds -= 1;
			this.#reconcile();
		};
	}

	setDemand(serverConnectionId: string, attachmentId: string | null): void {
		if (this.#retiring) throw new Error("Session worker is retiring");
		if (serverConnectionId !== this.#currentServerConnectionId) {
			throw new Error("Session worker received demand from a stale server generation");
		}
		this.#demandInitialized = true;
		if (this.#initialTimer) {
			clearTimeout(this.#initialTimer);
			this.#initialTimer = undefined;
		}
		const previous = this.#demands.get(serverConnectionId);
		if (previous?.timer) clearTimeout(previous.timer);
		if (attachmentId === null) this.#demands.delete(serverConnectionId);
		else this.#demands.set(serverConnectionId, { attachmentId });
		this.#reconcile();
	}

	operationStarted(kind: "run" | "compaction" | "navigation", lane: string, operationId: string): void {
		this.#activeOperations.add(`${kind}\0${lane}\0${operationId}`);
	}

	operationStopped(kind: "run" | "compaction" | "navigation", lane: string, operationId: string): void {
		this.#activeOperations.delete(`${kind}\0${lane}\0${operationId}`);
		this.#reconcile();
	}

	close(): void {
		if (this.#initialTimer) clearTimeout(this.#initialTimer);
		for (const demand of this.#demands.values()) {
			if (demand.timer) clearTimeout(demand.timer);
		}
		this.#demands.clear();
	}

	#reconcile(): void {
		if (
			!this.#enabled ||
			this.#retiring ||
			!this.#demandInitialized ||
			this.#retirementHolds !== 0 ||
			this.#activeOperations.size !== 0 ||
			this.#demands.size !== 0
		) {
			return;
		}
		this.#retiring = true;
		this.#onRetire();
	}
}
