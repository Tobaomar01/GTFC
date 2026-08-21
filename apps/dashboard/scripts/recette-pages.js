#!/usr/bin/env node
/**
 * Recette des pages du tableau de bord.
 *
 *   node scripts/recette-pages.js
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  POURQUOI CETTE RECETTE EXISTE
 *
 *  Les pages Redevables et Contestations ont été livrées avec une
 *  compilation réussie et un défaut grossier : `api.get('redevables')` au
 *  lieu de `api.get('/redevables')`. Le mandataire construisait
 *  `/api/proxyredevables`, qui n'existe pas, et la page n'affichait qu'un
 *  « Chargement impossible ».
 *
 *  Rien ne pouvait le voir : c'est une chaîne de caractères, donc la
 *  compilation passe, et aucun test ne l'exerçait. Il a fallu que quelqu'un
 *  ouvre la page.
 *
 *  Cette recette rejoue exactement ce que fait le navigateur : elle ouvre
 *  une session, puis appelle CHAQUE route que les pages consomment, à
 *  travers le mandataire — pas en direct sur l'API. Un chemin mal construit
 *  échoue ici, avant d'échouer devant un agent de la mairie.
 * ─────────────────────────────────────────────────────────────────────────
 */

'use strict';

const DASH = process.env.DASHBOARD_URL || 'http://127.0.0.1:3000';
const IDENTIFIANT = process.env.RECETTE_TEL || '+221700000002';
const MOT_DE_PASSE = process.env.RECETTE_MDP || 'GtfcDemo2026!';

let cookies = '';
let reussis = 0;
let echoues = 0;

const C = {
  ok: (t) => `\x1b[32m✓\x1b[0m ${t}`,
  ko: (t) => `\x1b[31m✗\x1b[0m ${t}`,
  gras: (t) => `\x1b[1m${t}\x1b[0m`,
  gris: (t) => `\x1b[90m${t}\x1b[0m`,
};

function verifier(libelle, condition, detail = '') {
  if (condition) { console.log(`  ${C.ok(libelle)}`); reussis += 1; } else {
    console.log(`  ${C.ko(libelle)}`);
    if (detail) console.log(`      ${C.gris(String(detail).slice(0, 180))}`);
    echoues += 1;
  }
}

async function appel(chemin, options = {}) {
  const r = await fetch(`${DASH}${chemin}`, {
    ...options,
    headers: { ...(options.headers ?? {}), ...(cookies ? { Cookie: cookies } : {}) },
    redirect: 'manual',
  });
  const brut = await r.text();
  let json = null;
  try { json = JSON.parse(brut); } catch { /* HTML */ }

  const pose = r.headers.getSetCookie?.() ?? [];
  if (pose.length > 0) {
    cookies = pose.map((c) => c.split(';')[0]).join('; ');
  }
  return { statut: r.status, json, brut, donnees: json?.donnees };
}

/** Appel passant par le mandataire, exactement comme le fait une page. */
const proxy = (route) => appel(`/api/proxy${route}`);

(async () => {
  console.log(`\n${C.gras('Recette — pages du tableau de bord')}   ${C.gris(DASH)}\n`);

  const co = await appel('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ telephone: IDENTIFIANT, mot_de_passe: MOT_DE_PASSE }),
  });
  if (co.statut !== 200) {
    console.log(`  ${C.ko(`connexion impossible (${co.statut})`)}`);
    console.log(`      ${C.gris(co.brut.slice(0, 200))}\n`);
    process.exit(1);
  }
  verifier('connexion au tableau de bord', true);

  // -------------------------------------------------------------------------
  // Les pages répondent
  // -------------------------------------------------------------------------
  console.log(`\n  ${C.gras('Les pages s\'ouvrent')}`);
  for (const page of ['/tableau-bord', '/redevables', '/contestations', '/commerces',
    '/recouvrement', '/carte', '/agents', '/audit']) {
    const r = await appel(page);
    verifier(`${page}`, r.statut === 200, `statut ${r.statut}`);
  }

  // -------------------------------------------------------------------------
  // Les données qu'elles consomment
  //
  // C'est ici que se voit un chemin mal construit : le mandataire répond 404
  // sur une route qui n'existe pas, et la page affiche « Chargement
  // impossible » sans qu'on sache pourquoi.
  // -------------------------------------------------------------------------
  console.log(`\n  ${C.gras('Les données que chaque page appelle')}`);

  const ROUTES = [
    ['Redevables — liste', '/redevables?limite=5'],
    ['Redevables — objets orphelins', '/objets-sans-redevable'],
    ['Contestations — file', '/contestations?limite=5'],
    ['Contestations — motifs', '/motifs-contestation'],
    ['Objets — dispositifs', '/affichages?limite=5'],
    ['Objets — chantiers', '/chantiers?limite=5'],
    ['Rues — couverture', '/rues/couverture'],
    ['Commerces', '/commerces?limite=5'],
    ['Recouvrement', '/stats/recouvrement'],
    ['Tableau de bord', '/stats/tableau-bord'],
  ];

  for (const [libelle, route] of ROUTES) {
    const r = await proxy(route);
    verifier(`${libelle}  ${C.gris(route)}`, r.statut === 200,
      `statut ${r.statut} — ${r.brut.slice(0, 120)}`);
  }

  // Une fiche de redevable, telle que l'ouvre le bouton « Ouvrir ».
  const liste = await proxy('/redevables?limite=1');
  const premier = liste.donnees?.[0];
  if (premier) {
    const fiche = await proxy(`/redevables/${premier.id}`);
    verifier('Redevables — fiche complète',
      fiche.statut === 200 && Array.isArray(fiche.donnees?.objets),
      `statut ${fiche.statut}`);
  }

  console.log(`\n  ${C.gras(`${reussis} réussi(s), ${echoues} échec(s)`)}\n`);
  process.exit(echoues > 0 ? 1 : 0);
})().catch((e) => {
  console.error(`\n  ${C.ko(e.message)}\n`);
  process.exit(1);
});
