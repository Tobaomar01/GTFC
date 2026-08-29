/**
 * Service des commerces.
 *
 * Enchaînement d'un enregistrement terrain, dans une seule transaction :
 *   1. détection du quartier à partir du GPS (PostGIS) ou saisie manuelle ;
 *   2. génération du code lisible GTFC-Z1-00042 (verrou par zone) ;
 *   3. création de la fiche ;
 *   4. rattachement des taxes dues d'après la catégorie et les mesures ;
 *   5. génération du QR code.
 *
 * Si l'une des étapes échoue, rien n'est enregistré : pas de commerce
 * orphelin sans taxe ni QR, situation impossible à rattraper sur le terrain.
 */
'use strict';

const { avecContexte, requete } = require('../config/database');
const { erreurs } = require('../utils/erreurs');

/** Colonnes exposées par l'API — pas de SELECT * vers l'extérieur. */
const CHAMPS_LISTE = `
  c.id, c.code, c.enseigne, c.activite_precise, c.statut, c.statut_fiscal,
  c.solde_du, c.todp_surface_m2, c.enseigne_surface_m2, c.surface_locale_m2,
  c.gerant_nom, c.gerant_prenom, c.gerant_telephone, c.telephone_paiement,
  c.adresse_libelle, c.point_repere, c.ninea, c.numero_patente,
  ST_X(c.geom) AS longitude, ST_Y(c.geom) AS latitude, c.precision_gps_m,
  c.quartier_detecte_auto, c.date_recensement, c.derniere_visite_le,
  c.nb_visites, c.version, c.origine, c.fiche_a_completer, c.cree_le, c.modifie_le,
  cat.id AS categorie_id, cat.libelle AS categorie,
  z.id AS zone_id, z.code AS zone_code, z.nom AS zone,
  q.id AS quartier_id, q.nom AS quartier`;

const JOINTURES = `
  FROM app.commerce c
  JOIN ref.categorie_commerce cat ON cat.id = c.categorie_id
  JOIN app.zone     z ON z.id = c.zone_id
  JOIN app.quartier q ON q.id = c.quartier_id`;

/**
 * Détermine zone et quartier.
 * L'ordre importe : on privilégie toujours le GPS, mais si aucun polygone
 * n'est renseigné — cas actuel tant que la mairie n'a pas fourni le fond de
 * carte — on retombe sur le quartier choisi par l'agent. On ne devine jamais.
 */
async function resoudreTerritoire(client, { communeId, longitude, latitude, quartierId }) {
  if (longitude != null && latitude != null) {
    const { rows } = await client.query(
      'SELECT * FROM app.detecter_quartier($1, $2, $3) LIMIT 1',
      [communeId, longitude, latitude],
    );
    if (rows[0]?.quartier_id) {
      return {
        quartierId: rows[0].quartier_id,
        zoneId: rows[0].zone_id,
        detecteAuto: true,
        methode: rows[0].methode,
      };
    }
  }

  if (!quartierId) {
    throw erreurs.requeteInvalide(
      'Impossible de déterminer le quartier depuis les coordonnées GPS. '
      + 'Sélectionnez le quartier manuellement.');
  }

  const { rows } = await client.query(
    `SELECT id, zone_id FROM app.quartier
      WHERE id = $1 AND commune_id = $2 AND archive_le IS NULL`,
    [quartierId, communeId],
  );
  if (!rows[0]) throw erreurs.requeteInvalide('Quartier inconnu pour cette commune');

  return { quartierId: rows[0].id, zoneId: rows[0].zone_id, detecteAuto: false, methode: 'manuel' };
}

/**
 * Rattache les taxes dues.
 *
 * Les taxes conditionnelles (TODP, enseignes, droit de place) ne sont
 * attachées que si la mesure correspondante existe : sans débordement mesuré,
 * pas de TODP. C'est ce qui évite de facturer un commerçant pour une
 * occupation qu'aucun agent n'a constatée.
 */
