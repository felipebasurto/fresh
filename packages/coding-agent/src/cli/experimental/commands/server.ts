import { isServerId, type ServerId } from "@earendil-works/pi-protocol";
import { Command, stringOption, valueOption } from "../command.ts";
import {
	type AuthInput,
	authTokenFileOption,
	authTokenOption,
	parseAuth,
	parseLegacyOptions,
	type TransportAddress,
	transportOption,
	unsupportedLegacyOptions,
} from "../command-options.ts";

export interface ServerCommand {
	readonly command: "server";
	readonly auth?: AuthInput;
	readonly listen?: readonly TransportAddress[];
	readonly serverId?: ServerId;
	readonly sessionDir?: string;
}

export interface ServerCommandContext {
	runServer(command: ServerCommand): void | Promise<void>;
}

const listenOption = transportOption("--listen");
const serverIdOption = valueOption("--server-id", (value) =>
	isServerId(value)
		? { ok: true, value }
		: { ok: false, error: `Invalid --server-id "${value}"; expected a lowercase UUIDv4` },
);
const sessionDirOption = stringOption("--session-dir");

export const serverCommand = new Command<ServerCommand, ServerCommandContext>("server")
	.option(listenOption)
	.option(serverIdOption)
	.option(sessionDirOption)
	.option(authTokenOption)
	.option(authTokenFileOption)
	.build((input) => {
		const { auth, errors: authErrors } = parseAuth(input);
		const listen = input.values(listenOption);
		const serverId = input.value(serverIdOption);
		const sessionDir = input.value(sessionDirOption);
		const { errors: optionErrors } = parseLegacyOptions(input);
		const errors = [...authErrors, ...optionErrors, ...unsupportedLegacyOptions("server", input)];
		if (errors.length > 0) return { ok: false, errors };
		return {
			ok: true,
			command: {
				command: "server",
				...(auth === undefined ? {} : { auth }),
				...(listen.length === 0 ? {} : { listen }),
				...(serverId === undefined ? {} : { serverId }),
				...(sessionDir === undefined ? {} : { sessionDir }),
			},
		};
	})
	.action((command, context) => context.runServer(command));
