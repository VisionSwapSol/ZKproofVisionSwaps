//! VisionSwap shielded SOL pool.
//!
//! Deposits wait in a public waiting room for `deposit_delay` slots. During
//! that time the depositor can take the deposit back, and the guard can send
//! it back to the depositor if it turns out to be tainted. After the delay
//! anyone can settle it into the Merkle tree. Spends prove ownership of notes
//! with a Groth16 proof; the program pays the recipient, the relayer and the
//! protocol fee, records the nullifiers and appends the new notes.
//!
//! No admin setting moves settled funds; but spends and settles need `config.treasury` writable (VS-07).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    ed25519_program,
    hash::hash as sha256,
    sysvar::instructions::{load_current_index_checked, load_instruction_at_checked},
};
use anchor_lang::system_program::{transfer, Transfer};
use solana_poseidon::{hashv, Endianness, Parameters};

mod constants;
mod verifier;

use constants::{FIELD_MODULUS, ZEROS};

declare_id!("VSwJY1r9S7nNUyvBzWYr1rBkEMyTAjDFGtixxLGpmt6");

pub const DEPTH: usize = 26;
pub const ROOT_HISTORY: usize = 256;
pub const META_LEN: usize = 28;
/// The protocol fee can never be set above 1%.
pub const MAX_FEE_BPS: u16 = 100;
/// Longest waiting room: 7 days at 400 ms slots, about 3.5 days at 200 ms (SIMD-0525).
pub const MAX_DELAY_SLOTS: u64 = 1_512_000;
pub const ATTESTATION_TAG: &[u8; 4] = b"VSA1";

#[program]
pub mod vision_pool {
    use super::*;

    /// One-time setup. Only the program's upgrade authority may call it.
    pub fn initialize(ctx: Context<Initialize>, params: ConfigParams) -> Result<()> {
        params.validate()?;
        let c = &mut ctx.accounts.config;
        c.admin = ctx.accounts.admin.key();
        c.pending_admin = Pubkey::default();
        c.apply(&params);
        c.bump = ctx.bumps.config;
        c.vault_bump = ctx.bumps.vault;

        let mut t = ctx.accounts.tree.load_init()?;
        for i in 0..DEPTH {
            t.filled_subtrees[i] = ZEROS[i];
        }
        t.roots[0] = ZEROS[DEPTH];
        t.root_index = 0;
        t.next_index = 0;
        emit!(c.as_event());
        Ok(())
    }

    pub fn update_config(ctx: Context<AdminOnly>, params: ConfigParams) -> Result<()> {
        params.validate()?;
        let c = &mut ctx.accounts.config;
        c.apply(&params);
        emit!(c.as_event());
        Ok(())
    }

