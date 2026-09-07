/** World-space radius of a file node. Shared by the layout worker (collision) and the renderer. */
export function nodeRadius(bytes: number): number {
  return 0.55 + 0.32 * Math.log10(1 + bytes / 512);
}
