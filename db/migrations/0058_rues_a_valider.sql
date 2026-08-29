-- 0058 — Une rue importée n'est pas une rue officielle
--
-- L'outil d'import annonce, dans son propre en-tête, que « chaque rue importée
-- est marquée à valider, et apparaît dans l'inventaire des données à compléter
-- jusqu'à ce que quelqu'un les ait relues ». Il n'en était rien : la route
-- d'import ne posait aucun indicateur, et l'inventaire ne connaissait pas les
-- rues du tout.
--
-- Cent noms de voie viennent d'être importés, dont quatre-vingt-cinq
-- d'OpenStreetMap — une source bénévole, précieuse et faillible. Rien ne les
-- distinguait d'un référentiel arrêté par la commune.
--
-- Ce n'est pas une question de forme. Le taux de collecte PAR RUE est une des
-- lectures principales du tableau de bord, et il servira à décider où envoyer
-- les agents. Bâti sur des noms que la mairie n'a jamais relus, il est
-- contestable — et il sera contesté le jour où il désignera un quartier.
--
-- Trois choses, donc : une rue non validée le dit, l'inventaire la montre, et
-- la validation laisse une trace nominative.

ALTER TABLE app.rue
    ADD COLUMN IF NOT EXISTS valide_le  timestamptz,
    ADD COLUMN IF NOT EXISTS valide_par uuid REFERENCES app.utilisateur(id);

COMMENT ON COLUMN app.rue.valide_le IS
  'Date à laquelle la mairie a arrêté le libellé de cette voie. Tant qu''elle '
  'est nulle, le nom vient d''une source externe et n''engage pas la commune.';

-- Reprise de l'existant : tout ce qui vient d'une source externe et n'a jamais
-- été validé attend une relecture. Les voies saisies à la main par la commune
-- (source « a_saisir ») sont son propre travail : on ne les lui renvoie pas.
UPDATE app.rue
   SET a_remplacer = true
 WHERE valide_le IS NULL
   AND source <> 'a_saisir'
   AND archive_le IS NULL
   AND NOT a_remplacer;

CREATE OR REPLACE VIEW app.v_donnees_a_remplacer AS
SELECT 'zone'::text AS entite,
    z.id,
    z.commune_id,
    z.nom AS libelle,
    'Nom de zone provisoire'::text AS a_faire,
    NULL::numeric AS montant
   FROM app.zone z
  WHERE z.a_remplacer AND z.archive_le IS NULL
UNION ALL
 SELECT 'quartier'::text AS entite,
    q.id,
    q.commune_id,
    q.nom AS libelle,
        CASE
            WHEN q.geom IS NULL THEN 'Nom provisoire + polygone manquant (détection GPS inactive)'::text
            ELSE 'Nom provisoire'::text
        END AS a_faire,
    NULL::numeric AS montant
   FROM app.quartier q
  WHERE (q.a_remplacer OR q.geom IS NULL) AND q.archive_le IS NULL
UNION ALL
 SELECT 'rue'::text AS entite,
    r.id,
    r.commune_id,
    r.nom AS libelle,
        CASE r.source
            WHEN 'osm' THEN 'Nom venu d''OpenStreetMap, à confirmer par la mairie'::text
            WHEN 'pdc' THEN 'Nom déduit du PDC, à confirmer par la mairie'::text
            ELSE 'Nom à confirmer par la mairie'::text
        END AS a_faire,
    NULL::numeric AS montant
   FROM app.rue r
  WHERE r.a_remplacer AND r.valide_le IS NULL AND r.archive_le IS NULL AND r.actif
UNION ALL
 SELECT 'categorie_commerce'::text AS entite,
    c.id,
    c.commune_id,
    c.libelle,
    'Libellé provisoire'::text AS a_faire,
    NULL::numeric AS montant
   FROM ref.categorie_commerce c
  WHERE c.a_remplacer AND c.archive_le IS NULL
UNION ALL
 SELECT 'bareme_taxe'::text AS entite,
    b.id,
    b.commune_id,
    b.libelle,
        CASE
            WHEN b.date_fin IS NOT NULL THEN ('Tarif provisoire, remplacé automatiquement le '::text || to_char(b.date_fin::timestamp with time zone, 'DD/MM/YYYY'::text)) || ' — plus rien à faire'::text
            ELSE 'TARIF PROVISOIRE — à remplacer par la délibération du conseil municipal'::text
        END AS a_faire,
    COALESCE(b.montant_fixe, b.montant_unitaire) AS montant
   FROM app.bareme_taxe b
  WHERE b.a_remplacer AND (b.date_fin IS NULL OR b.date_fin > CURRENT_DATE)
UNION ALL
 SELECT 'bareme_tranche'::text AS entite,
    t.id,
    b.commune_id,
    COALESCE(t.libelle, 'tranche'::text) AS libelle,
        CASE
            WHEN b.date_fin IS NOT NULL THEN 'Tarif provisoire, remplacé le '::text || to_char(b.date_fin::timestamp with time zone, 'DD/MM/YYYY'::text)
            ELSE 'TARIF PROVISOIRE'::text
        END AS a_faire,
    t.montant
   FROM app.bareme_tranche t
     JOIN app.bareme_taxe b ON b.id = t.bareme_id
  WHERE t.a_remplacer AND (b.date_fin IS NULL OR b.date_fin > CURRENT_DATE)
UNION ALL
 SELECT 'marche'::text AS entite,
    m.id,
    m.commune_id,
    m.nom AS libelle,
    'Marché provisoire'::text AS a_faire,
    NULL::numeric AS montant
   FROM app.marche m
  WHERE m.a_remplacer AND m.archive_le IS NULL
UNION ALL
 SELECT 'type_emplacement'::text AS entite,
    e.id,
    e.commune_id,
    e.libelle,
    'Libellé provisoire'::text AS a_faire,
    NULL::numeric AS montant
   FROM ref.type_emplacement e
  WHERE e.a_remplacer AND e.actif
UNION ALL
 SELECT 'objet_sans_redevable'::text AS entite,
    o.objet_id AS id,
    o.commune_id,
    (o.code || ' — '::text) || o.libelle AS libelle,
    'Redevable à identifier : '::text || COALESCE(o.rue, o.quartier, 'localisation inconnue'::text) AS a_faire,
    NULL::numeric AS montant
   FROM app.v_objets_sans_redevable o;

COMMENT ON VIEW app.v_donnees_a_remplacer IS
  'Tout ce qui est provisoire et attend une décision de la commune : noms de '
  'zones, de quartiers et de voies, libellés de catégories, tarifs non '
  'délibérés. Doit être vide avant la mise en service.';
