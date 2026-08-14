import type { AuthInput } from "../auth.ts";
import { Command, stringOption } from "../command.ts";
import {
	authTokenFileOption,
	authTokenOption,
	parseAuth,
	parseLegacyOptions,
	transportOption,
	unsupportedLegacyOptions,
} from "../command-options.ts";
import type { TransportAddress } from "../transport-address.ts";

export interface ServerCommand {
	readonly command: "server";
	readonly auth?: AuthInput;
	readonly listen?: readonly TransportAddress[];
	readonly sessionDir?: string;
}

export interface ServerCommandContext {
	runServer(command: ServerCommand): void | Promise<void>;
}

const listenOption = transportOption("--listen");
const sessionDirOption = stringOption("--session-dir");

export const serverCommand = new Command<ServerCommand, ServerCommandContext>("server")
	.option(listenOption)
	.option(sessionDirOption)
	.option(authTokenOption)
	.option(authTokenFileOption)
	.build((input) => {
		const { auth, errors: authErrors } = parseAuth(input);
		const listen = input.values(listenOption);
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
				...(sessionDir === undefined ? {} : { sessionDir }),
			},
		};
	})
	.action((command, context) => context.runServer(command));
