import {
	createRpcDispatcher,
	ProtocolValidationError,
	ServiceRpc,
	type ServiceRpcCall,
	type ServiceRpcResultUnion,
} from "@earendil-works/pi-protocol";
import { ServerDrainingError, SessionNotFoundError } from "./errors.ts";
import type { HostedHarnessHandle, PiServerHost } from "./types.ts";

class HarnessCleanupError extends AggregateError {}

interface HostedSession {
	readonly id: string;
	readonly harness: HostedHarnessHandle;
}

interface HostedHarnessManagerOptions {
	host: PiServerHost;
	isClosing: () => boolean;
	reportError: (error: unknown) => void;
}

export class HostedHarnessManager {
	private readonly options: HostedHarnessManagerOptions;
	private readonly hostedSessions = new Map<string, HostedSession>();
	private readonly openingSessions = new Map<string, Promise<HostedSession>>();
	private closePromise?: Promise<void>;
	private readonly dispatchRpc: (call: ServiceRpcCall, context: undefined) => Promise<ServiceRpcResultUnion>;

	constructor(options: HostedHarnessManagerOptions) {
		this.options = options;
		this.dispatchRpc = createRpcDispatcher(
			ServiceRpc,
			{
				list: () => this.options.host.sessions.list(),
				attach: async (_context, sessionId) => {
					if (this.options.isClosing()) throw new ServerDrainingError();
					const hosted = await this.acquire(sessionId);
					return { sessionId: hosted.id };
				},
			},
			(message) => new ProtocolValidationError(message),
		);
	}

	executeCall(call: ServiceRpcCall): Promise<ServiceRpcResultUnion> {
		return this.dispatchRpc(call, undefined);
	}

	close(): Promise<void> {
		this.closePromise ??= this.closeInternal();
		return this.closePromise;
	}

	private async closeInternal(): Promise<void> {
		const openingResults = await Promise.allSettled(this.openingSessions.values());
		const closeErrors: unknown[] = [];
		for (const result of openingResults) {
			if (result.status !== "rejected") continue;
			this.options.reportError(result.reason);
			if (result.reason instanceof HarnessCleanupError) closeErrors.push(result.reason);
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
		if (closeErrors.length > 0) throw new AggregateError(closeErrors, "Failed to close hosted Harnesses");
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
		const metadata = (await this.options.host.sessions.list()).find((candidate) => candidate.id === sessionId);
		if (!metadata) throw new SessionNotFoundError(`Unknown session: ${sessionId}`);
		const session = await this.options.host.sessions.open(metadata);
		let harness: HostedHarnessHandle;
		try {
			harness = await this.options.host.createHarness(session);
		} catch (error) {
			try {
				await session.close();
			} catch (closeError) {
				this.options.reportError(closeError);
				throw new HarnessCleanupError([error, closeError], "Harness creation and Session cleanup failed");
			}
			throw error;
		}
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
		if (error) this.options.reportError(error);
	}
}
