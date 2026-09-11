import { HOST } from "../core/config.js";
import { currentContext } from "../core/context.js";
import { loadIdentity } from "../core/identity.js";
import { identityGranted } from "./consent.js";

/**
 * Contexto que acompaña a cada evento: EN QUÉ aula y semestre, con QUÉ cuenta y en QUÉ sesión.
 *
 * Todo sale del contexto de semestre en curso (`core/context.ts`), que en el servidor MCP es
 * por llamada (AsyncLocalStorage): dos herramientas consultando 2025A y 2026B a la vez producen
 * eventos con realms distintos, sin pisarse.
 *
 * El id de Moodle viaja siempre, porque sin él dos alumnos en un mismo PC serían uno solo; el
 * servidor lo guarda como HMAC y sólo conserva el id en claro, el nombre y el correo si hay
 * consentimiento de identidad.
 */

export interface EventContext {
  realm?: { kind: string; host: string; instance: string };
  account?: { uid: string; name?: string; email?: string };
  sessionRef?: string;
}

export function semesterContext(): EventContext {
  try {
    const ctx = currentContext();
    const out: EventContext = { realm: { kind: "moodle", host: HOST, instance: ctx.id } };

    const identity = loadIdentity(ctx);
    if (identity) {
      out.account = identityGranted()
        ? { uid: String(identity.moodleUserId), name: identity.name, email: identity.email ?? undefined }
        : { uid: String(identity.moodleUserId) };
      if (identity.sessionRef) out.sessionRef = identity.sessionRef;
    }
    return out;
  } catch {
    // Un contexto irresoluble no debe impedir registrar el evento (que quizá sea justo ese error).
    return {};
  }
}
