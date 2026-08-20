#!/bin/sh
# ============================================================================
#  Init MinIO — buckets + utilisateur applicatif à droits restreints
#
#  Ce conteneur s'exécute puis s'arrête : c'est le comportement attendu.
#  Il est idempotent — on peut le relancer autant de fois que nécessaire :
#      docker compose run --rm minio-init
# ============================================================================
set -eu

MC_HOST="http://minio:9000"

echo "[minio-init] Connexion à ${MC_HOST}..."
# Le healthcheck de MinIO garantit déjà la disponibilité, mais on reste tolérant
i=0
until mc alias set gtfc "${MC_HOST}" "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 30 ]; then
    echo "[minio-init] ERREUR : MinIO injoignable après 30 tentatives." >&2
    exit 1
  fi
  echo "[minio-init] MinIO pas encore prêt, nouvelle tentative ($i/30)..."
  sleep 2
done
echo "[minio-init] Connecté."

# ---------------------------------------------------------------------------
# 1. Buckets
# ---------------------------------------------------------------------------
for BUCKET in "${MINIO_BUCKET_PHOTOS}" "${MINIO_BUCKET_DOCUMENTS}" "${MINIO_BUCKET_QRCODES}"; do
  if mc ls "gtfc/${BUCKET}" >/dev/null 2>&1; then
    echo "[minio-init] Bucket '${BUCKET}' déjà présent."
  else
    mc mb "gtfc/${BUCKET}"
    echo "[minio-init] Bucket '${BUCKET}' créé."
  fi

  # Aucun bucket n'est public : tout accès passe par une URL pré-signée
  # générée par l'API après vérification du JWT.
  mc anonymous set none "gtfc/${BUCKET}" >/dev/null

  # Versioning : une photo de devanture ne doit jamais pouvoir être écrasée
  # silencieusement — exigence du journal d'audit anti-fraude.
  mc version enable "gtfc/${BUCKET}" >/dev/null 2>&1 || true
done

# ---------------------------------------------------------------------------
# 2. Cycle de vie : purge automatique des anciennes versions
#    (les versions non courantes sont supprimées après 365 jours)
# ---------------------------------------------------------------------------
cat > /tmp/lifecycle.json <<JSON
{
  "Rules": [
    {
      "ID": "expire-noncurrent-versions",
      "Status": "Enabled",
      "NoncurrentVersionExpiration": { "NoncurrentDays": 365 }
    }
  ]
}
JSON
for BUCKET in "${MINIO_BUCKET_PHOTOS}" "${MINIO_BUCKET_DOCUMENTS}" "${MINIO_BUCKET_QRCODES}"; do
  mc ilm import "gtfc/${BUCKET}" < /tmp/lifecycle.json >/dev/null 2>&1 || \
    echo "[minio-init] (lifecycle non appliqué sur ${BUCKET}, non bloquant)"
done

# ---------------------------------------------------------------------------
# 3. Politique d'accès applicative : l'API ne peut toucher QUE ces 3 buckets.
#    Elle ne peut ni les supprimer, ni lister les autres buckets du serveur.
# ---------------------------------------------------------------------------
cat > /tmp/gtfc-app-policy.json <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetBucketLocation", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::${MINIO_BUCKET_PHOTOS}",
        "arn:aws:s3:::${MINIO_BUCKET_DOCUMENTS}",
        "arn:aws:s3:::${MINIO_BUCKET_QRCODES}"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:GetObjectVersion"],
      "Resource": [
        "arn:aws:s3:::${MINIO_BUCKET_PHOTOS}/*",
        "arn:aws:s3:::${MINIO_BUCKET_DOCUMENTS}/*",
        "arn:aws:s3:::${MINIO_BUCKET_QRCODES}/*"
      ]
    }
  ]
}
JSON

mc admin policy create gtfc gtfc-app /tmp/gtfc-app-policy.json >/dev/null 2>&1 \
  || mc admin policy add gtfc gtfc-app /tmp/gtfc-app-policy.json >/dev/null 2>&1 \
  || echo "[minio-init] Politique 'gtfc-app' déjà existante."

# ---------------------------------------------------------------------------
# 4. Utilisateur applicatif (MINIO_ACCESS_KEY / MINIO_SECRET_KEY du .env)
# ---------------------------------------------------------------------------
mc admin user add gtfc "${MINIO_ACCESS_KEY}" "${MINIO_SECRET_KEY}" >/dev/null 2>&1 \
  || echo "[minio-init] Utilisateur applicatif déjà existant, mot de passe inchangé."

mc admin policy attach gtfc gtfc-app --user "${MINIO_ACCESS_KEY}" >/dev/null 2>&1 \
  || mc admin policy set gtfc gtfc-app user="${MINIO_ACCESS_KEY}" >/dev/null 2>&1 \
  || echo "[minio-init] Politique déjà attachée."

echo "[minio-init] --------------------------------------------------"
echo "[minio-init] Buckets :"
mc ls gtfc
echo "[minio-init] Utilisateurs :"
mc admin user list gtfc || true
echo "[minio-init] TERMINÉ AVEC SUCCÈS"
