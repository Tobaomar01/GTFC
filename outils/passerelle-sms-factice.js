#!/usr/bin/env node
'use strict';
/**
 * Passerelle SMS factice, pour la répétition générale.
 *
 * Elle parle le protocole de la passerelle « générique » : un POST JSON
 * { to, from, text }. Elle accepte, journalise, et garde tout en mémoire pour
 * qu'on puisse vérifier CE QUI EST SORTI — c'est le point : sans passerelle,
 * le système bascule sur « à transmettre par l'agent » et n'éprouve rien du
 * chemin réel.
 *
 * Elle n'envoie évidemment aucun message. Aucun numéro réel n'est appelé.
 *
 *   node outils/passerelle-sms-factice.js [port]
 *
 * Puis :
 *   GET /_recus   ce qui a été reçu, en JSON
 *   POST /_vider  repartir de zéro
 */
const http = require('node:http');

const PORT = Number(process.argv[2] ?? 4555);
const recus = [];

const serveur = http.createServer((req, res) => {
  const repondre = (code, corps) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(corps));
  };

  if (req.method === 'GET' && req.url === '/_recus') {
    return repondre(200, { nb: recus.length, messages: recus });
  }
  if (req.method === 'POST' && req.url === '/_vider') {
    recus.length = 0;
    return repondre(200, { vide: true });
  }

  let brut = '';
  req.on('data', (c) => { brut += c; });
  req.on('end', () => {
    let corps = null;
    try { corps = JSON.parse(brut); } catch { /* non JSON */ }

    if (!corps?.to || !corps?.text) {
      // Un vrai agrégateur refuserait de même : mieux vaut que la répétition
      // le découvre ici qu'un opérateur en production.
      return repondre(400, { erreur: 'champs « to » et « text » requis' });
    }

    recus.push({ vers: corps.to, de: corps.from ?? null, texte: corps.text,
      longueur: corps.text.length, recu_le: new Date().toISOString() });
    console.log(`[SMS factice] → ${corps.to} (${corps.text.length} car.) : ${corps.text}`);
    return repondre(200, { id: `factice-${recus.length}`, statut: 'accepte' });
  });
});

serveur.listen(PORT, '127.0.0.1', () => {
  console.log(`[SMS factice] à l'écoute sur http://127.0.0.1:${PORT}`);
});
