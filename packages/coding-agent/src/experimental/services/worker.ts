import {
	type Context,
	createFacetHost,
	createStaticFacetLoader,
	defineFacet,
	type FacetHost,
	type FacetLoader,
	isJsonValue,
	type JsonValue,
	type ServiceProviderUpdate,
	type ServiceSubscription,
} from "@earendil-works/chord";
import type { AgentHarness, AgentLane } from "@earendil-works/pi-agent-core";
import { decodeServiceControlCall, type ProtocolRpcCall } from "@earendil-works/pi-protocol";
import Type, { type Static } from "typebox";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { AgentController } from "./agent-controller.ts";
import { createAgentController } from "./agent-controller-provider.ts";
import { createModelsServiceFacet } from "./models-provider.ts";
import { SessionPlugins } from "./plugins.ts";
import { createTranscriptServiceFacet } from "./transcript-provider.ts";

const OpaqueJsonValueSchema = Type.Unsafe<JsonValue>(Type.Unknown());

export const ServiceOperationResultSchema = Type.Object(
	{ result: Type.Optional(OpaqueJsonValueSchema) },
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
	readonly subscription: ServiceSubscription;
}

export interface SessionWorkerServices {
	invoke(call: ProtocolRpcCall, scope: WorkerServiceScope, context: Context): Promise<JsonValue | undefined>;
	removeSubscriptions(matches: (scope: WorkerServiceScope) => boolean): void;
	dispose(): Promise<void>;
}

export async function createSessionWorkerServices(options: {
	readonly lane: AgentLane;
	readonly modelRuntime: ModelRuntime | undefined;
	readonly settingsManager?: SettingsManager;
	readonly facetLoader?: FacetLoader;
	publish(scope: WorkerServiceScope, subscriptionId: string, update: ServiceProviderUpdate): Promise<void>;
}): Promise<SessionWorkerServices> {
	const agentControllerRuntimeFacet = defineFacet({
		id: "@pi/agent-controller-runtime",
		setup(env) {
			env.provide(AgentController, createAgentController(options.lane));
		},
	});
	let reloadPlugins = (): Promise<void> => Promise.reject(new Error("Session plugins are not ready"));
	const pluginRuntimeFacet = defineFacet({
		id: "@pi/session-plugins-runtime",
		setup(env) {
			env.provide(SessionPlugins, { reload: () => reloadPlugins() });
		},
	});
	const builtins = await createStaticFacetLoader([
		agentControllerRuntimeFacet,
		pluginRuntimeFacet,
		createModelsServiceFacet(options),
		createTranscriptServiceFacet(options.lane),
	]).load();
	const pluginLoader = options.facetLoader ?? createStaticFacetLoader([]);
	let loadedPlugins = await pluginLoader.load();
	let facetHost: FacetHost;
	try {
		facetHost = await createFacetHost({ facets: [...builtins.facets, ...loadedPlugins.facets] });
	} catch (error) {
		const cleanup = await Promise.allSettled([loadedPlugins.dispose(), builtins.dispose()]);
		const cleanupErrors = cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		if (cleanupErrors.length > 0) {
			throw new AggregateError([error, ...cleanupErrors], "Session facets failed to start and clean up");
		}
		throw error;
	}
	let reloadTail = Promise.resolve();
	reloadPlugins = () => {
		const operation = reloadTail.then(async () => {
			const candidate = await pluginLoader.load();
			try {
				await facetHost.reload(candidate.facets);
			} catch (error) {
				try {
					await candidate.dispose();
				} catch (cleanupError) {
					throw new AggregateError([error, cleanupError], "Session plugin reload and cleanup failed");
				}
				throw error;
			}
			const retired = loadedPlugins;
			loadedPlugins = candidate;
			await retired.dispose();
		});
		reloadTail = operation.catch(() => {});
		return operation;
	};
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
		async invoke(call, scope, context) {
			const controlCall = decodeServiceControlCall(call);
			if (controlCall?.type === "catalogue") return toProtocolJsonValue(provider.catalogue);
			if (controlCall?.type === "subscribe") {
				const key = scopedSubscriptionKey(scope, controlCall.subscriptionId);
				if (subscriptions.has(key)) throw new Error("Service subscription ID is already active");
				const subscription = provider.subscribe(controlCall.serviceId, controlCall.mode, (update) => {
					void options.publish(scope, controlCall.subscriptionId, update).catch(() => {});
				});
				subscriptions.set(key, { scope, subscription });
				subscription.activate();
				return toProtocolJsonValue(subscription.snapshot);
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
			await reloadTail;
			const errors: unknown[] = [];
			try {
				await facetHost.dispose();
			} catch (error) {
				errors.push(error);
			}
			const results = await Promise.allSettled([loadedPlugins.dispose(), builtins.dispose()]);
			errors.push(...results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])));
			if (errors.length === 1) throw errors[0];
			if (errors.length > 1) throw new AggregateError(errors, "Failed to dispose Session facets");
		},
	};
}

function scopedSubscriptionKey(scope: WorkerServiceScope, subscriptionId: string): string {
	return `${scope.serverConnectionId}\0${scope.attachmentId}\0${subscriptionId}`;
}

function toProtocolJsonValue(value: unknown): JsonValue {
	if (!isJsonValue(value)) throw new Error("Service produced invalid JSON");
	return value;
}
