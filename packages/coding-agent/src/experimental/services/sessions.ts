import { type Context, defineRemoteService, type RemoteState } from "@earendil-works/pi-agent-core";
import type { SessionCreateOptions, SessionSummary } from "@earendil-works/pi-protocol";

export interface SessionDirectoryState {
	revision: number;
	sessions: SessionSummary[];
}

export interface SessionDirectoryService {
	readonly state: RemoteState<SessionDirectoryState>;
}

export const SessionDirectory = defineRemoteService<SessionDirectoryService>("session-directory");

export interface SessionManagementService {
	create(options: SessionCreateOptions, context: Context): Promise<SessionSummary>;
	remove(sessionId: string, context: Context): Promise<void>;
	attach(sessionId: string, context: Context): Promise<void>;
	detach(context: Context): Promise<void>;
}

export const SessionManagement = defineRemoteService<SessionManagementService>("session-management");
