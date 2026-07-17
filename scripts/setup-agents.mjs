#!/usr/bin/env node
/**
 * Registra el servidor MCP `dutic` en los agentes instalados del usuario, preservando la
 * configuración existente y haciendo backup antes de escribir. Idempotente: reejecutarlo
 * sólo actualiza la entrada `dutic`.
 *
 * Agentes soportados:
 *  - Claude Code   (~/.claude.json)                → esquema mcpServers
 *  - Antigravity   (~/.antigravity/config/mcp_config.json) → esquema mcpServers
 *  - OpenCode      (~/.config/opencode/opencode.jsonc)     → esquema mcp/type:local
 *  - mimocode      (~/.config/mimocode/mimocode.jsonc)     → esquema mcp/type:local
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..");
const SERVER_JS = join(PROJECT_ROOT, "dist", "mcp", "server.js");
const SEMESTER = process.env.DUTIC_SEMESTER || "2026A";
const HOME = homedir();

/** Parser tolerante de JSONC: quita comentarios // y /* *\/ y comas colgantes. */
function parseJsonc(text) {
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const noLine = noBlock.replace(/(^|[^:])\/\/.*$/gm, "$1");
  const noTrailingCommas = noLine.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(noTrailingCommas);
}

function backupAndWrite(file, obj) {
  if (existsSync(file)) {
    const bak = `${file}.dutic-bak`;
    if (!existsSync(bak)) copyFileSync(file, bak);
  } else {
    mkdirSync(dirname(file), { recursive: true });
  }
  writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

// Entradas por esquema.
const mcpServersEntry = {
  command: "node",
  args: [SERVER_JS],
  env: { DUTIC_SEMESTER: SEMESTER },
};
const localMcpEntry = {
  type: "local",
  command: ["node", SERVER_JS],
  enabled: true,
  env: { DUTIC_SEMESTER: SEMESTER },
};

const results = [];

/** Config con esquema { mcpServers: { dutic: {...} } }. */
function configureMcpServers(name, file) {
  try {
    if (!existsSync(file) && name !== "Antigravity") {
      results.push(`⏭️  ${name}: no encontrado (${file})`);
      return;
    }
    const cfg = existsSync(file) ? parseJsonc(readFileSync(file, "utf8")) : {};
    cfg.mcpServers = cfg.mcpServers || {};
    cfg.mcpServers.dutic = mcpServersEntry;
    backupAndWrite(file, cfg);
    results.push(`✅ ${name}: dutic añadido → ${file}`);
  } catch (e) {
    results.push(`❌ ${name}: ${e.message}`);
  }
}

/** Config con esquema { mcp: { dutic: { type:"local", ... } } }. */
function configureLocalMcp(name, file) {
  try {
    if (!existsSync(file)) {
      results.push(`⏭️  ${name}: no encontrado (${file})`);
      return;
    }
    const cfg = parseJsonc(readFileSync(file, "utf8"));
    cfg.mcp = cfg.mcp || {};
    cfg.mcp.dutic = localMcpEntry;
    backupAndWrite(file, cfg);
    results.push(`✅ ${name}: dutic añadido → ${file}`);
  } catch (e) {
    results.push(`❌ ${name}: ${e.message}`);
  }
}

if (!existsSync(SERVER_JS)) {
  console.error(`⚠️  No existe ${SERVER_JS}. Ejecuta \`npm run build\` primero.`);
  process.exit(1);
}

configureMcpServers("Claude Code", join(HOME, ".claude.json"));
configureMcpServers("Antigravity", join(HOME, ".antigravity", "config", "mcp_config.json"));
configureLocalMcp("OpenCode", join(HOME, ".config", "opencode", "opencode.jsonc"));
configureLocalMcp("mimocode", join(HOME, ".config", "mimocode", "mimocode.jsonc"));

console.log("\nConfiguración del MCP `dutic`:\n");
for (const r of results) console.log("  " + r);
console.log(
  "\nReinicia cada agente para que cargue el servidor. Backups guardados como *.dutic-bak.\n",
);
