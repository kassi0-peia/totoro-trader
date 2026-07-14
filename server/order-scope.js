// Exact selected-account filtering for broker order rows. Missing account
// identity is deliberately excluded: guessing would make cancel/KILL capable of
// mutating an order that belongs to another managed account.

export function ordersForAccount(orders, accountValue) {
  const account = String(accountValue ?? '').trim();
  if (!account || !(orders instanceof Map)) return new Map();
  return new Map([...orders].filter(([, order]) => (
    String(order?.account ?? '').trim() === account
  )));
}

function optionalInteger(value, { positive = false } = {}) {
  if (!(typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value)))) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) return null;
  if (positive ? number <= 0 : number < 0) return null;
  return number;
}

// IBKR orderId is scoped to the submitting API client. permId is the stable
// host witness once assigned. Keep all three fields so reqAllOpenOrders rows
// from another client can never overwrite or masquerade as this bridge's row.
export function brokerOrderIdentity(orderIdValue, order = {}) {
  const validOrderIdShape = typeof orderIdValue === 'number'
    || (typeof orderIdValue === 'string' && /^-?\d+$/.test(orderIdValue));
  const rawOrderId = validOrderIdShape ? Number(orderIdValue) : NaN;
  const orderId = Number.isSafeInteger(rawOrderId) ? rawOrderId : null;
  const clientId = optionalInteger(order?.clientId);
  const permId = optionalInteger(order?.permId, { positive: true });
  const key = clientId != null && orderId != null
    ? `client:${clientId}:order:${orderId}${permId != null ? `:perm:${permId}` : ''}`
    : permId != null
      ? `perm:${permId}`
      : orderId != null
        ? `unknown:order:${orderId}`
        : null;
  return { key, orderId, clientId, permId };
}

export function orderIsCancellableByClient(identity, clientIdValue) {
  const clientId = optionalInteger(clientIdValue);
  return !!identity
    && clientId != null
    && Number.isSafeInteger(identity.orderId)
    && identity.orderId >= 0
    && identity.clientId === clientId;
}
