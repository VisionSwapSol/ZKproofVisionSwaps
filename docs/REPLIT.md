# Putting the website online with Replit

The website, the relayer and the screening guard run as one small server. Replit hosts it. You add one secret, create a storage bucket, then publish.

## 1. Import

1. Go to **replit.com/import** and sign in.
2. Choose **ZIP** and upload `VISIONSWAP-FOR-REPLIT.zip` from your Downloads folder.
3. If the form asks for secrets, add the one in step 2 below. Leave any other names empty: everything is inside that one secret.
4. Choose **Import**. Replit's Agent sets up the project, which takes a few minutes.
5. Open `REPLIT-AGENT-PROMPT.txt`, select all of it, and paste it into the Agent chat.

## 2. Add the one secret

Open `keys\REPLIT-SECRETS.txt` on your computer (double-click it). In the project, select **Tools** at the top, then **Secrets** in the **Setup** section, then **New Secret**:

- **Key:** `VISIONSWAP_CONFIG`
- **Value:** the long line from that file (all of it, nothing else)

Select **Add Secret**. That single secret holds your Helius connection, the program address, and the relayer and guard keys.

**Strongly recommended: a free Jupiter key.** Every swap, price check and order on the site goes through Jupiter, and without a key the whole site shares 30 calls a minute. A free key doubles that and keeps orders and swaps quick when the site is busy. It takes two minutes:

1. Go to **portal.jup.ag**, sign in, open **API Keys**, create a key on the **Free** plan and copy it.
2. Select **New Secret** again. **Key:** `JUPITER_API_KEY`, **Value:** the key you copied.

**On Helius's free plan, one more secret.** Select **New Secret** again. **Key:** `RPC_PROXY_PER_SECOND`, **Value:** `5`. The free plan answers 10 calls a second, and this keeps visitors' browsers to half of that, so private payments and orders always have room. When you move to a paid Helius plan, raise it (about `30` on the Developer plan) or delete it, and republish.

Optional extras: `CONTACT_EMAIL` (shown on the Terms page), `PUBLIC_ORIGIN` (your own domain later), `RANGE_API_KEY`.

## 3. Create the storage bucket (once)

Open the **App Storage** tool (in the left sidebar, or search for it under **Tools**) and select **Create new bucket**. Any name works, and the server finds it by itself.

Replit starts a published site with fresh files on every publish. The bucket is where the site keeps open orders (take-profit, stop-loss, limit buys, DCA) and scheduled payments, so they keep running through every update without anyone reopening the app. Everything in it is locked with a key only your server has. It holds very little and is written only when something changes, so it usually costs very little.

## 4. Publish

1. Select **Publish** in the upper-right corner.
2. Choose your address (like `visionswap.replit.app`) and set access to **Public**.
3. Select **Adjust settings**. Set **Deployment type** to **Reserved VM**: VisionSwap must keep running to settle deposits and relay payments, which Autoscale doesn't do. The smallest machine (Shared VM, 0.5 vCPU / 2 GB) is enough.
4. In the same settings, find **Production app secrets**. Secrets added in the project don't always carry over, so make sure `VISIONSWAP_CONFIG` (and `JUPITER_API_KEY` and `RPC_PROXY_PER_SECOND`, if you added them) is listed. If it isn't, add it there with the same value.
5. Select **Review security**, then **Publish**, and wait for it to finish.

If Replit's Agent offers to change or "fix" the code, decline. VisionSwap is finished and tested.

## 5. Check it

Open `https://<your address>/api/health`. You should see `"version":"1.6.0"`, `"ok":true`, `"network":"mainnet"`, the relayer and guard addresses, and the relayer's balance. If `ok` is `false`, `problems` says why in plain words (for example, the relayer needs more SOL). Under `jupiter`, `"key":true` means your Jupiter key is in use. Under `"state"`, `"backend"` should say `"replit app storage"`. Right after a publish it can briefly say `"replit app storage (unreachable)"` while the site keeps trying on its own. If it says that for more than a few minutes, the bucket from step 3 is missing: create it, then publish again. If it says `"disk"`, the site couldn't load its App Storage support, which means the install step didn't finish: ask the Agent to run `npm ci --include=dev`, check that the publishing build in `.replit` still starts with it, and publish again. (With `"disk"`, `ok` is `false` at once; if it stays `"(unreachable)"` for ten minutes, `ok` turns `false` too, and `problems` says so.)

