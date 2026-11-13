import type { Manifest } from '@dither-accounts/manager/kinds';

/** T3 Code's coding threads as chats: each thread a conversation with its agent, a message its next turn (docs/t3.md). */
export default {
  kind: 't3',
  name: 'T3 Code',
  interfaces: ['chat'],
  entry: 'src/main.ts',
  add: {
    blurb:
      "T3 Code's coding threads as chats: each thread a conversation with its agent, under its project, with its state " +
      '(working, waiting for your answer, finished); what you write goes to the thread as its next turn. It runs beside ' +
      'T3 Code on this machine, through its own command line, and needs nothing to sign in: it makes two read-only T3 ' +
      'sessions for itself, and sends each message with `t3 thread send`.',
    fields: [
      {
        key: 'projects',
        label: 'Projects',
        placeholder: 'all of them',
        optional: true,
        hint: "project titles, ids or folders, separated by commas (leave it empty for every project)",
      },
      {
        key: 't3',
        label: 'The t3 command',
        placeholder: 't3 on PATH',
        optional: true,
        pattern: '^/\\S+$',
        hint: 'the absolute path of the t3 command, when it is not on the PATH of dither-accounts',
      },
      {
        key: 'baseDir',
        label: "T3 Code's data directory",
        placeholder: '~/.t3',
        optional: true,
        pattern: '^/\\S+$',
        hint: "an absolute path, only when T3 Code keeps its data elsewhere than ~/.t3 (T3CODE_HOME)",
      },
    ],
    next: 'It reads the threads T3 Code shows in its sidebar now; each one\'s latest turns arrive as messages, older ones as you scroll back.',
  },
} satisfies Manifest;
