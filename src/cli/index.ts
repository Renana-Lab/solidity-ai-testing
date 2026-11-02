#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { doctor } from "./doctor.js";

const program = new Command();
program.name("sat").description("AI-assisted Solidity testing and auditing (educational)");

program
  .command("doctor")
  .description("check that forge, slither, solc, node and the API key are available")
  .action(async () => {
    process.exitCode = await doctor();
  });

await program.parseAsync(process.argv);
