#!/usr/bin/env node
'use strict';
/**
 * Crée les buckets MinIO attendus par l'API.
 *
 * L'API démarre en mode dégradé si les buckets manquent — les photos
 * deviennent indisponibles, donc aucune fiche de recensement ne peut être
 * validée (FR-005). Rien dans le dépôt ne les créait : ce script comble ce
 * trou, en local comme au déploiement.
 *
 * Idempotent : relançable sans effet de bord.
 */
require('dotenv').config({ path: require('node:path').resolve(__dirname, '../../../.env') });

const { S3Client, CreateBucketCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');

const client = new S3Client({
  endpoint: `http${process.env.MINIO_USE_SSL === 'true' ? 's' : ''}://`
          + `${process.env.MINIO_ENDPOINT}:${process.env.MINIO_PORT}`,
  region: process.env.MINIO_REGION || 'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY,
    secretAccessKey: process.env.MINIO_SECRET_KEY,
  },
});

const BUCKETS = [
  process.env.MINIO_BUCKET_PHOTOS,
  process.env.MINIO_BUCKET_DOCUMENTS,
  process.env.MINIO_BUCKET_QRCODES,
].filter(Boolean);

(async () => {
  if (BUCKETS.length === 0) {
    console.error('Aucun bucket configuré : vérifiez MINIO_BUCKET_* dans le .env');
    process.exit(1);
  }
  let cree = 0;
  for (const nom of BUCKETS) {
    try {
      await client.send(new HeadBucketCommand({ Bucket: nom }));
      console.log(`  = ${nom} (existe déjà)`);
    } catch {
      await client.send(new CreateBucketCommand({ Bucket: nom }));
      console.log(`  + ${nom} (créé)`);
      cree += 1;
    }
  }
  console.log(`\n${BUCKETS.length} buckets vérifiés, ${cree} créé(s).`);
})().catch((e) => {
  console.error('Échec :', e.message);
  console.error('Vérifiez que MinIO tourne et que MINIO_ACCESS_KEY/SECRET sont justes.');
  process.exit(1);
});
