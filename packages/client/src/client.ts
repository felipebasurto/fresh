import {
	type AttachmentEnvelope,
	createRpcClient,
	createServiceCatalogueCall,
	createServiceSubscribeCall,
	createServiceUnsubscribeCall,
	encodeClientMessage,
	encodeServiceRpcCall,
	isServerId,
	type LaneEvent,
	type PromptArguments,
	type PromptImage,
	type PromptMessage,
	type ProtocolRpcCall,
	ProtocolValidationError,
	parseServiceCatalogue,
	parseServiceSubscriptionSnapshot,
	type ResponseEnvelope,
	type RpcTarget,
	type ServerEventEnvelope,
	type ServerHello,
	type ServiceCatalogueEntry,
	type ServiceMode,
	type ServiceProviderUpdate,
	ServiceRpc,
	type ServiceRpcCall,
	type ServiceRpcResult,
	type ServiceSubscriptionSnapshot,
	type SessionAddress,
	type SessionCreateOptions,
	type SessionSummary,
	type SessionTarget,
} from "@earendil-works/pi-protocol";
import { Connection } from "./connection.ts";
import { ClientDisposedError, DisconnectedError, ServerError, toError } from "./errors.ts";
import { createPromiseResolvers } from "./promise.ts";
import type {
	AttachmentChangeListener,
	ClientOptions,
	ConnectionState,
	ConnectionStateChange,
	LaneWatch,
	ServiceSubscription,
	Unsubscribe,
} from "./types.ts";

interface PendingRequest {
	resolve(result: unknown): void;
	reject(error: Error): void;
	cleanup(): void;
}

interface ActiveWatchListener {
	readonly listener: (event: LaneEvent) => void | Promise<void>;
	deliveryTail: Promise<void>;
}

interface ActiveServiceListener {
	readonly target: RpcTarget;
	readonly listener: (update: ServiceProviderUpdate) => void | Promise<void>;
	readonly queued: ServiceProviderUpdate[];
	deliveryTail: Promise<void>;
	ready: boolean;
}

export class Client {
	readonly #options: ClientOptions;
	readonly #connection: Connection;
	readonly #pendingRequests = new Map<string, PendingRequest>();
	readonly #connectionStateListeners = new Set<(change: ConnectionStateChange) => void>();
	readonly #attachmentListeners = new Set<AttachmentChangeListener>();
	readonly #watchListeners = new Map<string, ActiveWatchListener>();
	readonly #serviceListeners = new Map<string, ActiveServiceListener>();
	readonly #rpc: ReturnType<typeof createRpcClient<typeof ServiceRpc>>;
	#requestSequence = 0;
	#serviceSubscriptionSequence = 0;
	#hello: ServerHello | undefined;
	#attachment: SessionTarget | undefined;
	#disposed = false;
	#disposePromise: Promise<void> | undefined;

