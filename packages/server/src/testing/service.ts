import type { AgentHarness, Session, SessionMetadata } from "@earendil-works/pi-agent-core";
import { MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { SessionLockedError } from "../errors.ts";
import type { PiServerService } from "../types.ts";

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

export class TestHarness {
	readonly session: Session;
	readonly closed = new Deferred<void>();
	closeCount = 0;

	constructor(session: Session) {
		this.session = session;
	}

	async close(): Promise<void> {
		this.closeCount += 1;
		await this.session.close();
		this.closed.resolve(undefined);
	}
}

interface ListDelay {
	entered: Deferred<void>;
	release: Deferred<void>;
}

export class TestServerService implements PiServerService {
	readonly repo = new MemorySessionRepo({ now: () => 1 });
	readonly harnesses = new Map<string, TestHarness[]>();
	readonly locked = new Set<string>();
	readonly sessions: PiServerService["sessions"] = {
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
			if (this.locked.has(metadata.id)) throw new SessionLockedError(`Session is locked: ${metadata.id}`);
			return this.repo.open(metadata);
		},
	};
	private nextListDelay?: ListDelay;

	async createHarness(session: Session): Promise<Pick<AgentHarness, "close">> {
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

	latestHarness(id: string): TestHarness {
		const harnesses = this.harnesses.get(id);
		if (!harnesses?.length) throw new Error(`No harness for ${id}`);
		return harnesses.at(-1)!;
	}
}
