/** Stop the whole oriented footprint on the pavement, not its centre at the end. */
export function terminalAddress(edgeLength: number, length: number, width: number, psi: number, forward = true): number {
  const extent = Math.abs(Math.cos(psi)) * length / 2 + Math.abs(Math.sin(psi)) * width / 2;
  const inset = Math.min(edgeLength / 2, extent + .1);
  return forward ? edgeLength - inset : inset;
}
