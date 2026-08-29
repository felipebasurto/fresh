import type { JsonValue } from "@earendil-works/chord";
import Type from "typebox";

/** Static JSON contract. Concrete serializers are responsible for rejecting unsupported runtime values. */
export const JsonValueSchema = Type.Unsafe<JsonValue>(Type.Unknown());

export type { JsonValue } from "@earendil-works/chord";
