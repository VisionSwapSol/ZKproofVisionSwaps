# VisionSwap release notes

## What's new in 1.8.0

In plain words:

- **A Wallets tab.** Every Vision wallet in one place, in a fixed order by number: its SOL and value, the tokens it holds, a status ("Ready to use", "Holds tokens", "Buy to finish", "Too small to move", "Arriving") and its actions: buy a token, move the SOL back to the private balance, send it to an address, show its private key, or give it a name kept on the device only. A wallet paid from the private balance ("+ Fund new wallets", or "+ A fresh wallet of mine" on Send) is listed the moment it's paid, as "Arriving" until the SOL lands. Payments to the user's own wallets read "Vision wallet #N (yours)" in Scheduled payments, Activity and messages, and the message after paying them says where the SOL is and what can be done with it, with a way to the Wallets tab.
- **Calm, one at a time.** Actions started in the Wallets tab run in the background without covering the page. Pressing another wallet's action while one runs puts it next in line; each row keeps its own half-typed address and shows its own result; an emptied wallet stays in place until the next visit. No browser pop-ups.
- **Several wallets at once.** "+ Fund new wallets" pays 2 to 10 new wallets from the private balance. Buy can pay with the private balance spread across 1, 2, 3, 5 or 10 new wallets, or with Vision wallets already funded ("Same in each" or "All of it", no pool fee). Sell can sell 25%, 50%, 75% or all of one token from every wallet holding it. Ticked wallets can move back or send to one address together. Up to 10 wallets per batch.
- **Paced to be harder to link.** The wallets take their turns one at a time: "One after another" (a random 10 to 60 seconds apart, the default) or "Back to back" (about 6 seconds apart, fastest, easier to see the wallets belong together), and each amount can vary a little (up to 3%). A card shows each wallet's progress; one that doesn't go through never stops the rest, and "Try those again" retries just those. The progress is kept on the device: if the page closes, wallets that haven't had their turn keep their SOL, and on reopening the app checks where an interrupted wallet got to and asks "Continue" or "Stop", so nothing is ever paid or bought twice.

- **$VSWAP on the landing page.** A new section explains how holding $VSWAP shares in VisionSwap's revenue (cashback on trading fees, half the platform revenue buying $VSWAP, every buyback burned, a bigger share as the supply shrinks), with the 55-second tokenomics video (served from the site, chapter buttons) and links to the Tokenomics page and the app.

Operator steps for 1.8.0: nothing new to set up, no server or program change (the web app only). If the live site is still on 1.6.2, publishing 1.8.0 brings the 1.7.0 changes below too. After publishing, `/api/health` should show `"version":"1.8.0"` and `"ok":true`.

## What came in 1.7.0

In plain words:

- **Pay any address straight from your wallet, in one step.** On the Send tab, "Pay from: Your wallet" takes the address and the amount the recipient should get, and the wallet approves one deposit of exactly what the payment needs plus the pool fee (the form shows the total first). The deposit goes through screening and the waiting room like any other; once it joins the private balance, the app proves the payment in the browser and the relayer sends it from the pool as a standard SOL transfer. The recipient gets the exact amount, and the wallet never appears next to the payment.
- **Timing.** "As soon as it's ready", or a random moment within 15 minutes (the default), 1 hour or 24 hours of joining, which makes it harder to match to the deposit. The last choice is remembered on the device.
- **Resumes by itself.** The page sends it once the deposit joins, so it asks people to keep the page open until it says "Handed to the relayer". Closed sooner, nothing is lost: the SOL is in the private balance, and the payment picks up the next time VisionSwap opens on that device. Which deposit pays whom is kept on that device only. A payment is never sent twice, one more than a day old asks first, and "Stop and keep it private" keeps the SOL in the private balance. A "Payments on their way" card shows each one.
- **Buys.** The "Shield first" pop-up now shows only on Buy, and a buy, limit buy or DCA that needs more than the private balance offers "Add X SOL from my wallet", which shields just the difference and keeps the form filled in. An account opened with a private key and nothing in it yet sees the QR code way in on the Send tab.

Operator steps for 1.7.0: nothing new to set up, no server or program change. After publishing, `/api/health` should show `"version":"1.7.0"` and `"ok":true`.

