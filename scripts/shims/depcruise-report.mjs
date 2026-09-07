// Build-time replacement for dependency-cruiser's src/report/index.mjs.
// The original picks a reporter with a variable import(). Orbit only consumes the
// raw cruise result, which is exactly what dependency-cruiser's identity reporter returns.
export async function getReporter() {
	return (pResults) => ({ output: pResults, exitCode: 0 });
}

export function getAvailableReporters() {
	return [];
}
