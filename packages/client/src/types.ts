import type {
	LaneEvent,
	LaneSnapshot,
	RpcTarget,
	ServiceSubscriptionSnapshot,
	SessionTarget,
} from "@earendil-works/pi-protocol";
import type { ByteTransportFactory } from "./transport.ts";

export type ConnectionState = "disconnected" | "connecting" | "connected";

export interface ConnectionStateChange {
	state: ConnectionState;
	error?: Error;
}

export type Unsubscribe = () => void;
export type ListenerErrorHandler = (error: Error) => void;
export type AttachmentChangeListener = (attachment: SessionTarget | undefined) => void;

export interface LaneWatch {
	readonly id: string;
	readonly sessionId: string;
	readonly snapshot: LaneSnapshot;
	start(listener: (event: LaneEvent) => void | Promise<void>): Promise<void>;
	resnapshot(): Promise<LaneSnapshot>;
	dispose(): Promise<void>;
}

export interface ServiceSubscription {
	readonly id: string;
	readonly target: RpcTarget;
	readonly snapshot: ServiceSubscriptionSnapshot;
	/** Begin ordered update delivery after the caller has installed the snapshot. */
	start(): void;
	dispose(): Promise<void>;
}

export interface ClientOptions {
	transportFactory: ByteTransportFactory;
	/** Logical server identity expected at the physical endpoint. */
	serverId: string;
	maxFrameLength?: number;
	/** Reports subscriber failures without allowing them to corrupt client state. */
	onListenerError?: ListenerErrorHandler;
}
