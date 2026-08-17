import type { SessionMetadata } from "@earendil-works/pi-agent-core";
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

/** One client connection's exclusive attachment to a hosted Session. */
export interface HostedHarnessAttachment {
	release(): MaybePromise<void>;
}

/** Snapshot-first observation handle supplied by a hosted Harness adapter. */
export interface HostedHarnessWatch {
	readonly snapshot: LaneSnapshot;
	start(listener: (event: LaneEvent) => MaybePromise<void>): MaybePromise<void>;
	unsubscribe(): MaybePromise<void>;
}

/** A process-safe handle for the hosted Harness operations exposed by this server. */
export interface HostedHarnessHandle {
	/** Acquire the Session for one client connection. Sessions permit only one attachment at a time. */
	attachClient?(): MaybePromise<HostedHarnessAttachment>;
	/** Execute one serializable prompt against the hosted Harness. */
	prompt(prompt: PromptArguments): Promise<RunResult>;
	/** Observe the attached main lane when supported by this host. */
	watch?(): Promise<HostedHarnessWatch>;
	/** Resolves with an error for unexpected termination, or undefined after an expected close. */
	readonly terminated?: Promise<Error | undefined>;
	close(): Promise<void>;
}

/** Host capabilities used directly by Session RPC operations. */
export interface PiServerHost<TMetadata extends SessionMetadata = SessionMetadata> {
	readonly sessions: {
		list(): Promise<TMetadata[]>;
		create(options: SessionCreateOptions): Promise<TMetadata>;
	};
	createHarness(metadata: TMetadata): Promise<HostedHarnessHandle>;
}
