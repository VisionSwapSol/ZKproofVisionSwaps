//! Adversarial tests for the Groth16 verifier and the checks `transact` runs
//! on its public inputs (pre-audit VS-33). Host only, never part of the
//! program: `cd program && cargo test --locked --lib`.
//!
//! The proof is the real spend proof in server/test/fixtures/spend-proof.json,
//! made with the verification key in constants.rs. After a new trusted setup,
//! that fixture is made again with the new key.
//!
//! On the host, solana-bn254 computes the alt_bn128 operations in Rust; on
//! the chain the validator's syscalls do. The cases below are the ones whose
//! answer does not depend on that difference. Encodings where the two could
//! differ (coordinates >= p, flag bits, G2 points outside the subgroup) need
//! the validator's own syscalls, so they belong in localnet tests.

use crate::constants::{FIELD_MODULUS, ZEROS};
use crate::verifier::{verify, N_PUBLIC};
use crate::{ext_data_hash, in_field, neg_u64_field, u64_field, META_LEN};
use anchor_lang::prelude::Pubkey;

const FIXTURE: &str = include_str!("../../../../server/test/fixtures/spend-proof.json");
/// BN254 base field (curve coordinates), decimal.
const BASE_FIELD: &str = "21888242871839275222246405745257275088696311157297823662689037894645226208583";

// ───── small big-endian helpers ─────

fn from_dec(s: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for ch in s.trim().bytes() {
        assert!(ch.is_ascii_digit(), "not a decimal number: {s}");
        let mut carry = (ch - b'0') as u32;
        for b in out.iter_mut().rev() {
            let v = (*b as u32) * 10 + carry;
            *b = (v & 0xff) as u8;
            carry = v >> 8;
        }
        assert_eq!(carry, 0, "does not fit in 32 bytes: {s}");
    }
    out
}

/// a + b; None when the sum does not fit in 32 bytes.
fn add(a: &[u8; 32], b: &[u8; 32]) -> Option<[u8; 32]> {
    let mut out = [0u8; 32];
    let mut carry = 0u16;
    for i in (0..32).rev() {
        let v = a[i] as u16 + b[i] as u16 + carry;
        out[i] = (v & 0xff) as u8;
        carry = v >> 8;
    }
    (carry == 0).then_some(out)
}

/// a - b, for a >= b.
fn sub(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let mut v = a[i] as i16 - b[i] as i16 - borrow;
        borrow = if v < 0 { 1 } else { 0 };
        if v < 0 {
            v += 256;
        }
        out[i] = v as u8;
    }
    assert_eq!(borrow, 0, "sub underflow");
    out
}

fn one() -> [u8; 32] {
    let mut o = [0u8; 32];
    o[31] = 1;
    o
}

