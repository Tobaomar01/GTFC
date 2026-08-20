/**
 * Contestations — /contestations
 *
 * Sans canal officiel, la contestation se règle oralement sur le trottoir :
 * rien n'est tracé, la mairie ignore combien de dossiers sont en litige, et
 * l'agent se retrouve à arbitrer seul. Le litige bloque alors la collecte sur
 * toute une rue.
 *
 * Trois étapes : soumission, instruction, résolution.
 *
 * UNE CONTESTATION NE SUSPEND PAS LE RECOUVREMENT PAR DÉFAUT.
 * La suspension est une décision explicite du superviseur, tracée. Si le
 * simple dépôt suffisait à suspendre, contester deviendrait le moyen le plus
 * simple de ne pas payer, et le canal officiel se retournerait contre la
 * commune qui l'a ouvert.
 */

'use strict';

const express = require('express');
const { requete, avecContexte } = require('../config/database');
const { authentifier, exigerRole, exigerCommune } = require('../middleware/auth');
const {
  z, valider, uuid, texteCourt, pagination, paramsId,
} = require('../middleware/validation');
const {
  asyncHandler, ok, cree, lirePagination, pagine,
} = require('../utils/reponse');
const { erreurs } = require('../utils/erreurs');

const router = express.Router();
router.use(['/contestations', '/motifs-contestation'], authentifier, exigerCommune);

router.get('/motifs-contestation', asyncHandler(async (req, res) => {
  const { rows } = await requete(req.contexte, `
    SELECT id, code, libelle, visite_recommandee, escalade_receveur, piece_jointe_utile
      FROM ref.motif_contestation
     WHERE actif AND (commune_id = $1 OR commune_id IS NULL)
     ORDER BY ordre_affichage`, [req.utilisateur.communeId]);
  return ok(res, rows);
}));

// ===========================================================================
//  FILE D'INSTRUCTION
// ===========================================================================
router.get('/contestations', valider(pagination.extend({
  statut: z.string().optional(),
  en_retard: z.enum(['oui']).optional(),
  redevable_id: uuid.optional(),
}), 'query'), asyncHandler(async (req, res) => {
  const { limite, decalage, page } = lirePagination(req.query);
  const filtres = [];
  const params = [];

  if (req.query.statut) {
    params.push(req.query.statut.split(','));
    filtres.push(`ct.statut = ANY($${params.length}::app.statut_contestation[])`);
  }
  if (req.query.redevable_id) {
    params.push(req.query.redevable_id);
    filtres.push(`ct.redevable_id = $${params.length}`);
  }
  if (req.query.en_retard === 'oui') {
    filtres.push(`ct.date_limite < current_date
                  AND ct.statut IN ('soumise','en_instruction','visite_demandee','transmise_receveur')`);
  }

  const where = filtres.length ? `WHERE ${filtres.join(' AND ')}` : '';
  params.push(limite, decalage);

  const { rows } = await requete(req.contexte, `
    SELECT ct.id, ct.numero, ct.statut, ct.canal, ct.cree_le, ct.date_limite,
           (ct.date_limite IS NOT NULL AND ct.date_limite < current_date
            AND ct.statut IN ('soumise','en_instruction','visite_demandee','transmise_receveur')) AS en_retard,
           ct.suspend_recouvrement, ct.description,
           m.libelle AS motif, m.visite_recommandee, m.escalade_receveur,
           r.id AS redevable_id, r.code AS redevable_code, r.designation AS redevable,
           a.numero AS avis, a.montant_total,
           u.nom_complet AS instructeur,
           (SELECT count(*)::int FROM app.contestation_piece p WHERE p.contestation_id = ct.id) AS nb_pieces,
           count(*) OVER () AS total_general
      FROM app.contestation ct
      JOIN ref.motif_contestation m ON m.id = ct.motif_id
      JOIN app.redevable r          ON r.id = ct.redevable_id
      LEFT JOIN app.avis_imposition a ON a.id = ct.avis_id
      LEFT JOIN app.utilisateur u   ON u.id = ct.instruite_par
     ${where}
     ORDER BY ct.date_limite NULLS LAST, ct.cree_le
     LIMIT $${params.length - 1} OFFSET $${params.length}`, params);

  const total = rows[0] ? Number(rows[0].total_general) : 0;
  return pagine(res, rows.map(({ total_general, ...r }) => r), { page, limite }, total);
}));

