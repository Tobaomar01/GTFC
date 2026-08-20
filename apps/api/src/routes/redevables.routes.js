/**
 * Redevables — /redevables
 *
 * Le redevable est l'entité facturée : c'est lui qui reçoit l'avis, le lien
 * Wave et la quittance. Un commerce, un panneau publicitaire ou un chantier
 * ne sont que ses objets taxables.
 *
 * LE NUMÉRO DE TÉLÉPHONE EST L'IDENTIFIANT
 * Un numéro, un redevable, tous ses objets dessous. Deux conséquences que ce
 * fichier fait respecter :
 *   · il se vérifie par code à usage unique, à la source, pendant le
 *     recensement — pas à l'échéance, quand il est trop tard ;
 *   · il ne se change jamais en libre-service, seulement par un agent, avec
 *     un motif et une trace au journal d'audit.
 */

'use strict';

const express = require('express');
const { requete, avecContexte } = require('../config/database');
const { authentifier, exigerRole, exigerCommune } = require('../middleware/auth');
const {
  z, valider, uuid, telephone, texteCourt, pagination, paramsId,
} = require('../middleware/validation');
const {
  asyncHandler, ok, cree, lirePagination, pagine,
} = require('../utils/reponse');
const { erreurs } = require('../utils/erreurs');
const otp = require('../services/otp.service');

const router = express.Router();
router.use(authentifier, exigerCommune);

// ---------------------------------------------------------------------------
// Schémas
// ---------------------------------------------------------------------------
const champsRedevable = z.object({
  type_redevable: z.enum(['personne_physique', 'personne_morale']).default('personne_physique'),
  nom: texteCourt(120).optional(),
  prenom: texteCourt(120).optional(),
  raison_sociale: texteCourt(200).optional(),
  telephone: telephone.optional(),
  telephone_secondaire: telephone.optional(),
  ninea: texteCourt(30).optional(),
  piece_type: z.enum(['CNI', 'passeport', 'permis', 'autre']).optional(),
  piece_numero: texteCourt(40).optional(),
  registre_commerce: texteCourt(40).optional(),
  quartier_id: uuid.optional(),
  rue_id: uuid.optional(),
  adresse_libelle: texteCourt(250).optional(),
  notes: z.string().trim().max(2000).optional(),
});

// .refine() produit un ZodEffects, qui ne connaît ni .partial() ni .omit().
// D'où deux schémas : l'objet nu pour dériver le schéma de modification, et
// la version affinée pour la création.
//
// La contrainte existe en base ; la répéter ici donne un message que l'agent
// comprend, au lieu d'une violation de CHECK remontée brute.
const corpsRedevable = champsRedevable.refine((v) => (v.type_redevable === 'personne_morale' ? Boolean(v.raison_sociale) : Boolean(v.nom)), {
    message: 'Une personne morale exige une raison sociale ; une personne physique, un nom.',
  });

// ===========================================================================
//  LISTE ET RECHERCHE
// ===========================================================================
router.get('/', valider(pagination.extend({
  statut_fiscal: z.enum(['a_jour', 'partiel', 'impaye', 'exonere', 'inconnu']).optional(),
  telephone_verifie: z.enum(['oui', 'non']).optional(),
  quartier_id: uuid.optional(),
}), 'query'), asyncHandler(async (req, res) => {
  const { limite, decalage, page } = lirePagination(req.query);
  const filtres = ['r.archive_le IS NULL'];
  const params = [];

  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    filtres.push(`(r.designation_normalisee LIKE app.normaliser($${params.length})
                   OR r.telephone LIKE $${params.length} OR r.code ILIKE $${params.length})`);
  }
  if (req.query.statut_fiscal) {
    params.push(req.query.statut_fiscal);
    filtres.push(`r.statut_fiscal = $${params.length}::app.statut_fiscal`);
  }
  if (req.query.telephone_verifie) {
    filtres.push(req.query.telephone_verifie === 'oui'
      ? "r.statut_telephone = 'verifie'" : "r.statut_telephone <> 'verifie'");
  }
  if (req.query.quartier_id) {
    params.push(req.query.quartier_id);
    filtres.push(`r.quartier_id = $${params.length}`);
  }

  const where = filtres.join(' AND ');
  params.push(limite, decalage);

  const { rows } = await requete(req.contexte, `
    SELECT r.id, r.code, r.designation, r.type_redevable, r.telephone,
           r.statut_telephone, r.statut_fiscal, r.solde_du, r.nb_objets_taxables,
           r.ninea, q.nom AS quartier, r.cree_le,
           count(*) OVER () AS total_general
      FROM app.redevable r
      LEFT JOIN app.quartier q ON q.id = r.quartier_id
     WHERE ${where}
     ORDER BY r.code
     LIMIT $${params.length - 1} OFFSET $${params.length}`, params);

  const total = rows[0] ? Number(rows[0].total_general) : 0;
  return ok(res, rows.map(({ total_general, ...r }) => r),
    { pagination: { page, limite, total, pages: Math.ceil(total / limite) } });
}));

