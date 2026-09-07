// Machine-checkable pilot task contracts. Pure: session JSONL in, verdict out.
// Task dirs may ship contract.json; the runner loads it and invalidates runs
// that violate the trajectory requirements.

/**
 * @typedef {{
 *   schema: string,
 *   id: string,
 *   require?: {
 *     reads?: Array<{ tool?: string, path: string, offset: number, limit: number }>,
 *     edits?: Array<{ tool?: string, path: string, mustIncludeOld: string, mustIncludeNew: string }>,
 *     forbid?: {
 *       fullFileReads?: Array<{ path: string }>,
 *       shellFileDumps?: { pathPatterns?: string[], commandPatterns?: string[] }
 *     }
 *   }
 * }} TaskContract
 */

/** Select task IDs: optional --task must exist in the directory listing. */
export function selectTaskIds(allTasks, taskArg) {
	if (taskArg === undefined || taskArg === null || taskArg === "") {
		return [...allTasks];
	}
	if (!allTasks.includes(taskArg)) {
		throw new Error(`unknown task id: ${taskArg}`);
	}
	return [taskArg];
}

/** Extract tool calls from a session JSONL document (array of parsed entries). */
export function extractToolCalls(entries) {
	const calls = [];
	for (const entry of entries) {
		if (!entry || entry.type !== "message") continue;
		const message = entry.message;
		if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (!block || block.type !== "toolCall") continue;
			const name = typeof block.name === "string" ? block.name : "";
			const args = block.arguments && typeof block.arguments === "object" ? block.arguments : {};
			calls.push({ name, arguments: args });
		}
	}
	return calls;
}

function pathMatches(actual, expected) {
	if (typeof actual !== "string" || typeof expected !== "string") return false;
	const a = actual.replaceAll("\\", "/");
	const e = expected.replaceAll("\\", "/");
	return a === e || a.endsWith(`/${e}`) || a.endsWith(e);
}

function isFullFileRead(args) {
	const offsetMissing = args.offset === undefined || args.offset === null;
	const limitMissing = args.limit === undefined || args.limit === null;
	return offsetMissing && limitMissing;
}

/**
 * Evaluate a task contract against session entries and verify status.
 * @returns {{ ok: boolean, failures: string[] }}
 */
export function evaluateTaskContract(contract, entries, verifyStatus) {
	const failures = [];
	if (!contract || typeof contract !== "object") {
		return { ok: false, failures: ["missing-contract"] };
	}
	const require = contract.require ?? {};
	const calls = extractToolCalls(entries);

	for (const need of require.reads ?? []) {
		const tool = need.tool ?? "read";
		const hit = calls.some(
			(call) =>
				call.name === tool &&
				pathMatches(call.arguments.path, need.path) &&
				Number(call.arguments.offset) === Number(need.offset) &&
				Number(call.arguments.limit) === Number(need.limit),
		);
		if (!hit) {
			failures.push(`missing-read:${need.path}:${need.offset}:${need.limit}`);
		}
	}

	for (const need of require.edits ?? []) {
		const tool = need.tool ?? "edit";
		const hit = calls.some((call) => {
			if (call.name !== tool || !pathMatches(call.arguments.path, need.path)) return false;
			const blob = JSON.stringify(call.arguments);
			return blob.includes(need.mustIncludeOld) && blob.includes(need.mustIncludeNew);
		});
		if (!hit) {
			failures.push(`missing-edit:${need.path}`);
		}
	}

	const forbid = require.forbid ?? {};
	for (const banned of forbid.fullFileReads ?? []) {
		const hit = calls.some(
			(call) => call.name === "read" && pathMatches(call.arguments.path, banned.path) && isFullFileRead(call.arguments),
		);
		if (hit) {
			failures.push(`full-file-read:${banned.path}`);
		}
	}

	const dump = forbid.shellFileDumps;
	if (dump) {
		const pathRes = (dump.pathPatterns ?? []).map((p) => new RegExp(p));
		const cmdRes = (dump.commandPatterns ?? []).map((p) => new RegExp(p, "i"));
		for (const call of calls) {
			if (call.name !== "bash") continue;
			const command = typeof call.arguments.command === "string" ? call.arguments.command : "";
			const touchesPath = pathRes.length === 0 ? true : pathRes.some((re) => re.test(command));
			const looksLikeDump = cmdRes.some((re) => re.test(command));
			if (touchesPath && looksLikeDump) {
				failures.push("shell-file-dump");
				break;
			}
		}
	}

	if (verifyStatus !== undefined && verifyStatus !== "PASS") {
		failures.push(`verify:${verifyStatus ?? "missing"}`);
	}

	return { ok: failures.length === 0, failures };
}

/** Load contract.json from a task directory, or null when absent. */
export function loadTaskContract(taskDir, readFileSync, existsSync) {
	const path = `${taskDir.replace(/\/$/, "")}/contract.json`;
	if (!existsSync(path)) return null;
	return JSON.parse(readFileSync(path, "utf8"));
}
