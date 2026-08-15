export const INTERNAL_PROCESS_ENV = "__PI_INTERNAL_SPAWN";

export type InternalProcessRole = "coordinator" | "session-worker";

/** Read and validate an internal process role without consuming it. */
export function getInternalProcessRole(): InternalProcessRole | undefined {
	const role = process.env[INTERNAL_PROCESS_ENV];
	if (role === undefined) return undefined;
	if (role === "coordinator" || role === "session-worker") return role;
	throw new Error(`Unsupported internal process role: ${role}`);
}

/** Read, validate, and remove the role so descendants do not inherit it. */
export function consumeInternalProcessRole(): InternalProcessRole | undefined {
	const role = getInternalProcessRole();
	delete process.env[INTERNAL_PROCESS_ENV];
	return role;
}
