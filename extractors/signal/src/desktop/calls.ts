/**
 * Calls from here, through Signal Desktop (desktop.ts), in dither-chat's bridge format (its docs/calls.md, "Video
 * (bridge mode)"): the hub's `call` and `declineCall` commands become the hook's ops, and the hook's news becomes `call`
 * and `callState` events. Only while the account's `calls` setting is on and Desktop is linked and running.
 *
 * Conversations are the signal kind's own ids (`dm:<self>:<peer>`, `group:<id>`); the hook names them by ACI or group
 * id. 1:1 rings are already said by calls.ts from what signal-cli receives; group rings, which signal-cli does not show,
 * come from Desktop.
 */
import type * as P from '@dither-chat/protocol';
import { parseConversation } from '../mapping.ts';
import type { CallsHost, HookEvent, HookTarget } from './desktop.ts';

type Log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;

/** What a linked, running Desktop adds to the account's capabilities. */
export const CALL_CAPABILITIES: P.Capability[] = ['calls', 'declineCall', 'ringCalls', 'callVideo'];

export interface CallsOptions {
  host: CallsHost;
  /** This account's ACI (lowercase), once known. */
  self: () => string | null;
  emit: (ev: P.AdapterEvent) => void;
  log: Log;
  /** This account is the primary device (signal-cli registered the number), so it links Desktop itself. */
  isPrimary: () => boolean;
  /** signal-cli's addDevice: link a device by the code it shows. */
  addDevice: (uri: string) => Promise<void>;
  /** A call through Desktop in a chat ended (left, hung up, or Desktop gone), at `at`. */
  left?: (conversation: string, at: number) => void;
}

export class DesktopCalls {
  /** The call the device is in, by the hub's call id: its conversation. */
  private calls = new Map<string, string>();
  private linkingUrl: string | null = null;
  /** Group rings heard, by ring id: when each started. */
  private rings = new Map<string, number>();

  constructor(private o: CallsOptions) {}

  /** Whether Desktop is in a call in this chat now. */
  inCall(conversation: string): boolean {
    for (const c of this.calls.values()) if (c === conversation) return true;
    return false;
  }

  private done(call: string) {
    const conversation = this.calls.get(call);
    if (conversation === undefined) return;
    this.calls.delete(call);
    this.o.left?.(conversation, Date.now());
  }

  capabilities(): P.Capability[] {
    return this.o.host.ready ? CALL_CAPABILITIES : [];
  }

  conversationOf(t: HookTarget): string | null {
    const self = this.o.self();
    if (!self) return null;
    if ('group' in t) return `group:${t.group}`;
    return `dm:${self}:${t.peer.toLowerCase()}`;
  }

  targetOf(conversation: string): HookTarget {
    const self = this.o.self();
    const t = self ? parseConversation(conversation, self) : null;
    if (!t || t.kind === 'self') throw new Error('Calls go to a person or a group on this account');
    return t.kind === 'group' ? { group: t.groupId } : { peer: t.peer };
  }

  /** Desktop changed (linked, link code, hook): a primary links it at once with its own code. */
  async onAppChange() {
    const app = this.o.host.app;
    if (!app || app.signedIn || !app.linkUrl || !this.o.isPrimary() || app.linkUrl === this.linkingUrl) return;
    this.linkingUrl = app.linkUrl;
    this.o.log('info', 'linking Signal Desktop to this account (its primary device)');
    try {
      await this.o.addDevice(app.linkUrl);
    } catch (e) {
      this.o.log('warn', `linking Signal Desktop failed: ${(e as Error).message}`);
      this.linkingUrl = null;
    }
  }

  async command(cmd: P.AdapterCommand): Promise<unknown> {
    if (!this.o.host.ready) throw new Error('Calls on this Signal account are not set up: turn on its calls setting and link Signal Desktop');
    if (cmd.t === 'declineCall') {
      await this.o.host.request('decline', { target: this.targetOf(cmd.conversation) });
      return {};
    }
    if (cmd.t !== 'call') throw new Error(`not a call command: ${cmd.t}`);
    switch (cmd.op) {
      case 'join': {
        if (cmd.mode !== 'bridge') throw new Error('Signal calls go through bridge mode');
        const target = this.targetOf(cmd.conversation);
        this.calls.set(cmd.call, cmd.conversation);
        try {
          await this.o.host.request('join', { call: cmd.call, target, ring: !!cmd.ring, muted: !!cmd.muted, deafened: !!cmd.deafened }, 40_000);
        } catch (e) {
          this.done(cmd.call);
          throw e;
        }
        return {};
      }
      case 'signal':
        return this.o.host.request('signal', { call: cmd.call, data: cmd.data });
      case 'leave':
        this.done(cmd.call);
        return this.o.host.request('leave', { call: cmd.call });
      case 'mute':
        return this.o.host.request('mute', { call: cmd.call, muted: cmd.muted, deafened: cmd.deafened });
      case 'video':
        return this.o.host.request('video', { call: cmd.call, camera: cmd.camera, screen: cmd.screen, screenAudio: !!cmd.screenAudio });
      case 'note':
        return { ignored: true };
      default:
        throw new Error(`Signal calls do not have ${cmd.op}`);
    }
  }

  /** Desktop went away (its window crashed or reloaded): every call through it is over, for the device too. */
  endAll(reason: string) {
    for (const call of [...this.calls.keys()]) {
      this.done(call);
      this.o.emit({ t: 'call', call, ended: reason });
    }
  }

  /** The hook's news as adapter events. */
  onHook(ev: HookEvent) {
    if (ev.ev === 'call') {
      if (ev.signal !== undefined) this.o.emit({ t: 'call', call: ev.call, signal: ev.signal });
      if (ev.state) {
        const conversation = this.calls.get(ev.call) ?? this.conversationOf(ev.state.target);
        if (!conversation) return;
        const { target: _t, ...rest } = ev.state;
        this.o.emit({ t: 'call', call: ev.call, state: { conversation, ...rest } });
      }
      if (ev.ended !== undefined) {
        this.done(ev.call);
        this.o.emit({ t: 'call', call: ev.call, ended: ev.ended });
      }
      return;
    }
    if (ev.ev === 'ring') {
      const conversation = this.conversationOf(ev.target);
      if (!conversation) return;
      if (ev.state === 'ringing') this.rings.set(ev.ring, ev.at);
      const startedAt = this.rings.get(ev.ring) ?? ev.at;
      if (ev.state === 'ended') this.rings.delete(ev.ring);
      // Answered here: the call goes on (the hub has it as this device's call); else it stopped ringing unanswered.
      const fact: P.CallFact = {
        nativeId: `ring:${ev.ring}`,
        conversation,
        ...(ev.caller ? { caller: ev.caller.toLowerCase() } : {}),
        startedAt,
        ...(ev.state === 'ringing' ? { state: 'ringing', ringsSelf: true } : ev.joined ? { state: 'ongoing', answeredAt: ev.at } : { state: 'ended', outcome: 'missed', endedAt: ev.at }),
        ...(ev.video ? { video: true } : {}),
      };
      this.o.emit({ t: 'callState', call: fact });
    }
  }
}
