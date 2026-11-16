const text = (value, fallback = "") => (typeof value === "string" ? value : fallback);
const number = (value, fallback = 0) => (typeof value === "number" ? value : fallback);
const nullableText = (value) => (typeof value === "string" ? value : null);

export function playerOf(raw) {
  if (!raw || typeof raw !== "object") return null;
  const source = raw;
  const consent = source.profileConsent === true;
  const profile =
    consent && source.profile && typeof source.profile === "object" ? source.profile : {};
  return {
    pseudoId: text(source.pseudoId),
    isGuest: source.isGuest !== false,
    profileConsent: consent,
    displayName: nullableText(profile.displayName),
    avatarUrl: nullableText(profile.avatarUrl),
  };
}

export function peerOf(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    index: number(source.index, -1),
    pseudoId: text(source.pseudoId),
    displayName: nullableText(source.displayName),
    avatarUrl: nullableText(source.avatarUrl),
  };
}

export function leaderboardDefinitionOf(raw) {
  if (!raw || typeof raw !== "object") return null;
  const source = raw;
  return {
    key: text(source.key),
    title: text(source.title),
    sort: source.sort === "asc" ? "asc" : "desc",
    valueType: text(source.valueType, "int"),
    aggregation: text(source.aggregation, "best"),
    period: text(source.period, "all_time"),
    minValue: typeof source.minValue === "number" ? source.minValue : null,
    maxValue: typeof source.maxValue === "number" ? source.maxValue : null,
  };
}

export function submitResultOf(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    accepted: raw.accepted === true,
    updated: raw.updated === true,
    value: number(raw.value),
    rank: typeof raw.rank === "number" ? raw.rank : null,
    verified: false,
  };
}

function entryOf(raw) {
  if (!raw || typeof raw !== "object") return null;
  const source = raw;
  return {
    rank: number(source.rank),
    pseudoId: text(source.pseudoId),
    displayName: nullableText(source.displayName),
    avatarUrl: nullableText(source.avatarUrl),
    isGuest: source.isGuest !== false,
    value: number(source.value),
    metadata: source.metadata ?? null,
    submittedAt: text(source.submittedAt),
    isSelf: source.isSelf === true,
  };
}

export function leaderboardPageOf(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    key: text(raw.key),
    title: text(raw.title),
    sort: raw.sort === "asc" ? "asc" : "desc",
    valueType: text(raw.valueType, "int"),
    period: text(raw.period, "all_time"),
    periodKey: text(raw.periodKey),
    verified: false,
    entries: Array.isArray(raw.entries)
      ? raw.entries.map(entryOf).filter((entry) => entry !== null)
      : [],
    total: number(raw.total),
  };
}

export function playerStateOf(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    pseudoId: text(raw.pseudoId),
    payload: raw.payload ?? {},
    revision: number(raw.revision),
    rating: typeof raw.rating === "number" ? raw.rating : null,
    updatedAt: text(raw.updatedAt),
  };
}

// The runtime may hand back either the bare value or the RPC result that wraps it ({ states }, { sent }…).
export function unwrap(raw, key) {
  return raw && typeof raw === "object" && !Array.isArray(raw) && key in raw ? raw[key] : raw;
}

export function countOf(raw, key) {
  const value = unwrap(raw, key);
  return typeof value === "number" ? value : undefined;
}

export function flagOf(raw, key) {
  return unwrap(raw, key) === true;
}

function payloadOf(raw) {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

export function inboxMessageOf(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id) return null;
  return {
    id: raw.id,
    from: text(raw.from),
    kind: text(raw.kind),
    payload: payloadOf(raw.payload),
    createdAt: text(raw.createdAt),
    readAt: nullableText(raw.readAt),
  };
}

export function inboxPageOf(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.messages)) return null;
  return {
    messages: raw.messages.map(inboxMessageOf).filter((message) => message !== null),
    unreadCount: number(raw.unreadCount),
    nextCursor: nullableText(raw.nextCursor),
  };
}

const TRADE_OUTCOMES = new Set(["matched", "taken", "expired", "cancelled", "notFound"]);

