import { type Context, defineService, type RemoteEvents, type ReplicatedState } from "@earendil-works/pi-agent-core";
import type { SessionCreateOptions, SessionSummary } from "@earendil-works/pi-protocol";

export interface SessionDirectoryState {
	revision: number;
	sessions: SessionSummary[];
}

export type SessionDirectoryEvent =
	| { type: "created" | "changed"; session: SessionSummary }
	| { type: "deleted"; sessionId: string };

export interface SessionDirectory {
	readonly state: ReplicatedState<SessionDirectoryState>;
	readonly events: RemoteEvents<SessionDirectoryEvent>;
}

export const SessionDirectory = defineService<SessionDirectory>("pi.session-directory");

export interface SessionManagement {
	create(options: SessionCreateOptions, context: Context): Promise<SessionSummary>;
	remove(sessionId: string, context: Context): Promise<void>;
	attach(sessionId: string, context: Context): Promise<void>;
	detach(context: Context): Promise<void>;
}

export const SessionManagement = defineService<SessionManagement>("pi.session-management");