router.get('/contestations/:id', valider(paramsId, 'params'), asyncHandler(async (req, res) => {
  const { rows } = await requete(req.contexte, `
    SELECT ct.*, m.libelle AS motif, m.code AS motif_code,
           r.code AS redevable_code, r.designation AS redevable, r.telephone,
           a.numero AS avis, a.montant_total, a.montant_restant
      FROM app.contestation ct
      JOIN ref.motif_contestation m ON m.id = ct.motif_id
      JOIN app.redevable r          ON r.id = ct.redevable_id
      LEFT JOIN app.avis_imposition a ON a.id = ct.avis_id
     WHERE ct.id = $1`, [req.params.id]);
  if (!rows[0]) throw erreurs.introuvable('Contestation');

  const { rows: pieces } = await requete(req.contexte, `
    SELECT id, nom_fichier, type_mime, taille_octets, deposee_par_redevable, cree_le
      FROM app.contestation_piece WHERE contestation_id = $1 ORDER BY cree_le`, [req.params.id]);

  return ok(res, { ...rows[0], pieces });
}));

// ===========================================================================
//  SAISIE PAR UN AGENT, POUR LE COMPTE DU REDEVABLE
//
//  Tous les redevables n'ont pas un téléphone qui ouvre un navigateur : le
//  canal officiel doit rester accessible depuis le terrain et le guichet.
// ===========================================================================
router.post('/contestations', exigerRole('agent'), valider(z.object({
  redevable_id: uuid,
  motif_id: uuid,
  description: z.string().trim().min(10, 'Décrivez la contestation en quelques mots').max(3000),
  avis_id: uuid.optional(),
  objet_type: z.enum(['commerce', 'affichage', 'chantier']).optional(),
  objet_id: uuid.optional(),
  canal: z.enum(['agent', 'guichet']).default('guichet'),
}), 'body'), asyncHandler(async (req, res) => {
  const resultat = await creerContestation(req, {
    ...req.body, saisiePar: req.utilisateur.id,
  });
  return cree(res, resultat);
}));

/**
 * Création partagée avec le portail redevable.
 * Exportée pour que le portail n'ait pas à réécrire la numérotation, le
 * calcul du délai et l'entrée au journal d'audit — trois occasions de
 * diverger.
 */
async function creerContestation(req, {
  redevableId, redevable_id: redevableIdAlt, motif_id: motifId, description,
  avis_id: avisId = null, objet_type: objetType = null, objet_id: objetId = null,
  canal = 'portail', saisiePar = null,
}) {
  const cible = redevableId ?? redevableIdAlt;

  return avecContexte(req.contexte, async (client) => {
    const { rows: [param] } = await client.query(
      'SELECT contestation_delai_jours FROM app.commune_parametre WHERE commune_id = $1',
      [req.contexte.communeId]);
    const delai = param?.contestation_delai_jours ?? 30;

    const { rows: [num] } = await client.query(
      'SELECT app.generer_numero_contestation($1) AS numero', [req.contexte.communeId]);

    const { rows: [ct] } = await client.query(`
      INSERT INTO app.contestation (
        commune_id, redevable_id, motif_id, numero, avis_id, objet_type, objet_id,
        description, canal, saisie_par, date_limite)
      VALUES ($1,$2,$3,$4,$5,$6::app.type_objet_taxable,$7,$8,$9,$10,
              current_date + ($11 || ' days')::interval)
      RETURNING *`,
    [req.contexte.communeId, cible, motifId, num.numero, avisId,
      objetType, objetId, description, canal, saisiePar, delai]);

    await client.query(`
      INSERT INTO audit.journal (commune_id, utilisateur_id, action, entite, entite_id,
                                 entite_libelle, motif)
      VALUES ($1,$2,'contestation','contestation',$3,$4,'depot')`,
    [req.contexte.communeId, saisiePar, ct.id, ct.numero]);

    return ct;
  });
}

