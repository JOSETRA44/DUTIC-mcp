import type { Command } from "commander";
import { createInterface } from "node:readline/promises";
import type { Session } from "../core/session.js";
import { observeIdentity } from "../domain/identity.js";
import {
  disabledByEnvironment,
  loadState,
  updateState,
  type IdentityConsent,
} from "../telemetry/consent.js";
import {
  flush,
  initTelemetry,
  localQueue,
  startSpan,
  takeFirstRunNotice,
  telemetryActive,
} from "../telemetry/index.js";
import { hashSecret } from "../telemetry/install.js";
import { PERSONAL_POLICY_READY } from "../telemetry/scrub.js";
import { postJson, TELEMETRY_ENDPOINT } from "../telemetry/transport.js";
import { banner, c, mark } from "./ui.js";

const out = (msg = "") => process.stdout.write(msg + "\n");
const log = (msg: string) => process.stderr.write(msg + "\n");

// ── Instrumentación de la CLI ──────────────────────────────────────────────────────

/** `saas push` → `saas.push`: el nombre del evento no admite espacios. */
function commandPath(command: Command): string {
  const names: string[] = [];
  for (let current: Command | null = command; current?.parent; current = current.parent) {
    names.unshift(current.name());
  }
  return names.join(".") || command.name();
}

let commandSpan: { end(error?: unknown): void } | null = null;

/** Mide cada comando como un span `command`. Se engancha DESPUÉS del hook que fija el semestre. */
export function instrumentCli(program: Command): void {
  program.hook("preAction", (_root, action) => {
    const name = commandPath(action);
    initTelemetry({ surface: name.startsWith("auto") ? "auto" : "cli" });

    if (!name.startsWith("telemetry")) {
      const notice = takeFirstRunNotice();
      if (notice) log(c.dim(`\n${notice}\n`));
    }
    commandSpan = startSpan("command", name);
  });

  program.hook("postAction", () => {
    commandSpan?.end();
    commandSpan = null;
  });
}

/** Cierra el span del comando (con su error, si lo hubo) y envía lo pendiente con poca paciencia. */
export async function finishCli(error?: unknown): Promise<void> {
  commandSpan?.end(error);
  commandSpan = null;
  await flush({ budgetMs: 1500 });
}

// ── Tras un login ──────────────────────────────────────────────────────────────────

/**
 * Pregunta UNA vez si se puede asociar la identidad, y anota quién es el usuario en el
 * semestre de esta sesión. Sólo en una terminal interactiva: el MCP y el agente nunca preguntan.
 */
export async function afterLogin(session: Session): Promise<void> {
  if (telemetryActive() && loadState().identity === "unasked" && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      log("");
      log("Si algo falla, poder ver QUIÉN tuvo el problema nos permite ayudarte directamente.");
      const answer = await rl.question(
        "¿Asociar tu nombre y correo institucional a la telemetría? Puedes cambiarlo luego. [s/N] ",
      );
      updateState({ identity: /^s/i.test(answer.trim()) ? "granted" : "denied" });
    } finally {
      rl.close();
    }
  }
  await observeIdentity(session).catch(() => null);
}

// ── `dutic telemetry` ──────────────────────────────────────────────────────────────

const IDENTITY_LABEL: Record<IdentityConsent, string> = {
  unasked: "sin preguntar todavía",
  granted: "concedida",
  denied: "denegada",
  blocked_by_domain: "bloqueada por la cuenta institucional",
};

export function registerTelemetryCommands(program: Command): void {
  const telemetry = program
    .command("telemetry")
    .description("Telemetría técnica: qué se envía, consentimiento y borrado de tus datos.");

  telemetry
    .command("status")
    .description("Muestra si la telemetría está activa, qué identidad comparte y cuánto hay pendiente.")
    .action(() => {
      const state = loadState();
      const env = disabledByEnvironment();
      const pending = localQueue().stats();

      out(banner("Telemetría"));
      if (!PERSONAL_POLICY_READY) {
        out(`${mark.info()} Estado: ${c.yellow("en preparación")} — esta versión no registra ni envía nada.`);
      } else if (env) {
        out(`${mark.info()} Estado: ${c.dim("apagada")} por la variable de entorno ${env}.`);
      } else {
        out(`${mark.info()} Estado: ${state.technical ? c.green("activa") : c.dim("apagada")}`);
      }
      out(`  Identidad:   ${IDENTITY_LABEL[state.identity]}`);
      out(`  Instalación: ${state.install?.id ?? c.dim("sin registrar")}`);
      out(`  Pendiente:   ${pending.files} archivo(s), ${(pending.bytes / 1024).toFixed(1)} KB`);
      out(`  Destino:     ${c.dim(TELEMETRY_ENDPOINT)}`);
      out("");
      out(c.dim("  Se envía: nombre del comando o herramienta, duración, clase de error y su mensaje"));
      out(c.dim("  saneado, versión, sistema operativo y semestre. Nunca tu sesión, tus notas ni el"));
      out(c.dim("  contenido de tus cursos."));
    });

  telemetry
    .command("on")
    .description("Activa la telemetría técnica.")
    .action(() => {
      updateState({ technical: true });
      out(`${mark.ok()} Telemetría activada.`);
    });

  telemetry
    .command("off")
    .description("Apaga la telemetría y descarta lo que aún no se envió.")
    .action(() => {
      updateState({ technical: false });
      localQueue().clear();
      out(`${mark.ok()} Telemetría apagada. Lo pendiente se descartó sin enviarse.`);
      out(c.dim("  Para borrar también lo ya enviado: dutic telemetry forget"));
    });

  telemetry
    .command("identity")
    .argument("<on|off>", "on: asociar nombre y correo · off: dejar de hacerlo")
    .description("Decide si la telemetría se asocia a tu identidad institucional.")
    .action((value: string) => {
      const granted = value.toLowerCase() === "on";
      if (!granted && value.toLowerCase() !== "off") {
        log(`${mark.err()} Usa \`on\` u \`off\`.`);
        process.exitCode = 1;
        return;
      }
      updateState({ identity: granted ? "granted" : "denied" });
      out(
        granted
          ? `${mark.ok()} Identidad asociada: tus próximos eventos llevarán tu nombre y correo institucional.`
          : `${mark.ok()} Identidad retirada: en el próximo envío el servidor borra tu nombre, correo e id de las cuentas vistas desde este equipo.`,
      );
    });

  telemetry
    .command("forget")
    .description("Borra del servidor todo lo enviado desde este equipo y apaga la telemetría.")
    .action(async () => {
      const { install } = loadState();
      if (install?.id) {
        try {
          const res = await postJson(
            "telemetry-forget",
            {},
            { "X-Dutic-Install": `${install.id}.${install.secret}` },
            15_000,
          );
          if (res.status === 200) {
            out(`${mark.ok()} Servidor: ${Number(res.data.events ?? 0)} evento(s) borrados.`);
          } else if (res.status === 401) {
            out(`${mark.info()} El servidor ya no tenía datos de esta instalación.`);
          } else {
            log(`${mark.err()} El servidor respondió ${res.status}. No se borró nada; reintenta más tarde.`);
            process.exitCode = 1;
            return;
          }
        } catch {
          log(`${mark.err()} Sin conexión con el servidor. No se borró nada; reintenta más tarde.`);
          process.exitCode = 1;
          return;
        }
      }
      localQueue().clear();
      updateState({ technical: false, install: null });
      out(`${mark.ok()} Telemetría apagada y credencial local descartada.`);
      out(c.dim(`  (huella de la credencial borrada: ${install ? hashSecret(install.secret).slice(0, 12) : "ninguna"})`));
    });
}
