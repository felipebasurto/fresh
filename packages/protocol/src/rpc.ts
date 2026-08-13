import Type, { type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";

export interface RpcMethodSchema<TArgs extends TSchema = TSchema, TResult extends TSchema = TSchema> {
	readonly args: TArgs;
	readonly result: TResult;
}

export type RpcManifest = Record<string, RpcMethodSchema>;

export function defineRpc<const TManifest extends RpcManifest>(manifest: TManifest): TManifest {
	if (Object.keys(manifest).length === 0) throw new TypeError("RPC manifest must define at least one method");
	return manifest;
}

export function createRpcCallSchema<TManifest extends RpcManifest>(manifest: TManifest): TSchema {
	const variants = Object.entries(manifest).map(([method, definition]) =>
		Type.Object(
			{
				method: Type.Literal(method),
				args: definition.args,
			},
			{ additionalProperties: false },
		),
	);
	return Type.Union(variants);
}

export function createRpcResultSchema<TManifest extends RpcManifest>(manifest: TManifest): TSchema {
	return Type.Union(Object.values(manifest).map(({ result }) => result));
}

export type RpcMethodName<TManifest extends RpcManifest> = Extract<keyof TManifest, string>;
export type RpcArgs<TManifest extends RpcManifest, TMethod extends RpcMethodName<TManifest>> = Static<
	TManifest[TMethod]["args"]
> &
	readonly unknown[];
export type RpcResult<TManifest extends RpcManifest, TMethod extends RpcMethodName<TManifest>> = Static<
	TManifest[TMethod]["result"]
>;

export type RpcCall<TManifest extends RpcManifest> = {
	[TMethod in RpcMethodName<TManifest>]: {
		readonly method: TMethod;
		readonly args: RpcArgs<TManifest, TMethod>;
	};
}[RpcMethodName<TManifest>];

export type RpcResultUnion<TManifest extends RpcManifest> = {
	[TMethod in RpcMethodName<TManifest>]: RpcResult<TManifest, TMethod>;
}[RpcMethodName<TManifest>];

export type RpcClient<TManifest extends RpcManifest> = {
	[TMethod in RpcMethodName<TManifest>]: (
		...args: RpcArgs<TManifest, TMethod>
	) => Promise<RpcResult<TManifest, TMethod>>;
};

export type RpcImplementation<TManifest extends RpcManifest, TContext> = {
	[TMethod in RpcMethodName<TManifest>]: (
		context: TContext,
		...args: RpcArgs<TManifest, TMethod>
	) => RpcResult<TManifest, TMethod> | Promise<RpcResult<TManifest, TMethod>>;
};

export type RpcValidationErrorFactory = (message: string) => Error;

function defaultValidationError(message: string): Error {
	return new TypeError(message);
}

/**
 * Create typed methods backed by one generic RPC call function.
 *
 * Only methods declared by the manifest are created. Arguments and returned
 * values are validated at this boundary.
 */
export function createRpcClient<TManifest extends RpcManifest>(
	manifest: TManifest,
	call: (call: RpcCall<TManifest>) => Promise<unknown>,
	validationError: RpcValidationErrorFactory = defaultValidationError,
): RpcClient<TManifest> {
	const client: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
	for (const method of Object.keys(manifest)) {
		const definition = manifest[method];
		if (!definition) continue;
		client[method] = async (...args: unknown[]) => {
			if (!Check(definition.args, args)) throw validationError(`Invalid arguments for RPC method ${method}`);
			const result = await call({ method, args } as RpcCall<TManifest>);
			if (!Check(definition.result, result)) throw validationError(`Invalid result for RPC method ${method}`);
			return result;
		};
	}
	return client as unknown as RpcClient<TManifest>;
}

/** Bind a typed implementation to a validated RPC manifest. */
export function createRpcDispatcher<TManifest extends RpcManifest, TContext>(
	manifest: TManifest,
	implementation: RpcImplementation<TManifest, TContext>,
	validationError: RpcValidationErrorFactory = defaultValidationError,
): (call: RpcCall<TManifest>, context: TContext) => Promise<RpcResultUnion<TManifest>> {
	return async (call, context) => {
		const definition = manifest[call.method];
		const method = implementation[call.method];
		if (!definition || typeof method !== "function") throw validationError(`Unknown RPC method ${call.method}`);
		if (!Check(definition.args, call.args)) throw validationError(`Invalid arguments for RPC method ${call.method}`);
		const result: unknown = await Reflect.apply(method, implementation, [context, ...call.args]);
		if (!Check(definition.result, result)) throw validationError(`Invalid result for RPC method ${call.method}`);
		return result as RpcResultUnion<TManifest>;
	};
}
