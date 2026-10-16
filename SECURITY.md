# Security policy

VisionSwap is a non-custodial, zero-knowledge shielded pool live on Solana mainnet. We value the work of security researchers and welcome every report.

## Reporting a vulnerability

- Email **support@visionswap.net** with "Security" in the subject line. Please do not open a public issue or pull request.
- Describe what you found, how to reproduce it and the impact you expect. A proof of concept against a local validator is the most helpful form.
- Test only on your own setup: `program/scripts/localnet.sh` starts a local validator with the program. Never test against the live pool or other people's funds.

We acknowledge every report, keep you informed while we work on it, and credit you publicly if you wish.

## Responsible disclosure

- Give us a reasonable time to investigate and ship a fix before sharing details with anyone else.
- Do not access, modify or move funds or data that are not yours, and do not degrade the service for others.
- Act in good faith and keep the details private until a fix is live.

## Scope

- The Solana program (`program/`), program ID `VSwJY1r9S7nNUyvBzWYr1rBkEMyTAjDFGtixxLGpmt6` on mainnet.
- The transaction circuit and its setup artifacts (`circuits/`).
- The SDK (`sdk/`), the web app (`web/`) and VisionSwap for Chrome (`extension/`).
- The website, https://visionswap.net.

The same contact is published at `https://visionswap.net/.well-known/security.txt`.

## Contact

- Security reports: support@visionswap.net
- Business, partnerships and press only: business@visionswap.net
