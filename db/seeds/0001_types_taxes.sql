-- ===========================================================================
--  SEED 0001 — Les 5 types de taxes (référentiel global)
--
--  Ces définitions-ci ne sont PAS factices : ce sont les taxes locales
--  effectivement citées dans le cahier des charges. Ce qui est provisoire,
--  ce sont les MONTANTS, définis dans le seed 0004.
--
--  Idempotent : relançable sans effet de bord.
-- ===========================================================================

INSERT INTO ref.type_taxe (
    code, libelle, libelle_court, description, base_legale,
    mode_calcul_defaut, periodicite_defaut,
    conditionnelle, condition_libelle,
    parametre_requis, parametre_unite, ordre_affichage
) VALUES

('patente',
 'Patente professionnelle',
 'Patente',
 'Taxe due par toute personne exerçant une activité commerciale, industrielle ou artisanale sur le territoire communal.',
 'À_REMPLACER — référence du code général des impôts / délibération',
 'par_categorie', 'annuelle',
 false, NULL,
 NULL, NULL, 10),

('todp',
 'Taxe d''occupation du domaine public',
 'TODP',
 'Due lorsque le commerce déborde sur le trottoir ou la voie publique. Calculée au mètre carré occupé, d''après la mesure et la photo prises par l''agent.',
 'À_REMPLACER — référence de la délibération',
 'par_m2', 'mensuelle',
 true, 'Uniquement si un débordement sur le domaine public est constaté et mesuré',
 'surface_m2', 'm²', 20),

('teom',
 'Taxe d''enlèvement des ordures ménagères',
 'TEOM',
 'Contribution au service communal de collecte des déchets.',
 'À_REMPLACER — référence de la délibération',
 'par_categorie', 'mensuelle',
 false, NULL,
 NULL, NULL, 30),

('droit_place',
 'Droit de place sur les marchés',
 'Droit de place',
 'Redevance due par les occupants d''un emplacement sur un marché communal.',
 'À_REMPLACER — référence de la délibération',
 'par_jour', 'mensuelle',
 true, 'Uniquement pour les commerces rattachés à un marché communal',
 'nb_jours', 'jour', 40),

('enseigne',
 'Taxe sur les enseignes et publicités',
 'Enseignes',
 'Due au titre des enseignes, panneaux et supports publicitaires apposés sur la devanture.',
 'À_REMPLACER — référence de la délibération',
 'par_m2', 'annuelle',
 true, 'Uniquement si une enseigne est présente et mesurée',
 'surface_m2', 'm²', 50)

ON CONFLICT (code) DO UPDATE SET
    libelle            = EXCLUDED.libelle,
    libelle_court      = EXCLUDED.libelle_court,
    description        = EXCLUDED.description,
    mode_calcul_defaut = EXCLUDED.mode_calcul_defaut,
    periodicite_defaut = EXCLUDED.periodicite_defaut,
    conditionnelle     = EXCLUDED.conditionnelle,
    condition_libelle  = EXCLUDED.condition_libelle,
    parametre_requis   = EXCLUDED.parametre_requis,
    parametre_unite    = EXCLUDED.parametre_unite,
    ordre_affichage    = EXCLUDED.ordre_affichage;

DO $$
BEGIN
    RAISE NOTICE '[seed 0001] % types de taxes enregistrés',
        (SELECT count(*) FROM ref.type_taxe);
END
$$;
