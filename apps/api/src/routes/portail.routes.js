/**
 * Portail du redevable — /portail
 *
 * Accessible depuis un navigateur, sur téléphone comme sur ordinateur. Rien
 * à installer : demander une application à 5 443 commerçants reviendrait à
 * n'en toucher aucun.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  CE QUE CE FICHIER PROTÈGE
 *
 *  1. L'ÉNUMÉRATION DES NUMÉROS. Demander un code pour un numéro inconnu
 *     renvoie exactement la même réponse que pour un numéro connu. Sinon
 *     l'API deviendrait un annuaire : « ce commerçant est-il enregistré ? »
 *     se lirait dans le code de statut.
 *
 *  2. LE JETON DE SESSION. Il ne transite jamais par le corps d'une réponse
 *     lisible en JavaScript : cookie httpOnly, SameSite strict. Une faille
 *     d'injection sur le portail ne permet donc pas de voler la session.
 *
 *  3. LE PÉRIMÈTRE DE LECTURE. Le redevable ne voit QUE son dossier. Chaque
 *     requête filtre sur l'identifiant issu de la session, jamais sur un
 *     identifiant fourni par le client.
 *
 *  LE QR CODE N'OUVRE RIEN ICI. Il est collé sur une devanture, accessible
 *  à tout passant. Le redevable accède à son dossier par ce portail
 *  authentifié, pas en scannant son propre autocollant.
 * ─────────────────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const { requete, requeteSysteme, CONTEXTE_SYSTEME } = require('../config/database');
const { limitePublic, limiteConnexion } = require('../middleware/limites');
const {
  z, valider, uuid, telephone,
} = require('../middleware/validation');
const { asyncHandler, ok, cree } = require('../utils/reponse');
const { erreurs } = require('../utils/erreurs');
const otp = require('../services/otp.service');
// Import direct : la création d'une contestation doit suivre exactement le même
// chemin depuis le portail et depuis le guichet — numérotation, calcul du délai
// et écriture au journal d'audit. Deux implémentations divergeraient.
const { creerContestation } = require('./contestations.routes');
const config = require('../config/env');
const logger = require('../config/logger');

const router = express.Router();
router.use(limitePublic);

const COOKIE = 'gtfc_portail';
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/, 'Commune invalide');

/**
 * Lecture du cookie de session.
 *
 * Écrite ici plutôt qu'en ajoutant `cookie-parser` : l'API n'a besoin de
 * lire qu'un seul cookie, dont le contenu est un jeton base64url. Une
 * dépendance de plus se met à jour, se casse, et s'audite — pour six lignes.
 * `res.cookie()` et `res.clearCookie()`, eux, sont natifs à Express.
 */
function lireCookie(req, nom) {
  const brut = req.headers.cookie;
  if (!brut) return null;
  for (const morceau of brut.split(';')) {
    const separateur = morceau.indexOf('=');
    if (separateur === -1) continue;
    if (morceau.slice(0, separateur).trim() === nom) {
      return decodeURIComponent(morceau.slice(separateur + 1).trim());
    }
  }
  return null;
}

/** Options du cookie de session. */
function optionsCookie(expire) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.production,
    path: '/portail',
    expires: expire,
  };
}

/**
 * Résout la commune par son sous-domaine, hors de toute session.
 *
 * Passe par app.public_commune_par_slug(), fonction SECURITY DEFINER : une
 * requête directe sur app.commune s'exécuterait sous le rôle applicatif SANS
 * contexte, et l'isolation par ligne renverrait zéro résultat. Le comportement
 * est voulu — sans commune déclarée, le rôle ne voit rien — mais il faut ici
 * une porte explicite, restreinte à quelques colonnes publiques.
 */
async function resoudreCommune(slugCommune) {
  const { rows } = await requeteSysteme(
    'SELECT id, nom, slug FROM app.public_commune_par_slug($1)', [slugCommune]);
  if (!rows[0]) throw erreurs.introuvable('Commune');
  return rows[0];
}

