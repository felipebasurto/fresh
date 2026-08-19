import {
	createRpcClient,
	type EventEnvelope,
	encodeClientMessage,
	encodeServiceRpcCall,
	isServerId,
	type LaneEvent,
	type PromptArguments,
	type PromptImage,
	type PromptMessage,
	type ProtocolRpcCall,
	ProtocolValidationError,
	type ResponseEnvelope,
	type RpcTarget,
	type ServerHello,
	ServiceRpc,
	type ServiceRpcCall,
	type ServiceRpcResult,
	type SessionAddress,
	type SessionCreateOptions,
	type SessionSummary,
	type SessionTarget,
} from "@earendil-works/pi-protocol";
import { Connection } from "./connection.ts";
import { PiClientDisposedError, PiDisconnectedError, PiServerError, toError } from "./errors.ts";
import { createPromiseResolvers } from "./promise.ts";
import type { ConnectionState, ConnectionStateChange, PiClientOptions, PiLaneWatch, Unsubscribe } from "./types.ts";

interface PendingRequest {
	resolve(result: unknown): void;
	reject(error: Error): void;
	cleanup(): void;
}

interface ActiveWatchListener {
	readonly listener: (event: LaneEvent) => void | Promise<void>;
	deliveryTail: Promise<void>;
}

export class PiClient {
	readonly #options: PiClientOptions;
	readonly #connection: Connection;
	readonly #pendingRequests = new Map<string, PendingRequest>();
	readonly #connectionStateListeners = new Set<(change: ConnectionStateChange) => void>();
	readonly #watchListeners = new Map<string, ActiveWatchListener>();
	readonly #rpc: ReturnType<typeof createRpcClient<typeof ServiceRpc>>;
	#requestSequence = 0;
	#hello: ServerHello | undefined;
	#attachment: SessionTarget | undefined;
	#disposed = false;
	#disposePromise: Promise<void> | undefined;

