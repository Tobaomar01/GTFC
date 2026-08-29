/**
 * Synchronisation hors-ligne.
 *
 * L'app Android accumule les opérations dans une base SQLite locale, puis
 * envoie un lot dès que le réseau revient. Trois exigences gouvernent ce
 * service :
 *
 *   1. IDEMPOTENCE — le réseau coupe souvent en pleine synchronisation.
 *      L'app renvoie alors le même lot. Il ne doit surtout pas être appliqué
 *      deux fois : l'identifiant de lot généré par le téléphone sert de clé.
 *
 *   2. TOLÉRANCE AUX PANNES — une opération invalide ne doit pas faire échouer
 *      les 40 autres. Chaque opération est traitée dans sa propre
 *      sous-transaction et rapporte son sort individuellement.
 *
 *   3. AUCUN ÉCRASEMENT SILENCIEUX — si la fiche a changé côté serveur depuis
 *      la dernière synchronisation, on marque un conflit et on le remonte à
 *      un superviseur. Le travail de personne n'est perdu.
 */
'use strict';

const { avecContexte } = require('../config/database');
const logger = require('../config/logger');
const commerceService = require('./commerce.service');
const qrService = require('./qr.service');

/** Champs d'un commerce sur lesquels un conflit est réellement significatif. */
const CHAMPS_SENSIBLES = [
  'enseigne', 'categorie_id', 'todp_surface_m2', 'enseigne_surface_m2',
  'surface_locale_m2', 'gerant_telephone', 'telephone_paiement', 'statut',
];

