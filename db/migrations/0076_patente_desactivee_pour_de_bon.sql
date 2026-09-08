-- ===========================================================================
--  La patente redevient inactive — et le reste
--
--  POURQUOI UNE SECONDE MIGRATION SUR LE MEME SUJET.
--
--  0023 avait deja desactive la patente, avec un raisonnement juste : elle a
--  ete remplacee en 2018 par la contribution economique locale (CEL-VL et
--  CEL-VA), etablie et recouvree par la DGID. La commune en percoit le produit
--  mais n'en est pas le collecteur. Elle avertissait :
--
--      « Laisser la patente active aurait fait reclamer par un agent communal
--        un impot que le commercant doit declarer a la DGID. Sur le terrain,
--        cela se serait traduit par un double appel a paiement, et par une
--        contestation legitime que la mairie aurait perdue. »
--
--  ELLE N'A JAMAIS RIEN FAIT SUR UNE BASE NEUVE. « ref.type_taxe » n'est
--  peuplee QUE par db/seeds/0001_types_taxes.sql, et db/migrate.sh joue les
--  seeds APRES les migrations. A l'instant ou 0023 s'executait, la table etait
--  VIDE : son UPDATE touchait zero ligne, la migration etait consignee comme
--  appliquee, et le seed reinserait aussitot la patente active.
--
--  Elle n'a donc fonctionne que sur la base d'origine, ou les donnees
--  preexistaient. Constate le 08/09/2026 sur deux bases construites de zero :
--  patente active au niveau du type ET de la commune, sur 61 avis de
--  demonstration pour 3 372 500 XOF.
--
--  CE QUI EST CORRIGE AILLEURS, ET QUI COMPTE PLUS QUE CETTE MIGRATION :
--   · db/seeds/0001 insere desormais la patente INACTIVE, et son ON CONFLICT
--     propage « actif » ;
--   · db/seeds/0002 et la route de creation de commune RECOPIENT t.actif au
--     lieu de forcer true.
--
--  Cette migration ne sert donc qu'aux bases DEJA installees. Sur une base
--  neuve elle ne trouvera, la aussi, rien a faire — mais cette fois le seed ne
--  la contredira plus.
--
--  ELLE NE TOUCHE A AUCUN AVIS DEJA EMIS. Annuler ou degrever une creance
--  notifiee est une decision municipale, pas l'effet d'un script. Voir la
--  question BR-010 de la specification.
-- ===========================================================================

UPDATE ref.type_taxe
   SET actif       = false,
       base_legale = 'Loi de finances 2018 — substitution de la CEL à la patente',
       description = 'Remplacée depuis 2018 par la contribution économique locale (CEL-VL et '
                     || 'CEL-VA), établie et recouvrée par la DGID. Hors périmètre de collecte '
                     || 'communale : conservée uniquement pour expliquer les avis antérieurs.',
       modifie_le  = now()
 WHERE code = 'patente' AND actif;

UPDATE ref.commune_type_taxe ctt
   SET actif         = false,
       libelle_local = 'Patente — remplacée par la CEL (DGID), hors collecte communale',
       modifie_le    = now()
  FROM ref.type_taxe t
 WHERE ctt.type_taxe_id = t.id AND t.code = 'patente' AND ctt.actif;

-- ---------------------------------------------------------------------------
--  Le controle qui empeche le retour.
--
--  Une taxe desactivee nationalement mais rattachee ACTIVE a une commune est
--  une reclamation en preparation. Cette vue nomme chaque cas ; elle DOIT
--  rester vide, et un test le verifie.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW app.v_controle_taxes_desactivees AS
SELECT c.slug          AS commune,
       t.code          AS taxe,
       'Type désactivé nationalement, mais rattaché ACTIF à cette commune : '
       'un agent la réclamerait.'::text AS consequence
  FROM ref.commune_type_taxe ctt
  JOIN ref.type_taxe t ON t.id = ctt.type_taxe_id
  JOIN app.commune   c ON c.id = ctt.commune_id
 WHERE ctt.actif AND NOT t.actif;

COMMENT ON VIEW app.v_controle_taxes_desactivees IS
    'DOIT rester vide. Toute ligne est une taxe qu''un agent reclamerait alors '
    'qu''elle ne revient pas a la commune.';

ALTER VIEW app.v_controle_taxes_desactivees SET (security_invoker = true);
GRANT SELECT ON app.v_controle_taxes_desactivees TO gtfc_app;

-- ---------------------------------------------------------------------------
--  Verification de la migration.
-- ---------------------------------------------------------------------------
DO $verif$
DECLARE
    v_restantes text;
BEGIN
    SELECT string_agg(commune || '/' || taxe, ', ') INTO v_restantes
      FROM app.v_controle_taxes_desactivees;

    IF v_restantes IS NOT NULL THEN
        RAISE EXCEPTION 'Taxes desactivees encore actives par commune : %', v_restantes;
    END IF;
END
$verif$;
