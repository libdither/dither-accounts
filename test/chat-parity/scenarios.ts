/**
 * The shared composition scenario matrix (docs/parity-testing.md) and the one call a driver's test file makes:
 * runCompositionSuite registers a test per scenario, each run against the same driver, skipping the scenarios whose
 * capabilities the driver does not declare.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { runScenario, runnableSteps, scenarioRuns, type Actor, type Cap, type ParityDriver, type RunOptions, type Scenario } from './harness.ts';

export const REACT_1 = '👍';
export const REACT_2 = '🎉';

const other = (a: Actor): Actor => (a === 'A' ? 'B' : 'A');
const who = (a: Actor) => (a === 'A' ? 'self' : 'peer');

/**
 * The shared matrix: each sequence once with the extractor's account as the author (self) and once with the other
 * person as the author (peer). The other side reacts, replies and pins.
 */
export function compositionScenarios(): Scenario[] {
  const out: Scenario[] = [];
  for (const x of ['A', 'B'] as Actor[]) {
    const y = other(x);
    const w = who(x);
    out.push(
      {
        name: `${w}: send → edit → edit`,
        catches: 'a chained edit arriving as a new message, or the second edit lost',
        steps: [
          { do: 'send', as: x, ref: 'm', body: 'first words' },
          { do: 'edit', as: x, ref: 'm', body: 'second words' },
          { do: 'edit', as: x, ref: 'm', body: 'third words' },
        ],
      },
      {
        name: `${w}: send → edit → react (peer + self) → unreact`,
        catches: 'reactions dropped or misplaced once the message was edited',
        steps: [
          { do: 'send', as: x, ref: 'm', body: 'before the reactions' },
          { do: 'edit', as: x, ref: 'm', body: 'edited, then reacted to' },
          { do: 'react', as: y, ref: 'm', key: REACT_1 },
          { do: 'react', as: x, ref: 'm', key: REACT_2 },
          { do: 'react', as: y, ref: 'm', key: REACT_1, remove: true },
        ],
      },
      {
        name: `${w}: send → edit → edit → react`,
        catches: 'a reaction aimed at an edit event instead of the message after several edits (target-id drift)',
        steps: [
          { do: 'send', as: x, ref: 'm', body: 'one' },
          { do: 'edit', as: x, ref: 'm', body: 'two' },
          { do: 'edit', as: x, ref: 'm', body: 'three' },
          { do: 'react', as: y, ref: 'm', key: REACT_1 },
        ],
      },
      {
        name: `${w}: send → edit → reply`,
        catches: 'a reply pointing at an edit, or at nothing, once its parent was edited',
        steps: [
          { do: 'send', as: x, ref: 'p', body: 'a question' },
          { do: 'edit', as: x, ref: 'p', body: 'a better question' },
          { do: 'reply', as: y, ref: 'r', to: 'p', body: 'an answer' },
        ],
      },
      {
        name: `${w}: send → edit → delete`,
        catches: 'a delete that misses an edited message',
        steps: [
          { do: 'send', as: x, ref: 'm', body: 'soon gone' },
          { do: 'edit', as: x, ref: 'm', body: 'soon gone, edited' },
          { do: 'delete', as: x, ref: 'm' },
        ],
      },
      {
        name: `${w}: send → edit → edit → delete`,
        catches: 'a delete that misses a message edited twice',
        steps: [
          { do: 'send', as: x, ref: 'm', body: 'going' },
          { do: 'edit', as: x, ref: 'm', body: 'still going' },
          { do: 'edit', as: x, ref: 'm', body: 'nearly gone' },
          { do: 'delete', as: x, ref: 'm' },
        ],
      },
      {
        name: `${w}: reply → edit parent → delete parent`,
        catches: 'a reply losing its parent, or its quote changing, as the parent is edited and deleted',
        steps: [
          { do: 'send', as: x, ref: 'p', body: 'the parent' },
          { do: 'reply', as: y, ref: 'r', to: 'p', body: 'the reply' },
          { do: 'edit', as: x, ref: 'p', body: 'the parent, edited' },
          { do: 'delete', as: x, ref: 'p' },
        ],
      },
      {
        name: `${w}: reply → edit the reply → react to it`,
        catches: 'a reply losing its parent, or its quote coming back into its words, when the reply itself is edited',
        steps: [
          { do: 'send', as: x, ref: 'p', body: 'asked' },
          { do: 'reply', as: y, ref: 'r', to: 'p', body: 'answered' },
          { do: 'edit', as: y, ref: 'r', body: 'answered, better' },
          { do: 'react', as: x, ref: 'r', key: REACT_1 },
        ],
      },
      {
        name: `${w}: send → reply to it yourself → edit the reply`,
        catches: "the reply's edit landing on its parent, both being the same person's",
        steps: [
          { do: 'send', as: x, ref: 'p', body: 'first thought' },
          { do: 'reply', as: x, ref: 'r', to: 'p', body: 'second thought' },
          { do: 'edit', as: x, ref: 'r', body: 'second thought, edited' },
          { do: 'react', as: y, ref: 'p', key: REACT_1 },
        ],
      },
      {
        name: `${w}: send → react → edit → unreact`,
        catches: 'a reaction lost, or impossible to take back, after an edit',
        steps: [
          { do: 'send', as: x, ref: 'm', body: 'react to me' },
          { do: 'react', as: y, ref: 'm', key: REACT_1 },
          { do: 'edit', as: x, ref: 'm', body: 'react to me, edited' },
          { do: 'react', as: y, ref: 'm', key: REACT_1, remove: true },
        ],
      },
      {
        name: `${w}: send → pin → edit → unpin`,
        catches: 'a pin lost, or stuck, across an edit',
        steps: [
          { do: 'send', as: x, ref: 'm', body: 'pin me' },
          { do: 'pin', as: y, ref: 'm', pinned: true },
          { do: 'edit', as: x, ref: 'm', body: 'pin me, edited' },
          { do: 'pin', as: y, ref: 'm', pinned: false },
        ],
      },
      {
        name: `${w}: send a file → react → delete`,
        catches: 'a file lost, or a reaction or delete missing a message with a file',
        steps: [
          { do: 'send', as: x, ref: 'm', body: 'a file', attachment: true },
          { do: 'react', as: y, ref: 'm', key: REACT_1 },
          { do: 'delete', as: x, ref: 'm' },
        ],
      },
    );
  }
  return out;
}

