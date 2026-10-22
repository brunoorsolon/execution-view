#!/usr/bin/env node
import { main, programNameFor } from './main.js';
import { readConfirmation } from './confirm.js';

// Setting exitCode (instead of calling process.exit) lets `serve` keep running:
// the listening server holds the event loop open.
main(
  process.argv.slice(2),
  {
    stdout: (s) => void process.stdout.write(s),
    stderr: (s) => void process.stderr.write(s),
    env: process.env,
    cwd: process.cwd(),
    isTTY: process.stdout.isTTY === true,
  },
  {
    programName: programNameFor(process.argv[1]),
    // Publishing asks only where a person can answer; anything else must pass --approve.
    ...(process.stdin.isTTY === true
      ? {
          confirm: (question: string) =>
            readConfirmation(process.stdin, (text) => void process.stderr.write(text), question),
        }
      : {}),
  },
).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
