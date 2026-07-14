// IBKR uses the same JavaScript number shape for order IDs and most request
// IDs, even though they are separate protocol namespaces. Keeping them far
// apart makes error ownership unambiguous: broker-assigned order IDs stay below
// REQUEST_ID_FLOOR, while our data/account/history requests live above it.

export const REQUEST_ID_FLOOR = 1_000_000_000;
export const REQUEST_ID_CEILING = 2_000_000_000;

function safeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return number;
}

export function createIbIdAllocator({
  requestFloor = REQUEST_ID_FLOOR,
  requestCeiling = REQUEST_ID_CEILING,
  initialOrderId = 1,
  isRequestIdActive = () => false,
  isOrderIdActive = () => false,
} = {}) {
  const floor = safeInteger(requestFloor, 'requestFloor');
  const ceiling = safeInteger(requestCeiling, 'requestCeiling');
  if (floor < 1 || ceiling < floor || ceiling > 2_147_483_647) {
    throw new RangeError('request ID namespace must fit inside positive signed int32');
  }
  if (typeof isRequestIdActive !== 'function' || typeof isOrderIdActive !== 'function') {
    throw new TypeError('ID ownership checks must be functions');
  }

  let requestCursor = floor;
  let orderCursor = safeInteger(initialOrderId, 'initialOrderId');

  function nextRequestId() {
    const start = requestCursor;
    do {
      const candidate = requestCursor;
      requestCursor = candidate >= ceiling ? floor : candidate + 1;
      if (!isRequestIdActive(candidate)) return candidate;
    } while (requestCursor !== start);
    throw new Error('IBKR request ID namespace is exhausted');
  }

  function observeNextValidId(value) {
    const next = safeInteger(value, 'nextValidId');
    // Skipping the handed-out value costs nothing and remains safe even if a
    // reconnect races a late openOrder callback carrying that same ID.
    orderCursor = Math.max(orderCursor, next + 1);
    if (orderCursor >= floor) throw new Error('IBKR order ID reached the reserved request namespace');
    return orderCursor;
  }

  function observeOrderId(value) {
    const used = safeInteger(value, 'orderId');
    orderCursor = Math.max(orderCursor, used + 1);
    if (orderCursor >= floor) throw new Error('IBKR order ID reached the reserved request namespace');
    return orderCursor;
  }

  function nextOrderId() {
    while (orderCursor < floor) {
      const candidate = orderCursor++;
      if (!isOrderIdActive(candidate)) return candidate;
    }
    throw new Error('IBKR order ID namespace is exhausted');
  }

  return {
    nextRequestId,
    nextOrderId,
    observeNextValidId,
    observeOrderId,
    snapshot: () => ({ requestCursor, orderCursor, requestFloor: floor, requestCeiling: ceiling }),
  };
}
