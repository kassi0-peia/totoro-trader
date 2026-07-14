import { DEFAULT_VISIBLE, MAX_VISIBLE, MIN_VISIBLE, buildView } from './coords.js';

const STORAGE_PREFIX = 'tt.chartViewport:v1';
const STORAGE_VERSION = 1;

export const MIN_PRICE_SCALE = 0.05;
export const MAX_PRICE_SCALE = 20;
export const DEFAULT_CHART_VIEWPORT = Object.freeze({
  visibleCount: DEFAULT_VISIBLE,
  viewOffset: 0,
  priceOffset: 0,
  priceScale: 1
});

const finite = (value) => Number.isFinite(value);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function chartViewportStorageKey(seriesIdentity, timeframe) {
  const series = String(seriesIdentity ?? '').trim();
  const tf = Number(timeframe);
  if (!series || !finite(tf) || tf <= 0) return null;
  return `${STORAGE_PREFIX}:${encodeURIComponent(series)}:${tf}`;
}

export function clampVisibleCount(value) {
  const count = finite(value) ? Math.round(value) : DEFAULT_VISIBLE;
  return clamp(count, MIN_VISIBLE, MAX_VISIBLE);
}

export function clampPriceScale(value) {
  const scale = finite(value) ? value : 1;
  return clamp(scale, MIN_PRICE_SCALE, MAX_PRICE_SCALE);
}

export function chartViewOffsetBounds({ tfLength, visibleCount }) {
  const count = clampVisibleCount(visibleCount);
  const length = Math.max(0, Math.floor(finite(tfLength) ? tfLength : 0));
  return {
    min: -Math.floor(count * 0.66),
    max: Math.max(0, length - count)
  };
}

export function clampViewOffset(value, { tfLength, visibleCount }) {
  const { min, max } = chartViewOffsetBounds({ tfLength, visibleCount });
  return clamp(finite(value) ? value : 0, min, max);
}

export function clampPriceOffset(value, limit = Infinity) {
  const offset = finite(value) ? value : 0;
  const bound = finite(limit) ? Math.max(0, limit) : Infinity;
  return clamp(offset, -bound, bound);
}

export function clampChartViewport(viewport, { tfLength, priceOffsetLimit = Infinity } = {}) {
  const visibleCount = clampVisibleCount(viewport?.visibleCount);
  return {
    visibleCount,
    viewOffset: clampViewOffset(viewport?.viewOffset, { tfLength, visibleCount }),
    priceOffset: clampPriceOffset(viewport?.priceOffset, priceOffsetLimit),
    priceScale: clampPriceScale(viewport?.priceScale)
  };
}

export function resolveChartViewportRestore(saved, tfCandles) {
  const candles = Array.isArray(tfCandles) ? tfCandles : [];
  const horizontal = clampChartViewport(saved, { tfLength: candles.length });
  const offsetBounds = chartViewOffsetBounds({
    tfLength: candles.length,
    visibleCount: horizontal.visibleCount
  });
  const restoredView = buildView({
    tfCandles: candles,
    visibleCount: horizontal.visibleCount,
    viewOffset: horizontal.viewOffset,
    priceOffset: 0,
    priceScale: horizontal.priceScale
  });
  const priceOffsetLimit = restoredView ? (restoredView.hi - restoredView.lo) * 4 : 0;
  return {
    viewport: clampChartViewport(saved, {
      tfLength: candles.length,
      priceOffsetLimit
    }),
    // A guest seed, deep-history response, or replay tape can still be
    // arriving. Keep the raw saved target pending when today's partial tape
    // is the only reason it had to clamp; later candles may make it reachable.
    complete: saved.viewOffset <= offsetBounds.max && Math.abs(saved.priceOffset) <= priceOffsetLimit
  };
}

export function serializeChartViewport(viewport) {
  if (
    !viewport ||
    !finite(viewport.visibleCount) ||
    !finite(viewport.viewOffset) ||
    !finite(viewport.priceOffset) ||
    !finite(viewport.priceScale)
  ) return null;
  return JSON.stringify({
    v: STORAGE_VERSION,
    visibleCount: viewport.visibleCount,
    viewOffset: viewport.viewOffset,
    priceOffset: viewport.priceOffset,
    priceScale: viewport.priceScale
  });
}

export function deserializeChartViewport(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const value = JSON.parse(raw);
    if (
      !value ||
      value.v !== STORAGE_VERSION ||
      !finite(value.visibleCount) ||
      !finite(value.viewOffset) ||
      !finite(value.priceOffset) ||
      !finite(value.priceScale)
    ) return null;
    return {
      visibleCount: value.visibleCount,
      viewOffset: value.viewOffset,
      priceOffset: value.priceOffset,
      priceScale: value.priceScale
    };
  } catch {
    return null;
  }
}

export function readChartViewport(key, storage) {
  if (!key) return null;
  try {
    const target = storage ?? globalThis.localStorage;
    return target ? deserializeChartViewport(target.getItem(key)) : null;
  } catch {
    return null;
  }
}

export function writeChartViewport(key, viewport, storage) {
  if (!key) return false;
  const serialized = serializeChartViewport(viewport);
  if (!serialized) return false;
  try {
    const target = storage ?? globalThis.localStorage;
    if (!target) return false;
    target.setItem(key, serialized);
    return true;
  } catch {
    return false;
  }
}
