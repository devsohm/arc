#!/usr/bin/env node
import { main } from "./main.ts";
void main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error) => {
		process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
