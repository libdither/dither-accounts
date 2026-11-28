# Composition parity tests (chat extractors)

`test/chat-parity/` checks that a chat extractor tells the hub the same conversation the network itself holds, after
operations that interact: an edit of an edit, a reaction after an edit, a reply to an edited message, a delete of a
message edited twice, a pin across an edit. Single-feature unit tests pass while these break, because each operation
changes what the next one has to find (a message's id, its latest edit, its reactions).

Each scenario runs in both directions: once with the extractor's own account as the author (its commands: send,
edit, react, redact, configure), once with the other person as the author (their own client, reaching the network
directly). After every step the harness waits until the two states agree, then goes on; after the last step the other
person writes once more (a barrier), so anything the extractor would still send about the steps has come in before
the final comparison.

## The two sides

- **The extractor's state:** its AdapterEvents folded by `EventFolder` (`harness.ts`) the way dither-chat's hub folds
  them (its `packages/hub/src/store.ts`): a message fact replaces the message whole, the edited flag and a reply's
  parent stay once set, a deleted message stays deleted, exclusive networks keep one reaction per person
  (`REACTION_RULES`). A reaction, pin or delete aimed at a message the hub never heard of is dropped, as the hub
  drops it, and is reported: that is how an id that drifted (a reaction sent to an edit's event id instead of the
  message's) shows up.
- **The oracle:** the same conversation read from the network, never through the extractor.

Both come out as a `NormalizedConversationState`: each message's author (A, B), body, edited flag, `replyTo`,
reactions by author, pinned flag and attachment kinds, and the messages deleted. `diffConversationStates` names each
difference: a missing or extra message (with "a duplicate of …?" when its body matches another), a body, an edited
flag, a `replyTo`, a dangling `replyTo` (a parent the extractor never sent), a missing or extra reaction, a pin, a
missed or wrong delete, attachments, and any event the hub would have dropped.

## The scenarios

`scenarios.ts`, each by the account itself (self) and by the other person (peer); the other side reacts, replies and
pins:

| scenario | catches |
|---|---|
| send → edit → edit | a chained edit arriving as a new message, or the second edit lost |
| send → edit → react (peer + self) → unreact | reactions dropped or misplaced once the message was edited |
| send → edit → edit → react | a reaction aimed at an edit event after several edits |
| send → edit → reply | a reply pointing at an edit, or at nothing |
| send → edit → delete, send → edit → edit → delete | a delete that misses an edited message |
| reply → edit parent → delete parent | a reply losing its parent as the parent is edited and deleted |
| reply → edit the reply → react to it | a reply losing its parent, or its quote coming back, when the reply is edited |
| send → reply to it yourself → edit the reply | the reply's edit landing on its parent (same person) |
| send → react → edit → unreact | a reaction lost, or impossible to take back, after an edit |
| send → pin → edit → unpin | a pin lost or stuck across an edit (`pin`) |
| send a file → react → delete | a file lost, or a reaction or delete missing it (`media`) |

A step needs a capability (`send`, `edit`, `react`, `reply`, `delete`, `pin`, `media`) of whoever takes it; a driver
declares them, and narrows one side with `only` (WhatsApp: the extractor pins nothing, the other person can). A
scenario whose capability no one has is a skipped test that says so.

## The drivers, all run by `bun run test`

| file | extractor | the other person and the oracle |
|---|---|---|
| `matrix-oracle.test.ts` | `extractors/matrix` as quinn, a fresh device signed in by password | continuwuity started for the file (`extractors/matrix/testbed/homeserver.ts`, the testbed's config, port from the kernel), a room per scenario; alice is a plain Client-Server API client, and the oracle reads the room back from `/messages`, each message's `/relations` and the pinned-events state |
| `telegram-parity.test.ts` | `extractors/telegram` on the fake Telegram | the fake's control ops (Alice's client); the oracle is the fake's world |
| `whatsapp-parity.test.ts` | `extractors/whatsapp` on the fake bridge process | bridge events shaped after `test/fixtures/events.jsonl` for Alice; the oracle is a model of WhatsApp kept by the test, fed by Alice's actions and by decoding each `send` the extractor gave the bridge (with the id it answered) |
| `zulip-parity.test.ts` | `extractors/zulip` on the fake Zulip server in its `live` mode | the server's own writes for Ann (`act`), the same paths the extractor's requests take; the oracle is the server's message list; a topic per scenario |

The Matrix file needs continuwuity: `CONTINUWUITY_BIN`, the prepared test programs (`nix/bins.json` "test",
`DITHER_BINS`: CI's `nix` job has them and must run it), or `conduwuit` on PATH. Elsewhere it skips, saying so.
`harness.test.ts` checks the harness itself against a toy network whose extractor is given each bug in turn.
`PARITY_LOG=1` prints each step and the state both sides agreed on.

## Found by it

- **Matrix, taking back a reaction:** a reaction the extractor had not seen (made before its window) is looked up
  through `/relations`, and continuwuity 26.9 lists a reply's relations under its parent too, as if a reply were one.
  Taking back 👍 on a message also redacted your 👍 on a reply to it. The extractor now keeps only reactions to that
  message (`extractors/matrix/test/relations.test.ts`); the oracle filters the same way.

## Adding a network

1. Write a `ParityDriver` (`harness.ts`): the two people's native ids as the extractor names them (`actorA`,
   `actorB`); each action for both sides, resolving once the network has taken it (`send` and `reply` return the
   message's id as the extractor names it); `extractorState()`, usually `folder.state(driver, conversation)` over
   an `EventFolder` fed every event the extractor emits; `oracleState()`, read from the network, mapping its ids to
   the extractor's and adding as deleted the messages the run made that are gone; `changed()`, resolving at the next
   event (or change in a fake); and `mark()` / `dropped()` from the folder. `beginScenario()` gives each scenario a
   fresh conversation where that is cheap; otherwise messages from before a scenario are left out of its comparison.
2. Call `runCompositionSuite(name, start, { capabilities, only })` from a `*.test.ts` file.
3. Everything waits on events: no sleeps. `convergeMs` (20 s) only ends a failing step, with its diff.

**A live throwaway oracle** (a test account on a real network) is the same driver with the other person's side
driven by that account's own client and `oracleState()` read through its API. Never run one against a real account,
and never from `bun run test`: a separate script, run by hand, as `extractors/zulip/testbed/drive.ts` is for the Zulip
testbed. The Zulip driver's oracle reads only what `GET /messages` gives (content, `last_edit_timestamp`, reactions),
so against `testbed/sandbox.ts` it would read the server's answers instead of `fake.messages`.