    pub fn transfer_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.config.pending_admin = new_admin;
        Ok(())
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.admin = ctx.accounts.new_admin.key();
        c.pending_admin = Pubkey::default();
        Ok(())
    }

    /// Puts `amount` lamports in the waiting room as a future note
    /// `Poseidon(amount, inner)`. `meta` is the owner's 28-byte note tag.
    /// The pool fee is paid on top and waits in the pending account with the
    /// deposit: it reaches the treasury at settlement, and a refund returns it.
    /// `max_fee_bps` is the fee the depositor agreed to.
    pub fn deposit(
        ctx: Context<Deposit>,
        amount: u64,
        inner: [u8; 32],
        meta: [u8; META_LEN],
        attestation_expiry: u64,
        max_fee_bps: u16,
    ) -> Result<()> {
        let cfg = &ctx.accounts.config;
        require!(!cfg.deposits_paused, PoolError::DepositsPaused);
        require!(amount >= cfg.min_deposit && amount <= cfg.max_deposit, PoolError::AmountOutOfRange);
        require!(in_field(&inner), PoolError::NotInField);
        require!(cfg.fee_bps <= max_fee_bps, PoolError::FeeAboveLimit);
        if cfg.require_attestation {
            check_attestation(
                &ctx.accounts.instructions.to_account_info(),
                &cfg.guard,
                &ctx.accounts.depositor.key(),
                attestation_expiry,
            )?;
        }

        transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.depositor.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            amount,
        )?;

        let fee = ((amount as u128) * (cfg.fee_bps as u128) / 10_000u128) as u64;
        if fee > 0 {
            transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.depositor.to_account_info(),
                        to: ctx.accounts.pending.to_account_info(),
                    },
                ),
                fee,
            )?;
        }

        if cfg.tvl_cap > 0 {
            let v = ctx.accounts.vault.to_account_info();
            let held = v.lamports().saturating_sub(Rent::get()?.minimum_balance(v.data_len()));
            require!(held <= cfg.tvl_cap, PoolError::PoolFull);
        }

        let mut t = ctx.accounts.tree.load_mut()?;
        t.pending_lamports = t.pending_lamports.checked_add(amount).ok_or(PoolError::Overflow)?;

        let slot = Clock::get()?.slot;
        let p = &mut ctx.accounts.pending;
        p.depositor = ctx.accounts.depositor.key();
        p.amount = amount;
        p.inner = inner;
        p.meta = meta;
        p.slot = slot;
        p.bump = ctx.bumps.pending;

        emit!(DepositQueued { depositor: p.depositor, amount, inner, slot });
        Ok(())
    }

    /// Moves a deposit from the waiting room into the tree. Anyone may call
    /// it once the delay has passed. The deposit fee waiting above the pending
    /// account's rent goes to the treasury; the rent goes back to the depositor.
    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        let cfg = &ctx.accounts.config;
        let p = &ctx.accounts.pending;
        let now = Clock::get()?.slot;
        require!(now >= p.slot.saturating_add(cfg.deposit_delay), PoolError::StillWaiting);

        let leaf = poseidon2(&u64_field(p.amount), &p.inner)?;
        let mut t = ctx.accounts.tree.load_mut()?;
        let (index, root) = insert(&mut t, leaf)?;
        t.pending_lamports = t.pending_lamports.checked_sub(p.amount).ok_or(PoolError::Overflow)?;
        t.deposits = t.deposits.saturating_add(1);

        let pending = ctx.accounts.pending.to_account_info();
        let fee = pending.lamports().saturating_sub(Rent::get()?.minimum_balance(pending.data_len()));
        let treasury = ctx.accounts.treasury.to_account_info();
        if fee > 0 && can_receive(&treasury, fee)? {
            **pending.try_borrow_mut_lamports()? = pending.lamports() - fee;
            credit(&treasury, fee)?;
        }

        emit!(DepositSettled { index, leaf, amount: p.amount, meta: p.meta, root });
        Ok(())
    }

    /// Sends a waiting deposit back to the wallet it came from. The
    /// depositor can do this at any time before settlement; the guard can do
    /// it for deposits it flags. Funds can only ever go back to the depositor.
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let signer = ctx.accounts.authority.key();
        let p = &ctx.accounts.pending;
        let cfg = &ctx.accounts.config;
        require!(signer == p.depositor || signer == cfg.guard, PoolError::NotAllowed);
        let amount = p.amount;

        let vault = ctx.accounts.vault.to_account_info();
        let depositor = ctx.accounts.depositor.to_account_info();
        **vault.try_borrow_mut_lamports()? = vault.lamports().checked_sub(amount).ok_or(PoolError::Overflow)?;
        **depositor.try_borrow_mut_lamports()? = depositor.lamports().checked_add(amount).ok_or(PoolError::Overflow)?;

        let mut t = ctx.accounts.tree.load_mut()?;
        t.pending_lamports = t.pending_lamports.checked_sub(amount).ok_or(PoolError::Overflow)?;

        emit!(DepositRefunded { depositor: p.depositor, amount, inner: p.inner, by_guard: signer != p.depositor });
        Ok(())
    }

    /// Spends up to two notes, creates two new ones, and pays out `withdraw`
    /// lamports: the relayer fee to the relayer, the protocol fee to the
    /// treasury, and the rest to the recipient.
    pub fn transact(ctx: Context<Transact>, args: TransactArgs) -> Result<()> {
        let cfg = &ctx.accounts.config;
        let a = &args;
        require!(a.nullifiers[0] != a.nullifiers[1], PoolError::DuplicateNullifier);
        for x in [&a.root, &a.nullifiers[0], &a.nullifiers[1], &a.commitments[0], &a.commitments[1]] {
            require!(in_field(x), PoolError::NotInField);
        }
        require!(a.relayer_fee <= a.withdraw, PoolError::BadFee);
        require!(cfg.fee_bps <= a.max_fee_bps, PoolError::FeeAboveLimit);
        {
            let t = ctx.accounts.tree.load()?;
            require!(is_known_root(&t, &a.root), PoolError::UnknownRoot);
        }

        let ext_hash = ext_data_hash(
            &ctx.accounts.recipient.key(),
            &ctx.accounts.relayer.key(),
            a.withdraw,
            a.relayer_fee,
            a.max_fee_bps,
            &a.meta0,
            &a.meta1,
        );
        let public = [
            a.root,
            neg_u64_field(a.withdraw),
            ext_hash,
            a.nullifiers[0],
            a.nullifiers[1],
            a.commitments[0],
            a.commitments[1],
        ];
        verifier::verify(&a.proof, &public)?;

        if a.withdraw > 0 {
            let net = a.withdraw - a.relayer_fee;
            let mut protocol_fee = ((net as u128) * (cfg.fee_bps as u128) / 10_000u128) as u64;
            // an emptied treasury must never block a withdrawal
            if protocol_fee > 0 && !can_receive(&ctx.accounts.treasury.to_account_info(), protocol_fee)? {
                protocol_fee = 0;
            }
            let to_recipient = net - protocol_fee;

            let vault = ctx.accounts.vault.to_account_info();
            let pending = ctx.accounts.tree.load()?.pending_lamports;
            let floor = Rent::get()?
                .minimum_balance(vault.data_len())
                .checked_add(pending)
                .ok_or(PoolError::Overflow)?;
            let after = vault.lamports().checked_sub(a.withdraw).ok_or(PoolError::InsufficientPool)?;
            require!(after >= floor, PoolError::InsufficientPool);
            **vault.try_borrow_mut_lamports()? = after;
            credit(&ctx.accounts.recipient.to_account_info(), to_recipient)?;
            credit(&ctx.accounts.relayer.to_account_info(), a.relayer_fee)?;
            credit(&ctx.accounts.treasury.to_account_info(), protocol_fee)?;
        }

        let mut t = ctx.accounts.tree.load_mut()?;
        let (index, _) = insert(&mut t, a.commitments[0])?;
        let (_, root) = insert(&mut t, a.commitments[1])?;
        t.spends = t.spends.saturating_add(1);

        emit!(Spent {
            index,
            commitments: a.commitments,
            metas: [a.meta0, a.meta1],
            nullifiers: a.nullifiers,
            withdraw: a.withdraw,
            root,
        });
        Ok(())
    }
}

