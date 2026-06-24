import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";

async function run(command: string, args: string[], cwd: string) {
  await new Promise<void>((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Reaper Tests",
          GIT_AUTHOR_EMAIL: "reaper-tests@example.com",
          GIT_COMMITTER_NAME: "Reaper Tests",
          GIT_COMMITTER_EMAIL: "reaper-tests@example.com",
        },
      },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }
        resolve();
      },
    );
  });
}

export async function createTempWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "reaper-phase2-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "app.ts"), "export const answer = 41;\n", "utf8");
  await writeFile(path.join(root, "README.md"), "# Temp Workspace\n", "utf8");
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "temp-workspace", version: "1.0.0" }, null, 2),
    "utf8",
  );
  await run("git", ["init"], root);
  await run("git", ["add", "."], root);
  await run("git", ["commit", "-m", "Initial fixture"], root);
  return root;
}