/**
 * Middleware de session.
 * Alimente `req.redevable` et `req.contexte` — ce dernier porte la commune,
 * ce qui rearme l'isolation par ligne côté PostgreSQL pour toute la suite.
 */
const exigerSession = asyncHandler(async (req, _res, next) => {
  const jeton = lireCookie(req, COOKIE);
  const session = await otp.lireSession(CONTEXTE_SYSTEME, jeton);

  if (!session) {
    throw erreurs.nonAuthentifie('Session expirée. Demandez un nouveau code d\'accès.');
  }

  req.contexte = { communeId: session.commune_id, ip: req.ip };
  req.redevableId = session.redevable_id;
  req.sessionExpire = session.expire_le;
  return next();
});

// ===========================================================================
//  1. DEMANDE DE CODE
// ===========================================================================
router.post('/code', limiteConnexion, valider(z.object({
  commune: slug,
  telephone,
}), 'body'), asyncHandler(async (req, res) => {
  const commune = await resoudreCommune(req.body.commune);
  const contexte = { communeId: commune.id, ip: req.ip };

  const { rows } = await requete(contexte,
    `SELECT id, statut_telephone FROM app.redevable
      WHERE commune_id = $1 AND telephone = $2 AND archive_le IS NULL`,
    [commune.id, req.body.telephone]);

  // ---- Réponse identique quoi qu'il arrive -----------------------------
  // Un numéro inconnu ne doit pas être distinguable d'un numéro connu :
  // sinon cette route devient un moyen de vérifier qui est enregistré.
  const reponse = {
    envoye: true,
    message: 'Si ce numéro est enregistré, un code vient de lui être envoyé.',
  };

  if (!rows[0]) {
    logger.info({ telephone: req.body.telephone, commune: commune.slug },
      'Portail : demande de code pour un numéro inconnu');
    return ok(res, reponse);
  }

  // Un numéro jamais vérifié n'a jamais prouvé qu'il appartenait bien au
  // redevable. Ouvrir une session dessus reviendrait à donner le dossier à
  // celui qui détient le numéro saisi par erreur.
  if (rows[0].statut_telephone !== 'verifie') {
    logger.warn({ redevable: rows[0].id }, 'Portail : numéro non vérifié');
    return ok(res, {
      ...reponse,
      // Message volontairement générique côté public ; le détail est au journal.
      note: 'Si vous ne recevez rien, présentez-vous à la mairie : votre numéro '
            + 'doit être confirmé par un agent avant le premier accès.',
    });
  }

  const envoi = await otp.emettre(contexte, {
    communeId: commune.id,
    telephone: req.body.telephone,
    usage: 'connexion',
    redevableId: rows[0].id,
    ip: req.ip,
  });

  return ok(res, {
    ...reponse,
    expire_le: envoi.expire_le,
    // Deuxième verrou. La configuration refuse déjà de démarrer en production
    // sans passerelle SMS ; si elle a été forcée malgré tout, le code ne doit
    // pas pour autant transiter dans la réponse — le lire suffirait à ouvrir
    // le dossier de n'importe quel commerçant dont on connaît le numéro.
    ...(envoi.code && !config.production ? {
      code_simule: envoi.code,
      avertissement: 'Aucun opérateur SMS raccordé : code affiché pour les essais uniquement.',
    } : {}),
  });
}));

