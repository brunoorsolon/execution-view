#!/usr/bin/env node
import { main } from './main.js';

// Setting exitCode (instead of calling process.exit) lets `serve` keep running:
// the listening server holds the event loop open.
main(process.argv.slice(2), {
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
  env: process.env,
  cwd: process.cwd(),
  isTTY: process.stdout.isTTY === true,
}).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
