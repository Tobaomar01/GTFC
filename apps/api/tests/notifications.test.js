'use strict';
/**
 * Le SMS mensuel — le seul canal par lequel l'argent rentre.
 *
 * Le dispositif n'a qu'un moyen de recouvrement : un message qui annonce la
 * somme due et porte le lien Wave. S'il ne part pas, rien ne rentre.
 *
 * Il ne partait pas. La passerelle refuse tout message contenant un montant —
 * règle posée pour empêcher une fuite de donnée fiscale — et les trois modèles
 * annoncent une somme. Chacun était donc rejeté.
 *
 * Rien ne s'en apercevait : sans passerelle raccordée, le canal bascule sur
 * « à transmettre par l'agent », qui n'appelle pas ce contrôle. Le défaut ne
 * se serait manifesté qu'au raccordement de l'opérateur, c'est-à-dire au
 * premier jour de collecte réelle.
 *
 * Ces tests tiennent ensemble deux choses qui avaient divergé sans bruit : ce
 * que les modèles écrivent, et ce que la passerelle accepte.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { un, fermer } = require('./aide');

const notif = require('../src/services/notification.service');
const sms = require('../src/services/sms.service');

test.after(fermer);

/** Variables plausibles, avec une enseigne réelle du registre. */
async function variables() {
  const c = await un(`
    SELECT enseigne FROM app.commerce
     WHERE archive_le IS NULL ORDER BY length(enseigne) DESC LIMIT 1`);
  return {
    commerce: c?.enseigne ?? 'Boutique Ndiaye',
    montant: '125 000',
    echeance: '15/09/2026',
    lien: 'https://pay.wave.com/c/AbCdEf123456',
    jours: 12,
    numero: 'QT-WAVE-ABCDEF0123456789',
  };
}

test('chaque modèle passe le contrôle de la passerelle', async () => {
  // Le cœur du défaut : les modèles et la passerelle avaient divergé, et rien
  // ne les tenait ensemble.
  const v = await variables();
  for (const [type, composer] of Object.entries(notif.modeles)) {
    const texte = notif.sansAccent(composer(v));
    assert.doesNotThrow(() => sms.verifierMessage(texte),
      `le modèle « ${type} » serait refusé par la passerelle`);
  }
});

test('le message annonce la somme et porte le lien', async () => {
  // Sans montant, l'avis n'apprend rien ; sans lien, il ne mène nulle part.
  const v = await variables();
  const texte = notif.sansAccent(notif.modeles.avis_emis(v));
  assert.match(texte, /125 000/, 'la somme due doit figurer');
  assert.match(texte, /pay\.wave\.com/, 'le lien de paiement doit figurer');
});

test('sans lien, le message dit où payer plutôt que de se taire', async () => {
  const v = await variables();
  const texte = notif.sansAccent(notif.modeles.avis_emis({ ...v, lien: null }));
  assert.match(texte, /agent|mairie/i,
    'un avis sans lien doit orienter le redevable, pas le laisser sans recours');
  assert.doesNotThrow(() => sms.verifierMessage(texte));
});

test('aucun identifiant interne ne sort', async () => {
  // Un identifiant technique n'apprend rien au destinataire et sert à qui
  // l'intercepte.
  assert.throws(() => sms.verifierMessage(
    'Mairie: dossier 3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071 a regler'),
  /identifiant interne/);
  assert.throws(() => sms.verifierMessage('Mairie: avis GTFC-2026-08-000123 impaye'),
    /numéro d'avis/);
});

test('les messages tiennent en un ou deux segments, enseigne la plus longue comprise', async () => {
  // Au-delà de 160 caractères le SMS est facturé double ; au-delà de 320 la
  // passerelle le refuse. On éprouve avec la plus longue enseigne du registre,
  // pas avec un exemple choisi.
  const v = await variables();
  for (const [type, composer] of Object.entries(notif.modeles)) {
    const texte = notif.sansAccent(composer(v));
    assert.ok(texte.length <= 320,
      `« ${type} » fait ${texte.length} caractères avec l'enseigne « ${v.commerce} » : refusé`);
  }
});

test('aucun accent ne subsiste : ils divisent par deux la place disponible', async () => {
  // Un « é » fait basculer le SMS en encodage 16 bits : 70 caractères au lieu
  // de 160. Le message est alors coupé, ou facturé triple.
  const v = await variables();
  for (const [type, composer] of Object.entries(notif.modeles)) {
    const texte = notif.sansAccent(composer(v));
    assert.doesNotMatch(texte, /[àâäéèêëîïôöùûüçÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ]/,
      `« ${type} » contient un accent`);
  }
});