Then open `https://<your address>/api/ip-check`. Check that `ok` is `true` and that `seenAs` is your own internet address. That is how the site tells visitors apart, so one busy visitor can't slow everyone else down. If `ok` is `false`, `reason` says which way to change `TRUST_PROXY_HOPS`.

To get an email when something needs you, point a free uptime monitor at `https://<your address>/api/health/alerts`. It answers normally while all is well, and with an error naming the problem when the relayer or the guard runs low on SOL (`RELAYER_LOW`, `GUARD_LOW`), the pool index can't move on (`INDEXER_STUCK`), orders and scheduled payments aren't being saved to App Storage (`STATE_NOT_SAVED`: see what `"backend"` says, at the start of this step), scheduled payments run late (`SCHEDULE_LATE`), order trades that are ready to run haven't started for over five minutes (`ORDERS_STALLED`: restart the deployment), or another copy of the site is holding orders and scheduled payments (`STATE_HANDOVER_WAITING`: the site should run on one machine. A new copy takes over by itself after ten minutes at the latest, a copy that was taken over from picks them back up by itself once the other one stops, and a copy that App Storage stopped answering pauses them until it answers again), or orders and scheduled payments couldn't start (`STATE_START_FAILED`: the site tries again every 30 seconds; if it lasts, restart the deployment), or a payment's delivery hasn't landed ten minutes after its pool payment (`DELIVERY_LATE`: the site keeps trying by itself, and the sender's app finishes it too the next time it opens). For `RELAYER_LOW` and `GUARD_LOW`, top up with 3-ADMIN.

`/api/health` shows everyone a summary. For the full details (Jupiter use, prices, orders and scheduled payments waiting), add a secret `HEALTH_TOKEN` with any long random text, in both places like `JUPITER_API_KEY`, and republish. Then open `https://<your address>/api/health?token=<your HEALTH_TOKEN>`, or send it in an `x-health-token` header. Keep it to yourself: the live counts show when people use the site.

## Your own domain

In **Publishing**, open the **Domains** tab and select **Buy a domain**. Search for a name, choose one and pay; it connects to the site by itself, usually within minutes (some networks take up to 48 hours to see it). Link previews follow the address people use automatically. Set `PUBLIC_ORIGIN` only if you want to force one address.

## Updating later

1. In the project's **Files** list, drag in the new `VISIONSWAP-FOR-REPLIT.zip` (or use the three dots at the top of the list, then **Upload file**).
2. Open `REPLIT-UPDATE-PROMPT.txt` on your computer, select all of it, and paste it into the Agent chat.
3. The Agent unpacks the update, rebuilds and republishes. Your secret, your address, any domain you bought, and everyone's open orders and scheduled payments stay as they are. The new copy of the site takes over orders and scheduled payments once the old copy has saved them, usually within a minute; in between, the app waits a moment and tries again by itself. (If you set the site up before the storage bucket existed, create it first, as in step 3 above. The update prompt also asks the Agent to check.)
4. Check it as in step 5: `version` shows the new release (`1.6.0` for this one), `ok` is `true`, `backend` under `state` says `"replit app storage"`, `"key":true` under `jupiter`, and `/api/ip-check` shows `"ok":true`. The Agent reports all of these back to you.

Run only one copy of the server: once the site is published, stop the app in the workspace (the **Stop** button) so the two don't both try to settle the same deposits. The pool lives on Solana, so updating the website never touches anyone's funds.

When an update also changes the on-chain program (version 1.1.0's deposit fee does), update the website first, then upgrade the program with 3-ADMIN, option 13. The new website notices the upgrade by itself within a minute; until then it simply charges no deposit fee.

Check any update at `https://<your address>/api/health`: `version` shows which website is live (`1.6.0` for this release), and `depositFees` turns `true` once the upgraded program is on-chain. Version 1.6.0 changes only the website and server, not the on-chain program.

## Payments to exchanges and other outside addresses (1.6.0)

Every private payment to an address outside the user's own VisionSwap wallets arrives as a standard SOL transfer from a one-time sending address made for that payment, so exchanges and wallets credit it like any other deposit. Nothing needs setting up:

- `https://<your address>/api/pool/info` shows a `delivery` section. `"nonce":true` means payments sent later, and split payments, are delivered while the sender's page is closed.
- For those, the relayer keeps a small reserve of durable nonce accounts (32 to start, about 0.046 SOL of rent). It makes more by itself as more payments are scheduled, while its balance stays above its low mark, and after a busy spell it closes the ones it no longer needs, so their rent comes back to it. The full details at `/api/health?token=…` count them under `deliveries`.
- The key that signs for those nonces comes from the relayer key, so it needs no secret of its own and never holds SOL. If you ever change the relayer key (`RELAYER_SECRET`), payments already scheduled to outside addresses wait for a fresh signature, which each sender's app makes by itself the next time it opens; their SOL stays in their private balance meanwhile. The relayer then makes new nonce accounts under the new key; the old ones stay where they are, and only the old key can close them (about 0.00145 SOL each).
- To see a delivery credited with your own eyes, open `https://<your address>/app#delivery-check` (it isn't linked anywhere). Paste an exchange's SOL deposit address, then send a small amount (0.05 SOL is plenty) once with **Send as L1** (how payments sent now arrive) and once with **Send as N2** (how payments sent later arrive). The page keeps each Transaction ID.

## Your Jupiter key (strongly recommended)

Without a key, Jupiter gives the whole site 30 calls a minute, shared by every visitor's swaps and prices and by the order keeper's price checks. A free key doubles that to 60 and makes it yours alone. The site shares whatever it has fairly: trades, quotes, the order keeper's checks and display prices each have a guaranteed share (40%, 30%, 25% and 5%), so order checks keep running when the site is busy, and no single visitor can take it all.

If you skipped it in step 2:

1. Go to **portal.jup.ag**, sign in, open **API Keys**, create a key on the **Free** plan and copy it.
2. In the project, add a secret named `JUPITER_API_KEY` with that value (**Tools**, **Secrets**, **New Secret**). Add the same in **Publish**, **Adjust settings**, **Production app secrets**.
3. Republish.

**When the site gets busy.** If people often see "Jupiter is busy", a paid Jupiter plan adds room (Developer allows 600 calls a minute). Then add a secret `JUPITER_RPM` with your plan's calls per minute (for example `600`) in both places and republish. The site also notices a bigger plan by itself from Jupiter's replies, up to 600 a minute; for plans above that, also add `JUPITER_RPM_MAX` with the same number. With `HEALTH_TOKEN` set (step 5), `/api/health` shows the allowance in use under `jupiter`.

## Advanced settings

Most sites don't need these. The one to know is `RPC_PROXY_PER_SECOND`, which step 2 sets for Helius's free plan.

- `TRUST_PROXY_HOPS` (default `1`): how many of the host's own public proxies stand in front of the server. Replit has one. Set `off` when nobody's proxy is in front.
- `RPC_PROXY_PER_SECOND` (default `30`): how many network calls a second visitors' browsers may make through the site, all together. The rest of your Helius plan stays free for payments and orders. Each visitor gets a fair share of it: while there is room, at least 4 a second; when it runs low, an even split between everyone active. On Helius's free plan (10 a second), set it to `5` (step 2), which serves about one or two busy visitors at a time.
- `RELAYER_MIN_LAMPORTS` (default `20000000`, that is 0.02 SOL; lamports, or SOL like `0.02`): below this, `/api/health` reports that the relayer needs SOL. `RELAYER_LOW_LAMPORTS` (default 0.05 SOL) is the earlier warning, `RELAYER_LOW` in `/api/health/alerts`.
- `HEALTH_TOKEN` (no default): shows `/api/health`'s full operator details to whoever sends it (see step 5).
