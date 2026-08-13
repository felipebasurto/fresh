import { randomBytes } from "node:crypto";
import type { ServiceId } from "@earendil-works/pi-protocol";

/** Generate a process-memory logical service identity. */
export function generateServiceId(): ServiceId {
	return randomBytes(16).toString("hex");
}
