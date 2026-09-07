-- ===========================================================================
--  La visite de suivi apres recensement
--
--  POURQUOI. Le jour du recensement, l'agent explique le dispositif a un gerant
--  qui decouvre tout : le QR, l'avis a venir, Wave. Il retient ce qu'il peut.
--  Quelques semaines plus tard, personne ne verifie que quoi que ce soit a ete
--  compris — et le premier signe du contraire est un impaye, trois mois apres,
--  quand il est trop tard pour expliquer sereinement.
--
--  Cette visite arrive AVANT le premier avis, quand la conversation est encore
--  neutre : personne ne doit rien, personne ne reclame rien.
--
--  LE DELAI EST UN PARAMETRE DE LA COMMUNE, pas une constante. Quatorze jours
--  au depart ; c'est le terrain qui dira si c'est trop tot ou trop tard, et la
--  mairie doit pouvoir le changer sans qu'on republie quoi que ce soit.
-- ===========================================================================

ALTER TABLE app.commune_parametre
    ADD COLUMN IF NOT EXISTS delai_suivi_recensement_jours integer NOT NULL DEFAULT 14;

COMMENT ON COLUMN app.commune_parametre.delai_suivi_recensement_jours IS
    'Delai en jours entre le recensement d''un commerce et sa visite de suivi. '
    'Mettre 0 desactive completement ce motif.';

-- ---------------------------------------------------------------------------
--  Le motif. Ajoute a la fin de l'enum : l'ordre de declaration d'un type
--  enumere ne se change pas sans le reconstruire, et rien ici ne depend de cet
--  ordre — la priorite est decidee dans la fonction de composition.
-- ---------------------------------------------------------------------------
ALTER TYPE app.motif_visite ADD VALUE IF NOT EXISTS 'suivi_recensement';
