import net from "node:net";
import { loadConfig } from "./config.ts";

// pi's CLI does the same: Node's 250ms default drops valid connections on high-latency routes.
net.setDefaultAutoSelectFamilyAttemptTimeout(2000);
import { Silky } from "./core.ts";

const USAGE = `usage: silky <command>

  daemon                          run the Telegram bot (needs TELEGRAM_BOT_TOKEN)
  status                          list projects and agents
  reconcile                       repair .silky and tmux from the project folders
  create-project <name>           create a project and its first agent
  create-agent <project>          add an agent to a project
  send <project> <agent> <text>   run a prompt and wait for the answer
  stop <project> <agent>          Ctrl-C the agent's current run
  clear <project> <agent>         start a fresh pi session on the next run
  archive-agent <project> <agent> kill the agent's window and archive it

Environment: PROJECTS_DIR (required), SILKY_PI (pi binary, default: pi on PATH)`;

async function main(argv: string[]): Promise<void> {
	const [cmd, ...args] = argv;
	if (!cmd || cmd === "help" || cmd === "--help") return console.log(USAGE);

	const silky = new Silky(loadConfig());
	if (cmd === "daemon") {
		const { runDaemon } = await import("./daemon.ts");
		return runDaemon(silky);
	}

	const need = (n: number) => {
		if (args.length < n) throw new Error(USAGE);
	};
	switch (cmd) {
		case "status":
			await silky.start();
			for (const p of await silky.status()) {
				console.log(p.name);
				for (const a of p.agents) {
					const extra = [a.unread ? `${a.unread} unread` : "", a.queued ? `${a.queued} queued` : ""].filter(Boolean).join(", ");
					console.log(`  ${a.name}  ${a.status}${extra ? `  (${extra})` : ""}`);
				}
			}
			break;
		case "reconcile":
			await silky.start();
			break;
		case "create-project": {
			need(1);
			await silky.start();
			const { agent, existed } = await silky.createProject(args[0]);
			console.log(`${existed ? "existing" : "created"} project ${args[0]}, agent ${agent}`);
			break;
		}
		case "create-agent":
			need(1);
			await silky.start();
			console.log(await silky.createAgent(args[0]));
			break;
		case "send": {
			need(3);
			const [project, agent] = args;
			const text = args.slice(2).join(" ");
			await silky.start();
			const done = new Promise<number>((resolve) => {
				silky.on((e) => {
					if (e.project !== project || !("agent" in e) || e.agent !== agent) return;
					if (e.type === "tool") console.error(`⚙ ${e.toolName}`);
					if (e.type === "finished") {
						console.log(e.text);
						if (e.error) console.error(`✗ ${e.error}`);
						resolve(e.ok ? 0 : 1);
					}
					if (e.type === "interrupted") {
						console.error("✗ interrupted");
						resolve(1);
					}
				});
			});
			const res = await silky.send(project, agent, text);
			if ("queued" in res) console.error(`queued (${res.queued})`);
			process.exitCode = await done;
			break;
		}
		case "stop":
			need(2);
			console.log((await silky.stop(args[0], args[1])) ? "stopped" : "not running");
			break;
		case "clear":
			need(2);
			await silky.clear(args[0], args[1]);
			console.log("cleared");
			break;
		case "archive-agent":
			need(2);
			await silky.start();
			console.log(`left: ${(await silky.archiveAgent(args[0], args[1])).join(", ") || "none"}`);
			break;
		default:
			throw new Error(USAGE);
	}
	silky.stopAll();
}

main(process.argv.slice(2)).catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
