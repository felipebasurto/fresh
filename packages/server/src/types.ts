import type { AgentHarness, SessionMetadata, SessionRepo } from "@earendil-works/pi-agent-core";
import type { PiServerListener } from "./listener.ts";

export interface PiServerOptions {
	listeners: readonly PiServerListener[];
	/** Stable logical server identity supplied by the installation or profile. */
	serverId: string;
	maxFrameLength?: number;
	handshakeTimeoutMs?: number;
	onError?: (error: Error) => void;
}

export type MaybePromise<T> = T | Promise<T>;

/** A handle that can optionally report when its hosted Harness can no longer serve its Session. */
export interface HostedHarnessHandle extends Pick<AgentHarness, "close"> {
	/** Resolves with an error for unexpected termination, or undefined after an expected close. */
	readonly terminated?: Promise<Error | undefined>;
}

/** Host capabilities used directly by the list and attach control-plane operations. */
export interface PiServerHost<TMetadata extends SessionMetadata = SessionMetadata> {
	readonly sessions: Pick<SessionRepo<TMetadata>, "list">;
	createHarness(metadata: TMetadata): Promise<HostedHarnessHandle>;
}
