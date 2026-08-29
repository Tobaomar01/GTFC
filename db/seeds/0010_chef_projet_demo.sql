-- ===========================================================================
--  SEED 0010 — Compte de démonstration : chef de projet
--
--  Le rôle existait en base depuis la migration 0043, l'API le gardait, le
--  registre des dérogations du tableau de bord lui était réservé — et aucun
--  compte ne le portait. Le mécanisme entier était donc inaccessible : sur
--  une installation neuve, personne ne pouvait accorder une exonération ni
--  valider un montant forcé.
--
--  Le chef de projet est HORS de la hiérarchie. Il détient les décisions
--  dérogatoires que l'administrateur n'a pas, et n'a pas la main sur le
--  barème, que l'administrateur détient. C'est cette séparation qui empêche
--  une seule personne de fixer la dette et de la remettre.
--
--  Mot de passe : GtfcDemo2026!, comme les autres comptes de démonstration.
--  Voir l'avertissement de mise en production dans le seed 0005.
-- ===========================================================================
DO $$
DECLARE
    v_commune_id uuid;
    v_hash       text;
BEGIN
    SELECT id INTO v_commune_id FROM app.commune WHERE code = 'GTFC';
    IF v_commune_id IS NULL THEN
        RAISE NOTICE '[seed 0010] commune GTFC absente — compte non créé';
        RETURN;
    END IF;

    v_hash := crypt('GtfcDemo2026!', gen_salt('bf', 12));

    INSERT INTO app.utilisateur (
        commune_id, matricule, nom, prenom, telephone, email,
        role, mot_de_passe_hash, doit_changer_mdp, actif
    ) VALUES (
        v_commune_id, 'DEMO-CP01', 'À_REMPLACER', 'Chef de projet',
        '+221700000004', 'chefprojet@example.sn',
        'chef_projet', v_hash, true, true
    )
    ON CONFLICT (telephone) WHERE archive_le IS NULL DO NOTHING;

    RAISE NOTICE '[seed 0010] chef de projet : +221700000004 (GtfcDemo2026!)';
END $$;
