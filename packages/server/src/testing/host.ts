import type { Session, SessionMetadata } from "@earendil-works/pi-agent-core";
import { MemorySessionRepo } from "@earendil-works/pi-agent-core";
import type { HostedHarnessHandle, PiServerHost } from "../types.ts";

export class Deferred<T> {
	readonly promise: Promise<T>;
	private resolvePromise!: (value: T) => void;

	constructor() {
		this.promise = new Promise<T>((resolve) => {
			this.resolvePromise = resolve;
		});
	}

	resolve(value: T): void {
		this.resolvePromise(value);
	}
}

interface OpenGate {
	entered: Deferred<void>;
	release: Deferred<void>;
}

export class TestHarness {
	readonly session: Session;
	readonly closed = new Deferred<void>();
	readonly #termination = new Deferred<Error | undefined>();
	readonly terminated = this.#termination.promise;
	closeCount = 0;
	failClose?: Error;
	private nextCloseGate?: OpenGate;

	constructor(session: Session) {
		this.session = session;
	}

	async close(): Promise<void> {
		this.closeCount += 1;
		const gate = this.nextCloseGate;
		if (gate) {
			this.nextCloseGate = undefined;
			gate.entered.resolve(undefined);
			await gate.release.promise;
		}
		if (this.failClose) {
			const error = this.failClose;
			this.failClose = undefined;
			throw error;
		}
		await this.session.close();
		this.closed.resolve(undefined);
		this.#termination.resolve(undefined);
	}

	async terminate(error: Error): Promise<void> {
		await this.session.close();
		this.#termination.resolve(error);
	}

	gateNextClose(): OpenGate {
		const gate = { entered: new Deferred<void>(), release: new Deferred<void>() };
		this.nextCloseGate = gate;
		return gate;
	}
}

interface ListDelay {
	entered: Deferred<void>;
	release: Deferred<void>;
}

export class TestServerHost implements PiServerHost {
	readonly repo = new MemorySessionRepo({ now: () => 1 });
	readonly harnesses = new Map<string, TestHarness[]>();
	openCount = 0;
	failNextOpen?: Error;
	failNextHarness?: Error;
	readonly sessions: PiServerHost["sessions"] = {
		list: async () => {
			const delay = this.nextListDelay;
			if (delay) {
				this.nextListDelay = undefined;
				delay.entered.resolve(undefined);
				await delay.release.promise;
			}
			return this.repo.list();
		},
		open: async (metadata) => {
			this.openCount += 1;
			const gate = this.nextOpenGate;
			if (gate) {
				this.nextOpenGate = undefined;
				gate.entered.resolve(undefined);
				await gate.release.promise;
			}
			if (this.failNextOpen) {
				const error = this.failNextOpen;
				this.failNextOpen = undefined;
				throw error;
			}
			return this.repo.open(metadata);
		},
	};
	private nextListDelay?: ListDelay;
	private nextOpenGate?: OpenGate;

	async createHarness(session: Session): Promise<HostedHarnessHandle> {
		if (this.failNextHarness) {
			const error = this.failNextHarness;
			this.failNextHarness = undefined;
			throw error;
		}
		const harness = new TestHarness(session);
		const harnesses = this.harnesses.get(session.metadata.id) ?? [];
		harnesses.push(harness);
		this.harnesses.set(session.metadata.id, harnesses);
		return harness;
	}

	async seed(id = "session-1", parentSessionId?: string): Promise<SessionMetadata> {
		const session = await this.repo.create({ id, parentSessionId });
		const metadata = session.metadata;
		await session.close();
		return metadata;
	}

	delayNextList(): ListDelay {
		const delay = { entered: new Deferred<void>(), release: new Deferred<void>() };
		this.nextListDelay = delay;
		return delay;
	}

	gateNextOpen(): OpenGate {
		const gate = { entered: new Deferred<void>(), release: new Deferred<void>() };
		this.nextOpenGate = gate;
		return gate;
	}

	latestHarness(id: string): TestHarness {
		const harnesses = this.harnesses.get(id);
		if (!harnesses?.length) throw new Error(`No harness for ${id}`);
		return harnesses.at(-1)!;
	}
}
