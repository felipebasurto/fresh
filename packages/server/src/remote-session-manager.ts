import { randomUUID } from "node:crypto";
import type {
	AgentMessage,
	BranchScan,
	Context,
	EntryQuery,
	EntryType,
	JsonValue,
	LaneConfiguration,
	ListReadOptions,
	Session,
	SessionMetadata,
	SessionMutator,
	StorageBranchScan,
	Value,
	ValueList,
	Write,
} from "@earendil-works/pi-agent-core";
import { isJsonValue, ProtocolValidationError } from "@earendil-works/pi-protocol";
import {
	NotSupportedError,
	PiServerError,
	ServerDrainingError,
	SessionAmbiguousError,
	SessionInUseError,
	SessionNotFoundError,
} from "./errors.ts";
import type { PiServerHost } from "./types.ts";

export const DEFAULT_REMOTE_MUTATION_LEASE_MS = 30_000;

export class RemoteMutationNotFoundError extends PiServerError {
	constructor() {
		super("mutation_not_found", "Remote Session mutation was not found");
		this.name = "RemoteMutationNotFoundError";
	}
}

export class RemoteMutationExpiredError extends PiServerError {
	constructor() {
		super("mutation_expired", "Remote Session mutation lease expired");
		this.name = "RemoteMutationExpiredError";
	}
}

interface OpenSession<TMetadata extends SessionMetadata> {
	readonly client: object;
	readonly handle: string;
	readonly session: Session<TMetadata>;
	readonly mutations: Map<string, RemoteMutation>;
	readonly expiredMutations: Set<string>;
	closing?: Promise<void>;
}

interface RemoteMutation {
	readonly id: string;
	completion: Promise<void>;
	readonly release: () => void;
	mutator?: SessionMutator;
	lease?: NodeJS.Timeout;
	state: "opening" | "active" | "finishing" | "expired";
}

interface RemoteSessionManagerOptions<TMetadata extends SessionMetadata> {
	readonly host: PiServerHost<TMetadata>;
	readonly mutationLeaseMs: number;
	readonly isSessionUnavailable?: (sessionId: string) => boolean;
}

/** Connection-scoped remote Session capabilities dispatched through untyped RPC method names. */
export class RemoteSessionManager<TMetadata extends SessionMetadata = SessionMetadata> {
	readonly #options: RemoteSessionManagerOptions<TMetadata>;
	readonly #sessionsByHandle = new Map<string, OpenSession<TMetadata>>();
	readonly #sessionsById = new Map<string, OpenSession<TMetadata>>();
	readonly #sessionsByClient = new Map<object, Set<OpenSession<TMetadata>>>();
	readonly #closingSessions = new Set<Promise<void>>();
	#openTail: Promise<void> = Promise.resolve();
	#closing = false;

	constructor(options: RemoteSessionManagerOptions<TMetadata>) {
		this.#options = options;
	}

	hasSession(sessionId: string): boolean {
		return this.#sessionsById.has(sessionId);
	}

