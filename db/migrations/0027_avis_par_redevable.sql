-- ===========================================================================
--  0027 — La facture est consolidée par redevable
--
--  « Un tailleur possédant une cantine au marché de Colobane et une enseigne
--    reçoit une seule facture couvrant les deux — et donc un seul lien de
--    paiement. »
--
--  Conséquences sur le schéma :
--
--   · avis_imposition.redevable_id devient la clé de regroupement ;
--   · avis_imposition.commerce_id devient FACULTATIF — une régie publicitaire
--     est facturée sans posséder le moindre commerce ;
--   · avis_ligne porte l'objet taxable qui la justifie, faute de quoi un
--     redevable à huit panneaux ne pourrait pas avoir huit lignes de taxe
--     publicitaire, et ne comprendrait pas son montant.
--
--  REPRISE DES AVIS EXISTANTS
--
--  Deux avis du même redevable sur la même période doivent devenir un seul.
--  La fusion est faite lorsqu'elle est SANS RISQUE : brouillons, ou avis émis
--  n'ayant reçu ni paiement ni quittance. Au-delà, la migration s'arrête et
--  donne la liste : déplacer un encaissement ou invalider une quittance déjà
--  remise à un commerçant n'est pas une décision de script.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Colonnes
-- ---------------------------------------------------------------------------
ALTER TABLE app.avis_imposition
    ADD COLUMN IF NOT EXISTS redevable_id uuid REFERENCES app.redevable(id) ON DELETE RESTRICT;

ALTER TABLE app.avis_ligne
    ADD COLUMN IF NOT EXISTS objet_type app.type_objet_taxable,
    ADD COLUMN IF NOT EXISTS objet_id   uuid,
    ADD COLUMN IF NOT EXISTS objet_code text;

COMMENT ON COLUMN app.avis_ligne.objet_id IS
'Objet taxable qui justifie la ligne. Pas de clé étrangère : les trois familles vivent dans trois tables, et une quittance doit rester lisible même si l''objet est archivé ensuite.';
COMMENT ON COLUMN app.avis_ligne.objet_code IS
'Copie du code de l''objet au moment du calcul (GTFC-Z1-00042, GTFC-A-00007). Rend la facture lisible sans jointure, y compris des années plus tard.';

-- ---------------------------------------------------------------------------
-- 2. Reprise
-- ---------------------------------------------------------------------------
UPDATE app.avis_imposition a
   SET redevable_id = c.redevable_id
  FROM app.commerce c
 WHERE a.commerce_id = c.id AND a.redevable_id IS NULL;

-- Les lignes existantes portent toutes sur le commerce de leur avis.
UPDATE app.avis_ligne l
   SET objet_type = 'commerce',
       objet_id   = a.commerce_id,
       objet_code = c.code
  FROM app.avis_imposition a
  JOIN app.commerce c ON c.id = a.commerce_id
 WHERE l.avis_id = a.id AND l.objet_id IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Fusion des doublons sans risque
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_grp        record;
    v_garde      uuid;
    v_fusionnes  integer := 0;
    v_bloquants  integer;
BEGIN
    FOR v_grp IN
        SELECT redevable_id, periode_id, array_agg(id ORDER BY cree_le) AS avis
          FROM app.avis_imposition
         WHERE annule_le IS NULL AND redevable_id IS NOT NULL
         GROUP BY redevable_id, periode_id
        HAVING count(*) > 1
    LOOP
        -- Un avis ayant reçu un paiement ou produit une quittance ne se
        -- fusionne pas ici : la trace comptable prime.
        SELECT count(*) INTO v_bloquants
          FROM unnest(v_grp.avis) AS x(id)
         WHERE EXISTS (SELECT 1 FROM app.paiement p  WHERE p.avis_id = x.id)
            OR EXISTS (SELECT 1 FROM app.quittance q WHERE q.avis_id = x.id);
        CONTINUE WHEN v_bloquants > 0;

        v_garde := v_grp.avis[1];

        -- Les lignes rejoignent l'avis conservé.
        UPDATE app.avis_ligne
           SET avis_id = v_garde
         WHERE avis_id = ANY(v_grp.avis) AND avis_id <> v_garde;

        -- Les liens de paiement encore ouverts suivent.
        UPDATE app.transaction_wave
           SET avis_id = v_garde
         WHERE avis_id = ANY(v_grp.avis) AND avis_id <> v_garde;

        UPDATE app.avis_imposition
           SET annule_le        = now(),
               statut           = 'annule',
               motif_annulation = 'Consolidé dans ' || v_garde::text
                                  || ' (facture unique par redevable, migration 0027).'
         WHERE id = ANY(v_grp.avis) AND id <> v_garde;

        -- Totaux recalculés depuis les lignes réellement présentes.
        UPDATE app.avis_imposition a
           SET montant_taxes   = coalesce(s.brut, 0),
               montant_exonere = coalesce(s.exo, 0),
               montant_total   = coalesce(s.net, 0) + a.montant_penalite
                                 - a.montant_remise + a.report_anterieur,
               modifie_le      = now()
          FROM (SELECT sum(montant_brut) brut, sum(montant_exonere) exo, sum(montant) net
                  FROM app.avis_ligne WHERE avis_id = v_garde) s
         WHERE a.id = v_garde;

        v_fusionnes := v_fusionnes + array_length(v_grp.avis, 1) - 1;
    END LOOP;

    IF v_fusionnes > 0 THEN
        RAISE NOTICE 'Consolidation : % avis fusionné(s) dans la facture de leur redevable.', v_fusionnes;
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. Refus explicite si des doublons non fusionnables subsistent
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW app.v_avis_doublons_redevable AS
SELECT a.commune_id, a.redevable_id, r.code AS redevable_code, r.designation,
       a.periode_id, p.code AS periode,
       count(*)                       AS nb_avis,
       array_agg(a.numero ORDER BY a.numero) AS numeros,
       sum(a.montant_total)           AS montant_cumule,
       sum(a.montant_paye)            AS deja_paye
  FROM app.avis_imposition a
  JOIN app.redevable r       ON r.id = a.redevable_id
  JOIN app.periode_fiscale p ON p.id = a.periode_id
 WHERE a.annule_le IS NULL
 GROUP BY a.commune_id, a.redevable_id, r.code, r.designation, a.periode_id, p.code
