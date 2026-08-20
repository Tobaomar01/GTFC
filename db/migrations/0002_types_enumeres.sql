-- ===========================================================================
--  0002 — Types énumérés
--
--  Choix : ENUM pour les ensembles FERMÉS (un statut de paiement ne s'invente
--  pas), tables de référence pour les ensembles OUVERTS que chaque commune
--  peut personnaliser (catégories de commerces, types d'emplacement...).
-- ===========================================================================

DO $$
BEGIN

-- --- Rôles ---------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'role_utilisateur') THEN
    CREATE TYPE app.role_utilisateur AS ENUM (
        'agent',            -- collecteur de terrain, app Android
        'superviseur',      -- encadre les agents d'une ou plusieurs zones
        'admin_commune',    -- administrateur de la mairie, dashboard complet
        'super_admin'       -- exploitant de la plateforme, voit toutes les communes
    );
END IF;

-- --- Commerces -----------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'statut_commerce') THEN
    CREATE TYPE app.statut_commerce AS ENUM (
        'actif',
        'ferme_temporaire',   -- rideau baissé le jour du passage
        'ferme_definitif',    -- cessation d'activité constatée
        'introuvable',        -- adresse visitée, commerce absent
        'archive'
    );
END IF;

IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'type_photo') THEN
    CREATE TYPE app.type_photo AS ENUM (
        'devanture',          -- obligatoire à l'enregistrement
        'trottoir_todp',      -- preuve de l'occupation du domaine public
        'enseigne',
        'document',           -- patente existante, pièce d'identité du gérant
        'autre'
    );
END IF;

-- --- Fiscalité -----------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'mode_calcul_taxe') THEN
    CREATE TYPE app.mode_calcul_taxe AS ENUM (
        'forfait',            -- montant fixe, identique pour tous
        'par_categorie',      -- montant fixe dépendant de la catégorie de commerce
        'par_m2',             -- montant unitaire × surface (TODP, enseignes)
        'par_tranche',        -- grille par tranches de surface ou de chiffre d'affaires
        'par_jour'            -- droit de place journalier
    );
END IF;

IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'periodicite') THEN
    CREATE TYPE app.periodicite AS ENUM (
        'journaliere',
        'mensuelle',
        'trimestrielle',
        'semestrielle',
        'annuelle'
    );
END IF;

IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'statut_avis') THEN
    CREATE TYPE app.statut_avis AS ENUM (
        'brouillon',            -- calculé, pas encore notifié au commerçant
        'emis',                 -- demande de paiement envoyée
        'partiellement_paye',
        'paye',
        'annule',
        'exonere'
    );
END IF;

IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'statut_fiscal') THEN
    CREATE TYPE app.statut_fiscal AS ENUM (
        'a_jour',     -- vert  sur la carte
        'partiel',    -- orange
        'impaye',     -- rouge
        'exonere',    -- gris
        'inconnu'     -- aucun avis émis pour la période
    );
END IF;

-- --- Paiements -----------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'moyen_paiement') THEN
    CREATE TYPE app.moyen_paiement AS ENUM (
        'wave',
        'especes',       -- encaissement par l'agent, à limiter
        'virement',
        'cheque',
        'compensation'   -- régularisation administrative
    );
END IF;

IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'statut_transaction') THEN
    CREATE TYPE app.statut_transaction AS ENUM (
        'initiee',       -- lien de paiement créé
        'en_attente',    -- le commerçant a ouvert le lien
        'reussie',
        'echouee',
        'expiree',
        'annulee',
        'remboursee'
    );
END IF;

-- --- Terrain et synchronisation -------------------------------------------
IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'resultat_visite') THEN
    CREATE TYPE app.resultat_visite AS ENUM (
        'enregistrement',       -- création d'un nouveau commerce
        'mise_a_jour',
        'controle',             -- passage de contrôle sans modification
        'encaissement',
        'ferme',
        'refus',                -- le commerçant refuse le contrôle
        'introuvable'
    );
END IF;

IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'statut_sync') THEN
    CREATE TYPE app.statut_sync AS ENUM (
        'en_attente',
        'traite',
        'conflit',      -- la fiche a été modifiée côté serveur entre-temps
        'rejete'        -- données invalides
    );
END IF;

-- --- Audit ----------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'action_audit') THEN
    CREATE TYPE audit.action_audit AS ENUM (
        'creation',
        'modification',
        'archivage',
        'consultation',
        'connexion',
        'deconnexion',
        'connexion_echouee',
        'paiement',
        'exoneration',
        'export',
        'impression_quittance',
        'changement_bareme'
    );
END IF;

END
$$;
