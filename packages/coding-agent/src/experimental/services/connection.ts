import {
	BACKGROUND_CONTEXT,
	type Context,
	type ServiceProviderUpdate as CoreServiceProviderUpdate,
	freshDeliveryContext,
	isJsonValue,
	type MutableReplicatedState,
	type RemoteServiceConnection,
	RemoteServiceNamespace,
	type RemoteServiceNamespaceApi,
	type ReplicatedState,
	remoteState,
} from "@earendil-works/pi-agent-core";
import type { Client } from "@earendil-works/pi-client";
import type { ProtocolRpcCall, RpcTarget, ServiceProviderUpdate, SessionTarget } from "@earendil-works/pi-protocol";
import { BUILTIN_SERVER_SERVICES, BUILTIN_SESSION_SERVICES } from "./builtins.ts";

export type ServerConnectionState =
	| { status: "connecting"; attempt: number }
	| { status: "connected"; since: string }
	| { status: "disconnected"; since: string; reason: string; retryAt: string | null };

export type SessionAttachmentState =
	| { status: "detached" }
	| { status: "attaching" | "attached" | "degraded"; sessionId: string };

export interface ServerServices extends RemoteServiceNamespaceApi {
	readonly connection: ReplicatedState<ServerConnectionState>;
	activate(context: Context): Promise<void>;
}

export interface SessionServices extends RemoteServiceNamespaceApi {
	readonly attachment: ReplicatedState<SessionAttachmentState>;
	activate(context: Context): Promise<void>;
	/** Wait for the exact current attachment generation to finish hydrating. */
	whenAttached(sessionId: string, context: Context): Promise<void>;
	/** Wait for the detached namespace to finish releasing its prior binding. */
	whenDetached(context: Context): Promise<void>;
}

export interface ServiceNamespaceOptions {
	readonly services: readonly { readonly id: string }[];
	readonly onError?: (error: Error) => void;
	readonly deferred?: boolean;
}

class ServerServiceNamespace extends RemoteServiceNamespace implements ServerServices {
	readonly connection: ReplicatedState<ServerConnectionState>;
	readonly #removeConnectionListener: () => void;
	readonly #onError: ((error: Error) => void) | undefined;
	#transition = Promise.resolve();
	#connectionAttempt: number;
	#enabled: boolean;

