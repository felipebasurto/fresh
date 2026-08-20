import { SessionDirectory, SessionManagement } from "./sessions.ts";

/** Complete documented server-service allowlist for the experimental presentation host. */
export const BUILTIN_SERVER_SERVICES = [SessionDirectory, SessionManagement] as const;
