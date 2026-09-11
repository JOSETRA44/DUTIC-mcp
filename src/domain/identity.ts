import { contextFor, currentContext, type SemesterContext } from "../core/context.js";
import { saveIdentity, type SemesterIdentity } from "../core/identity.js";
import { semesterFromUrl } from "../core/semester.js";
import type { Session } from "../core/session.js";
import { getMyProfile } from "./people.js";

/**
 * Observa quién es el usuario en el semestre de ESTA sesión y lo guarda.
 *
 * El semestre se toma de la URL de la sesión, no del contexto en curso: el aula a veces
 * redirige a otro período al iniciar sesión (`core/login.ts`), y guardar la identidad bajo el
 * semestre pedido la asociaría a un Moodle que no es el suyo.
 *
 * Una petición a `user/profile.php`. Se llama tras un login, no en cada comando.
 */
export async function observeIdentity(session: Session): Promise<SemesterIdentity | null> {
  const landed = semesterFromUrl(session.siteUrl);
  const ctx: SemesterContext = landed ? contextFor(landed, "session") : currentContext();

  const profile = await getMyProfile(session);
  if (!profile.userId) return null;

  const identity: SemesterIdentity = {
    moodleUserId: profile.userId,
    name: profile.name,
    email: profile.email,
    observedAt: Date.now(),
    sessionRef: session.ref ?? null,
  };
  await saveIdentity(identity, ctx);
  return identity;
}
