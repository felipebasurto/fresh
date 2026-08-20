import {
	BACKGROUND_CONTEXT,
	type Context,
	type ServiceProviderUpdate as CoreServiceProviderUpdate,
	freshDeliveryContext,
	isJsonValue,
	type RemoteServiceConnection,
	RemoteServiceNamespace,
} from "@earendil-works/pi-agent-core";
import type { PiClient } from "@earendil-works/pi-client";
import type { ProtocolRpcCall, RpcTarget, ServiceProviderUpdate } from "@earendil-works/pi-protocol";

export interface PiServiceNamespaceOptions {
	readonly services: readonly { readonly id: string }[];
	readonly onError?: (error: Error) => void;
}

class PiServerServiceNamespace extends RemoteServiceNamespace {
	readonly #removeConnectionListener: () => void;
	readonly #onError: ((error: Error) => void) | undefined;
	#transition = Promise.resolve();

	constructor(client: PiClient, connection: RemoteServiceConnection, options: PiServiceNamespaceOptions) {
		super({
			services: options.services,
			connection,
			bound: client.connected,
			...(options.onError === undefined ? {} : { onError: options.onError }),
		});
		this.#onError = options.onError;
		this.#removeConnectionListener = client.onConnectionStateChange(({ state }) => {
			this.#transition = this.#transition
				.then(() => this.rebind(state === "connected", BACKGROUND_CONTEXT))
				.catch((error: unknown) => this.#onError?.(toError(error)));
		});
	}

	override async dispose(context: Context): Promise<void> {
		this.#removeConnectionListener();
		await this.#transition;
		await super.dispose(context);
	}
}

class PiSessionServiceNamespace extends RemoteServiceNamespace {
	readonly #removeAttachmentListener: () => void;
	readonly #onError: ((error: Error) => void) | undefined;
	#transition = Promise.resolve();

	constructor(client: PiClient, connection: RemoteServiceConnection, options: PiServiceNamespaceOptions) {
		super({
			services: options.services,
			connection,
			bound: client.attachment !== undefined,
			...(options.onError === undefined ? {} : { onError: options.onError }),
		});
		this.#onError = options.onError;
		this.#removeAttachmentListener = client.onAttachmentChange((attachment) => {
			this.#transition = this.#transition
				.then(() => this.rebind(attachment !== undefined, BACKGROUND_CONTEXT))
				.catch((error: unknown) => this.#onError?.(toError(error)));
		});
	}

	override async dispose(context: Context): Promise<void> {
		this.#removeAttachmentListener();
		await this.#transition;
		await super.dispose(context);
	}
}

/** Bind plugin service facades to the connected server route. */
export function createPiServerServiceNamespace(
	client: PiClient,
	options: PiServiceNamespaceOptions,
): RemoteServiceNamespace {
	const connection = createServiceConnection(client, () => ({ serverId: client.serverId }));
	return new PiServerServiceNamespace(client, connection, options);
}

/** Bind plugin service facades to the Pi client's selected Session route. */
export function createPiSessionServiceNamespace(
	client: PiClient,
	options: PiServiceNamespaceOptions,
): RemoteServiceNamespace {
	const connection = createServiceConnection(client, () => client.attachment);
	return new PiSessionServiceNamespace(client, connection, options);
}

function createServiceConnection(client: PiClient, getTarget: () => RpcTarget | undefined): RemoteServiceConnection {
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

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