// ───────────────────────── helpers ─────────────────────────

fn credit(acc: &AccountInfo, lamports: u64) -> Result<()> {
    if lamports > 0 {
        **acc.try_borrow_mut_lamports()? = acc.lamports().checked_add(lamports).ok_or(PoolError::Overflow)?;
    }
    Ok(())
}

/// Whether `acc` stays rent-exempt after receiving `lamports`. An empty
/// treasury can't take a fee smaller than the rent minimum.
fn can_receive(acc: &AccountInfo, lamports: u64) -> Result<bool> {
    Ok(acc.lamports().saturating_add(lamports) >= Rent::get()?.minimum_balance(acc.data_len()))
}

/// Big-endian `x < p`.
pub fn in_field(x: &[u8; 32]) -> bool {
    for i in 0..32 {
        if x[i] < FIELD_MODULUS[i] {
            return true;
        }
        if x[i] > FIELD_MODULUS[i] {
            return false;
        }
    }
    false
}

pub fn u64_field(v: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&v.to_be_bytes());
    out
}

/// `-v mod p` as a big-endian field element.
pub fn neg_u64_field(v: u64) -> [u8; 32] {
    if v == 0 {
        return [0u8; 32];
    }
    let mut out = FIELD_MODULUS;
    let mut borrow: u16 = 0;
    let vb = u64_field(v);
    for i in (0..32).rev() {
        let a = out[i] as i32;
        let b = vb[i] as i32 + borrow as i32;
        if a >= b {
            out[i] = (a - b) as u8;
            borrow = 0;
        } else {
            out[i] = (a + 256 - b) as u8;
            borrow = 1;
        }
    }
    out
}

pub fn ext_data_hash(
    recipient: &Pubkey,
    relayer: &Pubkey,
    withdraw: u64,
    relayer_fee: u64,
    max_fee_bps: u16,
    meta0: &[u8; META_LEN],
    meta1: &[u8; META_LEN],
) -> [u8; 32] {
    let mut buf = [0u8; 32 + 32 + 8 + 8 + 2 + META_LEN * 2];
    buf[0..32].copy_from_slice(recipient.as_ref());
    buf[32..64].copy_from_slice(relayer.as_ref());
    buf[64..72].copy_from_slice(&withdraw.to_le_bytes());
    buf[72..80].copy_from_slice(&relayer_fee.to_le_bytes());
    buf[80..82].copy_from_slice(&max_fee_bps.to_le_bytes());
    buf[82..110].copy_from_slice(meta0);
    buf[110..138].copy_from_slice(meta1);
    let mut h = sha256(&buf).to_bytes();
    h[0] = 0;
    h
}

