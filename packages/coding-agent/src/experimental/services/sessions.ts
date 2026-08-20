import { type Context, defineRemoteService, type RemoteEvents, type RemoteState } from "@earendil-works/pi-agent-core";
import type { SessionCreateOptions, SessionSummary } from "@earendil-works/pi-protocol";

export interface SessionDirectoryState {
	revision: number;
	sessions: SessionSummary[];
}

export type SessionDirectoryEvent =
	| { type: "created" | "changed"; session: SessionSummary }
	| { type: "deleted"; sessionId: string };

export interface SessionDirectoryService {
	readonly state: RemoteState<SessionDirectoryState>;
	readonly events: RemoteEvents<SessionDirectoryEvent>;
}

export const SessionDirectory = defineRemoteService<SessionDirectoryService>("session-directory");

export interface SessionManagementService {
	create(options: SessionCreateOptions, context: Context): Promise<SessionSummary>;
	remove(sessionId: string, context: Context): Promise<void>;
	attach(sessionId: string, context: Context): Promise<void>;
	detach(context: Context): Promise<void>;
}

export const SessionManagement = defineRemoteService<SessionManagementService>("session-management");
