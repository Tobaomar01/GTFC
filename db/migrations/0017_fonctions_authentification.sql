-- ===========================================================================
--  0017 — Fonctions d'accès pour les chemins « avant authentification »
--
--  Problème résolu ici : les politiques RLS de la migration 0014 exigent que
--  l'API annonce sa commune (gtfc.commune_id) avant de lire quoi que ce soit.
--  Or, au moment de la connexion, on ne connaît pas encore la commune de
--  l'utilisateur — c'est justement ce qu'on cherche. Sans dérogation,
--  l'authentification serait impossible.
--
--  La dérogation est accordée ici, et NULLE PART AILLEURS, par un petit
--  nombre de fonctions SECURITY DEFINER : elles s'exécutent avec les droits
--  de leur propriétaire (postgres) et ne sont donc pas filtrées par le RLS.
--
--  Trois garde-fous les rendent sûres :
--    1. chacune ne renvoie QUE les colonnes strictement nécessaires ;
--    2. chacune fixe explicitement son search_path (sinon un schéma
--       malveillant en tête de chemin pourrait détourner un appel) ;
--    3. l'exécution est accordée au seul rôle applicatif.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Recherche du compte au moment de la connexion
--    Renvoie l'empreinte du mot de passe, pas le mot de passe : la
--    comparaison bcrypt est faite par l'API.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.auth_trouver_utilisateur(p_telephone text)
RETURNS TABLE (
    id                  uuid,
    commune_id          uuid,
    commune_slug        text,
    commune_nom         text,
    nom_complet         text,
    role                app.role_utilisateur,
    mot_de_passe_hash   text,
    doit_changer_mdp    boolean,
    actif               boolean,
    tentatives_echouees smallint,
    verrouille_jusqu_a  timestamptz,
    appareil_id         text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = app, ref, public
AS $$
    SELECT u.id, u.commune_id, c.slug, c.nom, u.nom_complet, u.role,
           u.mot_de_passe_hash, u.doit_changer_mdp, u.actif,
           u.tentatives_echouees, u.verrouille_jusqu_a, u.appareil_id
    FROM app.utilisateur u
    LEFT JOIN app.commune c ON c.id = u.commune_id
    WHERE u.telephone = p_telephone
      AND u.archive_le IS NULL
    LIMIT 1;
$$;

-- ---------------------------------------------------------------------------
-- 2. Suite d'une tentative de connexion
--    Verrouillage progressif après N échecs, remise à zéro au succès.
--    Le journal audit.connexion est alimenté dans la foulée : une tentative
--    infructueuse laisse une trace même si aucun compte ne correspond.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.auth_enregistrer_tentative(
    p_utilisateur_id  uuid,
    p_telephone       text,
    p_reussie         boolean,
    p_motif_echec     text        DEFAULT NULL,
    p_ip              inet        DEFAULT NULL,
    p_user_agent      text        DEFAULT NULL,
    p_appareil_id     text        DEFAULT NULL,
    p_appareil_modele text        DEFAULT NULL,
    p_version_app     text        DEFAULT NULL,
    p_max_tentatives  integer     DEFAULT 5,
    p_verrou_minutes  integer     DEFAULT 15
)
RETURNS TABLE (verrouille boolean, tentatives smallint)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = app, audit, public
AS $$
DECLARE
    v_commune_id  uuid;
    v_tentatives  smallint := 0;
    v_verrouille  boolean  := false;
    v_inhabituel  boolean  := false;
    v_appareil_connu text;
BEGIN
    IF p_utilisateur_id IS NOT NULL THEN
        SELECT u.commune_id, u.appareil_id
          INTO v_commune_id, v_appareil_connu
          FROM app.utilisateur u WHERE u.id = p_utilisateur_id;

        v_inhabituel := p_appareil_id IS NOT NULL
                        AND v_appareil_connu IS NOT NULL
                        AND v_appareil_connu <> p_appareil_id;

        IF p_reussie THEN
            UPDATE app.utilisateur
               SET tentatives_echouees = 0,
                   verrouille_jusqu_a  = NULL,
                   derniere_connexion  = now(),
                   derniere_ip         = p_ip,
                   appareil_id         = coalesce(p_appareil_id, appareil_id),
                   appareil_modele     = coalesce(p_appareil_modele, appareil_modele),
                   version_app         = coalesce(p_version_app, version_app)
             WHERE id = p_utilisateur_id;
        ELSE
            UPDATE app.utilisateur
               SET tentatives_echouees = tentatives_echouees + 1,
                   verrouille_jusqu_a  = CASE
                       WHEN tentatives_echouees + 1 >= p_max_tentatives
                       THEN now() + (p_verrou_minutes || ' minutes')::interval
                       ELSE verrouille_jusqu_a END
             WHERE id = p_utilisateur_id
            RETURNING tentatives_echouees, verrouille_jusqu_a IS NOT NULL
                 INTO v_tentatives, v_verrouille;
        END IF;
    END IF;

    INSERT INTO audit.connexion (
        commune_id, utilisateur_id, telephone_saisi, reussie, motif_echec,
        ip, user_agent, appareil_id, appareil_modele, version_app, appareil_inhabituel
    ) VALUES (
        v_commune_id, p_utilisateur_id, p_telephone, p_reussie, p_motif_echec,
        p_ip, p_user_agent, p_appareil_id, p_appareil_modele, p_version_app, v_inhabituel
    );

    RETURN QUERY SELECT v_verrouille, v_tentatives;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Sessions : création, recherche, révocation
--    Le jeton de rafraîchissement n'est jamais stocké en clair — seule son
--    empreinte SHA-256 l'est, calculée par l'API.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.auth_creer_session(
    p_utilisateur_id uuid,
    p_jeton_hash     text,
    p_expire_le      timestamptz,
    p_appareil_id    text DEFAULT NULL,
    p_appareil_modele text DEFAULT NULL,
    p_ip             inet DEFAULT NULL,
    p_user_agent     text DEFAULT NULL
)
RETURNS uuid
LANGUAGE sql SECURITY DEFINER
SET search_path = app, public
AS $$
    INSERT INTO app.session (utilisateur_id, jeton_hash, expire_le,
                             appareil_id, appareil_modele, ip, user_agent)
    VALUES (p_utilisateur_id, p_jeton_hash, p_expire_le,
            p_appareil_id, p_appareil_modele, p_ip, p_user_agent)
    RETURNING id;
$$;

CREATE OR REPLACE FUNCTION app.auth_trouver_session(p_jeton_hash text)
RETURNS TABLE (
    session_id       uuid,
    utilisateur_id   uuid,
    commune_id       uuid,
    commune_slug     text,
    nom_complet      text,
    role             app.role_utilisateur,
    actif            boolean,
    doit_changer_mdp boolean,
    expire_le        timestamptz,
    revoque_le       timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = app, public
AS $$
    SELECT s.id, u.id, u.commune_id, c.slug, u.nom_complet, u.role,
           u.actif, u.doit_changer_mdp, s.expire_le, s.revoque_le
    FROM app.session s
    JOIN app.utilisateur u ON u.id = s.utilisateur_id
    LEFT JOIN app.commune c ON c.id = u.commune_id
    WHERE s.jeton_hash = p_jeton_hash
      AND u.archive_le IS NULL
    LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION app.auth_revoquer_session(p_jeton_hash text, p_motif text DEFAULT 'deconnexion')
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = app, public
AS $$
DECLARE nb integer;
BEGIN
    UPDATE app.session
       SET revoque_le = now(), motif_revocation = p_motif
     WHERE jeton_hash = p_jeton_hash AND revoque_le IS NULL;
    GET DIAGNOSTICS nb = ROW_COUNT;
    RETURN nb;
END;
$$;

-- Rotation : on révoque l'ancien jeton et on en crée un nouveau dans la même
-- transaction. Un jeton de rafraîchissement ne sert donc qu'une seule fois ;
-- s'il réapparaît ensuite, c'est qu'il a été volé.
CREATE OR REPLACE FUNCTION app.auth_rafraichir_session(
    p_ancien_hash text,
    p_nouveau_hash text,
    p_expire_le   timestamptz,
    p_ip          inet DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = app, public
AS $$
DECLARE
    v_session app.session;
    v_id uuid;
BEGIN
    SELECT * INTO v_session FROM app.session WHERE jeton_hash = p_ancien_hash;
    IF NOT FOUND OR v_session.revoque_le IS NOT NULL OR v_session.expire_le < now() THEN
        RETURN NULL;
    END IF;

    UPDATE app.session
       SET revoque_le = now(), motif_revocation = 'rotation'
     WHERE id = v_session.id;

    INSERT INTO app.session (utilisateur_id, jeton_hash, expire_le,
                             appareil_id, appareil_modele, ip, user_agent)
    VALUES (v_session.utilisateur_id, p_nouveau_hash, p_expire_le,
            v_session.appareil_id, v_session.appareil_modele,
            coalesce(p_ip, v_session.ip), v_session.user_agent)
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Résolution du sous-domaine -> commune
--    Appelée par le dashboard avant toute authentification, pour afficher le
--    nom et le logo de la mairie sur l'écran de connexion.
--    Ne renvoie que des informations publiques.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.public_commune_par_slug(p_slug text)
RETURNS TABLE (
    id uuid, code text, slug text, nom text,
    logo_url text, couleur_principale text,
    centre_longitude double precision, centre_latitude double precision
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = app, public
AS $$
    SELECT c.id, c.code, c.slug, c.nom, c.logo_url, c.couleur_principale,
           ST_X(c.centre), ST_Y(c.centre)
    FROM app.commune c
    WHERE c.slug = p_slug AND c.actif AND c.archive_le IS NULL
    LIMIT 1;
$$;

-- ---------------------------------------------------------------------------
-- 5. Scan public d'un QR code
--
--    N'importe qui peut scanner un sticker avec l'appareil photo de son
--    téléphone. La page publique doit donc afficher quelque chose d'utile
--    SANS rien divulguer de sensible : ni le nom du gérant, ni son numéro,
--    ni le détail des taxes, ni le montant dû.
--    On se limite au strict nécessaire pour prouver qu'un commerce est
--    enregistré auprès de la commune.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.public_commerce_par_qr(
    p_jeton text,
    p_ip    inet DEFAULT NULL,
    p_user_agent text DEFAULT NULL
)
RETURNS TABLE (
    code          text,
    enseigne      text,
    categorie     text,
    quartier      text,
    commune       text,
    enregistre_le date,
    qr_actif      boolean
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = app, ref, public
AS $$
DECLARE
    v_qr app.qr_code;
BEGIN
    SELECT * INTO v_qr FROM app.qr_code q WHERE q.jeton = p_jeton;
    IF NOT FOUND THEN
        RETURN;
    END IF;

    UPDATE app.qr_code
       SET nb_scans = nb_scans + 1, dernier_scan_le = now()
     WHERE id = v_qr.id;

    INSERT INTO app.qr_scan (commune_id, qr_code_id, commerce_id, ip, user_agent, source)
    VALUES (v_qr.commune_id, v_qr.id, v_qr.commerce_id, p_ip, p_user_agent, 'navigateur');

    RETURN QUERY
    SELECT c.code, c.enseigne, cat.libelle, q.nom, m.nom,
           c.date_recensement, v_qr.actif
    FROM app.commerce c
    JOIN ref.categorie_commerce cat ON cat.id = c.categorie_id
    JOIN app.quartier q ON q.id = c.quartier_id
    JOIN app.commune  m ON m.id = c.commune_id
    WHERE c.id = v_qr.commerce_id AND c.archive_le IS NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Vérification publique d'une quittance
--    Le QR imprimé sur la quittance papier permet à un commerçant — ou à un
--    contrôleur — de s'assurer qu'elle n'a pas été fabriquée de toutes pièces.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.public_verifier_quittance(p_jeton text)
RETURNS TABLE (
    valide       boolean,
    numero       text,
    commerce_code text,
    montant      numeric,
    paye_le      timestamptz,
    commune      text
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = app, public
AS $$
BEGIN
    UPDATE app.quittance SET nb_verifications = nb_verifications + 1
     WHERE jeton_verification = p_jeton;

    RETURN QUERY
    SELECT (p.annule_le IS NULL), q.numero, c.code, p.montant, p.paye_le, m.nom
    FROM app.quittance q
    JOIN app.paiement p ON p.id = q.paiement_id
    JOIN app.commerce c ON c.id = q.commerce_id
    JOIN app.commune  m ON m.id = q.commune_id
    WHERE q.jeton_verification = p_jeton;
END;
$$;

-- ---------------------------------------------------------------------------
-- Droits : ces fonctions sont le seul contournement autorisé du RLS.
-- On les rend exécutables par le rôle applicatif et par personne d'autre.
-- ---------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gtfc_app') THEN
        RETURN;
    END IF;
    FOREACH f IN ARRAY ARRAY[
        'app.auth_trouver_utilisateur(text)',
        'app.auth_enregistrer_tentative(uuid,text,boolean,text,inet,text,text,text,text,integer,integer)',
        'app.auth_creer_session(uuid,text,timestamptz,text,text,inet,text)',
        'app.auth_trouver_session(text)',
        'app.auth_revoquer_session(text,text)',
        'app.auth_rafraichir_session(text,text,timestamptz,inet)',
        'app.public_commune_par_slug(text)',
        'app.public_commerce_par_qr(text,inet,text)',
        'app.public_verifier_quittance(text)'
    ] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO gtfc_app', f);
    END LOOP;
END
$$;
