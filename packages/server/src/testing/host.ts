import type { Context, Session, SessionMetadata } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import type { LaneEvent, LaneSnapshot, PromptArguments, RunResult } from "@earendil-works/pi-protocol";
import type { RoutedSessionHandle, RoutedSessionWatch, ServerHost } from "../types.ts";

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

const emptyLaneSnapshot: LaneSnapshot = {
	lane: "main",
	transcript: [],
	leafId: null,
	operation: null,
	queues: { steer: [], followUp: [], nextRun: [] },
	pendingWrites: [],
	faulted: false,
};

class TestHarnessWatch implements RoutedSessionWatch {
	readonly snapshot: LaneSnapshot;
	private readonly buffered: Array<{ event: LaneEvent; context: Context }> = [];
	private listener: ((event: LaneEvent, context: Context) => void | Promise<void>) | undefined;
	private tail: Promise<void> = Promise.resolve();
	private state: "buffering" | "started" | "unsubscribed" = "buffering";

	constructor(snapshot: LaneSnapshot) {
		this.snapshot = structuredClone(snapshot);
	}

	start(listener: (event: LaneEvent, context: Context) => void | Promise<void>, _context: Context): void {
		if (this.state !== "buffering") throw new Error("Test Harness watch may be started only once");
		this.state = "started";
		this.listener = listener;
		for (const buffered of this.buffered.splice(0)) this.enqueue(buffered.event, buffered.context);
	}

	unsubscribe(_context: Context): void {
		this.state = "unsubscribed";
		this.buffered.splice(0);
		this.listener = undefined;
	}

	push(event: LaneEvent, context: Context): Promise<void> {
		if (this.state === "unsubscribed") return Promise.resolve();
		if (this.state === "buffering") {
			this.buffered.push({ event: structuredClone(event), context });
			return Promise.resolve();
		}
		return this.enqueue(event, context);
	}

	private enqueue(event: LaneEvent, context: Context): Promise<void> {
		const listener = this.listener;
		if (listener === undefined) return Promise.resolve();
		const delivery = this.tail.then(() => listener(structuredClone(event), context));
		this.tail = delivery.catch(() => {});
		return delivery;
	}
}

export class TestHarness {
	readonly session: Session;
	readonly closed = new Deferred<void>();
	readonly #termination = new Deferred<Error | undefined>();
	readonly terminated = this.#termination.promise;
	attachedClients = 0;
	attachmentReleaseCount = 0;
	closeCount = 0;
	readonly promptCalls: PromptArguments[] = [];
	watchSnapshot: LaneSnapshot = structuredClone(emptyLaneSnapshot);
	private readonly watches = new Set<TestHarnessWatch>();
	failAttachmentRelease?: Error;
	failClose?: Error;
	nextPromptError?: Error;
	nextPromptResult?: RunResult;
	private nextCloseGate?: OpenGate;
	private nextPromptGate?: OpenGate;

	constructor(session: Session) {
		this.session = session;
	}

	attachClient(_context: Context): {
		prompt: TestHarness["prompt"];
		watch: TestHarness["watch"];
		release(context: Context): void;
	} {
		this.attachedClients += 1;
		let released = false;
		return {
			prompt: (prompt, context) => this.prompt(prompt, context),
			watch: (context) => this.watch(context),
			release: (_context) => {
				if (released) return;
				this.attachmentReleaseCount += 1;
				if (this.failAttachmentRelease) throw this.failAttachmentRelease;
				released = true;
				this.attachedClients -= 1;
			},
		};
	}

	async watch(_context: Context): Promise<RoutedSessionWatch> {
		const watch = new TestHarnessWatch(this.watchSnapshot);
		this.watches.add(watch);
		return {
			snapshot: watch.snapshot,
			start: (listener, context) => watch.start(listener, context),
			unsubscribe: (context) => {
				watch.unsubscribe(context);
				this.watches.delete(watch);
			},
		};
	}

	async emitEvent(event: LaneEvent, context: Context = BACKGROUND_CONTEXT): Promise<void> {
		await Promise.all([...this.watches].map((watch) => watch.push(event, context)));
	}

