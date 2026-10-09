# VisionSwap: start here

This folder is all of VisionSwap: the Solana program that holds the pool, the website and app, the server that relays transactions and runs orders, and the tools to launch and run it. Everything has been built and tested on a private copy of Solana and against real Solana mainnet data. Launching it on mainnet takes about an hour of your time, most of it waiting.

## What's new in version 1.8.0

- **A Wallets tab.** Your users see all their Vision wallets in one place: how much SOL each holds and what it's worth, the tokens in it, and what they can do with it: buy a token, move the SOL back to their private balance, send it anywhere, or show its private key. A wallet they pay from their private balance shows up straight away, marked "Arriving" until the SOL lands, and the message afterwards tells them where their SOL is and how to use it.
- **Nothing jumps.** Actions on one wallet run quietly in the background while they carry on with the next one, which waits its turn. Results show on each wallet's own row, and nothing on the page moves out from under their finger.
- **Several wallets at once.** Fund 2 to 10 new wallets in one go, buy one token across several wallets (new ones from the private balance, or wallets they funded already, with no pool fee), sell the same share of a token from every wallet holding it, and move back or send from several wallets together.
- **Harder to link.** Those wallets take their turns one after another, a random 10 to 60 seconds apart, with slightly different amounts, so they're harder to tie to one person (a faster "Back to back" choice is there too). A progress card shows every wallet, and if the page closes midway, the app offers to continue or stop next time, without ever paying or buying twice.

**What you do for 1.8.0:** follow "Updating later" in `docs/REPLIT.md`, nothing else to set up. If your live site is still on 1.6.2, this one update brings 1.7.0 too (below). Afterwards `/api/health` should show version `1.8.0` and `"ok": true`.

## What came in version 1.7.0

- **Pay any address straight from the wallet, in one step.** On the Send tab, your users pick "Pay from: Your wallet", type the address and the amount, and approve once. Their SOL joins their private balance, then goes to the recipient from the pool by itself as a standard SOL transfer, right away or at a random moment within 15 minutes, 1 hour or 24 hours. The recipient gets the exact amount, and the wallet never appears next to the payment.
- **Picks up where it left off.** The page sends it once the deposit joins the private balance. If someone closes the page first, the SOL is safe in their private balance and the payment picks up the next time they open VisionSwap on that device. A "Payments on their way" card shows where each one is, and any payment can be stopped and kept private until it goes.
- **Smoother buys.** The "add SOL first" pop-up now shows only on Buy, and a buy that needs more SOL offers "Add X SOL from my wallet" in one tap, keeping the form filled in.

**What you do for 1.7.0:** follow "Updating later" in `docs/REPLIT.md`, nothing else to set up. Afterwards `/api/health` should show version `1.7.0` and `"ok": true`.

## What came in version 1.6.0

- **Every private payment to another wallet or an exchange arrives as a standard SOL transfer.** A payment to any address outside your users' own VisionSwap wallets now leaves from a one-time sending address made just for it, which passes the exact amount on in an ordinary wallet-to-wallet transfer. Exchanges and wallets credit it like any other deposit, and each payment's Transaction ID is in the app's activity, ready to give an exchange that asks. This covers payments sent now, sent later, split payments, "Send it yourself" and payment links.
- **Always finished.** Only the user's app holds the key to that sending address, and it can make it again on any device. If a delivery is ever interrupted, your server finishes it, and the app finishes it the next time it opens. SOL that comes back to a sending address shows up in the app, ready to move into the private balance or send on.
- **Recipient checks.** Token accounts and program addresses are caught before anything moves, multisig vaults are paid once confirmed, and an address that only looks like an earlier recipient is shown side by side with it first.
- **Cost.** 0.000012 SOL more per payment to an outside address.

**What you do for 1.6.0:** follow "Updating later" in `docs/REPLIT.md`, nothing else to set up. Afterwards `/api/health` should show version `1.6.0` and `"ok": true`, and `/api/pool/info` should show `"nonce": true` under `delivery`. If you like, open `/app#delivery-check` and send a small amount (0.05 SOL is plenty) to an exchange deposit address, once with each button, to see it credited.