async function attacherTaxes(client, { communeId, commerceId, categorieId, mesures, agentId,
  taxesForcees = null }) {
  // Seules les taxes CONDITIONNELLES sont traitées ici. Les inconditionnelles
  // sont posées par un déclencheur à l'insertion du commerce (migration 0051),
  // qui les attache à TOUT commerce, y compris ceux dont la catégorie ne les
  // mentionne pas — un oubli de patente ne se voit pas, il se lit seulement
  // dans un total plus faible que prévu.
  //
  // Les insérer une seconde fois ici était sans effet : la contrainte
  // d'exclusion les rejetait et `ON CONFLICT DO NOTHING` avalait le rejet. La
  // date de début calculée ci-dessous était donc silencieusement perdue au
  // profit de celle du déclencheur. Mieux vaut ne pas prétendre les écrire.
  const { rows: types } = await client.query(
    `SELECT tt.id, tt.code, tt.conditionnelle, ct.obligatoire
       FROM ref.categorie_taxe ct
       JOIN ref.type_taxe tt ON tt.id = ct.type_taxe_id
      WHERE ct.categorie_id = $1
        AND tt.conditionnelle
      ORDER BY tt.ordre_affichage`,
    [categorieId],
  );

  const valeurPour = (code) => ({
    todp: mesures.todp_surface_m2,
    enseigne: mesures.enseigne_surface_m2,
    droit_place: mesures.nb_jours_marche,
  }[code] ?? null);

  const attachees = [];
  for (const t of types) {
    // L'agent peut restreindre explicitement la liste depuis l'application
    if (taxesForcees && !taxesForcees.includes(t.code)) continue;

    const valeur = valeurPour(t.code);
    if (t.conditionnelle && (valeur == null || Number(valeur) <= 0)) continue;
    if (t.code === 'droit_place' && !mesures.marche_id) continue;

    await client.query(
      `INSERT INTO app.commerce_taxe
         (commune_id, commerce_id, type_taxe_id, parametre_valeur,
          parametre_source, date_debut, actif, cree_par)
       VALUES ($1, $2, $3, $4, 'agent', date_trunc('month', current_date)::date, true, $5)
       ON CONFLICT DO NOTHING`,
      [communeId, commerceId, t.id, valeur, agentId],
    );
    attachees.push(t.code);
  }
  return attachees;
}

