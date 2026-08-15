import { createConnection } from "node:net";

// Test-only child executable. Keep this independent from the real worker so
// lifecycle failure paths remain deterministic as production integration evolves.
const address = process.env.PI_SESSION_WORKER_CONTROL_ADDRESS;
const token = process.env.PI_SESSION_WORKER_CONTROL_TOKEN;
const encodedSessionKey = process.env.PI_SESSION_WORKER_SESSION_KEY_BASE64;
if (!address || !token || !encodedSessionKey) throw new Error("Fixture requires worker control configuration");
const sessionKey = Buffer.from(encodedSessionKey, "base64url").toString();

const parsedMetadata: unknown = JSON.parse(process.argv[3] ?? "null");
const sessionId =
	typeof parsedMetadata === "object" && parsedMetadata !== null && "id" in parsedMetadata
		? parsedMetadata.id
		: undefined;
const mode = typeof sessionId === "string" ? sessionId.replaceAll("\0", "") : undefined;
const socket = createConnection(address);
await new Promise<void>((resolve, reject) => {
	socket.once("connect", resolve);
	socket.once("error", reject);
});
const send = (message: unknown): void => {
	socket.write(`${JSON.stringify(message)}\n`);
};
send({ type: "register_worker", protocol: 1, token, sessionKey, sessionId, pid: process.pid });

if (mode === "ready") {
	send({ type: "worker_ready", sessionId, pid: process.pid });
	let buffered = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffered += chunk;
		if (buffered.includes("\n") && JSON.parse(buffered.slice(0, buffered.indexOf("\n"))).type === "shutdown") {
			process.exit(0);
		}
	});
} else if (mode === "fail") {
	send({ type: "worker_failed", message: "fixture startup failed" });
} else if (mode === "exit") {
	process.exit(2);
} else if (mode === "startup-hang") {
	socket.resume();
} else if (mode === "hang") {
	send({ type: "worker_ready", sessionId, pid: process.pid });
	socket.resume();
} else {
	send({
		type: "worker_ready",
		sessionId: sessionId === undefined ? "missing" : `${sessionId}-different`,
		pid: process.pid,
	});
}