## What came in version 1.5.0

- **Pro orders.** Take-profit in up to 4 steps, trailing stops, a separate price room for stop-losses, and live orders people can edit without approving again. DCA can be paused and resumed, and its timing varies a little so it keeps no fixed rhythm. Limit buys never pay more than the user's price, take-profit steps never sell below theirs, and stop-losses are double-checked on a fresh price (or a live sell quote when a token's prices go quiet), then go first.
- **Nothing lost on updates.** Open orders and scheduled payments now keep running through every update, kept locked (encrypted) in Replit App Storage.
- **Smooth when busy.** The site shares Jupiter fairly: trades, quotes and order checks each have a guaranteed share, with trades getting the most, so stop-loss checks keep running. One busy visitor can't slow everyone else down.
- **Trader controls.** Normal, Fast and Turbo speeds, a custom price room, Max and quick % buttons, and a "minimum you'll receive" the blockchain enforces.
- **Payments.** Send later at a random moment, pay up to 20 people at once, one payment link per payer, and "Send it yourself" with a fresh fee wallet each time.
- **Safer.** A strict security policy on the website, saved keys sealed to the browser, and passkeys checked and backed up before any SOL goes in.

**What you do for 1.5.0:** create the App Storage bucket once (step 3 of `docs/REPLIT.md`), add the free `JUPITER_API_KEY` if you haven't, then follow "Updating later" in `docs/REPLIT.md`. Afterwards `/api/health` should show version `1.5.0`, `"ok": true`, `"replit app storage"` under `state` and `"key": true` under `jupiter`, and `/api/ip-check` should show `"ok": true`.

## What you need first

- **This computer.** It already has the Solana tools installed (inside Ubuntu/WSL), which the launch uses.
- **About 5 SOL** in a wallet you control, for the one-time upload. About 2.3 SOL stays locked as the program's storage deposit (Solana returns it if the program is ever closed). About 0.3 SOL goes to the relayer and the guard so they can pay network fees. The rest goes back to the deployer key when the upload finishes.
- **The wallet that should receive your fees.** Your normal Phantom address is fine.
- **A free Helius account** for a private Solana connection: sign up at helius.dev, then copy the "Mainnet" RPC URL. Solana's free public connection works, but it is slow and limited.
- **A Replit account** to host the website (a Reserved VM deployment). See `docs/REPLIT.md`.
- **A lawyer's opinion** before you take real users' money. Read `docs/LEGAL-NOTES.md` first. It is short.

## Launch, step by step

