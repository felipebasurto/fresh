import { type ChildProcess, spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

/**
 * FreshCtx child-process runtime (Phase C).
 *
 * Owns the `freshctx serve --stdio` child: spawn, `freshctx/1` handshake,
 * timeouts, abort, and shutdown. Transport only: response payloads are
 * returned unvalidated for `prepare-context.ts` to verify.
 *
 * Fail-closed: any transport failure, timeout, abort, or child exit rejects
 * all pending and future requests. Callers must block dispatch on rejection
 * and never fall back to the unprepared payload.
 */

export const FRESHCTX_PROTOCOL = "freshctx/1";
export const FRESHCTX_REQUIRED_CAPABILITIES = [
	"request_rewrite",
	"stable_result_identity",
	"projection_insertion",
	"shared_workspace",
] as const;

export interface FreshCtxServerCommand {
	command: string;
	args: string[];
}

/** Minimal transport surface prepare-context needs (real runtime or test stub). */
export interface FreshCtxClient {
	request(op: string, fields?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

export interface FreshCtxRuntimeOptions {
	server: FreshCtxServerCommand;
	/** Workspace root passed as `--root`. */
	root: string;
	sessionId: string;
	/** Adapter label sent in hello (informational only). */
	adapter: string;
	/** Per-request timeout in milliseconds. Default: 10000. */
	timeoutMs?: number;
	/** Environment for the child process. Default: process.env. */
	env?: NodeJS.ProcessEnv;
}

interface PendingRequest {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export class FreshCtxRuntime implements FreshCtxClient {
	private readonly child: ChildProcess;
	private readonly lines: Interface;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly timeoutMs: number;
	private sequence = 0;
	private failure: Error | null = null;
	private readonly exited: Promise<void>;

	private constructor(child: ChildProcess, timeoutMs: number) {
		if (!child.stdin || !child.stdout || !child.stderr) {
			throw new Error("FreshCtx child stdio unavailable");
		}
		this.child = child;
		this.timeoutMs = timeoutMs;
		this.exited = new Promise((resolve) => {
			child.once("close", () => resolve());
		});
		this.lines = createInterface({ input: child.stdout });
		child.stderr?.resume();
		child.stdin?.on("error", (error) => this.fail(error));
		child.on("error", (error) => this.fail(error));
		child.on("exit", () => this.fail(new Error("FreshCtx process exited")));
		this.lines.on("line", (line) => {
			let reply: unknown;
			try {
				reply = JSON.parse(line);
				if (!isRecord(reply) || reply.protocol !== FRESHCTX_PROTOCOL || typeof reply.ok !== "boolean") {
					throw new Error("Invalid FreshCtx response");
				}
				const pending = typeof reply.id === "string" ? this.pending.get(reply.id) : undefined;
				if (!pending) {
					// Stale reply to an aborted or timed-out request. Ignored:
					// the server never sends unsolicited lines.
					return;
				}
				clearTimeout(pending.timer);
				this.pending.delete(reply.id as string);
				if (reply.ok) {
					pending.resolve(reply.result);
				} else {
					const message =
						isRecord(reply.error) && typeof reply.error.message === "string"
							? (reply.error.message as string)
							: "FreshCtx rejected request";
					const code =
						isRecord(reply.error) && typeof reply.error.code === "string"
							? (reply.error.code as string)
							: undefined;
					pending.reject(Object.assign(new Error(message), code ? { code } : {}));
				}
			} catch (error) {
				this.fail(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	static async start(options: FreshCtxRuntimeOptions): Promise<FreshCtxRuntime> {
		const timeoutMs = options.timeoutMs ?? 10000;
		let child: ChildProcess;
		try {
			child = spawn(options.server.command, options.server.args, {
				stdio: ["pipe", "pipe", "pipe"],
				env: options.env ?? process.env,
			});
		} catch (error) {
			throw new Error(`Failed to start FreshCtx server: ${error instanceof Error ? error.message : String(error)}`);
		}
		let runtime: FreshCtxRuntime;
		try {
			runtime = new FreshCtxRuntime(child, timeoutMs);
		} catch (error) {
			child.kill();
			throw error;
		}
		await runtime.request("hello", {
			session_id: options.sessionId,
			adapter: options.adapter,
			capabilities: Object.fromEntries(FRESHCTX_REQUIRED_CAPABILITIES.map((capability) => [capability, true])),
		});
		return runtime;
	}

	get closed(): boolean {
		return this.failure !== null;
	}

	request(op: string, fields: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
		if (this.failure) {
			return Promise.reject(this.failure);
		}
		if (signal?.aborted) {
			return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("FreshCtx request aborted"));
		}
		const id = String(++this.sequence);
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.fail(new Error(`FreshCtx request timed out (op=${op})`));
			}, this.timeoutMs);
			const onAbort = () => {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(signal?.reason instanceof Error ? signal.reason : new Error("FreshCtx request aborted"));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			this.pending.set(id, {
				timer,
				resolve: (result) => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					resolve(result);
				},
				reject: (error) => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					reject(error);
				},
			});
			this.child.stdin?.write(`${JSON.stringify({ ...fields, protocol: FRESHCTX_PROTOCOL, id, op })}\n`, (error) => {
				if (error) {
					this.fail(error);
				}
			});
		});
	}

	/** Release the child process. Rejects pending requests; safe to call twice. */
	async close(): Promise<void> {
		this.fail(new Error("FreshCtx client closed"), false);
		this.child.stdin?.end();
		const timer = setTimeout(() => this.child.kill("SIGKILL"), 1000);
		try {
			await this.exited;
		} finally {
			clearTimeout(timer);
			this.lines.close();
		}
	}

	private fail(error: Error, kill = true): void {
		this.failure ??= error;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(this.failure);
		}
		this.pending.clear();
		if (kill) {
			this.child.kill();
		}
	}
}
