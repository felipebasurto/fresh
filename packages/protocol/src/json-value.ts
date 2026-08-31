import type { JsonValue } from "@earendil-works/chord";
import Type from "typebox";

/** Static JSON contract. Protocol codecs perform recursive validation at the wire boundary. */
export const JsonValueSchema = Type.Unsafe<JsonValue>(Type.Unknown());

export type { JsonValue } from "@earendil-works/chord";
