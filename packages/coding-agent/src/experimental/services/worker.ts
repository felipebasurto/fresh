import {
	type AgentHarness,
	type Context,
	type ServiceProviderUpdate as CoreServiceProviderUpdate,
	RemoteServiceProvider,
	type ServiceProviderSubscription,
} from "@earendil-works/pi-agent-core";
import {
	decodeServiceControlCall,
	type JsonValue,
	JsonValueSchema,
	type ProtocolRpcCall,
	type ServiceProviderUpdate as ProtocolServiceProviderUpdate,
	ServiceProviderUpdateSchema,
} from "@earendil-works/pi-protocol";
import Type, { type Static } from "typebox";
import { Check } from "typebox/value";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { Chat } from "./chat.ts";
import { provideChatService } from "./chat-provider.ts";
import { Models } from "./models.ts";
import { provideModelsService } from "./models-provider.ts";

export const ServiceOperationResultSchema = Type.Object(
	{ result: Type.Optional(JsonValueSchema) },
	{ additionalProperties: false },
);
export type ServiceOperationResult = Static<typeof ServiceOperationResultSchema>;

export interface SessionWorkerRuntime {
	readonly harness: AgentHarness;
	readonly modelRuntime?: ModelRuntime;
	readonly serviceTokens?: readonly { readonly id: string }[];
	configureServices?(provider: RemoteServiceProvider): void | Promise<void>;
}

export interface WorkerServiceScope {
	readonly serverConnectionId: string;
	readonly attachmentId: string;
}

interface WorkerServiceSubscription {
	readonly scope: WorkerServiceScope;
	readonly subscription: ServiceProviderSubscription;
}

export interface SessionWorkerServices {
	invoke(call: ProtocolRpcCall, scope: WorkerServiceScope, context: Context): Promise<JsonValue | undefined>;
	removeSubscriptions(matches: (scope: WorkerServiceScope) => boolean): void;
	dispose(): void;
}

export async function createSessionWorkerServices(options: {
	readonly harness: AgentHarness;
	readonly modelRuntime: ModelRuntime | undefined;
	readonly serviceTokens: readonly { readonly id: string }[];
	readonly configureServices: ((provider: RemoteServiceProvider) => void | Promise<void>) | undefined;
	publish(scope: WorkerServiceScope, subscriptionId: string, update: ProtocolServiceProviderUpdate): Promise<void>;
}): Promise<SessionWorkerServices> {
	const provider = new RemoteServiceProvider([Chat, Models, ...options.serviceTokens]);
	try {
		provideChatService(provider, options.harness);
		await provideModelsService(provider, options.harness, options.modelRuntime);
		await options.configureServices?.(provider);
	} catch (error) {
		provider.dispose();
		throw error;
	}

	const subscriptions = new Map<string, WorkerServiceSubscription>();
	const removeSubscriptions = (matches: (scope: WorkerServiceScope) => boolean): void => {
		for (const [key, entry] of subscriptions) {
			if (!matches(entry.scope)) continue;
			entry.subscription.close();
			subscriptions.delete(key);
		}
	};

	return {
		async invoke(call, scope, context) {
			const controlCall = decodeServiceControlCall(call);
			if (controlCall?.type === "subscribe") {
				const key = scopedSubscriptionKey(scope, controlCall.subscriptionId);
				if (subscriptions.has(key)) throw new Error("Service subscription ID is already active");
				const subscription = provider.subscribe(controlCall.serviceId, controlCall.mode, (update) => {
					void options.publish(scope, controlCall.subscriptionId, toProtocolServiceUpdate(update)).catch(() => {});
				});
				subscriptions.set(key, { scope, subscription });
				subscription.activate();
				return toProtocolJson(subscription.snapshot);
			}
			if (controlCall?.type === "unsubscribe") {
				const key = scopedSubscriptionKey(scope, controlCall.subscriptionId);
				const entry = subscriptions.get(key);
				if (entry === undefined) throw new Error("Service subscription was not found");
				entry.subscription.close();
				subscriptions.delete(key);
				return undefined;
			}
			return provider.invoke(call, context);
		},
		removeSubscriptions,
		dispose() {
			removeSubscriptions(() => true);
			provider.dispose();
		},
	};
}

function scopedSubscriptionKey(scope: WorkerServiceScope, subscriptionId: string): string {
	return `${scope.serverConnectionId}\0${scope.attachmentId}\0${subscriptionId}`;
}

function toProtocolJson(value: unknown): JsonValue {
	if (!Check(JsonValueSchema, value)) throw new Error("Service control value is not strict JSON");
	return value;
}

function toProtocolServiceUpdate(update: CoreServiceProviderUpdate): ProtocolServiceProviderUpdate {
	const candidate: unknown = update;
	if (!Check(ServiceProviderUpdateSchema, candidate)) throw new Error("Service produced an invalid update");
	return candidate;
}
