import type { LaneState } from "@earendil-works/pi-agent-core";
import { sql } from "../sql.ts";
import type { SqliteDatabase } from "../types.ts";

export function insertInitialMainLaneRegisters(db: SqliteDatabase): void {
	const laneState = { currentOperationId: null, pendingNextRun: [] } satisfies LaneState;
	sql`INSERT INTO registers (namespace, key, seq, value)
		VALUES (${"lane.leaf"}, ${"main"}, ${1}, ${JSON.stringify(null)})`.run(db);
	sql`INSERT INTO registers (namespace, key, seq, value)
		VALUES (${"lane.state"}, ${"main"}, ${2}, ${JSON.stringify(laneState)})`.run(db);
}
