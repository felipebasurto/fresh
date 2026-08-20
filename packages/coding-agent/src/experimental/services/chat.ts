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

export type ChatQueueResponse =
	| { accepted: true; entryId: string; error: null }
	| { accepted: false; entryId: null; error: ChatPromptError };

export interface ChatCompactionRequest {
	customInstructions: string | null;
}

export interface ChatNavigationRequest {
	targetId: string | null;
	summarize: boolean;
	label: string | null;
	customInstructions: string | null;
}

export interface ChatService {
	prompt(request: ChatPromptRequest, context: Context): Promise<ChatPromptResponse>;
	requestAbort(operationId: string, context: Context): Promise<void>;
	steer(request: ChatPromptRequest, context: Context): Promise<ChatQueueResponse>;
	followUp(request: ChatPromptRequest, context: Context): Promise<ChatQueueResponse>;
	nextRun(request: ChatPromptRequest, context: Context): Promise<ChatQueueResponse>;
	cancelQueued(
		entryId: string,
		context: Context,
	): Promise<{ outcome: "cancelled" | "already_consumed" | "not_found" }>;
	resume(context: Context): Promise<ChatPromptResponse>;
	compact(request: ChatCompactionRequest, context: Context): Promise<ChatPromptResponse>;
	navigate(request: ChatNavigationRequest, context: Context): Promise<ChatPromptResponse>;
}

export const Chat = defineRemoteService<ChatService>("chat");
