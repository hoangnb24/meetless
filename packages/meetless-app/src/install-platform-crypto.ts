import { getRandomValues, randomUUID } from "expo-crypto";

interface PaseoCryptoPrimitives {
  getRandomValues<T extends Uint8Array>(array: T): T;
  randomUUID(): string;
}

// Browsers and Electron already expose Web Crypto. React Native does not, but
// the pinned neutral Paseo client requires these two secure primitives for
// request IDs and relay-channel initialization.
if (typeof globalThis.crypto === "undefined") {
  Object.defineProperty(globalThis, "crypto", {
    configurable: false,
    enumerable: false,
    value: { getRandomValues, randomUUID } satisfies PaseoCryptoPrimitives,
    writable: false,
  });
}
