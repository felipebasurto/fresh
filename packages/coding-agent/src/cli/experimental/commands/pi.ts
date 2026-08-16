import type { Args } from "../../args.ts";
import { Command } from "../command.ts";
import {
	type AuthInput,
	authTokenFileOption,
	authTokenOption,
	parseAuth,
	parseLegacyOptions,
	type TransportAddress,
	transportOption,
} from "../command-options.ts";

export interface PiCommand {
	readonly command: "pi";
	readonly auth?: AuthInput;
	readonly options: Args;
	readonly listen?: readonly TransportAddress[];
}

export interface PiCommandContext {
	runPi(command: PiCommand): void | Promise<void>;
}

const listenOption = transportOption("--listen");

export const piCommand = new Command<PiCommand, PiCommandContext>("pi")
	.option(listenOption)
	.option(authTokenOption)
	.option(authTokenFileOption)
	.build((input) => {
		const { auth, errors: authErrors } = parseAuth(input);
		const listen = input.values(listenOption);
		const { options, errors: optionErrors } = parseLegacyOptions(input);
		const errors = [...authErrors, ...optionErrors];
		if (options.unknownFlags.has("connect")) errors.push("--connect is only valid for client mode");
		if (errors.length > 0) return { ok: false, errors };
		return {
			ok: true,
			command: {
				command: "pi",
				options,
				...(auth === undefined ? {} : { auth }),
				...(listen.length === 0 ? {} : { listen }),
			},
		};
	})
	.action((command, context) => context.runPi(command));