	async prompt(prompt: PromptArguments, _context: Context): Promise<RunResult> {
		this.promptCalls.push(prompt);
		if (this.nextPromptError) {
			const error = this.nextPromptError;
			this.nextPromptError = undefined;
			throw error;
		}
		const gate = this.nextPromptGate;
		if (gate) {
			this.nextPromptGate = undefined;
			gate.entered.resolve(undefined);
			await gate.release.promise;
		}
		const result = this.nextPromptResult ?? {
			ok: true,
			value: { kind: "completed", runId: "run-1", leafId: "leaf-1" },
		};
		this.nextPromptResult = undefined;
		return result;
	}

	async close(context: Context): Promise<void> {
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
		await this.session.close(context);
		this.closed.resolve(undefined);
		this.#termination.resolve(undefined);
	}

	async terminate(error: Error): Promise<void> {
		await this.session.close(BACKGROUND_CONTEXT);
		this.#termination.resolve(error);
	}

	gateNextClose(): OpenGate {
		const gate = { entered: new Deferred<void>(), release: new Deferred<void>() };
		this.nextCloseGate = gate;
		return gate;
	}

	gateNextPrompt(): OpenGate {
		const gate = { entered: new Deferred<void>(), release: new Deferred<void>() };
		this.nextPromptGate = gate;
		return gate;
	}
}

interface ListDelay {
	entered: Deferred<void>;
	release: Deferred<void>;
}

export class TestServerHost implements ServerHost {
	readonly repo = new MemorySessionRepo({ now: () => 1 });
	readonly harnesses = new Map<string, TestHarness[]>();
	openSessionCount = 0;
	nextOpenSessionError?: Error;
	nextHarnessCloseError?: Error;
	readonly sessions: ServerHost["sessions"] = {
		list: async (context) => {
			const delay = this.nextListDelay;
			if (delay) {
				this.nextListDelay = undefined;
				delay.entered.resolve(undefined);
				await delay.release.promise;
			}
			return this.repo.list(undefined, context);
		},
		create: async ({ id }, context) => {
			const session = await this.repo.create({ id }, context);
			try {
				return session.metadata;
			} finally {
				await session.close(context);
			}
		},
	};
	private nextListDelay?: ListDelay;
	private nextOpenSessionGate?: OpenGate;

	async openSession(metadata: SessionMetadata, context: Context): Promise<RoutedSessionHandle> {
		this.openSessionCount += 1;
		const gate = this.nextOpenSessionGate;
		if (gate) {
			this.nextOpenSessionGate = undefined;
			gate.entered.resolve(undefined);
			await gate.release.promise;
		}
		const session = await this.repo.open(metadata, context);
		try {
			if (this.nextOpenSessionError) {
				const error = this.nextOpenSessionError;
				this.nextOpenSessionError = undefined;
				throw error;
			}
			const harness = new TestHarness(session);
			if (this.nextHarnessCloseError) {
				harness.failClose = this.nextHarnessCloseError;
				this.nextHarnessCloseError = undefined;
			}
			const harnesses = this.harnesses.get(metadata.id) ?? [];
			harnesses.push(harness);
			this.harnesses.set(metadata.id, harnesses);
			return harness;
		} catch (error) {
			await session.close(context);
			throw error;
		}
	}

	async seed(id = "session-1", parentSessionId?: string): Promise<SessionMetadata> {
		const session = await this.repo.create({ id, parentSessionId }, BACKGROUND_CONTEXT);
		const metadata = session.metadata;
		await session.close(BACKGROUND_CONTEXT);
		return metadata;
	}

	delayNextList(): ListDelay {
		const delay = { entered: new Deferred<void>(), release: new Deferred<void>() };
		this.nextListDelay = delay;
		return delay;
	}

	gateNextOpenSession(): OpenGate {
		const gate = { entered: new Deferred<void>(), release: new Deferred<void>() };
		this.nextOpenSessionGate = gate;
		return gate;
	}

	latestHarness(id: string): TestHarness {
		const harnesses = this.harnesses.get(id);
		if (!harnesses?.length) throw new Error(`No harness for ${id}`);
		return harnesses.at(-1)!;
	}
}
