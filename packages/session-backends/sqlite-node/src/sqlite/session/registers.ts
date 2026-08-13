import type { LaneState, Register, RegisterNamespace, RegisterValues } from "@earendil-works/pi-agent-core";
import { sql } from "../sql.ts";
import type { SqliteDatabase } from "../types.ts";

export interface RegisterRow {
	namespace: RegisterNamespace;
	key: string;
	seq: number;
	value: string;
}

export function insertInitialMainLaneRegisters(db: SqliteDatabase): void {
	const laneState = { currentOperationId: null, pendingNextRun: [] } satisfies LaneState;
	setRegisterRow(db, "lane.leaf", "main", 1, null);
	setRegisterRow(db, "lane.state", "main", 2, laneState);
}

export function setRegisterRow<TNamespace extends RegisterNamespace>(
	db: SqliteDatabase,
	namespace: TNamespace,
	key: string,
	seq: number,
	value: RegisterValues[TNamespace],
): void {
	sql`INSERT INTO registers (namespace, key, seq, value)
		VALUES (${namespace}, ${key}, ${seq}, ${JSON.stringify(value)})
		ON CONFLICT(namespace, key) DO UPDATE SET seq = excluded.seq, value = excluded.value`.run(db);
}

export function deleteRegisterRow(db: SqliteDatabase, namespace: RegisterNamespace, key: string): void {
	sql`DELETE FROM registers WHERE namespace = ${namespace} AND key = ${key}`.run(db);
}

export function decodeRegisterRow<TNamespace extends RegisterNamespace>(
	namespace: TNamespace,
	row: RegisterRow,
): Register<TNamespace> {
	if (row.namespace !== namespace) throw new Error(`Expected register namespace ${namespace}, found ${row.namespace}`);
	return {
		namespace,
		key: row.key,
		seq: row.seq,
		value: JSON.parse(row.value) as RegisterValues[TNamespace],
	};
}

export function readRegisterRow<TNamespace extends RegisterNamespace>(
	db: SqliteDatabase,
	namespace: TNamespace,
	key: string,
): Register<TNamespace> | undefined {
	const row = sql`SELECT namespace, key, seq, value FROM registers
		WHERE namespace = ${namespace} AND key = ${key}`.get<RegisterRow>(db);
	return row === undefined ? undefined : decodeRegisterRow(namespace, row);
}

export function listRegisterRows<TNamespace extends RegisterNamespace>(
	db: SqliteDatabase,
	namespace: TNamespace,
	keyPrefix = "",
): Register<TNamespace>[] {
	const rows = sql`SELECT namespace, key, seq, value FROM registers
		WHERE namespace = ${namespace} AND key >= ${keyPrefix} AND key < ${`${keyPrefix}\uffff`}
		ORDER BY key ASC`.all<RegisterRow>(db);
	return rows.map((row) => decodeRegisterRow(namespace, row));
}
