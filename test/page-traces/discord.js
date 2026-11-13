/*
 * Discord's hook: its trap on the rspack runtimes' chunk list (two runtimes here, each wrapping the push before it,
 * as Discord's), its media patches while a bridge call runs (the test joins one through the extension once the hook
 * has found the client's stores), the stand-in microphone, and config.json, which a page cannot fetch.
 */
(async () => {
  const { P, check, native, accessor, text, finish, caught } = PROBE;

  function runtime(entry) {
    const modules = {};
    const cache = {};
    const T = (id) => {
      if (cache[id]) return cache[id].exports;
      const m = (cache[id] = { exports: {} });
      modules[id](m, m.exports, T);
      return m.exports;
    };
    T.m = modules;
    T.c = cache;
    T.o = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    const A = { [entry]: 0 };
    const h = (e, t) => {
      const [r, a, s] = t;
      let o;
      if (r.some((x) => A[x] !== 0)) {
        for (const n in a) if (T.o(a, n)) T.m[n] = a[n];
        if (s) o = s(T);
      }
      if (e) e(t);
      for (const i of r) A[i] = 0;
      return o;
    };
    let f;
    (f = self.webpackChunkdiscord_app = self.webpackChunkdiscord_app || []).forEach(h.bind(null, 0)), (f.push = h.bind(null, f.push.bind(f)));
    return T;
  }
  const chunk = (id, mods) => (self.webpackChunkdiscord_app = self.webpackChunkdiscord_app || []).push([[id], mods]);

  const store = (name, extra) => ({ getName: () => name, emitChange() {}, addChangeListener() {}, removeChangeListener() {}, ...extra });
  const handlers = {};
  const stores = (_m, e) => {
    e.A = { dispatch() {}, subscribe: (ev, fn) => void (handlers[ev] = fn), unsubscribe() {}, isDispatching: () => false, _subscriptions: {} };
    e.B = store('UserStore', { getCurrentUser: () => ({ id: '1', username: 'probe' }), getUser: () => null, getUsers: () => ({}) });
    e.C = store('ChannelStore', { getChannel: (id) => ({ id, type: 2, guild_id: null, name: 'Voice' }) });
    e.D = store('GuildStore', { getGuilds: () => ({}), getGuild: () => null });
    e.E = { selectVoiceChannel() {}, disconnect() {} };
  };

  const T1 = runtime('web');
  runtime('sentry');
  chunk('stores', { 7: stores });
  T1('7');

  const list = self.webpackChunkdiscord_app;
  const d = Object.getOwnPropertyDescriptor(window, 'webpackChunkdiscord_app');
  check('the chunk list global: a plain property again', !!d && 'value' in d && d.writable && d.enumerable && d.configurable && d.value === list, PROBE.shape(d));
  check('no probe chunk left in the list', list.length === 1 && list.every((c) => c[0].every((id) => typeof id === 'string')), list.map((c) => c[0].map(String)));
  accessor('the chunk list push', list, 'push');
  check('the chunk list push: enumerable, as an assigned one', Object.getOwnPropertyDescriptor(list, 'push').enumerable === true);
  check('push is the newest runtime’s', text(list.push) === 'function () { [native code] }' && list.push.name === 'bound h');

  // config.json holds the bridge's address and token: not for the page, even knowing the extension's id.
  const ext = new URLSearchParams(location.search).get('ext');
  for (const f of ['config.json', 'manifest.json', 'hook.js']) {
    const got = await fetch(`chrome-extension://${ext}/${f}`).then(
      (r) => r.status,
      () => 'refused',
    );
    check(`chrome-extension://…/${f} from the page`, got === 'refused', got);
  }

  // The call: the test joins it (bridge mode) once the hook has found the stores.
  const MD = MediaDevices.prototype;
  const PC = RTCPeerConnection.prototype;
  const before = { getUserMedia: MD.getUserMedia, enumerateDevices: MD.enumerateDevices, setRemoteDescription: PC.setRemoteDescription };
  const until = async (f, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (f()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };
  const patched = await until(() => MD.enumerateDevices !== before.enumerateDevices, 30000);
  check('the call patched the media functions', patched);
  const media = () => {
    native('MediaDevices.prototype.getUserMedia', MD, P().MediaDevices.prototype, 'getUserMedia');
    native('MediaDevices.prototype.enumerateDevices', MD, P().MediaDevices.prototype, 'enumerateDevices');
    native('RTCPeerConnection.prototype.setRemoteDescription', PC, P().RTCPeerConnection.prototype, 'setRemoteDescription');
    check('navigator.mediaDevices has no own properties', Object.getOwnPropertyNames(navigator.mediaDevices).length === 0, Object.getOwnPropertyNames(navigator.mediaDevices));
  };
  let mic = null;
  if (patched) {
    media();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    check('getUserMedia gives the device’s microphone', stream instanceof MediaStream && stream.getAudioTracks().length === 1);
    const listed = await navigator.mediaDevices.enumerateDevices();
    const m = listed.find((x) => x.kind === 'audioinput');
    // A machine with a microphone of its own lists that one, and the stand-in is not needed.
    if (m && m.deviceId === 'default' && m.label === 'Default' && !(listed.length > 1 && listed.filter((x) => x.kind === 'audioinput').length > 1)) {
      mic = {
        instanceOfMediaDeviceInfo: m instanceof MediaDeviceInfo,
        instanceOfInputDeviceInfo: m instanceof InputDeviceInfo,
        constructor: m.constructor === InputDeviceInfo,
        tag: Object.prototype.toString.call(m),
        ownNames: Object.getOwnPropertyNames(m),
        ownSymbols: Object.getOwnPropertySymbols(m).length,
        keys: Object.keys(m),
        json: JSON.stringify(m),
        inProto: 'deviceId' in m && 'groupId' in m,
        toJSON: text(m.toJSON),
        getCapabilities: typeof m.getCapabilities === 'function' && text(m.getCapabilities) === 'function getCapabilities() { [native code] }',
        capabilities: m.getCapabilities ? Object.keys(m.getCapabilities()) : null,
        groupId: m.groupId,
      };
      check('the stand-in microphone is an InputDeviceInfo', mic.instanceOfMediaDeviceInfo && mic.instanceOfInputDeviceInfo && mic.constructor && mic.tag === '[object InputDeviceInfo]', mic);
      check('the stand-in microphone has no own properties', mic.ownNames.length === 0 && mic.ownSymbols === 0 && mic.keys.length === 0, mic);
      check('the stand-in microphone as JSON', mic.json === JSON.stringify({ deviceId: 'default', kind: 'audioinput', label: 'Default', groupId: m.groupId }), mic.json);
      check('the stand-in microphone’s methods read as native', mic.toJSON === 'function toJSON() { [native code] }' && mic.getCapabilities, mic);
      check('the stand-in microphone: its prototype’s getters still refuse it', !!caught(() => Object.getOwnPropertyDescriptor(MediaDeviceInfo.prototype, 'kind').get.call(m)));
    }
  }
  // The test leaves the call when told the page has looked; then everything is as it was.
  await fetch('/result/discord-call', { method: 'POST', body: '{}' });
  const restored = await until(() => MD.enumerateDevices === before.enumerateDevices && MD.getUserMedia === before.getUserMedia && PC.setRemoteDescription === before.setRemoteDescription, 15000);
  check('leaving the call put the natives back', restored);
  if (restored) media();
  await finish({ patched, mic });
})();
