import type {
	AgentHarness,
	AgentLane,
	Context,
	ServiceProviderUpdate as CoreServiceProviderUpdate,
	ServiceProviderSubscription,
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
import { assembleFacetServices } from "../facets.ts";
import { chatServiceFacet } from "./chat-provider.ts";
import { modelsServiceFacet } from "./models-provider.ts";
import type { SessionFacet, SessionFacetAttributes } from "./session-facet.ts";
import { accountsServiceFacet, transcriptServiceFacet } from "./stubs-provider.ts";

export const ServiceOperationResultSchema = Type.Object(
	{ result: Type.Optional(JsonValueSchema) },
	{ additionalProperties: false },
);
export type ServiceOperationResult = Static<typeof ServiceOperationResultSchema>;

export interface SessionWorkerRuntime {
	readonly harness: AgentHarness;
	readonly lane?: AgentLane;
	readonly modelRuntime?: ModelRuntime;
	readonly facets?: readonly SessionFacet[];
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
	dispose(): Promise<void>;
}

const BUILTIN_SESSION_FACETS = [
	chatServiceFacet,
	modelsServiceFacet,
	accountsServiceFacet,
	transcriptServiceFacet,
] satisfies readonly SessionFacet[];

export async function createSessionWorkerServices(options: {
	readonly harness: AgentHarness;
	readonly lane: AgentLane;
	readonly modelRuntime: ModelRuntime | undefined;
	readonly facets: readonly SessionFacet[];
	publish(scope: WorkerServiceScope, subscriptionId: string, update: ProtocolServiceProviderUpdate): Promise<void>;
}): Promise<SessionWorkerServices> {
	const facetServices = await assembleFacetServices<SessionFacetAttributes>({
		facets: [...BUILTIN_SESSION_FACETS, ...options.facets],
		attributes: { harness: options.harness, lane: options.lane, modelRuntime: options.modelRuntime },
	});
	const provider = facetServices.provider;

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
		async dispose() {
			removeSubscriptions(() => true);
			await facetServices.dispose();
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
