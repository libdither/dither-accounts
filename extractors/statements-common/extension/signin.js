
/*
 * Signing in with another account here (the repo's docs/signin-relay.md), appended to driver.js for a kind that asks
 * (statements-common/src/tabs.ts, HostOpts.signIn): the relay's worker in place of the marker below, started at the
 * top level with config.json's `signIn`. driver.js hands it its `signin.*` commands and leaves its tabs out of reports.
 */
/*@include signin-worker@*/
signinRelay.start(sendUp, loadConfig().then((c) => c && c.signIn));
