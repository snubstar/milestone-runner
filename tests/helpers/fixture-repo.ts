import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  nodeCommandRunner,
  type CommandResult,
} from "../../src/shell/command-runner.js";

export interface FixtureRepoOptions {
  prefix?: string;
  gitignore?: string | false;
  files?: Record<string, string>;
  commitMessage?: string;
}

export interface FixtureRepo {
  path: string;
  cleanup: () => Promise<void>;
  git: (args: string[]) => Promise<string>;
  gitResult: (args: string[]) => Promise<CommandResult>;
  readFile: (relativePath: string) => Promise<string>;
  writeFile: (relativePath: string, content: string) => Promise<void>;
  mkdir: (relativePath: string) => Promise<void>;
}

export async function createFixtureRepo(
  options: FixtureRepoOptions = {},
): Promise<FixtureRepo> {
  const repoPath = await mkdtemp(
    path.join(os.tmpdir(), options.prefix ?? "agent-orchestrator-fixture-"),
  );
  const repo = buildFixtureRepo(repoPath);

  await repo.git(["init"]);
  if (options.gitignore !== false) {
    await repo.writeFile(".gitignore", options.gitignore ?? ".agent-work/\n");
  }

  const files = options.files ?? {
    "README.md": "# Fixture\n",
  };
  for (const [relativePath, content] of Object.entries(files)) {
    await repo.writeFile(relativePath, content);
  }

  await repo.git(["add", "."]);
  await repo.git([
    "-c",
    "user.name=Agent Orchestrator Test",
    "-c",
    "user.email=agent-orchestrator@example.invalid",
    "commit",
    "-m",
    options.commitMessage ?? "initial",
  ]);

  return repo;
}

function buildFixtureRepo(repoPath: string): FixtureRepo {
  return {
    path: repoPath,
    cleanup: () => rm(repoPath, { recursive: true, force: true }),
    git: async (args) => {
      const result = await runGit(repoPath, args);
      return result.stdout.trim();
    },
    gitResult: (args) => runGit(repoPath, args),
    readFile: (relativePath) => readFile(path.join(repoPath, relativePath), "utf8"),
    writeFile: async (relativePath, content) => {
      const filePath = path.join(repoPath, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf8");
    },
    mkdir: async (relativePath) => {
      await mkdir(path.join(repoPath, relativePath), { recursive: true });
    },
  };
}

async function runGit(repoPath: string, args: string[]): Promise<CommandResult> {
  const result = await nodeCommandRunner.run({
    command: "git",
    args,
    cwd: repoPath,
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }

  return result;
}
