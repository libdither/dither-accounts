/**
 * For the live view's tests: the inet sockets a process holds, and a VNC server's first words over its Unix socket. A
 * sandbox's x11vnc must hold no inet socket at all (src/vnc.ts): no TCP port, v4 or v6, for anything on this machine
 * or any web page in a browser here to reach.
 */
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { connect } from 'node:net';

/** Every TCP or UDP socket (v4 or v6) the process holds, from /proc: its fds' socket inodes in its namespace's tables. */
export function inetSockets(pid: number): { proto: string; local: string; state: string }[] {
  const inodes = new Set<string>();
  for (const fd of readdirSync(`/proc/${pid}/fd`)) {
    try {
      const m = readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[(\d+)\]$/);
      if (m) inodes.add(m[1]!);
    } catch {
      // closed in between
    }
  }
  const out: { proto: string; local: string; state: string }[] = [];
  for (const proto of ['tcp', 'tcp6', 'udp', 'udp6']) {
    let lines: string[];
    try {
      lines = readFileSync(`/proc/${pid}/net/${proto}`, 'utf8').trim().split('\n').slice(1);
    } catch {
      continue;
    }
    // sl local_address rem_address st tx:rx tr:when retrnsmt uid timeout inode
    for (const l of lines) {
      const f = l.trim().split(/\s+/);
      if (inodes.has(f[9]!)) out.push({ proto, local: f[1]!, state: f[3]! });
    }
  }
  return out;
}

/** The pids among these that are x11vnc. */
export function x11vncs(pids: number[]): number[] {
  return pids.filter((p) => {
    try {
      return readFileSync(`/proc/${p}/comm`, 'utf8').trim() === 'x11vnc';
    } catch {
      return false;
    }
  });
}

/** What a VNC server says first, over its Unix socket. */
export function rfbBanner(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect({ path }, () => {});
    sock.once('data', (b) => {
      resolve(b.toString('latin1'));
      sock.destroy();
    });
    sock.once('error', reject);
    setTimeout(() => (sock.destroy(), reject(new Error('no VNC banner'))), 5000);
  });
}
