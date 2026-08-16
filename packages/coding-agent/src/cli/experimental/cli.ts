import { type ClientCommandContext, clientCommand } from "./commands/client.ts";
import { type PiCommandContext, piCommand } from "./commands/pi.ts";
import { type ServerCommandContext, serverCommand } from "./commands/server.ts";

export type CliContext = PiCommandContext & ServerCommandContext & ClientCommandContext;

export const cli = piCommand.command(serverCommand).command(clientCommand);
