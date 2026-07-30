#!/usr/bin/env node
const cmd = process.argv[2];
if (cmd === "status") {
  process.stderr.write("Not logged in. Run 'cursor-agent login'.\n");
  process.exit(1);
}
process.exit(1);
