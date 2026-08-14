import type { SessionMetadata } from "@earendil-works/pi-agent-core";
import {
	createRpcDispatcher,
	ProtocolValidationError,
	ServiceRpc,
	type ServiceRpcCall,
	type ServiceRpcResultUnion,
} from "@earendil-works/pi-protocol";
import type { ConnectionState } from "./connection.ts";
import { ServerRestartingError, SessionNotFoundError } from "./errors.ts";
import type { HostedHarnessHandle, HostedSessionInfo, PiServerHost } from "./types.ts";

interface HostedSession {
	readonly id: string;
	readonly metadata: SessionMetadata;
	readonly harness: HostedHarnessHandle;
	readonly connections: Set<ConnectionState>;
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
	private readonly dispatchRpc: (call: ServiceRpcCall, connection: ConnectionState) => Promise<ServiceRpcResultUnion>;

	constructor(options: HostedHarnessManagerOptions) {
		this.options = options;
		this.dispatchRpc = createRpcDispatcher(
			ServiceRpc,
			{
				list: () => this.options.host.sessions.list(),
				attach: async (connection, sessionId) => {
					if (this.options.isClosing()) throw new ServerRestartingError();
					const hosted = await this.acquire(sessionId);
					if (connection.disconnected || connection.stage !== "ready" || connection.connection.closed) {
						throw new ServerRestartingError();
					}
					connection.sessionIds.add(hosted.id);
					hosted.connections.add(connection);
					return { sessionId: hosted.id };
				},
			},
			(message) => new ProtocolValidationError(message),
		);
	}

	get hosted(): readonly HostedSessionInfo[] {
		return [...this.hostedSessions.values()].map(({ id, metadata }) => ({ sessionId: id, metadata }));
	}

	executeCall(connection: ConnectionState, call: ServiceRpcCall): Promise<ServiceRpcResultUnion> {
		return this.dispatchRpc(call, connection);
	}

	disconnect(connection: ConnectionState): void {
		for (const sessionId of connection.sessionIds) this.hostedSessions.get(sessionId)?.connections.delete(connection);
		connection.sessionIds.clear();
	}

	async close(): Promise<void> {
		const openingResults = await Promise.allSettled(this.openingSessions.values());
		for (const result of openingResults) {
			if (result.status === "rejected") this.options.reportError(result.reason);
		}
		const hosted = [...this.hostedSessions.values()];
		this.hostedSessions.clear();
		const closeResults = await Promise.allSettled(hosted.map(({ harness }) => harness.close()));
		for (const result of closeResults) {
			if (result.status === "rejected") this.options.reportError(result.reason);
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
		const metadata = (await this.options.host.sessions.list()).find((candidate) => candidate.id === sessionId);
		if (!metadata) throw new SessionNotFoundError(`Unknown session: ${sessionId}`);
		const session = await this.options.host.sessions.open(metadata);
		let harness: HostedHarnessHandle;
		try {
			harness = await this.options.host.createHarness(session);
		} catch (error) {
			await session.close().catch((closeError: unknown) => this.options.reportError(closeError));
			throw error;
		}
		if (this.options.isClosing()) {
			await harness.close().catch((error: unknown) => this.options.reportError(error));
			throw new ServerRestartingError();
		}
		const hosted: HostedSession = { id: metadata.id, metadata, harness, connections: new Set() };
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
		for (const connection of hosted.connections) connection.sessionIds.delete(hosted.id);
		hosted.connections.clear();
		if (error) this.options.reportError(error);
	}
}
