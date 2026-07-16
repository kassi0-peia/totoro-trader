// Durable deadline metadata for quick LMT and MKT orders.
//
// The gateway keeps its exact millisecond timer for the normal 10-second quick
// window. IBKR's GTD field is only second-granular, so the broker deadline is
// placed on the first whole UTC second strictly after that local deadline. The
// short, versioned orderRef lets a restarted gateway recognize only metadata it
// created for this exact order id; it is never an ownership witness by itself.

export const QUICK_ORDER_REF_VERSION = 'TTQ1';
export const QUICK_ORDER_MAX_FUTURE_MS = 11_000;

const QUICK_ORDER_REF_PREFIX = `${QUICK_ORDER_REF_VERSION}:`;
const QUICK_ORDER_REF_PATTERN = /^TTQ1:([0-9a-z]+):([0-9a-z]+)$/;
// IBKR's GTD year is four digits even though JavaScript Date supports larger
// signed years.
const MAX_DATE_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

function parseBase36Safe(value) {
  let result = 0;
  for (const character of value) {
    const digit = character >= '0' && character <= '9'
      ? character.charCodeAt(0) - 48
      : character.charCodeAt(0) - 87;
    if (digit < 0 || digit >= 36) return null;
    result = result * 36 + digit;
    if (!Number.isSafeInteger(result)) return null;
  }
  return result;
}

