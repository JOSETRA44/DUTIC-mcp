import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import { currentContext, type SemesterContext } from "./context.js";

/**
 * Quién es el usuario DENTRO de un semestre: `~/.dutic/semesters/<id>/identity.json`.
 *
 * La identidad no es global. Cada semestre es un Moodle distinto y la misma persona tiene un
 * id diferente en cada uno, así que guardar "el id del usuario" en un solo sitio mezclaría
 * períodos en cuanto alguien use dos. Vive junto a la sesión de su semestre: imposible de
 * confundir con la de otro, y la telemetría la lee sin gastar una petición al aula.
 *
 * Sólo almacenamiento. Quien la observa (una petición a `user/profile.php`) está en
 * `domain/identity.ts`, para que `core/` no dependa del scraping.
 */

const IdentitySchema = z.object({
  moodleUserId: z.number().int().positive(),
  name: z.string().min(1).max(200),
  email: z.string().max(200).nullable(),
  /** epoch ms de la observación. */
  observedAt: z.number(),
  /** `ref` de la sesión con la que se observó. */
  sessionRef: z.string().nullable(),
});

export type SemesterIdentity = z.infer<typeof IdentitySchema>;

/** Síncrona: se lee al construir cada evento y es un archivo de pocos bytes. */
export function loadIdentity(ctx: SemesterContext = currentContext()): SemesterIdentity | null {
  try {
    return IdentitySchema.parse(JSON.parse(readFileSync(ctx.paths.identity, "utf8")));
  } catch {
    return null;
  }
}

export async function saveIdentity(
  identity: SemesterIdentity,
  ctx: SemesterContext = currentContext(),
): Promise<void> {
  const valid = IdentitySchema.parse(identity);
  await mkdir(ctx.paths.dir, { recursive: true });
  await writeFile(ctx.paths.identity, JSON.stringify(valid, null, 2), { encoding: "utf8", mode: 0o600 });
}
