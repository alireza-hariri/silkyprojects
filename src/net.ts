import { readFile } from "node:fs/promises";
import type { ClientRequest } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";
import { HttpsProxyAgent } from "https-proxy-agent";
import nodeFetch, { FetchError, type RequestInfo, type RequestInit, type Response } from "node-fetch";
import { SocksProxyAgent } from "socks-proxy-agent";

const CONNECT_MS = 10_000;
const PROBE_MS = 15_000;
/** How long we stay on a proxy before checking whether the direct route is back. */
const RECHECK_DIRECT_MS = 10 * 60_000;
const DEFAULT_TEST_URL = "https://telegram.org/robots.txt";

export type Fetch = (url: RequestInfo, init?: RequestInit) => Promise<Response>;

type Agent = HttpsAgent | HttpsProxyAgent<string> | SocksProxyAgent;

interface Route {
	/** Undefined for the direct route. */
	proxy?: string;
	agent: Agent;
}

/**
 * Picks how to reach Telegram: directly, or through the proxy named in ~/.proxyaddr.
 * The file is re-read on every failure, since it tracks whichever proxy is fastest right now.
 */
export class TelegramRoute {
	private route: Route = direct();
	private switching?: Promise<boolean>;
	private onProxySince = 0;
	private proxyFile: string;
	private testUrl: string;

	constructor(proxyFile = process.env.SILKY_PROXY_FILE || join(homedir(), ".proxyaddr"), testUrl = DEFAULT_TEST_URL) {
		this.proxyFile = proxyFile;
		this.testUrl = testUrl;
	}

	get proxy(): string | undefined {
		return this.route.proxy;
	}

	/** A node-fetch drop-in that moves to another route when the current one can't connect. */
	fetch: Fetch = async (url, init = {}) => {
		const route = this.route;
		if (route.proxy && Date.now() - this.onProxySince > RECHECK_DIRECT_MS) void this.tryDirect();
		try {
			return await nodeFetch(url, { ...init, agent: route.agent });
		} catch (err) {
			if (!isNetworkError(err) || init.signal?.aborted) throw err;
			const moved = await this.failover(route, err);
			// A streamed (multipart) body is spent; only plain bodies can be sent again.
			if (!moved || (init.body != null && typeof init.body !== "string")) throw err;
			return nodeFetch(url, { ...init, agent: this.route.agent });
		}
	};

	/** Resolves true when there is a different working route to retry with. */
	private failover(failed: Route, err: unknown): Promise<boolean> {
		if (this.route !== failed) return Promise.resolve(true);
		this.switching ??= this.pick(failed, err).finally(() => (this.switching = undefined));
		return this.switching;
	}

	private async pick(failed: Route, err: unknown): Promise<boolean> {
		console.error(`telegram: ${describe(failed)} failed (${errorMessage(err)})`);
		const proxy = await this.readProxy();
		// The proxy first, as the file may name a new one; then direct, in case the failure was a blip.
		for (const p of new Set([proxy, undefined])) {
			const route = p ? viaProxy(p) : direct();
			if (await this.probe(route)) {
				this.use(route);
				return true;
			}
			route.agent.destroy();
		}
		console.error(`telegram: no working route; staying on ${describe(failed)}`);
		return false;
	}

	private async tryDirect(): Promise<void> {
		this.onProxySince = Date.now();
		const route = direct();
		if (this.route.proxy && !this.switching && (await this.probe(route))) this.use(route);
		else route.agent.destroy();
	}

	private use(route: Route): void {
		const old = this.route;
		this.route = route;
		this.onProxySince = Date.now();
		console.log(`telegram: now going ${describe(route)}`);
		// Let in-flight requests (a long poll) finish on the old sockets.
		setTimeout(() => old.agent.destroy(), 60_000).unref();
	}

	/** Any HTTP answer counts: the test URL is a 404 page. */
	private async probe(route: Route): Promise<boolean> {
		try {
			const res = await nodeFetch(this.testUrl, { agent: route.agent, signal: AbortSignal.timeout(PROBE_MS) as any });
			await res.arrayBuffer();
			return true;
		} catch (err) {
			console.error(`telegram: probe ${describe(route)} failed (${errorMessage(err)})`);
			return false;
		}
	}

	private async readProxy(): Promise<string | undefined> {
		try {
			const proxy = (await readFile(this.proxyFile, "utf8")).trim();
			if (!proxy) console.warn(`telegram: WARNING: ${this.proxyFile} is empty, so there is no proxy to fall back to`);
			return proxy || undefined;
		} catch (err: any) {
			const why = err?.code === "ENOENT" ? "does not exist" : `can't be read (${errorMessage(err)})`;
			console.warn(`telegram: WARNING: ${this.proxyFile} ${why}, so there is no proxy to fall back to. Put a proxy URL in it, e.g. http://127.0.0.1:10808`);
			return undefined;
		}
	}
}

function describe(route: Route): string {
	return route.proxy ? `via ${route.proxy}` : "direct";
}

/** Error text with the bot token masked, since node-fetch puts the request URL in it. */
function errorMessage(err: unknown): string {
	return (err instanceof Error ? err.message : String(err)).replace(/\/bot\d+:[\w-]+/g, "/bot<token>");
}

function isNetworkError(err: unknown): boolean {
	return err instanceof FetchError && err.type === "system";
}

/** A keep-alive agent that gives up on a connection (TCP + TLS) that hangs, as filtered ones tend to. */
class DirectAgent extends HttpsAgent {
	override createConnection(...args: Parameters<HttpsAgent["createConnection"]>): Duplex | null | undefined {
		const socket = super.createConnection(...args) as TLSSocket | null | undefined;
		socket?.setTimeout(CONNECT_MS, () => socket.destroy(new Error(`connect timed out after ${CONNECT_MS / 1000}s`)));
		socket?.once("secureConnect", () => socket.setTimeout(0));
		return socket;
	}
}

class HttpProxy extends HttpsProxyAgent<string> {
	override connect(req: ClientRequest, opts: Parameters<HttpsProxyAgent<string>["connect"]>[1]) {
		return deadline(super.connect(req, opts));
	}
}

class SocksProxy extends SocksProxyAgent {
	override connect(req: ClientRequest, opts: Parameters<SocksProxyAgent["connect"]>[1]) {
		return deadline(super.connect(req, opts));
	}
}

function direct(): Route {
	return { agent: new DirectAgent({ keepAlive: true }) };
}

function viaProxy(proxy: string): Route {
	const agent = /^socks/i.test(proxy) ? new SocksProxy(proxy, { keepAlive: true }) : new HttpProxy(proxy, { keepAlive: true });
	return { proxy, agent };
}

/** Bounds the wait for a proxy to open the tunnel; a late socket is closed. */
function deadline<T extends Duplex>(p: Promise<T>): Promise<T> {
	let timer: NodeJS.Timeout;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			p.then((s) => s.destroy(), () => {});
			reject(new Error(`proxy connect timed out after ${CONNECT_MS / 1000}s`));
		}, CONNECT_MS);
	});
	return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
