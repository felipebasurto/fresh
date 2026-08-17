import {
	createRpcClient,
	type EventEnvelope,
	encodeClientMessage,
	isServerId,
	type LaneEvent,
	type PromptArguments,
	type PromptImage,
	type PromptMessage,
	ProtocolValidationError,
	type ResponseEnvelope,
	type ServerHello,
	ServiceRpc,
	type ServiceRpcCall,
	type ServiceRpcResult,
	type SessionCreateOptions,
	type SessionMetadata,
} from "@earendil-works/pi-protocol";
import { Connection } from "./connection.ts";
import { PiClientDisposedError, PiDisconnectedError, PiServerError, toError } from "./errors.ts";
import { createPromiseResolvers } from "./promise.ts";
import type { ConnectionState, ConnectionStateChange, PiClientOptions, PiLaneWatch, Unsubscribe } from "./types.ts";

interface PendingRequest {
	resolve(result: unknown): void;
	reject(error: Error): void;
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
			(call) => this.#request(call),
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

	listSessions(): Promise<readonly SessionMetadata[]> {
		return this.#rpc.list();
	}

	createSession(options: SessionCreateOptions): Promise<ServiceRpcResult<"create">> {
		return this.#rpc.create(options);
	}

	attachSession(sessionId: string): Promise<ServiceRpcResult<"attach">> {
		return this.#rpc.attach(sessionId);
	}

	promptSession(sessionId: string, text: string, images?: PromptImage[]): Promise<ServiceRpcResult<"prompt">>;
	promptSession(sessionId: string, message: PromptMessage | PromptMessage[]): Promise<ServiceRpcResult<"prompt">>;
	promptSession(
		sessionId: string,
		message: string | PromptMessage | PromptMessage[],
		images?: PromptImage[],
	): Promise<ServiceRpcResult<"prompt">> {
		if (typeof message === "string") {
			const prompt: PromptArguments = images === undefined ? [message] : [message, images];
			return this.#rpc.prompt(sessionId, prompt);
		}
		if (Array.isArray(message)) return this.#rpc.prompt(sessionId, [message]);
		return this.#rpc.prompt(sessionId, [message]);
	}

	async watchSession(sessionId: string): Promise<PiLaneWatch> {
		const { watchId, snapshot } = await this.#rpc.watch(sessionId);
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
					await this.#rpc.startWatch(sessionId, watchId);
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
					if (this.connected && this.#hello === connection) await this.#rpc.stopWatch(sessionId, watchId);
					await active?.deliveryTail;
				} finally {
					this.#watchListeners.delete(watchId);
				}
			},
		};
	}

	#request(call: ServiceRpcCall): Promise<unknown> {
		if (this.#disposed) return Promise.reject(new PiClientDisposedError());
		if (!this.connected) return Promise.reject(new PiDisconnectedError());
		const id = `request-${++this.#requestSequence}`;
		const { promise, resolve, reject } = createPromiseResolvers<unknown>();
		this.#pendingRequests.set(id, { resolve, reject });
		let frame: Uint8Array;
		try {
			frame = encodeClientMessage(
				{ type: "request", id, serverId: this.#options.serverId, call },
				{ maxFrameLength: this.#connection.maxFrameLength },
			);
		} catch (error) {
			this.#takePendingRequest(id)?.reject(toError(error));
			return promise;
		}
		this.#connection.send(frame);
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
		if (request) this.#pendingRequests.delete(id);
		return request;
	}

	#rejectPendingRequests(error: Error): void {
		const requests = [...this.#pendingRequests.values()];
		this.#pendingRequests.clear();
		for (const request of requests) request.reject(error);
	}

	dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		this.#disposed = true;
		this.#disposePromise = Promise.resolve();
		const error = new PiClientDisposedError();
		this.#rejectPendingRequests(error);
		this.#connection.disconnect(error);
		this.#hello = undefined;
		this.#connectionStateListeners.clear();
		this.#watchListeners.clear();
		return this.#disposePromise;
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
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