function validOrderId(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validEpochMs(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_DATE_MS;
}

export function formatQuickGoodTillDate(epochMs) {
  if (!validEpochMs(epochMs) || epochMs % 1000 !== 0) {
    throw new TypeError('quick broker deadline must be a non-negative whole UTC second');
  }
  const iso = new Date(epochMs).toISOString();
  // A dash between date and time is IBKR's unambiguous UTC GTD form.
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 19)}`;
}

export function createQuickOrderDeadline({ nowMs, timeoutMs, orderId }) {
  if (!validEpochMs(nowMs)) throw new TypeError('invalid quick deadline clock');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('invalid quick deadline timeout');
  }
  if (!validOrderId(orderId)) throw new TypeError('invalid quick deadline orderId');

  const localDeadlineMs = nowMs + timeoutMs;
  if (!validEpochMs(localDeadlineMs)) throw new RangeError('quick local deadline overflow');

  // Strictly later than the exact local deadline, including when that deadline
  // already lands on a whole second. This keeps the local timer the first line
  // of defence and makes GTD the process-independent backstop.
  const brokerDeadlineMs = (Math.floor(localDeadlineMs / 1000) + 1) * 1000;
  if (!validEpochMs(brokerDeadlineMs)) throw new RangeError('quick broker deadline overflow');
  const deadlineSeconds = brokerDeadlineMs / 1000;
  const orderRef = `${QUICK_ORDER_REF_VERSION}:${deadlineSeconds.toString(36)}:${orderId.toString(36)}`;

  return {
    localDeadlineMs,
    brokerDeadlineMs,
    goodTillDate: formatQuickGoodTillDate(brokerDeadlineMs),
    orderRef,
  };
}

export function parseQuickOrderRef(value, { orderId = null } = {}) {
  if (typeof value !== 'string') {
    return { recognized: false, ok: false, code: 'NOT_QUICK' };
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith(QUICK_ORDER_REF_PREFIX)) {
    return { recognized: false, ok: false, code: 'NOT_QUICK' };
  }
  const match = value === trimmed ? QUICK_ORDER_REF_PATTERN.exec(value) : null;
  if (!match) {
    return {
      recognized: true,
      ok: false,
      code: 'MALFORMED_ORDER_REF',
      reason: 'malformed TTQ1 orderRef',
    };
  }

  const deadlineSeconds = parseBase36Safe(match[1]);
  const encodedOrderId = parseBase36Safe(match[2]);
  if (!Number.isSafeInteger(deadlineSeconds) || deadlineSeconds <= 0 || !validOrderId(encodedOrderId)) {
    return {
      recognized: true,
      ok: false,
      code: 'MALFORMED_ORDER_REF',
      reason: 'malformed TTQ1 orderRef values',
    };
  }
  if (deadlineSeconds.toString(36) !== match[1] || encodedOrderId.toString(36) !== match[2]) {
    return {
      recognized: true,
      ok: false,
      code: 'MALFORMED_ORDER_REF',
      reason: 'TTQ1 orderRef is not canonically encoded',
    };
  }
  const brokerDeadlineMs = deadlineSeconds * 1000;
  if (!validEpochMs(brokerDeadlineMs)) {
    return {
      recognized: true,
      ok: false,
      code: 'MALFORMED_ORDER_REF',
      reason: 'TTQ1 deadline is outside the safe range',
    };
  }
  if (orderId != null && (!validOrderId(orderId) || encodedOrderId !== orderId)) {
    return {
      recognized: true,
      ok: false,
      code: 'ORDER_ID_MISMATCH',
      reason: 'TTQ1 orderRef does not match the broker orderId',
      encodedOrderId,
      brokerDeadlineMs,
    };
  }

  return {
    recognized: true,
    ok: true,
    code: 'VALID',
    encodedOrderId,
    brokerDeadlineMs,
  };
}

function recoveryHazard(code, reason, extra = {}) {
  return {
    recognized: true,
    recoverable: false,
    hazard: true,
    authoritative: extra.authoritative === true,
    code,
    reason,
    ...extra,
  };
}

// Assess one openOrder callback. `own` must come from the gateway's broker
// client-id identity check; orderRef alone can never make a row cancellable.
export function assessRecoveredQuickOrder({
  orderId,
  own,
  order,
  nowMs,
  maxFutureMs = QUICK_ORDER_MAX_FUTURE_MS,
}) {
  const parsed = parseQuickOrderRef(order?.orderRef, { orderId });
  if (!parsed.recognized) {
    return {
      recognized: false,
      recoverable: false,
      hazard: false,
      authoritative: false,
      code: 'NOT_QUICK',
    };
  }
  if (own !== true) {
    return {
      recognized: true,
      recoverable: false,
      hazard: false,
      authoritative: false,
      code: 'FOREIGN_ORDER',
      reason: 'foreign TTQ1 metadata is read-only',
    };
  }
  if (!parsed.ok) {
    return recoveryHazard(parsed.code, parsed.reason, {
      brokerDeadlineMs: parsed.brokerDeadlineMs ?? null,
      encodedOrderId: parsed.encodedOrderId ?? null,
    });
  }

  const authoritative = true;
  const orderType = String(order?.orderType ?? '').toUpperCase();
  if (orderType !== 'LMT' && orderType !== 'MKT') {
    return recoveryHazard('WRONG_ORDER_TYPE', 'TTQ1 recovery requires a quick LMT or MKT order', {
      authoritative,
      brokerDeadlineMs: parsed.brokerDeadlineMs,
    });
  }
  if (String(order?.tif ?? '').toUpperCase() !== 'GTD') {
    return recoveryHazard('MISSING_GTD_TIF', 'TTQ1 recovery requires GTD time-in-force', {
      authoritative,
      brokerDeadlineMs: parsed.brokerDeadlineMs,
    });
  }

  const expectedGoodTillDate = formatQuickGoodTillDate(parsed.brokerDeadlineMs);
  if (String(order?.goodTillDate ?? '').trim() !== expectedGoodTillDate) {
    return recoveryHazard('GTD_MISMATCH', 'TTQ1 broker deadline metadata does not match its orderRef', {
      authoritative,
      brokerDeadlineMs: parsed.brokerDeadlineMs,
      expectedGoodTillDate,
    });
  }
  if (!validEpochMs(nowMs)) {
    return recoveryHazard('INVALID_CLOCK', 'cannot evaluate TTQ1 deadline with an invalid clock', {
      authoritative,
      brokerDeadlineMs: parsed.brokerDeadlineMs,
      expectedGoodTillDate,
    });
  }
  if (!Number.isSafeInteger(maxFutureMs) || maxFutureMs <= 0
      || parsed.brokerDeadlineMs - nowMs > maxFutureMs) {
    return recoveryHazard('DEADLINE_TOO_FAR', 'TTQ1 deadline exceeds the quick-order recovery horizon', {
      authoritative,
      brokerDeadlineMs: parsed.brokerDeadlineMs,
      expectedGoodTillDate,
    });
  }
  if (parsed.brokerDeadlineMs <= nowMs) {
    return recoveryHazard('DEADLINE_EXPIRED', 'TTQ1 broker deadline has already expired', {
      authoritative,
      brokerDeadlineMs: parsed.brokerDeadlineMs,
      expectedGoodTillDate,
    });
  }

  return {
    recognized: true,
    recoverable: true,
    hazard: false,
    authoritative: true,
    code: 'RECOVERABLE',
    brokerDeadlineMs: parsed.brokerDeadlineMs,
    expectedGoodTillDate,
  };
}
