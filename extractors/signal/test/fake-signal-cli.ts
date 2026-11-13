/**
 * A stand-in for signal-cli that never touches the network, for driving the
 * adapter in tests. Implements just enough of the real CLI:
 *
 *   --config DIR [--trust-new-identities X] link -n NAME
 *       prints a sgnl://linkdevice URI; "scans" when DIR/fake-scan appears
 *       (logs "linking in progress", writes data/accounts.json, prints
 *       "Associated with: <number>", exits 0); otherwise times out like the
 *       real one ("Link request timed out, please try again.", exit 1). If
 *       fake-scan contains "fail", registration fails after the scan (exit 3).
 *
 *   --config DIR -a ACI daemon --socket PATH --receive-mode on-connection ...
 *       JSON-RPC over the UNIX socket. Every request is appended to
 *       DIR/fake-rpc.jsonl. Files dropped into DIR/fake-push/ are sent to
 *       connected clients as `receive` notifications. DIR/fake-exit makes it
 *       exit with the code inside; DIR/fake-hang holding this daemon's pid makes it
 *       stop answering (socket stays open). If data/accounts.json marks the account
 *       unregistered it fails like the real one ("User X is not registered.").
 *       listContacts without allRecipients lists only contacts, also when asked for some.
 *       updateGroup and updateContact change the groups and contacts it lists
 *       (kept in DIR/fake-groups.json and DIR/fake-contacts.json); updateGroup
 *       without a groupId makes a new group (its `member`s in it, or pending, as
 *       below; nobody left out; see updateGroup for its knobs), as the real one does, and with only
 *       a groupId accepts an invitation. Fields starting with `_` stay out of what
 *       it lists. updateGroup's `member` adds someone with a profile and invites
 *       (pending) someone without one, or unknown to it, as the real one does when
 *       it lacks their profile key; DIR/fake-add.json ({ [aci]: 'drop' | { error,
 *       code? } }) leaves someone out, or fails the whole call.
 *
 *       Adding: getUserStatus by number or `username` (a name.12, or a link a
 *       contact lists in `_links`; "busy.42" is rate limited); joinGroup by `uri`
 *       from DIR/fake-links.json ({ [uri]: { group, approval? } | { error, code? } }),
 *       which adds the group (you in it, or asking when `approval`); quitGroup
 *       (an invitation: declined); block (recipients or groups);
 *       sendMessageRequestResponse (accept / delete set profileSharing).
 *
 *       Groups admin (admins only, as Signal's servers enforce it): updateGroup's removeMember, admin, removeAdmin, ban
 *       (removes them too), unban, avatar (a path that must exist), link enabled-with-approval (kept as _approval);
 *       memberLabel and memberLabelEmoji (anyone, their own); terminateGroup; sendAdminDelete (admins, groups only);
 *       quitGroup refuses the only admin of a group with others in it unless `admin` names one, and `delete` forgets it.
 *
 *       People and this device: listIdentities from DIR/fake-identities.json (else none);
 *       trust (verifiedSafetyNumber must be the current one; trustAllKnownKeys clears it); unblock; removeContact
 *       (hide); updateContact's nick-names and note; updateProfile's names, About, emoji and picture; updateAccount
 *       (username answers name.NN and a link, deleteUsername, deviceName); listDevices (the phone and this one, #2,
 *       named as last set); submitRateLimitChallenge (a captcha "BAD…" is rejected). A send of the text "CAPTCHA"
 *       fails with a rate-limit challenge, as the real one does when Signal wants one.
 * send: message "FAIL" fails the call; "PARTIAL" answers with one recipient failed (UNREGISTERED_FAILURE).
 *
 * Knobs (env): FAKE_NUMBER, FAKE_ACI, FAKE_LINK_TIMEOUT_MS, FAKE_PROFILE_NAME.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const config = opt('--config') ?? opt('--data-dir');
if (!config) {
  console.error('fake: --config is required');
  process.exit(2);
}
const sub = args.find((a) => a === 'link' || a === 'daemon');
const NUMBER = process.env.FAKE_NUMBER ?? '+15550100';
const ACI = process.env.FAKE_ACI ?? '5f2c7a8e-1111-4aaa-8bbb-000000000001';
const accountsFile = join(config, 'data', 'accounts.json');
mkdirSync(join(config, 'data'), { recursive: true });
const record = (o: unknown) => appendFileSync(join(config, 'fake-rpc.jsonl'), JSON.stringify(o) + '\n');
record({ t: 'argv', argv: args, pid: process.pid });
process.on('SIGTERM', () => process.exit(143));

if (sub === 'link') {
  if (args.includes('-a')) {
    console.error('You cannot specify a account (phone number) when linking');
    process.exit(1);
  }
  const n = Math.floor(Math.random() * 1e9);
  await Bun.sleep(30);
  console.log(`sgnl://linkdevice?uuid=FAKE${n}&pub_key=KEY${n}`);
  const deadline = Date.now() + Number(process.env.FAKE_LINK_TIMEOUT_MS ?? 120_000);
  while (Date.now() < deadline) {
    if (existsSync(join(config, 'fake-scan'))) {
      const how = readFileSync(join(config, 'fake-scan'), 'utf8').trim();
      rmSync(join(config, 'fake-scan'), { force: true });
      console.error(`INFO  ProvisioningManagerImpl - Received link information from ${NUMBER}, linking in progress ...`);
      await Bun.sleep(50);
      if (how === 'fail') {
        console.error('Link request error: Failed to register as secondary device (NonSuccessfulResponseCodeException)');
        process.exit(3);
      }
      writeFileSync(accountsFile, JSON.stringify({ accounts: [{ path: '123456', environment: 'LIVE', number: NUMBER, uuid: ACI }], version: 2 }));
      writeFileSync(join(config, 'data', '123456'), JSON.stringify({ version: 9, deviceId: 2 }));
      console.log(`Associated with: ${NUMBER}`);
      process.exit(0);
    }
    await Bun.sleep(20);
  }
  console.error('Link request timed out, please try again.');
  process.exit(1);
}

if (sub === 'daemon') {
  const account = opt('-a');
  const accounts = existsSync(accountsFile) ? JSON.parse(readFileSync(accountsFile, 'utf8')).accounts : [];
  const acc = accounts.find((a: any) => a.uuid === account || a.number === account);
  if (!acc || acc.registered === false) {
    console.error(`User ${account} is not registered.`);
    process.exit(1);
  }
  const socketPath = opt('--socket');
  if (!socketPath) {
    console.error('At least one channel parameter is required, e.g. --socket or --dbus.');
    process.exit(1);
  }
  await Bun.sleep(100); // account loading
  const conns = new Set<any>();
  const send = (s: any, o: unknown) => s.write(JSON.stringify(o) + '\n');
  const SELF = acc.uuid;
  const contacts = () => {
    const f = join(config, 'fake-contacts.json');
    if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
    return [
      { number: NUMBER, uuid: SELF, username: null, name: '', givenName: null, familyName: null, nickName: null, nickGivenName: null, nickFamilyName: null, note: null, color: null, isArchived: false, isBlocked: false, isHidden: false, messageExpirationTime: 0, profileSharing: true, unregistered: false, profile: { lastUpdateTimestamp: 1, givenName: process.env.FAKE_PROFILE_NAME ?? 'Quinn', familyName: null, about: null, aboutEmoji: null, hasAvatar: false, mobileCoinAddress: null } },
      { number: '+15550137', uuid: 'a11ce000-2222-4ccc-9ddd-000000000002', username: null, name: 'Alice Chen', givenName: 'Alice', familyName: 'Chen', nickName: null, nickGivenName: null, nickFamilyName: null, note: null, color: null, isArchived: false, isBlocked: false, isHidden: false, messageExpirationTime: 0, profileSharing: true, unregistered: false, profile: { lastUpdateTimestamp: 1, givenName: 'Alice', familyName: null, about: 'Belay on', aboutEmoji: '🧗', hasAvatar: true, mobileCoinAddress: null } },
      { number: '+15550161', uuid: '5a3e0000-3333-4eee-afff-000000000003', username: null, name: '', givenName: null, familyName: null, nickName: null, nickGivenName: null, nickFamilyName: null, note: null, color: null, isArchived: false, isBlocked: false, isHidden: false, messageExpirationTime: 3600, profileSharing: true, unregistered: false, profile: { lastUpdateTimestamp: 1, givenName: 'Sam', familyName: 'Rivera', about: null, aboutEmoji: null, hasAvatar: false, mobileCoinAddress: null } },
      // Blocked, still a contact to signal-cli.
      { number: '+15550142', uuid: 'b10c0000-5555-4ddd-9eee-000000000005', username: null, name: 'Blake', givenName: 'Blake', familyName: null, nickName: null, nickGivenName: null, nickFamilyName: null, note: null, color: null, isArchived: false, isBlocked: true, isHidden: false, messageExpirationTime: 0, profileSharing: false, unregistered: false, profile: null },
      // Known from a group long gone, never a contact; number not shared. `_contact: false` keeps it out of the contacts listing.
      { _contact: false, number: null, uuid: '0b5e7ae0-4444-4bbb-8ccc-000000000004', username: null, name: null, givenName: null, familyName: null, nickName: null, nickGivenName: null, nickFamilyName: null, note: null, color: null, isArchived: false, isBlocked: false, isHidden: false, messageExpirationTime: 0, profileSharing: false, unregistered: false, profile: { lastUpdateTimestamp: 1, givenName: 'Robin', familyName: null, about: 'Gone bouldering', aboutEmoji: null, hasAvatar: false, mobileCoinAddress: null } },
    ];
  };
  const groups = () => {
    const f = join(config, 'fake-groups.json');
    if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
    return [
      {
        id: 'Cl1mb1ngCrew+Gr0up0000000000000000000000000=',
        name: 'Climbing crew 🧗',
        description: 'thursday nights',
        isMember: true,
        isBlocked: false,
        messageExpirationTime: 0,
        members: [
          { number: NUMBER, uuid: SELF, isAdmin: true },
          { number: '+15550137', uuid: 'a11ce000-2222-4ccc-9ddd-000000000002', isAdmin: false },
          { number: '+15550161', uuid: '5a3e0000-3333-4eee-afff-000000000003', isAdmin: false },
        ],
        pendingMembers: [],
        requestingMembers: [],
        admins: [{ number: NUMBER, uuid: SELF }],
        banned: [],
        permissionAddMember: 'EVERY_MEMBER',
        permissionEditDetails: 'EVERY_MEMBER',
        permissionSendMessage: 'EVERY_MEMBER',
        groupInviteLink: null,
        isTerminated: false,
      },
      {
        // Locked down by Alice: only admins edit, add or send, and the link is on.
        id: 'L0ckedGr0up+AdminsOnly0000000000000000000000=',
        name: 'Announcements',
        description: 'read only',
        isMember: true,
        isBlocked: false,
        messageExpirationTime: 604800,
        members: [
          { number: NUMBER, uuid: SELF, isAdmin: false },
          { number: '+15550137', uuid: 'a11ce000-2222-4ccc-9ddd-000000000002', isAdmin: true },
          { number: null, uuid: '5a3e0000-3333-4eee-afff-000000000003', isAdmin: false },
        ],
        pendingMembers: [{ number: null, uuid: 'f00d0000-1111-4aaa-8bbb-000000000099' }],
        requestingMembers: [],
        admins: [{ number: '+15550137', uuid: 'a11ce000-2222-4ccc-9ddd-000000000002' }],
        banned: [],
        permissionAddMember: 'ONLY_ADMINS',
        permissionEditDetails: 'ONLY_ADMINS',
        permissionSendMessage: 'ONLY_ADMINS',
        groupInviteLink: 'https://signal.group/#CjQKIFakeLockedGroupLink',
        isTerminated: false,
      },
      {
        // Alice invited us; we have not joined.
        id: 'Inv1tedGr0up+NotJoined000000000000000000000=',
        name: 'Surprise party',
        description: '',
        isMember: false,
        isBlocked: false,
        messageExpirationTime: 0,
        members: [{ number: '+15550137', uuid: 'a11ce000-2222-4ccc-9ddd-000000000002', isAdmin: true }],
        pendingMembers: [{ number: NUMBER, uuid: SELF }],
        requestingMembers: [],
        admins: [{ number: '+15550137', uuid: 'a11ce000-2222-4ccc-9ddd-000000000002' }],
        banned: [],
        permissionAddMember: 'EVERY_MEMBER',
        permissionEditDetails: 'EVERY_MEMBER',
        permissionSendMessage: 'EVERY_MEMBER',
        groupInviteLink: null,
        isTerminated: false,
      },
    ];
  };
  // Changes persist in the fake-*.json files, so a re-read (and a restarted daemon) sees them.
  const save = (name: string, list: unknown) => writeFileSync(join(config, name), JSON.stringify(list));
  const fail = (message: string, code = -1) => Object.assign(new Error(message), { code });
  const updateGroup = (params: any) => {
    const all = groups();
    if (!params?.groupId) {
      // As the real one (0.14.8: UpdateGroupCommand, GroupHelper.createGroup, GroupV2Helper.buildNewGroup): no group
      // id makes a new group. Members by ACI are never looked up, so nobody is left out or refused: a member with a
      // profile key, pending without. Signal's servers refusing (DIR/fake-create.json { error: true }) reads only as
      // signal-cli's "Failed to create group", code -32603. Then one group update message to everyone but you, its
      // results per person (DIR/fake-add.json { [aci]: { result: TYPE, token?, retryAfterSeconds? } }, else SUCCESS).
      if (existsSync(join(config, 'fake-create.json'))) throw fail('Failed to send message: Failed to create group (IOException) (UnexpectedErrorException)', -32603);
      const rules = existsSync(join(config, 'fake-add.json')) ? JSON.parse(readFileSync(join(config, 'fake-add.json'), 'utf8')) : {};
      const adds = [...new Set<string>([].concat(params?.member ?? params?.members ?? []))].filter((id) => id !== SELF);
      const people = contacts();
      const members: any[] = [{ number: NUMBER, uuid: SELF, isAdmin: true }];
      const pendingMembers: any[] = [];
      const results: any[] = [];
      for (const id of adds) {
        const c = people.find((x: any) => x.uuid === id);
        if (c?.profile) members.push({ number: c.number ?? null, uuid: id, isAdmin: false });
        else pendingMembers.push({ number: c?.number ?? null, uuid: id });
        const r = rules[id]?.result ? rules[id] : { result: 'SUCCESS' };
        results.push({ recipientAddress: { uuid: id, number: c?.number ?? null }, type: r.result, ...(r.token ? { token: r.token } : {}), ...(r.retryAfterSeconds ? { retryAfterSeconds: r.retryAfterSeconds } : {}) });
      }
      const g = { ...all[0], id: `NewGr0up${all.length}=`, name: params?.name ?? '', description: '', isMember: true, members, pendingMembers, requestingMembers: [], admins: [{ number: NUMBER, uuid: SELF }], permissionAddMember: 'EVERY_MEMBER', permissionEditDetails: 'EVERY_MEMBER', permissionSendMessage: 'EVERY_MEMBER', messageExpirationTime: 0, groupInviteLink: null };
      save('fake-groups.json', [...all, g]);
      return { timestamp: nextTs(), results, groupId: g.id };
    }
    const g = all.find((x: any) => x.id === params.groupId);
    if (!g) throw fail('Invalid group id');
    const admin = g.members.some((m: any) => m.uuid === SELF && m.isAdmin);
    const perm = (p: string) => (p === 'only-admins' ? 'ONLY_ADMINS' : 'EVERY_MEMBER');
    const adminOnly = ['setPermissionSendMessages', 'setPermissionEditDetails', 'setPermissionAddMember', 'link', 'resetLink', 'removeMember', 'admin', 'removeAdmin', 'ban', 'unban'].some((k) => k in params);
    if (g.isTerminated) throw fail('Group is terminated');
    const edits = ['name', 'description', 'expiration'].some((k) => k in params);
    if ((adminOnly || (edits && g.permissionEditDetails === 'ONLY_ADMINS')) && !admin) throw fail('Not a group admin');
    // An update on an invitation accepts it first, as the real one does.
    if ((g.pendingMembers ?? []).some((m: any) => m.uuid === SELF)) {
      g.pendingMembers = g.pendingMembers.filter((m: any) => m.uuid !== SELF);
      g.members = [...g.members, { number: NUMBER, uuid: SELF, isAdmin: false }];
    }
    g.isMember = true;
    const adds: string[] = [].concat(params.member ?? []);
    if (adds.length) {
      if (g.permissionAddMember === 'ONLY_ADMINS' && !admin) throw fail('Not a group admin');
      const rules = existsSync(join(config, 'fake-add.json')) ? JSON.parse(readFileSync(join(config, 'fake-add.json'), 'utf8')) : {};
      for (const id of adds) if (rules[id] && rules[id] !== 'drop') throw fail(rules[id].error, rules[id].code ?? -1);
      const people = contacts();
      g.pendingMembers ??= [];
      for (const id of adds) {
        // As the real one: someone in it already is left out.
        if (rules[id] === 'drop' || g.members.some((m: any) => m.uuid === id) || g.pendingMembers.some((m: any) => m.uuid === id)) continue;
        const c = people.find((x: any) => x.uuid === id);
        if (c?.profile) g.members.push({ number: c.number ?? null, uuid: id, isAdmin: false });
        else g.pendingMembers.push({ number: c?.number ?? null, uuid: id });
      }
    }
    const listOf = (k: string): string[] => [].concat(params[k] ?? []);
    // Someone asking to join is let in by adding them, turned away by removing them.
    for (const id of adds) g.requestingMembers = (g.requestingMembers ?? []).filter((m: any) => m.uuid !== id);
    for (const id of listOf('removeMember')) {
      g.members = g.members.filter((m: any) => m.uuid !== id);
      g.pendingMembers = (g.pendingMembers ?? []).filter((m: any) => m.uuid !== id);
      g.requestingMembers = (g.requestingMembers ?? []).filter((m: any) => m.uuid !== id);
    }
    for (const id of listOf('admin')) for (const m of g.members) if (m.uuid === id) m.isAdmin = true;
    for (const id of listOf('removeAdmin')) for (const m of g.members) if (m.uuid === id) m.isAdmin = false;
    for (const id of listOf('ban')) {
      g.members = g.members.filter((m: any) => m.uuid !== id);
      g.banned = [...(g.banned ?? []).filter((m: any) => m.uuid !== id), { number: null, uuid: id }];
    }
    for (const id of listOf('unban')) g.banned = (g.banned ?? []).filter((m: any) => m.uuid !== id);
    if ('avatar' in params) {
      if (!existsSync(params.avatar)) throw fail(`Group avatar file not found: ${params.avatar}`);
      g._avatar = params.avatar;
    }
    if ('memberLabel' in params || 'memberLabelEmoji' in params) {
      const me = g.members.find((m: any) => m.uuid === SELF);
      if (!me) throw fail('User is not a group member');
      if ('memberLabel' in params) me.label = params.memberLabel || null;
      if ('memberLabelEmoji' in params) me.labelEmoji = params.memberLabelEmoji || null;
    }
    if ('name' in params) g.name = params.name;
    if ('description' in params) g.description = params.description;
    if ('expiration' in params) g.messageExpirationTime = params.expiration;
    if ('setPermissionSendMessages' in params) g.permissionSendMessage = perm(params.setPermissionSendMessages);
    if ('setPermissionEditDetails' in params) g.permissionEditDetails = perm(params.setPermissionEditDetails);
    if ('setPermissionAddMember' in params) g.permissionAddMember = perm(params.setPermissionAddMember);
    if (params.link) g._approval = params.link === 'enabled-with-approval';
    if (params.link === 'disabled') g.groupInviteLink = null;
    else if (params.link || params.resetLink) g.groupInviteLink = `https://signal.group/#CjQKIFake${nextTs().toString(36)}`;
    save('fake-groups.json', all);
    return { groupId: g.id, timestamp: nextTs(), results: [] };
  };
  const updateContact = (params: any) => {
    const all = contacts();
    const c = all.find((x: any) => x.uuid === params?.recipient || x.number === params?.recipient);
    if (!c) throw fail('Unknown recipient');
    if ('expiration' in params) c.messageExpirationTime = params.expiration;
    // As the real one: a field not given is kept, and naming them un-hides them.
    for (const k of ['nickGivenName', 'nickFamilyName', 'note', 'givenName', 'familyName']) if (k in params) c[k] = params[k];
    if (['nickGivenName', 'nickFamilyName', 'note', 'givenName', 'familyName'].some((k) => k in params)) c.isHidden = false;
    save('fake-contacts.json', all);
    return {};
  };
  const identities = () => {
    const f = join(config, 'fake-identities.json');
    if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
    return [];
  };
  const trust = (params: any) => {
    const all = identities();
    const id = all.find((x: any) => x.uuid === params?.recipient || x.number === params?.recipient);
    if (!id) throw fail('Failed to set the trust for this number, make sure the number is correct.');
    if (params.trustAllKnownKeys) id.trustLevel = 'TRUSTED_UNVERIFIED';
    else if (params.verifiedSafetyNumber === id.safetyNumber) id.trustLevel = 'TRUSTED_VERIFIED';
    else throw fail('Failed to set the trust for this number, make sure the number and the fingerprint/safety number are correct.');
    save('fake-identities.json', all);
    return {};
  };
  const unblock = (params: any) => {
    const people = contacts();
    for (const r of [].concat(params?.recipient ?? [])) {
      const c = people.find((x: any) => x.uuid === r || x.number === r);
      if (c) c.isBlocked = false;
    }
    if (params?.recipient) save('fake-contacts.json', people);
    const all = groups();
    for (const id of [].concat(params?.groupId ?? [])) {
      const g = all.find((x: any) => x.id === id);
      if (g) g.isBlocked = false;
    }
    if (params?.groupId) save('fake-groups.json', all);
    return {};
  };
  const removeContact = (params: any) => {
    const people = contacts();
    const c = people.find((x: any) => x.uuid === params?.recipient || x.number === params?.recipient);
    if (!c) throw fail('Unknown recipient');
    if (params.forget) throw fail('fake: forget is not faked');
    if (params.hide) c.isHidden = true;
    save('fake-contacts.json', people);
    return {};
  };
  const deviceFile = join(config, 'fake-device.json');
  const updateAccount = (params: any) => {
    if (params?.deviceName) writeFileSync(deviceFile, JSON.stringify({ name: params.deviceName }));
    const people = contacts();
    const me = people.find((x: any) => x.uuid === SELF);
    if (params?.deleteUsername) {
      me.username = null;
      save('fake-contacts.json', people);
      return {};
    }
    if (params?.username) {
      const name = /\.\d+$/.test(params.username) ? params.username : `${params.username}.42`;
      me.username = name;
      save('fake-contacts.json', people);
      return { username: name, usernameLink: `https://signal.me/#eu/fake${name.length}` };
    }
    return {};
  };
  // Your own profile: only the fields given change, as in signal-cli.
  const updateProfile = (params: any) => {
    const all = contacts();
    const me = all.find((x: any) => x.uuid === SELF);
    me.profile ??= { lastUpdateTimestamp: 0, givenName: null, familyName: null, about: null, aboutEmoji: null, hasAvatar: false, mobileCoinAddress: null };
    for (const k of ['givenName', 'familyName', 'about', 'aboutEmoji']) if (k in params) me.profile[k] = params[k];
    if (params.avatar) {
      if (!existsSync(params.avatar)) throw fail(`Failed to read avatar file: ${params.avatar}`);
      me.profile.hasAvatar = true;
    }
    if (params.removeAvatar) me.profile.hasAvatar = false;
    me.profile.lastUpdateTimestamp = Date.now();
    save('fake-contacts.json', all);
    return {};
  };
  const joinGroup = (params: any) => {
    const links = existsSync(join(config, 'fake-links.json')) ? JSON.parse(readFileSync(join(config, 'fake-links.json'), 'utf8')) : {};
    const l = links[params?.uri];
    if (!l) throw fail('Group link is not valid: Group link is not active (NOT_FOUND)');
    if (l.error) throw fail(l.error, l.code ?? -1);
    const all = groups();
    const had = all.find((x: any) => x.id === l.group.id);
    if (had?.requestingMembers?.some((m: any) => m.uuid === SELF)) throw fail('Pending admin approval: You have already requested to join the group.');
    const me = { number: NUMBER, uuid: SELF };
    const g = l.approval ? { ...l.group, isMember: false, requestingMembers: [me] } : { ...l.group, isMember: true, members: [...l.group.members, { ...me, isAdmin: false }] };
    save('fake-groups.json', [...all.filter((x: any) => x.id !== g.id), g]);
    return { groupId: g.id, timestamp: nextTs(), results: [], ...(l.approval ? { onlyRequested: true } : {}) };
  };
  const quitGroup = (params: any) => {
    const all = groups();
    const g = all.find((x: any) => x.id === params?.groupId);
    if (!g) throw fail('Invalid group id');
    if ((g.pendingMembers ?? []).some((m: any) => m.uuid === SELF)) g.pendingMembers = g.pendingMembers.filter((m: any) => m.uuid !== SELF);
    else if (g.isMember) {
      const admins = g.members.filter((m: any) => m.isAdmin);
      const next: string[] = [].concat(params?.admin ?? []);
      if (admins.length === 1 && admins[0].uuid === SELF && g.members.length > 1 && !next.length) throw fail('You need to choose at least one new admin as you are the last admin');
      for (const m of g.members) if (next.includes(m.uuid)) m.isAdmin = true;
      g.members = g.members.filter((m: any) => m.uuid !== SELF);
    } else throw fail('User is not a group member');
    g.isMember = false;
    save('fake-groups.json', params?.delete ? all.filter((x: any) => x !== g) : all);
    return { timestamp: nextTs(), results: [] };
  };
  const block = (params: any) => {
    const people = contacts();
    for (const r of [].concat(params?.recipient ?? [])) {
      const c = people.find((x: any) => x.uuid === r || x.number === r);
      if (!c) throw fail('Unknown recipient');
      c.isBlocked = true;
    }
    if (params?.recipient) save('fake-contacts.json', people);
    const all = groups();
    for (const id of [].concat(params?.groupId ?? [])) {
      const g = all.find((x: any) => x.id === id);
      if (!g) throw fail(`Unknown group id: ${id}`);
      g.isBlocked = true;
    }
    if (params?.groupId) save('fake-groups.json', all);
    return {};
  };
  const messageRequestResponse = (params: any) => {
    if (params?.type !== 'accept' && params?.type !== 'delete') throw fail('Invalid type');
    const people = contacts();
    for (const r of [].concat(params?.recipient ?? [])) {
      const c = people.find((x: any) => x.uuid === r || x.number === r);
      if (c) c.profileSharing = params.type === 'accept';
    }
    save('fake-contacts.json', people);
    return {};
  };
  let ts = Date.now();
  const nextTs = () => (ts = Math.max(ts + 1, Date.now()));
  const handle = (method: string, params: any): unknown => {
    switch (method) {
      case 'listContacts': {
        // As the real one: without allRecipients only contacts (not hidden, still registered), recipients or not.
        const all = params?.allRecipients ? contacts() : contacts().filter((c: any) => c.uuid !== SELF && c._contact !== false && !c.isHidden && !c.unregistered);
        const want: string[] | undefined = params?.recipient ? [].concat(params.recipient) : undefined;
        const shown = (c: any) => Object.fromEntries(Object.entries(c).filter(([k]) => !k.startsWith('_')));
        return all.filter((c: any) => !want || want.includes(c.uuid) || want.includes(c.number)).map(shown);
      }
      case 'getUserStatus': {
        const byNumber = [].concat(params?.recipient ?? []).map((r: string) => {
          const c = contacts().find((x: any) => x.number === r);
          return { recipient: r, number: r, uuid: c?.uuid ?? (r === '+15550199' ? 'f00d0000-1111-4aaa-8bbb-000000000099' : null), isRegistered: !!c || r === '+15550199' };
        });
        const byName = [].concat(params?.username ?? []).map((u: string) => {
          if (u === 'busy.42') throw fail(`Rate limit reached\nNext attempt may be tried at ${Date.now() + 600_000} (later)`, -5);
          const c = contacts().find((x: any) => x.username === u || (x._links ?? []).includes(u));
          return { recipient: u, number: null, username: u, uuid: c?.uuid ?? null, isRegistered: !!c };
        });
        return [...byNumber, ...byName];
      }
      case 'joinGroup':
        return joinGroup(params);
      case 'quitGroup':
        return quitGroup(params);
      case 'block':
        return block(params);
      case 'sendMessageRequestResponse':
        return messageRequestResponse(params);
      case 'listGroups': {
        const ids: string[] | undefined = params?.groupId ? [].concat(params.groupId) : undefined;
        return groups().filter((g: any) => !ids || ids.includes(g.id));
      }
      case 'sendPollCreate':
      case 'sendPollVote':
      case 'sendPollTerminate':
      case 'sendPinMessage':
      case 'sendUnpinMessage':
      case 'send':
      case 'sendReaction':
      case 'remoteDelete':
      case 'sendReceipt':
      case 'sendTyping': {
        if (params?.message === 'FAIL') throw Object.assign(new Error('Failed to send message'), { code: -1 });
        if (params?.message === 'CAPTCHA') {
          const results = [{ recipientAddress: { uuid: 'a11ce000-2222-4ccc-9ddd-000000000002', number: '+15550137' }, type: 'RATE_LIMIT_FAILURE', token: 'fake-challenge-1' }];
          throw Object.assign(new Error('Failed to send message due to rate limiting'), { code: -5, data: { response: { timestamp: nextTs(), results } } });
        }
        // Some of a group reached, as the real one answers when one member is gone from Signal.
        if (params?.message === 'PARTIAL')
          return {
            timestamp: nextTs(),
            results: [
              { recipientAddress: { uuid: 'a11ce000-2222-4ccc-9ddd-000000000002', number: '+15550137' }, type: 'SUCCESS' },
              { recipientAddress: { uuid: '5a3e0000-3333-4eee-afff-000000000003', number: '+15550161' }, type: 'UNREGISTERED_FAILURE' },
            ],
          };
        return { timestamp: nextTs(), results: [{ recipientAddress: { uuid: 'a11ce000-2222-4ccc-9ddd-000000000002', number: '+15550137' }, type: 'SUCCESS' }] };
      }
      case 'updateGroup':
        return updateGroup(params);
      case 'terminateGroup': {
        const all = groups();
        const g = all.find((x: any) => x.id === params?.groupId);
        if (!g) throw fail('Invalid group id');
        if (!g.members.some((m: any) => m.uuid === SELF && m.isAdmin)) throw fail('Not a group admin');
        g.isTerminated = true;
        save('fake-groups.json', all);
        return { timestamp: nextTs(), results: [] };
      }
      case 'sendAdminDelete': {
        const g = groups().find((x: any) => ([] as any[]).concat(params?.groupId ?? []).includes(x.id));
        if (!g) throw fail('sendAdminDelete needs a group');
        if (!g.members.some((m: any) => m.uuid === SELF && m.isAdmin)) throw fail('Not a group admin');
        return { timestamp: nextTs(), results: [] };
      }
      case 'updateContact':
        return updateContact(params);
      case 'updateProfile':
        return updateProfile(params);
      case 'sendSyncRequest':
        return {};
      case 'listIdentities':
        return identities();
      case 'trust':
        return trust(params);
      case 'unblock':
        return unblock(params);
      case 'removeContact':
        return removeContact(params);
      case 'updateAccount':
        return updateAccount(params);
      case 'listDevices': {
        const name = existsSync(deviceFile) ? JSON.parse(readFileSync(deviceFile, 'utf8')).name : 'dither-chat';
        return [
          { id: 1, name: null, createdTimestamp: 1600000000000, lastSeenTimestamp: Date.now() },
          { id: 2, name, createdTimestamp: 1700000000000, lastSeenTimestamp: Date.now() },
        ];
      }
      case 'submitRateLimitChallenge':
        if (String(params?.captcha ?? '').startsWith('BAD')) throw fail('Captcha rejected, it may be outdated, already used or solved from a different IP address.');
        if (params?.challenge !== 'fake-challenge-1') throw fail('Invalid challenge');
        return {};
      // Sticker packs: one installed to begin with, and whatever addStickerPack put in fake-stickers.json.
      case 'listStickerPacks': {
        const file = join(config, 'fake-stickers.json');
        const added = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
        const cats = { packId: '0123456789abcdef0123456789abcdef', url: 'https://signal.art/addstickers/#pack_id=0123456789abcdef0123456789abcdef&pack_key=k', installed: true, title: 'Cats', author: 'A', cover: { id: 0, emoji: '😺', contentType: 'image/webp' }, stickers: [{ id: 0, emoji: '😺', contentType: 'image/webp' }, { id: 1, emoji: '😿', contentType: 'image/webp' }] };
        const known = { packId: 'fedcba9876543210fedcba9876543210', installed: false, title: 'Seen, not installed', stickers: [{ id: 0, emoji: '🙂' }] };
        return [cats, known, ...added];
      }
      case 'addStickerPack': {
        const uri = [].concat(params?.uri ?? [])[0] as string | undefined;
        const m = /pack_id=([0-9a-f]{32})/.exec(uri ?? '');
        if (!m) throw fail('Invalid sticker pack uri');
        const file = join(config, 'fake-stickers.json');
        const added = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
        added.push({ packId: m[1], installed: true, title: 'Added', stickers: [{ id: 0, emoji: '⭐', contentType: 'image/png' }] });
        save('fake-stickers.json', added);
        return {};
      }
      case 'getSticker':
        return { data: Buffer.from(`sticker ${params?.packId}:${params?.stickerId}`).toString('base64') };
      case 'version':
        return { version: '0.14.8-fake' };
      default:
        throw Object.assign(new Error('Method not implemented'), { code: -32601 });
    }
  };
  Bun.listen({
    unix: socketPath,
    socket: {
      open: (s) => {
        conns.add(s);
        (s as any).buf = '';
      },
      close: (s) => {
        conns.delete(s);
      },
      data: (s, chunk) => {
        (s as any).buf += chunk.toString();
        let nl: number;
        while ((nl = (s as any).buf.indexOf('\n')) >= 0) {
          const line = (s as any).buf.slice(0, nl);
          (s as any).buf = (s as any).buf.slice(nl + 1);
          if (!line.trim()) continue;
          const req = JSON.parse(line);
          record({ t: 'rpc', method: req.method, params: req.params ?? null });
          const hang = join(config, 'fake-hang');
          if (existsSync(hang) && readFileSync(hang, 'utf8').trim() === String(process.pid)) continue;
          try {
            send(s, { jsonrpc: '2.0', id: req.id, result: handle(req.method, req.params) });
          } catch (e: any) {
            send(s, { jsonrpc: '2.0', id: req.id, error: { code: e.code ?? -1, message: e.message, data: e.data ?? null } });
          }
        }
      },
    },
  });
  const pushDir = join(config, 'fake-push');
  mkdirSync(pushDir, { recursive: true });
  setInterval(() => {
    for (const f of readdirSync(pushDir).sort()) {
      if (!conns.size) return; // on-connection: only deliver while someone listens
      const p = join(pushDir, f);
      const params = JSON.parse(readFileSync(p, 'utf8'));
      rmSync(p);
      for (const s of conns) send(s, { jsonrpc: '2.0', method: 'receive', params });
    }
    const exitFile = join(config, 'fake-exit');
    if (existsSync(exitFile)) {
      const code = Number(readFileSync(exitFile, 'utf8').trim() || 3);
      rmSync(exitFile);
      console.error('ERROR fake: simulated crash');
      process.exit(code);
    }
  }, 20);
} else if (!sub) {
  console.error('fake: unsupported command ' + args.join(' '));
  process.exit(1);
}
