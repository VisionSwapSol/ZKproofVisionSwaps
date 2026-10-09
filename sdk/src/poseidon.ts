import { poseidon1, poseidon2, poseidon3 } from "poseidon-lite";
import { FIELD } from "./field.ts";

/** circomlib-compatible Poseidon (BN254, x^5), the same function as Solana's sol_poseidon syscall. */
export function H1(a: bigint): bigint {
  check(a);
  return poseidon1([a]);
}

export function H2(a: bigint, b: bigint): bigint {
  check(a);
  check(b);
  return poseidon2([a, b]);
}

export function H3(a: bigint, b: bigint, c: bigint): bigint {
  check(a);
  check(b);
  check(c);
  return poseidon3([a, b, c]);
}

function check(x: bigint) {
  if (x < 0n || x >= FIELD) throw new Error("not a field element");
}
