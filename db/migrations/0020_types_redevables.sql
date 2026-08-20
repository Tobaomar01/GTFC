-- ===========================================================================
--  0020 — Types énumérés du modèle « redevable »
--
--  Ce fichier ne contient QUE des créations et extensions de types.
--
--  Raison : PostgreSQL interdit d'utiliser une valeur d'énumération ajoutée
--  par ALTER TYPE ... ADD VALUE dans la MÊME transaction que l'ajout. Comme
--  migrate.sh applique chaque fichier dans une transaction unique, mélanger
--  l'ajout et l'usage ferait échouer la migration avec un message obscur
--  (« unsafe use of new value »). Les valeurs sont donc déclarées ici, et
--  utilisées à partir de 0021.
-- ===========================================================================

DO $$
BEGIN

-- --- Nature du redevable ---------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'type_redevable') THEN
    CREATE TYPE app.type_redevable AS ENUM (
        'personne_physique',   -- commerçant, artisan, profession libérale
        'personne_morale'      -- société, régie publicitaire, opérateur télécom
    );
END IF;

-- --- Familles d'objets taxables -------------------------------------------
-- Un redevable porte 0..n objets de chaque famille. La facture les consolide.
IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'type_objet_taxable') THEN
    CREATE TYPE app.type_objet_taxable AS ENUM (
        'commerce',
        'affichage',           -- enseigne, auvent, panneau publicitaire
        'chantier'             -- occupation temporaire du domaine public
    );
END IF;

-- --- Couverture du recensement, rue par rue -------------------------------
IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'statut_couverture') THEN
    CREATE TYPE app.statut_couverture AS ENUM (
        'non_commencee',
        'en_cours',
        'terminee'
    );
END IF;

-- --- Cycle de vie d'un chantier -------------------------------------------
IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'statut_chantier') THEN
    CREATE TYPE app.statut_chantier AS ENUM (
        'en_cours',
        'prolonge',            -- l'agent a constaté une poursuite au-delà du terme
        'termine',
        'introuvable'          -- repassage : plus rien sur place, sans constat de fin
    );
END IF;

-- --- Contestation ----------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'statut_contestation') THEN
    CREATE TYPE app.statut_contestation AS ENUM (
        'soumise',
        'en_instruction',
        'visite_demandee',     -- le superviseur veut un constat terrain
        'transmise_receveur',
        'acceptee',            -- dossier corrigé
        'rejetee',             -- motivée, notifiée au redevable
        'retiree'              -- le redevable se désiste
    );
END IF;

-- --- Vérification du numéro de téléphone ----------------------------------
IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'statut_telephone') THEN
    CREATE TYPE app.statut_telephone AS ENUM (
        'non_verifie',         -- saisi mais jamais confirmé : redevable injoignable
        'verifie',
        'refuse',              -- le redevable a refusé la vérification
        'invalide'             -- le code n'est jamais arrivé, numéro erroné
    );
END IF;

END
$$;

-- ---------------------------------------------------------------------------
-- Extensions d'énumérations existantes
-- ---------------------------------------------------------------------------
-- IF NOT EXISTS rend la migration rejouable sans erreur.
ALTER TYPE audit.action_audit ADD VALUE IF NOT EXISTS 'contestation';
ALTER TYPE audit.action_audit ADD VALUE IF NOT EXISTS 'verification_telephone';
ALTER TYPE audit.action_audit ADD VALUE IF NOT EXISTS 'acces_portail';
ALTER TYPE audit.action_audit ADD VALUE IF NOT EXISTS 'changement_telephone';

-- Un dispositif d'affichage se photographie comme une façade entière, pas
-- comme un objet isolé : sans le contexte, impossible de vérifier la surface.
ALTER TYPE app.type_photo ADD VALUE IF NOT EXISTS 'facade';
ALTER TYPE app.type_photo ADD VALUE IF NOT EXISTS 'chantier';

-- Le recensement d'un panneau ou d'un chantier n'est pas la visite d'un
-- commerce : le distinguer permet de mesurer l'effort réel des agents.
ALTER TYPE app.resultat_visite ADD VALUE IF NOT EXISTS 'recensement_affichage';
ALTER TYPE app.resultat_visite ADD VALUE IF NOT EXISTS 'recensement_chantier';
ALTER TYPE app.resultat_visite ADD VALUE IF NOT EXISTS 'constat_fin_chantier';
