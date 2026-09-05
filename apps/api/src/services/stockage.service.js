/**
 * Stockage des fichiers dans MinIO (S3 auto-hébergé).
 *
 * Deux règles :
 *   1. aucun bucket n'est public. Une photo n'est jamais servie directement :
 *      l'API délivre une URL pré-signée de 15 minutes, après avoir vérifié le
 *      JWT et l'appartenance du commerce à la commune de l'appelant.
 *   2. l'empreinte SHA-256 de chaque fichier est enregistrée en base. Deux
 *      commerces différents présentant la même empreinte signalent une photo
 *      recyclée — un cas de fraude classique lors du recensement.
 */
'use strict';

const crypto = require('crypto');
const path = require('path');
const {
  S3Client, PutObjectCommand, GetObjectCommand,
  DeleteObjectCommand, HeadBucketCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const config = require('../config/env');
const logger = require('../config/logger');
const { erreurs } = require('../utils/erreurs');

const client = new S3Client({
  endpoint: `${config.stockage.ssl ? 'https' : 'http'}://${config.stockage.endpoint}:${config.stockage.port}`,
  region: config.stockage.region,
  credentials: {
    accessKeyId: config.stockage.accessKey,
    secretAccessKey: config.stockage.secretKey,
  },
  // Indispensable avec MinIO : sans cela le SDK construit des URL de la forme
  // https://bucket.endpoint/ que MinIO ne sait pas router.
  forcePathStyle: true,
});

/**
 * L'hôte public du magasin d'objets, quand il diffère de l'hôte interne.
 *
 * En production l'API parle à MinIO par 127.0.0.1, qui ne sort pas du serveur,
 * tandis que le navigateur ou le téléphone passe par s3.<domaine>, servi par
 * Nginx. Les deux hôtes sont donc légitimement différents.
 */
const hotePublic = (config.production && config.domaine !== 'localhost')
  ? `https://s3.${config.domaine}`
  : null;

/**
 * Client réservé à la PRÉSIGNATURE.
 *
 * SigV4 signe l'en-tête Host. Signer sur l'hôte interne puis réécrire l'hôte
 * dans l'URL — ce que faisait ce module — produit une URL dont la signature ne
 * correspond plus à la requête que MinIO reçoit : Nginx transmet `Host: $host`,
 * donc l'hôte réécrit, et MinIO répond 403 SignatureDoesNotMatch. Mesuré sur un
 * objet témoin : 200 sur l'hôte signé, 403 sur tout autre.
 *
 * On signe donc directement sur l'hôte que le client contactera. Signature et
 * requête concordent alors par construction, sans retouche après coup.
 *
 * Ce client ne sert QU'À signer : aucune requête ne part par lui. Les envois et
 * suppressions continuent d'emprunter l'hôte interne.
 */
const clientPresignature = hotePublic
  ? new S3Client({
    endpoint: hotePublic,
    region: config.stockage.region,
    credentials: {
      accessKeyId: config.stockage.accessKey,
      secretAccessKey: config.stockage.secretKey,
    },
    forcePathStyle: true,
  })
  : client;

const TYPES_IMAGE_AUTORISES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * Chemin de l'objet : commune / année / mois / commerce / uuid.ext
 *
 * Le découpage par mois évite d'entasser 11 000 photos dans un seul préfixe,
 * et rend possible l'archivage ou la purge d'une période entière.
 */
function construireChemin({ communeCode, commerceId, type, extension }) {
  const maintenant = new Date();
  const annee = maintenant.getFullYear();
  const mois = String(maintenant.getMonth() + 1).padStart(2, '0');
  const nom = `${type}-${crypto.randomUUID()}${extension}`;
  return `${communeCode}/${annee}/${mois}/${commerceId}/${nom}`;
}

function extensionDepuisMime(mime) {
  return { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[mime] || '.bin';
}

/**
 * Vérifie que le contenu est bien une image, en lisant les premiers octets.
 * Se fier au Content-Type déclaré par le client reviendrait à laisser passer
 * n'importe quel fichier renommé en .jpg.
 */
function detecterTypeReel(buffer) {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.slice(0, 4).toString() === 'RIFF' && buffer.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

async function televerserPhoto({ buffer, mimeDeclare, communeCode, commerceId, type, metadonnees = {} }) {
  if (buffer.length > config.stockage.tailleMaxPhotoOctets) {
    throw erreurs.tropVolumineux(
      `Photo de ${Math.round(buffer.length / 1024 / 1024)} Mo — maximum autorisé : `
      + `${Math.round(config.stockage.tailleMaxPhotoOctets / 1024 / 1024)} Mo`);
  }

  const mimeReel = detecterTypeReel(buffer);
  if (!mimeReel) {
    throw erreurs.requeteInvalide(
      'Le fichier envoyé n\'est pas une image reconnue (JPEG, PNG ou WebP attendus)');
  }
  if (mimeDeclare && !TYPES_IMAGE_AUTORISES.has(mimeDeclare)) {
    throw erreurs.requeteInvalide(`Type de fichier non autorisé : ${mimeDeclare}`);
  }

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const chemin = construireChemin({
    communeCode, commerceId, type, extension: extensionDepuisMime(mimeReel),
  });

  await client.send(new PutObjectCommand({
    Bucket: config.stockage.buckets.photos,
    Key: chemin,
    Body: buffer,
    ContentType: mimeReel,
    // Les métadonnées S3 ne supportent que l'ASCII : on n'y met que des
    // valeurs techniques, jamais de nom de commerce ni de gérant.
    Metadata: {
      commerce: String(commerceId),
      type: String(type),
      sha256,
      ...Object.fromEntries(
        Object.entries(metadonnees).map(([k, v]) => [k, String(v).replace(/[^\x20-\x7E]/g, '')]),
      ),
    },
  }));

  return {
    bucket: config.stockage.buckets.photos,
    chemin,
    sha256,
    type_mime: mimeReel,
    taille_octets: buffer.length,
  };
}

async function televerserObjet({ bucket, chemin, buffer, contentType }) {
  await client.send(new PutObjectCommand({
    Bucket: bucket, Key: chemin, Body: buffer, ContentType: contentType,
  }));
  return {
    bucket,
    chemin,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    taille_octets: buffer.length,
  };
}

/**
 * URL temporaire de consultation.
 *
 * L'URL publique passe par le sous-domaine s3.<domaine> servi par Nginx, pas
 * par l'adresse interne du conteneur MinIO. Elle est SIGNÉE sur cet hôte-là :
 * voir clientPresignature ci-dessus pour la raison.
 */
async function urlSignee(bucket, chemin, secondes = config.stockage.dureeUrlSigneeSecondes) {
  return getSignedUrl(
    clientPresignature,
    new GetObjectCommand({ Bucket: bucket, Key: chemin }),
    { expiresIn: secondes },
  );
}

async function supprimerObjet(bucket, chemin) {
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: chemin }));
}

async function verifierConnexion() {
  const resultats = {};
  for (const [nom, bucket] of Object.entries(config.stockage.buckets)) {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
      resultats[nom] = 'ok';
    } catch (err) {
      resultats[nom] = `indisponible (${err.name})`;
      logger.error({ bucket, err: err.name }, 'Bucket MinIO inaccessible');
    }
  }
  const echecs = Object.values(resultats).filter((v) => v !== 'ok');
  if (echecs.length === Object.keys(resultats).length) {
    throw erreurs.serviceIndisponible('de stockage MinIO');
  }
  return resultats;
}

module.exports = {
  client,
  televerserPhoto,
  televerserObjet,
  urlSignee,
  supprimerObjet,
  verifierConnexion,
  construireChemin,
  extensionDepuisMime: (m) => extensionDepuisMime(m),
  nomFichierSur: (chemin) => path.basename(chemin),
};
