import type {
	AgentMessage,
	BranchScan,
	Entry,
	EntryQuery,
	JsonValue,
	LaneConfiguration,
	ListElement,
	ListReadOptions,
	Session,
	SessionMutator,
	SessionStats,
	SessionTree,
	StoredValue,
	Value,
	ValueList,
} from "@earendil-works/pi-agent-core";
import type { SqliteSessionMetadata } from "./session/session-row.ts";

export interface SqliteOpenSessionOptions {
	onClose: () => void;
	renewWriterLease: () => void;
	releaseWriterLease: () => void;
	renewIntervalMs: number;
}

/** SQLite-specific open-session lifecycle wrapper. */
export class SqliteOpenSession implements Session<SqliteSessionMetadata> {
	readonly metadata: SqliteSessionMetadata;
	readonly idGenerator: Session<SqliteSessionMetadata>["idGenerator"];
	private readonly session: Session<SqliteSessionMetadata>;
	private readonly onClose: () => void;
	private readonly renewWriterLease: () => void;
	private readonly releaseWriterLease: () => void;
	private readonly renewalTimer: ReturnType<typeof setInterval>;
	private readonly admitted = new Set<Promise<unknown>>();
	private leaseError: unknown;
	private readonly closedError = new Error("Session is closed");
	private state: "open" | "closing" | "closed" = "open";
	private closePromise: Promise<void> | undefined;

	constructor(session: Session<SqliteSessionMetadata>, options: SqliteOpenSessionOptions) {
		this.session = session;
		this.metadata = session.metadata;
		this.idGenerator = session.idGenerator;
		this.onClose = options.onClose;
		this.renewWriterLease = options.renewWriterLease;
		this.releaseWriterLease = options.releaseWriterLease;
		this.renewalTimer = setInterval(() => {
			try {
				this.renewWriterLease();
			} catch (error) {
				this.leaseError = error;
				clearInterval(this.renewalTimer);
			}
		}, options.renewIntervalMs);
		this.renewalTimer.unref?.();
	}

	mutate<T>(lane: string, mutation: (mutator: SessionMutator) => T | Promise<T>): Promise<T> {
		return this.admit(() => this.session.mutate(lane, mutation));
	}

	getEntries(ids: string[]): Promise<Map<string, Entry>> {
		return this.admit(() => this.session.getEntries(ids));
	}

	getValue<T>(address: Value<T>): Promise<StoredValue<T> | undefined> {
		return this.admit(() => this.session.getValue(address));
	}

	scanValues<T>(prefix: Value<T>): Promise<StoredValue<T>[]> {
		return this.admit(() => this.session.scanValues(prefix));
	}

	readList<T>(address: ValueList<T>, options?: ListReadOptions): Promise<ListElement<T>[]> {
		return this.admit(() => this.session.readList(address, options));
	}

	view(lane: string): SessionTree {
		const view = this.session.view(lane);
		return {
			getLeafId: () => this.admit(() => view.getLeafId()),
			getEntry: (id) => this.admit(() => view.getEntry(id)),
			getStats: () => this.admit(() => view.getStats()),
			getValue: (address) => this.admit(() => view.getValue(address)),
			scanValues: (prefix) => this.admit(() => view.scanValues(prefix)),
			readList: (address, options) => this.admit(() => view.readList(address, options)),
			setValue: (address, next) => this.admit(() => view.setValue(address, next)),
			deleteValue: (address) => this.admit(() => view.deleteValue(address)),
			appendList: (address, element) => this.admit(() => view.appendList(address, element)),
			deleteList: (address) => this.admit(() => view.deleteList(address)),
			getName: () => this.admit(() => view.getName()),
			setName: (name) => this.admit(() => view.setName(name)),
			getLabel: (targetId) => this.admit(() => view.getLabel(targetId)),
			setLabel: (targetId, label) => this.admit(() => view.setLabel(targetId, label)),
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

	setValue<T>(address: Value<T>, next: NoInfer<T>): Promise<void> {
		return this.admit(() => this.session.setValue(address, next));
	}

	deleteValue<T>(address: Value<T>): Promise<void> {
		return this.admit(() => this.session.deleteValue(address));
	}

	appendList<T>(address: ValueList<T>, element: NoInfer<T>): Promise<void> {
		return this.admit(() => this.session.appendList(address, element));
	}

	deleteList<T>(address: ValueList<T>): Promise<void> {
		return this.admit(() => this.session.deleteList(address));
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
				clearInterval(this.renewalTimer);
				try {
					this.releaseWriterLease();
				} finally {
					this.state = "closed";
					this.onClose();
				}
			});
		return this.closePromise;
	}

	private admit<T>(operation: () => Promise<T>): Promise<T> {
		if (this.state !== "open") return Promise.reject(this.closedError);
		if (this.leaseError !== undefined) return Promise.reject(this.leaseError);
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
