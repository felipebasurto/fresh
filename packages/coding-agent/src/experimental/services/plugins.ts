import { type Context, defineService } from "@earendil-works/chord";
import type { JsonValue } from "@earendil-works/pi-protocol";

/** Server-built plugin generations available to presentations. */
export interface PresentationPlugins {
	prepareSession(
		request: { readonly sessionId: string; readonly packagePaths: readonly string[] | null },
		context: Context,
	): Promise<JsonValue>;
	reload(context: Context): Promise<JsonValue>;
}

export const PresentationPlugins = defineService<PresentationPlugins>("pi.presentation-plugins");

/** Plugin facets hosted in the currently attached Session worker. */
export interface SessionPlugins {
	reload(context: Context): Promise<void>;
}

export const SessionPlugins = defineService<SessionPlugins>("pi.session-plugins");
