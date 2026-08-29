/**
 * Exports Excel et PDF.
 *
 * Ces exports sont produits par l'API, pas par le dashboard. Deux raisons :
 *   - l'isolation multi-communes est déjà garantie ici par les politiques RLS ;
 *     la refaire côté dashboard serait une seconde occasion de se tromper ;
 *   - chaque export est tracé dans audit.export (qui a extrait quoi, quand).
 *     Une liste de commerces avec les montants dus quitte le système : cela
 *     doit laisser une trace.
 *
 * Contrainte de volume : 5 443 commerces tiennent sans peine dans un fichier
 * Excel, mais on plafonne malgré tout — un export non borné sur une base
 * multi-communes finirait par saturer la mémoire du Mini PC.
 */
'use strict';

const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { requete } = require('../config/database');
const { erreurs } = require('../utils/erreurs');

const PLAFOND = 20000;
const VERT = '0B5D2B';
const VERT_HEX = '#0B5D2B';

const montantXof = (v) => Math.round(Number(v) || 0);

const dateFr = (d) => (d ? new Date(d).toLocaleDateString('fr-FR') : '');

function versBuffer(doc) {
  return new Promise((resolve, reject) => {
    const morceaux = [];
    doc.on('data', (c) => morceaux.push(c));
    doc.on('end', () => resolve(Buffer.concat(morceaux)));
    doc.on('error', reject);
    doc.end();
  });
}