async function traiterCommerce(client, op, contexte) {
  const d = op.donnees;

  if (op.operation === 'creation') {
    // Le même enregistrement peut arriver deux fois si l'app a réémis le lot.
    // L'identifiant local du téléphone permet de le reconnaître.
    const { rows: deja } = await client.query(
      `SELECT entite_id FROM app.sync_operation
        WHERE identifiant_local = $1 AND entite = 'commerce'
          AND statut = 'traite' AND entite_id IS NOT NULL
        LIMIT 1`,
      [op.identifiant_local],
    );
    if (deja[0]) {
      return { statut: 'traite', entite_id: deja[0].entite_id, message: 'déjà enregistré' };
    }

    const territoire = await commerceService.resoudreTerritoire(client, {
      communeId: contexte.communeId,
      longitude: d.longitude,
      latitude: d.latitude,
      quartierId: d.quartier_id,
    });

    const { rows: code } = await client.query(
      'SELECT * FROM app.generer_code_commerce($1, $2)',
      [contexte.communeId, territoire.zoneId],
    );

    const { rows } = await client.query(`
      INSERT INTO app.commerce (
        commune_id, zone_id, quartier_id, categorie_id, code, numero_sequence,
        enseigne, activite_precise, gerant_nom, gerant_prenom, gerant_telephone,
        telephone_paiement, ninea, adresse_libelle, point_repere,
        geom, precision_gps_m, quartier_detecte_auto,
        surface_locale_m2, todp_surface_m2, enseigne_surface_m2,
        marche_id, type_emplacement_id, numero_emplacement,
        statut, date_recensement, agent_recenseur_id, notes, origine, cree_par
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11,
        $12, $13, $14, $15,
        app.point_gps($16, $17), $18, $19,
        $20, $21, $22,
        $23, $24, $25,
        COALESCE($26::app.statut_commerce, 'actif'),
        COALESCE($27::date, current_date), $28, $29, 'terrain', $28
      ) RETURNING id, code, version`,
    [
      contexte.communeId, territoire.zoneId, territoire.quartierId, d.categorie_id,
      code[0].code, code[0].numero_sequence,
      d.enseigne, d.activite_precise ?? null, d.gerant_nom ?? null, d.gerant_prenom ?? null,
      d.gerant_telephone ?? null, d.telephone_paiement ?? d.gerant_telephone ?? null,
      d.ninea ?? null, d.adresse_libelle ?? null, d.point_repere ?? null,
      d.longitude ?? null, d.latitude ?? null, d.precision_gps_m ?? null, territoire.detecteAuto,
      d.surface_locale_m2 ?? null, d.todp_surface_m2 ?? null, d.enseigne_surface_m2 ?? null,
      d.marche_id ?? null, d.type_emplacement_id ?? null, d.numero_emplacement ?? null,
      d.statut ?? null, d.date_recensement ?? null, contexte.utilisateurId, d.notes ?? null,
    ]);

    await commerceService.attacherTaxes(client, {
      communeId: contexte.communeId,
      commerceId: rows[0].id,
      categorieId: d.categorie_id,
      agentId: contexte.utilisateurId,
      taxesForcees: d.taxes ?? null,
      mesures: {
        todp_surface_m2: d.todp_surface_m2,
        enseigne_surface_m2: d.enseigne_surface_m2,
        nb_jours_marche: d.nb_jours_marche,
        marche_id: d.marche_id,
      },
    });

    // QR code, dans la MÊME transaction.
    // Sans cela, les commerces recensés hors ligne — c'est-à-dire la
    // majorité pendant la campagne — n'auraient pas de sticker imprimable.
    let qr = null;
    try {
      qr = await qrService.genererAvecClient(client, {
        commerceId: rows[0].id,
        utilisateurId: contexte.utilisateurId,
      });
    } catch (err) {
      // Non bloquant : la fiche prime sur son sticker, qui peut être
      // régénéré depuis le dashboard.
      logger.warn({ err: err.message, commerce: rows[0].code },
        'QR non généré lors de la synchronisation');
    }

    return {
      statut: 'traite',
      entite_id: rows[0].id,
      code: rows[0].code,
      version: rows[0].version,
      qr_jeton: qr?.jeton ?? null,
    };
  }

  // --- Modification ---------------------------------------------------------
  const { rows: actuel } = await client.query(
    'SELECT * FROM app.commerce WHERE id = $1 AND archive_le IS NULL', [op.entite_id],
  );
  if (!actuel[0]) {
    return { statut: 'rejete', message: 'Commerce introuvable ou archivé' };
  }

  if (op.version_client != null && Number(op.version_client) !== Number(actuel[0].version)) {
    // On ne déclare un conflit que si les champs qui comptent divergent
    // réellement. Un agent qui rouvre une fiche sans rien changer ne doit pas
    // générer une alerte à traiter par un superviseur.
    const divergents = CHAMPS_SENSIBLES.filter(
      (c) => d[c] !== undefined && String(d[c]) !== String(actuel[0][c]),
    );
    if (divergents.length > 0) {
      return {
        statut: 'conflit',
        version_serveur: Number(actuel[0].version),
        conflit_detail: {
          champs: divergents,
          client: Object.fromEntries(divergents.map((c) => [c, d[c]])),
          serveur: Object.fromEntries(divergents.map((c) => [c, actuel[0][c]])),
          modifie_le_serveur: actuel[0].modifie_le,
        },
        message: 'Fiche modifiée sur le serveur depuis la dernière synchronisation',
      };
    }
  }

  const maj = await commerceService.mettreAJour(
    { ...contexte }, op.entite_id, d, null,
  ).catch((err) => { throw err; });

  return { statut: 'traite', entite_id: op.entite_id, version: maj.version };
}

async function traiterVisite(client, op, contexte) {
  const d = op.donnees;
  const { rows } = await client.query(`
    INSERT INTO app.visite (
      commune_id, commerce_id, agent_id, resultat, commentaire,
      geom, precision_gps_m, quartier_id, debute_le, termine_le,
      hors_ligne, sync_lot_id, identifiant_local
    ) VALUES (
      $1, $2, $3, $4, $5,
      app.point_gps($6, $7), $8, $9, $10, $11,
      true, $12, $13
    ) RETURNING id`,
  [
    contexte.communeId, d.commerce_id ?? null, contexte.utilisateurId,
    d.resultat, d.commentaire ?? null,
    d.longitude ?? null, d.latitude ?? null, d.precision_gps_m ?? null,
    d.quartier_id ?? null, d.debute_le, d.termine_le ?? null,
    op.lot_id, op.identifiant_local,
  ]);
  return { statut: 'traite', entite_id: rows[0].id };
}