HAVING count(*) > 1;

COMMENT ON VIEW app.v_avis_doublons_redevable IS
'Redevables portant plusieurs avis non annulés sur une même période. Doit être vide : la facture est unique par redevable et par période.';

DO $$
DECLARE v_reste integer;
BEGIN
    SELECT count(*) INTO v_reste FROM app.v_avis_doublons_redevable;
    IF v_reste > 0 THEN
        RAISE EXCEPTION
          '% redevable(s) portent encore plusieurs avis sur une même période, avec des '
          'paiements ou des quittances rattachés. Fusion impossible sans arbitrage : '
          'SELECT * FROM app.v_avis_doublons_redevable;', v_reste;
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 5. Bascule des contraintes
-- ---------------------------------------------------------------------------
-- Le commerce cesse d'être obligatoire : une régie publicitaire est facturée
-- sans en posséder aucun.
ALTER TABLE app.avis_imposition ALTER COLUMN commerce_id DROP NOT NULL;
ALTER TABLE app.avis_imposition ALTER COLUMN redevable_id SET NOT NULL;

ALTER TABLE app.avis_imposition DROP CONSTRAINT IF EXISTS avis_unique_par_periode;

-- Index partiel plutôt que contrainte : un avis annulé ne doit pas bloquer
-- l'émission de son remplaçant.
CREATE UNIQUE INDEX IF NOT EXISTS idx_avis_unique_redevable_periode
    ON app.avis_imposition (redevable_id, periode_id)
    WHERE annule_le IS NULL;

COMMENT ON INDEX app.idx_avis_unique_redevable_periode IS
'Une seule facture par redevable et par période. Empêche la double facturation si la génération mensuelle est relancée.';

CREATE INDEX IF NOT EXISTS idx_avis_redevable
    ON app.avis_imposition (redevable_id, date_exigibilite DESC);

-- Une ligne par taxe ET par objet : huit panneaux donnent huit lignes de
-- taxe publicitaire, chacune avec sa surface.
ALTER TABLE app.avis_ligne DROP CONSTRAINT IF EXISTS ligne_unique_par_taxe;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ligne_unique_taxe_objet
    ON app.avis_ligne (avis_id, type_taxe_id, coalesce(objet_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE INDEX IF NOT EXISTS idx_avis_ligne_objet ON app.avis_ligne (objet_type, objet_id);

-- ---------------------------------------------------------------------------
-- 6. Le dossier consolidé d'un redevable
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW app.v_redevable_objets AS
SELECT r.commune_id, r.id AS redevable_id, r.code AS redevable_code, r.designation,
       'commerce'::app.type_objet_taxable AS objet_type,
       c.id AS objet_id, c.code AS objet_code,
       c.enseigne AS objet_libelle,
       ca.libelle AS precision,
       c.statut::text AS statut
  FROM app.redevable r
  JOIN app.commerce c ON c.redevable_id = r.id AND c.archive_le IS NULL
  LEFT JOIN ref.categorie_commerce ca ON ca.id = c.categorie_id
 WHERE r.archive_le IS NULL
UNION ALL
SELECT r.commune_id, r.id, r.code, r.designation,
       'affichage', d.id, d.code,
       coalesce(d.texte_affiche, ta.libelle),
       ta.libelle || ' — ' || d.surface_m2 || ' m2',
       CASE WHEN d.actif THEN 'actif' ELSE 'depose' END
  FROM app.redevable r
  JOIN app.dispositif_affichage d ON d.redevable_id = r.id AND d.archive_le IS NULL
  JOIN ref.type_affichage ta ON ta.id = d.type_affichage_id
 WHERE r.archive_le IS NULL
UNION ALL
SELECT r.commune_id, r.id, r.code, r.designation,
       'chantier', ch.id, ch.code,
       coalesce(ch.libelle, 'Chantier'),
       ch.surface_m2 || ' m2'
         || CASE WHEN ch.facturable THEN '' ELSE ' — recensement seul' END,
       ch.statut::text
  FROM app.redevable r
  JOIN app.chantier ch ON ch.redevable_id = r.id AND ch.archive_le IS NULL
 WHERE r.archive_le IS NULL;

COMMENT ON VIEW app.v_redevable_objets IS
'Tous les objets taxables d''un redevable, toutes familles confondues. Base de la facture consolidée et de la page du portail.';
