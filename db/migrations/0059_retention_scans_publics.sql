-- 0059 — L'adresse IP d'un passant n'a pas à rester
--
-- Chaque lecture d'un QR code enregistre une ligne dans app.qr_scan, avec
-- l'adresse IP et le navigateur du lecteur. Pour un agent, la trace est
-- légitime et voulue : c'est une action professionnelle, attribuable.
--
-- Pour un PASSANT, non. La vue publique d'un sticker est ouverte à quiconque
-- pointe un téléphone sur une devanture. La personne n'est ni redevable, ni
-- agent, elle n'a aucun lien avec la commune — et son adresse IP, son
-- navigateur et l'horodatage étaient conservés sans terme.
--
-- La constitution est explicite : « les données personnelles collectées MUST
-- se limiter à ce qui est nécessaire à l'identification du redevable et au
-- recouvrement ». L'adresse d'un curieux n'est nécessaire ni à l'un ni à
-- l'autre. La loi 2008-12 ne dit pas autre chose.
--
-- Ce qu'on garde, et pourquoi. L'ÉVÉNEMENT reste : savoir qu'un sticker a été
-- lu, quand et sur quel commerce, sert aux statistiques et à détecter un
-- sticker arraché ou recopié. Ce sont les identifiants du lecteur qui
-- s'effacent. Une fenêtre courte subsiste avant l'effacement : sans elle, on
-- ne pourrait pas repérer une lecture massive et automatisée du registre.
--
-- Les scans d'AGENT ne sont pas touchés : l'action est professionnelle,
-- attribuable, et sa traçabilité est un principe du dispositif.

CREATE OR REPLACE FUNCTION app.anonymiser_scans_publics(p_jours integer DEFAULT 30)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_nb integer;
BEGIN
    UPDATE app.qr_scan
       SET ip = NULL,
           user_agent = NULL,
           geom = NULL
     WHERE utilisateur_id IS NULL
       AND scanne_le < now() - make_interval(days => p_jours)
       AND (ip IS NOT NULL OR user_agent IS NOT NULL OR geom IS NOT NULL);

    GET DIAGNOSTICS v_nb = ROW_COUNT;
    RETURN v_nb;
END;
$$;

COMMENT ON FUNCTION app.anonymiser_scans_publics IS
  'Efface l''adresse, le navigateur et la position des lectures ANONYMES de QR '
  'plus anciennes que la fenêtre donnée. L''événement subsiste ; le lecteur '
  'cesse d''être identifiable. Ne touche jamais aux scans d''un agent.';

GRANT EXECUTE ON FUNCTION app.anonymiser_scans_publics(integer) TO gtfc_app;

-- Le contrôle de conformité doit pouvoir répondre « oui » de lui-même, sans
-- qu'on aille lire le code du planificateur.
CREATE OR REPLACE VIEW app.v_conformite_vie_privee AS
 SELECT 'aucun suivi de position d''agent'::text AS controle,
        NOT EXISTS (
            SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'app'
               AND table_name ~ '^(position_agent|trace_agent|suivi_agent)$'
        ) AS conforme
UNION ALL
 SELECT 'aucune adresse de passant conservée au-delà de 30 jours'::text,
        NOT EXISTS (
            SELECT 1 FROM app.qr_scan
             WHERE utilisateur_id IS NULL
               AND scanne_le < now() - interval '30 days'
               AND (ip IS NOT NULL OR user_agent IS NOT NULL OR geom IS NOT NULL)
        )
UNION ALL
 SELECT 'aucun code d''accès conservé en clair'::text,
        NOT EXISTS (
            SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'app' AND table_name = 'code_acces'
               AND column_name IN ('code', 'code_clair', 'valeur')
        );

COMMENT ON VIEW app.v_conformite_vie_privee IS
  'Contrôles de protection des données que le système exerce sur lui-même. '
  'Toutes les lignes doivent être conformes avant la mise en service, et le '
  'rester : c''est un contrôle continu, pas une case cochée une fois.';

GRANT SELECT ON app.v_conformite_vie_privee TO gtfc_app;
