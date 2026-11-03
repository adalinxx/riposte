// Apps keep no key: every write goes to the person's wallet, which shows it,
// sets the fee (paid in this device's work through a fee sponsor, or in
// coins), picks the nonce, signs with the connected account and sends it.

/** The wallet request for `actions` on `chainPath`. No fee: the wallet's to set. */
export function writeRequest(chainPath, { actions }) {
  if (actions.length === 0) throw new Error("Nothing to write");
  return { chainPath: [...chainPath], actions };
}

/**
 * The same write as a transaction body signed for by `owner`, who pays
 * `fee`: for scripts and tests that hold a key themselves.
 */
export function transaction({ owner, actions, fee = 0n, nonce, chainPath }) {
  return {
    accountActions: fee > 0n ? [{ owner, delta: -fee }] : [],
    actions,
    depositActions: [],
    receiptActions: [],
    withdrawalActions: [],
    signers: [owner],
    nonce,
    chainPath: [...chainPath],
  };
}
