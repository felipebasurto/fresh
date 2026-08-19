import type { Context, SessionMetadata } from "@earendil-works/pi-agent-core";
import type {
	LaneEvent,
	LaneSnapshot,
	PromptArguments,
	RunResult,
	SessionCreateOptions,
} from "@earendil-works/pi-protocol";
import type { PiServerListener } from "./listener.ts";

export interface PiServerOptions {
	listeners: readonly PiServerListener[];
	/** Stable logical server identity supplied by the installation or profile. */
	serverId: string;
	maxFrameLength?: number;
	handshakeTimeoutMs?: number;
	onConnectionCountChanged?: (count: number) => void;
	onError?: (error: Error) => void;
}

export type MaybePromise<T> = T | Promise<T>;

/** One presentation connection's live capability for a hosted Session. */
export interface RoutedSessionAttachment {
	/** Execute one serializable prompt through this attachment. */
	prompt(prompt: PromptArguments, context: Context): Promise<RunResult>;
	/** Observe the attached main lane when supported by this host. */
	watch?(context: Context): Promise<RoutedSessionWatch>;
	release(context: Context): MaybePromise<void>;
}

/** Snapshot-first observation handle supplied by a routed Session attachment. */
export interface RoutedSessionWatch {
	readonly snapshot: LaneSnapshot;
	start(listener: (event: LaneEvent, context: Context) => MaybePromise<void>, context: Context): MaybePromise<void>;
	unsubscribe(context: Context): MaybePromise<void>;
}

/** A process-safe handle that acquires presentation-scoped Session capabilities. */
export interface RoutedSessionHandle {
	attachClient(context: Context): MaybePromise<RoutedSessionAttachment>;
	/** Resolves with an error for unexpected termination, or undefined after an expected close. */
	readonly terminated?: Promise<Error | undefined>;
	close(context: Context): Promise<void>;
}

/** Application capabilities used by server-wide management and Session routing. */
export interface PiServerHost<TMetadata extends SessionMetadata = SessionMetadata> {
	readonly sessions: {
		list(context: Context): Promise<TMetadata[]>;
		create(options: SessionCreateOptions, context: Context): Promise<TMetadata>;
	};
	openSession(metadata: TMetadata, context: Context): Promise<RoutedSessionHandle>;
}
