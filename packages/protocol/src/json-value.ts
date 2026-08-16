import Type, { type Static } from "typebox";

type JsonValueShape = null | boolean | number | string | JsonValueShape[] | { [key: string]: JsonValueShape };

// TypeBox cannot express plain-object checks or cycle-safe recursion. The static annotation and runtime refinement are
// deliberately paired here; all hand-written Harness and service DTOs remain schema-derived.
export const JsonValueSchema = Type.Refine(
	Type.Unsafe<JsonValueShape>(Type.Unknown()),
	(value) => isJsonValue(value),
	() => "Expected recursively plain JSON data",
);
export type JsonValue = Static<typeof JsonValueSchema>;

/** Return whether a value is recursively finite JSON data without cycles. */
export function isJsonValue(value: unknown): value is JsonValue {
	return checkJsonValue(value, new Set<object>());
}

function checkJsonValue(value: unknown, ancestors: Set<object>): value is JsonValue {
	if (value === null || typeof value === "boolean" || typeof value === "string") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object" || ancestors.has(value)) return false;
	if (!Array.isArray(value)) {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return false;
		if (
			Object.getOwnPropertySymbols(value).some((symbol) => Object.prototype.propertyIsEnumerable.call(value, symbol))
		) {
			return false;
		}
	}
	ancestors.add(value);
	const valid = Array.isArray(value)
		? checkJsonArray(value, ancestors)
		: Object.values(value).every((item) => checkJsonValue(item, ancestors));
	ancestors.delete(value);
	return valid;
}

function checkJsonArray(value: unknown[], ancestors: Set<object>): value is JsonValue[] {
	for (let index = 0; index < value.length; index++) {
		if (!Object.hasOwn(value, index) || !checkJsonValue(value[index], ancestors)) return false;
	}
	return true;
}
