/**
 * OpenCode V2 plugin: send shell tool calls through the Orca Digital Pod
 * permission gate + Docker sandbox. No-ops unless ORCA_POD_* env is set.
 */
const GATE =
  process.env.ORCA_POD_GATE_URL || "http://127.0.0.1:8877/api/permission-gate";
const WORKER_ID = process.env.ORCA_POD_WORKER_ID || "";
const TICKET_ID = process.env.ORCA_POD_TICKET_ID || "";
const WORKTREE = process.env.ORCA_POD_WORKTREE || process.cwd();
const ENABLED = Boolean(WORKER_ID || TICKET_ID || process.env.ORCA_POD_GATE_URL);
const SHELL_TOOLS = new Set(["bash", "shell", "exec", "command", "terminal"]);
const SKIP_TOOLS = new Set(["read", "write", "edit", "grep", "glob", "list", "webfetch", "todowrite", "todoread"]);

function commandOf(event) {
  const tool = String(event?.tool || "").toLowerCase();
  const input = event?.input || {};
  if (SKIP_TOOLS.has(tool)) return "";
  const command = String(input.command || input.cmd || input.script || "").trim();
  if (SHELL_TOOLS.has(tool)) return command;
  return command; // unknown tools that carry a shell command still go through the gate
}

async function gateCommand(command) {
  const resp = await fetch(GATE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workerId: WORKER_ID,
      ticketId: TICKET_ID,
      worktreePath: WORKTREE,
      command,
    }),
  });
  const data = await resp.json();
  if (data.pending) {
    throw new Error(
      `Permission gate pending approval: ${data.message || command}. The orchestrator or a person must approve it.`,
    );
  }
  const code = data.exit_code ?? data.exitCode ?? (data.ok ? 0 : 1);
  const output = data.output || data.message || "";
  if (code !== 0) {
    throw new Error(`Sandbox exit ${code}: ${output || command}`);
  }
  return { code, output };
}

async function setup(ctx) {
  try {
    const fs = await import("node:fs");
    const marker = WORKTREE + "/.gate-plugin-loaded";
    fs.writeFileSync(marker, ENABLED ? "enabled" : "loaded-disabled", "utf8");
  } catch {}
  if (!ENABLED) return;
  if (!ctx || typeof ctx.tool?.hook !== "function") return;
  await ctx.tool.hook("execute.before", async (event) => {
    try {
      const fs = await import("node:fs");
      const tool = String(event?.tool || "");
      const keys = event?.input && typeof event.input === "object" ? Object.keys(event.input) : [];
      fs.appendFileSync(WORKTREE + "/.gate-plugin-tools.log", JSON.stringify({ tool, keys }) + "\n");
    } catch {}
    const command = commandOf(event);
    if (!command) return;
    if (command.includes("already executed by orca-digital-pod sandbox")) return;
    const result = await gateCommand(command);
    if (event.input && typeof event.input === "object") {
      const printed = result.output || "sandbox ok";
      event.input.command = `true # already executed by orca-digital-pod sandbox\nprintf %s ${JSON.stringify(printed)}`;
      if ("cmd" in event.input) event.input.cmd = event.input.command;
    }
  });
}

export default {
  id: "orca.sandbox-gate",
  setup,
};
