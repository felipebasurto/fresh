import type { SessionMetadata } from "@earendil-works/pi-agent-core";
import {
	createRpcDispatcher,
	type PromptArguments,
	type SessionMetadata as ProtocolSessionMetadata,
	ProtocolValidationError,
	type RunResult,
	ServiceRpc,
	type ServiceRpcCall,
	type ServiceRpcResultUnion,
} from "@earendil-works/pi-protocol";
import {
	ServerDrainingError,
	SessionAmbiguousError,
	SessionInUseError,
	SessionNotAttachedError,
	SessionNotFoundError,
} from "./errors.ts";
import type { HostedHarnessAttachment, HostedHarnessHandle, PiServerHost } from "./types.ts";

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

interface ClientAttachment {
	readonly client: object;
	readonly session: HostedSession;
	readonly prompts: Set<Promise<RunResult>>;
	acquiring?: Promise<HostedHarnessAttachment>;
	lease?: HostedHarnessAttachment;
	releasing?: Promise<void>;
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
	private readonly dispatchRpc: (call: ServiceRpcCall, client: object) => Promise<ServiceRpcResultUnion>;

	constructor(options: HostedHarnessManagerOptions<TMetadata>) {
		this.options = options;
		this.dispatchRpc = createRpcDispatcher(
			ServiceRpc,
			{
				list: async () => (await this.options.host.sessions.list()).map(toProtocolSessionMetadata),
				attach: async (client, sessionId) => {
					if (this.options.isClosing()) throw new ServerDrainingError();
					return this.runForClient(client, () => this.attachClient(client, sessionId));
				},
				prompt: async (client, sessionId, prompt) => {
					const admitted = await this.runForClient(client, () => this.startPrompt(client, sessionId, prompt));
					return admitted.result;
				},
			},
			(message) => new ProtocolValidationError(message),
		);
	}

	executeCall(call: ServiceRpcCall, client: object): Promise<ServiceRpcResultUnion> {
		return this.dispatchRpc(call, client);
	}

	async disconnect(client: object): Promise<void> {
		this.disconnectedClients.add(client);
		try {
			await this.runForClient(client, async () => {
				const attachment = this.attachmentsByClient.get(client);
				if (attachment) await this.releaseAttachment(attachment);
			});
		} finally {
			this.disconnectedClients.delete(client);
		}
	}

	close(): Promise<void> {
		this.closePromise ??= this.closeInternal();
		return this.closePromise;
	}

	private async closeInternal(): Promise<void> {
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
				session.attachment ? [this.releaseAttachment(session.attachment)] : [],
			),
		);
		for (const result of attachmentResults) {
			if (result.status === "rejected") closeErrors.push(result.reason);
		}
		const hosted = [...this.hostedSessions.values()];
		const closeResults = await Promise.allSettled(hosted.map(({ harness }) => harness.close()));
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

	private async attachClient(client: object, sessionId: string): Promise<{ sessionId: string }> {
		if (this.options.isClosing() || this.disconnectedClients.has(client)) throw new ServerDrainingError();
		const current = this.attachmentsByClient.get(client);
		if (current?.session.id === sessionId) return { sessionId };
		if (current) await this.releaseAttachment(current);

		const hosted = await this.acquire(sessionId);
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
				hosted.harness.attachClient ? hosted.harness.attachClient() : { release: () => {} },
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
			await this.releaseAttachment(attachment);
			throw new ServerDrainingError();
		}
		this.attachmentsByClient.set(client, attachment);
		return { sessionId };
	}

	private async startPrompt(
		client: object,
		sessionId: string,
		prompt: PromptArguments,
	): Promise<{ result: Promise<RunResult> }> {
		if (this.options.isClosing() || this.disconnectedClients.has(client)) throw new ServerDrainingError();
		const attachment = this.attachmentsByClient.get(client);
		if (!attachment || attachment.session.id !== sessionId) throw new SessionNotAttachedError();
		const result = attachment.session.harness.prompt(prompt);
		attachment.prompts.add(result);
		const remove = (): void => {
			attachment.prompts.delete(result);
		};
		void result.then(remove, remove);
		return { result };
	}

	private releaseAttachment(attachment: ClientAttachment): Promise<void> {
		attachment.releasing ??= (async () => {
			try {
				await Promise.allSettled(attachment.prompts);
				const lease = attachment.lease ?? (await attachment.acquiring);
				if (lease) await lease.release();
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

	private async acquire(sessionId: string): Promise<HostedSession> {
		const existing = this.hostedSessions.get(sessionId);
		if (existing) return existing;
		const opening = this.openingSessions.get(sessionId);
		if (opening) return opening;
		const pending = this.open(sessionId);
		this.openingSessions.set(sessionId, pending);
		try {
			return await pending;
		} finally {
			if (this.openingSessions.get(sessionId) === pending) this.openingSessions.delete(sessionId);
		}
	}

	private async open(sessionId: string): Promise<HostedSession> {
		const matches = (await this.options.host.sessions.list()).filter((candidate) => candidate.id === sessionId);
		if (matches.length === 0) throw new SessionNotFoundError(`Unknown session: ${sessionId}`);
		if (matches.length > 1) throw new SessionAmbiguousError();
		const metadata = matches[0]!;
		const harness = await this.options.host.createHarness(metadata);
		if (this.options.isClosing()) {
			try {
				await harness.close();
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
			void this.releaseAttachment(attachment).catch((releaseError: unknown) =>
				this.options.reportError(releaseError),
			);
		}
		if (error) this.options.reportError(error);
	}
}
