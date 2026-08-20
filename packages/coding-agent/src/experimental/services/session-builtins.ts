import { Accounts } from "./accounts.ts";
import { Chat } from "./chat.ts";
import { Models } from "./models.ts";
import { Transcript } from "./transcript.ts";

/**
 * Complete built-in session-service allowlist for the experimental presentation host.
 * Some providers intentionally throw ServiceSliceNotImplemented until their implementation slice lands.
 */
export const BUILTIN_SESSION_SERVICES = [Accounts, Chat, Models, Transcript] as const;
