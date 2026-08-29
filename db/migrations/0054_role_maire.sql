-- 0054 — Le maire, côté municipalité
--
-- Deux organisations travaillent sur ce dispositif, et jusqu'ici une seule
-- était représentée dans les rôles.
--
--   · côté EXPLOITANT : l'équipe projet. Le chef de projet y détient les
--     décisions dérogatoires — montant forcé, exonération ;
--   · côté MUNICIPALITÉ : le maire, à qui la recette appartient et qui doit
--     pouvoir la constater sans dépendre d'un compte prêté.
--
-- Le maire consulte. Il ne recense pas, n'encaisse pas, ne remet pas de dette
-- et ne modifie pas le barème — le barème relève d'une délibération du
-- conseil municipal, pas d'un écran. Ce rôle est donc en LECTURE SEULE, et
-- c'est l'API qui le garantit d'un seul endroit plutôt que route par route :
-- un garde oublié sur une route neuve rouvrirait la porte en silence.
--
-- Un nouveau libellé d'énumération ne peut pas être utilisé dans la même
-- transaction que sa création. D'où une migration à part, sans autre contenu.

ALTER TYPE app.role_utilisateur ADD VALUE IF NOT EXISTS 'maire';
