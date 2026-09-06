#!/usr/bin/env node
import process from "node:process";
import console from "node:console";
import { main, terminalSafe } from "../../dist/packages/cli/src/main.js";

main().catch((error) => {
  console.error(
    terminalSafe(error instanceof Error ? error.message : "Command failed"),
  );
  process.exitCode = 1;
});