async function creer(contexte, donnees) {
  return avecContexte(contexte, async (client) => {
    const communeId = contexte.communeId;

    const { rows: cat } = await client.query(
      `SELECT id, libelle FROM ref.categorie_commerce
        WHERE id = $1 AND commune_id = $2 AND actif AND archive_le IS NULL`,
      [donnees.categorie_id, communeId],
    );
    if (!cat[0]) throw erreurs.requeteInvalide('Catégorie de commerce inconnue');

    // Point relevé hors du territoire : très probablement une inversion
    // latitude/longitude, ou un agent qui n'est pas là où il croit.
    if (donnees.longitude != null && donnees.latitude != null) {
      const { rows: dedans } = await client.query(
        'SELECT app.point_dans_commune($1, $2, $3) AS ok',
        [communeId, donnees.longitude, donnees.latitude],
      );
      if (!dedans[0].ok) {
        throw erreurs.requeteInvalide(
          'Les coordonnées relevées sont hors des limites de la commune. '
          + 'Vérifiez le signal GPS avant d\'enregistrer.');
      }
    }

    const territoire = await resoudreTerritoire(client, {
      communeId,
      longitude: donnees.longitude,
      latitude: donnees.latitude,
      quartierId: donnees.quartier_id,
    });

    const { rows: code } = await client.query(
      'SELECT * FROM app.generer_code_commerce($1, $2)', [communeId, territoire.zoneId],
    );

    const { rows: cree } = await client.query(`
      INSERT INTO app.commerce (
        commune_id, zone_id, quartier_id, categorie_id, code, numero_sequence,
        enseigne, activite_precise,
        gerant_nom, gerant_prenom, gerant_telephone, telephone_paiement,
        gerant_piece_type, gerant_piece_numero, ninea, numero_patente,
        adresse_libelle, point_repere, geom, precision_gps_m, quartier_detecte_auto,
        surface_locale_m2, todp_surface_m2, enseigne_surface_m2, enseigne_lumineuse,
        marche_id, type_emplacement_id, numero_emplacement,
        statut, date_recensement, agent_recenseur_id, notes, origine, cree_par
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8,
        $9, $10, $11, $12,
        $13, $14, $15, $16,
        $17, $18, app.point_gps($19, $20), $21, $22,
        $23, $24, $25, $26,
        $27, $28, $29,
        'actif', COALESCE($30, current_date), $31, $32, $33, $31
      ) RETURNING id, code, version, cree_le`,
    [
      communeId, territoire.zoneId, territoire.quartierId, donnees.categorie_id,
      code[0].code, code[0].numero_sequence,
      donnees.enseigne, donnees.activite_precise ?? null,
      donnees.gerant_nom ?? null, donnees.gerant_prenom ?? null,
      donnees.gerant_telephone ?? null,
      donnees.telephone_paiement ?? donnees.gerant_telephone ?? null,
      donnees.gerant_piece_type ?? null, donnees.gerant_piece_numero ?? null,
      donnees.ninea ?? null, donnees.numero_patente ?? null,
      donnees.adresse_libelle ?? null, donnees.point_repere ?? null,
      donnees.longitude ?? null, donnees.latitude ?? null,
      donnees.precision_gps_m ?? null, territoire.detecteAuto,
      donnees.surface_locale_m2 ?? null, donnees.todp_surface_m2 ?? null,
      donnees.enseigne_surface_m2 ?? null, donnees.enseigne_lumineuse ?? false,
      donnees.marche_id ?? null, donnees.type_emplacement_id ?? null,
      donnees.numero_emplacement ?? null,
      donnees.date_recensement ?? null, contexte.utilisateurId,
      donnees.notes ?? null, donnees.origine ?? 'terrain',
    ]);

    const commerceId = cree[0].id;

    const taxes = await attacherTaxes(client, {
      communeId,
      commerceId,
      categorieId: donnees.categorie_id,
      agentId: contexte.utilisateurId,
      taxesForcees: donnees.taxes ?? null,
      mesures: {
        todp_surface_m2: donnees.todp_surface_m2,
        enseigne_surface_m2: donnees.enseigne_surface_m2,
        nb_jours_marche: donnees.nb_jours_marche,
        marche_id: donnees.marche_id,
      },
    });

    // Visite de recensement : c'est elle qui prouve le passage de l'agent
    if (donnees.longitude != null && donnees.latitude != null) {
      await client.query(`
        INSERT INTO app.visite (commune_id, commerce_id, agent_id, resultat,
                                geom, precision_gps_m, quartier_id,
                                debute_le, termine_le, hors_ligne)
        VALUES ($1, $2, $3, 'enregistrement', app.point_gps($4, $5), $6, $7,
                COALESCE($8, now()), now(), $9)`,
      [communeId, commerceId, contexte.utilisateurId,
        donnees.longitude, donnees.latitude, donnees.precision_gps_m ?? null,
        territoire.quartierId, donnees.debute_le ?? null, donnees.hors_ligne ?? false]);
    }

    // On relit la version APRÈS les effets de bord : l'enregistrement de la
    // visite déclenche une mise à jour du commerce (compteur de passages), qui
    // incrémente le compteur de version. Renvoyer la valeur d'origine ferait
    // échouer la première modification envoyée par l'app avec un faux conflit.
    const { rows: apres } = await client.query(
      'SELECT version FROM app.commerce WHERE id = $1', [commerceId]);

    return {
      id: commerceId,
      code: cree[0].code,
      version: apres[0].version,
      quartier_detecte_auto: territoire.detecteAuto,
      methode_detection: territoire.methode,
      taxes_appliquees: taxes,
    };
  });
}

/**
 * Mise à jour avec détection de conflit.
 * `version` est le compteur incrémenté par la base à chaque modification.
 * Si le client travaille sur une version périmée, on refuse plutôt que
 * d'écraser en silence le travail d'un collègue.
 */
