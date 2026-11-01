// GameRush stores cloud saves, player states and leaderboard metadata as JSON and refuses a value it
// cannot store: one that walks more than GAME_JSON_MAX_NODES values or refers back to itself, one
// nested deeper than GAME_JSON_MAX_DEPTH, and one with a lone surrogate in a key or a string. The
// checks run in this order, each over the whole value, so a value with several of these fails with
// the same message. Each walk keeps its own stack, so a deeply nested value does not overflow the
// call stack.
const GAME_JSON_MAX_DEPTH = 3000;
// Every value counts, scalars included. A part shared by several places counts once for each place,
// as JSON.stringify writes it out once for each.
const GAME_JSON_MAX_NODES = 500_000;
const OPERATION_ID_MAX_LENGTH = 100;
// A lone surrogate (half of a UTF-16 pair). With the u flag a whole pair is one code point, so only
// the unpaired halves match.
const HAS_LONE_SURROGATE = /\p{Cs}/u;

function gameJsonWalkable(value) {
  const leave = Symbol("leave");
  const ancestors = new Set();
  const stack = [value];
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === leave) {
      ancestors.delete(stack.pop());
      continue;
    }
    visited += 1;
    if (visited > GAME_JSON_MAX_NODES) return false;
    if (current === null || typeof current !== "object") continue;
    if (ancestors.has(current)) return false;
    ancestors.add(current);
    stack.push(current, leave);
    for (const item of Array.isArray(current) ? current : Object.values(current)) stack.push(item);
  }
  return true;
}

// A scalar is 0 levels deep, [] and {} are 1, [[1]] is 2.
function gameJsonTooDeep(value) {
  const stack = [{ node: value, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop();
    if (node === null || typeof node !== "object") continue;
    if (depth + 1 > GAME_JSON_MAX_DEPTH) return true;
    for (const item of Array.isArray(node) ? node : Object.values(node)) {
      stack.push({ node: item, depth: depth + 1 });
    }
  }
  return false;
}

function gameJsonHasLoneSurrogate(value) {
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === "string") {
      if (HAS_LONE_SURROGATE.test(current)) return true;
    } else if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
    } else if (current !== null && typeof current === "object") {
      for (const [key, item] of Object.entries(current)) {
        if (HAS_LONE_SURROGATE.test(key)) return true;
        stack.push(item);
      }
    }
  }
  return false;
}

// Returns the message GameRush answers with, or null when the value can be stored. label is
// "Cloud save payload", "Player state payload" or "Metadata".
export function gameJsonError(value, label) {
  if (!gameJsonWalkable(value)) return `${label} must be JSON.`;
  if (gameJsonTooDeep(value)) return `${label} is nested too deeply.`;
  if (gameJsonHasLoneSurrogate(value)) return `${label} must not contain lone surrogates.`;
  return null;
}

// Like GameRush, an operationId that is not a string, is empty or is longer than 100 UTF-16 units is
// ignored, and one that is used but holds a lone surrogate is refused. Returns the message or null.
export function operationIdError(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value.length > OPERATION_ID_MAX_LENGTH) return null;
  return HAS_LONE_SURROGATE.test(value) ? "Operation ID must not contain lone surrogates." : null;
}
