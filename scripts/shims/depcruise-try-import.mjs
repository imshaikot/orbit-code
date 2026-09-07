// Build-time replacement for dependency-cruiser's src/utl/try-import.mjs.
// The original locates transpilers at runtime with createRequire and a variable
// import(), which cannot survive bundling. Orbit bundles exactly one: TypeScript.
import * as typescript from "typescript";

export default async function tryImport(pModuleName) {
	return pModuleName === "typescript" ? (typescript.default ?? typescript) : false;
}