async function mettreAJour(contexte, id, donnees, versionAttendue = null) {
  return avecContexte(contexte, async (client) => {
    const { rows: actuel } = await client.query(
      'SELECT * FROM app.commerce WHERE id = $1 AND archive_le IS NULL', [id],
    );
    if (!actuel[0]) throw erreurs.introuvable('Commerce');

    if (versionAttendue != null && Number(versionAttendue) !== Number(actuel[0].version)) {
      throw erreurs.conflitSync({
        version_client: Number(versionAttendue),
        version_serveur: Number(actuel[0].version),
        modifie_le: actuel[0].modifie_le,
      });
    }

    const modifiables = [
      'enseigne', 'activite_precise', 'gerant_nom', 'gerant_prenom', 'gerant_telephone',
      'telephone_paiement', 'gerant_piece_type', 'gerant_piece_numero', 'ninea',
      'numero_patente', 'adresse_libelle', 'point_repere', 'surface_locale_m2',
      'todp_surface_m2', 'enseigne_surface_m2', 'enseigne_lumineuse', 'categorie_id',
      'marche_id', 'type_emplacement_id', 'numero_emplacement', 'statut', 'notes',
    ];

    const colonnes = [];
    const valeurs = [id, contexte.utilisateurId];
    for (const champ of modifiables) {
      if (donnees[champ] !== undefined) {
        valeurs.push(donnees[champ]);
        colonnes.push(`${champ} = $${valeurs.length}`);
      }
    }

    if (donnees.longitude !== undefined && donnees.latitude !== undefined) {
      valeurs.push(donnees.longitude, donnees.latitude);
      colonnes.push(`geom = app.point_gps($${valeurs.length - 1}, $${valeurs.length})`);
    }

    if (colonnes.length === 0) throw erreurs.requeteInvalide('Aucun champ à modifier');

    const { rows } = await client.query(
      `UPDATE app.commerce SET ${colonnes.join(', ')}, modifie_par = $2
        WHERE id = $1 RETURNING id, code, version, modifie_le`,
      valeurs,
    );

    // Le montant de la TODP dépend de la surface : si elle change, la valeur
    // portée par la taxe doit suivre, sinon le prochain avis sera faux.
    if (donnees.todp_surface_m2 !== undefined) {
      await client.query(`
        UPDATE app.commerce_taxe ct SET parametre_valeur = $2, parametre_source = 'agent'
          FROM ref.type_taxe tt
         WHERE tt.id = ct.type_taxe_id AND tt.code = 'todp'
           AND ct.commerce_id = $1 AND ct.actif`,
      [id, donnees.todp_surface_m2]);
    }
    if (donnees.enseigne_surface_m2 !== undefined) {
      await client.query(`
        UPDATE app.commerce_taxe ct SET parametre_valeur = $2, parametre_source = 'agent'
          FROM ref.type_taxe tt
         WHERE tt.id = ct.type_taxe_id AND tt.code = 'enseigne'
           AND ct.commerce_id = $1 AND ct.actif`,
      [id, donnees.enseigne_surface_m2]);
    }

    return rows[0];
  });
}