	invoke(method: string, args: unknown, client: object, context: Context): Promise<unknown> {
		if (method === "session.open")
			return this.#open(expectString(expectArgs(args).sessionId, "sessionId"), client, context);
		const params = expectArgs(args);
		const owner = this.#requireOwner(expectString(params.handle, "handle"), client);
		switch (method) {
			case "session.close":
				return this.#closeOwner(owner, context).then(() => null);
			case "session.getEntries":
				return owner.session
					.getEntries(expectStringArray(params.ids, "ids"), context)
					.then((entries) => [...entries]);
			case "session.getValue":
				return owner.session.getValue(expectValue(params.address), context).then((value) => value ?? null);
			case "session.scanValues":
				return owner.session.scanValues(expectValue(params.prefix), context);
			case "session.readList":
				return owner.session.readList(expectList(params.address), optionalOptions(params.options), context);
			case "session.scanBranch":
				return owner.session.scanBranch(expectStorageBranchScan(params.query), context);
			case "session.createLane":
				return owner.session
					.createLane(
						expectString(params.name, "name"),
						expectNullableString(params.at, "at"),
						expectObject(params.configuration, "configuration") as unknown as LaneConfiguration,
						context,
					)
					.then(() => null);
			case "session.mutation.begin":
				return this.#beginMutation(owner, expectString(params.mutationLane, "mutationLane"), context);
			case "session.mutation.finish":
				return this.#finishMutation(owner, expectString(params.mutationId, "mutationId")).then(() => null);
			case "session.mutation.getEntries": {
				const mutation = this.#requireMutation(owner, params);
				return mutation
					.mutator!.getEntries(expectStringArray(params.ids, "ids"), context)
					.then((entries) => [...entries]);
			}
			case "session.mutation.getValue": {
				const mutation = this.#requireMutation(owner, params);
				return mutation.mutator!.getValue(expectValue(params.address), context).then((value) => value ?? null);
			}
			case "session.mutation.scanValues": {
				const mutation = this.#requireMutation(owner, params);
				return mutation.mutator!.scanValues(expectValue(params.prefix), context);
			}
			case "session.mutation.readList": {
				const mutation = this.#requireMutation(owner, params);
				return mutation.mutator!.readList(expectList(params.address), optionalOptions(params.options), context);
			}
			case "session.mutation.scanBranch": {
				const mutation = this.#requireMutation(owner, params);
				return mutation.mutator!.scanBranch(expectStorageBranchScan(params.query), context);
			}
			case "session.mutation.commit": {
				const mutation = this.#requireMutation(owner, params);
				if (!Array.isArray(params.writes)) throw new ProtocolValidationError("writes must be an array");
				return mutation.mutator!.commit(params.writes as Write[], context);
			}
		}

		const lane = expectString(params.lane, "lane");
		const tree = owner.session.view(lane);
		switch (method) {
			case "session.tree.getLeafId":
				return tree.getLeafId(context);
			case "session.tree.getEntry":
				return tree.getEntry(expectString(params.id, "id"), context).then((entry) => entry ?? null);
			case "session.tree.getStats":
				return tree.getStats(context);
			case "session.tree.getValue":
				return tree.getValue(expectValue(params.address), context).then((value) => value ?? null);
			case "session.tree.scanValues":
				return tree.scanValues(expectValue(params.prefix), context);
			case "session.tree.readList":
				return tree.readList(expectList(params.address), optionalOptions(params.options), context);
			case "session.tree.setValue":
				return tree.setValue(expectValue(params.address), required(params, "next"), context).then(() => null);
			case "session.tree.deleteValue":
				return tree.deleteValue(expectValue(params.address), context).then(() => null);
			case "session.tree.appendList":
				return tree.appendList(expectList(params.address), required(params, "element"), context).then(() => null);
			case "session.tree.deleteList":
				return tree.deleteList(expectList(params.address), context).then(() => null);
			case "session.tree.getName":
				return tree.getName(context).then((name) => name ?? null);
			case "session.tree.setName":
				return tree.setName(expectOptionalString(params.name, "name"), context).then(() => null);
			case "session.tree.getLabel":
				return tree.getLabel(expectString(params.targetId, "targetId"), context).then((label) => label ?? null);
			case "session.tree.setLabel":
				return tree
					.setLabel(
						expectString(params.targetId, "targetId"),
						expectOptionalString(params.label, "label"),
						context,
					)
					.then(() => null);
			case "session.tree.findEntries":
				return tree.findEntries(optionalEntryQuery(params.query), context);
			case "session.tree.findEntry":
				return tree.findEntry(optionalEntryQuery(params.query), context).then((entry) => entry ?? null);
			case "session.tree.findEntriesOnBranch":
				return tree.findEntriesOnBranch(optionalBranchScan(params.query), context);
			case "session.tree.findEntryOnBranch":
				return tree.findEntryOnBranch(optionalBranchScan(params.query), context).then((entry) => entry ?? null);
			case "session.tree.appendMessage":
				return tree.appendMessage(expectObject(params.message, "message") as unknown as AgentMessage, context);
			case "session.tree.appendCustomEntry":
				return tree.appendCustomEntry(
					expectString(params.customType, "customType"),
					optionalJsonValue(params, "data"),
					context,
				);
			default:
				return Promise.reject(new ProtocolValidationError(`Unknown RPC method ${method}`));
		}
	}

