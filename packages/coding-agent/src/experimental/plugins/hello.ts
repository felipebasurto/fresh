import { defineFacet } from "@earendil-works/chord";
import { AgentController } from "../services/agent-controller.ts";
import { SlashCommands } from "../services/slash-commands.ts";

/** Static example presentation facet; examples/plugins/pi-example-plugin demonstrates packaged plugins. */
const helloPluginFacet = defineFacet({
	id: "@pi/example-hello",
	setup(env) {
		const commands = env.use(SlashCommands);
		const controller = env.use(AgentController);
		env.onActivate(() => {
			env.own(
				commands.register({
					name: "hello",
					description: "Send a greeting from the example plugin",
					run(args, context) {
						return controller.prompt(
							{ message: args.length === 0 ? "Hello from the example plugin" : args, images: null },
							context,
						);
					},
				}),
			);
		});
	},
});

export default helloPluginFacet;
