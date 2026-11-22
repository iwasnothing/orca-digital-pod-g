/**
 * OpenCode V2 hook: intercept shell tool calls, send them through the
 * Orca Digital Pod permission gate, then let the sandbox runner execute.
 *
 * Local plugins under .opencode/plugins/*.ts are auto-discovered.
 */
const GATE =
  process.env.ORCA_POD_GATE_URL || "http://127.0.0.1:8877/api/permission-gate";
const WORKER_ID = process.env.ORCA_POD_WORKER_ID || "";
const TICKET_ID = process.env.ORCA_POD_TICKET_ID || "";
const WORKTREE = process.env.ORCA_POD_WORKTREE || process.cwd();

const SHELL_TOOLS = new Set(["bash", "shell", "exec", "command", "terminal"]);

function commandOf(event: { tool?: string; input?: Record<string, unknown> }): string {
  const tool = String(event?.tool || "").toLowerCase();
  const input = (event?.input || {}) as Record<string, unknown>;
  if (!SHELL_TOOLS.has(tool)) return "";
  return String(input.command || input.cmd || "").trim();
}

async function gateCommand(command: string): Promise<{ code: number; output: string }> {
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
  const data = (await resp.json()) as {
    ok?: boolean;
    pending?: boolean;
    message?: string;
    exit_code?: number;
    exitCode?: number;
    output?: string;
  };
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

const plugin = {
  id: "orca.sandbox-gate",
  async setup(ctx: {
    tool: { hook: (name: string, cb: (event: any) => Promise<void> | void) => Promise<unknown> };
  }) {
    try {
      const fs = await import("node:fs");
      fs.writeFileSync(".gate-plugin-loaded", "ok", "utf8");
    } catch {}
    await ctx.tool.hook("execute.before", async (event: any) => {
      const command = commandOf(event);
      if (!command) return;
      if (command.startsWith("true # already executed by orca-digital-pod sandbox")) return;
      const result = await gateCommand(command);
      if (event.input && typeof event.input === "object") {
        const printed = result.output || "sandbox ok";
        event.input.command = `true # already executed by orca-digital-pod sandbox\nprintf %s ${JSON.stringify(printed)}`;
        if ("cmd" in event.input) event.input.cmd = event.input.command;
      }
    });
  },
};

export default plugin;