async function lister(contexte, filtres, { limite, decalage }, tri) {
  const conditions = ['c.archive_le IS NULL'];
  const params = [];
  const ajouter = (sql, valeur) => {
    params.push(valeur);
    conditions.push(sql.replace('$?', `$${params.length}`));
  };

  if (filtres.zone_id) ajouter('c.zone_id = $?', filtres.zone_id);
  if (filtres.quartier_id) ajouter('c.quartier_id = $?', filtres.quartier_id);
  if (filtres.categorie_id) ajouter('c.categorie_id = $?', filtres.categorie_id);
  if (filtres.statut) ajouter('c.statut = $?', filtres.statut);
  if (filtres.statut_fiscal) ajouter('c.statut_fiscal = $?', filtres.statut_fiscal);
  if (filtres.marche_id) ajouter('c.marche_id = $?', filtres.marche_id);
  if (filtres.agent_id) ajouter('c.agent_recenseur_id = $?', filtres.agent_id);
  if (filtres.avec_todp === true) conditions.push('c.todp_surface_m2 > 0');
  // Le second passage : les fiches recensées sans le gérant, à reprendre.
  // Filtre présent ou absent, jamais inversé : sur une chaîne de requête,
  // `z.coerce.boolean` rend vrai pour toute valeur non vide — « false »
  // compris. Un `a_completer=false` qui filtrerait l'inverse de ce qu'il dit
  // serait un piège ; on ne l'offre pas.
  if (filtres.a_completer === true) conditions.push('c.fiche_a_completer');
  if (filtres.sans_qr === true) {
    conditions.push('NOT EXISTS (SELECT 1 FROM app.qr_code q WHERE q.commerce_id = c.id AND q.actif)');
  }
  if (filtres.q) {
    // Recherche insensible aux accents et à la casse, sur l'enseigne ou le
    // code. Le même paramètre est référencé deux fois, d'où l'écriture
    // explicite plutôt que le helper `ajouter`.
    params.push(filtres.q);
    const i = params.length;
    conditions.push(
      `(c.enseigne_normalisee LIKE '%' || app.normaliser($${i}) || '%'`
      + ` OR c.code ILIKE '%' || $${i} || '%')`,
    );
  }

  const where = conditions.join(' AND ');
  const { rows: total } = await requete(contexte,
    `SELECT count(*)::int AS n ${JOINTURES} WHERE ${where}`, params);

  params.push(limite, decalage);
  const { rows } = await requete(contexte,
    `SELECT ${CHAMPS_LISTE} ${JOINTURES} WHERE ${where}
      ORDER BY ${tri} LIMIT $${params.length - 1} OFFSET $${params.length}`, params);

  return { lignes: rows, total: total[0].n };
}

async function detail(contexte, id) {
  const { rows } = await requete(contexte,
    `SELECT ${CHAMPS_LISTE}, c.gerant_piece_type, c.gerant_piece_numero,
            c.numero_registre_communal, c.notes, c.marche_id, c.numero_emplacement
       ${JOINTURES} WHERE c.id = $1 AND c.archive_le IS NULL`, [id]);
  if (!rows[0]) throw erreurs.introuvable('Commerce');

  const commerce = rows[0];

  const [taxes, photos, qr, avis] = await Promise.all([
    requete(contexte, `
      SELECT ct.id, tt.code, tt.libelle_court AS libelle, ct.parametre_valeur,
             tt.parametre_unite AS unite, ct.montant_force, ct.date_debut, ct.actif
        FROM app.commerce_taxe ct JOIN ref.type_taxe tt ON tt.id = ct.type_taxe_id
       WHERE ct.commerce_id = $1 AND ct.actif ORDER BY tt.ordre_affichage`, [id]),
    requete(contexte, `
      SELECT id, type, bucket, chemin, prise_le, taille_octets, sha256
        FROM app.commerce_photo WHERE commerce_id = $1 AND archive_le IS NULL
       ORDER BY prise_le DESC`, [id]),
    requete(contexte, `
      SELECT id, jeton, url, version, genere_le, imprime_le, pose_le, nb_scans
        FROM app.qr_code WHERE commerce_id = $1 AND actif`, [id]),
    requete(contexte, `
      SELECT a.id, a.numero, p.code AS periode, a.montant_total, a.montant_paye,
             a.montant_restant, a.statut, a.date_exigibilite
        FROM app.avis_imposition a JOIN app.periode_fiscale p ON p.id = a.periode_id
       WHERE a.commerce_id = $1 AND a.annule_le IS NULL
       ORDER BY p.date_debut DESC LIMIT 12`, [id]),
  ]);

  return {
    ...commerce,
    taxes: taxes.rows,
    photos: photos.rows,
    qr_code: qr.rows[0] ?? null,
    avis: avis.rows,
  };
}

async function archiver(contexte, id, motif) {
  const { rows } = await requete(contexte,
    `UPDATE app.commerce
        SET archive_le = now(), archive_par = $2, motif_archivage = $3, statut = 'archive'
      WHERE id = $1 AND archive_le IS NULL
      RETURNING id, code`,
    [id, contexte.utilisateurId, motif]);
  if (!rows[0]) throw erreurs.introuvable('Commerce actif');
  return rows[0];
}

module.exports = { creer, mettreAJour, lister, detail, archiver, resoudreTerritoire, attacherTaxes };
