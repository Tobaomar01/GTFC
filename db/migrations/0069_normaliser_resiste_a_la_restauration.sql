-- ===========================================================================
--  app.normaliser doit survivre a une restauration
--
--  LA SAUVEGARDE NE SE RESTAURAIT PAS. Mesure sur un dump complet de la base
--  de recette, restaure par scripts/restore-postgres.sh :
--
--      pg_restore: error: COPY failed for table "commerce":
--          ERROR: function unaccent(unknown, text) does not exist
--          CONTEXT: SQL function "normaliser" during inlining
--
--      48 erreurs, en cascade. commerce, redevable, rue : ABSENTES.
--      audit.journal : VIDE. avis_imposition et paiement, eux, restaures.
--
--  Une base a moitie restauree, et rien pour le dire.
--
--  POURQUOI. app.normaliser appelait « unaccent(...) » sans qualifier son
--  schema, et n'avait aucun SET search_path. L'extension unaccent vit dans
--  « public ». En usage courant, public est dans le search_path et tout
--  fonctionne — ce qui explique que le defaut ait survecu si longtemps.
--
--  Mais pg_restore RESTREINT le search_path pendant la restauration, par
--  securite. La fonction devient alors introuvable ; le COPY de commerce
--  echoue ; et toutes les tables qui referencent commerce tombent avec lui.
--
--  La fonction alimente des colonnes GENEREES — enseigne_normalisee,
--  nom_normalise, designation_normalisee — donc elle est appelee pour CHAQUE
--  ligne inseree. Il n'y avait aucun moyen d'y echapper.
--
--  LE CORRECTIF. Qualifier le schema de la fonction ET du dictionnaire. Le
--  dictionnaire « unaccent » est un objet de premiere classe : sans
--  qualification, il se cherche lui aussi dans le search_path.
--
--  Eprouve : meme resultat qu'avant, et surtout le meme AVEC
--  « SET search_path = app, pg_catalog » — le cas de la restauration.
-- ===========================================================================

CREATE OR REPLACE FUNCTION app.normaliser(txt text)
RETURNS text
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
AS $normaliser$
    SELECT lower(public.unaccent('public.unaccent'::regdictionary, coalesce(txt, '')));
$normaliser$;

COMMENT ON FUNCTION app.normaliser(text) IS
    'Forme normalisee pour la recherche : minuscules, sans accents. '
    'Le schema de unaccent EST qualifie a dessein : sans cela, pg_restore '
    'echoue sur toutes les tables portant une colonne generee.';