fn poseidon2(a: &[u8; 32], b: &[u8; 32]) -> Result<[u8; 32]> {
    let h = hashv(Parameters::Bn254X5, Endianness::BigEndian, &[&a[..], &b[..]])
        .map_err(|_| error!(PoolError::HashFailed))?;
    Ok(h.to_bytes())
}

fn insert(t: &mut Tree, leaf: [u8; 32]) -> Result<(u64, [u8; 32])> {
    let index = t.next_index;
    require!(index < (1u64 << DEPTH), PoolError::TreeFull);
    let mut cur = leaf;
    let mut idx = index;
    for i in 0..DEPTH {
        if idx & 1 == 0 {
            t.filled_subtrees[i] = cur;
            cur = poseidon2(&cur, &ZEROS[i])?;
        } else {
            cur = poseidon2(&t.filled_subtrees[i], &cur)?;
        }
        idx >>= 1;
    }
    let ri = ((t.root_index + 1) % ROOT_HISTORY as u64) as usize;
    t.roots[ri] = cur;
    t.root_index = ri as u64;
    t.next_index = index + 1;
    Ok((index, cur))
}

fn is_known_root(t: &Tree, root: &[u8; 32]) -> bool {
    if root.iter().all(|b| *b == 0) {
        return false;
    }
    let start = t.root_index as usize;
    for k in 0..ROOT_HISTORY {
        let i = (start + ROOT_HISTORY - k) % ROOT_HISTORY;
        if &t.roots[i] == root {
            return true;
        }
    }
    false
}

/// The instruction right before `deposit` must be an Ed25519 check of the
/// guard's signature over "VSA1" || depositor || expiry_slot (LE).
fn check_attestation(ix_sysvar: &AccountInfo, guard: &Pubkey, depositor: &Pubkey, expiry: u64) -> Result<()> {
    require!(Clock::get()?.slot <= expiry, PoolError::AttestationExpired);
    let cur = load_current_index_checked(ix_sysvar)? as usize;
    require!(cur >= 1, PoolError::MissingAttestation);
    let ix = load_instruction_at_checked(cur - 1, ix_sysvar)?;
    require!(ix.program_id == ed25519_program::ID, PoolError::MissingAttestation);
    require!(ix.accounts.is_empty(), PoolError::BadAttestation);
    let d = &ix.data;
    require!(d.len() >= 16 && d[0] == 1, PoolError::BadAttestation);
    let rd = |o: usize| u16::from_le_bytes([d[o], d[o + 1]]) as usize;
    let (sig_off, sig_ix, pk_off, pk_ix, msg_off, msg_len, msg_ix) = (rd(2), rd(4), rd(6), rd(8), rd(10), rd(12), rd(14));
    let here = u16::MAX as usize;
    require!(sig_ix == here && pk_ix == here && msg_ix == here, PoolError::BadAttestation);
    require!(
        sig_off + 64 <= d.len() && pk_off + 32 <= d.len() && msg_off + msg_len <= d.len(),
        PoolError::BadAttestation
    );
    require!(&d[pk_off..pk_off + 32] == guard.as_ref(), PoolError::BadAttestation);
    let mut expect = [0u8; 4 + 32 + 8];
    expect[..4].copy_from_slice(ATTESTATION_TAG);
    expect[4..36].copy_from_slice(depositor.as_ref());
    expect[36..].copy_from_slice(&expiry.to_le_bytes());
    require!(msg_len == expect.len() && d[msg_off..msg_off + msg_len] == expect[..], PoolError::BadAttestation);
    Ok(())
}

// ───────────────────────── accounts ─────────────────────────

#[account]
pub struct Config {
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
    pub guard: Pubkey,
    pub treasury: Pubkey,
    pub fee_bps: u16,
    pub min_deposit: u64,
    pub max_deposit: u64,
    pub tvl_cap: u64,
    pub deposit_delay: u64,
    pub require_attestation: bool,
    pub deposits_paused: bool,
    pub bump: u8,
    pub vault_bump: u8,
}

impl Config {
    pub const LEN: usize = 32 * 4 + 2 + 8 * 4 + 1 + 1 + 1 + 1;

