# Hallazgos sobre el aula virtual (Moodle UNSA)

Notas de ingeniería inversa hechas contra `https://aulavirtual.unsa.edu.pe/2026B/` con la sesión
del propio usuario, sólo con peticiones de lectura salvo donde se indica. Sirven para no volver a
descubrir lo mismo y para saber qué se puede pedir sin inventar.

**Entorno medido:** Moodle 4.x, tema `learnr` (Boost Union), idioma `es`, `sessiontimeout` 28800 s.
Fecha de la medición: 2026-09-09. Semestre `2026B`.

---

## 1. Presencia en vivo — bloque «Usuarios en línea»

### Dónde vive

Sólo en el Dashboard, `/my/`. No hay endpoint AJAX ni servicio web que lo devuelva: Moodle lo
renderiza **en el servidor** al pedir la página. "Tiempo real" significa, entonces, "en el
instante en que se pidió `/my/`". Una consulta cuesta la página entera (~230 KB), lo que fija el
ritmo razonable de sondeo en decenas de segundos, no en uno.

### Qué contiene

```html
<section data-block="online_users" data-instance-id="39500">
  <div class="info">179 usuarios online (últimos 5 minutos)</div>
  <ul class="list">
    <li class="listentry"><div class="user">
      <a href=".../user/view.php?id=21157&course=1" title="3 segundos">ROSA YOLANDA CARPIO BARREDA</a>
    </div>…</li>
    …
    <li class="listentry"><div class="otherusers"><span>Otros usuarios (42)</span></div></li>
  </ul>
</section>
```

| Dato | De dónde sale |
|---|---|
| Total conectados | texto de `.info` |
| Ventana (5 min) | texto de `.info`; es config del sitio |
| Persona | `user/view.php?id=N` → id + nombre |
| Antigüedad de la señal | atributo `title` del enlace, con precisión de **segundos** |
| Anónimos | `.otherusers` → "Otros usuarios (N)" |
| Tu propia visibilidad | `#change-user-visibility[data-action]` — `hide` significa que ahora estás **visible** |

El nombre aparece en dos formas: con avatar de imagen va como texto suelto tras el `<img>`; sin
foto, Moodle pinta las iniciales en un `<span class="userinitials" title="NOMBRE COMPLETO">` y el
texto del enlace arrastraría las iniciales pegadas al nombre. Hay que leer el `title`.

### El límite que importa

Medido: **179 conectados, 8 nombrados, «Otros usuarios (42)»**. Es decir:

- El bloque toma como mucho **50** usuarios (8 + 42 en esa muestra).
- De esos 50 nombra sólo a los que **comparten curso contigo**; el resto se agrega como anónimos.
- `total` y la lista **no son la misma magnitud**. Decir "hay 8 personas conectadas" es falso, y
  que alguien no salga en la lista **no prueba que esté desconectado**.

Esto es una frontera de permisos del servidor, no una limitación del parser: no se puede ni se
debe rodear.

### Usos honestos

- «¿Está el profesor X conectado ahora?» antes de escribirle por mensajería.
- Ver la actividad de tus compañeros de curso alrededor de una entrega.
- Saber si tú mismo apareces visible para los demás.

Implementado en `src/domain/presence.ts`; CLI `dutic online [persona]`; MCP `dutic_online_users`.

---

## 2. Modo de edición y bloques del Dashboard

El Dashboard es una composición de bloques que el usuario elige. **Un bloque que no está puesto es
información que no llega**: por eso el modo de edición es relevante y no cosmético.

### Mecánica (verificada, incluidas las mutaciones)

| Acción | Petición |
|---|---|
| Conmutar edición | `POST /editmode.php` con `setmode=0\|1`, `sesskey`, `pageurl`, `context` |
| ¿Está activo? | `input[name=setmode]` lleva `checked` en `/my/` |
| Catálogo de añadibles | `GET /my/index.php?bui_addblock&sesskey=…` (con edición activa) |
| Añadir | `GET /my/index.php?sesskey=…&bui_addblock=<plugin>` |
| Quitar | `GET /my/index.php?bui_deleteid=<instancia>&sesskey=…&bui_confirm=1` |

El `sesskey` conviene leerlo del propio HTML (`M.cfg.sesskey`) y no del disco: el guardado puede
haber caducado. El `context` sale del formulario del interruptor.

Otras acciones que expone el mismo mecanismo, no implementadas: `bui_editid` (configurar),
`bui_hideid` (ocultar), `bui_moveid` + `bui_blockregion` (mover de región).

### Bloques puestos hoy

`recentlyaccesseditems`, `timeline`, `calendar_month`, `online_users`.

### Catálogo de añadibles (15)

| Plugin | Título | Qué aportaría |
|---|---|---|
| `completion_progress` | Estado de Finalización | barras de avance por curso ⚠️ |
| `calendar_upcoming` | Próximos eventos | próximas fechas del calendario |
| `news_items` | Avisos recientes | foro de novedades de tus cursos |
| `private_files` | Archivos privados | tu área de ficheros |
| `myoverview` | Vista general de curso | cursos por estado (en curso/futuros/pasados) |
| `starredcourses` | Cursos destacados | los que has marcado |
| `recentlyaccessedcourses` | Cursos accedidos recientemente | orden de uso reciente |
| `badges` | Insignias recientes | insignias obtenidas |
| `myprofile` | Usuario identificado | tu ficha |
| `mentees` | Aprendices (Mentees) | sólo si tutorizas a alguien |
| `comments`, `tags`, `glossary_random`, `lp`, `html` | — | poco o nada que extraer |