export function tradeOf(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id) return null;
  return {
    id: raw.id,
    from: nullableText(raw.from),
    to: nullableText(raw.to),
    taker: nullableText(raw.taker),
    offer: payloadOf(raw.offer),
    want: payloadOf(raw.want),
    offerKey: nullableText(raw.offerKey),
    wantKey: nullableText(raw.wantKey),
    give: raw.give && typeof raw.give === "object" && !Array.isArray(raw.give) ? raw.give : null,
    // A status this SDK does not know yet is passed through as is, so a newer GameRush still reads.
    status: text(raw.status),
    createdAt: text(raw.createdAt),
    expiresAt: text(raw.expiresAt),
    settledAt: nullableText(raw.settledAt),
  };
}

function pendingTradeOf(raw) {
  const trade = tradeOf(raw);
  if (!trade) return null;
  return { ...trade, role: text(raw.role), action: text(raw.action) };
}

export function tradePageOf(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.trades)) return null;
  return {
    trades: raw.trades.map(tradeOf).filter((trade) => trade !== null),
    nextCursor: nullableText(raw.nextCursor),
  };
}

export function myTradesOf(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!Array.isArray(raw.open) || !Array.isArray(raw.pending)) return null;
  return {
    open: raw.open.map(tradeOf).filter((trade) => trade !== null),
    pending: raw.pending.map(pendingTradeOf).filter((trade) => trade !== null),
  };
}

export function acceptResultOf(raw) {
  if (!raw || typeof raw !== "object" || !TRADE_OUTCOMES.has(raw.outcome)) return null;
  return { outcome: raw.outcome, trade: tradeOf(raw.trade) };
}

export function cloudSaveOf(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    slot: text(raw.slot, "default"),
    payload: raw.payload ?? null,
    revision: number(raw.revision),
    createdAt: text(raw.createdAt),
    updatedAt: text(raw.updatedAt),
    storage: raw.storage === "local" ? "local" : "cloud",
  };
}

export function shareResultOf(raw) {
  if (!raw || typeof raw !== "object") return null;
  return { status: raw.status === "opened" ? "opened" : "cancelled" };
}

export function localeOf(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.locale !== "string" || !raw.locale) return null;
  const languages = Array.isArray(raw.languages)
    ? raw.languages.filter((tag) => typeof tag === "string" && tag)
    : [];
  return {
    locale: raw.locale,
    source: typeof raw.source === "string" && raw.source ? raw.source : "device",
    languages: languages.length ? languages : [raw.locale],
  };
}

// GameRush has already checked the keys and values, so only the shape is kept here. Object.fromEntries
// keeps a "__proto__" key as an own property instead of changing the prototype.
export function launchOf(raw) {
  if (!raw || typeof raw !== "object") return null;
  const params = raw.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  return {
    params: Object.fromEntries(
      Object.entries(params).filter(([, value]) => typeof value === "string"),
    ),
  };
}

// GameRush checks the sku, name and price when the author registers a product, so only the shape is kept.
function shopProductOf(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.sku !== "string" || !raw.sku) return null;
  return { sku: raw.sku, name: text(raw.name), priceJpy: number(raw.priceJpy) };
}

export function shopProductsOf(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.products)) return null;
  const enabled = raw.enabled === true;
  // A shop that is not open sells nothing, so its list is empty even if the runtime sent one.
  return {
    enabled,
    products: enabled
      ? raw.products.map(shopProductOf).filter((product) => product !== null)
      : [],
  };
}

export function shopPurchaseOf(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.status !== "string" || !raw.status) return null;
  // A status this SDK does not know yet is passed through as is, so a newer GameRush still reads.
  return { status: raw.status };
}

export function shopGrantOf(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id) return null;
  if (typeof raw.sku !== "string" || !raw.sku) return null;
  return { id: raw.id, sku: raw.sku, createdAt: text(raw.createdAt) };
}

export function ownedShopGrantOf(raw) {
  const grant = shopGrantOf(raw);
  return grant ? { ...grant, acked: raw.acked === true } : null;
}

export function shopPendingEventOf(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.sku !== "string" || !raw.sku) return null;
  return { sku: raw.sku };
}