async function traiterPaiement(client, op, contexte) {
  const d = op.donnees;

  // Idempotence : la référence d'un encaissement est générée par le téléphone
  // et unique par commune. Un lot rejoué ne crée donc pas un double paiement.
  const { rows: deja } = await client.query(
    'SELECT id FROM app.paiement WHERE commune_id = $1 AND reference = $2',
    [contexte.communeId, d.reference],
  );
  if (deja[0]) return { statut: 'traite', entite_id: deja[0].id, message: 'déjà enregistré' };

  const { rows } = await client.query(`
    INSERT INTO app.paiement (
      commune_id, commerce_id, avis_id, reference, montant, moyen,
      paye_le, encaisse_par, geom, telephone_payeur, commentaire, cree_par
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, app.point_gps($9, $10), $11, $12, $8)
    RETURNING id`,
  [
    contexte.communeId, d.commerce_id, d.avis_id ?? null, d.reference,
    d.montant, d.moyen ?? 'wave', d.paye_le ?? new Date(),
    contexte.utilisateurId, d.longitude ?? null, d.latitude ?? null,
    d.telephone_payeur ?? null, d.commentaire ?? null,
  ]);
  return { statut: 'traite', entite_id: rows[0].id };
}

/**
 * Dispositif d'affichage recensé sur le terrain.
 *
 * Le rattachement au redevable est déduit du commerce quand l'agent recense
 * une enseigne sur une devanture (déclencheur trg_affichage_redevable). Pour
 * un panneau de régie, l'agent a désigné le redevable lui-même.
 *
 * Pas de détection de conflit par version : un dispositif recensé hors ligne
 * est toujours une création. Une modification passe par le dashboard, où la
 * connexion est acquise.
 */
async function traiterAffichage(client, op, contexte) {
  const d = op.donnees ?? {};

  // Rejeu d'un lot : la même opération locale ne doit pas créer un second
  // panneau. On s'appuie sur l'identifiant local, unique côté téléphone.
  const { rows: deja } = await client.query(
    `SELECT entite_id FROM app.sync_operation
      WHERE commune_id = $1 AND entite = 'affichage'
        AND identifiant_local = $2 AND statut = 'traite'
      LIMIT 1`, [contexte.communeId, op.identifiant_local]);
  if (deja[0]?.entite_id) {
    return { statut: 'traite', entite_id: deja[0].entite_id, message: 'Déjà enregistré' };
  }

  const { rows: [type] } = await client.query(
    'SELECT id, recensable, libelle FROM ref.type_affichage WHERE id = $1 AND commune_id = $2',
    [d.type_affichage_id, contexte.communeId]);
  if (!type) {
    const e = new Error("Type de dispositif inconnu"); e.attendue = true; throw e;
  }
  if (!type.recensable) {
    const e = new Error(`« ${type.libelle} » n'est pas recensable sur le terrain`);
    e.attendue = true; throw e;
  }

  const { rows: [g] } = await client.query(
    "SELECT * FROM app.generer_code_objet($1, 'A')", [contexte.communeId]);

  const { rows: [ligne] } = await client.query(`
    INSERT INTO app.dispositif_affichage (
      commune_id, redevable_id, commerce_id, type_affichage_id, code, numero_sequence,
      rue_id, quartier_id, zone_id, adresse_libelle,
      geom, precision_gps_m, surface_m2, largeur_m, hauteur_m, nb_faces,
      lumineux, texte_affiche, date_apposition, numero_autorisation, notes,
      agent_recenseur_id, origine, cree_par)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
            CASE WHEN $11::double precision IS NULL THEN NULL
                 ELSE ST_SetSRID(ST_MakePoint($11, $12), 4326) END,
            $13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,'terrain',$23)
    RETURNING id, code`,
  [contexte.communeId, d.redevable_id ?? null, d.commerce_id ?? null,
    d.type_affichage_id, g.code, g.numero_sequence,
    d.rue_id ?? null, d.quartier_id ?? null, d.zone_id ?? null, d.adresse_libelle ?? null,
    d.longitude ?? null, d.latitude ?? null, d.precision_gps_m ?? null,
    d.surface_m2, d.largeur_m ?? null, d.hauteur_m ?? null, d.nb_faces ?? 1,
    d.lumineux ?? false, d.texte_affiche ?? null, d.date_apposition ?? null,
    d.numero_autorisation ?? null, d.notes ?? null, contexte.utilisateurId]);

  return { statut: 'traite', entite_id: ligne.id, code: ligne.code };
}

/**
 * Chantier constaté sur le domaine public.
 * Recensement seul pendant le pilote : facturable reste faux.
 */
