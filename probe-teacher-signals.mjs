import { loadSession } from './dist/core/session.js';
import { fetchUnsa } from './dist/core/http.js';
import { getEnrolledCourses, getCourseState } from './dist/domain/courses.js';
import * as cheerio from 'cheerio';
const s = await loadSession();
const H={Cookie:`MoodleSession=${s.moodleSession}`,'User-Agent':'Mozilla/5.0 Chrome/124'};
const clean=t=>(t||'').replace(/\s+/g,' ').trim();

const courses = await getEnrolledCourses(s);
const c = courses[0];
console.log('curso de prueba:', c.id, c.fullname.slice(0,40));

// 1) course/view.php: ¿bloque de "personas"/contactos con nombre+link a perfil?
const cv = await fetchUnsa(`${s.siteUrl}/course/view.php?id=${c.id}`,{headers:H},45000);
const $cv=cheerio.load(await cv.text());
console.log('\n=== course/view.php ===');
$cv('a[href*="user/view.php"], a[href*="user/profile.php"]').each((_,a)=>{
  const href=$cv(a).attr('href')||''; const id=(href.match(/id=(\d+)/)||[])[1];
  const txt=clean($cv(a).text());
  if(txt && txt.length>3) console.log(`  link user id=${id} text="${txt.slice(0,40)}"`);
});
console.log('  .coursecontacts/.teachers block?', $cv('.coursecontacts, .teachers, .course-contacts').length);

// 2) foro de anuncios: buscar módulos "forum" en el estado del curso
const state = await getCourseState(s, c.id);
const forums = state.modules.filter(m=>m.module==='forum');
console.log('\nforos en el curso:', forums.length, forums.slice(0,3).map(f=>f.name));
if (forums[0]) {
  const fr = await fetchUnsa(forums[0].url,{headers:H},45000);
  const $f=cheerio.load(await fr.text());
  console.log('=== foro:', forums[0].name, '===');
  $f('a[href*="user/view.php"]').each((_,a)=>{
    const href=$f(a).attr('href')||''; const id=(href.match(/id=(\d+)/)||[])[1];
    const txt=clean($f(a).text());
    if(txt.length>3) console.log(`  autor id=${id} "${txt.slice(0,40)}"`);
  });
}
