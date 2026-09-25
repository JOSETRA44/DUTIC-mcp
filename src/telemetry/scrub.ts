import { homedir } from "node:os";

/**
 * Saneado de los textos que salen del equipo en la telemetría: mensajes de error y stacks.
 * NUNCA pasan por aquí argumentos ni resultados de herramientas — esos no se envían en absoluto.
 *
 * Dos niveles, con dueños distintos:
 *
 *   1. SECRETOS (`redactSecrets`) — siempre y sin excepción. Lo que permite suplantar al
 *      usuario (sesskey, MoodleSession, JWT, tokens, credenciales de la instalación) y la ruta
 *      de su carpeta personal, que en Windows lleva su nombre. No es una decisión de producto:
 *      si esto falla, la telemetría es una fuga.
 *
 *   2. DATOS PERSONALES Y ACADÉMICOS (`redactPersonal`) — aquí hay un equilibrio, y está
 *      resuelto abajo, en su propio comentario.
 */

/** Largo final de un mensaje. Un error que no se entiende en 500 caracteres es un stack, no un mensaje. */
export const MAX_MESSAGE_LENGTH = 500;

/**
 * Interruptor de toda la telemetría. Con `false`, dutic NI REGISTRA NI ENVÍA eventos.
 *
 * Existe porque el saneado se aplica al REGISTRAR: un evento guardado en disco con la política
 * a medias seguiría sin sanear el día que se enviara. Se enciende en el mismo cambio en que la
 * política queda implementada y probada, que es el caso desde 2026-09-23.
 */
export const PERSONAL_POLICY_READY: boolean = true;

/**
 * Tope previo al saneado. Se recorta ANTES para acotar el trabajo de las expresiones, pero con
 * margen amplio: cortar justo en MAX_MESSAGE_LENGTH podría partir un secreto por la mitad y
 * dejar su comienzo sin reconocer.
 */
const PRE_SCRUB_LIMIT = 8_000;

const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/(sesskey=)[^&\s"'<>]+/gi, "$1<redacted>"],
  [/(MoodleSession=)[^;\s"'<>]+/gi, "$1<redacted>"],
  [/(PHPSESSID=)[^;\s"'<>]+/gi, "$1<redacted>"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "<jwt>"],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1<redacted>"],
  [/(DUTIC-Install\s+)\S+/gi, "$1<redacted>"],
  [/("?(?:password|passwd|clave|token|secret|enrollToken|sesskey)"?\s*[:=]\s*"?)[^"\s,;}&]+/gi, "$1<redacted>"],
];

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Nivel 1: secretos y carpeta personal. `home` es inyectable para las pruebas. */
export function redactSecrets(text: string, home: string = homedir()): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  if (home) {
    // Windows mezcla separadores: `C:\Users\ana` y `C:/Users/ana` son la misma carpeta, y en
    // un stack pueden aparecer las dos formas (o la codificada de una URL file://).
    const variants = new Set([home, home.replace(/\\/g, "/"), home.replace(/\//g, "\\")]);
    for (const variant of variants) {
      out = out.replace(new RegExp(escapeRegExp(variant), "gi"), "~");
    }
  }
  return out;
}

/* ─────────────────────────────────────────────────────────────────────────────
   Nivel 2: datos personales y académicos.

   Aquí llegan textos YA sin secretos: mensajes de error y stacks. La regla que ordena las
   decisiones es "¿esto señala a una persona, o ayuda a reproducir el fallo?".

   · Correos → FUERA. Identifican a alguien y jamás explican un error de scraping.
   · Ids de PERSONA en URLs (`user/view.php?id=`, `profile.php?id=`, `userid=`) → FUERA. Son
     el identificador de un tercero, y el fallo se reproduce igual sin él.
   · Ids de CURSO o de módulo (`course=`, `course/view.php?id=`, `cmid=`) → SE QUEDAN. No
     señalan a nadie y son justo lo que permite repetir la petición que falló.
   · Números sueltos de 8 o más cifras (DNI, CUI, teléfonos, números de WhatsApp) → FUERA.
   · Texto entre comillas (nombres de tareas y cursos) → SE QUEDA: suele ser lo que explica el
     fallo ("la tarea X no tiene fecha"), y el nombre de un curso no es un dato personal. Los
     nombres de personas no llegan por esta vía: los argumentos y resultados de las herramientas
     no se envían nunca, y los mensajes de error del scraping hablan de páginas, no de gente.

   En caso de duda, borrar: un error menos preciso se depura con el `install_id` y su traza; un
   dato personal enviado no se puede deshacer.
   ──────────────────────────────────────────────────────────────────────────── */
export function redactPersonal(text: string): string {
  return (
    text
      // Correos (incluye los jid de WhatsApp, 5190…@s.whatsapp.net).
      .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<correo>")
      // Id de una PERSONA dentro de una URL del aula.
      .replace(/((?:user\/(?:view|profile|editadvanced|edit)|profile)\.php\?[^\s"'<>]*?\bid=)\d+/gi, "$1<persona>")
      // Id de persona como parámetro suelto, en cualquier orden de la cadena.
      .replace(/\b(userid|user_id|unsauserid|moodle_user_id|senderpn|scanned_by)=\d+/gi, "$1=<persona>")
      // Documentos, teléfonos y demás números largos sueltos. No toca ids de curso ni cmid,
      // que en este Moodle son de 4 a 6 cifras.
      .replace(/(?<![\w?=&/-])\d{8,15}(?![\w-])/g, "<numero>")
  );
}

/** Saneado completo de un mensaje antes de salir del equipo. */
export function scrub(value: unknown, home?: string): string {
  const raw = typeof value === "string" ? value : String(value ?? "");
  return redactPersonal(redactSecrets(raw.slice(0, PRE_SCRUB_LIMIT), home)).slice(0, MAX_MESSAGE_LENGTH);
}
