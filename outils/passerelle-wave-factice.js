#!/usr/bin/env node
'use strict';
/**
 * Passerelle de paiement Wave factice, pour la répétition générale.
 *
 * Elle parle le protocole que le service appelle réellement : un POST sur
 * /v1/checkout/sessions, porteur d'un jeton, qui répond une session et son
 * lien de paiement.
 *
 * POURQUOI ELLE EXISTE
 * La répétition annonce en tête qu'elle « ne touche à aucun service
 * extérieur ». Elle le faisait pourtant : WAVE_ACTIF=true sans URL de repli,
 * la campagne partait vers api.wave.com — soixante et une fois. Injoignable,
 * elle échouait, et l'exercice se terminait sur cent vingt-deux erreurs
 * internes qui ne disaient rien du système, seulement de l'absence de réseau.
 *
 * Le mode simulation intégré (WAVE_SIMULER) ne convient pas ici : il court-
 * circuite justement l'appel HTTP, c'est-à-dire le morceau qu'on veut
 * éprouver. Une passerelle factice garde le chemin réel, sans sortir.
 *
 * Aucun paiement réel n'est déclenché.
 *
 *   node outils/passerelle-wave-factice.js [port]
 *
 * Puis :
 *   GET  /_sessions   ce qui a été demandé, en JSON
 *   POST /_vider      repartir de zéro
 */
const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.argv[2] ?? 4556);
const sessions = [];

const serveur = http.createServer((req, res) => {
  const repondre = (code, corps) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(corps));
  };

  if (req.method === 'GET' && req.url === '/_sessions') {
    return repondre(200, { nb: sessions.length, sessions });
  }
  if (req.method === 'POST' && req.url === '/_vider') {
    sessions.length = 0;
    return repondre(200, { vide: true });
  }

  if (req.method !== 'POST' || !req.url.startsWith('/v1/checkout/sessions')) {
    return repondre(404, { error: 'route inconnue' });
  }

  // Wave refuse une requête non authentifiée. La répétition doit s'en
  // apercevoir ici, et pas le jour de la mise en service.
  const jeton = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (!jeton) {
    return repondre(401, { error: 'jeton absent' });
  }

  let brut = '';
  req.on('data', (c) => { brut += c; });
  req.on('end', () => {
    let corps = null;
    try { corps = JSON.parse(brut); } catch { /* non JSON */ }

    if (!corps?.amount || !corps?.currency) {
      return repondre(400, { error: 'champs « amount » et « currency » requis' });
    }

    // L'idempotence est la raison d'être de cet en-tête : rejouer la même
    // requête doit rendre la MÊME session, jamais une seconde.
    const cle = req.headers['idempotency-key'] ?? null;
    const deja = cle && sessions.find((s) => s.cle_idempotence === cle);
    if (deja) {
      return repondre(200, { id: deja.id, wave_launch_url: deja.wave_launch_url });
    }

    const id = `cos-${crypto.randomBytes(10).toString('hex')}`;
    const lien = `http://127.0.0.1:${PORT}/c/${id}`;
    sessions.push({
      id,
      wave_launch_url: lien,
      montant: corps.amount,
      devise: corps.currency,
      reference: corps.client_reference ?? null,
      cle_idempotence: cle,
      demande_le: new Date().toISOString(),
    });
    console.log(`[Wave factice] session ${id} — ${corps.amount} ${corps.currency}`);
    return repondre(200, { id, wave_launch_url: lien, status: 'open' });
  });
});

serveur.listen(PORT, '127.0.0.1', () => {
  console.log(`[Wave factice] à l'écoute sur http://127.0.0.1:${PORT}`);
});
