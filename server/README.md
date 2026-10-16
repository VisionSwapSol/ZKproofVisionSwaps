# server/

The VisionSwap service (the relayer, indexer, screening and order services behind [visionswap.net](https://visionswap.net)) is operated by VisionSwap and is not published in this repository.

This folder holds only two data files used by the tests in this repository: the circuit's public verification key (`zk/verification_key.json`, which the SDK's tests compare with the pinned proving files) and a real spend proof (`test/fixtures/spend-proof.json`, which the program's on-chain verifier tests check).
