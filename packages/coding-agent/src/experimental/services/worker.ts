import type {
	AgentHarness,
	AgentLane,
	Context,
	ServiceProviderUpdate as CoreServiceProviderUpdate,
	ServiceCatalogueEntry,
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
import type { SettingsManager } from "../../core/settings-manager.ts";
import { combineFacetLoaders, createStaticFacetLoader, type FacetLoader } from "../facet-loader.ts";
import { createFacetHost, defineFacet, type Facet, type FacetHost } from "../facets.ts";
import { AgentController } from "./agent-controller.ts";
import { createAgentController } from "./agent-controller-provider.ts";
import { createModelsServiceFacet } from "./models-provider.ts";
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
	readonly settingsManager?: SettingsManager;
	readonly facetLoader?: FacetLoader;
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
	readonly catalogue: readonly ServiceCatalogueEntry[];
	invoke(call: ProtocolRpcCall, scope: WorkerServiceScope, context: Context): Promise<JsonValue | undefined>;
	removeSubscriptions(matches: (scope: WorkerServiceScope) => boolean): void;
	dispose(): Promise<void>;
}

function createBuiltinSessionFacetLoader(options: {
	readonly lane: AgentLane;
	readonly modelRuntime: ModelRuntime | undefined;
	readonly settingsManager?: SettingsManager;
}): FacetLoader {
	return createStaticFacetLoader([
		createModelsServiceFacet(options),
		accountsServiceFacet,
		transcriptServiceFacet,
	] satisfies readonly Facet[]);
}

export async function createSessionWorkerServices(options: {
	readonly lane: AgentLane;
	readonly modelRuntime: ModelRuntime | undefined;
	readonly settingsManager?: SettingsManager;
	readonly facetLoader?: FacetLoader;
	publish(scope: WorkerServiceScope, subscriptionId: string, update: ProtocolServiceProviderUpdate): Promise<void>;
}): Promise<SessionWorkerServices> {
	const agentControllerRuntimeFacet = defineFacet({
		id: "@pi/agent-controller-runtime",
		setup(env) {
			env.provide(AgentController, createAgentController(options.lane));
		},
	});
	const loader = combineFacetLoaders([
		createStaticFacetLoader([agentControllerRuntimeFacet]),
		createBuiltinSessionFacetLoader(options),
		...(options.facetLoader === undefined ? [] : [options.facetLoader]),
	]);
	const loaded = await loader.load();
	let facetHost: FacetHost;
	try {
		facetHost = await createFacetHost({ facets: loaded.facets });
	} catch (error) {
		try {
			await loaded.dispose();
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "Session facets failed to start and clean up");
		}
		throw error;
	}
	const provider = facetHost.services;

	const subscriptions = new Map<string, WorkerServiceSubscription>();
	const removeSubscriptions = (matches: (scope: WorkerServiceScope) => boolean): void => {
		for (const [key, entry] of subscriptions) {
			if (!matches(entry.scope)) continue;
			entry.subscription.close();
			subscriptions.delete(key);
		}
	};

	return {
		catalogue: provider.catalogue,
		async invoke(call, scope, context) {
			const controlCall = decodeServiceControlCall(call);
			if (controlCall?.type === "catalogue") return toProtocolJson(provider.catalogue);
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
			const errors: unknown[] = [];
			try {
				await facetHost.dispose();
			} catch (error) {
				errors.push(error);
			}
			try {
				await loaded.dispose();
			} catch (error) {
				errors.push(error);
			}
			if (errors.length === 1) throw errors[0];
			if (errors.length > 1) throw new AggregateError(errors, "Failed to dispose Session facets");
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
