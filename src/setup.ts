import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { BrowserClient } from "./client";
import { ensureDaemon } from "./daemon/spawn";
import { daemonSocketPath } from "./daemon/protocol";
import { isBrowserRunning } from "./profile/browser-process";
import { promptForProfileIfUnset } from "./profile/command";
import { type Result, err, ok } from "./util/result";

// The machine probes setup runs before touching the client. Each defaults to the real implementation.
export type SetupDeps = {
  readonly isBrowserRunning?: () => Promise<boolean>;
  readonly ensureDaemon?: () => Promise<boolean>;
};

export function registerSetupCommand(pi: ExtensionAPI, client: BrowserClient, deps: SetupDeps = {}): void {
  pi.registerCommand("browser-setup", {
    description: "Connect pi to your Chrome browser",
    handler: async (_args, ctx) => {
      const result = await performSetup(client, ctx, deps);
      if (result.success) {
        ctx.ui.notify(result.data, "info");
      } else {
        ctx.ui.notify(result.error, "error");
      }
    },
  });
}

export type SetupResult = Result<string, string>;

export async function performSetup(
  client: BrowserClient,
  ctx?: ExtensionContext,
  deps: SetupDeps = {},
): Promise<SetupResult> {
  const chromeRunning = await (deps.isBrowserRunning ?? isBrowserRunning)();
  if (!chromeRunning) {
    return err("No browser instance running. Please open your browser and then run /browser-setup.");
  }

  const daemonReady = await (deps.ensureDaemon ?? ensureDaemon)();
  if (!daemonReady) {
    return err(`Could not start the browser daemon. Check ${daemonSocketPath()}.`);
  }

  const profileNote = await promptForProfileIfUnset(client, ctx);

  const startResult = await client.start({ reconnectNow: true });
  if (!startResult.success) {
    return err(`Connection failed (${startResult.error.kind}): ${startResult.error.message}`);
  }

  const tabResult = await client.newTab("https://github.com");
  if (!tabResult.success) {
    return err(`Browser connected but test navigation failed: ${tabResult.error.message}`);
  }

  const info = await client.pageInfo();
  if (info.success && info.data.kind === "dialog") {
    await client.session().call("Page.handleJavaScriptDialog", { accept: true });
  }

  const pageUrl = info.success && info.data.kind === "page" ? info.data.url : "github.com";
  const lines = ["Browser connected ✓", `Navigated to: ${pageUrl}`];
  if (profileNote) lines.push(profileNote);
  return ok(lines.join("\n"));
}

