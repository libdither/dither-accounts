# Discord composition parity

The composition parity suite ([parity-testing.md](parity-testing.md)) for `extractors/discord`, in two places: in CI
against a fake Discord, and by hand against real Discord with a throwaway account and a test bot. Both run the same
driver (`test/chat-parity/discord-driver.ts`) over the same scenario matrix (`scenarios.ts`).

- **A**, the extractor's account, acts through the chat interface's commands: `send`, `edit`, `react`, `redact`,
  and `configure` with a `pin` change.
- **B** is a bot on the REST API, `DiscordBotOracle` (`test/chat-parity/discord-bot-oracle.ts`). It sends, edits its
  own messages, reacts and takes reactions back, replies (`message_reference`), deletes and pins.
- **The oracle** is the same bot reading the channel back: `GET /channels/{id}/messages?after=…`, the people behind
  each reaction from `GET …/reactions/{emoji}`, and the pinned list from `GET …/messages/pins`, folded into a
  `NormalizedConversationState`. Discord's own notices ("pinned a message", type 6) are left out of both sides.
- A 429 waits its `Retry-After` and goes again. The fake answers `Retry-After: 0`, so CI never sleeps.
- The hook starts the client's own edit and delete and answers before Discord has them, as the client does. So the
  driver waits for A's edit or delete until the bot reads it on Discord's side, never on the extractor's.

## In CI: `test/chat-parity/discord-parity.test.ts`

- `fake-discord.ts` is Discord's REST API: v9 as the web client calls it, v10 as a bot does. It runs on port 0 and
  stores messages, edits, reactions, replies, pins, deletes and uploaded files, and it can answer 429. Each change
  goes out as the gateway's dispatches to every user, each user with their own `me` on reactions. A pin goes out as
  MESSAGE_UPDATE, then the type 6 notice, then CHANNEL_PINS_UPDATE.
- `discord-extractor.ts` runs the extractor without its sandbox. The real `hook.js` runs in a copy of the web
  client: a Flux dispatcher with interceptors, the stores the hook needs at its core, the REST helper and message
  actions pointed at the fake, and the gateway's dispatches turned into the client's Flux actions. On the other side
  of the bridge is the extractor's own code: the hook commands main.ts makes, pins through `PollOps`,
  `translateDispatch`, and `duePins` for held pins. It mirrors main.ts's `onCommand` and `handleBridge` for those
  commands, because main.ts starts a sandbox as soon as it is imported. When those parts of main.ts change, change it
  too.
- The file also checks the oracle against the fake's world, a 429 retried at once, and an error that names Discord's
  code and never the token. And it checks that the oracle catches a missed edit, a dropped reaction and a missed
  delete: the extractor is made to drop the dispatch, and the diff must name the change it missed.

## Live: `scripts/parity-discord.ts`

Run it only with a throwaway Discord account, in a test server and channel made for it. Never use it with a real
account, and never from `bun run test`.

1. **Make the bot.** On the [Discord Developer Portal](https://discord.com/developers/applications), choose
   **New Application**. On its **Bot** page, choose **Reset Token** and keep the token in a file (mode 0600)
   outside the repo. On the same page, turn on **Message Content Intent**: without it the bot reads other people's
   messages with no text.
2. **Invite it to the test server.** Under **OAuth2 → URL Generator**, pick the `bot` scope and these permissions:
   View Channel, Send Messages, Read Message History, Add Reactions, Attach Files, Manage Messages (to delete
   messages at cleanup), and Pin Messages (for pins; where the permission list has no Pin Messages, Manage Messages
   covers it). Open the URL and pick the test server, the one the throwaway account is in.
3. **Make the channel.** Use a text channel whose name has `parity` or `test` in it (the script refuses any other),
   where both the throwaway account and the bot can talk. Copy its id: in Discord's settings, under Advanced,
   turn on Developer Mode, then right-click the channel and choose Copy Channel ID.
4. **Let the script in.** The first run registers an app named `parity-discord` with the manager, asking for `chat`
   at manage (pins go through `configure`). It keeps the app's token in
   `~/.config/dither-accounts/parity-discord.json`. Approve that request on the manager's page, for the throwaway
   account only.
5. **Run it.**

   ```sh
   DISCORD_BOT_TOKEN="$(cat <token file>)" bun scripts/parity-discord.ts \
     --manager http://127.0.0.1:8486 --account <throwaway account id> --channel <channel id>
   # or: --token-file <token file>
   ```

   It prints a line for each scenario. A failure names each difference between the extractor and Discord.
   `PARITY_LOG=1` prints each step. `--only <text>` runs only the scenarios whose names contain it. At the end it
   deletes every message the run left in the channel, by either person, unless you pass `--keep`. It exits 0 when
   everything agreed, 1 when something didn't, and 2 when it couldn't start.
6. **Capture traces (optional).** `--capture <dir>` writes, for each scenario, the bot's requests and the extractor's
   events. Each file goes through `scrubTrace` (`packages/manager/src/wire-capture.ts`: `anonymizeTrace`, then
   `assertNoConcreteLeaks`) before it is written. A trace that fails the leak check is not written. A trace from a
   real network stays on this machine, even scrubbed. The repo never holds one ([golden-traces.md](golden-traces.md)).

The token is read from `DISCORD_BOT_TOKEN` or `--token-file`. It goes only into the Authorization header: never into
output, an error or a capture. Neither the script nor this doc holds any account, server, channel or token: each run
passes them in.

On A's side, the live run sends no files: the manager would read the file from a path on its own machine. The bot
still sends files.