	async disconnect(client: object, context: Context): Promise<void> {
		const sessions = [...(this.#sessionsByClient.get(client) ?? [])];
		const results = await Promise.allSettled(sessions.map((session) => this.#closeOwner(session, context)));
		const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Failed to close remote Sessions after disconnect");
	}

	async close(context: Context): Promise<void> {
		this.#closing = true;
		await this.#openTail.catch(() => {});
		const sessions = [...this.#sessionsByHandle.values()];
		const closing = sessions.map((session) => this.#closeOwner(session, context));
		const results = await Promise.allSettled([...this.#closingSessions, ...closing]);
		const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Failed to close remote Sessions");
	}

	#open(sessionId: string, client: object, context: Context): Promise<unknown> {
		return this.#serializeOpen(async () => {
			if (this.#closing) throw new ServerDrainingError();
			const existing = [...(this.#sessionsByClient.get(client) ?? [])].find(
				(candidate) => candidate.session.metadata.id === sessionId,
			);
			if (existing) return { handle: existing.handle, metadata: toProtocolMetadata(existing.session.metadata) };
			if (this.#sessionsById.has(sessionId) || this.#options.isSessionUnavailable?.(sessionId)) {
				throw new SessionInUseError();
			}
			const open = this.#options.host.sessions.open;
			if (open === undefined) throw new NotSupportedError("Host does not support remote Sessions");
			const matches = (await this.#options.host.sessions.list(context)).filter(
				(metadata) => metadata.id === sessionId,
			);
			if (matches.length === 0) throw new SessionNotFoundError(`Unknown session: ${sessionId}`);
			if (matches.length > 1) throw new SessionAmbiguousError();
			const session = await open(matches[0]!, context);
			if (this.#closing) {
				await session.close(context);
				throw new ServerDrainingError();
			}
			const owner: OpenSession<TMetadata> = {
				client,
				handle: randomUUID(),
				session,
				mutations: new Map(),
				expiredMutations: new Set(),
			};
			this.#sessionsByHandle.set(owner.handle, owner);
			this.#sessionsById.set(sessionId, owner);
			let clientSessions = this.#sessionsByClient.get(client);
			if (clientSessions === undefined) {
				clientSessions = new Set();
				this.#sessionsByClient.set(client, clientSessions);
			}
			clientSessions.add(owner);
			return { handle: owner.handle, metadata: toProtocolMetadata(session.metadata) };
		});
	}

	#serializeOpen<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#openTail.catch(() => {}).then(operation);
		this.#openTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	#requireOwner(handle: string, client: object): OpenSession<TMetadata> {
		const owner = this.#sessionsByHandle.get(handle);
		if (owner === undefined || owner.client !== client || owner.closing !== undefined) {
			throw new SessionNotFoundError("Remote Session handle was not found");
		}
		return owner;
	}

	async #closeOwner(owner: OpenSession<TMetadata>, context: Context): Promise<void> {
		if (owner.closing !== undefined) return owner.closing;
		const closing = (async () => {
			this.#sessionsByHandle.delete(owner.handle);
			if (this.#sessionsById.get(owner.session.metadata.id) === owner) {
				this.#sessionsById.delete(owner.session.metadata.id);
			}
			const clientSessions = this.#sessionsByClient.get(owner.client);
			clientSessions?.delete(owner);
			if (clientSessions?.size === 0) this.#sessionsByClient.delete(owner.client);
			const mutations = [...owner.mutations.values()];
			for (const mutation of mutations) mutation.release();
			const errors = (await Promise.allSettled(mutations.map((mutation) => mutation.completion))).flatMap(
				(result) => (result.status === "rejected" ? [result.reason] : []),
			);
			owner.expiredMutations.clear();
			try {
				await owner.session.close(context);
			} catch (error) {
				errors.push(error);
			}
			if (errors.length === 1) throw errors[0];
			if (errors.length > 1) throw new AggregateError(errors, "Failed to close remote Session");
		})();
		owner.closing = closing;
		this.#closingSessions.add(closing);
		void closing.finally(() => this.#closingSessions.delete(closing)).catch(() => {});
		return closing;
	}

	async #beginMutation(
		owner: OpenSession<TMetadata>,
		lane: string,
		context: Context,
	): Promise<{ mutationId: string }> {
		const id = randomUUID();
		let resolveEntered!: () => void;
		let rejectEntered!: (error: unknown) => void;
		const entered = new Promise<void>((resolve, reject) => {
			resolveEntered = resolve;
			rejectEntered = reject;
		});
		let resolveRelease!: () => void;
		const released = new Promise<void>((resolve) => {
			resolveRelease = resolve;
		});
		let releasedOnce = false;
		const release = (): void => {
			if (releasedOnce) return;
			releasedOnce = true;
			resolveRelease();
		};
		const resource: RemoteMutation = {
			id,
			completion: Promise.resolve(),
			release,
			state: "opening",
		};
		owner.mutations.set(id, resource);
		const completion = owner.session
			.mutate(
				lane,
				async (mutator) => {
					if (resource.state !== "opening") return;
					resource.mutator = mutator;
					resource.state = "active";
					resource.lease = setTimeout(() => {
						if (resource.state !== "active") return;
						resource.state = "expired";
						owner.expiredMutations.add(resource.id);
						resource.release();
					}, this.#options.mutationLeaseMs);
					resource.lease.unref();
					resolveEntered();
					await released;
				},
				context,
			)
			.catch((error: unknown) => {
				rejectEntered(error);
				throw error;
			})
			.finally(() => {
				if (resource.lease) clearTimeout(resource.lease);
				owner.mutations.delete(id);
			});
		resource.completion = completion;
		void completion.catch(() => {});

		const signal = context.abortSignal;
		let onAbort: (() => void) | undefined;
		const aborted =
			signal === undefined
				? undefined
				: new Promise<never>((_resolve, reject) => {
						onAbort = () => {
							resource.state = "finishing";
							resource.release();
							reject(abortError(signal));
						};
						signal.addEventListener("abort", onAbort, { once: true });
					});
		try {
			if (signal?.aborted) throw abortError(signal);
			await (aborted === undefined ? entered : Promise.race([entered, aborted]));
			if (signal?.aborted) throw abortError(signal);
			return { mutationId: id };
		} catch (error) {
			resource.state = "finishing";
			resource.release();
			throw error;
		} finally {
			if (signal !== undefined && onAbort !== undefined) signal.removeEventListener("abort", onAbort);
		}
	}

	#requireMutation(owner: OpenSession<TMetadata>, params: Record<string, unknown>): RemoteMutation {
		const id = expectString(params.mutationId, "mutationId");
		const mutation = owner.mutations.get(id);
		if (mutation === undefined) {
			if (owner.expiredMutations.has(id)) throw new RemoteMutationExpiredError();
			throw new RemoteMutationNotFoundError();
		}
		if (mutation.state === "expired") throw new RemoteMutationExpiredError();
		if (mutation.state !== "active" || mutation.mutator === undefined) throw new RemoteMutationNotFoundError();
		return mutation;
	}

	async #finishMutation(owner: OpenSession<TMetadata>, id: string): Promise<void> {
		const mutation = owner.mutations.get(id);
		if (mutation === undefined) {
			if (owner.expiredMutations.delete(id)) throw new RemoteMutationExpiredError();
			throw new RemoteMutationNotFoundError();
		}
		if (mutation.state === "expired") {
			await mutation.completion;
			owner.expiredMutations.delete(id);
			throw new RemoteMutationExpiredError();
		}
		mutation.state = "finishing";
		mutation.release();
		await mutation.completion;
	}
}

function toProtocolMetadata(metadata: SessionMetadata): SessionMetadata {
	return {
		id: metadata.id,
		createdAt: metadata.createdAt,
		storageVersion: metadata.storageVersion,
		...(metadata.cwd === undefined ? {} : { cwd: metadata.cwd }),
		...(metadata.parentSessionId === undefined ? {} : { parentSessionId: metadata.parentSessionId }),
		...(metadata.legacyParentSessionPath === undefined
			? {}
			: { legacyParentSessionPath: metadata.legacyParentSessionPath }),
	};
}

function expectArgs(value: unknown): Record<string, unknown> {
	return expectObject(value, "RPC arguments");
}

function expectObject(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new ProtocolValidationError(`${name} must be an object`);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ProtocolValidationError(`${name} must be a plain object`);
	}
	return value as Record<string, unknown>;
}

function expectString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new ProtocolValidationError(`${name} must be a non-empty string`);
	}
	return value;
}

function expectStringArray(value: unknown, name: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new ProtocolValidationError(`${name} must be an array of strings`);
	}
	return value;
}