    fn apply(&mut self, p: &ConfigParams) {
        self.guard = p.guard;
        self.treasury = p.treasury;
        self.fee_bps = p.fee_bps;
        self.min_deposit = p.min_deposit;
        self.max_deposit = p.max_deposit;
        self.tvl_cap = p.tvl_cap;
        self.deposit_delay = p.deposit_delay;
        self.require_attestation = p.require_attestation;
        self.deposits_paused = p.deposits_paused;
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ConfigParams {
    pub guard: Pubkey,
    pub treasury: Pubkey,
    pub fee_bps: u16,
    pub min_deposit: u64,
    pub max_deposit: u64,
    pub tvl_cap: u64,
    pub deposit_delay: u64,
    pub require_attestation: bool,
    pub deposits_paused: bool,
}

impl ConfigParams {
    fn validate(&self) -> Result<()> {
        require!(self.fee_bps <= MAX_FEE_BPS, PoolError::FeeAboveLimit);
        require!(self.min_deposit >= 1_000_000, PoolError::AmountOutOfRange);
        require!(self.max_deposit >= self.min_deposit, PoolError::AmountOutOfRange);
        require!(self.deposit_delay <= MAX_DELAY_SLOTS, PoolError::DelayTooLong);
        require!(self.treasury != Pubkey::default(), PoolError::NotAllowed);
        Ok(())
    }
}

#[account(zero_copy)]
#[repr(C)]
pub struct Tree {
    pub next_index: u64,
    pub root_index: u64,
    pub deposits: u64,
    pub spends: u64,
    pub pending_lamports: u64,
    pub reserved: [u64; 3],
    pub filled_subtrees: [[u8; 32]; DEPTH],
    pub roots: [[u8; 32]; ROOT_HISTORY],
}

#[account]
pub struct Vault {}

#[account]
pub struct Nullifier {}

#[account]
pub struct Pending {
    pub depositor: Pubkey,
    pub amount: u64,
    pub inner: [u8; 32],
    pub meta: [u8; META_LEN],
    pub slot: u64,
    pub bump: u8,
}

impl Pending {
    pub const LEN: usize = 32 + 8 + 32 + META_LEN + 8 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TransactArgs {
    pub proof: [u8; 256],
    pub root: [u8; 32],
    pub nullifiers: [[u8; 32]; 2],
    pub commitments: [[u8; 32]; 2],
    pub withdraw: u64,
    pub relayer_fee: u64,
    pub max_fee_bps: u16,
    pub meta0: [u8; META_LEN],
    pub meta1: [u8; META_LEN],
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::LEN, seeds = [b"config"], bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(init, payer = admin, space = 8 + std::mem::size_of::<Tree>(), seeds = [b"tree"], bump)]
    pub tree: AccountLoader<'info, Tree>,
    #[account(init, payer = admin, space = 8, seeds = [b"vault"], bump)]
    pub vault: Account<'info, Vault>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ PoolError::NotUpgradeAuthority)]
    pub program: Program<'info, crate::program::VisionPool>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ PoolError::NotUpgradeAuthority)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin @ PoolError::NotAllowed)]
    pub config: Box<Account<'info, Config>>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        constraint = config.pending_admin == new_admin.key() @ PoolError::NotAllowed
    )]
    pub config: Box<Account<'info, Config>>,
}

#[derive(Accounts)]
#[instruction(amount: u64, inner: [u8; 32])]
pub struct Deposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"tree"], bump)]
    pub tree: AccountLoader<'info, Tree>,
    #[account(mut, seeds = [b"vault"], bump = config.vault_bump)]
    pub vault: Account<'info, Vault>,
    #[account(init, payer = depositor, space = 8 + Pending::LEN, seeds = [b"pending", inner.as_ref()], bump)]
    pub pending: Account<'info, Pending>,
    /// CHECK: the instructions sysvar, read for the guard's attestation
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"tree"], bump)]
    pub tree: AccountLoader<'info, Tree>,
    #[account(mut, close = depositor, seeds = [b"pending", pending.inner.as_ref()], bump = pending.bump)]
    pub pending: Account<'info, Pending>,
    /// CHECK: the depositor, who gets the waiting-room rent back
    #[account(mut, address = pending.depositor @ PoolError::NotAllowed)]
    pub depositor: UncheckedAccount<'info>,
    /// CHECK: must be the configured treasury; receives the deposit fee
    #[account(mut, address = config.treasury @ PoolError::NotAllowed)]
    pub treasury: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"tree"], bump)]
    pub tree: AccountLoader<'info, Tree>,
    #[account(mut, seeds = [b"vault"], bump = config.vault_bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut, close = depositor, seeds = [b"pending", pending.inner.as_ref()], bump = pending.bump)]
    pub pending: Account<'info, Pending>,
    /// CHECK: the original depositor; refunds can only go here
    #[account(mut, address = pending.depositor @ PoolError::NotAllowed)]
    pub depositor: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(args: TransactArgs)]
