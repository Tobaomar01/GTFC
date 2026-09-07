-- ===========================================================================
--  Droits de l'application sur la feuille de route
--
--  Les migrations 0064 et 0065 creaient les tables, la vue et la fonction sans
--  les accorder a `gtfc_app`. L'API se connecte avec ce role : toutes les
--  routes repondaient « permission denied for table feuille_route ».
--
--  Invisible a la lecture : le SQL etait correct, les tables existaient, la
--  fonction tournait parfaitement en tant que postgres. Seul un appel par
--  l'application l'a montre.
-- ===========================================================================

GRANT SELECT, INSERT, UPDATE ON app.feuille_route       TO gtfc_app;
GRANT SELECT, INSERT, UPDATE ON app.feuille_route_ligne TO gtfc_app;
GRANT SELECT                  ON app.v_situation_paiement TO gtfc_app;
GRANT EXECUTE ON FUNCTION app.composer_feuille_route(uuid, date, uuid) TO gtfc_app;

-- Pas de DELETE, et c'est deliberé : une ligne de feuille de route ne se
-- supprime pas, elle se retire en disant qui, quand et pourquoi (FR-075).
-- Retirer le droit vaut mieux que compter sur la discipline du code.