## What came in 1.6.0

In plain words:

- **Every private payment to another wallet or an exchange arrives as a standard SOL transfer.** A payment to any address outside the user's own VisionSwap wallets leaves the pool through a one-time sending address made for that payment alone, which passes the exact amount on in an ordinary wallet-to-wallet SOL transfer, signed beforehand in the user's browser. Exchanges and wallets credit it like any other deposit, and the app's activity shows its Transaction ID, ready to give an exchange that asks. Payments sent now, sent later, split payments, "Send it yourself" and payment links all arrive this way; payments to the user's own Vision wallets, deposit addresses and fee wallets are paid by the pool directly, as before.
- **Always finished.** The one-time address is sealed into the proof, and only the user's app holds its key, made again from the user's own notes on any device. If a delivery is ever interrupted, the server finishes it, and the app finishes it the next time it opens. SOL that comes back to a sending address (an exchange returning a deposit, say) shows under Deliveries, ready to move into the private balance or send on.
- **Recipient checks.** Token accounts, program addresses and nonce accounts are caught before anything moves, a program-managed address such as a multisig vault is paid once the sender confirms it, and an address that only looks like an earlier recipient is shown side by side with it first.
- **Costs.** A payment to an outside address costs 0.000012 SOL more (the network fee of its delivery). "Send it yourself" costs 0.000005 SOL more (one more signature).

Operator steps for 1.6.0 (in `docs/REPLIT.md` and the two Replit prompts): nothing new to create. After publishing, check that `/api/health` shows `"version":"1.6.0"` and `"ok":true`, and that `/api/pool/info` has a `delivery` section with `"nonce":true`. The relayer keeps a small reserve of durable nonce accounts for payments that go out while the page is closed (about 0.046 SOL of refundable rent to start) and makes them by itself. Optional: open `/app#delivery-check` to send a small amount to an exchange deposit address once as L1 and once as N2 and see it credited. Changing the relayer key (`RELAYER_SECRET`) makes payments already scheduled to outside addresses wait for a fresh signature, which each owner's app makes by itself the next time it opens; their SOL stays in their private balance meanwhile.

## What came in 1.5.0

In plain words:

- **Pro orders.** Take-profit in up to 4 steps, trailing stops, a separate price room for the stop-loss, and edits to live orders with no new approval. DCA can pause and resume, and its timing varies a little by default (or runs exact). Limit buys never pay more than the user's price, taxed tokens included; take-profit steps never sell below their price per token traded. Stop-losses are confirmed on a newer price (or, for a token whose prices go quiet, on a live sell quote every 2 minutes) and go first in the queue, with a higher network priority.
- **Orders and scheduled payments survive every update.** They are kept sealed (encrypted) in Replit App Storage, so a republish no longer loses them. An order's key is deleted the moment the order ends.
- **Fair when busy.** Jupiter calls are shared in four lanes with guaranteed shares (trades 40%, quotes 30%, order price checks 25%, display prices 5%), so order checks keep running under load; each visitor gets a fair share when others are waiting, and sends and confirmations have network room set aside.
- **Trader controls.** Normal, Fast and Turbo speeds, a custom price room (0.1% to 25%), Max and 25/50/75/100% chips, a minimum received that the chain enforces, and "Buy with this SOL" on a Vision wallet.
- **Payments.** Send later goes at a random moment inside the window and may go a little early (still inside it) rather than go stale; several recipients sent "now" go out over about two minutes; one payment link per payer; "Send it yourself" uses a fresh fee wallet for each payment.
- **Hardening.** A strict content security policy, private keys sealed to the browser when "Keep me signed in" is on, passkeys confirmed and backed up before any SOL goes in, and many smaller reliability fixes.

Operator steps for 1.5.0 (all in `docs/REPLIT.md` and the two Replit prompts): create an **App Storage bucket** once, add a free **`JUPITER_API_KEY`** (strongly recommended), then after publishing check that `/api/health` shows `"version":"1.5.0"`, `"ok":true`, `state.backend` = `"replit app storage"` and `jupiter.key` = `true`, and that `/api/ip-check` shows `"ok":true`.
