-- ===========================================================================
--  Le journal d'audit doit pouvoir se restaurer
--
--  MEME DEFAUT QUE LA MIGRATION 0069, AUTRE FONCTION. Apres avoir qualifie
--  unaccent dans app.normaliser, la restauration ramenait toutes les tables
--  metier a l'identique — mais le journal d'audit restait VIDE : 0 ligne
--  sur 2499.
--
--      pg_restore: error: COPY failed for table "journal_2026_08":
--          ERROR: function digest(text, unknown) does not exist
--
--  audit.chainer et audit.verifier_chaine appellent digest(), fournie par
--  l'extension pgcrypto, installee dans « public ». Aucune des deux n'avait de
--  search_path fixe. En usage courant public est dans le chemin ; pendant une
--  restauration, pg_restore le restreint, et le declencheur qui calcule
--  l'empreinte echoue sur chaque ligne.
--
--  CONSEQUENCE : le registre PROBANT etait le seul a ne pas se restaurer. Une
--  commune qui restaure sa sauvegarde retrouvait ses commerces, ses avis et
--  ses paiements — et perdait la trace de qui les avait etablis. C'est
--  precisement ce qu'une contestation met en cause.
--
--  POURQUOI ALTER PLUTOT QUE REECRIRE. Ces deux fonctions calculent les
--  empreintes du journal. Retranscrire leur corps pour y qualifier digest
--  serait risquer d'en changer le resultat — et une empreinte qui change,
--  c'est un journal qui se declare altere. On fixe donc leur search_path sans
--  toucher a une ligne de leur logique.
-- ===========================================================================

ALTER FUNCTION audit.chainer()         SET search_path = audit, app, public, pg_catalog;
ALTER FUNCTION audit.verifier_chaine() SET search_path = audit, app, public, pg_catalog;

-- horodatage_canonique n'appelle ni digest ni unaccent, mais elle participe au
-- meme calcul : on lui donne le meme chemin, pour que les trois se comportent
-- de facon identique quel que soit l'appelant.
ALTER FUNCTION audit.horodatage_canonique(timestamptz)
    SET search_path = audit, app, public, pg_catalog;
