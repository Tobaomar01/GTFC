-- ===========================================================================
--  SEED 0014 — Quelques redevables au téléphone vérifié
--
--  Le portail du redevable ne s'ouvre qu'aux numéros VÉRIFIÉS : c'est la
--  règle, et elle est juste — un portail qui répondrait à un numéro non
--  vérifié permettrait d'énumérer les redevables de la commune en composant au
--  hasard.
--
--  Conséquence non voulue : aucun redevable de démonstration n'était vérifié,
--  et le portail ne pouvait donc être ni éprouvé, ni montré à la mairie. Une
--  fonctionnalité entière restait derrière une porte que rien n'ouvrait.
--
--  La vérification se fait normalement sur le terrain, par un agent qui fait
--  composer un code au commerçant. Ici on la simule pour cinq redevables, en
--  la traçant comme la base l'exige : sans date de vérification, elle refuse.
--
--  Idempotent. À NE PAS JOUER EN PRODUCTION : voir l'avertissement du seed
--  0005 sur les comptes de démonstration.
-- ===========================================================================
DO $$
DECLARE
    v_agent uuid;
    v_n     integer;
BEGIN
    SELECT id INTO v_agent FROM app.utilisateur
     WHERE role = 'agent' AND actif ORDER BY telephone LIMIT 1;

    WITH cibles AS (
        SELECT id FROM app.redevable
         WHERE archive_le IS NULL
           AND telephone IS NOT NULL
           AND statut_telephone <> 'verifie'
         ORDER BY code
         LIMIT 5
    )
    UPDATE app.redevable r
       SET statut_telephone     = 'verifie',
           telephone_verifie_le = now() - interval '20 days',
           telephone_verifie_par = v_agent
      FROM cibles c
     WHERE r.id = c.id;

    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE '[seed 0014] % redevable(s) au téléphone vérifié — le portail est ouvert pour eux', v_n;
END $$;
