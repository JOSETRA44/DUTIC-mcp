import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR } from "../core/config.js";
import type { Session } from "../core/session.js";
import { getAllTasks } from "./tasks.js";
import { getAllGrades } from "./grades.js";

/**
 * Detección de cambios ("vigilar"): toma una foto del estado académico (tareas + notas) y la
 * compara con la foto anterior para reportar QUÉ es nuevo o cambió — tareas nuevas u ocultas,
 * notas recién publicadas, cambios de estado de entrega o de fecha. Así el usuario ve de un
 * vistazo lo que apareció desde la última vez que revisó.
 */

const SNAPSHOT_FILE = join(DATA_DIR, "snapshot.json");

interface TaskSnap {
  name: string;
  courseName: string;
  dueDate: number | null;
  submission: string;
  hidden: boolean;
}
interface GradeSnap {
  courseName: string;
  item: string;
  grade: string | null;
}
export interface Snapshot {
  takenAt: number;
  tasks: Record<string, TaskSnap>;
  grades: Record<string, GradeSnap>;
}

/** Toma una foto del estado actual (barrido completo de tareas + notas de todos los cursos). */
export async function takeSnapshot(session: Session): Promise<Snapshot> {
  const [{ tasks }, grades] = await Promise.all([
    getAllTasks(session, { enrich: true }),
    getAllGrades(session),
  ]);

  const taskMap: Record<string, TaskSnap> = {};
  for (const t of tasks) {
    const key = t.cmid != null ? `cmid:${t.cmid}` : `n:${t.courseId}:${t.name}`;
    taskMap[key] = {
      name: t.name,
      courseName: t.courseName,
      dueDate: t.dueDate,
      submission: t.submission,
      hidden: t.hidden,
    };
  }

  const gradeMap: Record<string, GradeSnap> = {};
  for (const g of grades) {
    for (const item of g.items) {
      if (item.isTotal) continue;
      gradeMap[`${g.courseId}:${item.name}`] = {
        courseName: g.courseName,
        item: item.name,
        grade: item.grade,
      };
    }
  }

  return { takenAt: Date.now(), tasks: taskMap, grades: gradeMap };
}

export interface Changes {
  newTasks: TaskSnap[];
  submissionChanges: { task: TaskSnap; from: string; to: string }[];
  dueDateChanges: { task: TaskSnap; from: number | null; to: number | null }[];
  newGrades: GradeSnap[];
  gradeChanges: { grade: GradeSnap; from: string | null; to: string | null }[];
  hasChanges: boolean;
}

/** Compara dos fotos y devuelve lo nuevo/cambiado (de `prev` a `curr`). */
export function diffSnapshots(prev: Snapshot, curr: Snapshot): Changes {
  const newTasks: TaskSnap[] = [];
  const submissionChanges: Changes["submissionChanges"] = [];
  const dueDateChanges: Changes["dueDateChanges"] = [];

  for (const [key, t] of Object.entries(curr.tasks)) {
    const before = prev.tasks[key];
    if (!before) {
      newTasks.push(t);
      continue;
    }
    if (before.submission !== t.submission) {
      submissionChanges.push({ task: t, from: before.submission, to: t.submission });
    }
    if (before.dueDate !== t.dueDate) {
      dueDateChanges.push({ task: t, from: before.dueDate, to: t.dueDate });
    }
  }

  const newGrades: GradeSnap[] = [];
  const gradeChanges: Changes["gradeChanges"] = [];
  for (const [key, g] of Object.entries(curr.grades)) {
    const before = prev.grades[key];
    if ((!before || !before.grade) && g.grade) {
      newGrades.push(g);
    } else if (before && before.grade && g.grade && before.grade !== g.grade) {
      gradeChanges.push({ grade: g, from: before.grade, to: g.grade });
    }
  }

  const hasChanges =
    newTasks.length > 0 ||
    submissionChanges.length > 0 ||
    dueDateChanges.length > 0 ||
    newGrades.length > 0 ||
    gradeChanges.length > 0;

  return { newTasks, submissionChanges, dueDateChanges, newGrades, gradeChanges, hasChanges };
}

export async function loadSnapshot(): Promise<Snapshot | null> {
  try {
    return JSON.parse(await readFile(SNAPSHOT_FILE, "utf8")) as Snapshot;
  } catch {
    return null;
  }
}

export async function saveSnapshot(snap: Snapshot): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(SNAPSHOT_FILE, JSON.stringify(snap), "utf8");
}

export interface WatchResult {
  changes: Changes | null; // null en la primera ejecución (sólo se guarda línea base)
  previousAt: number | null;
  snapshot: Snapshot;
}

/**
 * Ejecuta el ciclo de vigilancia: toma la foto actual, la compara con la anterior y (salvo que
 * `save` sea false) actualiza la línea base. En la primera ejecución sólo guarda la base.
 */
export async function checkChanges(
  session: Session,
  opts: { save?: boolean } = {},
): Promise<WatchResult> {
  const { save = true } = opts;
  const prev = await loadSnapshot();
  const snapshot = await takeSnapshot(session);
  const changes = prev ? diffSnapshots(prev, snapshot) : null;
  if (save) await saveSnapshot(snapshot);
  return { changes, previousAt: prev?.takenAt ?? null, snapshot };
}
