import { randomBytes } from "node:crypto";

/** Generate a process-memory logical service identity. */
export function generateServiceId(): string {
	return randomBytes(16).toString("hex");
}