1. **Double-click `1-MAKE-KEYS.bat`.** It creates four keys in the `keys` folder and shows their addresses. The one marked **Deployer** is your admin key. Back the `keys` folder up somewhere safe and private (a USB stick, an encrypted drive). Anyone with it controls the program's settings.
2. **Send about 5 SOL to the Deployer address** from your own wallet.
3. **Double-click `2-GO-LIVE-MAINNET.bat`.** It asks for your fee wallet and your Helius URL, then builds the program, uploads it, sets up the pool, creates the account your sell fees land in, and funds the relayer and the guard. At the end it writes `keys\REPLIT-SECRETS.txt`. If anything stops it halfway, just run it again: it continues where it left off.
4. **Put the website online** by following `docs/REPLIT.md`: import the zip, add the one secret from `REPLIT-SECRETS.txt` (plus the free `JUPITER_API_KEY`, and `RPC_PROXY_PER_SECOND` set to `5` while you are on Helius's free plan), create the App Storage bucket, paste `REPLIT-AGENT-PROMPT.txt` to Replit's Agent, and publish as a Reserved VM.
5. **Do a small real test yourself:**
   - Open your site and connect Phantom. Choose **Sign to open** (Phantom asks twice the first time).
   - Shield 0.05 SOL. It waits in the waiting room for about 10 minutes, then shows up as your private balance.
   - Send 0.02 SOL to a second wallet of yours, and check that it arrived.
   - Buy a token with 0.02 SOL, then sell it again from the Vision wallet.

## Running it

- **`3-ADMIN.bat`** shows how the pool is doing and lets you change the fee (never above 1%), the deposit limits, the pool cap and the waiting-room time, remove the limits altogether (option 15), or pause new deposits. As the program stands, withdrawals can't be paused, by design.
- **Your income arrives by itself.** The 0.8% pool fee lands in your fee wallet as SOL with every deposit (including a sale's SOL going back into the pool) and every private send, buy and withdrawal. When you move your fees out, always leave at least 0.001 SOL in the fee wallet (never use a wallet's "send max"): below that, small fees are skipped and payments scheduled to go out later wait until their senders open VisionSwap again. Changing the fee wallet in `3-ADMIN.bat` (option 7) tops the new one up for you.
- **Keep the relayer topped up.** Each private payment pays the relayer back its costs plus a little, but give it a small balance (0.25 SOL) to work with. Its address is in `keys` and on `/api/health` of your site.
- **The site is open source.** Publish `VISIONSWAP-OPEN-SOURCE.zip` on GitHub (it has no keys or settings in it), so people can check the code, then add the repository's address as the `REPO_URL` secret on Replit so the footer links to it. The landing page says the code is open, and in privacy, trust comes from openness.
- **Wallet warnings.** Phantom and other wallets can show a caution screen for a brand-new program. After launch, submit your site for review to Phantom (and Blowfish, which Phantom uses) so the warning goes away.
- **When you get busy.** Helius's free plan comfortably serves a modest number of users. If private payments start to slow down or fail with "busy" errors, move to a paid Helius plan, then on Replit raise the `RPC_PROXY_PER_SECOND` secret (about `30` on the Developer plan) in both places and republish. If swaps and orders say "Jupiter is busy", first make sure the free `JUPITER_API_KEY` is set; a paid Jupiter plan adds more room once you also set `JUPITER_RPM` to the plan's calls per minute (see `docs/REPLIT.md`).

## Deposit limits

VisionSwap launched with careful limits: deposits from 0.01 to 25 SOL, and at most 500 SOL in the pool. **Option 15** in `3-ADMIN.bat` removes them: there is then no largest deposit and no cap on the pool, while the 0.01 SOL minimum stays. Options 2 and 3 put limits back at any time. The Docs page on your site always shows the limits that are live on-chain.

Without limits, a single bug could cost users far more, so these steps matter more:

1. Get an independent security audit of `program/` and `circuits/`. If you want extra assurance on the trusted setup, run a public "phase 2" ceremony with outside contributors and upgrade the program with the new verification key; people's notes keep working through such an upgrade.
2. Move program upgrades to a multisig (Squads) using option 9 in `3-ADMIN.bat`.
3. Add a commercial screening feed (the `RANGE_API_KEY` secret on Replit), so money from hacks and scams is caught at the door, not only sanctioned addresses. Bigger deposits attract exactly that money.
4. Once audited and stable, make the program permanent (option 10). After that nobody can change it, including you.

## If something goes wrong

- **The website is down:** users' money is safe on Solana. Restart the deployment on Replit. Open orders and scheduled payments pick up where they left off.
- **`/api/health` says `"replit app storage (unreachable)"` for more than a few minutes:** the App Storage bucket is missing. Create it (step 3 of `docs/REPLIT.md`) and publish again.
- **`/api/health` says `"disk"`:** the install step didn't finish, so the site couldn't load its App Storage support. Ask Replit's Agent to run `npm ci --include=dev`, check that the publishing build in `.replit` still starts with it, and publish again.
- **Private payments fail with "relayer" errors:** the relayer is probably out of SOL. Send it some.
- **You lose the `keys` folder:** the pool keeps working, but you can no longer change its settings or upgrade it. This is why the backup in step 1 matters.
