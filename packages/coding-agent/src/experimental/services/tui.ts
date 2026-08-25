import { defineService } from "@earendil-works/pi-agent-core";
import type { Models } from "./models.ts";
import type { SessionDirectory, SessionManagement } from "./sessions.ts";

export interface Tui {
	registerSessionPicker(directory: SessionDirectory, management: SessionManagement): () => void;
	registerModelSelection(models: Models): () => void;
	refresh(): void;
	setStatus(status: string): void;
}

export const Tui = defineService<Tui>("pi.local.tui", { rpc: false });
