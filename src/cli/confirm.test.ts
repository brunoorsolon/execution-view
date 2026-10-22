import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readConfirmation, type ConfirmationSignals } from './confirm.js';

async function ask(
  input: NodeJS.ReadableStream,
  signals: ConfirmationSignals = process,
): Promise<{ answer: boolean; prompts: string[] }> {
  const prompts: string[] = [];
  const answer = await readConfirmation(
    input,
    (question) => prompts.push(question),
    'Publish acme/app v1.2.4? [y/N] ',
    signals,
  );
  return { answer, prompts };
}

describe('readConfirmation', () => {
  it('approves only an explicit yes', async () => {
    for (const line of ['y\n', 'Y\n', 'yes\n', 'YES\n', ' yes \n']) {
      expect((await ask(Readable.from([line]))).answer).toBe(true);
    }
    for (const line of ['\n', 'n\n', 'no\n', 'yeah\n', 'yep\n', '1\n']) {
      expect((await ask(Readable.from([line]))).answer).toBe(false);
    }
  });

  it('shows the question before reading the answer', async () => {
    const { prompts } = await ask(Readable.from(['y\n']));
    expect(prompts).toEqual(['Publish acme/app v1.2.4? [y/N] ']);
  });

  it('cancels at end of input, with or without a final newline', async () => {
    expect((await ask(Readable.from([]))).answer).toBe(false);
    expect((await ask(Readable.from(['']))).answer).toBe(false);
  });

  it('cancels on interruption', async () => {
    const emitter = new EventEmitter();
    const signals = {
      once: (event: string, listener: () => void) => {
        emitter.once(event, listener);
        return process;
      },
      removeListener: (event: string, listener: () => void) => {
        emitter.off(event, listener);
        return process;
      },
    } as unknown as ConfirmationSignals;
    const input = new PassThrough();
    const pending = ask(input, signals);
    emitter.emit('SIGINT');
    expect((await pending).answer).toBe(false);
  });
});