pub struct Transact<'info> {
    #[account(mut)]
    pub relayer: Signer<'info>,
    /// CHECK: any account; bound to the proof through the ext-data hash
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"tree"], bump)]
    pub tree: AccountLoader<'info, Tree>,
    #[account(mut, seeds = [b"vault"], bump = config.vault_bump)]
    pub vault: Account<'info, Vault>,
    /// CHECK: must be the configured treasury
    #[account(mut, address = config.treasury @ PoolError::NotAllowed)]
    pub treasury: UncheckedAccount<'info>,
    #[account(init, payer = relayer, space = 8, seeds = [b"nf", args.nullifiers[0].as_ref()], bump)]
    pub nullifier0: Account<'info, Nullifier>,
    #[account(init, payer = relayer, space = 8, seeds = [b"nf", args.nullifiers[1].as_ref()], bump)]
    pub nullifier1: Account<'info, Nullifier>,
    pub system_program: Program<'info, System>,
}

// ───────────────────────── events ─────────────────────────

#[event]
pub struct DepositQueued {
    pub depositor: Pubkey,
    pub amount: u64,
    pub inner: [u8; 32],
    pub slot: u64,
}

#[event]
pub struct DepositSettled {
    pub index: u64,
    pub leaf: [u8; 32],
    pub amount: u64,
    pub meta: [u8; META_LEN],
    pub root: [u8; 32],
}

#[event]
pub struct DepositRefunded {
    pub depositor: Pubkey,
    pub amount: u64,
    pub inner: [u8; 32],
    pub by_guard: bool,
}

#[event]
pub struct Spent {
    pub index: u64,
    pub commitments: [[u8; 32]; 2],
    pub metas: [[u8; META_LEN]; 2],
    pub nullifiers: [[u8; 32]; 2],
    pub withdraw: u64,
    pub root: [u8; 32],
}

#[event]
pub struct ConfigUpdated {
    pub guard: Pubkey,
    pub treasury: Pubkey,
    pub fee_bps: u16,
    pub min_deposit: u64,
    pub max_deposit: u64,
    pub tvl_cap: u64,
    pub deposit_delay: u64,
    pub require_attestation: bool,
    pub deposits_paused: bool,
}

impl Config {
    fn as_event(&self) -> ConfigUpdated {
        let c = self;
        ConfigUpdated {
            guard: c.guard,
            treasury: c.treasury,
            fee_bps: c.fee_bps,
            min_deposit: c.min_deposit,
            max_deposit: c.max_deposit,
            tvl_cap: c.tvl_cap,
            deposit_delay: c.deposit_delay,
            require_attestation: c.require_attestation,
            deposits_paused: c.deposits_paused,
        }
    }
}

#[error_code]
pub enum PoolError {
    #[msg("Deposits are paused")]
    DepositsPaused,
    #[msg("Amount outside the allowed range")]
    AmountOutOfRange,
    #[msg("Value is not a field element")]
    NotInField,
    #[msg("The pool is at its deposit cap")]
    PoolFull,
    #[msg("This deposit is still in the waiting room")]
    StillWaiting,
    #[msg("Not allowed")]
    NotAllowed,
    #[msg("Both inputs use the same nullifier")]
    DuplicateNullifier,
    #[msg("Relayer fee is larger than the withdrawal")]
    BadFee,
    #[msg("The protocol fee is above the limit you agreed to")]
    FeeAboveLimit,
    #[msg("Unknown Merkle root; refresh and try again")]
    UnknownRoot,
    #[msg("Invalid proof")]
    InvalidProof,
    #[msg("The pool cannot cover this withdrawal")]
    InsufficientPool,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Poseidon hash failed")]
    HashFailed,
    #[msg("The tree is full")]
    TreeFull,
    #[msg("Screening attestation missing")]
    MissingAttestation,
    #[msg("Screening attestation invalid")]
    BadAttestation,
    #[msg("Screening attestation expired")]
    AttestationExpired,
    #[msg("Waiting-room delay is too long")]
    DelayTooLong,
    #[msg("Only the upgrade authority can initialize the pool")]
    NotUpgradeAuthority,
}
