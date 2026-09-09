import { strict as assert } from "node:assert";
import { test } from "node:test";
import { matchOnline, parseIdleSeconds, parseOnlineBlock } from "./presence.js";

/**
 * Fixture recortado del bloque real del Dashboard. Conserva a propósito las tres formas en que
 * el aula escribe una fila: con avatar de imagen, con iniciales (el nombre vive en el `title`
 * del span, no en el texto del enlace) y la fila propia, que en vez del enlace de mensaje trae
 * el control del ojo.
 */
const BLOQUE = `
<section id="inst39500" class="block_online_users block card mb-3" data-block="online_users" data-instance-id="39500">
  <div class="card-body p-3">
    <h3 class="h5 card-title">Usuarios en línea</h3>
    <div class="card-text content mt-3">
      <div class="info">179 usuarios online (últimos 5 minutos)</div>
      <ul class='list'>
        <li class="listentry"><div class="user"><a href="https://aulavirtual.unsa.edu.pe/2026B/user/view.php?id=21157&amp;course=1" title="3 segundos"><span class="userinitials size-30" title="ROSA YOLANDA CARPIO BARREDA" role="img">RC</span>ROSA YOLANDA CARPIO BARREDA</a></div><div class="message"><a href="https://aulavirtual.unsa.edu.pe/2026B/message/index.php?id=21157">msg</a></div></li>
        <li class="listentry"><div class="user"><a href="https://aulavirtual.unsa.edu.pe/2026B/user/view.php?id=4863&amp;course=1" title="2 minutos 5 segundos"><img src="x.png" class="userpicture" />CONSUELO VIRGINIA OROZA VILLEGAS</a></div></li>
        <li class="listentry"><div class="user"><a href="https://aulavirtual.unsa.edu.pe/2026B/user/view.php?id=12292&amp;course=1" title="ahora"><img src="y.png" class="userpicture" />JOSE GABRIEL HUANACO MUÑOZ</a></div><div class="uservisibility"><a data-action="hide" data-userid="12292" id="change-user-visibility" href="">ojo</a></div></li>
        <li class="listentry"><div class="otherusers"><span>Otros usuarios (42)</span></div></li>
      </ul>
    </div>
  </div>
</section>`;

const SITE = "https://aulavirtual.unsa.edu.pe/2026B";

test("separa el recuento global de los usuarios identificables", () => {
  const p = parseOnlineBlock(BLOQUE, SITE);
  assert.equal(p.blockPresent, true);
  // 179 conectados, pero el servidor sólo nombra a los que comparten curso conmigo. Confundir
  // ambas cifras sería decir "hay 3 personas conectadas en el aula", que es falso.
  assert.equal(p.total, 179);
  assert.equal(p.users.length, 3);
  assert.equal(p.hiddenCount, 42);
  assert.equal(p.windowMinutes, 5);
});

test("saca el nombre tanto del avatar de imagen como del de iniciales", () => {
  const p = parseOnlineBlock(BLOQUE, SITE);
  assert.equal(p.users[0].name, "ROSA YOLANDA CARPIO BARREDA");
  assert.equal(p.users[1].name, "CONSUELO VIRGINIA OROZA VILLEGAS");
  assert.equal(p.users[0].profileUrl, `${SITE}/user/profile.php?id=21157`);
});

test("reconoce quién soy yo y si los demás me ven", () => {
  const p = parseOnlineBlock(BLOQUE, SITE);
  assert.deepEqual(
    p.users.map((u) => u.isMe),
    [false, false, true],
  );
  // data-action="hide" es lo que HARÁ el botón, así que ahora mismo estoy visible.
  assert.equal(p.myVisibility, "visible");
});

test("convierte la antigüedad a segundos, incluida la del propio usuario", () => {
  assert.equal(parseIdleSeconds("3 segundos"), 3);
  assert.equal(parseIdleSeconds("2 minutos 5 segundos"), 125);
  assert.equal(parseIdleSeconds("1 hora"), 3600);
  // El aula escribe "ahora" en la fila propia: es cero, no "no se sabe".
  assert.equal(parseIdleSeconds("ahora"), 0);
  assert.equal(parseIdleSeconds("hace un rato"), null);
});

test("sin el bloque puesto, lo dice en vez de fingir que no hay nadie", () => {
  const p = parseOnlineBlock("<html><body><p>sin bloques</p></body></html>", SITE);
  assert.equal(p.blockPresent, false);
  assert.equal(p.total, null);
  assert.deepEqual(p.users, []);
});

test("busca personas por trozos del nombre en cualquier orden", () => {
  const p = parseOnlineBlock(BLOQUE, SITE);
  assert.equal(matchOnline(p, "carpio rosa")[0]?.id, 21157);
  // Escribir sin la ñ (o sin acentos) tiene que encontrar igual: nadie teclea "MUÑOZ" al buscar.
  assert.equal(matchOnline(p, "MUNOZ")[0]?.id, 12292);
  assert.equal(matchOnline(p, "muñoz")[0]?.id, 12292);
  assert.equal(matchOnline(p, "4863")[0]?.name, "CONSUELO VIRGINIA OROZA VILLEGAS");
  assert.deepEqual(matchOnline(p, "nadie"), []);
});