// ===========================================================================
//  DOSSIER COMPLET
// ===========================================================================
router.get('/:id', valider(paramsId, 'params'), asyncHandler(async (req, res) => {
  const { rows } = await requete(req.contexte, `
    SELECT r.*, q.nom AS quartier, ru.nom AS rue
      FROM app.redevable r
      LEFT JOIN app.quartier q ON q.id = r.quartier_id
      LEFT JOIN app.rue ru ON ru.id = r.rue_id
     WHERE r.id = $1 AND r.archive_le IS NULL`, [req.params.id]);
  if (!rows[0]) throw erreurs.introuvable('Redevable');

  const { rows: objets } = await requete(req.contexte, `
    SELECT objet_type, objet_id, objet_code, objet_libelle, precision, statut
      FROM app.v_redevable_objets
     WHERE redevable_id = $1
     ORDER BY objet_type, objet_code`, [req.params.id]);

  const { rows: avis } = await requete(req.contexte, `
    SELECT a.id, a.numero, p.code AS periode, a.statut, a.montant_total,
           a.montant_paye, a.montant_restant, a.date_exigibilite
      FROM app.avis_imposition a
      JOIN app.periode_fiscale p ON p.id = a.periode_id
     WHERE a.redevable_id = $1 AND a.annule_le IS NULL
     ORDER BY a.date_exigibilite DESC
     LIMIT 24`, [req.params.id]);

  const { rows: contestations } = await requete(req.contexte, `
    SELECT c.id, c.numero, c.statut, m.libelle AS motif, c.cree_le
      FROM app.contestation c
      JOIN ref.motif_contestation m ON m.id = c.motif_id
     WHERE c.redevable_id = $1
     ORDER BY c.cree_le DESC
     LIMIT 20`, [req.params.id]);

  return ok(res, { ...rows[0], objets, avis, contestations });
}));

// ===========================================================================
//  CRÉATION ET MISE À JOUR
// ===========================================================================
router.post('/', exigerRole('agent'), valider(corpsRedevable), asyncHandler(async (req, res) => {
  const b = req.body;

  const resultat = await avecContexte(req.contexte, async (client) => {
    if (b.telephone) {
      const { rows: doublon } = await client.query(
        `SELECT id, code, designation FROM app.redevable
          WHERE commune_id = $1 AND telephone = $2 AND archive_le IS NULL`,
        [req.utilisateur.communeId, b.telephone]);
      if (doublon[0]) {
        // Ce n'est pas une erreur de saisie : c'est très probablement le même
        // redevable qui ouvre un second commerce. On le dit clairement plutôt
        // que de refuser sèchement.
        throw erreurs.conflit(
          `Ce numéro appartient déjà à ${doublon[0].code} — ${doublon[0].designation}. `
          + 'Rattachez le nouvel objet à ce redevable plutôt que d\'en créer un second.',
          { redevable_id: doublon[0].id },
        );
      }
    }

    const { rows: [g] } = await client.query(
      'SELECT * FROM app.generer_code_redevable($1)', [req.utilisateur.communeId]);

    const { rows: [r] } = await client.query(`
      INSERT INTO app.redevable (
        commune_id, code, numero_sequence, type_redevable,
        nom, prenom, raison_sociale, telephone, telephone_secondaire,
        ninea, piece_type, piece_numero, registre_commerce,
        quartier_id, rue_id, adresse_libelle, notes, origine, cree_par)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'dashboard',$18)
      RETURNING *`,
    [req.utilisateur.communeId, g.code, g.numero_sequence, b.type_redevable,
      b.nom ?? null, b.prenom ?? null, b.raison_sociale ?? null,
      b.telephone ?? null, b.telephone_secondaire ?? null,
      b.ninea ?? null, b.piece_type ?? null, b.piece_numero ?? null,
      b.registre_commerce ?? null, b.quartier_id ?? null, b.rue_id ?? null,
      b.adresse_libelle ?? null, b.notes ?? null, req.utilisateur.id]);

    return r;
  });

  return cree(res, resultat);
}));

