import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function tmux(...args: string[]): Promise<string> {
	const { stdout } = await exec("tmux", args);
	return stdout;
}

async function ok(...args: string[]): Promise<boolean> {
	try {
		await tmux(...args);
		return true;
	} catch {
		return false;
	}
}

const target = (session: string, window?: string) => (window ? `=${session}:=${window}` : `=${session}`);

/** Environment every silky shell gets, so `pi` and `node` resolve even under systemd. */
function envArgs(env: Record<string, string>): string[] {
	return Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
}

export function hasSession(session: string): Promise<boolean> {
	return ok("has-session", "-t", target(session));
}

export async function windows(session: string): Promise<string[]> {
	try {
		const out = await tmux("list-windows", "-t", target(session), "-F", "#{window_name}");
		return out.split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

/** Create the window (and the session, if needed) as an idle shell in `cwd`. */
export async function ensureWindow(session: string, window: string, cwd: string, env: Record<string, string>): Promise<void> {
	if (!(await hasSession(session))) {
		await tmux("new-session", "-d", "-s", session, "-n", window, "-c", cwd, ...envArgs(env));
		return;
	}
	if ((await windows(session)).includes(window)) return;
	await tmux("new-window", "-d", "-t", `${target(session)}:`, "-n", window, "-c", cwd, ...envArgs(env));
}

export async function sendLine(session: string, window: string, line: string): Promise<void> {
	await tmux("send-keys", "-t", target(session, window), "-l", "--", line);
	await tmux("send-keys", "-t", target(session, window), "Enter");
}

export async function interrupt(session: string, window: string): Promise<void> {
	await tmux("send-keys", "-t", target(session, window), "C-c");
}

export async function killWindow(session: string, window: string): Promise<void> {
	await ok("kill-window", "-t", target(session, window));
}

export async function killSession(session: string): Promise<void> {
	await ok("kill-session", "-t", target(session));
}

export function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}
