export function getFreshUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `fresh/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
