// Pure geometry shared by marker painting and canvas interaction. Keeping the
// connector hit-test here means hover and click use the exact same rule.

export function pointToSegmentDistanceSquared(px, py, x1, y1, x2, y2) {
  if (![px, py, x1, y1, x2, y2].every(Number.isFinite)) return Infinity;

  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    const ox = px - x1;
    const oy = py - y1;
    return ox * ox + oy * oy;
  }

  const projection = ((px - x1) * dx + (py - y1) * dy) / lengthSquared;
  const t = Math.max(0, Math.min(1, projection));
  const ox = px - (x1 + t * dx);
  const oy = py - (y1 + t * dy);
  return ox * ox + oy * oy;
}

export function markerHitContains(hit, x, y) {
  if (!hit || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  const tolerance = Number.isFinite(hit.half) ? Math.max(0, hit.half) : 0;
  if (hit.kind === 'connector') {
    return pointToSegmentDistanceSquared(x, y, hit.x1, hit.y1, hit.x2, hit.y2)
      <= tolerance * tolerance;
  }
  return Number.isFinite(hit.x) && Number.isFinite(hit.y)
    && Math.abs(x - hit.x) <= tolerance
    && Math.abs(y - hit.y) <= tolerance;
}

// `entries` has already been filtered to markers that are visible in the
// current chart window. A closed position gets one connector: from its earliest
// visible entry fill to its exit, rather than one ray per added lot.
export function selectEarliestVisibleEntry(entries) {
  let earliest = null;
  for (const entry of entries ?? []) {
    if (!Number.isFinite(entry?.x) || !Number.isFinite(entry?.y)) continue;
    if (!earliest) {
      earliest = entry;
      continue;
    }
    if (Number.isFinite(entry.ts)
      && (!Number.isFinite(earliest.ts) || entry.ts < earliest.ts)) {
      earliest = entry;
    }
  }
  return earliest;
}
