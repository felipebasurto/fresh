import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import type { Session, SessionCreateOptions, SessionMetadata, SessionRepo } from "@earendil-works/pi-agent-core";
import { createNodeSqliteFactory, SqliteSessionRepo } from "../../src/index.ts";
import type { BenchmarkTarget } from "../../../../agent/benchmark/session/benchmark.ts";

export interface SessionRepoBenchmarkFixture extends AsyncDisposable {
	readonly repo: SessionRepo;
}

const NOW = 1_700_000_000_000;

class TrackingSessionRepo<TMetadata extends SessionMetadata = SessionMetadata> implements SessionRepo<TMetadata> {
	private readonly sessions = new Set<Session<TMetadata>>();

	constructor(private readonly inner: SessionRepo<TMetadata>) {}

	async create(options: SessionCreateOptions | undefined, context = BACKGROUND_CONTEXT): Promise<Session<TMetadata>> {
		return this.track(await this.inner.create(options, context));
	}

	async open(metadata: TMetadata, context = BACKGROUND_CONTEXT): Promise<Session<TMetadata>> {
		return this.track(await this.inner.open(metadata, context));
	}

	list(options: undefined, context = BACKGROUND_CONTEXT): Promise<TMetadata[]> {
		return this.inner.list(options, context);
	}

	delete(metadata: TMetadata, context = BACKGROUND_CONTEXT): Promise<void> {
		return this.inner.delete(metadata, context);
	}

	async fork(source: TMetadata, options = {}, context = BACKGROUND_CONTEXT): Promise<Session<TMetadata>> {
		return this.track(await this.inner.fork(source, options, context));
	}

	async closeTrackedSessions(): Promise<void> {
		await Promise.allSettled([...this.sessions].map((session) => session.close(BACKGROUND_CONTEXT)));
		this.sessions.clear();
	}

	private track(session: Session<TMetadata>): Session<TMetadata> {
		this.sessions.add(session);
		return session;
	}
}

export const sessionRepoBenchmarkTargets = [
	{
		name: "sqlite",
		async createFixture() {
			const directory = await mkdtemp(join(tmpdir(), "pi-sqlite-session-repo-benchmark-"));
			const sqliteRepo = new SqliteSessionRepo({
				directory,
				databaseFactory: createNodeSqliteFactory(),
				now: () => NOW,
			});
			const repo = new TrackingSessionRepo(sqliteRepo);
			return {
				repo,
				async [Symbol.asyncDispose]() {
					await repo.closeTrackedSessions();
					await rm(directory, { recursive: true, force: true });
				},
			};
		},
	},
] satisfies readonly BenchmarkTarget<SessionRepoBenchmarkFixture>[];
