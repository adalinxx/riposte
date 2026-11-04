//! Transaction-scope validity policy for Riposte, comments under web pages.
//!
//! Every key belongs to one account, which must sign to write or delete it:
//!
//! - `comment/<page>/<a>/<id>`: a comment by `<a>` under page `<page>`.
//!   Created once, deleted, never edited, so a reply always answers what its
//!   author saw. At most `MAX_VALUE` bytes.
//! - `like/<page>/<author>/<id>/<a>`: `<a>` likes that comment. Value `1`.
//! - `hide/<m>/<page>/<author>/<id>`: moderator `<m>` hides that comment.
//!   Value `1`. It hides it only on pages that name `<m>` as a moderator.
//! - `block/<m>/<a>`: moderator `<m>` hides everything `<a>` writes. Value `1`.
//! - `tip/<page>/<author>/<id>/<a>/<tid>`: `<a>` tips that comment. The value
//!   is the amount, a canonical decimal of at least 1, and the same
//!   transaction credits `<author>` at least that much. Created once, never
//!   edited or deleted: it records a payment. `<a>` is not `<author>`, and
//!   `<author>` does not sign, so a tip can't net to nothing within its own
//!   transaction and still look paid.
//!
//! Nothing is deleted by anyone but its writer: a moderator only marks, and
//! each page chooses whose marks it follows. What a comment says, and whether
//! a reply's parent exists, is for readers: the policy never reads JSON.
//!
//! `<a>`, `<m>` and `<author>` are account addresses; `<page>` is 1 to
//! `MAX_PAGE` and `<id>` and `<tid>` 1 to `MAX_ID` lowercase letters and
//! digits. Coin actions pass untouched, beyond paying for tips.
//!
//! Tips are checked against the account actions in one pass (Moniker's
//! `Payments`): consecutive tips to one author are paid by one credit to
//! them, and each run of tips by its own credit, in the order the runs come.
#![cfg_attr(not(test), no_std)]

use lattice_policy_rules::{decimal, is_address, transaction_body, Action, Body, Signers};

lattice_policy_rules::lattice_policy_abi!(crate::validate);

/// The most bytes a comment holds: room for 2,000 characters of any script,
/// a name and the comment it answers, and no more, since every host keeps
/// every byte for good.
pub const MAX_VALUE: usize = 10240;
/// The longest comment id: a time in base 36 and a few random characters.
pub const MAX_ID: usize = 16;
/// The longest page key: a hash of the page's address, in base 32.
pub const MAX_PAGE: usize = 64;

/// The verdict for one policy context, with `scratch` for the signer tree.
/// Anything malformed is a rejection.
pub fn validate(context: &[u8], scratch: &mut [u32]) -> bool {
    transaction_body(context).and_then(|body| check_body(body, scratch)).is_some()
}

/// What a key is, read from its segments: the account that owns it, and
/// whether it is a comment (anything else is a marker).
enum Record<'a> {
    Comment { account: &'a [u8] },
    Marker { account: &'a [u8] },
    Tip { account: &'a [u8], author: &'a [u8] },
}

fn check_body(bytes: &[u8], scratch: &mut [u32]) -> Option<()> {
    let body = Body::parse(bytes)?;
    let signers = body.signers(scratch)?;
    let mut payments = body.payments()?;
    let mut actions = body.actions()?;
    while let Some(action) = actions.next() {
        let action = action?;
        match parse(action.key)? {
            Record::Comment { account } => {
                signs(&signers, account)?;
                // Created, or deleted; never edited.
                match (action.old_value, action.new_value) {
                    (None, Some(value)) => sized(value)?,
                    (Some(_), None) => {}
                    _ => return None,
                }
            }
            Record::Marker { account } => {
                signs(&signers, account)?;
                marker(&action)?;
            }
            Record::Tip { account, author } => {
                signs(&signers, account)?;
                if signers.is_signer(author).is_some() {
                    return None;
                }
                // Created only, with an amount the author is credited.
                let (None, Some(value)) = (action.old_value, action.new_value) else {
                    return None;
                };
                let amount = decimal(value).filter(|&amount| amount >= 1)?;
                payments.owe(author, amount)?;
            }
        }
    }
    payments.finish()
}

fn signs(signers: &Signers, account: &[u8]) -> Option<()> {
    signers.is_signer(account)
}

/// A comment: something, and not too much.
fn sized(value: &[u8]) -> Option<()> {
    (!value.is_empty() && value.len() <= MAX_VALUE).then_some(())
}

/// A marker's value: `1`, or deleted.
fn marker(action: &Action) -> Option<()> {
    matches!(action.new_value, None | Some(b"1")).then_some(())
}

fn parse(key: &[u8]) -> Option<Record<'_>> {
    let mut segments = key.split(|&byte| byte == b'/');
    let kind = segments.next()?;
    let mut next = || segments.next();
    let record = match kind {
        b"comment" => {
            let (page, account, id) = (next()?, next()?, next()?);
            (is_page(page) && is_address(account) && is_id(id)).then_some(Record::Comment { account })?
        }
        b"like" => {
            let (page, author, id, account) = (next()?, next()?, next()?, next()?);
            (is_page(page) && is_address(author) && is_id(id) && is_address(account)).then_some(Record::Marker { account })?
        }
        b"hide" => {
            let (account, page, author, id) = (next()?, next()?, next()?, next()?);
            (is_address(account) && is_page(page) && is_address(author) && is_id(id)).then_some(Record::Marker { account })?
        }
        b"tip" => {
            let (page, author, id, account, tid) = (next()?, next()?, next()?, next()?, next()?);
            (is_page(page) && is_address(author) && is_id(id) && is_address(account) && is_id(tid) && account != author)
                .then_some(Record::Tip { account, author })?
        }
        b"block" => {
            let (account, blocked) = (next()?, next()?);
            (is_address(account) && is_address(blocked)).then_some(Record::Marker { account })?
        }
        _ => return None,
    };
    next().is_none().then_some(record)
}

fn is_word(text: &[u8], max: usize) -> bool {
    (1..=max).contains(&text.len()) && text.iter().all(|&byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9'))
}

/// A comment id: 1 to `MAX_ID` lowercase letters and digits.
fn is_id(text: &[u8]) -> bool {
    is_word(text, MAX_ID)
}

/// A page key: 1 to `MAX_PAGE` lowercase letters and digits.
fn is_page(text: &[u8]) -> bool {
    is_word(text, MAX_PAGE)
}
