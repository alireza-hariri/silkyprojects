import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface Config {
	projectsDir: string;
	silkyDir: string;
	piBin: string;
	nodeBin: string;
	runScript: string;
	prettyScript: string;
	pollMs: number;
}

function findPi(): string {
	if (process.env.SILKY_PI) return process.env.SILKY_PI;
	try {
		return execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
	} catch {
		return "pi";
	}
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
	const raw = overrides.projectsDir ?? process.env.PROJECTS_DIR;
	if (!raw) throw new Error("PROJECTS_DIR is not set");
	const projectsDir = resolve(raw.replace(/^~(?=\/|$)/, homedir()));
	return {
		projectsDir,
		silkyDir: join(projectsDir, ".silky"),
		piBin: findPi(),
		nodeBin: process.execPath,
		runScript: join(ROOT, "bin", "silky-run"),
		prettyScript: join(ROOT, "bin", "silky-pretty.mjs"),
		pollMs: 400,
		...overrides,
	};
}
