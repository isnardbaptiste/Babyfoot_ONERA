import React, { useState, useEffect, useMemo, useCallback } from "react";
import { api } from "./api";
import { compilerFormule } from "./formule";

// Variables mises à disposition des formules personnalisées.
const VARS_DELTA = ["K", "mult", "E", "res", "ecart"];
const VARS_MULT = ["ecart"];

/* ────────────────────────────────────────────────────────────
   LIGUE DU MIDI — classement Elo de baby-foot 2v2
   Elo séparé pour l'attaque, la défense et le général.
   Toutes les notes sont recalculées depuis l'historique complet,
   ce qui rend la suppression d'un match ou d'un joueur exacte.
   ──────────────────────────────────────────────────────────── */

const MIN_SCORE = -5;
const MAX_SCORE = 10;
const PERLES_NEG = Array.from({ length: -MIN_SCORE }, (_, i) => MIN_SCORE + i); // -5 … -1
const PERLES_POS = Array.from({ length: MAX_SCORE }, (_, i) => i + 1); // 1 … 10
const AN_MS = 365 * 24 * 60 * 60 * 1000;
const JOUR_MS = 24 * 60 * 60 * 1000;
const MODES = [
  { id: "general", label: "Général" },
  { id: "attaque", label: "Attaque" },
  { id: "defense", label: "Défense" },
];

// Coefficients par défaut, identiques au serveur. Servent de secours quand la
// ligue n'a pas encore renvoyé les siens (premier chargement).
const COEFS_DEFAUT = {
  depart: 1500,
  k: 24,
  plancher: 4,
  partRole: 0.75,
  inactiviteJours: 91,
  paliers: [
    { ecart: 8, facteur: 5 },
    { ecart: 7, facteur: 4 },
    { ecart: 6, facteur: 3 },
    { ecart: 4, facteur: 2 },
    { ecart: 1, facteur: 1 },
  ],
};
// Quelques valeurs encore lues directement par des libellés d'interface.
const START = COEFS_DEFAUT.depart;
const K = COEFS_DEFAUT.k;
const PLANCHER = COEFS_DEFAUT.plancher;

/* ── Maths Elo ─────────────────────────────────────────────── */

// Multiplicateur par palier d'écart de buts (comportement standard).
function multPaliers(ecart, coefs) {
  const e = Math.abs(ecart);
  for (const p of coefs.paliers) if (e >= p.ecart) return p.facteur; // paliers triés décroissant
  return 1;
}

function esperance(noteEquipe, noteAdverse) {
  return 1 / (1 + Math.pow(10, (noteAdverse - noteEquipe) / 400));
}

// Prépare, une fois par recalcul, les fonctions "mult" et "delta" à employer.
// Chaque formule personnalisée valide remplace le calcul standard ; sinon on garde le standard.
function prepareModele(coefs) {
  let fnMult = null, fnDelta = null;
  if (coefs.formuleMult) {
    const r = compilerFormule(coefs.formuleMult, VARS_MULT);
    if (r.fn) fnMult = r.fn; // en cas d'erreur on ignore et on garde les paliers
  }
  if (coefs.formuleDelta) {
    const r = compilerFormule(coefs.formuleDelta, VARS_DELTA);
    if (r.fn) fnDelta = r.fn;
  }
  const mult = (ecart) => {
    if (fnMult) { try { return fnMult({ ecart: Math.abs(ecart) }); } catch (e) {} }
    return multPaliers(ecart, coefs);
  };
  const delta = (K, m, E, res, ecart) => {
    if (fnDelta) { try { return fnDelta({ K, mult: m, E, res, ecart: Math.abs(ecart) }); } catch (e) {} }
    return K * m * (res - E);
  };
  return { mult, delta };
}

function deltasMatch(etat, m, coefs, modele) {
  const mod = modele || prepareModele(coefs);
  const aAtk = etat[m.a.atk], aDef = etat[m.a.def];
  const bAtk = etat[m.b.atk], bDef = etat[m.b.def];

  // Force d'une équipe = moyenne de l'attaquant en attaque et du défenseur en défense
  const noteA = (aAtk.attaque + aDef.defense) / 2;
  const noteB = (bAtk.attaque + bDef.defense) / 2;

  const ecart = Math.abs(m.sa - m.sb);
  const mult = mod.mult(ecart);
  const resA = m.sa > m.sb ? 1 : m.sa < m.sb ? 0 : 0.5;
  const E = esperance(noteA, noteB);
  let brut = mod.delta(coefs.k, mult, E, resA, ecart);
  if (typeof brut !== "number" || !isFinite(brut)) brut = coefs.k * mult * (resA - E); // sécurité
  // Le vainqueur gagne au moins "plancher", le perdant en laisse autant.
  const spec = brut >= 0 ? Math.max(brut, coefs.plancher) : Math.min(brut, -coefs.plancher);

  return { spec, noteA, noteB, mult, proba: E };
}

function ligneVide(id, nom, depart) {
  const role = () => ({
    j: 0, v: 0, d: 0, bp: 0, bc: 0, forme: [], dernier: 0,
    // confrontations par mode : coequipiers[idAutre] = {j, v}, adversaires[idAutre] = {j, v}
    coequipiers: {}, adversaires: {},
    courbe: {}, // Elo de fin de journée : { "AAAA-MM-JJ": elo }
  });
  return {
    id, nom,
    general: depart, attaque: depart, defense: depart,
    dernierJoue: null, // date du dernier match joué, pour la règle d'inactivité
    stats: { general: role(), attaque: role(), defense: role() },
  };
}

// Enregistre un duel (coéquipier ou adversaire) dans une sous-table de stats.
function noter(table, autreId, gagne) {
  const e = table[autreId] || (table[autreId] = { j: 0, v: 0 });
  e.j += 1;
  if (gagne) e.v += 1;
}

const jourDe = (ms) => new Date(ms).toISOString().slice(0, 10); // "AAAA-MM-JJ" en UTC

function calculerLigue(joueurs, matchs, coefs = COEFS_DEFAUT, maintenant = Date.now()) {
  const inactifMs = coefs.inactiviteJours * JOUR_MS;
  const modele = prepareModele(coefs); // compile les formules une seule fois
  const etat = {};
  joueurs.forEach((j) => { etat[j.id] = ligneVide(j.id, j.nom, coefs.depart); });

  const ordonnes = [...matchs].sort((x, y) => x.date.localeCompare(y.date));
  const enrichis = [];

  for (const m of ordonnes) {
    const ids = [m.a.atk, m.a.def, m.b.atk, m.b.def];
    if (ids.some((id) => !etat[id])) continue; // joueur supprimé : match ignoré
    const quand = new Date(m.date).getTime();
    const jour = jourDe(quand);

    // Inactivité : une absence de plus de N jours coupe le fil de l'Elo.
    // Au retour, le joueur repart de "depart" (attaque et défense) avant ce match.
    for (const id of ids) {
      const p = etat[id];
      if (p.dernierJoue !== null && quand - p.dernierJoue > inactifMs) {
        p.attaque = coefs.depart;
        p.defense = coefs.depart;
        p.general = coefs.depart;
      }
    }

    const d = deltasMatch(etat, m, coefs, modele);

    const membres = [
      { id: m.a.atk, role: "attaque", eq: "a", coeq: m.a.def, adv: [m.b.atk, m.b.def] },
      { id: m.a.def, role: "defense", eq: "a", coeq: m.a.atk, adv: [m.b.atk, m.b.def] },
      { id: m.b.atk, role: "attaque", eq: "b", coeq: m.b.def, adv: [m.a.atk, m.a.def] },
      { id: m.b.def, role: "defense", eq: "b", coeq: m.b.atk, adv: [m.a.atk, m.a.def] },
    ];

    for (const mb of membres) {
      const p = etat[mb.id];
      const signe = mb.eq === "a" ? 1 : -1;
      const dSpec = d.spec * signe;

      // Le poste tenu prend "partRole" de la variation, l'autre poste le reste.
      const dAtt = dSpec * (mb.role === "attaque" ? coefs.partRole : 1 - coefs.partRole);
      const dDef = dSpec * (mb.role === "defense" ? coefs.partRole : 1 - coefs.partRole);
      p.attaque += dAtt;
      p.defense += dDef;
      // Le général suit mécaniquement : moyenne de l'attaque et de la défense.
      p.general = (p.attaque + p.defense) / 2;
      p.dernierJoue = quand;

      p.stats.attaque.dernier = dAtt;
      p.stats.defense.dernier = dDef;
      p.stats.general.dernier = dSpec / 2;

      const bp = mb.eq === "a" ? m.sa : m.sb;
      const bc = mb.eq === "a" ? m.sb : m.sa;
      const gagne = bp > bc;
      // Les compteurs de matchs ne bougent que pour le poste réellement tenu, plus le général.
      for (const cle of [mb.role, "general"]) {
        const s = p.stats[cle];
        s.j += 1;
        s[gagne ? "v" : "d"] += 1;
        s.bp += bp; s.bc += bc;
        s.forme.push(gagne ? "V" : "D");
        noter(s.coequipiers, mb.coeq, gagne);
        mb.adv.forEach((idAdv) => noter(s.adversaires, idAdv, gagne));
      }

      // Elo de fin de journée pour la courbe : on écrase, le dernier match du jour gagne.
      p.stats.general.courbe[jour] = p.general;
      p.stats.attaque.courbe[jour] = p.attaque;
      p.stats.defense.courbe[jour] = p.defense;
    }

    enrichis.push({ ...m, delta: d.spec, mult: d.mult, moyA: d.noteA, moyB: d.noteB });
  }

  // Un joueur est "actif" s'il a joué dans la fenêtre d'inactivité. Les inactifs
  // sortent du classement (mais gardent leur historique et leurs stats de saison).
  const classement = Object.values(etat).map((p) => ({
    ...p,
    actif: p.dernierJoue !== null && maintenant - p.dernierJoue <= inactifMs,
  }));

  return { classement, index: Object.fromEntries(classement.map((p) => [p.id, p])), matchs: enrichis.reverse(), coefs };
}

/* ── Petits éléments graphiques ────────────────────────────── */

function Barre({ role, couleur }) {
  // Silhouette de barre de baby-foot : 3 figurines pour l'attaque, 2 pour la défense
  const n = role === "attaque" ? 3 : 2;
  const pas = 60 / (n + 1);
  return (
    <svg viewBox="0 0 60 22" className="bf-barre" aria-hidden="true">
      <rect x="0" y="3" width="60" height="2.4" rx="1.2" fill="var(--chrome)" opacity="0.8" />
      {Array.from({ length: n }, (_, i) => {
        const x = pas * (i + 1);
        return (
          <g key={i} fill={couleur}>
            <rect x={x - 1.1} y="5" width="2.2" height="5" />
            <circle cx={x} cy="12" r="3.4" />
            <path d={`M ${x - 4} 15 L ${x + 4} 15 L ${x + 2.6} 21 L ${x - 2.6} 21 Z`} />
          </g>
        );
      })}
    </svg>
  );
}

function Logo() {
  return (
    <svg viewBox="0 0 98 58" className="bf-logo-svg" role="img" aria-label="BabyFoot">
      <title>Un joueur de baby-foot frappe la balle au-delà du mur du son</title>

      {/* onde de choc : cônes de Mach empilés derrière la balle */}
      <g fill="none" stroke="var(--craie)" strokeLinecap="round" strokeLinejoin="round">
        <path d="M59.4 50.3 62.8 31.8 51.3 25.2" strokeWidth="1.8" opacity=".28" />
        <path d="M67.4 43.9 70.9 28 56.4 20.5" strokeWidth="2.4" opacity=".55" />
        <path d="M76 36.6 79 24.2 67.6 18.6" strokeWidth="3.1" opacity=".95" />
      </g>

      {/* balle */}
      <circle cx="88" cy="20" r="6.6" fill="var(--craie)" />
      <path d="M83.6 15.1a6.6 6.6 0 0 1 8.8 9.8" fill="none" stroke="#0E3B2C" strokeOpacity=".22" strokeWidth="1.6" />

      {/* figurine : torse, jambe d'appui, jambe de frappe */}
      <g stroke="var(--rouge)" strokeLinecap="round" fill="none">
        <path d="M28 18 27 32" strokeWidth="13" />
        <path d="M24.5 33 20.5 49.5" strokeWidth="6" />
        <path d="M30 32 40.5 29.5 48 24.5" strokeWidth="6" strokeLinejoin="round" />
      </g>
      <circle cx="28" cy="9.5" r="6.6" fill="var(--rouge)" />

      {/* barre chromée traversant le joueur */}
      <rect x="0" y="20" width="42" height="4.6" rx="2.3" fill="var(--chrome)" />
      <rect x="22" y="17.6" width="11" height="9.4" rx="2" fill="var(--chrome)" opacity=".55" />
    </svg>
  );
}

