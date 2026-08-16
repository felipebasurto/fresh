import type { AgentHarness, SessionMetadata } from "@earendil-works/pi-agent-core";
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

/** A handle that can optionally report when its hosted Harness can no longer serve its Session. */
export interface HostedHarnessHandle extends Pick<AgentHarness, "close"> {
	/** Acquire the Session for one client connection. Sessions permit only one attachment at a time. */
	attachClient?(): MaybePromise<HostedHarnessAttachment>;
	/** Resolves with an error for unexpected termination, or undefined after an expected close. */
	readonly terminated?: Promise<Error | undefined>;
}

/** Host capabilities used directly by the list and attach control-plane operations. */
export interface PiServerHost<TMetadata extends SessionMetadata = SessionMetadata> {
	readonly sessions: { list(): Promise<TMetadata[]> };
	createHarness(metadata: TMetadata): Promise<HostedHarnessHandle>;
}
