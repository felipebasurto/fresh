import type {
	AgentMessage,
	BranchScan,
	Entry,
	EntryQuery,
	JsonValue,
	LaneConfiguration,
	Register,
	RegisterNamespace,
	Session,
	SessionMutator,
	SessionStats,
	SessionTree,
} from "@earendil-works/pi-agent-core";
import type { SqliteSessionMetadata } from "./session/session-row.ts";

/**
 * SQLite-specific open-session lifecycle wrapper.
 *
 * TODO: Keep the writer lease claimed for the lifetime of this open session,
 *   renew it while open, and release only the matching fenced lease on close.
 */
export class SqliteOpenSession implements Session<SqliteSessionMetadata> {
	readonly metadata: SqliteSessionMetadata;
	readonly idGenerator: Session<SqliteSessionMetadata>["idGenerator"];
	private readonly session: Session<SqliteSessionMetadata>;
	private readonly onClose: () => void;
	private readonly admitted = new Set<Promise<unknown>>();
	private readonly closedError = new Error("Session is closed");
	private state: "open" | "closing" | "closed" = "open";
	private closePromise: Promise<void> | undefined;

	constructor(session: Session<SqliteSessionMetadata>, onClose: () => void) {
		this.session = session;
		this.metadata = session.metadata;
		this.idGenerator = session.idGenerator;
		this.onClose = onClose;
	}

	mutate<T>(lane: string, mutation: (mutator: SessionMutator) => T | Promise<T>): Promise<T> {
		return this.admit(() => this.session.mutate(lane, mutation));
	}

	getEntries(ids: string[]): Promise<Map<string, Entry>> {
		return this.admit(() => this.session.getEntries(ids));
	}

	getRegister<TNamespace extends RegisterNamespace>(
		namespace: TNamespace,
		key: string,
	): Promise<Register<TNamespace> | undefined> {
		return this.admit(() => this.session.getRegister(namespace, key));
	}

	listRegisters<TNamespace extends RegisterNamespace>(
		namespace: TNamespace,
		keyPrefix?: string,
	): Promise<Register<TNamespace>[]> {
		return this.admit(() => this.session.listRegisters(namespace, keyPrefix));
	}

	view(lane: string): SessionTree {
		const view = this.session.view(lane);
		return {
			getLeafId: () => this.admit(() => view.getLeafId()),
			getEntry: (id) => this.admit(() => view.getEntry(id)),
			getStats: () => this.admit(() => view.getStats()),
			getName: () => this.admit(() => view.getName()),
			setName: (name) => this.admit(() => view.setName(name)),
			getLabel: (targetId) => this.admit(() => view.getLabel(targetId)),
			setLabel: (targetId, label) => this.admit(() => view.setLabel(targetId, label)),
			getCustomFact: (key) => this.admit(() => view.getCustomFact(key)),
			setCustomFact: (key, value) => this.admit(() => view.setCustomFact(key, value)),
			findEntries: (query) => this.admit(() => view.findEntries(query)),
			findEntry: (query) => this.admit(() => view.findEntry(query)),
			findEntriesOnBranch: (query) => this.admit(() => view.findEntriesOnBranch(query)),
			findEntryOnBranch: (query) => this.admit(() => view.findEntryOnBranch(query)),
			appendMessage: (message) => this.admit(() => view.appendMessage(message)),
			appendCustomEntry: (customType, data) => this.admit(() => view.appendCustomEntry(customType, data)),
		};
	}

	createLane(name: string, at: string | null, configuration: LaneConfiguration): Promise<SessionTree> {
		return this.admit(async () => {
			await this.session.createLane(name, at, configuration);
			return this.view(name);
		});
	}

	getLeafId(): Promise<string | null> {
		return this.admit(() => this.session.getLeafId());
	}

	getEntry(id: string): Promise<Entry | undefined> {
		return this.admit(() => this.session.getEntry(id));
	}

	getStats(): Promise<SessionStats> {
		return this.admit(() => this.session.getStats());
	}

	getName(): Promise<string | undefined> {
		return this.admit(() => this.session.getName());
	}

	setName(name: string | undefined): Promise<void> {
		return this.admit(() => this.session.setName(name));
	}

	getLabel(targetId: string): Promise<string | undefined> {
		return this.admit(() => this.session.getLabel(targetId));
	}

	setLabel(targetId: string, label: string | undefined): Promise<void> {
		return this.admit(() => this.session.setLabel(targetId, label));
	}

	getCustomFact(key: string): Promise<JsonValue | undefined> {
		return this.admit(() => this.session.getCustomFact(key));
	}

	setCustomFact(key: string, value: JsonValue | undefined): Promise<void> {
		return this.admit(() => this.session.setCustomFact(key, value));
	}

	findEntries(query?: EntryQuery): Promise<Entry[]> {
		return this.admit(() => this.session.findEntries(query));
	}

	findEntry(query?: EntryQuery): Promise<Entry | undefined> {
		return this.admit(() => this.session.findEntry(query));
	}

	findEntriesOnBranch(query?: BranchScan): Promise<Entry[]> {
		return this.admit(() => this.session.findEntriesOnBranch(query));
	}

	findEntryOnBranch(query?: BranchScan): Promise<Entry | undefined> {
		return this.admit(() => this.session.findEntryOnBranch(query));
	}

	appendMessage(message: AgentMessage): Promise<string> {
		return this.admit(() => this.session.appendMessage(message));
	}

	appendCustomEntry(customType: string, data?: JsonValue): Promise<string> {
		return this.admit(() => this.session.appendCustomEntry(customType, data));
	}

	close(): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		this.state = "closing";
		this.closePromise = Promise.allSettled([...this.admitted])
			.then(() => this.session.close())
			.finally(() => {
				this.state = "closed";
				this.onClose();
			});
		return this.closePromise;
	}

	private admit<T>(operation: () => Promise<T>): Promise<T> {
		if (this.state !== "open") return Promise.reject(this.closedError);
		let result: Promise<T>;
		try {
			result = operation();
		} catch (error) {
			result = Promise.reject(error);
		}
		this.admitted.add(result);
		void result.then(
			() => this.admitted.delete(result),
			() => this.admitted.delete(result),
		);
		return result;
	}
}
