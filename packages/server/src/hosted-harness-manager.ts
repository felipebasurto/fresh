import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT, type Context, type SessionMetadata } from "@earendil-works/pi-agent-core";
import {
	createRpcDispatcher,
	type EventEnvelope,
	type PromptArguments,
	type SessionMetadata as ProtocolSessionMetadata,
	ProtocolValidationError,
	type RunResult,
	ServiceRpc,
	type ServiceRpcCall,
	type ServiceRpcResultUnion,
} from "@earendil-works/pi-protocol";
import {
	NotSupportedError,
	ServerDrainingError,
	SessionAmbiguousError,
	SessionInUseError,
	SessionNotAttachedError,
	SessionNotFoundError,
	WatchInUseError,
	WatchNotFoundError,
} from "./errors.ts";
import type { HostedHarnessAttachment, HostedHarnessHandle, HostedHarnessWatch, PiServerHost } from "./types.ts";

class HarnessCleanupError extends AggregateError {}

function toProtocolSessionMetadata(metadata: SessionMetadata): ProtocolSessionMetadata {
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

interface ActiveWatch {
	readonly id: string;
	readonly handle: HostedHarnessWatch;
	started: boolean;
}

interface ClientAttachment {
	readonly client: object;
	readonly session: HostedSession;
	readonly prompts: Set<Promise<RunResult>>;
	acquiring?: Promise<HostedHarnessAttachment>;
	lease?: HostedHarnessAttachment;
	releasing?: Promise<void>;
	watch?: ActiveWatch;
}

interface RpcContext {
	readonly client: object;
	readonly context: Context;
	publish(message: EventEnvelope, context: Context): Promise<void>;
}

interface HostedSession {
	readonly id: string;
	readonly harness: HostedHarnessHandle;
	attachment?: ClientAttachment;
}

interface HostedHarnessManagerOptions<TMetadata extends SessionMetadata> {
	host: PiServerHost<TMetadata>;
	isClosing: () => boolean;
	reportError: (error: unknown) => void;
}

export class HostedHarnessManager<TMetadata extends SessionMetadata = SessionMetadata> {
	private readonly options: HostedHarnessManagerOptions<TMetadata>;
	private readonly hostedSessions = new Map<string, HostedSession>();
	private readonly openingSessions = new Map<string, Promise<HostedSession>>();
	private readonly attachmentsByClient = new Map<object, ClientAttachment>();
	private readonly disconnectedClients = new Set<object>();
	private readonly clientOperations = new Map<object, Promise<void>>();
	private closePromise?: Promise<void>;
	private readonly dispatchRpc: (call: ServiceRpcCall, context: RpcContext) => Promise<ServiceRpcResultUnion>;

	constructor(options: HostedHarnessManagerOptions<TMetadata>) {
		this.options = options;
		this.dispatchRpc = createRpcDispatcher(
			ServiceRpc,
			{
				list: async ({ context }, ..._args: never[]) =>
					(await this.options.host.sessions.list(context)).map(toProtocolSessionMetadata),
				create: async ({ client, context }, createOptions) =>
					this.runForClient(client, async () => {
						if (this.options.isClosing() || this.disconnectedClients.has(client)) throw new ServerDrainingError();
						return toProtocolSessionMetadata(await this.options.host.sessions.create(createOptions, context));
					}),
				attach: async ({ client, context }, sessionId) => {
					if (this.options.isClosing()) throw new ServerDrainingError();
					return this.runForClient(client, () => this.attachClient(client, sessionId, context));
				},
				prompt: async ({ client, context }, sessionId, prompt) => {
					const admitted = await this.runForClient(client, () =>
						this.startPrompt(client, sessionId, prompt, context),
					);
					return admitted.result;
				},
				watch: ({ client, context }, sessionId) =>
					this.runForClient(client, () => this.createWatch(client, sessionId, context)),
				startWatch: ({ client, publish, context }, sessionId, watchId) =>
					this.runForClient(client, () => this.startWatch(client, sessionId, watchId, publish, context)),
				stopWatch: ({ client, context }, sessionId, watchId) =>
					this.runForClient(client, () => this.stopWatch(client, sessionId, watchId, context)),
			},
			(message) => new ProtocolValidationError(message),
		);
	}

	executeCall(
		call: ServiceRpcCall,
		client: object,
		publish: (message: EventEnvelope, context: Context) => Promise<void>,
		context: Context,
	): Promise<ServiceRpcResultUnion> {
		return this.dispatchRpc(call, { client, publish, context });
	}

	async disconnect(client: object, context: Context): Promise<void> {
		this.disconnectedClients.add(client);
		try {
			await this.runForClient(client, async () => {
				const attachment = this.attachmentsByClient.get(client);
				if (attachment) await this.releaseAttachment(attachment, context);
			});
		} finally {
			this.disconnectedClients.delete(client);
		}
	}

	close(context: Context): Promise<void> {
		this.closePromise ??= this.closeInternal(context);
		return this.closePromise;
	}

	private async closeInternal(context: Context): Promise<void> {
		const operationPromises = [...this.clientOperations.values()];
		const openingPromises = [...this.openingSessions.values()];
		const [operationResults, openingResults] = await Promise.all([
			Promise.allSettled(operationPromises),
			Promise.allSettled(openingPromises),
		]);
		const closeErrors: unknown[] = [];
		for (const result of [...operationResults, ...openingResults]) {
			if (result.status !== "rejected") continue;
			this.options.reportError(result.reason);
			if (result.reason instanceof HarnessCleanupError) closeErrors.push(result.reason);
		}
		const attachmentResults = await Promise.allSettled(
			[...this.hostedSessions.values()].flatMap((session) =>
				session.attachment ? [this.releaseAttachment(session.attachment, context)] : [],
			),
		);
		for (const result of attachmentResults) {
			if (result.status === "rejected") closeErrors.push(result.reason);
		}
		const hosted = [...this.hostedSessions.values()];
		const closeResults = await Promise.allSettled(hosted.map(({ harness }) => harness.close(context)));
		for (let index = 0; index < closeResults.length; index++) {
			const result = closeResults[index]!;
			const session = hosted[index]!;
			if (result.status === "fulfilled") {
				if (this.hostedSessions.get(session.id) === session) this.hostedSessions.delete(session.id);
				continue;
			}
			this.options.reportError(result.reason);
			closeErrors.push(result.reason);
		}
		this.attachmentsByClient.clear();
		this.clientOperations.clear();
		if (closeErrors.length > 0) throw new AggregateError(closeErrors, "Failed to close hosted Harnesses");
	}

	private runForClient<T>(client: object, operation: () => Promise<T>): Promise<T> {
		const previous = this.clientOperations.get(client) ?? Promise.resolve();
		const result = previous.catch(() => {}).then(operation);
		const tail = result.then(
			() => undefined,
			() => undefined,
		);
		this.clientOperations.set(client, tail);
		void tail.finally(() => {
			if (this.clientOperations.get(client) === tail) this.clientOperations.delete(client);
		});
		return result;
	}

	private async attachClient(client: object, sessionId: string, context: Context): Promise<{ sessionId: string }> {
		if (this.options.isClosing() || this.disconnectedClients.has(client)) throw new ServerDrainingError();
		const current = this.attachmentsByClient.get(client);
		if (current?.session.id === sessionId) return { sessionId };
		if (current) await this.releaseAttachment(current, context);

		const hosted = await this.acquire(sessionId, context);
		if (this.options.isClosing() || this.disconnectedClients.has(client)) throw new ServerDrainingError();
		const occupied = hosted.attachment;
		if (occupied) {
			if (occupied.client !== client) throw new SessionInUseError();
			return { sessionId };
		}

		const attachment: ClientAttachment = { client, session: hosted, prompts: new Set() };
		hosted.attachment = attachment;
		try {
			const acquiring = Promise.resolve(
				hosted.harness.attachClient ? hosted.harness.attachClient(context) : { release: (_context: Context) => {} },
			);
			attachment.acquiring = acquiring;
			attachment.lease = await acquiring;
		} catch (error) {
			if (hosted.attachment === attachment) hosted.attachment = undefined;
			throw error;
		}
		if (
			this.hostedSessions.get(hosted.id) !== hosted ||
			hosted.attachment !== attachment ||
			this.disconnectedClients.has(client) ||
			this.options.isClosing()
		) {
			await this.releaseAttachment(attachment, context);
			throw new ServerDrainingError();
		}
		this.attachmentsByClient.set(client, attachment);
		return { sessionId };
	}

	private async startPrompt(
		client: object,
		sessionId: string,
		prompt: PromptArguments,
		context: Context,
	): Promise<{ result: Promise<RunResult> }> {
		if (this.options.isClosing() || this.disconnectedClients.has(client)) throw new ServerDrainingError();
		const attachment = this.attachmentsByClient.get(client);
		if (!attachment || attachment.session.id !== sessionId) throw new SessionNotAttachedError();
		const result = attachment.session.harness.prompt(prompt, context);
		attachment.prompts.add(result);
		const remove = (): void => {
			attachment.prompts.delete(result);
		};
		void result.then(remove, remove);
		return { result };
	}

	private async createWatch(
		client: object,
		sessionId: string,
		context: Context,
	): Promise<{ watchId: string; snapshot: HostedHarnessWatch["snapshot"] }> {
		const attachment = this.requireAttachment(client, sessionId);
		if (attachment.watch !== undefined) throw new WatchInUseError();
		const create = attachment.session.harness.watch;
		if (create === undefined) throw new NotSupportedError("Hosted Harness does not support lane watches");
		const handle = await create.call(attachment.session.harness, context);
		const watch = { id: randomUUID(), handle, started: false } satisfies ActiveWatch;
		attachment.watch = watch;
		return { watchId: watch.id, snapshot: handle.snapshot };
	}

	private async startWatch(
		client: object,
		sessionId: string,
		watchId: string,
		publish: (message: EventEnvelope, context: Context) => Promise<void>,
		context: Context,
	): Promise<{ watchId: string }> {
		const attachment = this.requireAttachment(client, sessionId);
		const watch = attachment.watch;
		if (watch?.id !== watchId) throw new WatchNotFoundError();
		if (!watch.started) {
			watch.started = true;
			try {
				await watch.handle.start(
					(event, eventContext) => publish({ type: "event", watchId, event }, eventContext),
					context,
				);
			} catch (error) {
				delete attachment.watch;
				try {
					await watch.handle.unsubscribe(context);
				} catch (cleanupError) {
					throw new AggregateError([error, cleanupError], "Failed to start and clean up lane watch");
				}
				throw error;
			}
		}
		return { watchId };
	}

	private async stopWatch(
		client: object,
		sessionId: string,
		watchId: string,
		context: Context,
	): Promise<{ watchId: string }> {
		const attachment = this.requireAttachment(client, sessionId);
		const watch = attachment.watch;
		if (watch?.id !== watchId) throw new WatchNotFoundError();
		delete attachment.watch;
		await watch.handle.unsubscribe(context);
		return { watchId };
	}

	private requireAttachment(client: object, sessionId: string): ClientAttachment {
		if (this.options.isClosing() || this.disconnectedClients.has(client)) throw new ServerDrainingError();
		const attachment = this.attachmentsByClient.get(client);
		if (!attachment || attachment.session.id !== sessionId) throw new SessionNotAttachedError();
		return attachment;
	}

	private releaseAttachment(attachment: ClientAttachment, context: Context): Promise<void> {
		attachment.releasing ??= (async () => {
			const errors: unknown[] = [];
			try {
				const watch = attachment.watch;
				delete attachment.watch;
				try {
					await watch?.handle.unsubscribe(context);
				} catch (error) {
					errors.push(error);
				}
				await Promise.allSettled(attachment.prompts);
				try {
					const lease = attachment.lease ?? (await attachment.acquiring);
					if (lease) await lease.release(context);
				} catch (error) {
					errors.push(error);
				}
				if (errors.length === 1) throw errors[0];
				if (errors.length > 1) throw new AggregateError(errors, "Failed to release Session attachment");
			} finally {
				this.clearAttachment(attachment);
			}
		})();
		return attachment.releasing;
	}

	private clearAttachment(attachment: ClientAttachment): void {
		if (attachment.session.attachment === attachment) attachment.session.attachment = undefined;
		if (this.attachmentsByClient.get(attachment.client) === attachment) {
			this.attachmentsByClient.delete(attachment.client);
		}
	}

	private async acquire(sessionId: string, context: Context): Promise<HostedSession> {
		const existing = this.hostedSessions.get(sessionId);
		if (existing) return existing;
		const opening = this.openingSessions.get(sessionId);
		if (opening) return opening;
		const pending = this.open(sessionId, context);
		this.openingSessions.set(sessionId, pending);
		try {
			return await pending;
		} finally {
			if (this.openingSessions.get(sessionId) === pending) this.openingSessions.delete(sessionId);
		}
	}

	private async open(sessionId: string, context: Context): Promise<HostedSession> {
		const matches = (await this.options.host.sessions.list(context)).filter(
			(candidate) => candidate.id === sessionId,
		);
		if (matches.length === 0) throw new SessionNotFoundError(`Unknown session: ${sessionId}`);
		if (matches.length > 1) throw new SessionAmbiguousError();
		const metadata = matches[0]!;
		const harness = await this.options.host.createHarness(metadata, context);
		if (this.options.isClosing()) {
			try {
				await harness.close(context);
			} catch (error) {
				this.options.reportError(error);
				throw new HarnessCleanupError(
					[new ServerDrainingError(), error],
					"Failed to close Harness acquired while draining",
				);
			}
			throw new ServerDrainingError();
		}
		const hosted: HostedSession = { id: metadata.id, harness };
		this.hostedSessions.set(hosted.id, hosted);
		if (harness.terminated) {
			void harness.terminated.then(
				(error) => this.invalidate(hosted, error),
				(error: unknown) => this.invalidate(hosted, error instanceof Error ? error : new Error(String(error))),
			);
		}
		return hosted;
	}

	private invalidate(hosted: HostedSession, error: Error | undefined): void {
		if (this.hostedSessions.get(hosted.id) !== hosted) return;
		this.hostedSessions.delete(hosted.id);
		const attachment = hosted.attachment;
		if (attachment) {
			void this.releaseAttachment(attachment, BACKGROUND_CONTEXT).catch((releaseError: unknown) =>
				this.options.reportError(releaseError),
			);
		}
		if (error) this.options.reportError(error);
	}
}
