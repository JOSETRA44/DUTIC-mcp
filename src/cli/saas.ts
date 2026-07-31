import type { Command } from "commander";
import { withSession } from "../core/auth.js";
import { enrollStudent, loadSaasEnrollment, pushChanges } from "../core/saasClient.js";
import { checkChanges } from "../domain/watch.js";
import { setCacheRefresh } from "../core/cache.js";
import { getMyProfile } from "../domain/people.js";
import { banner, c, mark, statusLine } from "./ui.js";
import { installAutoQuietly } from "./auto.js";

const out = (msg = "") => process.stdout.write(msg + "\n");
const log = (msg: string) => process.stderr.write(msg + "\n");

/**
 * Comandos del piloto de notificaciones por WhatsApp: `dutic saas enroll` (opt-in,
 * una vez) y `dutic saas push` (envía las novedades que ya detectó `dutic watch`).
 * El scraping de Moodle nunca sale de esta máquina — sólo se envía el resultado ya
 * calculado (tareas/notas nuevas), nunca la sesión ni el sesskey.
 */
export function registerSaasCommands(program: Command): void {
  const saas = program
    .command("saas")
    .description("Piloto de notificaciones por WhatsApp (opt-in). Requiere consentimiento explícito.");

  saas
    .command("enroll")
    .description("Te registra para el piloto de avisos por WhatsApp de tareas/notas nuevas.")
    .action(async () => {
      await withSession(
        async (session) => {
          const status = statusLine();
          status.set("registrando…");
          const profile = await getMyProfile(session);
          if (!profile.userId) {
            status.done();
            out(`${mark.err()} No se pudo resolver tu userId de Moodle.`);
            return;
          }
          const enrollment = await enrollStudent(profile.userId, profile.name);
          status.done();
          out(banner("Piloto de notificaciones"));
          if (enrollment.status === "pending_link") {
            out(`${mark.info()} Registrado como ${c.cyan(profile.name)}.`);
            out(`  Código de vinculación: ${c.bold(enrollment.linkCode)}`);
            out(`  ${c.dim("Escríbele ese código, tal cual, al número de WhatsApp del bot (pídeselo al operador del piloto).")}`);
          } else {
            out(`${mark.ok()} Ya estabas registrado (estado: ${enrollment.status}).`);
          }

          // Cero clics: enrolarse ya es un opt-in explícito, así que dejamos la revisión
          // automática andando en el mismo paso. Se dice claramente qué se instaló y cómo
          // quitarlo — nada de persistencia silenciosa.
          const installed = await installAutoQuietly();
          if (installed) {
            out(`\n${mark.ok()} Revisión automática activada (cada 3 h, en segundo plano).`);
            out(`  ${c.dim("No queda ningún proceso residente: cada pasada dura segundos y termina.")}`);
            out(`  ${c.dim("Ver estado: dutic auto status  ·  Desactivar: dutic auto uninstall")}`);
          } else {
            out(`\n${c.dim("Para que revise solo: `dutic auto install` (o corre `dutic saas push` a mano).")}`);
          }
        },
        { login: { onStatus: log } },
      );
    });

  saas
    .command("push")
    .description("Calcula novedades (como `dutic watch`) y las envía a la cola de notificaciones.")
    .option(
      "--headless-only",
      "No abrir nunca una ventana de navegador; falla si la sesión no se puede renovar en silencio.",
    )
    .action(async (opts) => {
      const enrollment = await loadSaasEnrollment();
      if (!enrollment) {
        out(`${mark.err()} Aún no estás enrolado. Corre ${c.cyan("dutic saas enroll")} primero.`);
        return;
      }
      // Igual que `dutic watch`: para detectar cambios reales hay que mirar datos
      // frescos. Sin esto la caché podría ocultar justo la novedad que queremos enviar.
      setCacheRefresh(true);
      await withSession(
        async (session) => {
          const status = statusLine();
          status.set("revisando novedades…");
          const { changes, previousAt, snapshot } = await checkChanges(session);
          status.done();
          if (!previousAt) {
            out(`${mark.info()} Línea base guardada localmente. Nada que enviar todavía.`);
            return;
          }
          const result = await pushChanges(enrollment.enrollToken, snapshot, changes);
          out(`${mark.ok()} Enviado — ${result.notificationsQueued} novedad(es) en cola.`);
        },
        { mode: opts.headlessOnly ? "headless-only" : "interactive", login: { onStatus: log } },
      );
    });
}
