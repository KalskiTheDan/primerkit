// A logo's path, drawn on a grid of pixels: its curves cut into short straight pieces, and how
// far a point lies from one of them. PreReason's mark and primerkit's both use it.

export type Piece = [number, number, number, number];

// The path as straight pieces, each curve cut into short chords.
export function pathPieces(d: string, steps = 24): Piece[] {
  const pieces: Piece[] = [];
  let x = 0;
  let y = 0;
  for (const [, cmd, args] of d.matchAll(/([MLC])([^MLC]*)/g)) {
    const n = (args ?? '').trim().split(/[\s,]+/).map(Number);
    if (cmd === 'M') {
      x = n[0] ?? 0;
      y = n[1] ?? 0;
    } else if (cmd === 'L') {
      pieces.push([x, y, n[0] ?? 0, n[1] ?? 0]);
      x = n[0] ?? 0;
      y = n[1] ?? 0;
    } else {
      const [x1 = 0, y1 = 0, x2 = 0, y2 = 0, x3 = 0, y3 = 0] = n;
      let px = x;
      let py = y;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const u = 1 - t;
        const qx = u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3;
        const qy = u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3;
        pieces.push([px, py, qx, qy]);
        px = qx;
        py = qy;
      }
      x = x3;
      y = y3;
    }
  }
  return pieces;
}

export function distance(px: number, py: number, [x0, y0, x1, y1]: Piece): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len)) : 0;
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}
