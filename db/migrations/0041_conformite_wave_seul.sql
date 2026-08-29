-- 0041 — Wave, unique moyen de paiement (FR-025b, FR-030)
--
-- Décision du commanditaire : zéro espèce. C'est dans la collecte que naît
-- le risque de détournement par les agents ; supprimer l'encaissement
-- supprime le risque à la racine, là où un contrôle a posteriori ne le rend
-- que visible.
--
-- Le dispositif de traçabilité des espèces était bien conçu — vue des
-- sommes non versées, contrainte nominative. Il devient sans objet.
--
-- Les valeurs de l'énumération ne sont pas retirées : PostgreSQL ne le
-- permet pas sans recréer le type, et d'anciennes lignes peuvent les
-- porter. La contrainte CHECK ferme la porte pour toute écriture nouvelle,
-- ce qui suffit et se relit sans ambiguïté.

-- 1. Fermer le moyen de paiement
ALTER TABLE app.paiement DROP CONSTRAINT IF EXISTS paiement_especes_tracable;
ALTER TABLE app.paiement DROP CONSTRAINT IF EXISTS paiement_moyen_wave_seulement;
ALTER TABLE app.paiement ADD  CONSTRAINT paiement_moyen_wave_seulement
    CHECK (moyen = 'wave'::app.moyen_paiement);

COMMENT ON CONSTRAINT paiement_moyen_wave_seulement ON app.paiement IS
'Wave est l''unique moyen du pilote. Ajouter un moyen exige une migration, donc une décision explicite (FR-025b).';

-- 2. Retirer la mécanique de caisse, désormais sans objet
DROP VIEW  IF EXISTS app.v_especes_non_versees;
DROP INDEX IF EXISTS app.idx_paiement_non_verse;
DROP INDEX IF EXISTS app.idx_paiement_agent;

-- Les colonnes sont conservées mais neutralisées : les supprimer ferait
-- perdre l'historique des encaissements déjà enregistrés en démonstration.
COMMENT ON COLUMN app.paiement.encaisse_par IS
'OBSOLÈTE depuis 0041 — plus aucun encaissement par agent. Conservée pour l''historique.';
COMMENT ON COLUMN app.paiement.verse_en_caisse_le IS
'OBSOLÈTE depuis 0041 — plus de caisse à rapprocher. Conservée pour l''historique.';
COMMENT ON COLUMN app.paiement.verse_recu_par IS
'OBSOLÈTE depuis 0041. Conservée pour l''historique.';

-- 3. Le paramètre communal ne peut plus autoriser les espèces
ALTER TABLE app.commune_parametre
    ALTER COLUMN encaissement_especes_autorise SET DEFAULT false;
UPDATE app.commune_parametre SET encaissement_especes_autorise = false;
ALTER TABLE app.commune_parametre DROP CONSTRAINT IF EXISTS parametre_especes_interdites;
ALTER TABLE app.commune_parametre ADD  CONSTRAINT parametre_especes_interdites
    CHECK (encaissement_especes_autorise = false);

COMMENT ON COLUMN app.commune_parametre.encaissement_especes_autorise IS
'Forcé à false depuis 0041. Le paramètre subsiste pour ne pas casser les lectures existantes.';
