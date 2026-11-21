# desk-signer: the laptop as an approver device

The phone answers approvals behind its fingerprint prompt; on a laptop, browsers on Linux have no platform
authenticator, and a key the browser holds is a key every process running as you can use. So the laptop's answers come
from a second paired device: this daemon, of kind `desk`. It runs as **its own system user**, keeps its keys where only
that user can read them, and signs only when the page asks it to (an `intent`) **and** the fingerprint reader reports
your finger through fprintd. The protocol is the phone's (docs/approver.md "Approvals"), so the statement, the keys
file and the verifier treat it like any device.

What it doesn't protect: the laptop's screen. Something running as you can make the page show one thing and ask the
signer to sign another; the signer logs the title and action it is about to sign, but that is on your screen too.
Hosts can trust only phone keys for some kinds by listing only those in the keys file they use for them.

## Commands

```
desk-signer pair <dither-approver://pair?url=…&code=…> [--name NAME] [--url URL] [--force]
desk-signer run
desk-signer status
```

- `pair`: makes an identity key and an approval key (WebCrypto P-256), pairs with the manager the link names (the
  page's Approvers → Pair a phone; `--url` reaches it at another address), and keeps `device.json`, `identity.pk8` and
  `approval.pk8` (PKCS8) in the state directory: 0700, each file 0600. It prints both fingerprints: compare the
  identity key's with the one the manager's page shows. Already paired: refused without `--force`.
- `run`: keeps the link to the manager (backoff 1 s to 60 s), proves itself with the identity key, sends its keys frame
  (`kind desk`, the approval key) on every link, and keeps each approve request it is sent after checking it as the
  phone does. On an intent for an action that needs a signature it runs the presence check, then signs and answers;
  an action that needs none is answered without it. A finger that doesn't match answers an error and keeps the request
  (the page can ask again). It never answers on its own. It refuses to start when its files can be read by others, and
  exits 2 when the manager says it is not paired (4401).
- `status`: the device, the manager, both fingerprints, and whether the state directory is private.

Environment:

| | |
|---|---|
| `DESK_SIGNER_STATE` | the state directory (default `$STATE_DIRECTORY`, as systemd sets it, else `~/.local/state/desk-signer`) |
| `DESK_SIGNER_USER` | whose finger counts (`run` needs it) |
| `DESK_SIGNER_VERIFY` | the presence check as a JSON array, `{user}` replaced (default `["fprintd-verify","{user}"]`); success is exit 0 with `verify-match` in its output, within 30 s |

## How it is meant to run

A system service, not a user one, so nothing running as you can read its key:

- **Its own system user** (say `desk-signer`), with a state directory only it can read (`StateDirectory=desk-signer`,
  `StateDirectoryMode=0700`). Pair once as that user: `sudo -u desk-signer env DESK_SIGNER_STATE=/var/lib/desk-signer
  desk-signer pair '<link>'`.
- **The unit**: `ExecStart=bun /path/to/apps/desk-signer/src/main.ts run`, `Environment=DESK_SIGNER_USER=<you>`,
  `Restart=on-failure`, `RestartSec=5`, `RestartPreventExitStatus=2` (not paired: don't loop), and the usual hardening
  (`ProtectHome=yes`, `PrivateTmp=yes`, `NoNewPrivileges=yes`, `ProtectSystem=strict`). It needs the network to reach
  the manager's page and the system bus to reach fprintd.
- **A polkit rule** letting that user verify *your* finger: fprintd asks polkit for `net.reactivated.fprint.device.verify`,
  and for verifying another user's finger also `net.reactivated.fprint.device.setusername`. Allow both for the
  signer's user only, and only for your user name where polkit can tell (fprintd passes no user detail today, so the
  rule is per action):

  ```js
  polkit.addRule(function (action, subject) {
    if (subject.user == "desk-signer" &&
        (action.id == "net.reactivated.fprint.device.verify" || action.id == "net.reactivated.fprint.device.setusername"))
      return polkit.Result.YES;
  });
  ```

- On NixOS this is a module in the system's own configuration (the user, the unit, `security.polkit.extraConfig` with
  the rule above, `services.fprintd.enable`); it is not in this repository.