fn base64(s: &str) -> Vec<u8> {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes().filter(|c| *c != b'=') {
        let v = T.iter().position(|t| *t == c).expect("base64") as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    out
}

/// The fixture: 256 proof bytes (-A, B, C) and the 7 public inputs in the program's order.
fn fixture() -> ([u8; 256], [[u8; 32]; N_PUBLIC]) {
    let after = |key: &str| FIXTURE.split(key).nth(1).expect(key);
    let proof_b64 = after("\"proof\"").split('"').nth(1).unwrap();
    let proof: [u8; 256] = base64(proof_b64).try_into().expect("256-byte proof");
    let list = after("\"inputs\"").split('[').nth(1).unwrap().split(']').next().unwrap();
    let inputs: Vec<[u8; 32]> = list.split(',').map(|x| from_dec(x.trim().trim_matches('"'))).collect();
    (proof, inputs.try_into().expect("7 public inputs"))
}

fn p() -> [u8; 32] {
    from_dec(BASE_FIELD)
}

/// -y mod p for a coordinate (0 stays 0).
fn neg_coord(y: &[u8]) -> [u8; 32] {
    let y: [u8; 32] = y.try_into().unwrap();
    if y == [0u8; 32] {
        y
    } else {
        sub(&p(), &y)
    }
}

fn negate_g1(proof: &mut [u8; 256], at: usize) {
    let y = neg_coord(&proof[at + 32..at + 64]);
    proof[at + 32..at + 64].copy_from_slice(&y);
}

/// G2 is x.c1 || x.c0 || y.c1 || y.c0; negation negates both halves of y.
fn negate_g2(proof: &mut [u8; 256], at: usize) {
    for off in [64usize, 96] {
        let c = neg_coord(&proof[at + off..at + off + 32]);
        proof[at + off..at + off + 32].copy_from_slice(&c);
    }
}

// ───── the verifier ─────

#[test]
fn the_real_proof_verifies() {
    let (proof, public) = fixture();
    assert!(verify(&proof, &public).is_ok());
    for x in &public {
        assert!(in_field(x), "the fixture's inputs are canonical");
    }
}

#[test]
fn changing_any_public_input_fails() {
    let (proof, public) = fixture();
    for i in 0..N_PUBLIC {
        let mut bad = public;
        bad[i] = add(&bad[i], &one()).unwrap();
        assert!(verify(&proof, &bad).is_err(), "input {i} + 1 was accepted");
    }
}

/// `verify` itself treats x and x + k·r alike (the multiplication reduces the
/// scalar), so an alias of a nullifier would pass it. `transact` rejects every
/// caller-supplied input that is not below r (`in_field`), and computes the
/// other two (publicAmount, extDataHash) itself. This test pins down both
/// halves: if `verify` starts rejecting aliases (pre-audit VS-50), update it.
#[test]
fn aliases_x_plus_k_r_pass_verify_but_not_in_field() {
    let (proof, public) = fixture();
    let mut aliases_tried = 0;
    for i in 0..N_PUBLIC {
        let mut alias = public[i];
        for k in 1..=4 {
            let Some(next) = add(&alias, &FIELD_MODULUS) else { break };
            alias = next;
            assert!(!in_field(&alias), "input {i} + {k}r counts as in the field");
            let mut bad = public;
            bad[i] = alias;
            assert!(verify(&proof, &bad).is_ok(), "input {i} + {k}r: verify alone no longer accepts aliases; update this test");
            aliases_tried += 1;
        }
    }
    assert!(aliases_tried >= N_PUBLIC, "every input has at least the +r alias");
}

#[test]
fn swapped_or_duplicate_nullifiers_and_commitments_fail() {
    let (proof, public) = fixture();
    let mut swapped = public;
    swapped.swap(3, 4);
    assert!(verify(&proof, &swapped).is_err(), "swapped nullifiers");
    let mut dup = public;
    dup[4] = dup[3];
    assert!(verify(&proof, &dup).is_err(), "duplicate nullifier");
    let mut outs = public;
    outs.swap(5, 6);
    assert!(verify(&proof, &outs).is_err(), "swapped commitments");
}

#[test]
fn another_root_fails() {
    let (proof, public) = fixture();
    let mut bad = public;
    bad[0] = ZEROS[26]; // the empty tree's root
    assert!(verify(&proof, &bad).is_err());
}

#[test]
fn public_amount_is_minus_withdraw_and_its_sign_matters() {
    let (proof, public) = fixture();
    // the fixture withdraws 20,000,000 lamports
    assert_eq!(neg_u64_field(20_000_000), public[1]);
    let mut more = public;
    more[1] = neg_u64_field(20_000_001);
    assert!(verify(&proof, &more).is_err(), "a larger withdraw");
    let mut minted = public;
    minted[1] = u64_field(20_000_000);
    assert!(verify(&proof, &minted).is_err(), "+withdraw would create value");
    let mut none = public;
    none[1] = neg_u64_field(0);
    assert!(verify(&proof, &none).is_err(), "no withdraw");
}

#[test]
fn malleated_proofs() {
    let (proof, public) = fixture();
    let check = |p: &[u8; 256]| verify(p, &public).is_ok();

    let mut a = proof;
    negate_g1(&mut a, 0); // A instead of -A
    assert!(!check(&a), "A not negated");
    let mut b = proof;
    negate_g2(&mut b, 64);
    assert!(!check(&b), "B negated alone");
    let mut c = proof;
    negate_g1(&mut c, 192);
    assert!(!check(&c), "C negated");
    let mut ac = proof;
    ac[0..64].copy_from_slice(&proof[192..256]);
    ac[192..256].copy_from_slice(&proof[0..64]);
    assert!(!check(&ac), "A and C swapped");

    // Groth16 is malleable: e(A, -B) = e(-A, B), so negating both A and B
    // gives a second valid proof of the same statement. Spends stay unique
    // through their nullifiers, never through the proof bytes.
    let mut ab = proof;
    negate_g1(&mut ab, 0);
    negate_g2(&mut ab, 64);
    assert!(check(&ab), "the (A, -B) twin of a valid proof");
}

#[test]
fn points_off_the_curve_or_at_infinity_fail() {
    let (proof, public) = fixture();
    for (name, at, len) in [("A", 0usize, 64usize), ("B", 64, 128), ("C", 192, 64)] {
        let mut off = proof;
        let last = at + len - 1;
        off[last] ^= 1; // y (or y.c0) changes: almost surely off the curve
        assert!(verify(&off, &public).is_err(), "{name} off the curve");
        let mut zero = proof;
        zero[at..at + len].fill(0); // the encoding of the point at infinity
        assert!(verify(&zero, &public).is_err(), "{name} at infinity");
    }
    assert!(verify(&[0u8; 256], &public).is_err(), "all-zero proof");
}

// ───── the input checks transact runs ─────

#[test]
fn in_field_boundaries() {
    let r = FIELD_MODULUS;
    let r_minus_1 = sub(&r, &one());
    assert!(in_field(&[0u8; 32]));
    assert!(in_field(&r_minus_1));
    assert!(!in_field(&r));
    assert!(!in_field(&add(&r, &one()).unwrap()));
    assert!(!in_field(&[0xff; 32]));
}

#[test]
fn neg_u64_field_is_canonical_and_exact() {
    assert_eq!(neg_u64_field(0), [0u8; 32]);
    for v in [1u64, 20_000_000, 1 << 63, u64::MAX] {
        let n = neg_u64_field(v);
        assert!(in_field(&n));
        assert_eq!(add(&n, &u64_field(v)).unwrap(), FIELD_MODULUS, "-{v} + {v} must be r");
    }
}

/// The same ext data the SDK test (sdk/test/adversarial.test.ts) hashes: both
/// sides must produce this value, or proofs made by the app would not verify.
#[test]
fn ext_data_hash_matches_the_sdk_and_fits_the_field() {
    let bytes = |f: &dyn Fn(usize) -> usize| -> [u8; 32] { core::array::from_fn(|i| (f(i) & 0xff) as u8) };
    let meta = |f: &dyn Fn(usize) -> usize| -> [u8; META_LEN] { core::array::from_fn(|i| (f(i) & 0xff) as u8) };
    let recipient = Pubkey::new_from_array(bytes(&|i| i + 1));
    let relayer = Pubkey::new_from_array(bytes(&|i| i + 33));
    let h = ext_data_hash(&recipient, &relayer, 1_234_567_890, 1_500_000, 80, &meta(&|i| i * 7), &meta(&|i| 255 - i));
    let hex: String = h.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(hex, "005667903f773df01e5f3614baec793da979ef1d7efe339b688a1ff086aaaa35");
    assert_eq!(h[0], 0);
    assert!(in_field(&h));

    // any field change gives another hash
    let other = ext_data_hash(&relayer, &relayer, 1_234_567_890, 1_500_000, 80, &meta(&|i| i * 7), &meta(&|i| 255 - i));
    assert_ne!(h, other);
    let fee = ext_data_hash(&recipient, &relayer, 1_234_567_890, 1_500_001, 80, &meta(&|i| i * 7), &meta(&|i| 255 - i));
    assert_ne!(h, fee);
}