// ===========================================================================
//  2. OUVERTURE DE SESSION
// ===========================================================================
router.post('/session', limiteConnexion, valider(z.object({
  commune: slug,
  telephone,
  code: z.string().trim().regex(/^[0-9]{4,8}$/, 'Code à 4 à 8 chiffres'),
}), 'body'), asyncHandler(async (req, res) => {
  const commune = await resoudreCommune(req.body.commune);
  const contexte = { communeId: commune.id, ip: req.ip };

  const { redevableId } = await otp.verifier(contexte, {
    communeId: commune.id,
    telephone: req.body.telephone,
    code: req.body.code,
    usage: 'connexion',
    ip: req.ip,
  });

  if (!redevableId) throw erreurs.nonAuthentifie('Code invalide ou expiré');

  const session = await otp.ouvrirSession(contexte, {
    communeId: commune.id,
    redevableId,
    ip: req.ip,
    navigateur: req.headers['user-agent'] ?? null,
  });

  await requete(contexte, `
    INSERT INTO audit.journal (commune_id, action, entite, entite_id, entite_libelle, motif)
    VALUES ($1,'acces_portail','redevable',$2,
            (SELECT code FROM app.redevable WHERE id = $2),'connexion')`,
  [commune.id, redevableId]);

  res.cookie(COOKIE, session.jeton, optionsCookie(session.expire_le));

  // Le jeton n'est PAS renvoyé dans le corps : il ne doit exister que dans
  // le cookie httpOnly, hors de portée du JavaScript de la page.
  return ok(res, {
    connecte: true,
    expire_le: session.expire_le,
    duree_heures: session.duree_heures,
    rappel: 'Session volontairement courte : les téléphones sont souvent prêtés.',
  });
}));

router.post('/deconnexion', asyncHandler(async (req, res) => {
  await otp.fermerSession(CONTEXTE_SYSTEME, lireCookie(req, COOKIE));
  res.clearCookie(COOKIE, { path: '/portail' });
  return ok(res, { deconnecte: true });
}));

// ===========================================================================
//  3. LE DOSSIER
// ===========================================================================
router.get('/dossier', exigerSession, asyncHandler(async (req, res) => {
  const { rows } = await requete(req.contexte, `
    SELECT r.code, r.designation, r.type_redevable, r.telephone,
           r.statut_fiscal, r.solde_du, r.nb_objets_taxables,
           q.nom AS quartier
      FROM app.redevable r
      LEFT JOIN app.quartier q ON q.id = r.quartier_id
     WHERE r.id = $1 AND r.archive_le IS NULL`, [req.redevableId]);
  if (!rows[0]) throw erreurs.introuvable('Dossier');

  const { rows: objets } = await requete(req.contexte, `
    SELECT objet_type, objet_code, objet_libelle, precision, statut
      FROM app.v_redevable_objets
     WHERE redevable_id = $1
     ORDER BY objet_type, objet_code`, [req.redevableId]);

  const { rows: avis } = await requete(req.contexte, `
    SELECT a.id, a.numero, p.code AS periode, a.statut,
           a.montant_total, a.montant_paye, a.montant_restant,
           a.date_exigibilite, a.date_emission
      FROM app.avis_imposition a
      JOIN app.periode_fiscale p ON p.id = a.periode_id
     WHERE a.redevable_id = $1 AND a.annule_le IS NULL
       -- Un brouillon n'a pas encore été notifié : l'afficher ferait croire
       -- à une dette que la mairie n'a pas encore arrêtée.
       AND a.statut <> 'brouillon'
     ORDER BY a.date_exigibilite DESC
     LIMIT 24`, [req.redevableId]);

  const prochaine = avis.find((a) => Number(a.montant_restant) > 0) ?? null;

  return ok(res, {
    redevable: rows[0],
    objets,
    avis,
    prochaine_echeance: prochaine
      ? { numero: prochaine.numero, montant: prochaine.montant_restant, date: prochaine.date_exigibilite }
      : null,
    session_expire_le: req.sessionExpire,
  });
}));

