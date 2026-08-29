-- Estimation de recette sur la répartition réelle du PDC 2021-2025.
--
-- Les MONTANTS sont théoriques (seed 0007) ; la RÉPARTITION est réelle.
-- L'estimation ne vaut donc que ce que valent les tarifs — mais elle n'est
-- plus faussée par un échantillon de démonstration non représentatif.

WITH pdc(code, libelle, effectif) AS (VALUES
    ('ACT-01','Boutiques alimentation',      821),
    ('ACT-02','Restaurants',                 495),
    ('ACT-99','Cantines / magasins',        1134),
    ('ACT-03','Dibiteries',                   21),
    ('ACT-05','Stations d''essence',           9),
    ('ACT-04','Grandes surfaces',              6),
    ('ACT-12','Tailleurs / couture',        1285),
    ('ACT-99','Ventes diverses',             813),
    ('ACT-19','Dépôts',                      139),
    ('ACT-13','Salons de coiffure',          152),
    ('ACT-15','Quincailleries',              103),
    ('ACT-18','Cosmétiques',                  96),
    ('ACT-10','Menuiseries bois',             82),
    ('ACT-17','Pressing',                     59),
    ('ACT-07','Cordonneries',                 68),
    ('ACT-09','Garages mécaniques',           47),
    ('ACT-16','Merceries',                    42),
    ('ACT-08','Forgeries',                    23),
    ('ACT-06','Bijouteries',                  28),
    ('ACT-11','Vulcanisation',                11),
    ('ACT-14','Boulangeries',                  9)
), tarifs AS (
    SELECT c.code,
           max(CASE WHEN t.code='patente' THEN b.montant END) AS patente,
           max(CASE WHEN t.code='teom'    THEN b.montant END) AS teom
      FROM ref.categorie_commerce c
      LEFT JOIN app.bareme_tranche b ON b.categorie_id = c.id
      LEFT JOIN app.bareme_taxe bt   ON bt.id = b.bareme_id
      LEFT JOIN ref.type_taxe t      ON t.id = bt.type_taxe_id
     GROUP BY c.code
)
SELECT p.libelle,
       p.effectif,
       coalesce(tf.patente,0) AS patente_mois,
       coalesce(tf.teom,0)    AS teom_mois,
       p.effectif * (coalesce(tf.patente,0) + coalesce(tf.teom,0)) * 12 AS annuel_fcfa
  FROM pdc p LEFT JOIN tarifs tf ON tf.code = p.code
 ORDER BY 5 DESC;

-- Synthèse
WITH pdc(code, effectif) AS (VALUES
    ('ACT-01',821),('ACT-02',495),('ACT-99',1134),('ACT-03',21),('ACT-05',9),
    ('ACT-04',6),('ACT-12',1285),('ACT-99',813),('ACT-19',139),('ACT-13',152),
    ('ACT-15',103),('ACT-18',96),('ACT-10',82),('ACT-17',59),('ACT-07',68),
    ('ACT-09',47),('ACT-16',42),('ACT-08',23),('ACT-06',28),('ACT-11',11),
    ('ACT-14',9)
), tarifs AS (
    SELECT c.code,
           max(CASE WHEN t.code='patente' THEN b.montant END) AS patente,
           max(CASE WHEN t.code='teom'    THEN b.montant END) AS teom
      FROM ref.categorie_commerce c
      LEFT JOIN app.bareme_tranche b ON b.categorie_id = c.id
      LEFT JOIN app.bareme_taxe bt   ON bt.id = b.bareme_id
      LEFT JOIN ref.type_taxe t      ON t.id = bt.type_taxe_id
     GROUP BY c.code
), calc AS (
    SELECT p.effectif,
           coalesce(tf.patente,0) + coalesce(tf.teom,0) AS mensuel
      FROM pdc p LEFT JOIN tarifs tf ON tf.code = p.code
)
SELECT sum(effectif)                                   AS redevables,
       round(sum(effectif*mensuel)/sum(effectif))      AS moyenne_mensuelle,
       sum(effectif*mensuel)*12                        AS plafond_theorique,
       round(sum(effectif*mensuel)*12*0.55)            AS a_55_pct_recouvrement,
       round(sum(effectif*mensuel)*12*0.35)            AS a_35_pct_recouvrement
  FROM calc;