// ===========================================================================
//  INSTRUCTION
// ===========================================================================
router.post('/contestations/:id/instruire', exigerRole('superviseur'), valider(paramsId, 'params'),
  valider(z.object({
    statut: z.enum(['en_instruction', 'visite_demandee', 'transmise_receveur']),
    notes: z.string().trim().max(3000).optional(),
    suspend_recouvrement: z.coerce.boolean().optional(),
    motif_suspension: texteCourt(300).optional(),
  }).refine((v) => !v.suspend_recouvrement || Boolean(v.motif_suspension), {
    message: 'Suspendre le recouvrement exige un motif : la décision engage la commune.',
  }), 'body'), asyncHandler(async (req, res) => {
    const b = req.body;
    const { rows } = await requete(req.contexte, `
      UPDATE app.contestation
         SET statut = $2::app.statut_contestation,
             instruite_par = $3, instruite_le = coalesce(instruite_le, now()),
             notes_instruction = concat_ws(E'\\n', notes_instruction, $4),
             suspend_recouvrement = coalesce($5::boolean, suspend_recouvrement),
             suspendu_par = CASE WHEN $5::boolean THEN $3 ELSE suspendu_par END,
             modifie_le = now()
       WHERE id = $1 AND statut NOT IN ('acceptee','rejetee','retiree')
       RETURNING id, numero, statut, suspend_recouvrement, date_limite`,
    [req.params.id, b.statut, req.utilisateur.id,
      b.notes ?? (b.motif_suspension ? `Suspension : ${b.motif_suspension}` : null),
      b.suspend_recouvrement ?? null]);

    if (!rows[0]) {
      throw erreurs.conflit('Contestation introuvable ou déjà résolue');
    }
    return ok(res, rows[0]);
  }));

/**
 * Résolution. Acceptée ou rejetée, la décision est motivée — un rejet non
 * motivé est un rejet indéfendable, et le redevable reviendra au guichet.
 */
router.post('/contestations/:id/resoudre', exigerRole('superviseur'), valider(paramsId, 'params'),
  valider(z.object({
    decision: z.enum(['acceptee', 'rejetee']),
    motif_decision: z.string().trim().min(10, 'Motivez la décision').max(2000),
    correction_appliquee: z.record(z.any()).optional(),
  }), 'body'), asyncHandler(async (req, res) => {
    const { rows } = await requete(req.contexte, `
      UPDATE app.contestation
         SET statut = $2::app.statut_contestation,
             resolue_le = now(), resolue_par = $3,
             motif_decision = $4, correction_appliquee = $5::jsonb,
             -- La suspension tombe avec la décision : la laisser courir
             -- gèlerait la créance indéfiniment.
             suspend_recouvrement = false,
             modifie_le = now()
       WHERE id = $1 AND statut NOT IN ('acceptee','rejetee','retiree')
       RETURNING id, numero, statut, motif_decision, resolue_le, redevable_id`,
    [req.params.id, req.body.decision, req.utilisateur.id, req.body.motif_decision,
      req.body.correction_appliquee ? JSON.stringify(req.body.correction_appliquee) : null]);

    if (!rows[0]) throw erreurs.conflit('Contestation introuvable ou déjà résolue');

    return ok(res, {
      ...rows[0],
      rappel: 'Le redevable doit être informé de la décision, acceptée comme rejetée.',
    });
  }));

module.exports = router;
module.exports.creerContestation = creerContestation;
