import {
	createRpcClient,
	encodeClientMessage,
	ProtocolValidationError,
	type ResponseEnvelope,
	type ServerHello,
	ServiceRpc,
	type ServiceRpcCall,
	type ServiceRpcResult,
	type ServiceRpcResultUnion,
	type SessionMetadata,
} from "@earendil-works/pi-protocol";
import { Connection } from "./connection.ts";
import { PiClientDisposedError, PiDisconnectedError, PiServerError, toError } from "./errors.ts";
import { createPromiseResolvers } from "./promise.ts";
import type { ConnectionState, ConnectionStateChange, PiClientOptions, Unsubscribe } from "./types.ts";

interface PendingRequest {
	call: ServiceRpcCall;
	resolve(result: ServiceRpcResultUnion): void;
	reject(error: Error): void;
}

export class PiClient {
	readonly #options: PiClientOptions;
	readonly #connection: Connection;
	readonly #pendingRequests = new Map<string, PendingRequest>();
	readonly #connectionStateListeners = new Set<(change: ConnectionStateChange) => void>();
	readonly #rpc: ReturnType<typeof createRpcClient<typeof ServiceRpc>>;
	#requestSequence = 0;
	#hello: ServerHello | undefined;
	#disposed = false;
	#disposePromise: Promise<void> | undefined;

	constructor(options: PiClientOptions) {
		if (!options.serviceId) throw new TypeError("PiClient serviceId must not be empty");
		this.#options = options;
		this.#connection = new Connection({
			transportFactory: options.transportFactory,
			serviceId: options.serviceId,
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

	attachSession(sessionId: string): Promise<ServiceRpcResult<"attach">> {
		return this.#rpc.attach(sessionId);
	}

	#request(call: ServiceRpcCall): Promise<ServiceRpcResultUnion> {
		if (this.#disposed) return Promise.reject(new PiClientDisposedError());
		if (!this.connected) return Promise.reject(new PiDisconnectedError());
		const id = `request-${++this.#requestSequence}`;
		const { promise, resolve, reject } = createPromiseResolvers<ServiceRpcResultUnion>();
		this.#pendingRequests.set(id, { call, resolve, reject });
		let frame: Uint8Array;
		try {
			frame = encodeClientMessage(
				{ type: "request", id, serviceId: this.#options.serviceId, call },
				{ maxFrameLength: this.#connection.maxFrameLength },
			);
		} catch (error) {
			this.#takePendingRequest(id)?.reject(toError(error));
			return promise;
		}
		this.#connection.send(frame);
		return promise;
	}

	#handleMessage(message: ResponseEnvelope): void {
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