	constructor(options: ClientOptions) {
		if (!isServerId(options.serverId)) {
			throw new TypeError("serverId must be a canonical lowercase UUIDv4");
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

	get serverId(): string {
		return this.#options.serverId;
	}

	get hello(): ServerHello | undefined {
		return this.#hello;
	}

	get attachment(): SessionTarget | undefined {
		return this.#attachment;
	}

	static async connect(options: ClientOptions): Promise<Client> {
		const client = new Client(options);
		try {
			await client.connect();
			return client;
		} catch (error) {
			await client.dispose();
			throw error;
		}
	}

	connect(): Promise<ServerHello> {
		if (this.#disposed) return Promise.reject(new ClientDisposedError());
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

	onAttachmentChange(listener: AttachmentChangeListener): Unsubscribe {
		this.#assertNotDisposed();
		this.#attachmentListeners.add(listener);
		return () => this.#attachmentListeners.delete(listener);
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
			throw new ServerError({ code: "wrong_server", message: "Session belongs to another server" });
		}
		const result = await this.#request(
			{ serverId: this.#options.serverId },
			{ serviceId: "pi.session-management", member: "attach", args: [sessionId] },
		);
		if (
			typeof result === "object" &&
			result !== null &&
			"sessionId" in result &&
			"attachmentId" in result &&
			typeof result.sessionId === "string" &&
			typeof result.attachmentId === "string"
		) {
			this.#setAttachment({
				serverId: this.#options.serverId,
				sessionId: result.sessionId,
				attachmentId: result.attachmentId,
			});
		}
		const attachment = this.#attachment;
		if (attachment?.sessionId !== sessionId) {
			const error = new ProtocolValidationError("Session attach completed without a matching attachment route");
			this.#connection.fail(error);
			throw error;
		}
		return { sessionId, attachmentId: attachment.attachmentId };
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

	async serviceCatalogue(target: RpcTarget, signal?: AbortSignal): Promise<readonly ServiceCatalogueEntry[]> {
		const result = await this.#request(target, createServiceCatalogueCall(), signal);
		try {
			return parseServiceCatalogue(result);
		} catch (error) {
			const validationError = new ProtocolValidationError(
				error instanceof Error ? error.message : "Invalid service catalogue",
			);
			this.#connection.fail(validationError);
			throw validationError;
		}
	}

	async subscribeService(
		target: RpcTarget,
		serviceId: string,
		mode: ServiceMode,
		listener: (update: ServiceProviderUpdate) => void | Promise<void>,
		signal?: AbortSignal,
	): Promise<ServiceSubscription> {
		const subscriptionId = `service-${++this.#serviceSubscriptionSequence}`;
		const active: ActiveServiceListener = {
			target,
			listener,
			queued: [],
			deliveryTail: Promise.resolve(),
			ready: false,
		};
		this.#serviceListeners.set(subscriptionId, active);
		let snapshot: ServiceSubscriptionSnapshot;
		try {
			const result = await this.#request(
				target,
				createServiceSubscribeCall(subscriptionId, serviceId, mode),
				signal,
			);
			try {
				snapshot = parseServiceSubscriptionSnapshot(result);
			} catch (error) {
				const validationError = new ProtocolValidationError(
					error instanceof Error ? error.message : "Invalid service subscription snapshot",
				);
				this.#connection.fail(validationError);
				throw validationError;
			}
		} catch (error) {
			if (this.#serviceListeners.get(subscriptionId) === active) this.#serviceListeners.delete(subscriptionId);
			throw error;
		}
		if (this.#serviceListeners.get(subscriptionId) !== active) throw new DisconnectedError();
		let disposed = false;
		return {
			id: subscriptionId,
			target,
			snapshot,
			start: () => {
				if (disposed || active.ready) return;
				active.ready = true;
				for (const update of active.queued.splice(0)) this.#deliverServiceUpdate(active, update);
			},
			dispose: async () => {
				if (disposed) return;
				disposed = true;
				if (this.#serviceListeners.get(subscriptionId) === active) this.#serviceListeners.delete(subscriptionId);
				try {
					if (this.connected && this.#targetIsCurrent(target)) {
						await this.#request(target, createServiceUnsubscribeCall(subscriptionId));
					}
					await active.deliveryTail;
				} finally {
					active.queued.length = 0;
				}
			},
		};
	}

	async watchSession(sessionId: string): Promise<LaneWatch> {
		this.#requireSessionTarget(sessionId);
		const { watchId, snapshot } = await this.#rpc.watch();
		const connection = this.#hello;
		let currentSnapshot = snapshot;
		let state: "ready" | "starting" | "started" | "disposed" = "ready";
		return {
			id: watchId,
			sessionId,
			get snapshot() {
				return currentSnapshot;
			},
			start: async (listener) => {
				if (state !== "ready") throw new Error("Lane watch may be started only once");
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
			resnapshot: async () => {
				if (state === "disposed") throw new Error("Lane watch is disposed");
				this.#requireSessionTarget(sessionId);
				const refreshed = await this.#rpc.resnapshotWatch(watchId);
				currentSnapshot = refreshed.snapshot;
				return currentSnapshot;
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
		if (this.#disposed) return Promise.reject(new ClientDisposedError());
		if (!this.connected) return Promise.reject(new DisconnectedError());
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

	#handleMessage(message: ResponseEnvelope | ServerEventEnvelope | AttachmentEnvelope): void {
		if (message.type === "attachment") {
			if (message.attachment !== null && message.attachment.serverId !== this.#options.serverId) {
				this.#connection.fail(new ProtocolValidationError("Attachment update belongs to another server"));
				return;
			}
			this.#setAttachment(message.attachment ?? undefined);
			return;
		}
		if (message.type === "event") {
			const active = this.#watchListeners.get(message.watchId);
			if (active === undefined) return;
			active.deliveryTail = active.deliveryTail
				.then(() => active.listener(message.event))
				.catch((error: unknown) => this.#reportListenerError(error));
			return;
		}
		if (message.type === "service_update") {
			const active = this.#serviceListeners.get(message.subscriptionId);
			if (active === undefined) return;
			if (active.ready) this.#deliverServiceUpdate(active, message.update);
			else active.queued.push(message.update);
			return;
		}
		const pending = this.#takePendingRequest(message.id);
		if (!pending) {
			this.#connection.fail(new ProtocolValidationError("Response has no matching request"));
			return;
		}
		if (!message.ok) {
			pending.reject(new ServerError(message.error));
			return;
		}
		pending.resolve(message.result);
	}

	#handleConnectionStateChange(change: ConnectionStateChange): void {
		if (change.state === "disconnected") {
			this.#hello = undefined;
			this.#setAttachment(undefined);
			this.#rejectPendingRequests(change.error ?? new DisconnectedError());
			this.#watchListeners.clear();
			this.#serviceListeners.clear();
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
		const error = new ClientDisposedError();
		this.#rejectPendingRequests(error);
		this.#connection.disconnect(error);
		this.#hello = undefined;
		this.#setAttachment(undefined);
		this.#connectionStateListeners.clear();
		this.#attachmentListeners.clear();
		this.#watchListeners.clear();
		this.#serviceListeners.clear();
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
			case "resnapshotWatch":
			case "stopWatch":
				return this.#requireSessionTarget();
		}
	}

	#requireSessionTarget(sessionId?: string): SessionTarget {
		const attachment = this.#attachment;
		if (attachment === undefined || (sessionId !== undefined && attachment.sessionId !== sessionId)) {
			throw new ServerError({ code: "session_not_attached", message: "Session is not attached" });
		}
		return attachment;
	}

	#setAttachment(attachment: SessionTarget | undefined): void {
		const previous = this.#attachment;
		if (
			previous?.serverId === attachment?.serverId &&
			previous?.sessionId === attachment?.sessionId &&
			previous?.attachmentId === attachment?.attachmentId
		) {
			return;
		}
		this.#attachment = attachment;
		for (const listener of this.#attachmentListeners) {
			try {
				listener(attachment);
			} catch (error) {
				this.#reportListenerError(error);
			}
		}
	}

	#deliverServiceUpdate(active: ActiveServiceListener, update: ServiceProviderUpdate): void {
		active.deliveryTail = active.deliveryTail
			.then(() => active.listener(update))
			.catch((error: unknown) => this.#reportListenerError(error));
	}

	#targetIsCurrent(target: RpcTarget): boolean {
		if (!("sessionId" in target)) return this.#hello?.serverId === target.serverId;
		const attachment = this.#attachment;
		return (
			attachment?.serverId === target.serverId &&
			attachment.sessionId === target.sessionId &&
			attachment.attachmentId === target.attachmentId
		);
	}

	#assertNotDisposed(): void {
		if (this.#disposed) throw new ClientDisposedError();
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
