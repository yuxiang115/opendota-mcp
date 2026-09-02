import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * `opendota-mcp install-skill` — copy the shipped Agent Skill (skill/SKILL.md)
 * into the host application's skill directory. Skills are discovered by the
 * HOST (Claude Code / ZCode / openclaw), never by the MCP server itself, so
 * this is a convenience for `npx opendota-mcp install-skill` users who have no
 * persistent node_modules to copy from.
 */

const SKILL_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../skill/SKILL.md");

interface Target {
  id: string;
  label: string;
  /** Absolute destination directory for the SKILL.md copy, or null for CLI-installed hosts. */
  dir: string | null;
  /** Only offer when the host looks present. */
  detect: () => boolean;
}

const home = (...parts: string[]) => path.join(os.homedir(), ...parts);

const TARGETS: Target[] = [
  {
    id: "claude-code",
    label: "Claude Code (~/.claude/skills/opendota)",
    dir: home(".claude", "skills", "opendota"),
    detect: () => existsSync(home(".claude")),
  },
  {
    id: "zcode",
    label: "ZCode (~/.agents/skills/opendota)",
    dir: home(".agents", "skills", "opendota"),
    detect: () => existsSync(home(".agents")),
  },
  {
    id: "openclaw",
    label: "openclaw (openclaw skills install)",
    dir: null,
    detect: () => {
      try {
        execFileSync("openclaw", ["--version"], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    },
  },
];

const MANUAL = [
  "Claude Code: mkdir -p ~/.claude/skills/opendota && cp <skill-dir>/SKILL.md ~/.claude/skills/opendota/",
  "ZCode:       mkdir -p ~/.agents/skills/opendota && cp <skill-dir>/SKILL.md ~/.agents/skills/opendota/",
  "openclaw:    openclaw skills install <skill-dir>",
];

export function installSkill(requested: string[] = []): void {
  if (!existsSync(SKILL_SRC)) {
    console.error(`Skill file missing from package: ${SKILL_SRC}`);
    console.error("Install the package properly (npm i -g opendota-mcp) or clone the repo.");
    process.exit(1);
  }
  const force = requested.includes("--force") || requested.includes("-f");
  const wantAll = requested.includes("all");
  const explicit = requested.filter((r) => r !== "all" && r !== "--force" && r !== "-f");
  let installed = 0;
  for (const t of TARGETS) {
    const isSelected = explicit.includes(t.id);
    if (!wantAll && !isSelected && !t.detect()) continue;
    try {
      if (t.dir) {
        // File-copy targets always overwrite (npm users re-run to update).
        mkdirSync(t.dir, { recursive: true });
        copyFileSync(SKILL_SRC, path.join(t.dir, "SKILL.md"));
      } else if (t.id === "openclaw") {
        // openclaw skips existing skills unless forced, so upgrades need the flag.
        execFileSync(
          "openclaw",
          ["skills", "install", path.dirname(SKILL_SRC), ...(force ? ["--force"] : [])],
          { stdio: "inherit" },
        );
      }
      console.log(`ok  ${t.label}`);
      installed++;
    } catch (err) {
      console.error(`FAIL ${t.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (installed === 0) {
    console.log("No supported host detected. Manual install:");
    for (const line of MANUAL) console.log(`  ${line}`);
    console.log(`  skill dir in this package: ${path.dirname(SKILL_SRC)}`);
  } else {
    console.log("Done — restart the host app (or start a new session) to load the skill.");
  }
}