⚠️ **`completion_progress` no se monta bien en este sitio**: la petición de alta devuelve una
página de error de ~1,3 KB y el bloque acaba descartado. `calendar_upcoming` y `badges` se añaden
y se quitan sin problema (probado y revertido). Por eso `addDashboardBlock` verifica releyendo el
estado en vez de fiarse de la respuesta.

Implementado en `src/domain/dashboard.ts`; CLI `dutic dashboard`; MCP `dutic_dashboard_*`.

---

## 3. Catálogo institucional: Escuelas, cursos y docentes

### El árbol de categorías

`GET /course/index.php` da la raíz, y cada `?categoryid=N` da sus hijas directas. La estructura
real tiene **cuatro niveles**, no tres:

```
raíz
├── "Categoría 1"        (id 1, sin uso académico)
└── "2026-B"             (id 2)   ← el período
    ├── BIOMÉDICAS       (id 3)   →  6 Escuelas
    ├── INGENIERÍAS      (id 4)   → 20 Escuelas
    └── SOCIALES         (id 5)   → 20 Escuelas
```

46 Escuelas en total (ids 6–52 en 2026-B). **Los ids son por semestre**: cada período es una
instalación de Moodle distinta, así que hay que descubrir el árbol dentro del período y nunca
codificarlo. Cuesta 6 peticiones y se cachea 24 h.

### El problema: la lista tiene los cursos, pero no los docentes

`GET /course/index.php?categoryid=41&browse=courses&perpage=500` devuelve la lista **autoritativa**
de los cursos de la Escuela… con las fichas colapsadas: sólo `data-courseid` y nombre.

`GET /course/search.php?search=…&perpage=500` devuelve las fichas **expandidas**, con
`<ul class="teachers">` (nombre + `user/profile.php?id=N`) y la categoría… pero la pertenencia es
difusa: busca por palabras y arrastra cursos de otras Escuelas.

**La solución es cruzarlas**: (1) fija el conjunto, (2) le pone los docentes, y la intersección por
`courseid` descarta los falsos positivos. Dos peticiones por Escuela en vez de una por curso.

### El detalle que lo hacía fallar

El término de búsqueda **no se puede deducir del nombre de la categoría**. El prefijo que la OTI
pone a los cursos es una abreviatura que a menudo no coincide:

| Categoría | Prefijo real de los cursos |
|---|---|
| ECONOMÍA | `26B ECONOMÍA:` ✅ |
| INGENIERÍA DE SISTEMAS | `26B SISTEMAS:` ❌ |
| LITERATURA Y LINGÜÍSTICA | `26B LINGÜÍSTICA:` ❌ |
| INGENIERÍA AGRONÓMICA | `26B AGRONÓMICA:` ❌ |

Buscar por el nombre de la categoría daba **0 % de cobertura** en SISTEMAS y 1 % en LINGÜÍSTICA.
La solución es no adivinar: extraer el prefijo dominante **de los nombres que ya devolvió el paso
(1)** y buscar por él.

### Cobertura medida

| Escuela | Cursos | Cubiertos por la búsqueda | Con docente |
|---|---|---|---|
| ECONOMÍA (41) | 129 | 129 (100 %) | 120 |
| DERECHO (39) | 201 | 201 (100 %) | 185 |
| INGENIERÍA DE SISTEMAS (20) | 114 | 114 (100 %) | 107 |
| LITERATURA Y LINGÜÍSTICA (46) | 93 | 93 (100 %) | 87 |

Tiempo: ~1,5 s por Escuela. Los que quedan sin docente no lo publican en la ficha; `--deep` abre
`course/info.php?id=N` uno a uno para intentarlo.

### Otros datos del mismo pozo

- **`perpage` no está topado** en la práctica: `perpage=2000` se sirve entero.
- `GET /course/search.php?search=26B&perpage=2000` anuncia **4906 cursos** en todo el semestre: es
  el censo completo del período, alcanzable en 3 páginas.
- `GET /course/info.php?id=N` da la ficha expandida de un curso suelto **sin estar matriculado**:
  nombre, docente e imagen.

Implementado en `src/domain/catalog.ts`; CLI `dutic escuela`; MCP `dutic_list_schools` y
`dutic_school_courses`.

---

## 4. Efectos colaterales en el código existente

- `parseCourseName` (`src/core/coursename.ts`) enumeraba las letras admitidas en el prefijo
  (`[A-Za-zÁÉÍÓÚÑ]+`) y **dejaba fuera la diéresis**: en `26B LINGÜÍSTICA: …` el prefijo no se
  reconocía y se quedaba pegado a la asignatura, contaminando la clave de comparación. Ahora el
  prefijo es "todo lo que hay entre el período y el primer `:`". Cubierto por
  `src/core/coursename.test.ts`.
- La caché del árbol lleva versión de forma en la clave (`["tree", "v1", siteUrl]`): si cambia el
  recorrido, subirla invalida lo viejo en vez de dejar un árbol incompatible que nadie detecta.

---

## 5. Qué NO se puede hacer (comprobado)

- Ver el **nombre** de los conectados con los que no compartes curso: el servidor no los envía.
- Pasar de 50 usuarios en el bloque de presencia: es el corte del propio bloque.
- Refrescar la presencia sin recargar `/my/`: no hay AJAX para ese bloque.
- Filtrar `course/search.php` por categoría: no acepta `categoryid`, de ahí el cruce del punto 3.
- Listar participantes de cursos ajenos: eso sí exige matrícula o permisos.
