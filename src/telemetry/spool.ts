import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Cola en disco de eventos pendientes de enviar.
 *
 * Por qué en disco y no en memoria: la CLI vive segundos y el agente automático a veces
 * arranca sin red. Un evento se escribe al instante (una línea JSON, sin tocar la red) y
 * sale cuando haya ocasión — en este proceso, en el siguiente comando o en la próxima
 * pasada del agente. Nada bloquea al usuario esperando a un servidor.
 *
 * Varios procesos a la vez (el servidor MCP, un comando a mano, la tarea programada) sin
 * locks: cada proceso escribe SU archivo, y quien envía primero RENOMBRA el archivo para
 * reclamarlo. `rename` es atómico, así que dos procesos nunca envían el mismo lote; el que
 * pierde la carrera simplemente no lo encuentra. Si un proceso muere a mitad de envío, su
 * reclamo caduca y otro lo recoge.
 */

export const MAX_SPOOL_BYTES = 2 * 1024 * 1024;
const CLAIM_STALE_MS = 10 * 60 * 1000;

export interface ClaimedFile {
  path: string;
  lines: string[];
}

export class Spool {
  private readonly ownFile: string;

  constructor(
    private readonly dir: string,
    tag: string = `${process.pid}-${randomUUID().slice(0, 8)}`,
  ) {
    this.ownFile = join(dir, `spool-${tag}.jsonl`);
  }

  /** Añade un evento. Nunca lanza: sin disco no hay telemetría, pero el comando sigue. */
  append(event: unknown): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.ownFile, `${JSON.stringify(event)}\n`, "utf8");
    } catch {
      /* disco lleno o sin permisos */
    }
  }

  /** Reclama archivos pendientes (propios y ajenos) para enviarlos. */
  claim(maxFiles = 20, now = Date.now()): ClaimedFile[] {
    const claimed: ClaimedFile[] = [];
    for (const name of this.list()) {
      if (claimed.length >= maxFiles) break;
      const path = join(this.dir, name);
      const pending = name.endsWith(".jsonl");
      const abandoned = name.endsWith(".sending") && this.olderThan(path, CLAIM_STALE_MS, now);
      if (!pending && !abandoned) continue;

      const target = join(this.dir, `${name.split(".")[0]}.${randomUUID().slice(0, 8)}.sending`);
      try {
        renameSync(path, target);
      } catch {
        continue; // otro proceso lo reclamó antes
      }
      try {
        claimed.push({ path: target, lines: readFileSync(target, "utf8").split("\n").filter(Boolean) });
      } catch {
        this.release({ path: target, lines: [] });
      }
    }
    return claimed;
  }

  /** Enviado: se borra. */
  ack(file: ClaimedFile): void {
    rmSync(file.path, { force: true });
  }

  /** No se pudo enviar: vuelve a la cola para otro intento. */
  release(file: ClaimedFile): void {
    try {
      renameSync(file.path, file.path.replace(/\.sending$/, ".jsonl"));
    } catch {
      /* ya no existe */
    }
  }

  /**
   * Tope de tamaño: si la cola crece sin poder enviarse (semanas sin red), se descartan los
   * archivos más viejos. Devuelve los bytes descartados, para dejar constancia del hueco.
   */
  enforceCap(maxBytes = MAX_SPOOL_BYTES): number {
    const files = this.list()
      .map((name) => {
        try {
          const stat = statSync(join(this.dir, name));
          return { path: join(this.dir, name), size: stat.size, mtime: stat.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((f): f is { path: string; size: number; mtime: number } => f !== null)
      .sort((a, b) => a.mtime - b.mtime);

    let total = files.reduce((sum, f) => sum + f.size, 0);
    let dropped = 0;
    for (const file of files) {
      if (total <= maxBytes) break;
      rmSync(file.path, { force: true });
      total -= file.size;
      dropped += file.size;
    }
    return dropped;
  }

  /** Cuánto hay pendiente, para `dutic telemetry status`. */
  stats(): { files: number; bytes: number } {
    let bytes = 0;
    const names = this.list();
    for (const name of names) {
      try {
        bytes += statSync(join(this.dir, name)).size;
      } catch {
        /* se envió mientras se contaba */
      }
    }
    return { files: names.length, bytes };
  }

  /** Borra todo lo pendiente (al apagar la telemetría: lo no enviado ya no debe salir). */
  clear(): void {
    for (const name of this.list()) rmSync(join(this.dir, name), { force: true });
  }

  private list(): string[] {
    try {
      return readdirSync(this.dir)
        .filter((name) => name.startsWith("spool-") && /\.(jsonl|sending)$/.test(name))
        .sort();
    } catch {
      return [];
    }
  }

  private olderThan(path: string, ms: number, now: number): boolean {
    try {
      return now - statSync(path).mtimeMs > ms;
    } catch {
      return false;
    }
  }
}
