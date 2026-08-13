import type { AgentHarness, Session, SessionMetadata, SessionRepo } from "@earendil-works/pi-agent-core";
import type { PiServerListener } from "./listener.ts";

export interface PiServerOptions {
	listeners: readonly PiServerListener[];
	/** Stable logical identity supplied by the server installation or profile. */
	serviceId: string;
	maxFrameLength?: number;
	handshakeTimeoutMs?: number;
	onError?: (error: Error) => void;
}

export type MaybePromise<T> = T | Promise<T>;

/** Host capabilities used directly by the list and attach control-plane operations. */
export interface PiServerService {
	readonly sessions: Pick<SessionRepo, "list" | "open">;
	createHarness(session: Session): Promise<Pick<AgentHarness, "close">>;
}

export interface HostedSessionInfo {
	readonly sessionId: string;
	readonly metadata: SessionMetadata;
}
