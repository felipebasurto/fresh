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
import type { ProtocolRpcCall, ServiceProviderUpdate } from "@earendil-works/pi-protocol";

export interface PiSessionServiceNamespaceOptions {
	readonly services: readonly { readonly id: string }[];
	readonly onError?: (error: Error) => void;
}

class PiSessionServiceNamespace extends RemoteServiceNamespace {
	readonly #removeAttachmentListener: () => void;
	readonly #onError: ((error: Error) => void) | undefined;
	#transition = Promise.resolve();

	constructor(client: PiClient, connection: RemoteServiceConnection, options: PiSessionServiceNamespaceOptions) {
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

/** Bind plugin service facades to the Pi client's selected Session route. */
export function createPiSessionServiceNamespace(
	client: PiClient,
	options: PiSessionServiceNamespaceOptions,
): RemoteServiceNamespace {
	const connection: RemoteServiceConnection = {
		invoke: async (call, context) => {
			const target = client.attachment;
			if (target === undefined) throw new Error("No Session is attached");
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
			const target = client.attachment;
			if (target === undefined) throw new Error("No Session is attached");
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
	return new PiSessionServiceNamespace(client, connection, options);
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