/** Détail d'un avis — lignes comprises, pour comprendre le montant. */
router.get('/avis/:id', exigerSession, valider(z.object({ id: uuid }), 'params'),
  asyncHandler(async (req, res) => {
    const { rows } = await requete(req.contexte, `
      SELECT a.id, a.numero, p.code AS periode, a.statut, a.montant_taxes,
             a.montant_penalite, a.montant_exonere, a.report_anterieur,
             a.montant_total, a.montant_paye, a.montant_restant,
             a.date_emission, a.date_exigibilite
        FROM app.avis_imposition a
        JOIN app.periode_fiscale p ON p.id = a.periode_id
       WHERE a.id = $1 AND a.redevable_id = $2
         AND a.annule_le IS NULL AND a.statut <> 'brouillon'`,
    [req.params.id, req.redevableId]);
    if (!rows[0]) throw erreurs.introuvable('Avis');

    const { rows: lignes } = await requete(req.contexte, `
      SELECT libelle, objet_type, objet_code, base_calcul, unite,
             montant_unitaire, montant_brut, montant_exonere, montant, detail_calcul
        FROM app.avis_ligne WHERE avis_id = $1 ORDER BY ordre`, [req.params.id]);

    return ok(res, { ...rows[0], lignes });
  }));

/** Quittances téléchargeables. */
router.get('/quittances', exigerSession, asyncHandler(async (req, res) => {
  const { rows } = await requete(req.contexte, `
    SELECT q.id, q.numero, q.genere_le AS emise_le,
           a.numero AS avis, pa.montant, pa.moyen, pa.paye_le
      FROM app.quittance q
      -- La quittance est rattachée au paiement ; l'avis vient du paiement.
      JOIN app.paiement pa            ON pa.id = q.paiement_id
      LEFT JOIN app.avis_imposition a ON a.id = pa.avis_id
     WHERE q.redevable_id = $1
     ORDER BY q.genere_le DESC
     LIMIT 50`, [req.redevableId]);
  return ok(res, rows);
}));

// ===========================================================================
//  4. CONTESTATION
// ===========================================================================
router.get('/motifs-contestation', exigerSession, asyncHandler(async (req, res) => {
  const { rows } = await requete(req.contexte, `
    SELECT id, code, libelle, piece_jointe_utile
      FROM ref.motif_contestation
     WHERE actif AND (commune_id = $1 OR commune_id IS NULL)
     ORDER BY ordre_affichage`, [req.contexte.communeId]);
  return ok(res, rows);
}));

router.post('/contestations', exigerSession, valider(z.object({
  motif_id: uuid,
  description: z.string().trim().min(10, 'Décrivez votre contestation').max(3000),
  avis_id: uuid.optional(),
}), 'body'), asyncHandler(async (req, res) => {
  // L'avis visé doit appartenir au redevable connecté. Sans ce contrôle, un
  // identifiant deviné permettrait de contester la facture d'un tiers — et
  // d'apprendre au passage qu'elle existe.
  if (req.body.avis_id) {
    const { rows } = await requete(req.contexte,
      'SELECT 1 FROM app.avis_imposition WHERE id = $1 AND redevable_id = $2',
      [req.body.avis_id, req.redevableId]);
    if (!rows[0]) throw erreurs.introuvable('Avis');
  }

  const ct = await creerContestation(req, {
    redevableId: req.redevableId,
    motif_id: req.body.motif_id,
    description: req.body.description,
    avis_id: req.body.avis_id ?? null,
    canal: 'portail',
  });

  return cree(res, {
    numero: ct.numero,
    statut: ct.statut,
    date_limite: ct.date_limite,
    message: 'Votre contestation est enregistrée. Le recouvrement se poursuit '
             + 'tant que la mairie n\'a pas statué.',
  });
}));

// ===========================================================================
//  5. CE QUE LE PORTAIL NE FAIT PAS
// ===========================================================================
router.all('/telephone', exigerSession, (_req, _res, next) => {
  next(erreurs.accesRefuse(
    'Le changement de numéro passe obligatoirement par un agent municipal. '
    + 'Le numéro est votre identifiant : le modifier en libre-service permettrait '
    + 'à quiconque emprunte votre téléphone de détourner votre dossier.',
  ));
});

module.exports = router;