router.patch('/:id', exigerRole('agent'), valider(paramsId, 'params'),
  valider(champsRedevable.partial(), 'body'), asyncHandler(async (req, res) => {
    // Le téléphone est exclu volontairement : il passe par /telephone,
    // qui exige un motif et laisse une trace.
    const { telephone: _ignore, ...champs } = req.body;
    const colonnes = Object.keys(champs);
    if (colonnes.length === 0) throw erreurs.requeteInvalide('Aucun champ à modifier');

    const sets = colonnes.map((c, i) => `${c} = $${i + 2}`);
    const { rows } = await requete(req.contexte, `
      UPDATE app.redevable
         SET ${sets.join(', ')}, modifie_le = now(), modifie_par = $${colonnes.length + 2},
             version = version + 1
       WHERE id = $1 AND archive_le IS NULL
       RETURNING *`,
    [req.params.id, ...colonnes.map((c) => champs[c]), req.utilisateur.id]);

    if (!rows[0]) throw erreurs.introuvable('Redevable');
    return ok(res, rows[0]);
  }));

// ===========================================================================
//  VÉRIFICATION DU NUMÉRO — le cœur du dispositif
// ===========================================================================

/**
 * Envoie un code au redevable. L'agent est à côté de lui : il le lui fera
 * relire dans la foulée.
 */
router.post('/:id/telephone/code', exigerRole('agent'), valider(paramsId, 'params'),
  asyncHandler(async (req, res) => {
    const { rows } = await requete(req.contexte,
      'SELECT id, telephone, statut_telephone FROM app.redevable WHERE id = $1 AND archive_le IS NULL',
      [req.params.id]);
    const r = rows[0];
    if (!r) throw erreurs.introuvable('Redevable');
    if (!r.telephone) {
      throw erreurs.requeteInvalide(
        'Ce redevable n\'a pas de numéro. Saisissez-le avant de lancer la vérification.',
      );
    }

    const envoi = await otp.emettre(req.contexte, {
      communeId: req.utilisateur.communeId,
      telephone: r.telephone,
      usage: 'verification_terrain',
      redevableId: r.id,
      demandePar: req.utilisateur.id,
      ip: req.ip,
    });

    return ok(res, {
      envoye_a: r.telephone,
      expire_le: envoi.expire_le,
      tentatives_permises: envoi.tentatives_permises,
      simule: envoi.simule,
      ...(envoi.code ? {
        code_simule: envoi.code,
        avertissement: 'Aucun opérateur SMS raccordé : ce code est affiché pour les essais uniquement.',
      } : {}),
    });
  }));

/** L'agent saisit le code que le redevable vient de lui lire. */
router.post('/:id/telephone/verifier', exigerRole('agent'), valider(paramsId, 'params'),
  valider(z.object({ code: z.string().trim().regex(/^[0-9]{4,8}$/, 'Code à 4 à 8 chiffres') }), 'body'),
  asyncHandler(async (req, res) => {
    const { rows } = await requete(req.contexte,
      'SELECT id, telephone FROM app.redevable WHERE id = $1 AND archive_le IS NULL', [req.params.id]);
    if (!rows[0]) throw erreurs.introuvable('Redevable');

    await otp.verifier(req.contexte, {
      communeId: req.utilisateur.communeId,
      telephone: rows[0].telephone,
      code: req.body.code,
      usage: 'verification_terrain',
      ip: req.ip,
    });

    const { rows: [maj] } = await requete(req.contexte, `
      UPDATE app.redevable
         SET statut_telephone = 'verifie', telephone_verifie_le = now(),
             telephone_verifie_par = $2, modifie_le = now()
       WHERE id = $1
       RETURNING id, code, telephone, statut_telephone, telephone_verifie_le`,
    [req.params.id, req.utilisateur.id]);

    return ok(res, maj);
  }));

/**
 * Changement de numéro — réservé aux agents, motivé, tracé.
 *
 * Le portail ne propose pas cette opération : quelques minutes d'accès au
 * téléphone d'un redevable suffiraient sinon à rediriger définitivement son
 * dossier, ses liens de paiement et ses quittances.
 */
