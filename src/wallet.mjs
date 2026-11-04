// Apps keep no key: every write goes to the person's wallet, which shows it,
// sets the fee (paid in this device's work through a fee sponsor, or in
// coins), picks the nonce, signs with the connected account and sends it.

/**
 * The wallet request for `actions` on `chainPath`, with `payments`
 * (`[{ to, amount }]`, amounts decimal strings) made in the same
 * transaction. No fee: the wallet's to set. `fund` names the key prefixes of
 * a fee sponsor's fund that may pay the fee, for the wallet to pass on.
 */
export function writeRequest(chainPath, { actions, payments }, fund) {
  if (actions.length === 0) throw new Error("Nothing to write");
  return { chainPath: [...chainPath], actions, ...(payments?.length && { payments }), ...(fund?.length && { fund: [...fund] }) };
}

/**
 * The same write as a transaction body signed for by `owner`, who pays
 * `fee` and `payments`: for scripts and tests that hold a key themselves.
 * The owner's one debit comes first, then each payee's credit.
 */
export function transaction({ owner, actions, payments = [], fee = 0n, nonce, chainPath }) {
  const paying = payments.reduce((sum, p) => sum + BigInt(p.amount), 0n);
  return {
    accountActions: [...(fee + paying > 0n ? [{ owner, delta: -(fee + paying) }] : []), ...payments.map((p) => ({ owner: p.to, delta: BigInt(p.amount) }))],
    actions,
    depositActions: [],
    receiptActions: [],
    withdrawalActions: [],
    signers: [owner],
    nonce,
    chainPath: [...chainPath],
  };
}