// ---------------------------------------------------------------------------
// Mise en forme commune des classeurs
// ---------------------------------------------------------------------------
function preparerFeuille(feuille, colonnes) {
  feuille.columns = colonnes;

  const entete = feuille.getRow(1);
  entete.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  entete.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${VERT}` } };
  entete.alignment = { vertical: 'middle', horizontal: 'left' };
  entete.height = 22;

  // Fige la ligne d'en-tête : sur 5 443 lignes, sans cela on ne sait plus
  // quelle colonne on lit dès le premier défilement.
  feuille.views = [{ state: 'frozen', ySplit: 1 }];
  feuille.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: colonnes.length },
  };
}

function finaliserClasseur(classeur, { titre, commune, utilisateur }) {
  classeur.creator = 'Plateforme de collecte des taxes locales';
  classeur.lastModifiedBy = utilisateur ?? 'système';
  classeur.created = new Date();
  classeur.title = titre;
  classeur.company = commune;
  return classeur.xlsx.writeBuffer().then((b) => Buffer.from(b));
}

/** Trace l'export dans le journal d'audit. */
async function tracerExport(contexte, { format, entite, filtres, nbLignes }) {
  await requete(contexte, `
    INSERT INTO audit.export (commune_id, utilisateur_id, format, entite, filtres, nb_lignes, ip)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::inet)`,
  [contexte.communeId, contexte.utilisateurId, format, entite,
    JSON.stringify(filtres ?? {}), nbLignes, contexte.ip ?? null]);
}

// ===========================================================================
//  COMMERCES
// ===========================================================================
async function donneesCommerces(contexte, filtres = {}) {
  const conditions = ['c.archive_le IS NULL'];
  const params = [];

  for (const [champ, colonne] of [
    ['zone_id', 'c.zone_id'], ['quartier_id', 'c.quartier_id'],
    ['categorie_id', 'c.categorie_id'], ['statut_fiscal', 'c.statut_fiscal'],
    ['statut', 'c.statut'],
  ]) {
    if (filtres[champ]) {
      params.push(filtres[champ]);
      conditions.push(`${colonne} = $${params.length}`);
    }
  }
  params.push(PLAFOND);

  const { rows } = await requete(contexte, `
    SELECT c.code, c.enseigne, cat.libelle AS categorie,
           z.nom AS zone, q.nom AS quartier,
           c.gerant_prenom, c.gerant_nom, c.gerant_telephone, c.telephone_paiement,
           c.ninea, c.point_repere,
           c.surface_locale_m2, c.todp_surface_m2, c.enseigne_surface_m2,
           c.statut, c.statut_fiscal, c.solde_du,
           ST_Y(c.geom) AS latitude, ST_X(c.geom) AS longitude,
           c.date_recensement, u.nom_complet AS agent_recenseur,
           c.derniere_visite_le, c.nb_visites,
           (SELECT count(*) FROM app.commerce_photo p
             WHERE p.commerce_id = c.id AND p.archive_le IS NULL)::int AS nb_photos,
           (SELECT string_agg(tt.libelle_court, ', ' ORDER BY tt.ordre_affichage)
              FROM app.commerce_taxe ct JOIN ref.type_taxe tt ON tt.id = ct.type_taxe_id
             WHERE ct.commerce_id = c.id AND ct.actif) AS taxes,
           (SELECT jeton FROM app.qr_code k WHERE k.commerce_id = c.id AND k.actif) AS qr_jeton
      FROM app.commerce c
      JOIN ref.categorie_commerce cat ON cat.id = c.categorie_id
      JOIN app.zone z ON z.id = c.zone_id
      JOIN app.quartier q ON q.id = c.quartier_id
      LEFT JOIN app.utilisateur u ON u.id = c.agent_recenseur_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY z.ordre, q.code, c.code
     LIMIT $${params.length}`, params);

  return rows;
}

const LIBELLES_STATUT_FISCAL = {
  a_jour: 'À jour', partiel: 'Paiement partiel', impaye: 'Impayé',
  exonere: 'Exonéré', inconnu: 'Non facturé',
};

const LIBELLES_STATUT = {
  actif: 'Ouvert', ferme_temporaire: 'Fermé temporairement',
  ferme_definitif: 'Cessation', introuvable: 'Introuvable', archive: 'Archivé',
};

async function commercesExcel(contexte, filtres = {}) {
  const lignes = await donneesCommerces(contexte, filtres);
  const classeur = new ExcelJS.Workbook();
  const feuille = classeur.addWorksheet('Commerces');

  preparerFeuille(feuille, [
    { header: 'Code', key: 'code', width: 16 },
    { header: 'Enseigne', key: 'enseigne', width: 32 },
    { header: 'Catégorie', key: 'categorie', width: 24 },
    { header: 'Zone', key: 'zone', width: 18 },
    { header: 'Quartier', key: 'quartier', width: 22 },
    { header: 'Gérant', key: 'gerant', width: 24 },
    { header: 'Téléphone', key: 'telephone', width: 16 },
    { header: 'NINEA', key: 'ninea', width: 14 },
    { header: 'Repère', key: 'repere', width: 28 },
    { header: 'Surface local (m²)', key: 'surface', width: 16 },
    { header: 'TODP (m²)', key: 'todp', width: 12 },
    { header: 'Taxes', key: 'taxes', width: 30 },
    { header: 'État', key: 'statut', width: 20 },
    { header: 'Situation fiscale', key: 'fiscal', width: 18 },
    { header: 'Reste dû', key: 'solde', width: 14 },
    { header: 'Recensé le', key: 'recensement', width: 13 },
    { header: 'Agent', key: 'agent', width: 24 },
    { header: 'Visites', key: 'visites', width: 9 },
    { header: 'Photos', key: 'photos', width: 9 },
    { header: 'Latitude', key: 'latitude', width: 12 },
    { header: 'Longitude', key: 'longitude', width: 12 },
  ]);

  for (const c of lignes) {
    feuille.addRow({
      code: c.code,
      enseigne: c.enseigne,
      categorie: c.categorie,
      zone: c.zone,
      quartier: c.quartier,
      gerant: [c.gerant_prenom, c.gerant_nom].filter(Boolean).join(' '),
      telephone: c.telephone_paiement ?? c.gerant_telephone ?? '',
      ninea: c.ninea ?? '',
      repere: c.point_repere ?? '',
      surface: c.surface_locale_m2 ?? null,
      todp: c.todp_surface_m2 ?? null,
      taxes: c.taxes ?? '',
      statut: LIBELLES_STATUT[c.statut] ?? c.statut,
      fiscal: LIBELLES_STATUT_FISCAL[c.statut_fiscal] ?? c.statut_fiscal,
      solde: montantXof(c.solde_du),
      recensement: dateFr(c.date_recensement),
      agent: c.agent_recenseur ?? '',
      visites: c.nb_visites,
      photos: c.nb_photos,
      latitude: c.latitude,
      longitude: c.longitude,
    });
  }

  feuille.getColumn('solde').numFmt = '# ##0 "F"';
  feuille.getColumn('latitude').numFmt = '0.000000';
  feuille.getColumn('longitude').numFmt = '0.000000';

  // Couleur de la situation fiscale : la même convention que la carte, pour
  // qu'un tableur et un écran racontent la même chose.
  const teintes = {
    'À jour': 'FFE7F3EB', 'Paiement partiel': 'FFFBF0DF',
    Impayé: 'FFFBEAE9', Exonéré: 'FFEFF1F0',
  };
  feuille.eachRow((ligne, numero) => {
    if (numero === 1) return;
    const teinte = teintes[ligne.getCell('fiscal').value];
    if (teinte) {
      ligne.getCell('fiscal').fill = {
        type: 'pattern', pattern: 'solid', fgColor: { argb: teinte },
      };
    }
  });

  await tracerExport(contexte, {
    format: 'excel', entite: 'commerce', filtres, nbLignes: lignes.length,
  });

  return {
    buffer: await finaliserClasseur(classeur, {
      titre: 'Registre des commerces',
      commune: contexte.communeNom,
      utilisateur: contexte.utilisateurNom,
    }),
    nbLignes: lignes.length,
    tronque: lignes.length >= PLAFOND,
  };
}

/**
 * Version PDF : liste de contrôle destinée aux agents.
 *
 * Format paysage, colonnes réduites au strict nécessaire — un agent qui part
 * en tournée avec une liste papier a besoin du code, du nom, du repère et du
 * montant dû, pas de vingt colonnes.
 */
async function commercesPdf(contexte, filtres = {}) {
  const lignes = await donneesCommerces(contexte, filtres);

  const { rows: cr } = await requete(contexte,
    'SELECT nom FROM app.commune WHERE id = $1', [contexte.communeId]);
  const commune = cr[0]?.nom ?? '';

  const doc = new PDFDocument({
    size: 'A4', layout: 'landscape', margin: 30,
    info: { Title: 'Liste des commerces', Author: commune },
  });

  const colonnes = [
    { titre: 'Code', cle: 'code', largeur: 78 },
    { titre: 'Enseigne', cle: 'enseigne', largeur: 150 },
    { titre: 'Catégorie', cle: 'categorie', largeur: 110 },
    { titre: 'Quartier', cle: 'quartier', largeur: 100 },
    { titre: 'Repère', cle: 'point_repere', largeur: 130 },
    { titre: 'TODP', cle: 'todp_surface_m2', largeur: 42, alignement: 'right' },
    { titre: 'Situation', cle: 'fiscal', largeur: 66 },
    { titre: 'Reste dû', cle: 'solde', largeur: 66, alignement: 'right' },
  ];
  const largeurTotale = colonnes.reduce((s, c) => s + c.largeur, 0);

  let y = 0;
  let page = 0;

  const enTete = () => {
    page += 1;
    if (page > 1) doc.addPage();
    doc.rect(30, 28, largeurTotale, 26).fill(VERT_HEX);
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(11)
      .text(`${commune} — Liste des commerces`, 38, 36);
    doc.font('Helvetica').fontSize(8)
      .text(`${lignes.length} commerces · ${dateFr(new Date())} · page ${page}`,
        30, 38, { width: largeurTotale - 10, align: 'right' });

    y = 62;
    doc.fillColor('#000000').font('Helvetica-Bold').fontSize(8);
    let x = 30;
    for (const c of colonnes) {
      doc.text(c.titre, x + 3, y, { width: c.largeur - 6, align: c.alignement ?? 'left' });
      x += c.largeur;
    }
    y += 12;
    doc.moveTo(30, y).lineTo(30 + largeurTotale, y).lineWidth(0.8).stroke(VERT_HEX);
    y += 4;
    doc.font('Helvetica').fontSize(7.5);
  };

  enTete();

  for (const [i, c] of lignes.entries()) {
    if (y > doc.page.height - 50) enTete();

    // Une ligne sur deux légèrement teintée : sur une liste de 200 lignes,
    // c'est ce qui évite de sauter d'une ligne à l'autre en la lisant.
    if (i % 2 === 1) {
      doc.rect(30, y - 2, largeurTotale, 12).fill('#F5F6F4');
      doc.fillColor('#000000');
    }

    const valeurs = {
      ...c,
      fiscal: LIBELLES_STATUT_FISCAL[c.statut_fiscal] ?? '',
      solde: Number(c.solde_du) > 0 ? `${montantXof(c.solde_du)} F` : '—',
      todp_surface_m2: c.todp_surface_m2 ? `${c.todp_surface_m2}` : '',
    };

    let x = 30;
    for (const col of colonnes) {
      const brut = String(valeurs[col.cle] ?? '');
      const texte = brut.length > col.largeur / 3.6
        ? `${brut.slice(0, Math.floor(col.largeur / 3.6) - 1)}…`
        : brut;

      if (col.cle === 'solde' && Number(c.solde_du) > 0) doc.fillColor('#B3261E');
      doc.text(texte, x + 3, y, { width: col.largeur - 6, align: col.alignement ?? 'left' });
      doc.fillColor('#000000');
      x += col.largeur;
    }
    y += 12;
  }

  await tracerExport(contexte, {
    format: 'pdf', entite: 'commerce', filtres, nbLignes: lignes.length,
  });

  return { buffer: await versBuffer(doc), nbLignes: lignes.length };
}

// ===========================================================================
//  PAIEMENTS
// ===========================================================================
async function paiementsExcel(contexte, filtres = {}) {
  const conditions = ['p.annule_le IS NULL'];
  const params = [];

  if (filtres.depuis) { params.push(filtres.depuis); conditions.push(`p.paye_le >= $${params.length}`); }
  if (filtres.jusqua) { params.push(filtres.jusqua); conditions.push(`p.paye_le <= $${params.length}`); }
  if (filtres.moyen) { params.push(filtres.moyen); conditions.push(`p.moyen = $${params.length}`); }
  params.push(PLAFOND);

  const { rows } = await requete(contexte, `
    SELECT p.reference, p.montant, p.moyen, p.paye_le,
           c.code AS commerce_code, c.enseigne, z.nom AS zone, q.nom AS quartier,
           a.numero AS avis, pf.code AS periode,
           qt.numero AS quittance,
           t.wave_session_id, t.wave_transaction_id
      FROM app.paiement p
      JOIN app.commerce c ON c.id = p.commerce_id
      JOIN app.zone z ON z.id = c.zone_id
      JOIN app.quartier q ON q.id = c.quartier_id
      LEFT JOIN app.avis_imposition a ON a.id = p.avis_id
      LEFT JOIN app.periode_fiscale pf ON pf.id = a.periode_id
      LEFT JOIN app.quittance qt ON qt.paiement_id = p.id
      LEFT JOIN app.transaction_wave t ON t.paiement_id = p.id
     WHERE ${conditions.join(' AND ')}
     ORDER BY p.paye_le DESC
     LIMIT $${params.length}`, params);

  const classeur = new ExcelJS.Workbook();
  const feuille = classeur.addWorksheet('Paiements');

  preparerFeuille(feuille, [
    { header: 'Référence', key: 'reference', width: 26 },
    { header: 'Date', key: 'date', width: 18 },
    { header: 'Commerce', key: 'commerce', width: 16 },
    { header: 'Enseigne', key: 'enseigne', width: 30 },
    { header: 'Zone', key: 'zone', width: 18 },
    { header: 'Quartier', key: 'quartier', width: 20 },
    { header: 'Période', key: 'periode', width: 12 },
    { header: 'Avis', key: 'avis', width: 22 },
    { header: 'Moyen', key: 'moyen', width: 12 },
    { header: 'Montant', key: 'montant', width: 14 },
    { header: 'Quittance', key: 'quittance', width: 26 },
    { header: 'Transaction Wave', key: 'wave', width: 30 },
  ]);

  const moyens = {
    wave: 'Wave',
  };

  for (const p of rows) {
    feuille.addRow({
      reference: p.reference,
      date: p.paye_le ? new Date(p.paye_le) : null,
      commerce: p.commerce_code,
      enseigne: p.enseigne,
      zone: p.zone,
      quartier: p.quartier,
      periode: p.periode ?? '',
      avis: p.avis ?? '',
      moyen: moyens[p.moyen] ?? p.moyen,
      montant: montantXof(p.montant),
      quittance: p.quittance ?? '',
      wave: p.wave_transaction_id ?? p.wave_session_id ?? '',
    });
  }

  feuille.getColumn('montant').numFmt = '# ##0 "F"';
  feuille.getColumn('date').numFmt = 'dd/mm/yyyy hh:mm';

  feuille.eachRow((ligne, numero) => {
    if (numero === 1) return;
    if (ligne.getCell('verse').value === 'NON VERSÉ') {
      ligne.getCell('verse').font = { bold: true, color: { argb: 'FFB3261E' } };
    }
  });

  // Ligne de total, en gras : c'est le chiffre que cherche le receveur.
  const total = rows.reduce((s, p) => s + montantXof(p.montant), 0);
  const ligneTotal = feuille.addRow({ enseigne: 'TOTAL', montant: total });
  ligneTotal.font = { bold: true, size: 12 };
  ligneTotal.getCell('montant').numFmt = '# ##0 "F"';

  await tracerExport(contexte, {
    format: 'excel', entite: 'paiement', filtres, nbLignes: rows.length,
  });

  return {
    buffer: await finaliserClasseur(classeur, {
      titre: 'Journal des paiements',
      commune: contexte.communeNom,
      utilisateur: contexte.utilisateurNom,
    }),
    nbLignes: rows.length,
    total,
  };
}

// ===========================================================================
//  ÉTAT DE RECOUVREMENT (PDF de synthèse, pour le conseil municipal)
// ===========================================================================
async function recouvrementPdf(contexte, { periodeId = null } = {}) {
  const { rows: cr } = await requete(contexte,
    'SELECT nom FROM app.commune WHERE id = $1', [contexte.communeId]);
  const commune = cr[0]?.nom ?? '';

  const params = [];
  let filtre = '';
  if (periodeId) { params.push(periodeId); filtre = `WHERE periode_id = $${params.length}`; }

  const [periodes, zones, taxes] = await Promise.all([
    requete(contexte, `SELECT * FROM app.v_recouvrement_periode ${filtre}
                        ORDER BY date_debut DESC LIMIT 12`, params),
    requete(contexte, 'SELECT * FROM app.v_stats_zone ORDER BY zone_code'),
    requete(contexte, 'SELECT * FROM app.v_recouvrement_taxe LIMIT 40'),
  ]);

  const doc = new PDFDocument({
    size: 'A4', margin: 40,
    info: { Title: 'État de recouvrement', Author: commune },
  });
  const L = doc.page.width - 80;

  doc.rect(40, 36, L, 44).fill(VERT_HEX);
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(15)
    .text(commune, 48, 46);
  doc.font('Helvetica').fontSize(9)
    .text(`État de recouvrement des taxes locales — ${dateFr(new Date())}`, 48, 66);

  doc.fillColor('#000000');
  let y = 100;

  const tableau = (titre, entetes, donnees, largeurs) => {
    if (y > doc.page.height - 140) { doc.addPage(); y = 50; }

    doc.font('Helvetica-Bold').fontSize(11).fillColor(VERT_HEX).text(titre, 40, y);
    y += 16;
    doc.fillColor('#000000').fontSize(8).font('Helvetica-Bold');

    let x = 40;
    entetes.forEach((h, i) => {
      doc.text(h, x + 2, y, { width: largeurs[i] - 4, align: i === 0 ? 'left' : 'right' });
      x += largeurs[i];
    });
    y += 11;
    doc.moveTo(40, y).lineTo(40 + L, y).lineWidth(0.6).stroke(VERT_HEX);
    y += 4;

    doc.font('Helvetica').fontSize(8);
    for (const ligne of donnees) {
      if (y > doc.page.height - 60) { doc.addPage(); y = 50; }
      x = 40;
      ligne.forEach((v, i) => {
        doc.text(String(v ?? '—'), x + 2, y, {
          width: largeurs[i] - 4, align: i === 0 ? 'left' : 'right',
        });
        x += largeurs[i];
      });
      y += 11;
    }
    y += 14;
  };

  tableau('Recouvrement par période',
    ['Période', 'Avis', 'Attendu', 'Recouvré', 'Restant', 'Taux'],
    periodes.rows.map((p) => [
      p.periode, p.nb_avis,
      `${montantXof(p.montant_attendu)} F`,
      `${montantXof(p.montant_recouvre)} F`,
      `${montantXof(p.montant_restant)} F`,
      p.taux_recouvrement_pct != null ? `${p.taux_recouvrement_pct} %` : '—',
    ]),
    [90, 50, 90, 90, 90, 55]);

  tableau('Situation par zone',
    ['Zone', 'Commerces', 'À jour', 'Partiels', 'Impayés', 'Dû', 'Taux'],
    zones.rows.map((z) => [
      z.zone_nom, z.nb_commerces, z.nb_a_jour, z.nb_partiel, z.nb_impaye,
      `${montantXof(z.montant_du)} F`,
      z.taux_a_jour_pct != null ? `${z.taux_a_jour_pct} %` : '—',
    ]),
    [130, 62, 50, 55, 55, 90, 48]);

  tableau('Répartition par taxe',
    ['Taxe', 'Période', 'Lignes', 'Facturé', 'Recouvré (est.)'],
    taxes.rows.map((t) => [
      t.taxe, t.periode, t.nb_lignes,
      `${montantXof(t.montant_facture)} F`,
      `${montantXof(t.montant_recouvre_estime)} F`,
    ]),
    [140, 70, 55, 105, 105]);

  doc.fontSize(7).fillColor('#777777')
    .text(
      'Le montant recouvré par taxe est une estimation proportionnelle : un paiement Wave '
      + 'règle l\'avis dans son ensemble, pas une taxe en particulier.',
      40, doc.page.height - 60, { width: L },
    );

  await tracerExport(contexte, {
    format: 'pdf', entite: 'recouvrement', filtres: { periodeId }, nbLignes: periodes.rows.length,
  });

  return { buffer: await versBuffer(doc) };
}


// ===========================================================================
//  RÉVERSIBILITÉ — CSV et GeoJSON (FR-064, SC-018)
//
//  Excel et PDF servent au travail quotidien de la mairie. Ils ne servent
//  PAS la réversibilité : dans un partenariat public-privé, la commune doit
//  pouvoir reprendre ses données sans l'outil qui les a produites, ni le
//  partenaire qui l'exploite. Cela suppose des formats ouverts et documentés.
// ===========================================================================

/** Échappement conforme au RFC 4180. */
function champCsv(v) {
  if (v === null || v === undefined) return '';
  const t = v instanceof Date ? v.toISOString() : String(v);
  return /[";\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

/**
 * Point-virgule et BOM UTF-8. Sans eux, Excel en configuration francophone
 * met tout dans une seule colonne et casse les accents — un export illisible
 * par la mairie n'est pas un export.
 */
function versCsv(lignes, colonnes) {
  const entete = colonnes.map((c) => champCsv(c.titre)).join(';');
  const corps = lignes.map((l) => colonnes.map((c) => champCsv(l[c.cle])).join(';'));
  return `\ufeff${[entete, ...corps].join('\r\n')}\r\n`;
}

const COLONNES_COMMERCES_CSV = [
  { cle: 'code', titre: 'Code' },
  { cle: 'enseigne', titre: 'Enseigne' },
  { cle: 'categorie', titre: 'Categorie' },
  { cle: 'zone', titre: 'Zone' },
  { cle: 'quartier', titre: 'Quartier' },
  { cle: 'rue', titre: 'Rue' },
  { cle: 'statut', titre: 'Statut' },
  { cle: 'statut_fiscal', titre: 'Statut fiscal' },
  { cle: 'solde_du', titre: 'Solde du (FCFA)' },
  { cle: 'longitude', titre: 'Longitude' },
  { cle: 'latitude', titre: 'Latitude' },
];

async function commercesCsv(contexte, filtres = {}) {
  const lignes = await donneesCommerces(contexte, filtres);
  await tracerExport(contexte, {
    format: 'csv', entite: 'commerces', filtres, nbLignes: lignes.length });
  return { contenu: versCsv(lignes, COLONNES_COMMERCES_CSV), nbLignes: lignes.length };
}

/**
 * GeoJSON aux propriétés PLATES : un GeoJSON imbriqué ne s'ouvre pas dans
 * QGIS sans retraitement, ce qui manquerait le but.
 *
 * Une unité sans position est ÉCARTÉE, jamais placée à zéro : un point au
 * large du golfe de Guinée fausserait toute lecture cartographique.
 */
async function commercesGeoJson(contexte, filtres = {}) {
  const lignes = await donneesCommerces(contexte, filtres);

  const features = lignes
    .filter((l) => l.longitude !== null && l.latitude !== null)
    .map((l) => {
      const proprietes = { ...l };
      delete proprietes.longitude;
      delete proprietes.latitude;
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [Number(l.longitude), Number(l.latitude)] },
        properties: proprietes,
      };
    });

  await tracerExport(contexte, {
    format: 'geojson', entite: 'commerces', filtres, nbLignes: features.length });

  return {
    contenu: {
      type: 'FeatureCollection',
      // Le système de référence est explicite : sans lui, un lecteur doit
      // deviner, et devine parfois mal.
      crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
      features,
    },
    nbLignes: features.length,
    sansPosition: lignes.length - features.length,
  };
}

module.exports = {
  commercesExcel, commercesPdf, paiementsExcel, recouvrementPdf,
  commercesCsv, commercesGeoJson, versCsv, champCsv,
  PLAFOND,
};
