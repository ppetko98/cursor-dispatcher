#!/usr/bin/env node
// Fake cursor-agent that only handles `status`; used in auth tests.
const cmd = process.argv[2];
if (cmd === "status") {
  process.stdout.write("✓ Logged in as test@example.com\n");
  process.exit(0);
}
process.stderr.write("unsupported\n");
process.exit(1);
