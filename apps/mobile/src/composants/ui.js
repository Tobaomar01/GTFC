/**
 * Composants d'interface communs.
 *
 * Conçus pour un usage debout, au soleil, avec le pouce : cibles de 48 px,
 * libellés explicites, aucun geste caché. Un agent ne doit jamais avoir à
 * deviner ce qu'un bouton fait.
 */
import React from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ActivityIndicator, ScrollView, StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  couleurs, espacements, rayons, typographie, ombre, CIBLE_TACTILE, STATUTS_FISCAUX,
} from '../theme';

// ---------------------------------------------------------------------------
export function Bouton({
  titre, onPress, variante = 'primaire', icone = null, charge = false,
  desactive = false, pleineLargeur = true, style,
}) {
  const bloque = desactive || charge;
  const styles = stylesBouton[variante] ?? stylesBouton.primaire;

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={bloque}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={titre}
      accessibilityState={{ disabled: bloque, busy: charge }}
      style={[
        base.bouton,
        styles.conteneur,
        pleineLargeur && { alignSelf: 'stretch' },
        bloque && base.boutonDesactive,
        style,
      ]}
    >
      {charge ? (
        <ActivityIndicator color={styles.texte.color} />
      ) : (
        <>
          {icone && <Ionicons name={icone} size={20} color={styles.texte.color} />}
          <Text style={[base.boutonTexte, styles.texte]}>{titre}</Text>
        </>
      )}
    </TouchableOpacity>
  );
}

const stylesBouton = StyleSheet.create({
  primaire: {
    conteneur: { backgroundColor: couleurs.primaire },
    texte: { color: couleurs.texteInverse },
  },
  secondaire: {
    conteneur: {
      backgroundColor: couleurs.surface,
      borderWidth: 1.5,
      borderColor: couleurs.primaire,
    },
    texte: { color: couleurs.primaire },
  },
  danger: {
    conteneur: { backgroundColor: couleurs.erreur },
    texte: { color: couleurs.texteInverse },
  },
  discret: {
    conteneur: { backgroundColor: 'transparent' },
    texte: { color: couleurs.texteSecondaire },
  },
});

