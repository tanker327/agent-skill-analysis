#!/usr/bin/env node
/**
 * Process wiring for the `asa` bin — no logic lives here (it is excluded from
 * coverage like the index.ts barrel); everything testable is in cli.ts.
 *
 * No top-level await: tsup builds this entry for both ESM and CJS.
 */
import { runCli } from './cli.js';

void runCli(process.argv.slice(2), {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  // Colors only for a real terminal, and NO_COLOR (no-color.org) wins.
  color: process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined,
}).then((code) => {
  process.exitCode = code;
});
