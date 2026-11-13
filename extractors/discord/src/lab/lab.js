  // ------------------------------------------------------------------ call lab
  // Appended inside hook.js's closure by sandbox.ts, only for accounts configured with `lab: true`
  // (scripts/call-lab.ts). Never present in a normal sandbox. It drives the client's own voice,
  // camera and Go Live actions with the probe's synthetic media, and reads back what was measured.
  const labProbe = installDitherProbe('sandbox');
  const labFind = (test) => {
    for (const m of candidates()) {
      try {
        if (test(m)) return m;
      } catch (e) {}
    }
    return null;
  };
  const source = (f) => {
    try {
      return Function.prototype.toString.call(f);
    } catch (e) {
      return '';
    }
  };
  labCommand = async (cmd) => {
    const D = mod.Dispatcher;
    switch (cmd.op) {
      case 'media':
        if (cmd.on === false) labProbe.unpatchMedia();
        else labProbe.patchMedia();
        return { ok: true };
      case 'join':
        labProbe.patchMedia();
        mod.VoiceActions.selectVoiceChannel(cmd.channelId);
        return { ok: true };
      case 'leave':
        mod.VoiceActions.disconnect();
        return { ok: true };
      case 'video':
        D.dispatch({ type: 'MEDIA_ENGINE_SET_VIDEO_ENABLED', enabled: !!cmd.on });
        return { ok: true };
      case 'dispatch':
        D.dispatch(cmd.action);
        return { ok: true };
      case 'view': {
        // Open the channel, so the call's video tiles render and the client asks for their streams.
        const g = labFind((m) => typeof m.transitionToGuildSync === 'function');
        if (!g) throw new Error('no guild navigation');
        await g.transitionToGuildSync(cmd.guildId, {}, cmd.channelId);
        return { ok: true };
      }
      case 'findCode': {
        // Functions among module exports whose source contains every needle (for finding actions at runtime).
        const out = [];
        for (const m of candidates()) {
          for (const k of Object.keys(m)) {
            let f;
            try {
              f = m[k];
            } catch (e) {
              continue;
            }
            if (typeof f !== 'function') continue;
            const s = source(f);
            if (cmd.all.every((n) => s.includes(n))) out.push({ key: k, keys: Object.keys(m).slice(0, 40), src: s.slice(0, cmd.max || 1500) });
            if (out.length >= 10) return out;
          }
        }
        return out;
      }
      case 'eval':
        // Lab only: the operator's own expressions against the client's modules.
        return await new Function('mod', 'labFind', 'candidates', 'rest', 'labProbe', 'return (async () => {' + cmd.code + '})()')(mod, labFind, candidates, rest, labProbe);
      case 'speech': {
        const bin = atob(cmd.b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return labProbe.useSpeech(bytes.buffer);
      }
      case 'report':
        return labProbe.report(cmd.since || 0);
      case 'note':
        labProbe.note(cmd.text);
        return { ok: true };
      default:
        throw new Error('unknown lab op ' + cmd.op);
    }
  };
