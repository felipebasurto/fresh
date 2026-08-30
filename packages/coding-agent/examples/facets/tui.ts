import { defineFacet } from "@earendil-works/chord";
import { AgentController } from "../../src/experimental/services/agent-controller.ts";
import { PresentationUI } from "../../src/experimental/services/presentation-ui.ts";
import { SlashCommands } from "../../src/experimental/services/slash-commands.ts";
import { ExampleFacetService } from "./contract.ts";

export default defineFacet({
	id: "@pi/example-bundled:tui",
	setup(env) {
		const example = env.use(ExampleFacetService);
		const commands = env.use(SlashCommands);
		const controller = env.use(AgentController);
		const ui = env.use(PresentationUI);
		env.onActivate(() => {
			env.own(
				commands.register({
					name: "facet-hello",
					description: "Call the bundled Session worker facet",
					argumentHint: "<name>",
					async run(args, context) {
						const message = args.length === 0 ? "from the TUI" : args;
						const reply = await example.greet({ name: message }, context);
						ui.showStatus(`${reply.message} Worker activations: ${reply.workerActivations}.`, context);
						return controller.prompt({ message: `pong: ${message}`, images: null }, context);
					},
				}),
			);
		});
	},
});
