import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { BudgetWorkflowService } from "./budget/budget-workflow-service.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);
const service = new AgentService(config, store, workspaces, runner);
await service.initialize();

// The same runner instance backs both, so the Playground and a budgeted workflow
// contend for one agent rather than quietly running two turns on one thread.
const budgetWorkflows = new BudgetWorkflowService(store, runner);

const app = await createApp(config, service, budgetWorkflows);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
