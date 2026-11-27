# A bug bugwatch found: {{title}}

bugwatch (dither-accounts' `bugwatch` extractor) saw a new error in `{{source}}` ({{reason}}) and started this thread
to find out what fails, why the design let it, and fix it.

## What was seen

- Fingerprint `{{id}}`: `{{fingerprint}}`
- Where: `{{where}}`; source `{{sourceKind}}` read from `{{file}}`
- {{count}} times, first seen {{first}}, last seen {{last}}; {{lastHour}} in the last hour, about {{hourly}} an hour
  over the 7 days before it
- The project: `{{project}}`, this worktree starts from `{{base}}`
{{recur}}
{{kind}}

Sample records (the error line and its frames, nothing else of the log):

{{samples}}

{{trace}}

How far back each source goes now (older records are gone; say so rather than guess about before then):

{{reach}}

## Related bugs bugwatch saw

Read these first. If this bug is one of them (the same failure seen from another place, or one a thread already
settled), say which, and stop: change nothing unless what was concluded there is wrong, and then say why.

{{related}}

## Look past the symptom

- **Name the mechanism, not the path.** Say in a sentence or two what general thing went wrong, as a reader who does
  not know this code would need it: work lost while something was being replaced, an expected refusal reported as a
  bug, one bad record failing a whole answer, a wait nobody will answer, a retry loop with no memory, or whatever it
  is. Explain how the parts involved work, not only which function called which.
- **Ask why the design let it happen.** Where else does the same shape occur? Search for the sibling cases and list
  them, even if you fix only this one.
- **Choose the fix's level on purpose:** a local patch, a shared building block, or a change to a contract between
  parts. If a local patch is right for now, say what the general fix would be, and open it as an issue rather than
  leaving it inside the pull request.
- A fix that adds a timing constant (wait N seconds) says why that number, and what happens when it is exceeded.
- "Not a bug" needs numbers: how often it happens, how often it did before, and what would make it a bug. bugwatch
  keeps your verdict and shows it to the next thread on a related bug.

## Rules

- **Read only on live systems.** Read the live logs, trace files and databases, but never re-send a command, never act
  on a real account (no sign-in, no message, no change), never restart or stop a live service, never call a running
  service's API in a way that changes something.
- **Never read or print private content** (messages, mail, people's names) from live data: in logs and databases,
  look only at what is about this error, and keep it out of anything you write to a public place.
- **Reproduce it away from them:** in a test, or in a demo or test instance with its own temporary data directory.
- **Fix it in a pull request and leave it for the owner's review:** do not merge it, do not enable auto-merge, do not
  deploy it.
- If it is not a bug in this code (an outside service's outage, a refusal that is expected), say so and change nothing.
- **Budget: about {{budget}} minutes.** If the cause is not found by then, stop and report what you know, what you
  ruled out, and which log line or measurement would settle it next time. Adding that line, at the point of failure, is
  a fine pull request on its own: bugwatch points the next thread at the logs around each later occurrence.
- **Finish with:** what failed, the mechanism, why, the pull request's link, and what is still unproven. End your last
  reply with these three lines, each on its own line, for bugwatch to keep (no private content in them):

  ```
  Verdict: fixed | not a bug (with its rate) | already fixed | same as <bug id> | cause unknown
  Class: <the general mechanism, in a few words>
  Design cause: <the design choice that let it happen, or "none: a one-off slip">
  ```
