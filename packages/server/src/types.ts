import type { Context, Session, SessionMetadata } from "@earendil-works/pi-agent-core";
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
	/** Maximum time an acquired remote Session mutation may hold its lane. */
	remoteMutationLeaseMs?: number;
}

export type MaybePromise<T> = T | Promise<T>;

/** One client connection's exclusive attachment to a hosted Session. */
export interface HostedHarnessAttachment {
	release(context: Context): MaybePromise<void>;
}

/** Snapshot-first observation handle supplied by a hosted Harness adapter. */
export interface HostedHarnessWatch {
	readonly snapshot: LaneSnapshot;
	start(listener: (event: LaneEvent, context: Context) => MaybePromise<void>, context: Context): MaybePromise<void>;
	unsubscribe(context: Context): MaybePromise<void>;
}

/** A process-safe handle for the hosted Harness operations exposed by this server. */
export interface HostedHarnessHandle {
	/** Acquire the Session for one client connection. Sessions permit only one attachment at a time. */
	attachClient?(context: Context): MaybePromise<HostedHarnessAttachment>;
	/** Execute one serializable prompt against the hosted Harness. */
	prompt(prompt: PromptArguments, context: Context): Promise<RunResult>;
	/** Observe the attached main lane when supported by this host. */
	watch?(context: Context): Promise<HostedHarnessWatch>;
	/** Resolves with an error for unexpected termination, or undefined after an expected close. */
	readonly terminated?: Promise<Error | undefined>;
	close(context: Context): Promise<void>;
}

/** Host capabilities used directly by Session RPC operations. */
export interface PiServerHost<TMetadata extends SessionMetadata = SessionMetadata> {
	readonly sessions: {
		list(context: Context): Promise<TMetadata[]>;
		create(options: SessionCreateOptions, context: Context): Promise<TMetadata>;
		/** Open one exclusive Session capability for a remote harness client. */
		open?(metadata: TMetadata, context: Context): Promise<Session<TMetadata>>;
	};
	createHarness(metadata: TMetadata, context: Context): Promise<HostedHarnessHandle>;
}