function expectNullableString(value: unknown, name: string): string | null {
	return value === null ? null : expectString(value, name);
}

function expectOptionalString(value: unknown, name: string): string | undefined {
	return value === null ? undefined : expectString(value, name);
}

function expectValue(value: unknown): Value<unknown> {
	const address = expectObject(value, "value address");
	if (address.kind !== "value" || typeof address.namespace !== "string" || typeof address.key !== "string") {
		throw new ProtocolValidationError("Invalid value address");
	}
	return address as unknown as Value<unknown>;
}

function expectList(value: unknown): ValueList<unknown> {
	const address = expectObject(value, "list address");
	if (address.kind !== "list" || typeof address.namespace !== "string" || typeof address.key !== "string") {
		throw new ProtocolValidationError("Invalid list address");
	}
	return address as unknown as ValueList<unknown>;
}

function required(params: Record<string, unknown>, key: string): unknown {
	if (!Object.hasOwn(params, key)) throw new ProtocolValidationError(`${key} is required`);
	return params[key];
}

function optionalJsonValue(params: Record<string, unknown>, key: string): JsonValue | undefined {
	if (!(key in params)) return undefined;
	const value = params[key];
	if (!isJsonValue(value)) throw new ProtocolValidationError(`${key} must be a JSON value`);
	return value;
}