	constructor(client: Client, connection: RemoteServiceConnection, options: ServiceNamespaceOptions) {
		const enabled = options.deferred !== true;
		super({
			services: options.services,
			connection,
			bound: enabled && client.connected,
			...(options.onError === undefined ? {} : { onError: options.onError }),
		});
		this.#onError = options.onError;
		this.#enabled = enabled;
		this.#connectionAttempt = client.connectionState === "connecting" ? 1 : 0;
		const connectionState = remoteState<ServerConnectionState>(
			toServerConnectionState(client, this.#connectionAttempt),
		);
		this.connection = connectionState;
		this.#removeConnectionListener = client.onConnectionStateChange(({ state, error }) => {
			if (state === "connecting") this.#connectionAttempt += 1;
			connectionState.set(toServerConnectionState(client, this.#connectionAttempt, error), BACKGROUND_CONTEXT);
			if (!this.#enabled) return;
			this.#transition = this.#transition
				.then(() => this.rebind(state === "connected", BACKGROUND_CONTEXT))
				.catch((transitionError: unknown) => this.#onError?.(toError(transitionError)));
		});
	}

	async activate(context: Context): Promise<void> {
		if (!this.#enabled) {
			this.#enabled = true;
			this.#transition = this.#transition.then(() =>
				this.rebind(this.connection.value?.status === "connected", context),
			);
		}
		await this.ready(context);
	}

	override async ready(context: Context): Promise<void> {
		while (true) {
			const transition = this.#transition;
			await transition;
			await super.ready(context);
			if (transition === this.#transition) return;
		}
	}

	override async dispose(context: Context): Promise<void> {
		this.#removeConnectionListener();
		await this.#transition;
		await super.dispose(context);
	}
}

class SessionServiceNamespace extends RemoteServiceNamespace implements SessionServices {
	readonly attachment: ReplicatedState<SessionAttachmentState>;
	readonly #client: Client;
	readonly #attachmentState: MutableReplicatedState<SessionAttachmentState>;
	readonly #removeAttachmentListener: () => void;
	readonly #onError: ((error: Error) => void) | undefined;
	readonly #transitions = new Set<Promise<void>>();
	#attachmentRevision = 0;
	#enabled: boolean;

	constructor(client: Client, connection: RemoteServiceConnection, options: ServiceNamespaceOptions) {
		const enabled = options.deferred !== true;
		super({
			services: options.services,
			connection,
			bound: enabled && client.attachment !== undefined,
			...(options.onError === undefined ? {} : { onError: options.onError }),
		});
		this.#client = client;
		this.#onError = options.onError;
		this.#enabled = enabled;
		this.#attachmentState = remoteState<SessionAttachmentState>(
			client.attachment === undefined
				? { status: "detached" }
				: { status: "attaching", sessionId: client.attachment.sessionId },
		);
		this.attachment = this.#attachmentState;
		this.#removeAttachmentListener = client.onAttachmentChange((attachment) => {
			const revision = ++this.#attachmentRevision;
			if (attachment !== undefined) {
				this.#attachmentState.set({ status: "attaching", sessionId: attachment.sessionId }, BACKGROUND_CONTEXT);
			} else if (!this.#enabled) {
				this.#attachmentState.set({ status: "detached" }, BACKGROUND_CONTEXT);
			}
			if (!this.#enabled) return;
			const transition = this.rebind(attachment !== undefined, BACKGROUND_CONTEXT);
			this.#transitions.add(transition);
			void transition.then(
				() => {
					this.#transitions.delete(transition);
					if (this.#attachmentRevision !== revision || !sameAttachment(this.#client.attachment, attachment))
						return;
					this.#attachmentState.set(
						attachment === undefined
							? { status: "detached" }
							: { status: "attached", sessionId: attachment.sessionId },
						BACKGROUND_CONTEXT,
					);
				},
				(error: unknown) => {
					this.#transitions.delete(transition);
					if (this.#attachmentRevision !== revision || !sameAttachment(this.#client.attachment, attachment))
						return;
					if (attachment === undefined) {
						this.#attachmentState.set({ status: "detached" }, BACKGROUND_CONTEXT);
					} else {
						this.#attachmentState.set(
							{ status: "degraded", sessionId: attachment.sessionId },
							BACKGROUND_CONTEXT,
						);
					}
					this.#onError?.(toError(error));
				},
			);
		});
	}

	async activate(context: Context): Promise<void> {
		if (!this.#enabled) {
			this.#enabled = true;
			const transition = this.rebind(this.#client.attachment !== undefined, context);
			this.#transitions.add(transition);
			await transition.finally(() => this.#transitions.delete(transition));
		}
		await this.ready(context);
	}

	override async ready(context: Context): Promise<void> {
		const attachment = this.#client.attachment;
		const revision = this.#attachmentRevision;
		if (attachment === undefined) await this.#whenDetached(revision, context);
		else await this.#whenAttached(attachment, revision, context);
	}

	async whenAttached(sessionId: string, context: Context): Promise<void> {
		const attachment = this.#client.attachment;
		if (attachment === undefined || attachment.sessionId !== sessionId) {
			throw new Error(`Session ${sessionId} is not the current attachment`);
		}
		await this.#whenAttached(attachment, this.#attachmentRevision, context);
	}

	async whenDetached(context: Context): Promise<void> {
		if (this.#client.attachment !== undefined) throw new Error("A Session is still attached");
		await this.#whenDetached(this.#attachmentRevision, context);
	}

	override async dispose(context: Context): Promise<void> {
		this.#removeAttachmentListener();
		await Promise.allSettled(this.#transitions);
		await super.dispose(context);
	}

	async #whenAttached(attachment: SessionTarget, revision: number, context: Context): Promise<void> {
		try {
			await super.ready(context);
		} catch (error) {
			if (this.#attachmentRevision === revision && sameAttachment(this.#client.attachment, attachment)) {
				this.#attachmentState.set({ status: "degraded", sessionId: attachment.sessionId }, context);
			}
			throw error;
		}
		if (this.#attachmentRevision !== revision || !sameAttachment(this.#client.attachment, attachment)) {
			throw new Error(`Session ${attachment.sessionId} was replaced while attaching`);
		}
		const state = this.#attachmentState.value;
		if (state.status !== "attached" || state.sessionId !== attachment.sessionId) {
			this.#attachmentState.set({ status: "attached", sessionId: attachment.sessionId }, context);
		}
	}

	async #whenDetached(revision: number, context: Context): Promise<void> {
		await super.ready(context);
		if (this.#attachmentRevision !== revision || this.#client.attachment !== undefined) {
			throw new Error("The Session attachment changed while detaching");
		}
		if (this.#attachmentState.value.status !== "detached") {
			this.#attachmentState.set({ status: "detached" }, context);
		}
	}
}

/** Bind plugin service facades to the connected server route. */
export function createServerServiceNamespace(client: Client, options: ServiceNamespaceOptions): ServerServices {
	const connection = createServiceConnection(client, () => ({ serverId: client.serverId }));
	return new ServerServiceNamespace(client, connection, options);
}

/** Bind every built-in server service expected by the presentation host. */
export function createBuiltinServerServiceNamespace(
	client: Client,
	options: Omit<ServiceNamespaceOptions, "services"> = {},
): ServerServices {
	return createServerServiceNamespace(client, { ...options, services: BUILTIN_SERVER_SERVICES });
}

/** Bind plugin service facades to the client's selected Session route. */
export function createSessionServiceNamespace(client: Client, options: ServiceNamespaceOptions): SessionServices {
	const connection = createServiceConnection(client, () => client.attachment);
	return new SessionServiceNamespace(client, connection, options);
}

/** Bind every built-in Session service expected by the presentation host. */
export function createBuiltinSessionServiceNamespace(
	client: Client,
	options: Omit<ServiceNamespaceOptions, "services"> = {},
): SessionServices {
	return createSessionServiceNamespace(client, { ...options, services: BUILTIN_SESSION_SERVICES });
}

function createServiceConnection(client: Client, getTarget: () => RpcTarget | undefined): RemoteServiceConnection {
	return {
		invoke: async (call, context) => {
			const target = getTarget();
			if (target === undefined) throw new Error("Service namespace is not routed");
			const wireCall: ProtocolRpcCall = {
				serviceId: call.serviceId,
				...(call.instance === undefined ? {} : { instance: call.instance }),
				member: call.member,
				args: [...call.args],
			};
			const result = await client.request(target, wireCall, context.abortSignal);
			if (result !== undefined && !isJsonValue(result)) throw new Error("Service returned a non-JSON result");
			return result;
		},
		subscribe: async (serviceId, mode, listener, context) => {
			const target = getTarget();
			if (target === undefined) throw new Error("Service namespace is not routed");
			const subscription = await client.subscribeService(
				target,
				serviceId,
				mode,
				(update: ServiceProviderUpdate) =>
					listener(update as unknown as CoreServiceProviderUpdate, freshDeliveryContext()),
				context.abortSignal,
			);
			return {
				snapshot: subscription.snapshot,
				activate: () => subscription.start(),
				close: () => subscription.dispose(),
			};
		},
	};
}

function toServerConnectionState(client: Client, attempt: number, error?: Error): ServerConnectionState {
	const since = new Date().toISOString();
	switch (client.connectionState) {
		case "connecting":
			return { status: "connecting", attempt };
		case "connected":
			return { status: "connected", since };
		case "disconnected":
			return {
				status: "disconnected",
				since,
				reason: error?.message ?? "Client is disconnected",
				retryAt: null,
			};
	}
}

function sameAttachment(left: SessionTarget | undefined, right: SessionTarget | undefined): boolean {
	if (left === undefined || right === undefined) return left === right;
	return (
		left.serverId === right.serverId && left.sessionId === right.sessionId && left.attachmentId === right.attachmentId
	);
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
