import type { TLShape } from "@tldraw/tlschema";

/**
 * Fractional index keys in tldraw's format, without the jitter tldraw adds outside tests, so the
 * same input always yields the same keys. Port of rocicorp/fractional-indexing (CC0).
 */

export type IndexKey = TLShape["index"];

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ZERO = "0";
const SMALLEST_INTEGER = `A${ZERO.repeat(26)}`;

/** A key strictly between `low` and `high`; null means unbounded. */
export function indexBetween(low: string | null, high: string | null): IndexKey {
  // keyBetween only builds valid keys.
  return keyBetween(low, high) as IndexKey;
}

function keyBetween(a: string | null, b: string | null): string {
  if (a === null) {
    if (b === null) return `a${ZERO}`;
    const ib = integerPart(b);
    const fb = b.slice(ib.length);
    if (ib === SMALLEST_INTEGER) return ib + midpoint("", fb);
    if (ib < b) return ib;
    const decremented = decrementInteger(ib);
    if (decremented === null) throw new Error("index key underflow");
    return decremented;
  }
  if (b === null) {
    const ia = integerPart(a);
    const incremented = incrementInteger(ia);
    return incremented ?? ia + midpoint(a.slice(ia.length), null);
  }
  if (a >= b) throw new Error(`index keys out of order: ${a} >= ${b}`);
  const ia = integerPart(a);
  const ib = integerPart(b);
  if (ia === ib) return ia + midpoint(a.slice(ia.length), b.slice(ib.length));
  const incremented = incrementInteger(ia);
  if (incremented !== null && incremented < b) return incremented;
  return ia + midpoint(a.slice(ia.length), null);
}

function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a.charAt(0)) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b.charAt(0)) : DIGITS.length;
  if (digitB - digitA > 1) return DIGITS.charAt(Math.round(0.5 * (digitA + digitB)));
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS.charAt(digitA) + midpoint(a.slice(1), null);
}

function integerLength(head: string): number {
  if (head >= "a" && head <= "z") return head.charCodeAt(0) - 97 + 2;
  if (head >= "A" && head <= "Z") return 90 - head.charCodeAt(0) + 2;
  throw new Error(`invalid index key head: ${head}`);
}

function integerPart(key: string): string {
  return key.slice(0, integerLength(key.charAt(0)));
}

function incrementInteger(x: string): string | null {
  const head = x.charAt(0);
  const digits = x.slice(1).split("");
  let carry = true;
  for (let i = digits.length - 1; carry && i >= 0; i--) {
    const d = DIGITS.indexOf(digits[i] ?? ZERO) + 1;
    if (d === DIGITS.length) digits[i] = ZERO;
    else {
      digits[i] = DIGITS.charAt(d);
      carry = false;
    }
  }
  if (!carry) return head + digits.join("");
  if (head === "Z") return `a${ZERO}`;
  if (head === "z") return null;
  const next = String.fromCharCode(head.charCodeAt(0) + 1);
  if (next > "a") digits.push(ZERO);
  else digits.pop();
  return next + digits.join("");
}

function decrementInteger(x: string): string | null {
  const head = x.charAt(0);
  const digits = x.slice(1).split("");
  let borrow = true;
  for (let i = digits.length - 1; borrow && i >= 0; i--) {
    const d = DIGITS.indexOf(digits[i] ?? ZERO) - 1;
    if (d === -1) digits[i] = DIGITS.charAt(DIGITS.length - 1);
    else {
      digits[i] = DIGITS.charAt(d);
      borrow = false;
    }
  }
  if (!borrow) return head + digits.join("");
  if (head === "a") return `Z${DIGITS.charAt(DIGITS.length - 1)}`;
  if (head === "A") return null;
  const next = String.fromCharCode(head.charCodeAt(0) - 1);
  if (next < "Z") digits.push(DIGITS.charAt(DIGITS.length - 1));
  else digits.pop();
  return next + digits.join("");
}
