#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2)).then((code) => {
  // Exit as soon as the work is done; lingering sockets from a slow site must not keep us waiting.
  process.exit(code);
});
