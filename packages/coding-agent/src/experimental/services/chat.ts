import { type Context, defineRemoteService } from "@earendil-works/pi-agent-core";
import type { PromptImage } from "@earendil-works/pi-protocol";

export interface ChatPromptRequest {
	message: string;
	images: PromptImage[] | null;
}

export interface ChatPromptError {
	code: string;
	message: string;
}

export type ChatPromptResponse =
	| { accepted: true; operationId: string; error: ChatPromptError | null }
	| { accepted: false; operationId: string | null; error: ChatPromptError };

export interface ChatService {
	prompt(request: ChatPromptRequest, context: Context): Promise<ChatPromptResponse>;
	requestAbort(operationId: string, context: Context): Promise<void>;
}

export const Chat = defineRemoteService<ChatService>("chat");
