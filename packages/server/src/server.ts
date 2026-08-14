import {
	type ClientHello,
	type ClientMessage,
	ClientMessageDecoder,
	DEFAULT_MAX_FRAME_LENGTH,
	encodeServerMessage,
	isServerId,
	isSupportedProtocolVersion,
	PROTOCOL_VERSION,
	type ProtocolError,
	type ProtocolRpcResult,
	ProtocolValidationError,
	type RequestEnvelope,
	type ResponseEnvelope,
	type ServerControlRpcResult,
	type ServerHello,
	type ServerHelloError,
	type ServerMessage,
} from "@earendil-works/pi-protocol";
import {
	type ByteConnection,
	type ByteConnectionHandler,
	type ConnectionState,
	isTerminalConnection,
} from "./connection.ts";
import { INTERNAL_SERVER_ERROR_MESSAGE, PiServerError, ServerDrainingError, WrongServerError } from "./errors.ts";
import { HostedHarnessManager } from "./hosted-harness-manager.ts";
import type { PiServerListener } from "./listener.ts";
import type { PiServerHost, PiServerOptions } from "./types.ts";

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const MAX_UINT32 = 0xffff_ffff;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export class PiServer {
	readonly serverId: string;
	/** Resolves after shutdown, or rejects when listener or hosted-Harness cleanup fails. */
	readonly closed: Promise<void>;

	private readonly listeners: readonly PiServerListener[];
	private readonly maxFrameLength: number;
	private readonly handshakeTimeoutMs: number;
	private readonly onError: ((error: Error) => void) | undefined;
	private readonly connections = new Set<ConnectionState>();
	private readonly sessions: HostedHarnessManager;
	private closing = false;
	private closePromise?: Promise<void>;
	private closedSettled = false;
	private rejectClosed!: (error: unknown) => void;
	private resolveClosed!: () => void;
	private startPromise?: Promise<this>;
	private started = false;

	constructor(host: PiServerHost, options: PiServerOptions) {
		const resolved = resolveOptions(options);
		this.listeners = options.listeners;
		this.serverId = options.serverId;
		this.maxFrameLength = resolved.maxFrameLength;
		this.handshakeTimeoutMs = resolved.handshakeTimeoutMs;
		this.onError = options.onError;
		this.sessions = new HostedHarnessManager({
			host,
			isClosing: () => this.closing,
			reportError: (error) => this.reportError(error),
		});
		this.closed = new Promise((resolve, reject) => {
			this.resolveClosed = resolve;
			this.rejectClosed = reject;
		});
		void this.closed.catch(() => {});
	}

	start(): Promise<this> {
		if (this.started) return Promise.reject(new Error("PiServer is already started"));
		if (this.startPromise) return Promise.reject(new Error("PiServer is already starting"));
		if (this.closing) return Promise.reject(new Error("PiServer is closing or closed"));
		this.startPromise = this.startInternal();
		return this.startPromise;
	}

	private async startInternal(): Promise<this> {
		const started: PiServerListener[] = [];
		try {
			for (const listener of this.listeners) {
				await listener.start((connection) => this.accept(connection));
				started.push(listener);
			}
			this.started = true;
			return this;
		} catch (error) {
			this.closing = true;
			const cleanupErrors: unknown[] = [];
			const listenerResults = await Promise.allSettled(started.map((listener) => listener.close()));
			for (const result of listenerResults) {
				if (result.status === "rejected") cleanupErrors.push(result.reason);
			}
			try {
				await this.closeServerState();
			} catch (cleanupError) {
				cleanupErrors.push(cleanupError);
			}
			if (cleanupErrors.length > 0) {
				const failure = new AggregateError([error, ...cleanupErrors], "Server startup and cleanup failed");
				this.settleClosed(failure);
				throw failure;
			}
			this.settleClosed();
			throw error;
		} finally {
			this.startPromise = undefined;
		}
	}

	accept(connection: ByteConnection): ByteConnectionHandler {
		if (this.closing) {
			void this.closeConnection(connection);
			return {
				onData: () => {},
				onClose: () => {},
				onError: (error) => this.reportError(error),
			};
		}

		let state: ConnectionState;
		const handshakeTimeout = setTimeout(() => {
			void this.failProtocol(state, {
				code: "invalid_request",
				message: "Handshake timeout",
			});
		}, this.handshakeTimeoutMs);
		handshakeTimeout.unref();
		state = {
			connection,
			decoder: new ClientMessageDecoder({ maxFrameLength: this.maxFrameLength }),
			stage: "awaitingHello",
			disconnected: false,
			handshakeTimeout,
		};
		this.connections.add(state);

		return {
			onData: (chunk) => this.receive(state, chunk),
			onClose: () => this.transportClosed(state),
			onError: (error) => {
				this.reportError(error);
				void this.closeConnection(connection).then(() => this.disconnect(state));
			},
		};
	}

	async close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		this.closePromise = this.closeInternal();
		return this.closePromise;
	}

	private async closeInternal(): Promise<void> {
		const starting = this.startPromise;
		if (starting) await starting.catch(() => {});
		const errors: unknown[] = [];
		const listenerResults = await Promise.allSettled(this.listeners.map((listener) => listener.close()));
		for (const result of listenerResults) {
			if (result.status === "rejected") errors.push(result.reason);
		}
		try {
			await this.closeServerState();
		} catch (error) {
			errors.push(error);
		}
		this.started = false;
		if (errors.length > 0) {
			const failure =
				errors.length === 1 && errors[0] instanceof Error
					? errors[0]
					: new AggregateError(errors, "Server shutdown failed");
			this.settleClosed(failure);
			throw failure;
		}
		this.settleClosed();
	}

	private receive(state: ConnectionState, chunk: Uint8Array): void {
		if (isTerminalConnection(state)) return;
		let messages: ClientMessage[];
		try {
			messages = state.decoder.push(chunk);
		} catch (error) {
			void this.failProtocol(state, this.toProtocolError(error));
			return;
		}
		for (const message of messages) {
			if (isTerminalConnection(state)) return;
			this.dispatchMessage(state, message);
		}
	}

	private dispatchMessage(state: ConnectionState, message: ClientMessage): void {
		if (state.stage === "awaitingHello") {
			if (message.type !== "hello") {
				void this.failProtocol(state, {
					code: "invalid_request",
					message: "The first client message must be hello",
				});
				return;
			}
			state.stage = "handshaking";
			state.handshake = this.finishHandshake(state, message).catch((error: unknown) =>
				this.failProtocol(state, this.toProtocolError(error)),
			);
			return;
		}

		if (message.type === "hello") {
			void this.failProtocol(state, {
				code: "invalid_request",
				message: "hello may only be sent as the first message",
			});
			return;
		}

		if (state.stage === "ready") {
			void this.handleRequest(state, message);
			return;
		}
		if (state.stage !== "handshaking") return;
		const handshake = state.handshake;
		if (!handshake) return;
		void handshake.then(() => {
			if (state.stage === "ready" && !state.disconnected) void this.handleRequest(state, message);
		});
	}

	private async finishHandshake(state: ConnectionState, hello: ClientHello): Promise<void> {
		if (!isSupportedProtocolVersion(hello.version)) {
			await this.failProtocol(state, {
				code: "version",
				message: `Unsupported protocol version ${hello.version}; expected ${PROTOCOL_VERSION}`,
			});
			return;
		}

		if (this.closing || state.disconnected || state.stage !== "handshaking" || state.connection.closed) return;
		const sent = await this.sendMessage(state, {
			type: "hello",
			version: PROTOCOL_VERSION,
			serverId: this.serverId,
		} satisfies ServerHello);
		if (sent && !state.disconnected && state.stage === "handshaking") {
			state.stage = "ready";
			clearTimeout(state.handshakeTimeout);
		}
	}

	private async handleRequest(state: ConnectionState, envelope: RequestEnvelope): Promise<void> {
		const draining = envelope.call.method === "drain";
		let ownsDrain = false;
		try {
			if (envelope.serverId !== this.serverId) throw new WrongServerError();
			let result: ProtocolRpcResult;
			if (draining) {
				if (this.closing) throw new ServerDrainingError();
				this.closing = true;
				ownsDrain = true;
				result = await this.drain();
			} else {
				result = await this.sessions.executeCall(envelope.call);
			}
			await this.sendMessage(state, {
				type: "response",
				id: envelope.id,
				ok: true,
				result,
			} satisfies ResponseEnvelope);
		} catch (error) {
			await this.sendMessage(state, {
				type: "response",
				id: envelope.id,
				ok: false,
				error: this.toProtocolError(error),
			} satisfies ResponseEnvelope);
		} finally {
			if (ownsDrain) this.scheduleClose();
		}
	}

	private async drain(): Promise<ServerControlRpcResult<"drain">> {
		await this.sessions.close();
		return {};
	}

	private scheduleClose(): void {
		void this.close().catch((error: unknown) => this.reportError(error));
	}

	private transportClosed(connection: ConnectionState): void {
		if (!connection.disconnected && connection.stage !== "closing") {
			try {
				connection.decoder.end();
			} catch (error) {
				this.reportError(error);
			}
		}
		this.disconnect(connection);
	}

	private disconnect(connection: ConnectionState): void {
		if (connection.disconnected) return;
		connection.disconnected = true;
		connection.stage = "closed";
		clearTimeout(connection.handshakeTimeout);
		this.connections.delete(connection);
	}

	private async sendMessage(connection: ConnectionState, message: ServerMessage): Promise<boolean> {
		if (connection.disconnected || connection.connection.closed) return false;
		let frame: Uint8Array;
		try {
			frame = encodeServerMessage(message, { maxFrameLength: this.maxFrameLength });
		} catch (error) {
			this.reportError(error);
			await this.closeConnection(connection.connection);
			this.disconnect(connection);
			return false;
		}
		try {
			await connection.connection.send(frame);
			return true;
		} catch (error) {
			this.reportError(error);
			await this.closeConnection(connection.connection);
			this.disconnect(connection);
			return false;
		}
	}

	private async failProtocol(connection: ConnectionState, error: ProtocolError): Promise<void> {
		if (connection.disconnected || connection.stage === "closing" || connection.stage === "closed") return;
		connection.stage = "closing";
		clearTimeout(connection.handshakeTimeout);
		const message: ServerHelloError = { type: "hello_error", error };
		let finalFrame: Uint8Array | undefined;
		try {
			finalFrame = encodeServerMessage(message, { maxFrameLength: this.maxFrameLength });
		} catch (encodeError) {
			this.reportError(encodeError);
		}
		await this.closeConnection(connection.connection, finalFrame);
		this.disconnect(connection);
	}

	private async closeServerState(): Promise<void> {
		const connections = [...this.connections];
		for (const connection of connections) {
			connection.stage = "closing";
			clearTimeout(connection.handshakeTimeout);
		}
		await Promise.all(connections.map((connection) => this.closeConnection(connection.connection)));
		for (const connection of connections) this.disconnect(connection);
		await this.sessions.close();
		this.connections.clear();
	}

	private async closeConnection(connection: ByteConnection, finalChunk?: Uint8Array): Promise<void> {
		try {
			await connection.close(finalChunk);
		} catch (error) {
			this.reportError(error);
		}
	}

	private toProtocolError(error: unknown): ProtocolError {
		if (error instanceof PiServerError) {
			return { code: error.code, message: error.message };
		}
		if (error instanceof ProtocolValidationError) {
			return { code: "invalid_request", message: error.message };
		}
		this.reportError(error);
		return { code: "internal_error", message: INTERNAL_SERVER_ERROR_MESSAGE };
	}

	private reportError(error: unknown): void {
		try {
			this.onError?.(error instanceof Error ? error : new Error(String(error)));
		} catch {
			// Error observers cannot affect server state.
		}
	}

	private settleClosed(error?: unknown): void {
		if (this.closedSettled) return;
		this.closedSettled = true;
		if (error === undefined) this.resolveClosed();
		else this.rejectClosed(error);
	}
}

function resolveOptions(options: PiServerOptions): { maxFrameLength: number; handshakeTimeoutMs: number } {
	if (!Array.isArray(options.listeners)) throw new TypeError("PiServer listeners must be an array");
	if (!isServerId(options.serverId)) {
		throw new TypeError("PiServer serverId must be a canonical lowercase UUIDv4");
	}
	const maxFrameLength = options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
	if (!Number.isSafeInteger(maxFrameLength) || maxFrameLength <= 0 || maxFrameLength > MAX_UINT32) {
		throw new TypeError(`PiServer maxFrameLength must be an integer between 1 and ${MAX_UINT32}`);
	}
	const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
	if (
		!Number.isSafeInteger(handshakeTimeoutMs) ||
		handshakeTimeoutMs <= 0 ||
		handshakeTimeoutMs > MAX_TIMER_DELAY_MS
	) {
		throw new TypeError(`PiServer handshakeTimeoutMs must be an integer between 1 and ${MAX_TIMER_DELAY_MS}`);
	}
	return { maxFrameLength, handshakeTimeoutMs };
}
