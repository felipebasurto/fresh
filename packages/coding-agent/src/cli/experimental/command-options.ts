import { posix } from "node:path";
import { isServerId, type ServerId } from "@earendil-works/pi-protocol";
import { type Args, parseArgs } from "../args.ts";
import { type CommandOption, type ParsedCommandInput, stringOption, valueOption } from "./command.ts";

export type AuthInput =
	| { readonly type: "token"; readonly token: string }
	| { readonly type: "file"; readonly path: string };

interface UnixTransportAddress {
	readonly transport: "unix";
	readonly path: string;
}

interface RadiusTransportAddress {
	readonly transport: "radius";
	readonly serverId: ServerId;
}

export type TransportAddress = UnixTransportAddress | RadiusTransportAddress;

export const authTokenOption = stringOption("--auth-token");
export const authTokenFileOption = stringOption("--auth-token-file");

function parseAuthInput(options: { readonly authToken?: string; readonly authTokenFile?: string }): {
	auth?: AuthInput;
	errors: string[];
} {
	if (options.authToken !== undefined && options.authTokenFile !== undefined) {
		return { errors: ["--auth-token and --auth-token-file are mutually exclusive"] };
	}
	if (options.authToken !== undefined) {
		return { auth: { type: "token", token: options.authToken }, errors: [] };
	}
	if (options.authTokenFile !== undefined) {
		return { auth: { type: "file", path: options.authTokenFile }, errors: [] };
	}
	return { errors: [] };
}

function parseTransportAddress(
	value: string,
	option: "--listen" | "--connect",
): { address?: TransportAddress; error?: string } {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return { error: `Invalid ${option} address "${value}"` };
	}
	if (url.protocol === "radius:") {
		if (option !== "--connect") return { error: "Radius transport is only valid for --connect" };
		if (
			url.username ||
			url.password ||
			url.port ||
			(url.pathname !== "" && url.pathname !== "/") ||
			url.search ||
			url.hash ||
			value !== `radius://${url.hostname}${url.pathname}`
		) {
			return { error: `Invalid ${option} address "${value}"` };
		}
		const serverId = url.hostname;
		if (!isServerId(serverId)) {
			return { error: "Radius transport address requires a lowercase UUIDv4 server ID" };
		}
		return { address: { transport: "radius", serverId } };
	}
	if (url.protocol !== "unix:") return { error: `Unsupported ${option} transport "${url.protocol}"` };
	if (url.hostname || url.port || url.username || url.password) {
		return { error: "Unix transport address must not include an authority" };
	}
	if (
		!value.startsWith("unix:///") ||
		value.startsWith("unix:////") ||
		value.includes("?") ||
		value.includes("#") ||
		url.href !== value
	) {
		return { error: `Invalid ${option} address "${value}"` };
	}
	let path: string;
	try {
		path = decodeURIComponent(url.pathname);
	} catch {
		return { error: `Invalid ${option} address "${value}"` };
	}
	if (path.includes("\0")) return { error: `Invalid ${option} address "${value}"` };
	if (!posix.isAbsolute(path)) return { error: "Unix transport address requires an absolute path" };
	return { address: { transport: "unix", path } };
}

export function transportOption(name: "--listen" | "--connect"): CommandOption<TransportAddress> {
	return valueOption(name, (value) => {
		const result = parseTransportAddress(value, name);
		return result.address
			? { ok: true, value: result.address }
			: { ok: false, error: result.error ?? `Invalid ${name} address "${value}"` };
	});
}

export function parseAuth(input: ParsedCommandInput): { auth?: AuthInput; errors: string[] } {
	return parseAuthInput({
		authToken: input.value(authTokenOption),
		authTokenFile: input.value(authTokenFileOption),
	});
}

export function parseLegacyOptions(input: ParsedCommandInput): { options: Args; errors: string[] } {
	const options = parseArgs([...input.remainingArgs]);
	return {
		options,
		errors: options.diagnostics
			.filter((diagnostic) => diagnostic.type === "error")
			.map((diagnostic) => diagnostic.message),
	};
}

export function unsupportedLegacyOptions(command: string, input: ParsedCommandInput): string[] {
	if (input.remainingArgs.length === 0) return [];
	return [`The experimental ${command} command does not support existing CLI options yet`];
}
