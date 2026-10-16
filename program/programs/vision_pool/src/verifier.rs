//! Groth16 verification over BN254 using Solana's alt_bn128 syscalls.
//! Layout follows EIP-197: G1 = x || y, G2 = x.c1 || x.c0 || y.c1 || y.c0,
//! all 32-byte big-endian. The client sends A already negated.

use crate::constants::{VK_ALPHA_G1, VK_BETA_G2, VK_DELTA_G2, VK_GAMMA_G2, VK_IC};
use crate::PoolError;
use anchor_lang::prelude::*;
use solana_bn254::prelude::{alt_bn128_addition, alt_bn128_multiplication, alt_bn128_pairing};

pub const N_PUBLIC: usize = 7;

pub fn verify(proof: &[u8; 256], public: &[[u8; 32]; N_PUBLIC]) -> Result<()> {
    // vk_x = IC[0] + sum(public[i] * IC[i + 1])
    let mut acc: [u8; 64] = VK_IC[0];
    for i in 0..N_PUBLIC {
        let mut mul_in = [0u8; 96];
        mul_in[..64].copy_from_slice(&VK_IC[i + 1]);
        mul_in[64..].copy_from_slice(&public[i]);
        let term = alt_bn128_multiplication(&mul_in).map_err(|_| error!(PoolError::InvalidProof))?;
        let mut add_in = [0u8; 128];
        add_in[..64].copy_from_slice(&acc);
        add_in[64..].copy_from_slice(&term);
        let sum = alt_bn128_addition(&add_in).map_err(|_| error!(PoolError::InvalidProof))?;
        acc.copy_from_slice(&sum);
    }

    // e(-A, B) * e(alpha, beta) * e(vk_x, gamma) * e(C, delta) == 1
    let mut pairing = [0u8; 768];
    pairing[0..64].copy_from_slice(&proof[0..64]);
    pairing[64..192].copy_from_slice(&proof[64..192]);
    pairing[192..256].copy_from_slice(&VK_ALPHA_G1);
    pairing[256..384].copy_from_slice(&VK_BETA_G2);
    pairing[384..448].copy_from_slice(&acc);
    pairing[448..576].copy_from_slice(&VK_GAMMA_G2);
    pairing[576..640].copy_from_slice(&proof[192..256]);
    pairing[640..768].copy_from_slice(&VK_DELTA_G2);
    let out = alt_bn128_pairing(&pairing).map_err(|_| error!(PoolError::InvalidProof))?;
    let ok = out.len() == 32 && out[31] == 1 && out[..31].iter().all(|b| *b == 0);
    require!(ok, PoolError::InvalidProof);
    Ok(())
}

// Host tests only. Not under idl-build: `anchor idl build` compiles the crate's
// tests, and these read a fixture from server/ that a copy of program/ lacks.
#[cfg(all(test, not(feature = "idl-build")))]
#[path = "adversarial_tests.rs"]
mod adversarial_tests;
