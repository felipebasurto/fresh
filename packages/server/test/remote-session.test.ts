import {
	AgentHarness,
	BACKGROUND_CONTEXT,
	MemorySessionRepo,
	RemoteSession,
	setValue,
	value,
} from "@earendil-works/pi-agent-core";
import { createModels, type Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteSessionManager } from "../src/remote-session-manager.ts";
import type { PiServerHost } from "../src/types.ts";

const repos = new Set<MemorySessionRepo>();

async function createRemoteSession(
	id: string,
	mutationLeaseMs = 1_000,
): Promise<{
	remote: RemoteSession;
	manager: RemoteSessionManager;
	repo: MemorySessionRepo;
	client: object;
}> {
	const repo = new MemorySessionRepo();
	repos.add(repo);
	const created = await repo.create({ id }, BACKGROUND_CONTEXT);
	await created.close(BACKGROUND_CONTEXT);
	const host: PiServerHost = {
		sessions: {
			list: (context) => repo.list(undefined, context),
			create: async (options, context) => {
				const session = await repo.create(options, context);
				try {
					return session.metadata;
				} finally {
					await session.close(context);
				}
			},
			open: (metadata, context) => repo.open(metadata, context),
		},
		createHarness: async () => {
			throw new Error("Harness hosting is not used by remote Session tests");
		},
	};
	const manager = new RemoteSessionManager({ host, mutationLeaseMs });
	const client = {};
	const remote = await RemoteSession.open(
		{
			invoke: (method, args, context) => manager.invoke(method, args, client, context),
		},
		id,
		BACKGROUND_CONTEXT,
	);
	return { remote, manager, repo, client };
}

afterEach(async () => {
	await Promise.all([...repos].map((repo) => repo.close(BACKGROUND_CONTEXT)));
	repos.clear();
});

describe("RemoteSession", () => {
	test("preserves callback-scoped mutation and tree behavior over untyped RPC", async () => {
		const { remote } = await createRemoteSession("remote-session");
		const applicationValue = value<string>("app.test", "value");
		let capturedMutator: Parameters<Parameters<typeof remote.mutate>[1]>[0] | undefined;

		await expect(
			remote.mutate(
				"main",
				async (mutator, context) => {
					capturedMutator = mutator;
					await expect(mutator.getValue(applicationValue, context)).resolves.toBeUndefined();
					const committed = mutator.commit([setValue(applicationValue, "committed")], context);
					await expect(mutator.commit([], context)).rejects.toThrow("already attempted");
					await committed;
					return "local-result";
				},
				BACKGROUND_CONTEXT,
			),
		).resolves.toBe("local-result");
		await expect(remote.getValue(applicationValue, BACKGROUND_CONTEXT)).resolves.toMatchObject({
			value: "committed",
		});
		await expect(capturedMutator?.getValue(applicationValue, BACKGROUND_CONTEXT)).rejects.toThrow(
			"outside its mutation callback",
		);

		await remote.setValue(applicationValue, "tree-write", BACKGROUND_CONTEXT);
		await expect(remote.getValue(applicationValue, BACKGROUND_CONTEXT)).resolves.toMatchObject({
			value: "tree-write",
		});
		const review = await remote.createLane(
			"review",
			null,
			{
				model: { provider: "test", modelId: "model" },
				thinkingLevel: "off",
				activeToolNames: [],
			},
			BACKGROUND_CONTEXT,
		);
		await expect(review.getLeafId(BACKGROUND_CONTEXT)).resolves.toBeNull();
		await remote.close(BACKGROUND_CONTEXT);
	});

	test("expires a wedged mutation and releases its lane", async () => {
		const { remote } = await createRemoteSession("remote-expiry", 10);
		const applicationValue = value<string>("app.test", "expiry");

		await expect(
			remote.mutate(
				"main",
				async (mutator, context) => {
					await new Promise<void>((resolve) => setTimeout(resolve, 25));
					await mutator.getValue(applicationValue, context);
				},
				BACKGROUND_CONTEXT,
			),
		).rejects.toThrow(/mutation/i);
		await remote.setValue(applicationValue, "after-expiry", BACKGROUND_CONTEXT);
		await expect(remote.getValue(applicationValue, BACKGROUND_CONTEXT)).resolves.toMatchObject({
			value: "after-expiry",
		});
		await remote.close(BACKGROUND_CONTEXT);
	});

	test("releases active mutations and the Session on disconnect", async () => {
		const { remote, manager, repo, client } = await createRemoteSession("remote-disconnect");
		let markEntered!: () => void;
		const entered = new Promise<void>((resolve) => {
			markEntered = resolve;
		});
		let releaseCallback!: () => void;
		const callbackGate = new Promise<void>((resolve) => {
			releaseCallback = resolve;
		});
		const mutation = remote.mutate(
			"main",
			async () => {
				markEntered();
				await callbackGate;
			},
			BACKGROUND_CONTEXT,
		);
		const rejectedMutation = expect(mutation).rejects.toThrow(/Session|mutation/i);
		await entered;
		await manager.disconnect(client, BACKGROUND_CONTEXT);
		releaseCallback();
		await rejectedMutation;

		const metadata = (await repo.list(undefined, BACKGROUND_CONTEXT))[0]!;
		const reopened = await repo.open(metadata, BACKGROUND_CONTEXT);
		await reopened.close(BACKGROUND_CONTEXT);
	});

	test("can be passed to AgentHarness.create without local/remote branching", async () => {
		const { remote } = await createRemoteSession("remote-harness");
		const model = {
			id: "model",
			name: "Model",
			api: "test",
			provider: "test",
			baseUrl: "https://example.test",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10_000,
			maxTokens: 1_000,
		} satisfies Model<"test">;
		const { harness } = await AgentHarness.create(
			{ session: remote, models: createModels(), model, resources: {} },
			BACKGROUND_CONTEXT,
		);

		await expect(harness.getModel(BACKGROUND_CONTEXT)).resolves.toBeUndefined();
		await harness.close(BACKGROUND_CONTEXT);
	});
});
