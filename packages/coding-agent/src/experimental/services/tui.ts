import { defineService } from "@earendil-works/pi-agent-core";
import type { AgentController } from "./agent-controller.ts";
import type { Models } from "./models.ts";
import type { SessionDirectory, SessionManagement } from "./sessions.ts";

export interface Tui {
	registerSessions(directory: SessionDirectory, management: SessionManagement): () => void;
	registerModelSelection(models: Models): () => void;
	registerAgentController(controller: AgentController): () => void;
	refresh(): void;
	setStatus(status: string): void;
}

export const Tui = defineService<Tui>("pi.local.tui", { rpc: false });
