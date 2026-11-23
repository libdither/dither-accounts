# Reading records: one bad record costs that record

An extractor reads lists out of outside services' answers: Gmail's thread rows and messages, people suggestions,
contact lists, feeds, statements. When one record in such a list is not laid out as the extractor knows it, that
record is left out, named and counted, and the rest of the answer is answered. The whole answer is refused only when
its own envelope is off or when most of its records fail. Code: `packages/link/src/records.ts`
(`@dither-accounts/link/records`).

Why: a parser that throws for the whole answer when one record is off refuses every record for as long as that one
stays in the answer. Gmail's sync did so for days for one message whose labels were `null` (#53): every sync call on
the account answered 502, for all of its mail, and the same error was counted thousands of times.

## The rule

- **The envelope** (the list is a list, the cursor or sync point is where it belongs): checked as before. When it is
  off the answer is refused.
- **One record**: the reader throws a `RecordError(where, expected, got)` for it: where is a path (`json[0][3][1][0]`),
  expected and got say what kind of thing, never a value. `readEach` leaves the record out and puts it in `skipped`
  (with its id when `idOf` can read one).
- **Most records** (`looksChanged`): at least 3 left out (`SYSTEMIC`), and more than were read. Then the layout
  changed, and records that passed may have passed by accident: the answer is refused with a `LayoutChanged`, a 502 of
  kind `bug` ([manager.md](manager.md), FailureKind). One or two odd records can't tell a drift from a bad record, so
  they are counted and logged; a drift that hits every record shows as a refusal on the next answer of three or more.
- **Not ours to catch**: any other error a reader throws (a TypeError from our own code) is a bug and goes up.

## A skipped record is not an absent one

What an answer leaves out was not read, so nothing may be concluded from its absence:

- an id in `skipped` is never reported removed and never dropped from a cache in a way that deletes the user's data;
  it may be forgotten so that the next read asks the service again;
- when a skip has no id (`anonymous`), nothing at all is worked out from what the answer lacks (no removals, no "this
  list is complete");
- an answer that moves a sync point past its records (Gmail's `s`) refuses a record it cannot name, since it could
  never be asked for again.

## Seen, not one line per record

- `Skips` counts skips per extractor by what and what was expected (`gmail.contacts: an address 3`). Its `summary()`
  goes in the account's status details, where the page shows it.
- It logs a kind once when first seen, then at most once an hour while it keeps coming, with its count. bugwatch reads
  those lines from the adapter log as it reads any other ([bugwatch.md](bugwatch.md)), one per kind, so a drift raises
  one bug and a count, not a line per record.

## Where it is used

- Gmail's people suggestions (`extractors/google/src/gmail/contacts.ts`): `details.contactsSkipped`.
- Proton's contact list (`extractors/proton/src/contacts.ts`): `details.contactsSkipped`.
- Gmail's sync, list and fetch answers (`extractors/google/src/gmail/protocol.ts`) keep their own `Tally`, with the
  same rule (`looksChanged`), named skips and the self-check's counts.
- X, Reddit, Substack and Meta already drop and count records their own way (a `Drops` per extractor); moving them
  onto `Skips` is listed in [#115](https://github.com/libdither/dither-accounts/issues/115), with the parsers that still
  refuse a whole answer.
