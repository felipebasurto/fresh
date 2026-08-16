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
	readonly prompt?: string;
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
		const promptArgs = input.remainingArgs[0] === "--" ? input.remainingArgs.slice(1) : input.remainingArgs;
		const prompt =
			promptArgs.length === 1 &&
			(input.remainingArgs[0] === "--" || !promptArgs[0]!.startsWith("-")) &&
			promptArgs[0]!.length > 0
				? promptArgs[0]
				: undefined;
		const { errors: optionErrors } = parseLegacyOptions(input);
		const modelErrors = provider !== undefined && model === undefined ? ["--provider requires --model"] : [];
		const promptErrors =
			prompt !== undefined && sessionId === undefined ? ["Client prompt requires --session-id"] : [];
		const unsupportedErrors =
			input.remainingArgs.length === 0 || prompt !== undefined ? [] : unsupportedLegacyOptions("client", input);
		const errors = [...authErrors, ...optionErrors, ...modelErrors, ...promptErrors, ...unsupportedErrors];
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
				...(prompt === undefined ? {} : { prompt }),
			},
		};
	})
	.action((command, context) => context.runClient(command));
