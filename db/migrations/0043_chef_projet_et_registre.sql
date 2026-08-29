-- 0043 — Chef de projet et registre des décisions dérogatoires
--          (FR-020c à FR-020e, FR-020j, FR-020k, Constitution III)
--
-- Montants forcés et exonérations sont les deux façons d'effacer une dette.
-- Elles méritent la même surveillance : un registre commun, réservé à un
-- rôle qui n'existait pas — le chef de projet.
--
-- Ce rôle n'est pas « un superviseur en plus fort ». Il détient les
-- décisions dérogatoires, que le superviseur n'a jamais, et n'a pas la main
-- sur le barème, que l'administrateur détient. Un ordre hiérarchique serait
-- faux, et c'est ainsi qu'un super-administrateur finit par tout pouvoir.

ALTER TYPE app.role_utilisateur ADD VALUE IF NOT EXISTS 'chef_projet';
