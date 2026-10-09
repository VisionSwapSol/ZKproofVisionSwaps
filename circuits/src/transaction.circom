pragma circom 2.2.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/comparators.circom";

/*
  VisionSwap shielded pool, transaction circuit.

  A note is a leaf in a depth-`levels` Poseidon Merkle tree:

      pubKey  = Poseidon(privKey)
      inner   = Poseidon(pubKey, blinding)
      leaf    = Poseidon(amount, inner)

  Deposits never use this circuit: the program hashes Poseidon(amount, inner)
  itself, because the deposited amount is public anyway.

  Spending a note reveals its nullifier

      sig       = Poseidon(privKey, leaf, leafIndex)
      nullifier = Poseidon(leaf, leafIndex, sig)

  which the program records so the note can never be spent twice. Including
  leafIndex keeps two identical leaves at different positions independent.

  Public inputs, in order:
      root, publicAmount, extDataHash,
      inputNullifier[nIns], outputCommitment[nOuts]

  publicAmount = -(lamports leaving the pool) mod p, computed by the program.
  extDataHash binds recipient, relayer, fees and encrypted note data, so a
  relayer cannot change any of them.
*/

template MerkleRoot(levels) {
    signal input leaf;
    signal input pathIndexBits[levels];
    signal input pathElements[levels];
    signal output root;

    component hashers[levels];
    signal cur[levels + 1];
    signal left[levels];
    cur[0] <== leaf;
    for (var i = 0; i < levels; i++) {
        // bit = 0: cur is the left child; bit = 1: cur is the right child
        left[i] <== cur[i] + pathIndexBits[i] * (pathElements[i] - cur[i]);
        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== left[i];
        hashers[i].inputs[1] <== cur[i] + pathElements[i] - left[i];
        cur[i + 1] <== hashers[i].out;
    }
    root <== cur[levels];
}

template Transaction(levels, nIns, nOuts) {
    signal input root;
    signal input publicAmount;
    signal input extDataHash;
    signal input inputNullifier[nIns];
    signal input outputCommitment[nOuts];

    signal input inAmount[nIns];
    signal input inPrivateKey[nIns];
    signal input inBlinding[nIns];
    signal input inPathIndex[nIns];
    signal input inPathElements[nIns][levels];

    signal input outAmount[nOuts];
    signal input outPubkey[nOuts];
    signal input outBlinding[nOuts];

    component inKey[nIns];
    component inInner[nIns];
    component inLeaf[nIns];
    component inSig[nIns];
    component inNullifier[nIns];
    component inIndexBits[nIns];
    component inAmountBits[nIns];
    component inTree[nIns];
    component inRootCheck[nIns];

    var sumIns = 0;
    for (var i = 0; i < nIns; i++) {
        inAmountBits[i] = Num2Bits(64);
        inAmountBits[i].in <== inAmount[i];

        inKey[i] = Poseidon(1);
        inKey[i].inputs[0] <== inPrivateKey[i];

        inInner[i] = Poseidon(2);
        inInner[i].inputs[0] <== inKey[i].out;
        inInner[i].inputs[1] <== inBlinding[i];

        inLeaf[i] = Poseidon(2);
        inLeaf[i].inputs[0] <== inAmount[i];
        inLeaf[i].inputs[1] <== inInner[i].out;

        inSig[i] = Poseidon(3);
        inSig[i].inputs[0] <== inPrivateKey[i];
        inSig[i].inputs[1] <== inLeaf[i].out;
        inSig[i].inputs[2] <== inPathIndex[i];

        inNullifier[i] = Poseidon(3);
        inNullifier[i].inputs[0] <== inLeaf[i].out;
        inNullifier[i].inputs[1] <== inPathIndex[i];
        inNullifier[i].inputs[2] <== inSig[i].out;
        inNullifier[i].out === inputNullifier[i];

        // also pins inPathIndex to a canonical value below 2^levels
        inIndexBits[i] = Num2Bits(levels);
        inIndexBits[i].in <== inPathIndex[i];

        inTree[i] = MerkleRoot(levels);
        inTree[i].leaf <== inLeaf[i].out;
        for (var j = 0; j < levels; j++) {
            inTree[i].pathIndexBits[j] <== inIndexBits[i].out[j];
            inTree[i].pathElements[j] <== inPathElements[i][j];
        }

        // a zero-value input is padding and needs no membership proof
        inRootCheck[i] = ForceEqualIfEnabled();
        inRootCheck[i].enabled <== inAmount[i];
        inRootCheck[i].in[0] <== root;
        inRootCheck[i].in[1] <== inTree[i].root;

        sumIns += inAmount[i];
    }

    component outInner[nOuts];
    component outLeaf[nOuts];
    component outAmountBits[nOuts];
    var sumOuts = 0;
    for (var i = 0; i < nOuts; i++) {
        outInner[i] = Poseidon(2);
        outInner[i].inputs[0] <== outPubkey[i];
        outInner[i].inputs[1] <== outBlinding[i];

        outLeaf[i] = Poseidon(2);
        outLeaf[i].inputs[0] <== outAmount[i];
        outLeaf[i].inputs[1] <== outInner[i].out;
        outLeaf[i].out === outputCommitment[i];

        outAmountBits[i] = Num2Bits(64);
        outAmountBits[i].in <== outAmount[i];

        sumOuts += outAmount[i];
    }

    // no note may be spent twice inside one transaction
    component sameNullifier[nIns * (nIns - 1) / 2];
    var k = 0;
    for (var i = 0; i < nIns - 1; i++) {
        for (var j = i + 1; j < nIns; j++) {
            sameNullifier[k] = IsEqual();
            sameNullifier[k].in[0] <== inputNullifier[i];
            sameNullifier[k].in[1] <== inputNullifier[j];
            sameNullifier[k].out === 0;
            k++;
        }
    }

    // value is conserved: what comes in plus what enters publicly equals what goes out
    sumIns + publicAmount === sumOuts;

    // make extDataHash part of a constraint so it cannot be swapped after proving
    signal extDataSquare;
    extDataSquare <== extDataHash * extDataHash;
}

component main {public [root, publicAmount, extDataHash, inputNullifier, outputCommitment]} = Transaction(26, 2, 2);