async function traiterChantier(client, op, contexte) {
  const d = op.donnees ?? {};

  const { rows: deja } = await client.query(
    `SELECT entite_id FROM app.sync_operation
      WHERE commune_id = $1 AND entite = 'chantier'
        AND identifiant_local = $2 AND statut = 'traite'
      LIMIT 1`, [contexte.communeId, op.identifiant_local]);
  if (deja[0]?.entite_id) {
    return { statut: 'traite', entite_id: deja[0].entite_id, message: 'Déjà enregistré' };
  }

  const { rows: [g] } = await client.query(
    "SELECT * FROM app.generer_code_objet($1, 'C')", [contexte.communeId]);

  const { rows: [ligne] } = await client.query(`
    INSERT INTO app.chantier (
      commune_id, redevable_id, code, numero_sequence, libelle,
      rue_id, quartier_id, zone_id, adresse_libelle,
      geom, surface_m2, duree_prevue_jours, date_fin_prevue,
      numero_autorisation, autorisation_vue, notes, agent_recenseur_id, cree_par)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
            CASE WHEN $10::double precision IS NULL THEN NULL
                 ELSE ST_SetSRID(ST_MakePoint($10, $11), 4326) END,
            $12,$13,$14,$15,$16,$17,$18,$18)
    RETURNING id, code`,
  [contexte.communeId, d.redevable_id, g.code, g.numero_sequence, d.libelle ?? null,
    d.rue_id ?? null, d.quartier_id ?? null, d.zone_id ?? null, d.adresse_libelle ?? null,
    d.longitude ?? null, d.latitude ?? null,
    d.surface_m2, d.duree_prevue_jours ?? null, d.date_fin_prevue ?? null,
    d.numero_autorisation ?? null, d.autorisation_vue ?? false, d.notes ?? null,
    contexte.utilisateurId]);

  for (const typeId of (d.types ?? [])) {
    await client.query(
      'INSERT INTO app.chantier_occupation (chantier_id, type_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [ligne.id, typeId]);
  }

  return { statut: 'traite', entite_id: ligne.id, code: ligne.code };
}

/*
 * Le suivi de position des agents a été retiré (FR-051a, FR-051b, SC-029).
 *
 * Géolocaliser des employés en continu relève de la loi 2008-12 : cela
 * exige une justification, une proportionnalité et l'information des
 * intéressés. Seules subsistent les positions rattachées à une fiche
 * recensée ou à une visite — celles-là situent une devanture, elles ne
 * surveillent personne.
 */

const AIGUILLAGE = {
  commerce: traiterCommerce,
  visite: traiterVisite,
  paiement: traiterPaiement,
  affichage: traiterAffichage,
  chantier: traiterChantier,
};

/**
 * Traite un lot complet.
 * Le lot lui-même est enregistré dans une première transaction (pour être
 * retrouvable même si tout échoue ensuite), puis chaque opération est traitée
 * indépendamment.
 */
async function traiterLot(contexte, lot) {
  // --- 1. Enregistrement du lot, ou récupération s'il est déjà connu -------
  const enTete = await avecContexte(contexte, async (client) => {
    const { rows } = await client.query(`
      INSERT INTO app.sync_lot (commune_id, agent_id, identifiant_client, appareil_id,
                                version_app, nb_operations, hors_ligne_depuis)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (agent_id, identifiant_client) DO UPDATE SET recu_le = app.sync_lot.recu_le
      RETURNING id, statut, nb_appliquees, nb_conflits, nb_rejetees, traite_le`,
    [contexte.communeId, contexte.utilisateurId, lot.identifiant_client,
      lot.appareil_id ?? null, lot.version_app ?? null,
      lot.operations.length, lot.hors_ligne_depuis ?? null]);
    return rows[0];
  });

  if (enTete.statut === 'traite' && enTete.traite_le) {
    // Lot déjà appliqué : on renvoie le résultat d'origine plutôt que de
    // rejouer. C'est la garantie d'idempotence côté réseau instable.
    const resultats = await avecContexte(contexte, async (client) => {
      const { rows } = await client.query(
        `SELECT ordre, identifiant_local, entite, entite_id, statut, message, conflit_detail
           FROM app.sync_operation WHERE lot_id = $1 ORDER BY ordre`, [enTete.id]);
      return rows;
    });
    return { lot_id: enTete.id, rejoue: true, resultats, resume: {
      appliquees: enTete.nb_appliquees,
      conflits: enTete.nb_conflits,
      rejetees: enTete.nb_rejetees,
    } };
  }

  // --- 2. Traitement opération par opération ------------------------------
  const debut = Date.now();
  const resultats = [];
  let appliquees = 0; let conflits = 0; let rejetees = 0;

  for (const [index, operation] of lot.operations.entries()) {
    const op = { ...operation, ordre: index + 1, lot_id: enTete.id };
    let resultat;

    try {
      const traiter = AIGUILLAGE[op.entite];
      if (!traiter) {
        resultat = { statut: 'rejete', message: `Entité non prise en charge : ${op.entite}` };
      } else {
        // Chaque opération dans sa propre transaction : une erreur n'annule
        // que la sienne, jamais les précédentes.
        resultat = await avecContexte(contexte, (client) => traiter(client, op, contexte));
      }
    } catch (err) {
      logger.warn(
        { err, lot: enTete.id, ordre: op.ordre, entite: op.entite, agent: contexte.utilisateurId },
        'Opération de synchronisation rejetée',
      );
      resultat = {
        statut: 'rejete',
        message: err.attendue ? err.message : 'Erreur lors du traitement de cette opération',
      };
    }

    if (resultat.statut === 'traite') appliquees += 1;
    else if (resultat.statut === 'conflit') conflits += 1;
    else rejetees += 1;

    await avecContexte(contexte, (client) => client.query(`
      INSERT INTO app.sync_operation (
        lot_id, commune_id, ordre, entite, operation, identifiant_local, entite_id,
        donnees, version_client, version_serveur, statut, message, conflit_detail,
        horodatage_client, traite_le
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())
      ON CONFLICT (lot_id, ordre) DO NOTHING`,
    [
      enTete.id, contexte.communeId, op.ordre, op.entite, op.operation,
      op.identifiant_local, resultat.entite_id ?? null,
      JSON.stringify(op.donnees), op.version_client ?? null,
      resultat.version_serveur ?? resultat.version ?? null,
      resultat.statut, resultat.message ?? null,
      resultat.conflit_detail ? JSON.stringify(resultat.conflit_detail) : null,
      op.horodatage_client ?? new Date(),
    ]));

    resultats.push({
      ordre: op.ordre,
      identifiant_local: op.identifiant_local,
      entite: op.entite,
      statut: resultat.statut,
      entite_id: resultat.entite_id ?? null,
      code: resultat.code ?? null,
      version: resultat.version ?? null,
      message: resultat.message ?? null,
      conflit: resultat.conflit_detail ?? null,
    });
  }

  // --- 3. Clôture du lot ---------------------------------------------------
  await avecContexte(contexte, (client) => client.query(`
    UPDATE app.sync_lot
       SET statut = $2, nb_appliquees = $3, nb_conflits = $4, nb_rejetees = $5,
           traite_le = now(), duree_ms = $6
     WHERE id = $1`,
  [enTete.id, conflits > 0 ? 'conflit' : 'traite', appliquees, conflits, rejetees,
    Date.now() - debut]));

  await avecContexte(contexte, (client) => client.query(
    'UPDATE app.utilisateur SET derniere_sync = now() WHERE id = $1', [contexte.utilisateurId],
  ));

  return {
    lot_id: enTete.id,
    rejoue: false,
    resume: { total: lot.operations.length, appliquees, conflits, rejetees },
    resultats,
  };
}

/**
 * Données à télécharger sur le téléphone pour travailler hors ligne :
 * référentiels complets et commerces de la zone de l'agent.
 */
async function paquetHorsLigne(contexte, { depuis = null, zoneId = null } = {}) {
  return avecContexte(contexte, async (client) => {
    const [categories, quartiers, zones, marches, emplacements, typesTaxes, parametres,
      rues, typesAffichage, typesChantier] =
      await Promise.all([
        client.query(`SELECT id, code, code_reference, libelle, icone, secteur,
                             todp_probable, enseigne_probable, sur_marche, ordre_affichage
                        FROM ref.categorie_commerce WHERE actif AND archive_le IS NULL
                       ORDER BY ordre_affichage`),
        client.query(`SELECT id, zone_id, code, nom, ST_X(centre) AS longitude,
                             ST_Y(centre) AS latitude
                        FROM app.quartier WHERE archive_le IS NULL ORDER BY code`),
        client.query('SELECT id, code, nom, couleur, ordre FROM app.zone WHERE archive_le IS NULL ORDER BY ordre'),
        client.query('SELECT id, code, nom, quartier_id FROM app.marche WHERE archive_le IS NULL'),
        client.query('SELECT id, code, libelle FROM ref.type_emplacement WHERE actif'),
        client.query(`SELECT id, code, libelle_court, conditionnelle, parametre_requis,
                             parametre_unite, ordre_affichage
                        FROM ref.type_taxe WHERE actif ORDER BY ordre_affichage`),
        client.query(`SELECT todp_surface_minimale_m2, todp_arrondi, rayon_tolerance_gps_m,
                             photo_devanture_obligatoire, photo_todp_obligatoire,
                             objectif_visites_jour_agent, encaissement_especes_autorise
                        FROM app.commune_parametre WHERE commune_id = $1`, [contexte.communeId]),
        // Les rues partent EN ENTIER, tracé compris.
        //
        // Le tracé était autrefois exclu, au motif qu'un MultiLineString pèse
        // lourd et que l'agent choisissait dans une liste. Depuis que le
        // recensement se fait sur une carte, il en a besoin : sans fond de
        // plan — hors ligne, ou tuiles pas encore générées — le dessin des
        // rues est ce qui lui permet de se repérer et de poser le point au
        // bon endroit.
        //
        // Le coût est mesuré, pas supposé : simplifié à 2 m, le réseau entier
        // de la commune pèse 22 ko, moins qu'une vignette de photo.
        client.query(`SELECT id, code, nom, quartier_id, zone_id, type_voie, variantes,
                             statut_couverture,
                             CASE WHEN geom IS NULL THEN NULL
                                  ELSE ST_AsGeoJSON(
                                         ST_SimplifyPreserveTopology(geom, 0.00002))
                             END AS trace
                        FROM app.rue
                       WHERE archive_le IS NULL AND actif
                       ORDER BY nom`),
        client.query(`SELECT id, code, libelle, paiement_avance, commerce_rare, ordre_affichage
                        FROM ref.type_affichage
                       WHERE actif AND recensable AND commune_id = $1
                       ORDER BY ordre_affichage`, [contexte.communeId]),
        client.query(`SELECT id, code, libelle, ordre_affichage
                        FROM ref.type_occupation_chantier
                       WHERE actif AND commune_id = $1
                       ORDER BY ordre_affichage`, [contexte.communeId]),
      ]);

    // Delta : seuls les commerces modifiés depuis la dernière synchronisation
    // sont renvoyés. Sur une connexion lente, c'est la différence entre
    // 5 443 fiches et une poignée.
    const params = [];
    let filtre = 'c.archive_le IS NULL';
    if (depuis) { params.push(depuis); filtre += ` AND c.modifie_le > $${params.length}`; }
    if (zoneId) { params.push(zoneId); filtre += ` AND c.zone_id = $${params.length}`; }

    const commerces = await client.query(`
      SELECT c.id, c.code, c.enseigne, c.categorie_id, c.zone_id, c.quartier_id,
             c.statut, c.statut_fiscal, c.solde_du, c.version,
             c.todp_surface_m2, c.enseigne_surface_m2, c.surface_locale_m2,
             c.gerant_nom, c.gerant_prenom, c.gerant_telephone, c.telephone_paiement,
             c.point_repere, ST_X(c.geom) AS longitude, ST_Y(c.geom) AS latitude,
             c.modifie_le, q.jeton AS qr_jeton
        FROM app.commerce c
        LEFT JOIN app.qr_code q ON q.commerce_id = c.id AND q.actif
       WHERE ${filtre}
       ORDER BY c.modifie_le DESC
       LIMIT 5000`, params);

    return {
      genere_le: new Date().toISOString(),
      delta_depuis: depuis,
      referentiels: {
        categories: categories.rows,
        zones: zones.rows,
        quartiers: quartiers.rows,
        marches: marches.rows,
        types_emplacement: emplacements.rows,
        types_taxes: typesTaxes.rows,
        rues: rues.rows,
        types_affichage: typesAffichage.rows,
        types_chantier: typesChantier.rows,
        parametres: parametres.rows[0] ?? null,
      },
      commerces: commerces.rows,
      nb_commerces: commerces.rowCount,
      tronque: commerces.rowCount >= 5000,
    };
  });
}

module.exports = { traiterLot, paquetHorsLigne };