function Boulier({ value, onChange, couleur, label }) {
  // Le boulier du baby-foot : on pousse les perles pour marquer,
  // et vers la gauche du cran quand une gamelle fait perdre un but.
  const borne = (n) => Math.max(MIN_SCORE, Math.min(MAX_SCORE, n));
  const cle = (e) => {
    const pas = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (pas) { e.preventDefault(); onChange(borne(value + pas)); return; }
    if (e.key === "Home") { e.preventDefault(); onChange(0); }
    if (e.key === "End") { e.preventDefault(); onChange(MAX_SCORE); }
  };
  const teinte = { "--perle": couleur };

  return (
    <div className="bf-boulier-bloc">
      <div className="bf-score" style={{ color: couleur }}>
        {affScore(value)}
      </div>
      <div
        className="bf-boulier"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={MIN_SCORE}
        aria-valuemax={MAX_SCORE}
        aria-valuenow={value}
        onKeyDown={cle}
      >
        <span className="bf-tige" />
        <span className="bf-perles neg">
          {PERLES_NEG.map((v) => {
            const on = value <= v;
            return (
              <button
                key={v}
                type="button"
                tabIndex={-1}
                className={"bf-perle neg" + (on ? " on" : "")}
                style={on ? teinte : undefined}
                onClick={() => onChange(value === v ? v + 1 : v)}
                aria-label={`${v} but${v < -1 ? "s" : ""}`}
              />
            );
          })}
        </span>
        <span className="bf-cran" aria-hidden="true" />
        <span className="bf-perles pos">
          {PERLES_POS.map((v) => {
            const on = value >= v;
            return (
              <button
                key={v}
                type="button"
                tabIndex={-1}
                className={"bf-perle" + (on ? " on" : "")}
                style={on ? teinte : undefined}
                onClick={() => onChange(value === v ? v - 1 : v)}
                aria-label={`${v} but${v > 1 ? "s" : ""}`}
              />
            );
          })}
        </span>
      </div>
    </div>
  );
}

function Choix({ value, onChange, joueurs, exclus, placeholder }) {
  return (
    <select
      className="bf-select"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{placeholder}</option>
      {joueurs
        .filter((j) => j.id === value || !exclus.includes(j.id))
        .map((j) => (
          <option key={j.id} value={j.id}>{j.nom}</option>
        ))}
    </select>
  );
}

const MENTIONS_HAUT = ["[GOAT]", "[LEGEND]", "[PRO]"]; // 1er, 2e, 3e
const MENTIONS_BAS = ["[KIKELACHEVRE]", "[POMPEALOOSE]", "[NAINDEPATTYA]"]; // dernier, avant-dernier, …

// Décrit les paliers du multiplicateur en une phrase, ex. "×1 de 1 à 3 · ×2 de 4 à 5 · ×5 à partir de 8".
function decrirePaliers(coefs) {
  const tries = [...coefs.paliers].sort((a, b) => a.ecart - b.ecart); // du plus petit au plus grand
  return tries
    .map((p, i) => {
      const suivant = tries[i + 1];
      const borne = suivant ? suivant.ecart - 1 : null;
      const plage = i === tries.length - 1
        ? `à partir de ${p.ecart}`
        : p.ecart === borne ? `à ${p.ecart}` : `de ${p.ecart} à ${borne}`;
      return `×${p.facteur} ${plage}`;
    })
    .join(" · ");
}
const moisEnv = (jours) => Math.round(jours / 30);

const signe = (n) => (n > 0 ? "+" : n < 0 ? "−" : "±") + Math.abs(Math.round(n));
const affScore = (n) => (n < 0 ? "−" + Math.abs(n) : String(n));

/* ── Vues ──────────────────────────────────────────────────── */

