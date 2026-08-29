-- 0050 — Consultation USSD, franchissement contrôlé de l'isolation
--
-- Défaut révélé en démarrant l'API : le canal USSD ne reconnaissait aucun
-- redevable. La cause est structurelle, pas accidentelle.
--
-- L'isolation multi-communes exige un contexte de commune à chaque requête
-- (FR-046b). Or l'USSD est par nature INTER-communes : c'est le numéro
-- appelant qui détermine la commune, on ne peut donc pas la connaître avant
-- d'avoir interrogé.
--
-- Une fonction SECURITY DEFINER franchit l'isolation de façon étroite et
-- délibérée. Elle ne rend PAS l'isolation poreuse :
--   — elle exige le numéro exact, elle ne liste rien ;
--   — elle ne retourne que ce que l'appelant sait déjà de lui-même : son
--     solde et son échéance, aucune donnée d'identité ;
--   — elle ignore les numéros non vérifiés, exactement comme les inconnus.
--
-- Restriction d'exploitation, à poser au déploiement : la route /ussd ne
-- doit être joignable que depuis les adresses de la passerelle opérateur.
-- Sans cela, quiconque atteint l'API pourrait éprouver des numéros au
-- hasard pour découvrir lesquels sont redevables.

CREATE OR REPLACE FUNCTION app.consultation_ussd(p_telephone text)
RETURNS TABLE (
    redevable_id     uuid,
    commune_id       uuid,
    solde_du         numeric,
    date_exigibilite date,
    nb_objets        integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = app, ref, pg_temp
AS $$
    SELECT r.id, r.commune_id, r.solde_du,
           (SELECT min(a.date_exigibilite)
              FROM app.avis_imposition a
             WHERE a.redevable_id = r.id
               AND a.annule_le IS NULL
               AND a.statut <> 'brouillon'
               AND a.montant_restant > 0),
           r.nb_objets_taxables
      FROM app.redevable r
     WHERE r.telephone = p_telephone
       AND r.statut_telephone = 'verifie'
       AND r.archive_le IS NULL
     LIMIT 1;
$$;

COMMENT ON FUNCTION app.consultation_ussd IS
'Consultation USSD. Franchit l''isolation multi-communes de façon étroite : exige le numéro exact, ne retourne que le solde et l''échéance, ignore les numéros non vérifiés (FR-067, FR-068).';

REVOKE ALL ON FUNCTION app.consultation_ussd(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.consultation_ussd(text) TO gtfc_app;
