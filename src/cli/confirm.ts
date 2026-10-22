import { createInterface } from 'node:readline';

/** The process members a confirmation needs, so a test can supply its own interrupt source. */
export type ConfirmationSignals = Pick<NodeJS.Process, 'once' | 'removeListener'>;

/**
 * Ask a yes/no question and default to No: only an explicit `y` or `yes` approves.
 * End of input, Ctrl-C and every other answer cancel, so no answer can never submit.
 */
export async function readConfirmation(
  input: NodeJS.ReadableStream,
  ask: (question: string) => void,
  question: string,
  signals: ConfirmationSignals = process,
): Promise<boolean> {
  ask(question);
  const lines = createInterface({ input, terminal: false });
  // Closing on SIGINT ends the line iterator, so an interruption cancels like any other answer.
  const onInterrupt = (): void => lines.close();
  signals.once('SIGINT', onInterrupt);
  try {
    for await (const line of lines) {
      const answer = line.trim().toLowerCase();
      return answer === 'y' || answer === 'yes';
    }
    return false;
  } finally {
    signals.removeListener('SIGINT', onInterrupt);
    lines.close();
  }
}