// ---------------------------------------------------------------------------
export function Champ({
  etiquette, valeur, onChangeText, obligatoire = false, erreur = null,
  aide = null, suffixe = null, ...props
}) {
  return (
    <View style={base.champConteneur}>
      {etiquette ? (
        <Text style={base.etiquette}>
          {etiquette}
          {obligatoire && <Text style={{ color: couleurs.erreur }}> *</Text>}
        </Text>
      ) : null}

      <View style={[
        base.champBoite,
        erreur && { borderColor: couleurs.erreur, borderWidth: 1.5 },
      ]}
      >
        <TextInput
          value={valeur == null ? '' : String(valeur)}
          onChangeText={onChangeText}
          placeholderTextColor={couleurs.texteDesactive}
          style={base.champSaisie}
          accessibilityLabel={etiquette}
          {...props}
        />
        {suffixe ? <Text style={base.suffixe}>{suffixe}</Text> : null}
      </View>

      {erreur ? <Text style={base.messageErreur}>{erreur}</Text> : null}
      {aide && !erreur ? <Text style={base.aide}>{aide}</Text> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
/** Sélecteur en liste de pastilles : plus rapide au pouce qu'un menu déroulant. */
export function Selecteur({
  etiquette, options, valeur, onChange, obligatoire = false, aide = null,
  cleValeur = 'id', cleLibelle = 'libelle', horizontal = false,
}) {
  const Conteneur = horizontal ? ScrollView : View;
  const propsConteneur = horizontal
    ? { horizontal: true, showsHorizontalScrollIndicator: false }
    : {};

  return (
    <View style={base.champConteneur}>
      {etiquette ? (
        <Text style={base.etiquette}>
          {etiquette}
          {obligatoire && <Text style={{ color: couleurs.erreur }}> *</Text>}
        </Text>
      ) : null}

      <Conteneur {...propsConteneur} style={horizontal ? null : base.grilleOptions}>
        <View style={horizontal ? base.ligneOptions : base.grilleOptions}>
          {options.map((o) => {
            const v = o[cleValeur];
            const actif = valeur === v;
            return (
              <TouchableOpacity
                key={String(v)}
                onPress={() => onChange(actif ? null : v)}
                activeOpacity={0.75}
                accessibilityRole="radio"
                accessibilityState={{ selected: actif }}
                style={[base.option, actif && base.optionActive]}
              >
                <Text style={[base.optionTexte, actif && base.optionTexteActif]}>
                  {o[cleLibelle]}
                </Text>
                {o.detail ? (
                  <Text style={[base.optionDetail, actif && { color: '#DCEEE2' }]}>
                    {o.detail}
                  </Text>
                ) : null}
              </TouchableOpacity>
            );
          })}
        </View>
      </Conteneur>

      {aide ? <Text style={base.aide}>{aide}</Text> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
export function Carte({ children, style, onPress }) {
  const Conteneur = onPress ? TouchableOpacity : View;
  return (
    <Conteneur
      onPress={onPress}
      activeOpacity={0.8}
      style={[base.carte, style]}
    >
      {children}
    </Conteneur>
  );
}

// ---------------------------------------------------------------------------
export function BadgeStatut({ statut, petit = false }) {
  const info = STATUTS_FISCAUX[statut] ?? STATUTS_FISCAUX.inconnu;
  return (
    <View style={[
      base.badge,
      { backgroundColor: `${info.couleur}1A`, borderColor: info.couleur },
      petit && { paddingVertical: 2, paddingHorizontal: 6 },
    ]}
    >
      <Ionicons name={info.icone} size={petit ? 12 : 14} color={info.couleur} />
      <Text style={[base.badgeTexte, { color: info.couleur }, petit && { fontSize: 12 }]}>
        {info.libelle}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
export function Message({ type = 'info', titre, texte, action = null }) {
  const palettes = {
    info: { fond: '#EAF0F7', bord: couleurs.info, icone: 'information-circle' },
    succes: { fond: '#E7F3EB', bord: couleurs.succes, icone: 'checkmark-circle' },
    avertissement: { fond: couleurs.horsLigneFond, bord: couleurs.avertissement, icone: 'warning' },
    erreur: { fond: '#FBEAE9', bord: couleurs.erreur, icone: 'alert-circle' },
  };
  const p = palettes[type] ?? palettes.info;

  return (
    <View style={[base.message, { backgroundColor: p.fond, borderLeftColor: p.bord }]}>
      <Ionicons name={p.icone} size={22} color={p.bord} style={{ marginTop: 1 }} />
      <View style={{ flex: 1, marginLeft: espacements.m }}>
        {titre ? <Text style={base.messageTitre}>{titre}</Text> : null}
        {texte ? <Text style={base.messageTexte}>{texte}</Text> : null}
        {action}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
export function LigneInfo({ etiquette, valeur, icone = null, style }) {
  return (
    <View style={[base.ligneInfo, style]}>
      {icone ? (
        <Ionicons name={icone} size={18} color={couleurs.texteSecondaire}
          style={{ width: 26 }} />
      ) : null}
      <Text style={base.ligneInfoEtiquette}>{etiquette}</Text>
      <Text style={base.ligneInfoValeur} numberOfLines={2}>{valeur ?? '—'}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
export function Chargement({ texte = 'Chargement…' }) {
  return (
    <View style={base.chargement}>
      <ActivityIndicator size="large" color={couleurs.primaire} />
      <Text style={[typographie.petit, { marginTop: espacements.m }]}>{texte}</Text>
    </View>
  );
}

export function EtatVide({ icone = 'file-tray-outline', titre, texte, action = null }) {
  return (
    <View style={base.etatVide}>
      <Ionicons name={icone} size={56} color={couleurs.texteDesactive} />
      <Text style={[typographie.sousTitre, { marginTop: espacements.l, textAlign: 'center' }]}>
        {titre}
      </Text>
      {texte ? (
        <Text style={[typographie.petit, {
          marginTop: espacements.s, textAlign: 'center', paddingHorizontal: espacements.xl,
        }]}
        >
          {texte}
        </Text>
      ) : null}
      {action ? <View style={{ marginTop: espacements.xl, alignSelf: 'stretch' }}>{action}</View> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
export function Separateur({ titre = null }) {
  if (!titre) return <View style={base.separateur} />;
  return (
    <View style={base.separateurTitre}>
      <View style={base.separateurTrait} />
      <Text style={base.separateurTexte}>{titre}</Text>
      <View style={base.separateurTrait} />
    </View>
  );
}

// ---------------------------------------------------------------------------
const base = StyleSheet.create({
  bouton: {
    minHeight: CIBLE_TACTILE,
    borderRadius: rayons.m,
    paddingHorizontal: espacements.l,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: espacements.s,
  },
  boutonDesactive: { opacity: 0.45 },
  boutonTexte: { fontSize: 16, fontWeight: '600' },

  champConteneur: { marginBottom: espacements.l },
  etiquette: { ...typographie.etiquette, marginBottom: espacements.xs },
  champBoite: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: couleurs.surface,
    borderWidth: 1,
    borderColor: couleurs.bordure,
    borderRadius: rayons.m,
    paddingHorizontal: espacements.m,
    minHeight: CIBLE_TACTILE,
  },
  champSaisie: { flex: 1, fontSize: 16, color: couleurs.texte, paddingVertical: espacements.m },
  suffixe: { ...typographie.petit, marginLeft: espacements.s, fontWeight: '600' },
  messageErreur: { fontSize: 13, color: couleurs.erreur, marginTop: espacements.xs },
  aide: { fontSize: 13, color: couleurs.texteSecondaire, marginTop: espacements.xs },

  grilleOptions: { flexDirection: 'row', flexWrap: 'wrap', gap: espacements.s },
  ligneOptions: { flexDirection: 'row', gap: espacements.s, paddingRight: espacements.l },
  option: {
    minHeight: CIBLE_TACTILE,
    justifyContent: 'center',
    paddingHorizontal: espacements.l,
    paddingVertical: espacements.s,
    borderRadius: rayons.m,
    borderWidth: 1.5,
    borderColor: couleurs.bordure,
    backgroundColor: couleurs.surface,
  },
  optionActive: { backgroundColor: couleurs.primaire, borderColor: couleurs.primaire },
  optionTexte: { fontSize: 15, color: couleurs.texte, fontWeight: '500' },
  optionTexteActif: { color: couleurs.texteInverse, fontWeight: '700' },
  optionDetail: { fontSize: 12, color: couleurs.texteSecondaire, marginTop: 1 },

  carte: {
    backgroundColor: couleurs.surface,
    borderRadius: rayons.l,
    padding: espacements.l,
    marginBottom: espacements.m,
    ...ombre,
  },

  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: rayons.rond,
    borderWidth: 1,
  },
  badgeTexte: { fontSize: 13, fontWeight: '600' },

  message: {
    flexDirection: 'row',
    padding: espacements.l,
    borderRadius: rayons.m,
    borderLeftWidth: 4,
    marginBottom: espacements.m,
  },
  messageTitre: { fontSize: 15, fontWeight: '700', color: couleurs.texte, marginBottom: 2 },
  messageTexte: { fontSize: 14, color: couleurs.texteSecondaire, lineHeight: 20 },

  ligneInfo: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: espacements.s,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: couleurs.bordure,
  },
  ligneInfoEtiquette: { ...typographie.petit, width: 130 },
  ligneInfoValeur: { ...typographie.corps, flex: 1, fontWeight: '500' },

  chargement: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: espacements.xxl },
  etatVide: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: espacements.xxl },

  separateur: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: couleurs.bordure,
    marginVertical: espacements.l,
  },
  separateurTitre: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: espacements.m,
    marginVertical: espacements.l,
  },
  separateurTrait: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: couleurs.bordure },
  separateurTexte: { ...typographie.etiquette, textTransform: 'uppercase', fontSize: 12 },
});

export { base as stylesUi };
