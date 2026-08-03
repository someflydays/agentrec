import { spawn } from "node:child_process";

/** Best effort: a failed launch must never take the server down. */
export function openBrowser(url: string): void {
  const [command, args] = launchCommand(url);
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      // no browser available — the URL is already printed
    });
    child.unref();
  } catch {
    // spawn refused outright (e.g. no such binary)
  }
}

function launchCommand(url: string): [string, string[]] {
  switch (process.platform) {
    case "darwin":
      return ["open", [url]];
    case "win32":
      // The empty string is `start`'s window-title argument; without it a
      // quoted URL would be treated as the title.
      return ["cmd", ["/c", "start", "", url]];
    default:
      return ["xdg-open", [url]];
  }
}
