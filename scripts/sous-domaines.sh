#!/usr/bin/env bash
#
# Les noms que la plateforme sert. UNE seule source.
#
#   source scripts/sous-domaines.sh   # après avoir chargé APP_DOMAIN
#   echo "${DOMAINS[@]}"
#
# POURQUOI CE FICHIER EXISTE.
#
# Cette liste vivait en double : dans init-ssl.sh, qui la donne à Let's Encrypt,
# et dans deployer.sh, qui vérifie que le DNS résout avant de lancer quoi que
# ce soit. Les deux copies avaient divergé — « portail » figurait dans la
# première et manquait dans la seconde.
#
# La conséquence n'est pas symétrique, et c'est ce qui rend le défaut grave.
# Let's Encrypt valide les noms UN PAR UN et refuse le certificat ENTIER si un
# seul ne résout pas. Le contrôle de deployer.sh passait donc au vert sur une
# zone DNS incomplète, et la panne survenait une étape plus loin, au moment du
# certificat — là où elle coûte le plus cher à diagnostiquer, et là où
# l'opérateur ne pense plus au DNS puisqu'on vient de lui dire qu'il est bon.
#
# Un contrôle qui rassure avant la vraie panne est pire que pas de contrôle.
#
# Constaté le 11/09/2026 sur le premier déploiement réel : la documentation
# demandait TROIS enregistrements, le contrôle en exigeait six, le certificat
# sept. Trois chiffres, trois endroits, aucun d'accord avec les autres.
#
# Vérifier plutôt que dupliquer aurait laissé la porte ouverte : on écrit la
# liste une fois, et les deux scripts la lisent.

# APP_DOMAIN doit être chargé par l'appelant (depuis .env).
if [[ -z "${APP_DOMAIN:-}" ]]; then
    echo "sous-domaines.sh : APP_DOMAIN n'est pas défini. Chargez .env d'abord." >&2
    return 1 2>/dev/null || exit 1
fi

# Racine du dépôt, quel que soit l'endroit d'où l'on source ce fichier.
_SD_RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---------------------------------------------------------------------------
#  Les noms de base.
#
#  apex + www : la page publique de la plateforme.
#  api        : l'API, et le webhook Wave.
#  s3         : le stockage des photos (MinIO).
#  console    : la console d'administration du stockage.
#  portail    : le portail du redevable, ouvert au public.
#  gtfc       : le tableau de bord de la commune pilote.
# ---------------------------------------------------------------------------
DOMAINS=(
    "${APP_DOMAIN}"
    "www.${APP_DOMAIN}"
    "api.${APP_DOMAIN}"
    "s3.${APP_DOMAIN}"
    "console.${APP_DOMAIN}"
    "portail.${APP_DOMAIN}"
    "gtfc.${APP_DOMAIN}"
)

# ---------------------------------------------------------------------------
#  Les communes ajoutées après coup, un slug par ligne.
#  Alimenté par scripts/add-commune-domain.sh.
# ---------------------------------------------------------------------------
_SD_EXTRA="${_SD_RACINE}/infra/certbot/communes.txt"
if [[ -f "$_SD_EXTRA" ]]; then
    while read -r _sd_slug; do
        [[ -z "$_sd_slug" || "$_sd_slug" == \#* ]] && continue
        [[ "$_sd_slug" == "gtfc" ]] && continue      # déjà dans la liste de base
        DOMAINS+=("${_sd_slug}.${APP_DOMAIN}")
    done < "$_SD_EXTRA"
fi

unset _sd_slug