export interface SuiteOptions extends RunOptions {
  /** What both sides can do, known before the driver starts (the tests are registered first). */
  capabilities: readonly Cap[];
  only?: Partial<Record<Actor, readonly Cap[]>>;
  /** Why the whole suite skips here (a missing homeserver), or null to run it. */
  skip?: string | null;
  /** Each scenario's limit (bun's), above convergeMs so a failure reports its diff first. Default 60 s. */
  timeoutMs?: number;
  /** Only these scenarios (by name), for a driver being brought up. */
  filter?: (s: Scenario) => boolean;
}

/**
 * Registers the matrix against one driver: the driver starts once (beforeAll) and stops after (afterAll); each
 * scenario is a test, and one whose capabilities the driver lacks is a skipped test saying so.
 */
export function runCompositionSuite(name: string, start: () => Promise<ParityDriver & { stop(): Promise<void> }>, o: SuiteOptions): void {
  describe(`composition parity: ${name}`, () => {
    let d: (ParityDriver & { stop(): Promise<void> }) | null = null;
    beforeAll(async () => {
      if (o.skip) return;
      d = await start();
      expect([...d.capabilities].sort()).toEqual([...o.capabilities].sort());
    }, o.timeoutMs ?? 60_000);
    afterAll(async () => {
      await d?.stop();
    });
    const caps = { capabilities: o.capabilities, only: o.only };
    for (const s of compositionScenarios().filter(o.filter ?? (() => true))) {
      const runs = !o.skip && scenarioRuns(caps, s);
      const label = `${s.name} (${runnableSteps(caps, s).length}/${s.steps.length} steps)`;
      (runs ? test : test.skip)(label, async () => {
        await runScenario(d!, s, o);
      }, o.timeoutMs ?? 60_000);
    }
  });
}