router.post('/:id/telephone', exigerRole('superviseur'), valider(paramsId, 'params'),
  valider(z.object({
    nouveau_telephone: telephone,
    motif: texteCourt(300),
  }), 'body'), asyncHandler(async (req, res) => {
    const resultat = await avecContexte(req.contexte, async (client) => {
      const { rows } = await client.query(
        'SELECT id, telephone FROM app.redevable WHERE id = $1 AND archive_le IS NULL',
        [req.params.id]);
      if (!rows[0]) throw erreurs.introuvable('Redevable');

      const { rows: pris } = await client.query(
        `SELECT code, designation FROM app.redevable
          WHERE commune_id = $1 AND telephone = $2 AND archive_le IS NULL AND id <> $3`,
        [req.utilisateur.communeId, req.body.nouveau_telephone, req.params.id]);
      if (pris[0]) {
        throw erreurs.conflit(
          `Ce numéro est déjà celui de ${pris[0].code} — ${pris[0].designation}.`,
        );
      }

      await client.query(`
        INSERT INTO app.changement_telephone (commune_id, redevable_id, ancien_telephone,
                                              nouveau_telephone, motif, effectue_par)
        VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.utilisateur.communeId, req.params.id, rows[0].telephone,
        req.body.nouveau_telephone, req.body.motif, req.utilisateur.id]);

      // Le nouveau numéro repart NON VÉRIFIÉ : la vérification portait sur
      // l'ancien. La reconduire d'office annulerait tout l'intérêt du contrôle.
      const { rows: [maj] } = await client.query(`
        UPDATE app.redevable
           SET telephone = $2, statut_telephone = 'non_verifie',
               telephone_verifie_le = NULL, telephone_verifie_par = NULL,
               modifie_le = now(), modifie_par = $3, version = version + 1
         WHERE id = $1
         RETURNING id, code, telephone, statut_telephone`,
      [req.params.id, req.body.nouveau_telephone, req.utilisateur.id]);

      // Les sessions ouvertes sur l'ancien numéro tombent immédiatement.
      await client.query(`
        UPDATE app.session_redevable
           SET revoque_le = now(), motif_revocation = 'changement de numéro'
         WHERE redevable_id = $1 AND revoque_le IS NULL`, [req.params.id]);

      return maj;
    });

    return ok(res, {
      ...resultat,
      rappel: 'Le nouveau numéro doit être vérifié : POST /redevables/:id/telephone/code',
    });
  }));

// ===========================================================================
//  FUSION — deux dossiers pour une même personne
// ===========================================================================
router.post('/:id/fusionner', exigerRole('admin_commune'), valider(paramsId, 'params'),
  valider(z.object({ absorbe_id: uuid, motif: texteCourt(300) }), 'body'),
  asyncHandler(async (req, res) => {
    if (req.params.id === req.body.absorbe_id) {
      throw erreurs.requeteInvalide('Un redevable ne peut pas se fusionner avec lui-même');
    }

    const resultat = await avecContexte(req.contexte, async (client) => {
      // Un dossier portant des avis non soldés ne se fait pas absorber : les
      // créances suivraient sans que personne ne l'ait décidé.
      const { rows: [reste] } = await client.query(`
        SELECT coalesce(sum(montant_restant), 0)::numeric AS du
          FROM app.avis_imposition
         WHERE redevable_id = $1 AND annule_le IS NULL
           AND statut IN ('emis', 'partiellement_paye')`, [req.body.absorbe_id]);

      if (Number(reste.du) > 0) {
        throw erreurs.conflit(
          `Le dossier à absorber a ${reste.du} FCFA d'impayés. `
          + 'Soldez ou annulez ces avis avant la fusion — une créance ne change pas '
          + 'de débiteur sans décision explicite.',
        );
      }

      await client.query('UPDATE app.commerce SET redevable_id = $1 WHERE redevable_id = $2',
        [req.params.id, req.body.absorbe_id]);
      await client.query('UPDATE app.dispositif_affichage SET redevable_id = $1 WHERE redevable_id = $2',
        [req.params.id, req.body.absorbe_id]);
      await client.query('UPDATE app.chantier SET redevable_id = $1 WHERE redevable_id = $2',
        [req.params.id, req.body.absorbe_id]);
      await client.query('UPDATE app.contestation SET redevable_id = $1 WHERE redevable_id = $2',
        [req.params.id, req.body.absorbe_id]);

      const { rows: [absorbe] } = await client.query(`
        UPDATE app.redevable
           SET archive_le = now(), archive_par = $3,
               motif_archivage = 'Fusionné dans le dossier conservé — ' || $2
         WHERE id = $1 RETURNING code`,
      [req.body.absorbe_id, req.body.motif, req.utilisateur.id]);

      await client.query('SELECT app.rafraichir_nb_objets($1)', [req.params.id]);

      const { rows: [garde] } = await client.query(
        'SELECT id, code, designation, nb_objets_taxables FROM app.redevable WHERE id = $1',
        [req.params.id]);
      return { conserve: garde, absorbe: absorbe?.code ?? null };
    });

    return ok(res, resultat);
  }));

module.exports = router;