function optionalOptions(value: unknown): ListReadOptions | undefined {
	return value === null ? undefined : (expectObject(value, "list options") as unknown as ListReadOptions);
}

function optionalEntryQuery(value: unknown): EntryQuery | undefined {
	return value === null ? undefined : (expectObject(value, "entry query") as unknown as EntryQuery);
}

function optionalBranchScan(value: unknown): BranchScan | undefined {
	return value === null ? undefined : (expectObject(value, "branch query") as unknown as BranchScan);
}

function expectStorageBranchScan(value: unknown): StorageBranchScan {
	const query = expectObject(value, "storage branch query");
	return {
		start: expectString(query.start, "query.start"),
		...(query.stopAtType === undefined ? {} : { stopAtType: expectEntryType(query.stopAtType, "query.stopAtType") }),
		...(query.stopAtId === undefined ? {} : { stopAtId: expectString(query.stopAtId, "query.stopAtId") }),
		...(query.type === undefined ? {} : { type: expectEntryType(query.type, "query.type") }),
		...(query.customType === undefined ? {} : { customType: expectString(query.customType, "query.customType") }),
		...(query.order === undefined ? {} : { order: expectBranchOrder(query.order) }),
		...(query.limit === undefined ? {} : { limit: expectFiniteNumber(query.limit, "query.limit") }),
		...(query.cursor === undefined ? {} : { cursor: expectEntryCursor(query.cursor) }),
	};
}

function expectEntryType(value: unknown, name: string): EntryType {
	if (value !== "message" && value !== "compaction" && value !== "branch_summary" && value !== "custom") {
		throw new ProtocolValidationError(`${name} must be a valid entry type`);
	}
	return value;
}

function expectBranchOrder(value: unknown): "newestFirst" | "oldestFirst" {
	if (value !== "newestFirst" && value !== "oldestFirst") {
		throw new ProtocolValidationError("query.order must be newestFirst or oldestFirst");
	}
	return value;
}

function expectEntryCursor(value: unknown): { seq: number } {
	const cursor = expectObject(value, "query.cursor");
	return { seq: expectFiniteNumber(cursor.seq, "query.cursor.seq") };
}

function expectFiniteNumber(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new ProtocolValidationError(`${name} must be a finite number`);
	}
	return value;
}

function abortError(signal: AbortSignal): Error {
	const reason: unknown = signal.reason;
	return reason instanceof Error ? reason : new DOMException("The operation was aborted", "AbortError");
}
