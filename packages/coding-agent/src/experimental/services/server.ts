import {
	BACKGROUND_CONTEXT,
	type Context,
	type ServiceProviderUpdate as CoreServiceProviderUpdate,
	type MutableRemoteEvents,
	RemoteServiceProvider,
	remoteEvents,
	remoteState,
	type ServiceProviderSubscription,
} from "@earendil-works/pi-agent-core";
import {
	decodeServiceControlCall,
	type JsonValue,
	JsonValueSchema,
	type ServiceProviderUpdate as ProtocolServiceProviderUpdate,
	ServiceProviderUpdateSchema,
	type SessionCreateOptions,
	type SessionSummary,
} from "@earendil-works/pi-protocol";
import type { RoutedServerServiceAttachment, RoutedServerServiceHost } from "@earendil-works/pi-server";
import { Check } from "typebox/value";
import {
	SessionDirectory,
	type SessionDirectoryEvent,
	type SessionDirectoryState,
	SessionManagement,
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
}): Promise<ExperimentalServerServices> {
	let revision = 1;
	const directory = remoteState<SessionDirectoryState>({
		revision,
		sessions: await options.list(BACKGROUND_CONTEXT),
	});
	const directoryEvents = remoteEvents<SessionDirectoryEvent>();
	const attachments = new Set<RoutedServerServiceAttachment>();
	let mutationTail = Promise.resolve();

	const refreshNow = async (context: Context): Promise<void> => {
		const previous = directory.value.sessions;
		const sessions = await options.list(context);
		revision += 1;
		directory.set({ revision, sessions }, context);
		publishDirectoryChanges(previous, sessions, directoryEvents, context);
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
				const provider = new RemoteServiceProvider([
					{ service: SessionDirectory, mode: "singleton" },
					{ service: SessionManagement, mode: "singleton" },
				]);
				provider.provide(SessionDirectory, { state: directory, events: directoryEvents });
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

function publishDirectoryChanges(
	previous: readonly SessionSummary[],
	next: readonly SessionSummary[],
	events: MutableRemoteEvents<SessionDirectoryEvent>,
	context: Context,
): void {
	const previousById = new Map(previous.map((session) => [session.sessionId, session]));
	const nextById = new Map(next.map((session) => [session.sessionId, session]));
	for (const session of previous) {
		if (!nextById.has(session.sessionId)) events.emit({ type: "deleted", sessionId: session.sessionId }, context);
	}
	for (const session of next) {
		const existing = previousById.get(session.sessionId);
		if (existing === undefined) events.emit({ type: "created", session }, context);
		else if (!sameSessionSummary(existing, session)) events.emit({ type: "changed", session }, context);
	}
}

function sameSessionSummary(left: SessionSummary, right: SessionSummary): boolean {
	return left.serverId === right.serverId && left.sessionId === right.sessionId && left.createdAt === right.createdAt;
}

function createProviderAttachment(
	provider: RemoteServiceProvider,
	onRelease: () => void,
): RoutedServerServiceAttachment {
	const subscriptions = new Map<string, ServiceProviderSubscription>();
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
					void Promise.resolve(
						publish(control.subscriptionId, toProtocolServiceUpdate(update), updateContext),
					).catch(() => {});
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
	if (!Check(JsonValueSchema, value)) throw new Error("Service control value is not strict JSON");
	return value;
}

function toProtocolServiceUpdate(update: CoreServiceProviderUpdate): ProtocolServiceProviderUpdate {
	const candidate: unknown = update;
	if (!Check(ServiceProviderUpdateSchema, candidate)) throw new Error("Service produced an invalid update");
	return candidate;
}
