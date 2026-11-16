import { CODES, failure, ok } from "./result.js";

// The same rules GameRush applies to the author's items.
const SKU = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACK_MAX_IDS = 100;

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

// The configured products that GameRush would accept from the author. Others are left out, so a typo in
// the config shows up as a missing product instead of a product GameRush could never sell.
function productsOf(config) {
  const list = Array.isArray(config.shopProducts) ? config.shopProducts : [];
  return list
    .filter(
      (product) =>
        product &&
        typeof product === "object" &&
        typeof product.sku === "string" &&
        SKU.test(product.sku) &&
        typeof product.name === "string" &&
        product.name &&
        Number.isInteger(product.priceJpy),
    )
    .map(({ sku, name, priceJpy }) => ({ sku, name, priceJpy }));
}

// The author's item shop of the mock. A purchase skips the payment: the grant goes straight to pending and
// the onPending handler is called, as if the player had paid and come back. Handlers resolve the same bare
// values as the GameRush runtime ({ enabled, products }, { status }, a count…).
export function createMockShop({ config, now = () => Date.now() }) {
  let grants = [];
  const signals = [];
  let handler = null;
  let token = null;
  let scheduled = false;

  const enabled = () => config.shopEnabled !== false;
  const grantWire = ({ id, sku, createdAt }) => ({ id, sku, createdAt });

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
    return ok({ enabled: true, products: productsOf(config) });
  }

  function purchase({ sku }) {
    if (typeof sku !== "string" || !SKU.test(sku)) return invalid("Invalid sku.");
    if (!enabled()) return failure(CODES.unavailable, "The shop of this game is not open.");
    if (!config.signedIn) return failure(CODES.signInRequired, "Purchases require sign-in.");
    if (!productsOf(config).some((product) => product.sku === sku)) {
      return invalid("No product for that sku.");
    }
    if (grants.some((grant) => grant.sku === sku)) return ok({ status: "alreadyOwned" });
    if (config.shopPurchaseStatus === "cancelled") return ok({ status: "cancelled" });
    grants.push({ id: uuid(), sku, createdAt: new Date(now()).toISOString(), acked: false });
    signals.push({ sku });
    schedule();
    return ok({ status: "redirecting" });
  }

  const pending = () => ok(grants.filter((grant) => !grant.acked).map(grantWire));

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

  const owned = () => ok(grants.map((grant) => ({ ...grantWire(grant), acked: grant.acked })));

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
