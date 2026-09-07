// Build-time replacement for dependency-cruiser's src/extract/transpile/try-import-available.mjs.
// Availability must agree with depcruise-try-import.mjs: only the bundled TypeScript exists.
export default function tryImportAvailable(pModuleName) {
	return pModuleName === "typescript";
}
