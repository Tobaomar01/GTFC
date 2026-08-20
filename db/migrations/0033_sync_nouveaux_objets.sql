-- ===========================================================================
--  0033 — La synchronisation accepte les nouveaux objets taxables
--
--  CE QUI ÉTAIT CASSÉ
--
--  app.sync_operation.entite portait une liste fermée héritée du modèle
--  d'origine : commerce, visite, paiement, photo, commerce_taxe, position.
--
--  L'API et l'application mobile ont été élargies aux dispositifs
--  d'affichage et aux chantiers, mais la base, elle, refusait la ligne de
--  journal — et comme cette écriture fait partie du traitement du lot, c'est
--  le LOT ENTIER qui repartait en erreur 400.
--
--  Le symptôme sur le terrain aurait été le pire possible : un agent
--  synchronise après une journée de recensement, voit « échec de
--  synchronisation », et ne peut rien y faire. Son travail reste dans la
--  file locale, apparemment perdu.
--
--  La contrainte a bien joué son rôle : elle a refusé une donnée que le
--  schéma ne connaissait pas, plutôt que de l'accepter en silence. C'est le
--  schéma qu'il fallait mettre à jour.
-- ===========================================================================

ALTER TABLE app.sync_operation DROP CONSTRAINT IF EXISTS sync_op_entite;

ALTER TABLE app.sync_operation ADD CONSTRAINT sync_op_entite CHECK (
    entite = ANY (ARRAY[
        'commerce', 'visite', 'paiement', 'photo', 'commerce_taxe', 'position',
        -- Ajoutés avec le modèle « redevable » :
        'affichage',   -- enseignes, auvents, panneaux publicitaires
        'chantier',    -- occupation temporaire du domaine public
        'redevable'    -- réservé : la création de redevable depuis le terrain
                       -- passe aujourd'hui par le déclencheur du commerce,
                       -- mais l'application pourra l'envoyer explicitement.
    ]::text[])
);

COMMENT ON CONSTRAINT sync_op_entite ON app.sync_operation IS
'Liste fermée des entités synchronisables. À élargir AVANT de déployer une application mobile qui en enverrait une nouvelle : sinon le lot entier est refusé et l''agent voit « échec de synchronisation » sans recours.';

-- ---------------------------------------------------------------------------
-- Index de reprise
--
--  traiterAffichage() et traiterChantier() cherchent si l'identifiant local
--  a déjà été traité, pour ne pas créer deux panneaux quand un lot est
--  rejoué avec un nouvel identifiant de lot. Sans index, cette recherche
--  balaie toute la table à chaque opération de chaque lot.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_sync_op_reprise
    ON app.sync_operation (commune_id, entite, identifiant_local)
    WHERE statut = 'traite';
