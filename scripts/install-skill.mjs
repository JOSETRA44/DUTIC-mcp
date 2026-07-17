#!/usr/bin/env node
/**
 * Copia la skill `dutic` a los directorios de skills de los agentes que la soportan
 * (Claude Code, OpenCode, mimocode). Idempotente: sobreescribe la copia existente.
 */
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..", "skills", "dutic", "SKILL.md");
const HOME = homedir();

const targets = [
  join(HOME, ".claude", "skills", "dutic"),
  join(HOME, ".config", "opencode", "skills", "dutic"),
  join(HOME, ".config", "mimocode", "skills", "dutic"),
];

for (const dir of targets) {
  // Sólo instalar si el agente padre existe (evita crear dirs de agentes no instalados).
  const parent = resolve(dir, "..", "..");
  if (!existsSync(parent)) {
    console.log(`⏭️  ${dir} (agente no instalado)`);
    continue;
  }
  mkdirSync(dir, { recursive: true });
  copyFileSync(SRC, join(dir, "SKILL.md"));
  console.log(`✅ ${join(dir, "SKILL.md")}`);
}