function Classement({ ligue, mode, setMode, onJoueur, palmaresParCat, saisons }) {
  const c = ligue.coefs;
  const palmaresMode = (palmaresParCat && palmaresParCat[mode]) || {};
  // Coupes de tenant : podium (de la catégorie affichée) de la saison la plus récemment close.
  const coupes = useMemo(() => {
    const arch = saisons || [];
    if (!arch.length || !arch[0].awards) return {};
    const podium = arch[0].awards[mode] || [];
    const c2 = {};
    podium.forEach((id, i) => { if (id) c2[id] = i + 1; });
    return c2;
  }, [saisons, mode]);
  // Seuls les joueurs actifs (un match dans la fenêtre d'inactivité) figurent au classement.
  const lignes = useMemo(
    () => ligue.classement.filter((p) => p.actif).sort((a, b) => b[mode] - a[mode]),
    [ligue, mode]
  );
  const inactifs = ligue.classement.filter((p) => !p.actif && p.dernierJoue !== null).length;

  if (!ligue.classement.length) {
    return (
      <div className="bf-vide">
        <p>Le classement est vide.</p>
        <p className="bf-vide-sous">Ajoutez vos collègues dans l'onglet Joueurs pour démarrer la saison.</p>
      </div>
    );
  }

  if (!lignes.length) {
    return (
      <div className="bf-vide">
        <p>Personne n'a joué ces trois derniers mois.</p>
        <p className="bf-vide-sous">Un match remet son auteur au classement, Elo repart de {START}.</p>
      </div>
    );
  }

  return (
    <>
      <div className="bf-segments" role="tablist" aria-label="Type de classement">
        {MODES.map((m) => (
          <button
            key={m.id}
            role="tab"
            aria-selected={mode === m.id}
            className={"bf-seg" + (mode === m.id ? " on" : "")}
            onClick={() => setMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="bf-table" role="table">
        <div className="bf-tr bf-thead" role="row">
          <span className="bf-c-rang">#</span>
          <span className="bf-c-nom">Joueur</span>
          {MODES.map((m) => (
            <span key={m.id} className={"bf-c-elo" + (mode === m.id ? " actif" : "")}>
              {m.label.slice(0, 3)}
            </span>
          ))}
        </div>
        {lignes.map((p, i) => {
          const s = p.stats[mode];
          const haut = s.j > 0 && i < 3 ? MENTIONS_HAUT[i] : null;
          const rangFin = lignes.length - 1 - i;
          const bas = !haut && s.j > 0 && lignes.length >= 6 && rangFin < 3 ? MENTIONS_BAS[rangFin] : null;
          return (
            <div
              className="bf-tr bf-tr-clic"
              role="row"
              key={p.id}
              onClick={() => onJoueur(p.id)}
              title={`Voir les statistiques de ${p.nom}`}
            >
              <span className="bf-c-rang"><i className={"bf-rang r" + (i < 3 ? i + 1 : 0)}>{i + 1}</i></span>
              <span className="bf-c-nom">
                <span className="bf-nom-ligne">
                  {p.nom}
                  <Palmes palmares={palmaresMode} id={p.id} />
                  {coupes[p.id] && <Coupe rang={MEDAILLES[coupes[p.id] - 1]} place={coupes[p.id]} />}
                  {haut && <b className={"bf-tag haut h" + (i + 1)}>{haut}</b>}
                  {bas && <b className="bf-tag bas">{bas}</b>}
                </span>
                <span className="bf-sous">
                  {s.j ? (
                    <>
                      {s.v}<em>V</em> {s.d}<em>D</em>
                      <b className={s.dernier > 0 ? "pos" : s.dernier < 0 ? "neg" : ""}>{signe(s.dernier)}</b>
                      <span className="bf-forme">
                        {s.forme.slice(-5).map((r, k) => (
                          <i key={k} className={"bf-pastille " + (r === "V" ? "v" : "d")} />
                        ))}
                      </span>
                    </>
                  ) : (
                    "aucun match"
                  )}
                </span>
              </span>
              {MODES.map((m) => (
                <span key={m.id} className={"bf-c-elo" + (mode === m.id ? " actif" : "")}>
                  {Math.round(p[m.id])}
                </span>
              ))}
            </div>
          );
        })}
      </div>
      <p className="bf-note">
        Touchez un joueur pour ses statistiques. Départ à {c.depart} · général = moyenne attaque/défense · K={c.k} ·
        variation minimale de {c.plancher} points.
        <br />
        Le poste tenu prend {Math.round(c.partRole * 100)} % de la variation, l'autre poste le reste.
        Multiplicateur d'écart de buts : {decrirePaliers(c)}.
        {inactifs > 0 && (
          <>
            <br />
            {inactifs} joueur{inactifs > 1 ? "s" : ""} masqué{inactifs > 1 ? "s" : ""} pour plus de {moisEnv(c.inactiviteJours)} mois sans jouer ·
            un match les ramène, Elo remis à {c.depart}.
          </>
        )}
      </p>
    </>
  );
}

function NouveauMatch({ ligue, joueurs, onValider }) {
  const [a, setA] = useState({ atk: "", def: "" });
  const [b, setB] = useState({ atk: "", def: "" });
  const [sa, setSa] = useState(10);
  const [sb, setSb] = useState(0);
  const [err, setErr] = useState("");

  const pris = [a.atk, a.def, b.atk, b.def].filter(Boolean);
  const complet = pris.length === 4;
  const nulMatch = sa === sb;

  const apercu = useMemo(() => {
    if (!complet || nulMatch) return null;
    const m = { a, b, sa, sb };
    if ([m.a.atk, m.a.def, m.b.atk, m.b.def].some((id) => !ligue.index[id])) return null;
    return deltasMatch(ligue.index, m, ligue.coefs);
  }, [complet, nulMatch, a, b, sa, sb, ligue]);

  const valider = () => {
    if (!complet) return setErr("Choisissez les quatre joueurs.");
    if (nulMatch) return setErr("Il faut un vainqueur : les scores ne peuvent pas être égaux.");
    setErr("");
    onValider({ a, b, sa, sb });
    setA({ atk: "", def: "" }); setB({ atk: "", def: "" });
    setSa(10); setSb(0);
  };

  if (joueurs.length < 4) {
    return (
      <div className="bf-vide">
        <p>Il faut quatre joueurs pour lancer une partie.</p>
        <p className="bf-vide-sous">{joueurs.length} inscrit{joueurs.length > 1 ? "s" : ""} pour l'instant. Complétez la liste dans l'onglet Joueurs.</p>
      </div>
    );
  }

  const nom = (id) => ligue.index[id]?.nom ?? "";

  return (
    <div className="bf-terrain">
      <div className="bf-camps">
        {[
          { eq: a, set: setA, cle: "rouge", titre: "Rouges", score: sa, setScore: setSa },
          { eq: b, set: setB, cle: "bleu", titre: "Bleus", score: sb, setScore: setSb },
        ].map((c) => (
          <div className={"bf-camp " + c.cle} key={c.cle}>
            <h3 className="bf-camp-titre">{c.titre}</h3>
            <label className="bf-poste">
              <span className="bf-poste-lib"><Barre role="attaque" couleur={`var(--${c.cle})`} />Attaque</span>
              <Choix
                value={c.eq.atk}
                onChange={(v) => c.set({ ...c.eq, atk: v })}
                joueurs={joueurs}
                exclus={pris}
                placeholder="Choisir…"
              />
            </label>
            <label className="bf-poste">
              <span className="bf-poste-lib"><Barre role="defense" couleur={`var(--${c.cle})`} />Défense</span>
              <Choix
                value={c.eq.def}
                onChange={(v) => c.set({ ...c.eq, def: v })}
                joueurs={joueurs}
                exclus={pris}
                placeholder="Choisir…"
              />
            </label>
            <Boulier
              value={c.score}
              onChange={c.setScore}
              couleur={`var(--${c.cle})`}
              label={`Buts des ${c.titre}`}
            />
          </div>
        ))}
      </div>

      <p className="bf-legende">
        Score de −5 à 10 : les perles à gauche du cran comptent les buts perdus.
      </p>

      {apercu && (
        <div className="bf-apercu">
          <div className="bf-apercu-cote">
            <b>Rouges</b> favoris à {Math.round(apercu.proba * 100)} %
            <span className="bf-muet"> · écart ×{apercu.mult}</span>
          </div>
          <ul className="bf-apercu-liste">
            {[
              { id: a.atk, role: "attaque", sens: 1 },
              { id: a.def, role: "defense", sens: 1 },
              { id: b.atk, role: "attaque", sens: -1 },
              { id: b.def, role: "defense", sens: -1 },
            ].map((l, k) => {
              const d = apercu.spec * l.sens;
              const pr = ligue.coefs.partRole;
              const dAtt = d * (l.role === "attaque" ? pr : 1 - pr);
              const dDef = d * (l.role === "defense" ? pr : 1 - pr);
              const cl = d > 0 ? "pos" : "neg";
              return (
                <li key={k}>
                  <span>{nom(l.id)}</span>
                  <b className={cl}>att {signe(dAtt)}</b>
                  <b className={cl}>déf {signe(dDef)}</b>
                  <em className="bf-muet">gén {signe(d / 2)}</em>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {err && <p className="bf-erreur">{err}</p>}
      <button className="bf-cta" onClick={valider}>Enregistrer le match</button>
    </div>
  );
}

function Deverrouiller({ onDeverrouiller, texte }) {
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [envoi, setEnvoi] = useState(false);

  const tenter = async () => {
    if (!code) return setErr("Entrez le code.");
    setEnvoi(true);
    try {
      await onDeverrouiller(code);
      setCode(""); setErr("");
    } catch (e) {
      setErr(e.message);
    } finally {
      setEnvoi(false);
    }
  };

  return (
    <>
      <p className="bf-zone-texte">{texte}</p>
      <div className="bf-ajout">
        <input
          className="bf-input"
          type="password"
          value={code}
          placeholder="Code de la ligue"
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && tenter()}
          aria-label="Code de la ligue"
        />
        <button className="bf-cta petit" onClick={tenter} disabled={envoi}>
          {envoi ? "Vérification…" : "Déverrouiller"}
        </button>
      </div>
      {err && <p className="bf-erreur">{err}</p>}
    </>
  );
}

// Édition en ligne d'un match : mêmes règles que la saisie (4 joueurs distincts, pas d'égalité).
function EditionMatch({ match, joueurs, onEnregistrer, onAnnuler }) {
  const [a, setA] = useState({ ...match.a });
  const [b, setB] = useState({ ...match.b });
  const [sa, setSa] = useState(match.sa);
  const [sb, setSb] = useState(match.sb);
  const [err, setErr] = useState("");

  const pris = [a.atk, a.def, b.atk, b.def].filter(Boolean);

  const enregistrer = () => {
    if (pris.length !== 4 || new Set(pris).size !== 4)
      return setErr("Quatre joueurs différents sont requis.");
    if (sa === sb) return setErr("Il faut un vainqueur.");
    setErr("");
    onEnregistrer({ a, b, sa, sb });
  };

  return (
    <li className="bf-match bf-match-edit">
      <div className="bf-edit-camps">
        {[
          { eq: a, set: setA, cle: "rouge", titre: "Rouges", score: sa, setScore: setSa },
          { eq: b, set: setB, cle: "bleu", titre: "Bleus", score: sb, setScore: setSb },
        ].map((c) => (
          <div className={"bf-edit-camp " + c.cle} key={c.cle}>
            <h4>{c.titre}</h4>
            <label className="bf-poste-mini">Attaque
              <Choix value={c.eq.atk} onChange={(v) => c.set({ ...c.eq, atk: v })}
                joueurs={joueurs} exclus={pris} placeholder="Choisir…" />
            </label>
            <label className="bf-poste-mini">Défense
              <Choix value={c.eq.def} onChange={(v) => c.set({ ...c.eq, def: v })}
                joueurs={joueurs} exclus={pris} placeholder="Choisir…" />
            </label>
            <Boulier value={c.score} onChange={c.setScore} couleur={`var(--${c.cle})`} label={`Buts des ${c.titre}`} />
          </div>
        ))}
      </div>
      {err && <p className="bf-erreur">{err}</p>}
      <div className="bf-edit-actions">
        <button className="bf-cta petit" onClick={enregistrer}>Enregistrer</button>
        <button className="bf-lien" onClick={onAnnuler}>Annuler</button>
      </div>
    </li>
  );
}

function Historique({ ligue, admin, onDeverrouiller, verrouiller, onSupprimer, onModifier }) {
  const [edite, setEdite] = useState(null); // id du match en cours d'édition

  if (!ligue.matchs.length) {
    return (
      <div className="bf-vide">
        <p>Aucun match enregistré.</p>
        <p className="bf-vide-sous">Le premier résultat de la pause de midi ouvrira l'historique.</p>
      </div>
    );
  }
  const nom = (id) => ligue.index[id]?.nom ?? "?";
  const date = (iso) =>
    new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

  const enregistrer = async (id, modif) => {
    await onModifier(id, modif);
    setEdite(null);
  };

  return (
    <>
      <ul className="bf-histo">
        {ligue.matchs.map((m) => {
          if (edite === m.id) {
            return (
              <EditionMatch
                key={m.id}
                match={m}
                joueurs={ligue.classement}
                onEnregistrer={(modif) => enregistrer(m.id, modif)}
                onAnnuler={() => setEdite(null)}
              />
            );
          }
          const rougeGagne = m.sa > m.sb;
          return (
            <li className="bf-match" key={m.id}>
              <div className="bf-match-date">{date(m.date)}</div>
              <div className="bf-match-corps">
                <div className={"bf-match-eq rouge" + (rougeGagne ? " gagnant" : "")}>
                  <span>{nom(m.a.atk)} <i>att</i></span>
                  <span>{nom(m.a.def)} <i>déf</i></span>
                  <span className="bf-match-moy">moy. {Math.round(m.moyA)}</span>
                </div>
                <div className="bf-match-score">
                  <b>{affScore(m.sa)}</b><span>–</span><b>{affScore(m.sb)}</b>
                  <em>{signe(Math.abs(m.delta))} Elo</em>
                </div>
                <div className={"bf-match-eq bleu" + (!rougeGagne ? " gagnant" : "")}>
                  <span><i>att</i> {nom(m.b.atk)}</span>
                  <span><i>déf</i> {nom(m.b.def)}</span>
                  <span className="bf-match-moy">moy. {Math.round(m.moyB)}</span>
                </div>
              </div>
              {admin && (
                <div className="bf-match-admin">
                  <button className="bf-lien" onClick={() => setEdite(m.id)}>Modifier</button>
                  <button className="bf-lien danger" onClick={() => onSupprimer(m.id)}>Supprimer</button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {admin ? (
        <p className="bf-note">
          Zone déverrouillée : chaque match peut être modifié ou supprimé, les Elo se recalculent aussitôt.{" "}
          <button className="bf-lien" onClick={verrouiller}>Verrouiller</button>
        </p>
      ) : (
        <section className="bf-zone">
          <h3 className="bf-zone-titre">Zone protégée</h3>
          <Deverrouiller
            onDeverrouiller={onDeverrouiller}
            texte="Modifier ou supprimer un match demande le code de la ligue."
          />
        </section>
      )}
    </>
  );
}

/* ── Statistiques par joueur ───────────────────────────────── */

// Une colonne de confrontations (coéquipiers ou adversaires), triée par nombre de matchs.
function ColonneDuels({ titre, legGauche, legDroite, verbe, table, index }) {
  const lignes = Object.entries(table)
    .map(([id, e]) => ({ nom: index[id]?.nom ?? "?", v: e.v, j: e.j }))
    .sort((x, y) => y.j - x.j || y.v - x.v);

  return (
    <div className="bf-stat-col">
      <h3 className="bf-stat-col-titre">{titre}</h3>
      <p className="bf-stat-leg">
        <i className="bf-sw clair" /> {legGauche}
        <i className="bf-sw fonce" /> {legDroite}
      </p>
      {lignes.length ? (
        <ul className="bf-duels">
          {lignes.map((l) => (
            <li key={l.nom}>
              <span className="bf-duel-nom">{l.nom}</span>
              <span className="bf-duel-barre" aria-label={`${l.v} ${verbe} sur ${l.j}`}>
                <span className="bf-duel-fond" style={{ width: (l.j / lignes[0].j) * 100 + "%" }}>
                  <span className="bf-duel-plein" style={{ width: (l.v / l.j) * 100 + "%" }} />
                </span>
              </span>
              <span className="bf-duel-chiffre">{l.v}<em> / {l.j}</em></span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="bf-muet bf-duel-vide">aucune donnée dans ce classement</p>
      )}
    </div>
  );
}

function Statistiques({ ligue, selection, setSelection }) {
  const [mode, setMode] = useState("general");

  // Joueurs ayant au moins un match, triés par volume de matchs (généraux).
  const joueurs = useMemo(
    () =>
      ligue.classement
        .filter((p) => p.stats.general.j > 0)
        .sort((a, b) => b.stats.general.j - a.stats.general.j),
    [ligue]
  );

  // Le joueur montré : la sélection si elle est valable, sinon le plus actif.
  const choisi =
    (selection && ligue.index[selection]?.stats.general.j > 0 && ligue.index[selection]) ||
    joueurs[0] ||
    null;

  if (!choisi) {
    return (
      <div className="bf-vide">
        <p>Aucune statistique pour l'instant.</p>
        <p className="bf-vide-sous">Elles apparaîtront dès le premier match enregistré.</p>
      </div>
    );
  }

  const s = choisi.stats[mode];
  const pct = s.j ? Math.round((s.v / s.j) * 100) : 0;
  const labelMode = MODES.find((m) => m.id === mode).label.toLowerCase();

  return (
    <>
      <div className="bf-stat-choix" role="tablist" aria-label="Choisir un joueur">
        {joueurs.map((p) => (
          <button
            key={p.id}
            role="tab"
            aria-selected={p.id === choisi.id}
            className={"bf-chip" + (p.id === choisi.id ? " on" : "")}
            onClick={() => setSelection(p.id)}
          >
            {p.nom}<b>{p.stats.general.j}</b>
          </button>
        ))}
      </div>

      <div className="bf-segments" role="tablist" aria-label="Type de statistiques">
        {MODES.map((m) => (
          <button
            key={m.id}
            role="tab"
            aria-selected={mode === m.id}
            className={"bf-seg" + (mode === m.id ? " on" : "")}
            onClick={() => setMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="bf-stat-tete">
        <h2 className="bf-stat-nom">{choisi.nom}</h2>
        {s.j ? (
          <div className="bf-stat-kpis">
            <span><b>{s.j}</b> match{s.j > 1 ? "s" : ""}</span>
            <span><b>{s.v}</b> victoire{s.v > 1 ? "s" : ""}</span>
            <span><b>{pct}</b><em> %</em> de victoires</span>
            <span className="bf-stat-elo"><b>{Math.round(choisi[mode])}</b> Elo{!choisi.actif ? " · inactif" : ""}</span>
          </div>
        ) : (
          <p className="bf-muet">Aucun match en {labelMode}.</p>
        )}
      </div>

      {s.j > 0 && (
        <div className="bf-stat-grille">
          <ColonneDuels
            titre="Avec qui il joue"
            legGauche="Matchs ensemble"
            legDroite="Victoires"
            verbe="gagnés ensemble"
            table={s.coequipiers}
            index={ligue.index}
          />
          <ColonneDuels
            titre="Contre qui il gagne"
            legGauche="Affrontés"
            legDroite="Battus"
            verbe="battus"
            table={s.adversaires}
            index={ligue.index}
          />
        </div>
      )}

      <p className="bf-note">
        Statistiques en {labelMode}, sur toute la saison — y compris les matchs d'avant une éventuelle pause.
        Les barres claires comptent les matchs, les barres foncées les victoires.
      </p>
    </>
  );
}

/* ── Onglet Graphiques ─────────────────────────────────────── */

const PALETTE = ["#E8C15C","#3277E0","#DC3049","#7BD389","#C08552","#B07CE0","#45C4D6","#E8734A","#9FB3A8","#F0866A"];

// Courbe d'Elo jour par jour pour les joueurs sélectionnés, dans un mode donné.
function CourbeElo({ series, modeLabel }) {
  const W = 720, H = 300, mL = 44, mR = 14, mT = 14, mB = 34;
  const tous = series.flatMap((s) => s.points);
  if (tous.length < 1) {
    return <p className="bf-muet bf-graph-vide">Pas encore de données à tracer.</p>;
  }
  const jours = [...new Set(tous.map((p) => p.jour))].sort();
  const idxJour = Object.fromEntries(jours.map((j, i) => [j, i]));
  const nJours = Math.max(1, jours.length - 1);

  let lo = Math.min(...tous.map((p) => p.elo));
  let hi = Math.max(...tous.map((p) => p.elo));
  const marge = Math.max(20, (hi - lo) * 0.12);
  lo = Math.floor((lo - marge) / 10) * 10;
  hi = Math.ceil((hi + marge) / 10) * 10;

  const x = (jour) => mL + (nJours ? idxJour[jour] / nJours : 0) * (W - mL - mR);
  const y = (elo) => mT + (1 - (elo - lo) / (hi - lo)) * (H - mT - mB);

  // graduations Y : 4 repères
  const ticks = Array.from({ length: 4 }, (_, i) => Math.round(lo + ((hi - lo) * i) / 3));
  // quelques dates en X
  const pas = Math.max(1, Math.ceil(jours.length / 6));
  const datesX = jours.filter((_, i) => i % pas === 0);
  const jjmm = (j) => `${j.slice(8, 10)}/${j.slice(5, 7)}`;

  return (
    <div className="bf-graph-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="bf-graph-svg" role="img"
        aria-label={`Évolution de l'Elo en ${modeLabel}`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={mL} x2={W - mR} y1={y(t)} y2={y(t)} className="bf-grid" />
            <text x={mL - 6} y={y(t) + 4} className="bf-axe" textAnchor="end">{t}</text>
          </g>
        ))}
        {datesX.map((j) => (
          <text key={j} x={x(j)} y={H - 12} className="bf-axe" textAnchor="middle">{jjmm(j)}</text>
        ))}
        {series.map((s) => {
          if (!s.points.length) return null;
          const d = s.points.map((p, i) => `${i ? "L" : "M"}${x(p.jour).toFixed(1)} ${y(p.elo).toFixed(1)}`).join(" ");
          return (
            <g key={s.id}>
              <path d={d} fill="none" stroke={s.couleur} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
              {s.points.length === 1 && <circle cx={x(s.points[0].jour)} cy={y(s.points[0].elo)} r="3.5" fill={s.couleur} />}
              <circle cx={x(s.points[s.points.length - 1].jour)} cy={y(s.points[s.points.length - 1].elo)} r="3.5" fill={s.couleur} />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// Barres horizontales de victoires / défaites pour les joueurs sélectionnés.
function BarresVD({ series }) {
  const max = Math.max(1, ...series.map((s) => s.j));
  return (
    <ul className="bf-vd">
      {series.map((s) => {
        const pct = s.j ? Math.round((s.v / s.j) * 100) : 0;
        return (
          <li key={s.id}>
            <span className="bf-vd-nom" style={{ color: s.couleur }}>{s.nom}</span>
            <span className="bf-vd-barre" style={{ width: (s.j / max) * 100 + "%" }}>
              <span className="bf-vd-v" style={{ width: pct + "%" }} />
            </span>
            <span className="bf-vd-chiffre">{pct}<em>%</em> · {s.v}<i>V</i> {s.d}<i>D</i></span>
          </li>
        );
      })}
    </ul>
  );
}

function Graphiques({ ligue, selection, setSelection }) {
  const [mode, setMode] = useState("general");

  // On ne propose que les joueurs actifs ayant au moins un match, triés par Elo du mode.
  const dispo = useMemo(
    () => ligue.classement
      .filter((p) => p.actif && p.stats.general.j > 0)
      .sort((a, b) => b[mode] - a[mode]),
    [ligue, mode]
  );

  // Sélection par défaut : les 3 premiers, une fois, si rien n'est choisi.
  const [choix, setChoix] = useState(() => new Set(selection ? [selection] : []));
  useEffect(() => {
    setChoix((prev) => {
      if (prev.size) return prev;
      const base = selection ? [selection] : dispo.slice(0, 3).map((p) => p.id);
      return new Set(base.filter((id) => dispo.some((p) => p.id === id)));
    });
    // eslint-disable-next-line
  }, [dispo.length]);

  const bascule = (id) => {
    setChoix((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
    setSelection(null);
  };

  const couleurDe = {};
  [...choix].forEach((id, i) => { couleurDe[id] = PALETTE[i % PALETTE.length]; });

  const series = [...choix]
    .map((id) => ligue.index[id])
    .filter(Boolean)
    .map((p) => {
      const s = p.stats[mode];
      const points = Object.entries(s.courbe)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([jour, elo]) => ({ jour, elo }));
      return { id: p.id, nom: p.nom, couleur: couleurDe[p.id], points, j: s.j, v: s.v, d: s.d };
    });

  if (!dispo.length) {
    return (
      <div className="bf-vide">
        <p>Aucun joueur actif à tracer.</p>
        <p className="bf-vide-sous">Les courbes apparaissent dès les premiers matchs.</p>
      </div>
    );
  }

  const labelMode = MODES.find((m) => m.id === mode).label;

  return (
    <>
      <div className="bf-segments" role="tablist" aria-label="Type de courbe">
        {MODES.map((m) => (
          <button key={m.id} role="tab" aria-selected={mode === m.id}
            className={"bf-seg" + (mode === m.id ? " on" : "")} onClick={() => setMode(m.id)}>
            {m.label}
          </button>
        ))}
      </div>

      <p className="bf-graph-consigne">Choisissez les joueurs à comparer :</p>
      <div className="bf-stat-choix">
        {dispo.map((p) => {
          const on = choix.has(p.id);
          return (
            <button key={p.id}
              className={"bf-chip" + (on ? " on" : "")}
              style={on ? { borderColor: couleurDe[p.id], background: couleurDe[p.id] + "22" } : undefined}
              onClick={() => bascule(p.id)}>
              {on && <i className="bf-puce" style={{ background: couleurDe[p.id] }} />}
              {p.nom}<b>{Math.round(p[mode])}</b>
            </button>
          );
        })}
      </div>

      {series.length ? (
        <>
          <h3 className="bf-graph-titre">Évolution de l'Elo en {labelMode.toLowerCase()}</h3>
          <CourbeElo series={series} modeLabel={labelMode} />
          <h3 className="bf-graph-titre">Victoires et défaites</h3>
          <BarresVD series={series} />
          <p className="bf-note">
            Un point par jour joué : l'Elo en fin de journée. Les pourcentages de victoire portent sur
            tous les matchs du joueur en {labelMode.toLowerCase()}.
          </p>
        </>
      ) : (
        <p className="bf-muet bf-graph-vide">Sélectionnez au moins un joueur ci-dessus.</p>
      )}
    </>
  );
}

/* ── Onglet Formule & coefficients ─────────────────────────── */

// Champ d'édition d'une formule, avec contrôle de validité en direct.
function ChampFormule({ label, valeur, onChange, variables, standard, apercu }) {
  const vide = !valeur || !valeur.trim();
  const etat = useMemo(() => {
    if (vide) return { ok: true, standard: true };
    const r = compilerFormule(valeur, variables);
    if (r.erreur) return { ok: false, msg: r.erreur };
    try {
      const v = r.fn(apercu.vars);
      if (!isFinite(v)) return { ok: false, msg: "Résultat non fini." };
      return { ok: true, exemple: v };
    } catch (e) { return { ok: false, msg: e.message }; }
  }, [valeur, variables, apercu]);

  return (
    <div className="bf-formchamp">
      <div className="bf-formchamp-tete">
        <label>{label}</label>
        <button type="button" className="bf-lien" onClick={() => onChange("")}>formule standard</button>
      </div>
      <input
        className={"bf-input bf-mono" + (etat.ok ? "" : " invalide")}
        value={valeur || ""}
        placeholder={standard}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
      <p className="bf-formchamp-aide">
        Variables : <b>{variables.join(", ")}</b> · fonctions : min, max, abs, log, sqrt, exp, pow.
      </p>
      {etat.standard ? (
        <p className="bf-formchamp-ok">Vide = formule standard : <code>{standard}</code></p>
      ) : etat.ok ? (
        <p className="bf-formchamp-ok">Valide · {apercu.libelle} → <b>{etat.exemple.toFixed(2)}</b></p>
      ) : (
        <p className="bf-formchamp-err">{etat.msg}</p>
      )}
    </div>
  );
}

function Formule({ ligue, admin, onDeverrouiller, verrouiller, onDefinir }) {
  const c = ligue.coefs;
  const [brouillon, setBrouillon] = useState(null); // copie éditable quand on règle
  const [err, setErr] = useState("");
  const [confirme, setConfirme] = useState(false);

  // (Re)synchronise le brouillon sur les coefficients courants à l'ouverture de l'édition.
  const ouvrirEdition = () => { setBrouillon(JSON.parse(JSON.stringify(c))); setErr(""); setConfirme(false); };

  const champ = (cle, valeur) => setBrouillon((b) => ({ ...b, [cle]: valeur }));
  const champPalier = (i, cle, valeur) =>
    setBrouillon((b) => ({ ...b, paliers: b.paliers.map((p, k) => (k === i ? { ...p, [cle]: valeur } : p)) }));

  const enregistrer = async () => {
    const b = brouillon;
    const nb = (v) => (v === "" || v === null ? NaN : Number(v));
    const coefs = {
      depart: nb(b.depart), k: nb(b.k), plancher: nb(b.plancher),
      partRole: nb(b.partRole), inactiviteJours: nb(b.inactiviteJours),
      paliers: b.paliers.map((p) => ({ ecart: nb(p.ecart), facteur: nb(p.facteur) })),
      // chaîne vide = retour au standard ; le serveur revalide de toute façon.
      formuleDelta: (b.formuleDelta || "").trim(),
      formuleMult: (b.formuleMult || "").trim(),
    };
    try {
      await onDefinir(coefs);
      setBrouillon(null); setConfirme(false); setErr("");
    } catch (e) {
      setErr(e.message);
    }
  };

  const Val = ({ children }) => <b className="bf-f-val">{children}</b>;

  return (
    <>
      <div className="bf-formule">
        <h2 className="bf-f-titre">Comment l'Elo est calculé</h2>

        <section className="bf-f-bloc">
          <h3>1 · La force d'une équipe</h3>
          <p>
            Chaque joueur a deux notes, une en attaque et une en défense. La force d'une équipe pour un match
            est la moyenne de l'attaquant <em>en attaque</em> et du défenseur <em>en défense</em> :
          </p>
          <p className="bf-f-math">R<sub>équipe</sub> = ( Elo<sub>att</sub>(attaquant) + Elo<sub>déf</sub>(défenseur) ) / 2</p>
        </section>

        <section className="bf-f-bloc">
          <h3>2 · La probabilité de gagner</h3>
          <p>Face à l'équipe adverse de force R<sub>adv</sub>, l'espérance de victoire suit la formule Elo classique :</p>
          <p className="bf-f-math">E = 1 / ( 1 + 10<sup>(R<sub>adv</sub> − R<sub>équipe</sub>) / 400</sup> )</p>
          <p>Un écart de 400 points correspond à environ 10 chances sur 11.</p>
        </section>

        <section className="bf-f-bloc">
          <h3>3 · Les points échangés</h3>
          <p>Le résultat vaut 1 pour une victoire, 0 pour une défaite. La variation de base est :</p>
          <p className="bf-f-math">Δ = {c.formuleDelta ? c.formuleDelta : "K × mult × ( résultat − E )"}</p>
          {c.formuleDelta && <p className="bf-f-custom">Formule personnalisée en place.</p>}
          <p>
            où <Val>K = {c.k}</Val> règle l'ampleur générale, et <b>mult</b> dépend de l'écart de buts.
            La variation est ensuite plafonnée à un minimum de <Val>{c.plancher} points</Val> pour le vainqueur
            comme pour le perdant.
          </p>
          {c.formuleMult ? (
            <p className="bf-f-math">mult = {c.formuleMult} <span className="bf-f-custom">personnalisée</span></p>
          ) : (
            <div className="bf-f-paliers">
              {[...c.paliers].sort((a, b) => a.ecart - b.ecart).map((p, i, t) => {
                const suiv = t[i + 1];
                const borne = suiv ? suiv.ecart - 1 : null;
                const plage = i === t.length - 1 ? `${p.ecart}+` : p.ecart === borne ? `${p.ecart}` : `${p.ecart}–${borne}`;
                return <span key={i} className="bf-f-palier"><b>×{p.facteur}</b> écart {plage}</span>;
              })}
            </div>
          )}
        </section>

        <section className="bf-f-bloc">
          <h3>4 · La répartition entre les postes</h3>
          <p>
            Le poste réellement tenu reçoit <Val>{Math.round(c.partRole * 100)} %</Val> de la variation,
            l'autre poste le reste. Le général est toujours la moyenne de l'attaque et de la défense.
          </p>
        </section>

        <section className="bf-f-bloc">
          <h3>5 · L'inactivité</h3>
          <p>
            Sans match depuis plus de <Val>{c.inactiviteJours} jours</Val> (≈ {moisEnv(c.inactiviteJours)} mois),
            un joueur quitte le classement. S'il rejoue, son Elo repart de <Val>{c.depart}</Val> ;
            ses anciens matchs restent dans l'historique et ses statistiques.
          </p>
        </section>
      </div>

      <section className="bf-zone">
        <h3 className="bf-zone-titre">Réglage du modèle</h3>
        {!admin ? (
          <Deverrouiller
            onDeverrouiller={onDeverrouiller}
            texte="Modifier les coefficients demande le code de la ligue. Attention : tout changement recalcule l'intégralité du classement."
          />
        ) : !brouillon ? (
          <>
            <p className="bf-zone-texte ouverte">Zone déverrouillée.</p>
            <div className="bf-ajout">
              <button className="bf-cta petit" onClick={ouvrirEdition}>Modifier les coefficients</button>
              <button className="bf-lien" onClick={verrouiller}>Verrouiller</button>
            </div>
          </>
        ) : (
          <div className="bf-reglage">
            <p className="bf-reglage-avert">
              Changer un coefficient recalcule tous les Elo depuis le premier match. L'historique des matchs
              n'est pas modifié, mais chaque classement change.
            </p>
            <div className="bf-reglage-grille">
              <label>Elo de départ
                <input className="bf-input" type="number" value={brouillon.depart}
                  onChange={(e) => champ("depart", e.target.value)} />
              </label>
              <label>K (ampleur)
                <input className="bf-input" type="number" value={brouillon.k}
                  onChange={(e) => champ("k", e.target.value)} />
              </label>
              <label>Variation minimale
                <input className="bf-input" type="number" value={brouillon.plancher}
                  onChange={(e) => champ("plancher", e.target.value)} />
              </label>
              <label>Part du poste tenu (0,5–1)
                <input className="bf-input" type="number" step="0.05" value={brouillon.partRole}
                  onChange={(e) => champ("partRole", e.target.value)} />
              </label>
              <label>Inactivité (jours)
                <input className="bf-input" type="number" value={brouillon.inactiviteJours}
                  onChange={(e) => champ("inactiviteJours", e.target.value)} />
              </label>
            </div>

            <p className="bf-reglage-sous">Multiplicateur par écart de buts (écart minimum → facteur) :</p>
            <div className="bf-reglage-paliers">
              {brouillon.paliers.map((p, i) => (
                <div className="bf-reglage-palier" key={i}>
                  <span>à partir de</span>
                  <input className="bf-input" type="number" value={p.ecart}
                    onChange={(e) => champPalier(i, "ecart", e.target.value)} />
                  <span>buts → ×</span>
                  <input className="bf-input" type="number" value={p.facteur}
                    onChange={(e) => champPalier(i, "facteur", e.target.value)} />
                </div>
              ))}
            </div>

            <details className="bf-avance">
              <summary>Formules avancées (facultatif)</summary>
              <p className="bf-reglage-sous">
                Remplacez le calcul par votre propre expression. Laissez vide pour garder le calcul standard.
                Une formule invalide est refusée à l'enregistrement.
              </p>
              <ChampFormule
                label="Multiplicateur (mult)"
                valeur={brouillon.formuleMult}
                onChange={(v) => champ("formuleMult", v)}
                variables={VARS_MULT}
                standard="paliers ci-dessus"
                apercu={{ vars: { ecart: 5 }, libelle: "écart 5" }}
              />
              <ChampFormule
                label="Points échangés (Δ)"
                valeur={brouillon.formuleDelta}
                onChange={(v) => champ("formuleDelta", v)}
                variables={VARS_DELTA}
                standard="K * mult * (res - E)"
                apercu={{ vars: { K: brouillon.k || 24, mult: 2, E: 0.5, res: 1, ecart: 4 }, libelle: "match gagné, mult 2" }}
              />
            </details>

            {err && <p className="bf-erreur">{err}</p>}

            {confirme ? (
              <div className="bf-zone-confirm">
                <p>Appliquer ces coefficients et recalculer tout le classement ?</p>
                <div className="bf-ajout">
                  <button className="bf-cta petit danger" onClick={enregistrer}>Oui, appliquer</button>
                  <button className="bf-lien" onClick={() => setConfirme(false)}>Revenir</button>
                </div>
              </div>
            ) : (
              <div className="bf-ajout">
                <button className="bf-cta petit" onClick={() => { setErr(""); setConfirme(true); }}>Enregistrer</button>
                <button className="bf-lien" onClick={() => { setBrouillon(null); setErr(""); }}>Annuler</button>
              </div>
            )}
          </div>
        )}
      </section>
    </>
  );
}

/* ── Onglet Saison ─────────────────────────────────────────── */

// La saison d'une date : 1er sept → 31 août. "AAAA-AAAA+1".
function saisonDe(dateIso) {
  const d = new Date(dateIso);
  const an = d.getUTCFullYear();
  const debut = d.getUTCMonth() >= 8 ? an : an - 1;
  return `${debut}-${debut + 1}`;
}

const MEDAILLES = ["or", "argent", "bronze"]; // index 0,1,2 = 1er,2e,3e

// Une étoile (award) : or, argent ou bronze.
function Etoile({ rang, titre }) {
  return (
    <svg viewBox="0 0 24 24" className={"bf-etoile " + rang} role="img" aria-label={titre}>
      <title>{titre}</title>
      <path d="M12 2.6l2.6 5.9 6.4.6-4.8 4.2 1.4 6.3L12 16.9 6.4 19.6l1.4-6.3L3 9.1l6.4-.6z"
        fill="currentColor" stroke="rgba(0,0,0,.25)" strokeWidth="0.6" strokeLinejoin="round" />
    </svg>
  );
}

// Une coupe de tenant du titre, avec le numéro de place.
function Coupe({ rang, place }) {
  return (
    <span className={"bf-coupe " + rang} title={`Tenant du titre — ${place}${place === 1 ? "er" : "e"}`}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 4h10v3a5 5 0 0 1-10 0z" fill="currentColor" />
        <path d="M7 5H4.5a2.5 2.5 0 0 0 2.5 3M17 5h2.5a2.5 2.5 0 0 1-2.5 3"
          fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M10 11h4v3h-4zM8 19h8v1.6H8zM9.5 14h5l-.4 5h-4.2z" fill="currentColor" />
      </svg>
      <b>{place}</b>
    </span>
  );
}

// Les petites étoiles cumulées d'un joueur, affichées à côté du pseudo.
function Palmes({ palmares, id }) {
  const p = palmares[id];
  if (!p || (!p.or && !p.argent && !p.bronze)) return null;
  return (
    <span className="bf-palmes" aria-label={`${p.or} or, ${p.argent} argent, ${p.bronze} bronze`}>
      {p.or > 0 && <span className="bf-palme or"><Etoile rang="or" titre="étoile(s) or" />{p.or > 1 && <em>{p.or}</em>}</span>}
      {p.argent > 0 && <span className="bf-palme argent"><Etoile rang="argent" titre="étoile(s) argent" />{p.argent > 1 && <em>{p.argent}</em>}</span>}
      {p.bronze > 0 && <span className="bf-palme bronze"><Etoile rang="bronze" titre="étoile(s) bronze" />{p.bronze > 1 && <em>{p.bronze}</em>}</span>}
    </span>
  );
}

// Tableau de classement d'une saison. `coupes` = { id: place } pour les tenants du titre.
function TableSaison({ lignes, mode, palmares, coupes }) {
  if (!lignes.length) {
    return <p className="bf-muet bf-saison-vide">Aucun joueur classé.</p>;
  }
  return (
    <div className="bf-table bf-table-saison" role="table">
      <div className="bf-tr bf-thead" role="row">
        <span className="bf-c-rang">#</span>
        <span className="bf-c-nom">Joueur</span>
        {MODES.map((m) => (
          <span key={m.id} className={"bf-c-elo" + (mode === m.id ? " actif" : "")}>{m.label.slice(0, 3)}</span>
        ))}
      </div>
      {lignes.map((p, i) => (
        <div className="bf-tr" role="row" key={p.id || p.nom}>
          <span className="bf-c-rang"><i className={"bf-rang r" + (i < 3 ? i + 1 : 0)}>{i + 1}</i></span>
          <span className="bf-c-nom">
            <span className="bf-nom-ligne">
              {p.nom}
              {coupes && coupes[p.id] && <Coupe rang={MEDAILLES[coupes[p.id] - 1]} place={coupes[p.id]} />}
              {palmares && <Palmes palmares={palmares} id={p.id} />}
            </span>
          </span>
          {MODES.map((m) => (
            <span key={m.id} className={"bf-c-elo" + (mode === m.id ? " actif" : "")}>{Math.round(p[m.id])}</span>
          ))}
        </div>
      ))}
    </div>
  );
}

// Additionne les étoiles de toutes les saisons : palmares[id] = {nom, or, argent, bronze}.
// Palmarès détaillé par catégorie : parCat[cat][id] = {nom, or, argent, bronze}.
// Les étoiles restent rattachées à leur catégorie d'obtention.
function cumulParCategorie(archives, index) {
  const parCat = { general: {}, attaque: {}, defense: {} };
  const ajoute = (cat, id, cle) => {
    if (!id) return;
    const t = parCat[cat];
    const nom = index[id]?.nom || id;
    const e = t[id] || (t[id] = { id, nom, or: 0, argent: 0, bronze: 0 });
    e[cle] += 1;
  };
  for (const s of archives) {
    if (!s.awards) continue;
    for (const cat of ["general", "attaque", "defense"]) {
      const podium = s.awards[cat] || [];
      if (podium[0]) ajoute(cat, podium[0], "or");
      if (podium[1]) ajoute(cat, podium[1], "argent");
      if (podium[2]) ajoute(cat, podium[2], "bronze");
    }
  }
  return parCat;
}

// Somme des trois catégories : total[id] = {nom, or, argent, bronze} toutes catégories confondues.
function totalPalmares(parCat, index) {
  const tot = {};
  for (const cat of ["general", "attaque", "defense"]) {
    for (const e of Object.values(parCat[cat])) {
      const t = tot[e.id] || (tot[e.id] = { id: e.id, nom: index[e.id]?.nom || e.nom, or: 0, argent: 0, bronze: 0 });
      t.or += e.or; t.argent += e.argent; t.bronze += e.bronze;
    }
  }
  return tot;
}

function Saisons({ ligue, saisons, palmaresParCat }) {
  const [mode, setMode] = useState("general");

  const archives = saisons || [];
  const dernierMatch = ligue.matchs[0];
  const saisonCourante = saisonDe(dernierMatch ? dernierMatch.date : new Date().toISOString());

  // Onglets du sélecteur : "Palmarès" d'abord, puis la saison en cours, puis les archives.
  const options = useMemo(
    () => [
      { code: "palmares", palmares: true },
      { code: saisonCourante, encours: true },
      ...archives.map((s) => ({ code: s.saison, encours: false })),
    ],
    [saisonCourante, archives]
  );
  const [choix, setChoix] = useState(saisonCourante);
  const vraiChoix = options.some((o) => o.code === choix) ? choix : saisonCourante;
  const estPalmares = vraiChoix === "palmares";
  const estCourante = vraiChoix === saisonCourante;

  // Palmarès de la catégorie affichée (étoiles gagnées dans cette catégorie).
  const palmaresListe = useMemo(() => {
    const t = (palmaresParCat && palmaresParCat[mode]) || {};
    return Object.values(t)
      .map((p) => ({ ...p, total: p.or * 3 + p.argent * 2 + p.bronze }))
      .sort((a, b) => b.or - a.or || b.argent - a.argent || b.bronze - a.bronze || b.total - a.total);
  }, [palmaresParCat, mode]);

  // Classement de la saison choisie (sans étoiles ni coupes : tout cela est dans l'onglet Classement).
  const courant = useMemo(
    () => ligue.classement.filter((p) => p.stats.general.j > 0).sort((a, b) => b[mode] - a[mode]),
    [ligue, mode]
  );
  const archiveChoisie = archives.find((s) => s.saison === vraiChoix);
  const lignes = estCourante
    ? courant
    : archiveChoisie ? [...archiveChoisie.classement].sort((a, b) => b[mode] - a[mode]) : [];

  const libelle = (s) => "Saison " + s.replace("-", "–");
  const labelMode = MODES.find((m) => m.id === mode).label;

  return (
    <>
      <div className="bf-stat-choix" role="tablist" aria-label="Choisir une saison">
        {options.map((o) => (
          <button key={o.code} role="tab" aria-selected={o.code === vraiChoix}
            className={"bf-chip" + (o.code === vraiChoix ? " on" : "") + (o.palmares ? " bf-chip-palm" : "")}
            onClick={() => setChoix(o.code)}>
            {o.palmares ? "Palmarès" : o.code.replace("-", "–")}{o.encours && <b>en cours</b>}
          </button>
        ))}
      </div>

      <div className="bf-segments" role="tablist" aria-label="Catégorie">
        {MODES.map((m) => (
          <button key={m.id} role="tab" aria-selected={mode === m.id}
            className={"bf-seg" + (mode === m.id ? " on" : "")} onClick={() => setMode(m.id)}>
            {m.label}
          </button>
        ))}
      </div>

      {estPalmares ? (
        palmaresListe.length ? (
          <section className="bf-saison-bloc">
            <h2 className="bf-saison-titre bf-palm-titre">
              Palmarès <span className="bf-palm-sous">{labelMode} · toutes saisons</span>
            </h2>
            <div className="bf-table bf-table-saison" role="table">
              <div className="bf-tr bf-palm-tr bf-thead" role="row">
                <span className="bf-c-rang">#</span>
                <span className="bf-c-nom">Joueur</span>
                <span className="bf-palm-c"><Etoile rang="or" titre="or" /></span>
                <span className="bf-palm-c"><Etoile rang="argent" titre="argent" /></span>
                <span className="bf-palm-c"><Etoile rang="bronze" titre="bronze" /></span>
              </div>
              {palmaresListe.map((p, i) => (
                <div className="bf-tr bf-palm-tr" role="row" key={p.id}>
                  <span className="bf-c-rang"><i className={"bf-rang r" + (i < 3 ? i + 1 : 0)}>{i + 1}</i></span>
                  <span className="bf-c-nom"><span className="bf-nom-ligne">{p.nom}</span></span>
                  <span className="bf-palm-c or">{p.or || "·"}</span>
                  <span className="bf-palm-c argent">{p.argent || "·"}</span>
                  <span className="bf-palm-c bronze">{p.bronze || "·"}</span>
                </div>
              ))}
            </div>
            <p className="bf-note">
              Étoiles gagnées sur les podiums <b>{labelMode.toLowerCase()}</b> de toutes les saisons terminées.
              Changez de catégorie ci-dessus pour l'attaque ou la défense.
            </p>
          </section>
        ) : (
          <div className="bf-vide">
            <p>Aucun palmarès en {labelMode.toLowerCase()} pour l'instant.</p>
            <p className="bf-vide-sous">Les étoiles arrivent à la fin de la première saison.</p>
          </div>
        )
      ) : (
        <>
          <section className="bf-saison-bloc">
            <h2 className="bf-saison-titre">
              {libelle(vraiChoix)}
              <span className={estCourante ? "bf-saison-encours" : "bf-saison-close"}>
                {estCourante ? "en cours" : "terminée"}
              </span>
            </h2>
            <TableSaison lignes={lignes} mode={mode} palmares={null} coupes={null} />
          </section>

          <p className="bf-note">
            Une saison va du 1er septembre au 31 août. À la clôture, le podium de chaque catégorie reçoit une étoile
            or, argent ou bronze (voir l'onglet Palmarès) et tout le monde repart à {ligue.coefs.depart}.
            Les coupes et étoiles s'affichent dans l'onglet Classement.
          </p>
        </>
      )}
    </>
  );
}

function Joueurs({ ligue, joueurs, matchs, admin, onDeverrouiller, verrouiller, onAjouter, onRenommer, onSupprimer, onReinitialiser }) {
  const [nom, setNom] = useState("");
  const [err, setErr] = useState("");
  const [edition, setEdition] = useState(null); // { id, valeur }
  const [confirme, setConfirme] = useState(false);

  // Dernier signe de vie : le match le plus récent, sinon la date d'inscription.
  const activite = useMemo(() => {
    const map = {};
    joueurs.forEach((j) => { map[j.id] = j.depuis || new Date().toISOString(); });
    matchs.forEach((m) => {
      [m.a.atk, m.a.def, m.b.atk, m.b.def].forEach((id) => {
        if (map[id] !== undefined && m.date > map[id]) map[id] = m.date;
      });
    });
    return map;
  }, [joueurs, matchs]);

  const libreLe = (id) => new Date(new Date(activite[id]).getTime() + AN_MS);
  const dateCourte = (d) => d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });

  const nomLibre = (n, saufId) =>
    !joueurs.some((j) => j.id !== saufId && j.nom.toLowerCase() === n.toLowerCase());

  const ajouter = () => {
    const n = nom.trim();
    if (!n) return setErr("Entrez un nom.");
    if (!nomLibre(n)) return setErr("Ce pseudo est déjà pris.");
    setErr("");
    onAjouter(n);
    setNom("");
  };

  const enregistrerPseudo = () => {
    const n = edition.valeur.trim();
    if (!n) return setErr("Le pseudo ne peut pas être vide.");
    if (!nomLibre(n, edition.id)) return setErr("Ce pseudo est déjà pris.");
    setErr("");
    onRenommer(edition.id, n);
    setEdition(null);
  };

  return (
    <>
      <div className="bf-ajout">
        <input
          className="bf-input"
          value={nom}
          placeholder="Pseudo du joueur"
          onChange={(e) => setNom(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ajouter()}
          aria-label="Pseudo du joueur"
        />
        <button className="bf-cta petit" onClick={ajouter}>Inscrire</button>
      </div>
      {err && <p className="bf-erreur">{err}</p>}

      <ul className="bf-joueurs">
        {joueurs.map((j) => {
          const p = ligue.index[j.id];
          const dispo = libreLe(j.id);
          const retirable = admin || dispo <= new Date();
          const enEdition = admin && edition?.id === j.id;
          return (
            <li key={j.id}>
              {enEdition ? (
                <div className="bf-j-edition">
                  <input
                    className="bf-input"
                    autoFocus
                    value={edition.valeur}
                    onChange={(e) => setEdition({ ...edition, valeur: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") enregistrerPseudo();
                      if (e.key === "Escape") { setEdition(null); setErr(""); }
                    }}
                    aria-label={"Nouveau pseudo de " + j.nom}
                  />
                  <button className="bf-cta petit" onClick={enregistrerPseudo}>Enregistrer</button>
                  <button className="bf-lien" onClick={() => { setEdition(null); setErr(""); }}>Annuler</button>
                </div>
              ) : (
                <>
                  <span className="bf-j-nom">{j.nom}</span>
                  <span className="bf-j-elos">
                    <b>{Math.round(p.general)}</b> gén
                    <b>{Math.round(p.attaque)}</b> att
                    <b>{Math.round(p.defense)}</b> déf
                  </span>
                  <span className="bf-j-actions">
                    {admin && (
                      <button className="bf-lien" onClick={() => { setEdition({ id: j.id, valeur: j.nom }); setErr(""); }}>
                        Renommer
                      </button>
                    )}
                    {retirable ? (
                      <button className="bf-lien danger" onClick={() => onSupprimer(j.id)}>Retirer</button>
                    ) : (
                      <span className="bf-verrou" title={`Retrait possible le ${dateCourte(dispo)}`}>
                        Actif
                      </span>
                    )}
                  </span>
                </>
              )}
            </li>
          );
        })}
      </ul>
      <p className="bf-note">
        L'inscription est ouverte à tous. Changer un pseudo demande le code de la ligue ; l'historique et les Elo
        suivent automatiquement. Un joueur ne peut être retiré qu'après un an sans avoir joué — ses matchs sont
        alors effacés et tous les Elo recalculés.
      </p>

      <section className="bf-zone">
        <h3 className="bf-zone-titre">Zone protégée</h3>
        {!admin ? (
          <Deverrouiller
            onDeverrouiller={onDeverrouiller}
            texte="Le code de la ligue débloque le changement de pseudo, le retrait immédiat d'un joueur, la suppression d'un match et la remise à zéro du classement."
          />
        ) : (
          <>
            <p className="bf-zone-texte ouverte">
              Zone déverrouillée. Renommer et Retirer sont actifs sur tous les joueurs.
            </p>
            {confirme ? (
              <div className="bf-zone-confirm">
                <p>
                  Effacer les {matchs.length} match{matchs.length > 1 ? "s" : ""} et remettre tout le monde
                  à {START} ? Les joueurs restent inscrits, l'historique est perdu.
                </p>
                <div className="bf-ajout">
                  <button className="bf-cta petit danger" onClick={() => { onReinitialiser(); setConfirme(false); }}>
                    Oui, réinitialiser
                  </button>
                  <button className="bf-lien" onClick={() => setConfirme(false)}>Annuler</button>
                </div>
              </div>
            ) : (
              <div className="bf-ajout">
                <button className="bf-cta petit danger" onClick={() => setConfirme(true)} disabled={!matchs.length}>
                  Réinitialiser le classement
                </button>
                <button className="bf-lien" onClick={() => { verrouiller(); setConfirme(false); }}>Verrouiller</button>
              </div>
            )}
          </>
        )}
      </section>
    </>
  );
}

/* ── Application ───────────────────────────────────────────── */

export default function LigueBabyfoot() {
  const [data, setData] = useState({ joueurs: [], matchs: [] });
  const [chargement, setChargement] = useState(true);
  const [onglet, setOnglet] = useState("classement");
  const [mode, setMode] = useState("general");
  const [alerte, setAlerte] = useState("");
  const [code, setCode] = useState(null); // code de la ligue, gardé en mémoire seulement
  const [selection, setSelection] = useState(null); // joueur affiché dans l'onglet Stats
  const admin = code !== null;

  const charger = useCallback(async () => {
    try {
      setData(await api.lire());
      setAlerte("");
    } catch (e) {
      setAlerte(e.message);
    } finally {
      setChargement(false);
    }
  }, []);

  useEffect(() => { charger(); }, [charger]);

  // Les collègues saisissent depuis leur poste : on resynchronise au retour sur l'onglet.
  useEffect(() => {
    const auRetour = () => { if (document.visibilityState === "visible") charger(); };
    document.addEventListener("visibilitychange", auRetour);
    window.addEventListener("focus", auRetour);
    return () => {
      document.removeEventListener("visibilitychange", auRetour);
      window.removeEventListener("focus", auRetour);
    };
  }, [charger]);

  const agir = async (appel) => {
    try {
      setData(await appel());
      setAlerte("");
    } catch (e) {
      setAlerte(e.message);
    }
  };

  const deverrouiller = async (essai) => {
    await api.verifier(essai); // lève une erreur si le code est refusé
    setCode(essai);
  };
  const verrouiller = () => setCode(null);

  const ajouterJoueur = (nom) => agir(() => api.ajouterJoueur(nom));
  const renommerJoueur = (id, nom) => agir(() => api.renommerJoueur(id, nom, code));
  const retirerJoueur = (id) => agir(() => api.retirerJoueur(id, code));
  const ajouterMatch = (m) => {
    agir(() => api.ajouterMatch(m));
    setOnglet("classement");
  };
  const supprimerMatch = (id) => agir(() => api.supprimerMatch(id, code));
  const modifierMatch = (id, modif) => agir(() => api.modifierMatch(id, modif, code));
  const reinitialiser = () => agir(() => api.reinitialiser(code));
  const definirCoefs = (coefs) => agir(() => api.definirCoefs(coefs, code));

  const allerAuxStats = (id) => { setSelection(id); setOnglet("stats"); };

  const ligue = useMemo(
    () => calculerLigue(data.joueurs, data.matchs, data.coefs || COEFS_DEFAUT),
    [data]
  );

  // Palmarès par catégorie (étoiles cumulées), partagé entre Classement et Saison.
  const palmaresParCat = useMemo(
    () => cumulParCategorie(data.saisons || [], ligue.index),
    [data.saisons, ligue.index]
  );

  const onglets = [
    { id: "classement", label: "Classement" },
    { id: "match", label: "Nouveau match" },
    { id: "stats", label: "Statistiques" },
    { id: "graphiques", label: "Graphiques" },
    { id: "saison", label: "Saisons" },
    { id: "historique", label: "Historique" },
    { id: "formule", label: "Formules" },
    { id: "joueurs", label: "Joueurs" },
  ];

  return (
    <div className="bf-root">
      <style>{CSS}</style>

      <header className="bf-entete">
        <div className="bf-rod" aria-hidden="true" />
        <div className="bf-haut">
          <div className="bf-titre-bloc">
            <p className="bf-eyebrow">DAAA Stadium</p>
            <h1 className="bf-titre">Onera<span>pro ligue du midi</span></h1>
          </div>
          <div className="bf-logo">
            <Logo />
            <span className="bf-marque">BabyFoot</span>
          </div>
        </div>
        <nav className="bf-nav">
          {onglets.map((o) => (
            <button
              key={o.id}
              className={"bf-onglet" + (onglet === o.id ? " on" : "")}
              onClick={() => setOnglet(o.id)}
              aria-current={onglet === o.id}
            >
              {o.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="bf-main">
        {alerte && <p className="bf-erreur">{alerte}</p>}
        {chargement ? (
          <p className="bf-vide">Chargement du classement…</p>
        ) : onglet === "classement" ? (
          <Classement ligue={ligue} mode={mode} setMode={setMode} onJoueur={allerAuxStats} palmaresParCat={palmaresParCat} saisons={data.saisons} />
        ) : onglet === "match" ? (
          <NouveauMatch ligue={ligue} joueurs={data.joueurs} onValider={ajouterMatch} />
        ) : onglet === "stats" ? (
          <Statistiques ligue={ligue} selection={selection} setSelection={setSelection} />
        ) : onglet === "graphiques" ? (
          <Graphiques ligue={ligue} selection={selection} setSelection={setSelection} />
        ) : onglet === "saison" ? (
          <Saisons ligue={ligue} saisons={data.saisons} palmaresParCat={palmaresParCat} />
        ) : onglet === "historique" ? (
          <Historique
            ligue={ligue}
            admin={admin}
            onDeverrouiller={deverrouiller}
            verrouiller={verrouiller}
            onSupprimer={supprimerMatch}
            onModifier={modifierMatch}
          />
        ) : onglet === "formule" ? (
          <Formule
            ligue={ligue}
            admin={admin}
            onDeverrouiller={deverrouiller}
            verrouiller={verrouiller}
            onDefinir={definirCoefs}
          />
        ) : (
          <Joueurs
            ligue={ligue}
            joueurs={data.joueurs}
            matchs={data.matchs}
            admin={admin}
            onDeverrouiller={deverrouiller}
            verrouiller={verrouiller}
            onAjouter={ajouterJoueur}
            onRenommer={renommerJoueur}
            onSupprimer={retirerJoueur}
            onReinitialiser={reinitialiser}
          />
        )}
      </main>

      <footer className="bf-pied">
        Les résultats sont partagés : tout le monde voit le même classement.
      </footer>
    </div>
  );
}

/* ── Feuille de style ──────────────────────────────────────── */

const CSS = `
.bf-root{
  --feutre:#0E3B2C; --feutre2:#0A2E22; --craie:#F1EEE2; --craie-faible:#9FB3A8;
  --rouge:#DC3049; --bleu:#3277E0; --chrome:#C9CFD5; --noyer:#3B2A1C;
  --pos:#7BD389; --neg:#E8734A;
  min-height:100%;
  background:
    radial-gradient(circle at 50% 0%, rgba(255,255,255,.05), transparent 60%),
    repeating-linear-gradient(90deg, rgba(255,255,255,.018) 0 44px, transparent 44px 88px),
    var(--feutre);
  color:var(--craie);
  font-family:Inter,"Segoe UI",system-ui,-apple-system,sans-serif;
  font-size:15px; line-height:1.45;
  padding-bottom:40px;
}
.bf-root *{box-sizing:border-box}
.bf-root button{font:inherit;cursor:pointer;border:none;background:none;color:inherit}
.bf-root :focus-visible{outline:2px solid var(--craie);outline-offset:2px;border-radius:2px}

/* entête */
.bf-entete{position:relative;padding:26px 22px 0;border-bottom:1px solid rgba(255,255,255,.09)}
.bf-rod{height:5px;margin:0 -22px 22px;background:linear-gradient(180deg,#F4F6F8,#9BA3AB 45%,#5E666D 55%,#C3CAD1);box-shadow:0 3px 8px rgba(0,0,0,.4)}
.bf-haut{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}
.bf-titre-bloc{min-width:0}
.bf-logo{flex:none;display:flex;flex-direction:column;align-items:center;gap:7px;padding-top:2px}
.bf-logo-svg{width:96px;height:auto;display:block}
.bf-marque{margin:0;padding:3px 10px;border-radius:4px;
  background:linear-gradient(180deg,#EDF0F3,#B7BFC6);color:#12251D;
  font-size:11px;font-weight:800;letter-spacing:.16em;text-transform:uppercase}
.bf-eyebrow{margin:0;font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--craie-faible)}
.bf-titre{
  margin:2px 0 16px;font-size:clamp(34px,8vw,58px);line-height:.9;
  font-family:"Haettenschweiler","Arial Narrow",Impact,"Oswald",sans-serif;
  font-weight:400;letter-spacing:.01em;text-transform:uppercase;
  color:var(--craie);text-shadow:0 2px 0 rgba(0,0,0,.25);
}
.bf-titre span{display:block;font-size:.46em;letter-spacing:.06em;color:var(--chrome)}
.bf-nav{display:flex;gap:2px;overflow-x:auto;scrollbar-width:none}
.bf-nav::-webkit-scrollbar{display:none}
.bf-onglet{padding:9px 15px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--craie-faible);
  border-radius:6px 6px 0 0;white-space:nowrap;border-bottom:2px solid transparent}
.bf-onglet:hover{color:var(--craie)}
.bf-onglet.on{color:var(--feutre2);background:var(--chrome);border-bottom-color:var(--chrome);font-weight:600}

.bf-main{max-width:760px;margin:0 auto;padding:24px 18px 0}
.bf-note{margin:18px 2px 0;font-size:12px;color:var(--craie-faible)}
.bf-muet{color:var(--craie-faible);font-style:normal;font-size:12px}
.bf-erreur{margin:0 0 14px;padding:10px 12px;background:rgba(220,48,73,.16);border-left:3px solid var(--rouge);font-size:13px}
.bf-vide{padding:48px 8px;text-align:center;color:var(--craie)}
.bf-vide p{margin:0 0 6px;font-size:17px}
.bf-vide-sous{color:var(--craie-faible);font-size:14px !important}

/* segments général / attaque / défense */
.bf-segments{display:flex;gap:3px;padding:3px;margin-bottom:18px;background:rgba(0,0,0,.28);border-radius:999px}
.bf-seg{flex:1;padding:9px 4px;font-size:13px;letter-spacing:.05em;text-transform:uppercase;color:var(--craie-faible);border-radius:999px}
.bf-seg.on{background:linear-gradient(180deg,#EDF0F3,#B7BFC6);color:#12251D;font-weight:700;box-shadow:0 1px 3px rgba(0,0,0,.4)}

/* tableau */
.bf-table{border-top:1px solid rgba(255,255,255,.16)}
.bf-tr{display:grid;grid-template-columns:32px 1fr 56px 56px 56px;align-items:center;gap:4px;
  padding:10px 4px;border-bottom:1px solid rgba(255,255,255,.09)}
.bf-thead{padding:8px 4px;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--craie-faible);border-bottom-color:rgba(255,255,255,.16)}
.bf-thead .bf-c-elo{font-size:10px;font-weight:400;font-family:inherit;letter-spacing:.16em}
.bf-thead .bf-c-elo.actif{color:var(--craie);font-weight:700}
.bf-c-nom{display:grid;gap:2px;min-width:0}
.bf-nom-ligne{display:flex;align-items:center;gap:6px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bf-sous{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--craie-faible);font-family:ui-monospace,Menlo,monospace}
.bf-sous em{font-style:normal;opacity:.55;margin-left:1px}
.bf-sous b{font-weight:600}
.bf-forme{display:flex;gap:3px;align-items:center;margin-left:2px}
.bf-c-elo{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:14px;text-align:right;
  color:var(--craie-faible);padding-right:2px}
.bf-c-elo.actif{color:var(--craie);font-size:19px;font-weight:700;
  background:linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.02));border-radius:5px;padding:3px 4px 3px 0}
.pos{color:var(--pos)}
.neg{color:var(--neg)}
.bf-tag{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:10px;font-weight:700;letter-spacing:.06em;flex:none}
.bf-tag.h1{color:#F0C752}
.bf-tag.h2{color:#D6DCE2}
.bf-tag.h3{color:#D69A5F}
.bf-tag.bas{color:#A8B6AE;font-size:9px;letter-spacing:.02em}
.bf-pastille{width:8px;height:8px;border-radius:50%;display:block}
.bf-pastille.v{background:var(--pos)}
.bf-pastille.d{background:rgba(255,255,255,.22)}
.bf-rang{display:grid;place-items:center;width:24px;height:24px;border-radius:50%;font-size:12px;font-weight:700;font-style:normal;
  background:rgba(255,255,255,.1);color:var(--craie)}
.bf-rang.r1{background:#E8C15C;color:#2A1F06}
.bf-rang.r2{background:#CBD2D8;color:#22282C}
.bf-rang.r3{background:#C08552;color:#231206}

/* terrain / saisie de match */
.bf-terrain{position:relative}
.bf-camps{display:grid;grid-template-columns:1fr 1fr;gap:14px;position:relative}
.bf-camps::before{content:"";position:absolute;left:50%;top:-6px;bottom:-6px;width:1px;background:repeating-linear-gradient(180deg,rgba(255,255,255,.3) 0 6px,transparent 6px 12px)}
.bf-camp{padding:16px 14px;border-radius:10px;background:rgba(0,0,0,.22);border-top:3px solid}
.bf-camp.rouge{border-color:var(--rouge)}
.bf-camp.bleu{border-color:var(--bleu)}
.bf-camp-titre{margin:0 0 14px;font-size:13px;letter-spacing:.18em;text-transform:uppercase;font-weight:700}
.bf-camp.rouge .bf-camp-titre{color:var(--rouge)}
.bf-camp.bleu .bf-camp-titre{color:var(--bleu)}
.bf-poste{display:block;margin-bottom:12px}
.bf-poste-lib{display:flex;align-items:center;gap:7px;margin-bottom:5px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--craie-faible)}
.bf-barre{width:40px;height:15px;flex:none}
.bf-select,.bf-input{width:100%;padding:9px 10px;border-radius:6px;background:rgba(255,255,255,.94);color:#12251D;
  border:1px solid rgba(0,0,0,.2);font-size:14px;font-weight:500}
.bf-boulier-bloc{margin-top:18px;text-align:center}
.bf-score{font-family:"Haettenschweiler","Arial Narrow",Impact,sans-serif;font-size:52px;line-height:1;font-weight:400}
.bf-boulier{position:relative;display:flex;align-items:center;gap:4px;margin-top:8px;padding:7px 4px}
.bf-perles{display:flex;align-items:center;gap:2px;min-width:0}
.bf-perles.neg{flex:5}
.bf-perles.pos{flex:10}
.bf-cran{position:relative;z-index:1;flex:none;width:3px;height:19px;border-radius:1px;
  background:linear-gradient(180deg,#F4F6F8,#7E868D);box-shadow:0 0 0 1px rgba(0,0,0,.35)}
.bf-tige{position:absolute;left:4px;right:4px;top:50%;height:3px;transform:translateY(-50%);border-radius:2px;
  background:linear-gradient(180deg,#EEF1F4,#8C949B)}
.bf-perle{position:relative;width:100%;aspect-ratio:1;max-width:15px;min-width:9px;border-radius:50%;
  background:radial-gradient(circle at 32% 28%,rgba(255,255,255,.5),rgba(0,0,0,.55) 78%),#26483A;
  box-shadow:0 1px 2px rgba(0,0,0,.5);transition:background .12s,transform .12s}
.bf-perle.on{background:radial-gradient(circle at 32% 28%,rgba(255,255,255,.65),rgba(0,0,0,.35) 82%),var(--perle);transform:translateY(-1px)}
.bf-perle.neg.on{background:radial-gradient(circle at 32% 28%,rgba(255,255,255,.28),rgba(0,0,0,.6) 80%),#1C1A17;
  box-shadow:inset 0 0 0 1.6px var(--perle),0 1px 2px rgba(0,0,0,.5)}
.bf-legende{margin:16px 0 0;font-size:12px;color:var(--craie-faible);text-align:center}

.bf-apercu{margin-top:20px;padding:14px 16px;border-radius:10px;background:rgba(0,0,0,.26)}
.bf-apercu-cote{font-size:13px;margin-bottom:10px;color:var(--craie)}
.bf-apercu-liste{margin:0;padding:0;list-style:none;font-size:13px;display:grid;gap:5px}
.bf-apercu-liste li{display:flex;gap:6px;align-items:baseline;color:var(--craie-faible)}
.bf-apercu-liste span{min-width:92px;color:var(--craie);font-weight:600}
.bf-apercu-liste b{font-family:ui-monospace,Menlo,monospace}
.bf-apercu-liste em{margin-left:6px;font-family:ui-monospace,Menlo,monospace}

.bf-cta{display:block;width:100%;margin-top:22px;padding:15px;border-radius:8px;
  background:linear-gradient(180deg,#F2F4F6,#B9C1C8);color:#12251D;
  font-size:15px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;
  box-shadow:0 3px 0 rgba(0,0,0,.35)}
.bf-cta:hover{background:linear-gradient(180deg,#FFF,#C8D0D7)}
.bf-cta:active{transform:translateY(2px);box-shadow:0 1px 0 rgba(0,0,0,.35)}
.bf-cta.petit{width:auto;margin:0;padding:10px 18px;font-size:13px}
.bf-cta.danger{background:linear-gradient(180deg,#F0866A,#D14C2C);color:#22100A}
.bf-cta.danger:hover{background:linear-gradient(180deg,#FF9C80,#E05835)}
.bf-cta:disabled{opacity:.4;cursor:not-allowed;transform:none}

.bf-zone{margin-top:26px;padding:16px;border:1px dashed rgba(255,255,255,.22);border-radius:10px;background:rgba(0,0,0,.18)}
.bf-zone-titre{margin:0 0 6px;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--craie-faible);font-weight:700}
.bf-zone-texte{margin:0 0 12px;font-size:13px;color:var(--craie-faible)}
.bf-zone-texte.ouverte{color:var(--craie)}
.bf-zone-confirm p{margin:0 0 12px;font-size:13px}

/* historique */
.bf-histo{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.bf-match{position:relative;padding:12px 14px;border-radius:10px;background:rgba(0,0,0,.2)}
.bf-match-date{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--craie-faible);margin-bottom:8px}
.bf-match-corps{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:10px}
.bf-match-eq{display:grid;gap:2px;font-size:13px;opacity:.62}
.bf-match-eq.gagnant{opacity:1;font-weight:600}
.bf-match-eq.bleu{text-align:right}
.bf-match-eq i{font-style:normal;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--craie-faible)}
.bf-match-moy{margin-top:3px;font-family:ui-monospace,Menlo,monospace;font-size:11px;font-weight:400;
  color:var(--craie-faible);letter-spacing:.02em}
.bf-match-eq.rouge.gagnant{color:#FF8397}
.bf-match-eq.bleu.gagnant{color:#8FB6F5}
.bf-match-score{text-align:center;font-family:ui-monospace,Menlo,monospace}
.bf-match-score b{font-size:22px}
.bf-match-score span{margin:0 5px;opacity:.4}
.bf-match-score em{display:block;font-style:normal;font-size:11px;color:var(--craie-faible)}
.bf-suppr{position:absolute;top:10px;right:12px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--craie-faible)}
.bf-suppr:hover{color:var(--neg)}

/* joueurs */
.bf-ajout{display:flex;gap:8px;margin-bottom:16px}
.bf-ajout .bf-input{flex:1}
.bf-joueurs{list-style:none;margin:0;padding:0}
.bf-joueurs li{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 2px;border-bottom:1px solid rgba(255,255,255,.09)}
.bf-j-nom{flex:1;min-width:110px;font-weight:600}
.bf-j-elos{display:flex;gap:10px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--craie-faible)}
.bf-j-elos b{font-family:ui-monospace,Menlo,monospace;font-size:14px;color:var(--craie);margin-right:3px;letter-spacing:0}
.bf-j-actions{display:flex;align-items:center;gap:12px;margin-left:auto}
.bf-j-edition{display:flex;align-items:center;gap:8px;width:100%}
.bf-j-edition .bf-input{flex:1;min-width:120px}
.bf-lien{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--craie-faible);text-decoration:underline;text-underline-offset:3px}
.bf-lien:hover{color:var(--craie)}
.bf-lien.danger:hover{color:var(--neg)}
.bf-verrou{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--craie-faible);
  padding:3px 8px;border:1px solid rgba(255,255,255,.18);border-radius:999px;cursor:help}

.bf-pied{max-width:760px;margin:30px auto 0;padding:16px 18px 0;border-top:1px solid rgba(255,255,255,.09);
  font-size:12px;color:var(--craie-faible);text-align:center}

/* lignes de classement cliquables */
.bf-tr-clic{cursor:pointer;border-radius:6px;transition:background .12s}
.bf-tr-clic:hover{background:rgba(255,255,255,.05)}

/* historique : actions admin + édition en ligne */
.bf-match-admin{position:absolute;top:10px;right:12px;display:flex;gap:12px}
.bf-match-edit{display:block}
.bf-edit-camps{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.bf-edit-camp{padding:12px;border-radius:8px;background:rgba(0,0,0,.22);border-top:3px solid}
.bf-edit-camp.rouge{border-color:var(--rouge)}
.bf-edit-camp.bleu{border-color:var(--bleu)}
.bf-edit-camp h4{margin:0 0 10px;font-size:11px;letter-spacing:.16em;text-transform:uppercase}
.bf-edit-camp.rouge h4{color:var(--rouge)}
.bf-edit-camp.bleu h4{color:var(--bleu)}
.bf-poste-mini{display:block;margin-bottom:8px;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--craie-faible)}
.bf-poste-mini .bf-select{margin-top:4px}
.bf-edit-actions{display:flex;align-items:center;gap:14px;margin-top:14px}

/* onglet statistiques */
.bf-stat-choix{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px}
.bf-chip{display:inline-flex;align-items:center;gap:7px;padding:7px 12px;border-radius:999px;
  background:rgba(0,0,0,.22);font-size:13px;color:var(--craie);border:1px solid transparent;transition:background .12s}
.bf-chip:hover{background:rgba(255,255,255,.08)}
.bf-chip b{font-family:ui-monospace,Menlo,monospace;font-size:11px;font-weight:600;color:var(--craie-faible)}
.bf-chip.on{border-color:#E8C15C;background:rgba(232,193,92,.12)}
.bf-chip.on b{color:#E8C15C}
.bf-stat-tete{margin:4px 0 20px;padding-bottom:16px;border-bottom:2px solid rgba(255,255,255,.14)}
.bf-stat-nom{margin:0 0 8px;font-size:clamp(26px,6vw,38px);line-height:1;
  font-family:"Haettenschweiler","Arial Narrow",Impact,sans-serif;font-weight:400;text-transform:uppercase}
.bf-stat-kpis{display:flex;flex-wrap:wrap;gap:18px;align-items:baseline}
.bf-stat-kpis span{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--craie-faible)}
.bf-stat-kpis b{font-family:ui-monospace,Menlo,monospace;font-size:24px;font-weight:700;color:var(--craie);margin-right:5px;letter-spacing:0}
.bf-stat-kpis em{font-style:normal;margin-left:-3px}
.bf-stat-elo{margin-left:auto}
.bf-stat-grille{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.bf-stat-col{padding:16px;border-radius:10px;background:rgba(0,0,0,.18)}
.bf-stat-col-titre{margin:0 0 4px;font-size:15px;font-weight:700}
.bf-stat-leg{display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin:0 0 14px;font-size:11px;color:var(--craie-faible)}
.bf-sw{display:inline-block;width:11px;height:11px;border-radius:2px;margin-right:2px}
.bf-sw.clair{background:rgba(123,211,137,.28)}
.bf-sw.fonce{background:var(--pos)}
.bf-sw.fonce{margin-left:8px}
.bf-duels{list-style:none;margin:0;padding:0;display:grid;gap:9px}
.bf-duels li{display:grid;grid-template-columns:72px 1fr auto;align-items:center;gap:8px}
.bf-duel-nom{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bf-duel-barre{display:block}
.bf-duel-fond{display:block;height:14px;border-radius:3px;background:rgba(123,211,137,.24);min-width:3px}
.bf-duel-plein{display:block;height:100%;border-radius:3px;background:var(--pos)}
.bf-duel-chiffre{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--craie);white-space:nowrap}
.bf-duel-chiffre em{font-style:normal;color:var(--craie-faible)}
.bf-duel-vide{padding:8px 0}

/* onglet graphiques */
.bf-graph-consigne{margin:4px 0 8px;font-size:13px;color:var(--craie-faible)}
.bf-puce{display:inline-block;width:9px;height:9px;border-radius:50%;flex:none}
.bf-graph-titre{margin:22px 0 10px;font-size:15px;font-weight:700}
.bf-graph-wrap{overflow-x:auto;border-radius:10px;background:rgba(0,0,0,.2);padding:12px}
.bf-graph-svg{display:block;width:100%;min-width:420px;height:auto}
.bf-grid{stroke:rgba(255,255,255,.1);stroke-width:1}
.bf-axe{fill:var(--craie-faible);font-size:11px;font-family:ui-monospace,Menlo,monospace}
.bf-graph-vide{padding:30px 0;text-align:center}
.bf-vd{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.bf-vd li{display:grid;grid-template-columns:84px 1fr auto;align-items:center;gap:10px}
.bf-vd-nom{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bf-vd-barre{display:block;height:16px;border-radius:4px;background:rgba(232,115,74,.28);min-width:4px;overflow:hidden}
.bf-vd-v{display:block;height:100%;background:var(--pos)}
.bf-vd-chiffre{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--craie);white-space:nowrap}
.bf-vd-chiffre em{font-style:normal;color:var(--craie-faible)}
.bf-vd-chiffre i{font-style:normal;color:var(--craie-faible);margin-left:1px}

/* onglet formule */
.bf-formule{max-width:620px}
.bf-f-titre{margin:0 0 18px;font-size:clamp(22px,5vw,30px);line-height:1.05;
  font-family:"Haettenschweiler","Arial Narrow",Impact,sans-serif;font-weight:400;text-transform:uppercase}
.bf-f-bloc{margin-bottom:20px;padding-bottom:18px;border-bottom:1px solid rgba(255,255,255,.08)}
.bf-f-bloc h3{margin:0 0 8px;font-size:14px;letter-spacing:.04em;color:var(--craie)}
.bf-f-bloc p{margin:0 0 8px;font-size:14px;color:var(--craie);line-height:1.5}
.bf-f-bloc em{font-style:italic;color:var(--craie)}
.bf-f-math{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:13px;color:#CFE8D6 !important;
  background:rgba(0,0,0,.26);padding:10px 12px;border-radius:6px;overflow-x:auto;white-space:nowrap}
.bf-f-val{font-family:ui-monospace,Menlo,monospace;color:#E8C15C;font-weight:700}
.bf-f-paliers{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.bf-f-palier{font-size:12px;padding:4px 9px;border-radius:999px;background:rgba(0,0,0,.26);color:var(--craie-faible)}
.bf-f-palier b{color:var(--craie);font-family:ui-monospace,Menlo,monospace;margin-right:3px}
.bf-reglage-avert{margin:0 0 14px;padding:10px 12px;font-size:13px;background:rgba(232,115,74,.14);
  border-left:3px solid var(--neg);border-radius:0 6px 6px 0;color:var(--craie)}
.bf-reglage-grille{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px}
.bf-reglage-grille label,.bf-reglage-palier{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--craie-faible)}
.bf-reglage-grille label{display:grid;gap:5px}
.bf-reglage-grille .bf-input{text-transform:none;letter-spacing:0}
.bf-reglage-sous{margin:0 0 10px;font-size:12px;color:var(--craie-faible)}
.bf-reglage-paliers{display:grid;gap:8px;margin-bottom:16px}
.bf-reglage-palier{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.bf-reglage-palier .bf-input{width:72px}
.bf-avance{margin:4px 0 16px;padding:12px;border-radius:8px;background:rgba(0,0,0,.2)}
.bf-avance summary{cursor:pointer;font-size:13px;font-weight:600;color:var(--craie);letter-spacing:.02em}
.bf-avance[open] summary{margin-bottom:12px}
.bf-formchamp{margin-top:14px}
.bf-formchamp-tete{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:5px}
.bf-formchamp-tete label{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--craie-faible)}
.bf-mono{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:13px}
.bf-mono.invalide{border-color:var(--neg);box-shadow:0 0 0 1px var(--neg)}
.bf-formchamp-aide{margin:5px 0 4px;font-size:11px;color:var(--craie-faible)}
.bf-formchamp-aide b{color:var(--craie);font-family:ui-monospace,Menlo,monospace}
.bf-formchamp-ok{margin:0;font-size:12px;color:var(--pos)}
.bf-formchamp-ok code{font-family:ui-monospace,Menlo,monospace;color:var(--craie-faible)}
.bf-formchamp-err{margin:0;font-size:12px;color:var(--neg)}
.bf-f-custom{display:inline-block;font-size:11px;color:#E8C15C;font-style:normal;margin-top:2px}

/* onglet saison */
.bf-saison-bloc{margin-bottom:26px}
.bf-saison-titre{display:flex;align-items:center;gap:10px;margin:0 0 12px;font-size:clamp(18px,4vw,24px);
  font-family:"Haettenschweiler","Arial Narrow",Impact,sans-serif;font-weight:400;text-transform:uppercase;letter-spacing:.01em}
.bf-saison-encours{font-family:Inter,system-ui,sans-serif;font-size:10px;font-weight:700;letter-spacing:.1em;
  text-transform:uppercase;padding:3px 8px;border-radius:999px;background:rgba(123,211,137,.18);color:var(--pos)}
.bf-saison-close{font-family:Inter,system-ui,sans-serif;font-size:10px;font-weight:700;letter-spacing:.1em;
  text-transform:uppercase;padding:3px 8px;border-radius:999px;background:rgba(255,255,255,.1);color:var(--craie-faible)}
.bf-table-saison{border-top:1px solid rgba(255,255,255,.16)}
.bf-saison-vide{padding:16px 0}
.bf-saison-tenants{margin:-6px 0 12px;font-size:12px;color:var(--craie-faible)}
/* étoiles (awards) */
.bf-etoile{width:14px;height:14px;flex:none}
.bf-etoile.or{color:#F0C752}
.bf-etoile.argent{color:#CBD2D8}
.bf-etoile.bronze{color:#C8894E}
.bf-palmes{display:inline-flex;align-items:center;gap:5px;margin-left:3px}
.bf-palme{display:inline-flex;align-items:center;gap:1px}
.bf-palme em{font-style:normal;font-size:10px;font-weight:700;font-family:ui-monospace,Menlo,monospace}
.bf-palme.or em{color:#F0C752}
.bf-palme.argent em{color:#CBD2D8}
.bf-palme.bronze em{color:#C8894E}
/* coupe de tenant */
.bf-coupe{display:inline-flex;align-items:center;gap:1px;margin-left:2px}
.bf-coupe svg{width:15px;height:15px}
.bf-coupe b{font-size:10px;font-weight:800;font-family:ui-monospace,Menlo,monospace}
.bf-coupe.or{color:#F0C752}
.bf-coupe.argent{color:#CBD2D8}
.bf-coupe.bronze{color:#C8894E}
/* tableau palmarès */
.bf-palm-titre{margin-top:4px}
.bf-palm-sous{font-family:Inter,system-ui,sans-serif;font-size:11px;font-weight:600;letter-spacing:.1em;
  text-transform:uppercase;color:var(--craie-faible)}
.bf-palm-tr{grid-template-columns:32px 1fr 44px 44px 44px}
.bf-palm-c{display:flex;align-items:center;justify-content:center;font-family:ui-monospace,Menlo,monospace;
  font-size:14px;font-weight:700}
.bf-palm-c.or{color:#F0C752}
.bf-palm-c.argent{color:#CBD2D8}
.bf-palm-c.bronze{color:#C8894E}
.bf-palm-tr .bf-palm-c svg{width:15px;height:15px}

@media (max-width:560px){
  .bf-logo-svg{width:74px}
  .bf-marque{font-size:10px;letter-spacing:.12em;padding:2px 8px}
  .bf-tr{grid-template-columns:28px 1fr 46px 46px 46px;gap:2px}
  .bf-c-elo{font-size:13px}
  .bf-c-elo.actif{font-size:17px}
  .bf-forme{display:none}
  .bf-camps{grid-template-columns:1fr;gap:12px}
  .bf-camps::before{display:none}
  .bf-j-elos b{font-size:13px}
  .bf-stat-grille{grid-template-columns:1fr;gap:12px}
  .bf-edit-camps{grid-template-columns:1fr;gap:12px}
  .bf-stat-elo{margin-left:0}
  .bf-reglage-grille{grid-template-columns:1fr}
}
@media (prefers-reduced-motion:reduce){
  .bf-root *{transition:none !important}
}
`;