	constructor(options: PiClientOptions) {
		if (!isServerId(options.serverId)) {
			throw new TypeError("PiClient serverId must be a canonical lowercase UUIDv4");
		}
		this.#options = options;
		this.#connection = new Connection({
			transportFactory: options.transportFactory,
			serverId: options.serverId,
			maxFrameLength: options.maxFrameLength,
			onHandshake: (hello) => {
				this.#hello = hello;
			},
			onMessage: (message) => this.#handleMessage(message),
			onStateChange: (change) => this.#handleConnectionStateChange(change),
		});
		this.#rpc = createRpcClient(
			ServiceRpc,
			(call) => this.#request(this.#targetForCall(call), encodeServiceRpcCall(call)),
			(message) => new ProtocolValidationError(message),
		);
	}

	get disposed(): boolean {
		return this.#disposed;
	}

	get connectionState(): ConnectionState {
		return this.#connection.state;
	}

	get connected(): boolean {
		return this.#connection.state === "connected";
	}

	get hello(): ServerHello | undefined {
		return this.#hello;
	}

	get attachment(): SessionTarget | undefined {
		return this.#attachment;
	}

	static async connect(options: PiClientOptions): Promise<PiClient> {
		const client = new PiClient(options);
		try {
			await client.connect();
			return client;
		} catch (error) {
			await client.dispose();
			throw error;
		}
	}

	connect(): Promise<ServerHello> {
		if (this.#disposed) return Promise.reject(new PiClientDisposedError());
		this.#hello = undefined;
		return this.#connection.connect();
	}

	reconnect(): Promise<ServerHello> {
		return this.connect();
	}

	disconnect(reason = "Client disconnected"): void {
		this.#connection.disconnect(reason);
	}

	onConnectionStateChange(listener: (change: ConnectionStateChange) => void): Unsubscribe {
		this.#assertNotDisposed();
		this.#connectionStateListeners.add(listener);
		return () => this.#connectionStateListeners.delete(listener);
	}

	/** Invoke one low-level protocol call against an explicit routed target. */
	request(target: RpcTarget, call: ProtocolRpcCall, signal?: AbortSignal): Promise<unknown> {
		return this.#request(target, call, signal);
	}

	listSessions(): Promise<readonly SessionSummary[]> {
		return this.#rpc.list();
	}

	createSession(options: SessionCreateOptions): Promise<ServiceRpcResult<"create">> {
		return this.#rpc.create(options);
	}

	async attachSession(session: string | SessionAddress): Promise<ServiceRpcResult<"attach">> {
		const sessionId = typeof session === "string" ? session : session.sessionId;
		if (typeof session !== "string" && session.serverId !== this.#options.serverId) {
			throw new PiServerError({ code: "wrong_server", message: "Session belongs to another server" });
		}
		const attached = await this.#rpc.attach(sessionId);
		this.#attachment = { serverId: this.#options.serverId, ...attached };
		return attached;
	}

	promptSession(sessionId: string, text: string, images?: PromptImage[]): Promise<ServiceRpcResult<"prompt">>;
	promptSession(sessionId: string, message: PromptMessage | PromptMessage[]): Promise<ServiceRpcResult<"prompt">>;
	promptSession(
		sessionId: string,
		message: string | PromptMessage | PromptMessage[],
		images?: PromptImage[],
	): Promise<ServiceRpcResult<"prompt">> {
		this.#requireSessionTarget(sessionId);
		if (typeof message === "string") {
			const prompt: PromptArguments = images === undefined ? [message] : [message, images];
			return this.#rpc.prompt(prompt);
		}
		if (Array.isArray(message)) return this.#rpc.prompt([message]);
		return this.#rpc.prompt([message]);
	}

	async watchSession(sessionId: string): Promise<PiLaneWatch> {
		this.#requireSessionTarget(sessionId);
		const { watchId, snapshot } = await this.#rpc.watch();
		const connection = this.#hello;
		let state: "ready" | "starting" | "started" | "disposed" = "ready";
		return {
			id: watchId,
			sessionId,
			snapshot,
			start: async (listener) => {
				if (state !== "ready") throw new Error("Pi lane watch may be started only once");
				if (this.#watchListeners.has(watchId)) {
					this.#connection.fail(new ProtocolValidationError("Server reused an active lane watch ID"));
					throw new ProtocolValidationError("Server reused an active lane watch ID");
				}
				state = "starting";
				this.#watchListeners.set(watchId, { listener, deliveryTail: Promise.resolve() });
				try {
					this.#requireSessionTarget(sessionId);
					await this.#rpc.startWatch(watchId);
					if (state === "starting") state = "started";
				} catch (error) {
					this.#watchListeners.delete(watchId);
					state = "disposed";
					throw error;
				}
			},
			dispose: async () => {
				if (state === "disposed") return;
				state = "disposed";
				const active = this.#watchListeners.get(watchId);
				try {
					if (this.connected && this.#hello === connection && this.#attachment?.sessionId === sessionId) {
						await this.#rpc.stopWatch(watchId);
					}
					await active?.deliveryTail;
				} finally {
					this.#watchListeners.delete(watchId);
				}
			},
		};
	}

	#request(target: RpcTarget, call: ProtocolRpcCall, signal?: AbortSignal): Promise<unknown> {
		if (this.#disposed) return Promise.reject(new PiClientDisposedError());
		if (!this.connected) return Promise.reject(new PiDisconnectedError());
		if (signal?.aborted) return Promise.reject(abortError(signal));
		const id = `request-${++this.#requestSequence}`;
		const { promise, resolve, reject } = createPromiseResolvers<unknown>();
		let sent = false;
		let aborted = false;
		let onAbort: (() => void) | undefined;
		const sendCancel = (): void => {
			if (!sent || !this.connected) return;
			try {
				this.#connection.send(
					encodeClientMessage({ type: "cancel", id, target }, { maxFrameLength: this.#connection.maxFrameLength }),
				);
			} catch (error) {
				this.#connection.fail(toError(error));
			}
		};
		if (signal !== undefined) {
			onAbort = () => {
				if (aborted) return;
				aborted = true;
				reject(abortError(signal));
				sendCancel();
			};
			signal.addEventListener("abort", onAbort, { once: true });
		}
		this.#pendingRequests.set(id, {
			resolve,
			reject,
			cleanup: () => {
				if (signal !== undefined && onAbort !== undefined) signal.removeEventListener("abort", onAbort);
			},
		});
		let frame: Uint8Array;
		try {
			frame = encodeClientMessage(
				{ type: "request", id, target, call },
				{ maxFrameLength: this.#connection.maxFrameLength },
			);
		} catch (error) {
			this.#takePendingRequest(id)?.reject(toError(error));
			return promise;
		}
		this.#connection.send(frame);
		sent = true;
		if (aborted) sendCancel();
		return promise;
	}

	#handleMessage(message: ResponseEnvelope | EventEnvelope): void {
		if (message.type === "event") {
			const active = this.#watchListeners.get(message.watchId);
			if (active === undefined) return;
			active.deliveryTail = active.deliveryTail
				.then(() => active.listener(message.event))
				.catch((error: unknown) => this.#reportListenerError(error));
			return;
		}
		const pending = this.#takePendingRequest(message.id);
		if (!pending) {
			this.#connection.fail(new ProtocolValidationError("Response has no matching request"));
			return;
		}
		if (!message.ok) {
			pending.reject(new PiServerError(message.error));
			return;
		}
		pending.resolve(message.result);
	}

	#handleConnectionStateChange(change: ConnectionStateChange): void {
		if (change.state === "disconnected") {
			this.#hello = undefined;
			this.#attachment = undefined;
			this.#rejectPendingRequests(change.error ?? new PiDisconnectedError());
			this.#watchListeners.clear();
		}
		for (const listener of this.#connectionStateListeners) {
			try {
				listener(change);
			} catch (error) {
				this.#reportListenerError(error);
			}
		}
	}

	#takePendingRequest(id: string): PendingRequest | undefined {
		const request = this.#pendingRequests.get(id);
		if (request) {
			this.#pendingRequests.delete(id);
			request.cleanup();
		}
		return request;
	}

	#rejectPendingRequests(error: Error): void {
		const requests = [...this.#pendingRequests.values()];
		this.#pendingRequests.clear();
		for (const request of requests) {
			request.cleanup();
			request.reject(error);
		}
	}

	dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		this.#disposed = true;
		this.#disposePromise = Promise.resolve();
		const error = new PiClientDisposedError();
		this.#rejectPendingRequests(error);
		this.#connection.disconnect(error);
		this.#hello = undefined;
		this.#attachment = undefined;
		this.#connectionStateListeners.clear();
		this.#watchListeners.clear();
		return this.#disposePromise;
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}

	#targetForCall(call: ServiceRpcCall): RpcTarget {
		switch (call.method) {
			case "list":
			case "create":
			case "attach":
				return { serverId: this.#options.serverId };
			case "prompt":
			case "watch":
			case "startWatch":
			case "stopWatch":
				return this.#requireSessionTarget();
		}
	}

	#requireSessionTarget(sessionId?: string): SessionTarget {
		const attachment = this.#attachment;
		if (attachment === undefined || (sessionId !== undefined && attachment.sessionId !== sessionId)) {
			throw new PiServerError({ code: "session_not_attached", message: "Session is not attached" });
		}
		return attachment;
	}

	#assertNotDisposed(): void {
		if (this.#disposed) throw new PiClientDisposedError();
	}

	#reportListenerError(error: unknown): void {
		if (!this.#options.onListenerError) return;
		try {
			this.#options.onListenerError(toError(error));
		} catch {
			// Diagnostics cannot affect protocol or transport state.
		}
	}
}

function abortError(signal: AbortSignal): Error {
	const reason: unknown = signal.reason;
	return reason instanceof Error ? reason : new DOMException("The operation was aborted", "AbortError");
}
