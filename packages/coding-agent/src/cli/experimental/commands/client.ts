import { Command, stringOption } from "../command.ts";
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

export interface ClientCommand {
	readonly command: "client";
	readonly auth?: AuthInput;
	readonly connect?: TransportAddress;
	readonly sessionId?: string;
	readonly provider?: string;
	readonly model?: string;
}

export interface ClientCommandContext {
	runClient(command: ClientCommand): void | Promise<void>;
}

const connectOption = transportOption("--connect");
const sessionIdOption = stringOption("--session-id");
const providerOption = stringOption("--provider");
const modelOption = stringOption("--model");

export const clientCommand = new Command<ClientCommand, ClientCommandContext>("client")
	.option(connectOption)
	.option(sessionIdOption)
	.option(providerOption)
	.option(modelOption)
	.option(authTokenOption)
	.option(authTokenFileOption)
	.build((input) => {
		const { auth, errors: authErrors } = parseAuth(input);
		const connect = input.value(connectOption);
		const sessionId = input.value(sessionIdOption);
		const provider = input.value(providerOption);
		const model = input.value(modelOption);
		const { errors: optionErrors } = parseLegacyOptions(input);
		const modelErrors = provider !== undefined && model === undefined ? ["--provider requires --model"] : [];
		const errors = [...authErrors, ...optionErrors, ...modelErrors, ...unsupportedLegacyOptions("client", input)];
		if (errors.length > 0) return { ok: false, errors };
		return {
			ok: true,
			command: {
				command: "client",
				...(auth === undefined ? {} : { auth }),
				...(connect === undefined ? {} : { connect }),
				...(sessionId === undefined ? {} : { sessionId }),
				...(provider === undefined ? {} : { provider }),
				...(model === undefined ? {} : { model }),
			},
		};
	})
	.action((command, context) => context.runClient(command));
