import { CODES, failure, ok } from "./result.js";

// The same rules GameRush applies to the author's items.
const SKU = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACK_MAX_IDS = 100;
// GameRush hands over at most this many pending grants per call, oldest first.
const PENDING_MAX = 100;

function uuid() {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function invalid(message) {
  return failure(CODES.invalidParams, message);
}

// The prices (JPY, tax included) GameRush lets authors set on an item.
export const SHOP_PRICES_JPY = Object.freeze([100, 120, 300, 500, 1000, 2000, 3000, 5000]);

// The kinds of item GameRush sells. A permanent item is bought once; a consumable one any number of times; a
// lottery any number of times, each purchase drawing one permanent or consumable item by its odds.
const ITEM_TYPES = ["permanent", "consumable", "lottery"];
// A lottery's odds are basis points (1/100 of a percent) adding up to this, as on GameRush.
const LOTTERY_BP_TOTAL = 10000;
const LOTTERY_MIN_ENTRIES = 2;
const LOTTERY_MAX_ENTRIES = 30;

function isProduct(product) {
  return (
    product &&
    typeof product === "object" &&
    typeof product.sku === "string" &&
    SKU.test(product.sku) &&
    typeof product.name === "string" &&
    product.name &&
    SHOP_PRICES_JPY.includes(product.priceJpy) &&
    (product.type === undefined || ITEM_TYPES.includes(product.type))
  );
}

// The odds GameRush would accept: 2 to 30 different items, each a whole number of basis points, adding up to
// 10000, and each a permanent or consumable item of the same config.
function oddsOf(odds, items) {
  if (!Array.isArray(odds) || odds.length < LOTTERY_MIN_ENTRIES) return null;
  if (odds.length > LOTTERY_MAX_ENTRIES) return null;
  const seen = new Set();
  let total = 0;
  for (const entry of odds) {
    if (!entry || typeof entry !== "object" || seen.has(entry.sku)) return null;
    if (!Number.isInteger(entry.weightBp) || entry.weightBp < 1) return null;
    if (!items.some((item) => item.sku === entry.sku && item.type !== "lottery")) return null;
    seen.add(entry.sku);
    total += entry.weightBp;
  }
  return total === LOTTERY_BP_TOTAL ? odds.map(({ sku, weightBp }) => ({ sku, weightBp })) : null;
}

// A lottery's draw table, or null when GameRush would refuse it. A fallback lottery hands over fallbackSku (a
// consumable item of the same config) when it draws a permanent item the player owns; a stack lottery hands
// over the drawn item again.
function lotteryOf(product, items) {
  const odds = oddsOf(product.odds, items);
  if (!odds) return null;
  if (product.duplicatePolicy === "stack") {
    if (product.fallbackSku !== undefined && product.fallbackSku !== null) return null;
    return { odds, duplicatePolicy: "stack", fallbackSku: null };
  }
  if (product.duplicatePolicy !== "fallback") return null;
  const fallback = items.find((item) => item.sku === product.fallbackSku);
  if (fallback?.type !== "consumable") return null;
  return { odds, duplicatePolicy: "fallback", fallbackSku: fallback.sku };
}

// The configured products that GameRush would accept from the author. Others are left out, so a typo in
// the config shows up as a missing product instead of a product GameRush could never sell. A product
// without a type is permanent, as on GameRush. A lottery keeps its draw table in `lottery`.
function productsOf(config) {
  const list = Array.isArray(config.shopProducts) ? config.shopProducts : [];
  const items = [];
  for (const product of list) {
    if (!isProduct(product) || items.some((item) => item.sku === product.sku)) continue;
    const { sku, name, priceJpy, type = "permanent" } = product;
    items.push({ sku, name, priceJpy, type, source: product });
  }
  const products = [];
  for (const { source, ...item } of items) {
    if (item.type !== "lottery") {
      products.push(item);
      continue;
    }
    const lottery = lotteryOf(source, items);
    if (lottery) products.push({ ...item, lottery });
  }
  return products;
}

// What GameRush hands the game: a lottery lists its items by name with percentages, and its substitute item.
function productView({ lottery, ...product }, products) {
  if (!lottery) return product;
  const nameOf = (sku) => products.find((item) => item.sku === sku)?.name ?? sku;
  return {
    ...product,
    odds: lottery.odds.map(({ sku, weightBp }) => ({
      sku,
      name: nameOf(sku),
      percent: weightBp / 100,
    })),
    duplicatePolicy: lottery.duplicatePolicy,
    fallback:
      lottery.fallbackSku === null
        ? null
        : { sku: lottery.fallbackSku, name: nameOf(lottery.fallbackSku) },
  };
}

// Draws one item by the odds. random is a number in [0, 1).
export function drawLottery(odds, random) {
  let rest = Math.floor(random * LOTTERY_BP_TOTAL);
  for (const entry of odds) {
    if (rest < entry.weightBp) return entry.sku;
    rest -= entry.weightBp;
  }
  return odds[odds.length - 1].sku;
}

// The author's item shop of the mock. A purchase skips the payment: the grant goes straight to pending and
// the onPending handler is called, as if the player had paid and come back. Handlers resolve the same bare
// values as the GameRush runtime ({ enabled, products }, { status }, a count…). Like GameRush, a permanent
// item already granted is alreadyOwned, while a consumable item can be bought again and never shows in owned.
// A lottery draws by its odds (or the item config.shopLotteryDraw names) and grants the drawn item; a
// permanent item the player owns becomes the substitute (fallback) or a second one (stack, owned's count).
export function createMockShop({ config, now = () => Date.now(), random = () => Math.random() }) {
  let grants = [];
  const signals = [];
  let handler = null;
  let token = null;
  let scheduled = false;

  const enabled = () => config.shopEnabled !== false;
  const grantWire = ({ id, sku, createdAt }) => ({ id, sku, createdAt });
  const owns = (sku) => grants.some((grant) => grant.sku === sku);

  function deliver() {
    scheduled = false;
    while (handler && signals.length > 0) {
      const signal = signals.shift();
      // Like GameRush, a handler that throws does not stop the next signal. sdk.js has already sent the
      // error to the console.
      try {
        handler(signal);
      } catch {}
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(deliver);
  }

  function products() {
    if (!enabled()) return ok({ enabled: false, products: [] });
    const list = productsOf(config);
    return ok({ enabled: true, products: list.map((product) => productView(product, list)) });
  }

  // The item a purchase hands over: the product itself, or what a lottery draws.
  function grantFor(product, list) {
    if (!product.lottery) return { sku: product.sku, consumable: product.type === "consumable" };
    const { odds, duplicatePolicy, fallbackSku } = product.lottery;
    const forced = odds.find((entry) => entry.sku === config.shopLotteryDraw);
    const drawnSku = forced ? forced.sku : drawLottery(odds, random());
    const consumable = list.find((item) => item.sku === drawnSku)?.type === "consumable";
    const fallback = !consumable && duplicatePolicy === "fallback" && owns(drawnSku);
    if (fallback) return { sku: fallbackSku, consumable: true, drawnSku, fallback };
    return { sku: drawnSku, consumable, drawnSku, fallback };
  }

  function purchase({ sku }) {
    if (typeof sku !== "string" || !SKU.test(sku)) return invalid("Invalid sku.");
    // Like the app and LINE, where nothing can be bought.
    if (!enabled()) return failure(CODES.unsupported, "Nothing can be bought here.");
    if (!config.signedIn) return failure(CODES.signInRequired, "Purchases require sign-in.");
    const list = productsOf(config);
    const product = list.find((item) => item.sku === sku);
    if (!product) return invalid("No product for that sku.");
    if (product.type === "permanent" && owns(sku)) return ok({ status: "alreadyOwned" });
    const status = config.shopPurchaseStatus;
    // Like the iOS app: "pending" waits for an approval and grants nothing yet.
    if (status === "cancelled" || status === "pending") return ok({ status });
    const granted = grantFor(product, list);
    grants.push({
      id: uuid(),
      sku: granted.sku,
      createdAt: new Date(now()).toISOString(),
      acked: false,
      consumable: granted.consumable,
    });
    // Like the iOS app: "purchased" puts the grant in pending without leaving the page, so no signal follows.
    if (status === "purchased") {
      const result = { status, sku: granted.sku };
      if (granted.drawnSku === undefined) return ok(result);
      return ok({ ...result, drawnSku: granted.drawnSku, fallback: granted.fallback });
    }
    signals.push({ sku: granted.sku });
    schedule();
    return ok({ status: "redirecting" });
  }

  const pending = () =>
    ok(
      grants
        .filter((grant) => !grant.acked)
        .slice(0, PENDING_MAX)
        .map(grantWire),
    );

  function ack({ ids }) {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > ACK_MAX_IDS) {
      return invalid(`ids must be 1 to ${ACK_MAX_IDS} grant ids.`);
    }
    const wanted = new Set();
    for (const id of ids) {
      if (typeof id !== "string" || !UUID.test(id)) return invalid("ids must be grant ids.");
      wanted.add(id.toLowerCase());
    }
    let acked = 0;
    for (const grant of grants) {
      if (grant.acked || !wanted.has(grant.id.toLowerCase())) continue;
      grant.acked = true;
      acked += 1;
    }
    return ok(acked);
  }

  // Like GameRush: one entry per permanent item, with the id, date and ack of its first grant. count grows when
  // a stack lottery hands over an item the player already owns.
  function owned() {
    const bySku = new Map();
    for (const grant of grants) {
      if (grant.consumable) continue;
      const seen = bySku.get(grant.sku);
      if (seen) seen.count += 1;
      else bySku.set(grant.sku, { ...grantWire(grant), acked: grant.acked, count: 1 });
    }
    return ok([...bySku.values()]);
  }

  // Mirrors GameRush: one handler, replaced by the next registration. A signal that arrived before any
  // handler is handed over once, when one is registered.
  function onPending(next) {
    const own = {};
    handler = next;
    token = own;
    schedule();
    return () => {
      if (token !== own) return;
      handler = null;
      token = null;
    };
  }

  return {
    handlers: { products, purchase, pending, ack, owned },
    onPending,
    reset() {
      grants = [];
      signals.length = 0;
    },
  };
}
