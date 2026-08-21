import {
	BACKGROUND_CONTEXT,
	type Context,
	type ServiceProviderUpdate as CoreServiceProviderUpdate,
	freshDeliveryContext,
	isJsonValue,
	type RemoteServiceConnection,
	RemoteServiceNamespace,
	type RemoteServiceNamespaceApi,
	type ReplicatedState,
	remoteState,
} from "@earendil-works/pi-agent-core";
import type { Client } from "@earendil-works/pi-client";
import type { ProtocolRpcCall, RpcTarget, ServiceProviderUpdate } from "@earendil-works/pi-protocol";
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
}

export interface SessionServices extends RemoteServiceNamespaceApi {
	readonly attachment: ReplicatedState<SessionAttachmentState>;
}

export interface ServiceNamespaceOptions {
	readonly services: readonly { readonly id: string }[];
	readonly onError?: (error: Error) => void;
}

class ServerServiceNamespace extends RemoteServiceNamespace implements ServerServices {
	readonly connection: ReplicatedState<ServerConnectionState>;
	readonly #removeConnectionListener: () => void;
	readonly #onError: ((error: Error) => void) | undefined;
	#transition = Promise.resolve();
	#connectionAttempt: number;

	constructor(client: Client, connection: RemoteServiceConnection, options: ServiceNamespaceOptions) {
		super({
			services: options.services,
			connection,
			bound: client.connected,
			...(options.onError === undefined ? {} : { onError: options.onError }),
		});
		this.#onError = options.onError;
		this.#connectionAttempt = client.connectionState === "connecting" ? 1 : 0;
		const connectionState = remoteState<ServerConnectionState>(
			toServerConnectionState(client, this.#connectionAttempt),
		);
		this.connection = connectionState;
		this.#removeConnectionListener = client.onConnectionStateChange(({ state, error }) => {
			if (state === "connecting") this.#connectionAttempt += 1;
			connectionState.set(toServerConnectionState(client, this.#connectionAttempt, error), BACKGROUND_CONTEXT);
			this.#transition = this.#transition
				.then(() => this.rebind(state === "connected", BACKGROUND_CONTEXT))
				.catch((transitionError: unknown) => this.#onError?.(toError(transitionError)));
		});
	}

	override async dispose(context: Context): Promise<void> {
		this.#removeConnectionListener();
		await this.#transition;
		await super.dispose(context);
	}
}

class SessionServiceNamespace extends RemoteServiceNamespace implements SessionServices {
	readonly attachment: ReplicatedState<SessionAttachmentState>;
	readonly #removeAttachmentListener: () => void;
	readonly #onError: ((error: Error) => void) | undefined;
	#transition = Promise.resolve();

	constructor(client: Client, connection: RemoteServiceConnection, options: ServiceNamespaceOptions) {
		super({
			services: options.services,
			connection,
			bound: client.attachment !== undefined,
			...(options.onError === undefined ? {} : { onError: options.onError }),
		});
		this.#onError = options.onError;
		const attachmentState = remoteState<SessionAttachmentState>(toSessionAttachmentState(client));
		this.attachment = attachmentState;
		this.#removeAttachmentListener = client.onAttachmentChange((attachment) => {
			if (attachment !== undefined) {
				attachmentState.set({ status: "attaching", sessionId: attachment.sessionId }, BACKGROUND_CONTEXT);
			}
			this.#transition = this.#transition
				.then(async () => {
					await this.rebind(attachment !== undefined, BACKGROUND_CONTEXT);
					attachmentState.set(
						attachment === undefined
							? { status: "detached" }
							: { status: "attached", sessionId: attachment.sessionId },
						BACKGROUND_CONTEXT,
					);
				})
				.catch((error: unknown) => {
					if (attachment !== undefined) {
						attachmentState.set({ status: "degraded", sessionId: attachment.sessionId }, BACKGROUND_CONTEXT);
					}
					this.#onError?.(toError(error));
				});
		});
	}

	override async dispose(context: Context): Promise<void> {
		this.#removeAttachmentListener();
		await this.#transition;
		await super.dispose(context);
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

function toSessionAttachmentState(client: Client): SessionAttachmentState {
	const attachment = client.attachment;
	return attachment === undefined ? { status: "detached" } : { status: "attached", sessionId: attachment.sessionId };
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
