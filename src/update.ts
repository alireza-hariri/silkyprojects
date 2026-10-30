import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "alireza-hariri/silkyprojects";

/** The silky install (or checkout) this code runs from. */
const ROOT = fileURLToPath(new URL("..", import.meta.url));

function run(cmd: string, args: string[], opts: { cwd?: string; capture?: boolean } = {}): string {
	const res = spawnSync(cmd, args, { cwd: opts.cwd, encoding: "utf8", stdio: opts.capture ? ["ignore", "pipe", "inherit"] : "inherit" });
	if (res.error) throw res.error;
	if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (exit ${res.status})`);
	return res.stdout ?? "";
}

function installDeps(): void {
	console.log("Installing dependencies ...");
	run("npm", ["install", "--omit=dev", "--no-fund", "--no-audit"], { cwd: ROOT });
}

/**
 * Updates silky in place: a git checkout is pulled; an install from install.sh is replaced by the
 * latest GitHub release when it is newer (or always, with `force`). `.env` and other files that
 * are not in the release are kept. A running daemon keeps the old code until it is restarted.
 */
export function update(current: string, opts: { force: boolean }): void {
	if (existsSync(join(ROOT, ".git"))) {
		console.log(`git checkout at ${ROOT}: pulling`);
		run("git", ["-C", ROOT, "pull", "--ff-only"]);
		installDeps();
		return;
	}

	// curl rather than fetch, so https_proxy and friends work as they do for install.sh.
	const release = JSON.parse(run("curl", ["-fsSL", `https://api.github.com/repos/${REPO}/releases/latest`], { capture: true })) as {
		tag_name: string;
		tarball_url: string;
	};
	const latest = release.tag_name.replace(/^v/, "");
	if (latest === current && !opts.force) return console.log(`silky ${current} is up to date`);

	const tmp = mkdtempSync(join(tmpdir(), "silky-update-"));
	try {
		console.log(`Downloading ${release.tag_name} ...`);
		run("sh", ["-c", 'curl -fsSL "$1" | tar -xz -C "$2"', "sh", release.tarball_url, tmp]);
		const [src] = readdirSync(tmp);
		if (!src) throw new Error("release tarball is empty");
		console.log(`Installing to ${ROOT} ...`);
		cpSync(join(tmp, src), ROOT, { recursive: true });
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
	installDeps();
	console.log(`Updated silky ${current} -> ${latest}. Restart the daemon to use it.`);
}
