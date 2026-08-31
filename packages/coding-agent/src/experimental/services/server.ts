import {
	type Context,
	decodeServiceControlCall,
	type JsonValue,
	RemoteServiceProvider,
	replicatedState,
	type ServiceSubscription,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { RoutedServerServiceAttachment, RoutedServerServiceHost } from "@earendil-works/pi-server";
import { PresentationPlugins } from "./plugins.ts";
import {
	type SessionCreateOptions,
	SessionDirectory,
	type SessionDirectoryState,
	SessionManagement,
	type SessionSummary,
} from "./sessions.ts";

export interface ExperimentalServerServices {
	readonly host: RoutedServerServiceHost;
	refresh(context?: Context): Promise<void>;
	dispose(): Promise<void>;
}

export async function createExperimentalServerServices(options: {
	list(context: Context): Promise<SessionSummary[]>;
	create(createOptions: SessionCreateOptions, context: Context): Promise<SessionSummary>;
	remove(sessionId: string, context: Context): Promise<void>;
	prepareSessionPlugins(
		sessionId: string,
		packagePaths: readonly string[] | undefined,
		context: Context,
	): Promise<{ readonly packagePaths: readonly string[]; readonly presentationPlugins: JsonValue }>;
	reloadPresentationPlugins(packagePaths: readonly string[], context: Context): Promise<JsonValue>;
}): Promise<ExperimentalServerServices> {
	let revision = 1;
	const directory = replicatedState<SessionDirectoryState>({
		revision,
		sessions: await options.list(BACKGROUND_CONTEXT),
	});
	const attachments = new Set<RoutedServerServiceAttachment>();
	let mutationTail = Promise.resolve();

	const refreshNow = async (context: Context): Promise<void> => {
		const sessions = await options.list(context);
		revision += 1;
		directory.state.revision = revision;
		directory.state.sessions = sessions;
		directory.publish(context);
	};
	const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = mutationTail.catch(() => {}).then(operation);
		mutationTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};

	return {
		host: {
			attachClient(presentation) {
				let preparedPluginPackagePaths: readonly string[] | undefined;
				const provider = new RemoteServiceProvider([
					{ service: SessionDirectory, mode: "singleton" },
					{ service: SessionManagement, mode: "singleton" },
					{ service: PresentationPlugins, mode: "singleton" },
				]);
				provider.provide(SessionDirectory, { state: directory });
				provider.provide(PresentationPlugins, {
					prepareSession: ({ sessionId, packagePaths }, context) =>
						serialize(async () => {
							const selected = await options.prepareSessionPlugins(
								sessionId,
								packagePaths ?? undefined,
								context,
							);
							preparedPluginPackagePaths = selected.packagePaths;
							return selected.presentationPlugins;
						}),
					reload: (context) =>
						serialize(() => {
							if (preparedPluginPackagePaths === undefined) {
								throw new Error("No Session plugin selection is prepared");
							}
							return options.reloadPresentationPlugins(preparedPluginPackagePaths, context);
						}),
				});
				provider.provide(SessionManagement, {
					create: (createOptions, context) =>
						serialize(async () => {
							const created = await options.create(createOptions, context);
							await refreshNow(context);
							return created;
						}),
					remove: (sessionId, context) =>
						serialize(async () => {
							await presentation.prepareSessionRemoval(sessionId, context);
							await options.remove(sessionId, context);
							await refreshNow(context);
						}),
					attach: (sessionId, context) =>
						serialize(async () => {
							await presentation.attachSession(sessionId, context);
						}),
					detach: (context) =>
						serialize(async () => {
							await presentation.detachSession(context);
							preparedPluginPackagePaths = undefined;
						}),
				});
				const attachment = createProviderAttachment(provider, () => attachments.delete(attachment));
				attachments.add(attachment);
				return attachment;
			},
		},
		refresh: (context = BACKGROUND_CONTEXT) => serialize(() => refreshNow(context)),
		async dispose() {
			const releases = await Promise.allSettled(
				[...attachments].map((attachment) => attachment.release(BACKGROUND_CONTEXT)),
			);
			attachments.clear();
			await mutationTail;
			const errors = releases.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
			if (errors.length === 1) throw errors[0];
			if (errors.length > 1) throw new AggregateError(errors, "Failed to release server service attachments");
		},
	};
}

function createProviderAttachment(
	provider: RemoteServiceProvider,
	onRelease: () => void,
): RoutedServerServiceAttachment {
	const subscriptions = new Map<string, ServiceSubscription>();
	let released = false;
	return {
		async invokeService(call, publish, context) {
			if (released) throw new Error("Server service attachment is released");
			const control = decodeServiceControlCall(call);
			if (control?.type === "catalogue") return toProtocolJson(provider.catalogue);
			if (control?.type === "subscribe") {
				if (subscriptions.has(control.subscriptionId)) {
					throw new Error("Service subscription ID is already active");
				}
				const subscription = provider.subscribe(control.serviceId, control.mode, (update, updateContext) => {
					void Promise.resolve(publish(control.subscriptionId, update, updateContext)).catch(() => {});
				});
				subscriptions.set(control.subscriptionId, subscription);
				subscription.activate();
				return toProtocolJson(subscription.snapshot);
			}
			if (control?.type === "unsubscribe") {
				const subscription = subscriptions.get(control.subscriptionId);
				if (subscription === undefined) throw new Error("Service subscription was not found");
				subscription.close();
				subscriptions.delete(control.subscriptionId);
				return undefined;
			}
			return provider.invoke(call, context);
		},
		release() {
			if (released) return;
			released = true;
			for (const subscription of subscriptions.values()) subscription.close();
			subscriptions.clear();
			provider.dispose();
			onRelease();
		},
	};
}

function toProtocolJson(value: unknown): JsonValue {
	return value as JsonValue;
}
