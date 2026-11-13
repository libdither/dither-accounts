# A bug bugwatch found: {{title}}

bugwatch (dither-accounts' `bugwatch` extractor) saw a new error in `{{source}}` ({{reason}}) and started this thread
to find out what fails and fix it.

## What was seen

- Fingerprint `{{id}}`: `{{fingerprint}}`
- Where: `{{where}}`; source `{{sourceKind}}` read from `{{file}}`
- {{count}} times, first seen {{first}}, last seen {{last}}; {{lastHour}} in the last hour, about {{hourly}} an hour
  over the 7 days before it
- The project: `{{project}}`, this worktree starts from `{{base}}`

Sample records (the error line and its frames, nothing else of the log):

{{samples}}

{{trace}}

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
- **Finish with:** what failed, why, the pull request's link, and what is still unproven.
