import React, { useState, useEffect, useMemo, useCallback } from "react";
import { api } from "./api";

/* ────────────────────────────────────────────────────────────
   LIGUE DU MIDI — classement Elo de baby-foot 2v2
   Elo séparé pour l'attaque, la défense et le général.
   Toutes les notes sont recalculées depuis l'historique complet,
   ce qui rend la suppression d'un match ou d'un joueur exacte.
   ──────────────────────────────────────────────────────────── */

const START = 1500;
const K = 24;
const PLANCHER = 4; // variation minimale, quel que soit l'écart de niveau
const PART_ROLE = 0.75; // part de la variation sur le poste tenu, le reste sur l'autre
const MIN_SCORE = -5;
const MAX_SCORE = 10;
const PERLES_NEG = Array.from({ length: -MIN_SCORE }, (_, i) => MIN_SCORE + i); // -5 … -1
const PERLES_POS = Array.from({ length: MAX_SCORE }, (_, i) => i + 1); // 1 … 10
const AN_MS = 365 * 24 * 60 * 60 * 1000;
const MODES = [
  { id: "general", label: "Général" },
  { id: "attaque", label: "Attaque" },
  { id: "defense", label: "Défense" },
];

/* ── Maths Elo ─────────────────────────────────────────────── */

// Multiplicateur par palier d'écart de buts.
// 1 à 3 → ×1 · 4 à 5 → ×2 · 6 → ×3 · 7 → ×4 · 8 et plus → ×5
function facteurEcart(ecart) {
  const e = Math.abs(ecart);
  if (e >= 8) return 5;
  if (e === 7) return 4;
  if (e === 6) return 3;
  if (e >= 4) return 2;
  return 1;
}

function esperance(noteEquipe, noteAdverse) {
  return 1 / (1 + Math.pow(10, (noteAdverse - noteEquipe) / 400));
}

function deltasMatch(etat, m) {
  const aAtk = etat[m.a.atk], aDef = etat[m.a.def];
  const bAtk = etat[m.b.atk], bDef = etat[m.b.def];

  // Force d'une équipe = moyenne de l'attaquant en attaque et du défenseur en défense
  const noteA = (aAtk.attaque + aDef.defense) / 2;
  const noteB = (bAtk.attaque + bDef.defense) / 2;

  const ecart = Math.abs(m.sa - m.sb);
  const mult = facteurEcart(ecart);
  const resA = m.sa > m.sb ? 1 : m.sa < m.sb ? 0 : 0.5;
  const brut = K * mult * (resA - esperance(noteA, noteB));
  // Le vainqueur gagne au moins 4 points, le perdant en laisse autant.
  const spec = brut >= 0 ? Math.max(brut, PLANCHER) : Math.min(brut, -PLANCHER);

  return {
    spec,
    noteA,
    noteB,
    mult,
    proba: esperance(noteA, noteB),
  };
}

function ligneVide(id, nom) {
  const role = () => ({ j: 0, v: 0, d: 0, bp: 0, bc: 0, forme: [], dernier: 0 });
  return {
    id, nom,
    general: START, attaque: START, defense: START,
    stats: { general: role(), attaque: role(), defense: role() },
  };
}

function calculerLigue(joueurs, matchs) {
  const etat = {};
  joueurs.forEach((j) => { etat[j.id] = ligneVide(j.id, j.nom); });

  const ordonnes = [...matchs].sort((x, y) => x.date.localeCompare(y.date));
  const enrichis = [];

  for (const m of ordonnes) {
    const ids = [m.a.atk, m.a.def, m.b.atk, m.b.def];
    if (ids.some((id) => !etat[id])) continue; // joueur supprimé : match ignoré
    const d = deltasMatch(etat, m);

    const membres = [
      { id: m.a.atk, role: "attaque", eq: "a" },
      { id: m.a.def, role: "defense", eq: "a" },
      { id: m.b.atk, role: "attaque", eq: "b" },
      { id: m.b.def, role: "defense", eq: "b" },
    ];

    for (const mb of membres) {
      const p = etat[mb.id];
      const signe = mb.eq === "a" ? 1 : -1;
      const dSpec = d.spec * signe;

      // Le poste tenu prend 3/4 de la variation, l'autre poste le quart restant.
      const dAtt = dSpec * (mb.role === "attaque" ? PART_ROLE : 1 - PART_ROLE);
      const dDef = dSpec * (mb.role === "defense" ? PART_ROLE : 1 - PART_ROLE);
      p.attaque += dAtt;
      p.defense += dDef;
      // Le général suit mécaniquement : moyenne de l'attaque et de la défense.
      p.general = (p.attaque + p.defense) / 2;

      p.stats.attaque.dernier = dAtt;
      p.stats.defense.dernier = dDef;
      p.stats.general.dernier = dSpec / 2;

      const bp = mb.eq === "a" ? m.sa : m.sb;
      const bc = mb.eq === "a" ? m.sb : m.sa;
      const gagne = bp > bc;
      // Les compteurs de matchs ne bougent que pour le poste réellement tenu.
      for (const cle of [mb.role, "general"]) {
        const s = p.stats[cle];
        s.j += 1;
        s[gagne ? "v" : "d"] += 1;
        s.bp += bp; s.bc += bc;
        s.forme.push(gagne ? "V" : "D");
      }
    }

    enrichis.push({ ...m, delta: d.spec, mult: d.mult, moyA: d.noteA, moyB: d.noteB });
  }

  const classement = Object.values(etat);
  return { classement, index: etat, matchs: enrichis.reverse() };
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

const signe = (n) => (n > 0 ? "+" : n < 0 ? "−" : "±") + Math.abs(Math.round(n));
const affScore = (n) => (n < 0 ? "−" + Math.abs(n) : String(n));

/* ── Vues ──────────────────────────────────────────────────── */

function Classement({ ligue, mode, setMode }) {
  const lignes = useMemo(
    () => [...ligue.classement].sort((a, b) => b[mode] - a[mode]),
    [ligue, mode]
  );

  if (!lignes.length) {
    return (
      <div className="bf-vide">
        <p>Le classement est vide.</p>
        <p className="bf-vide-sous">Ajoutez vos collègues dans l'onglet Joueurs pour démarrer la saison.</p>
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
            <div className="bf-tr" role="row" key={p.id}>
              <span className="bf-c-rang"><i className={"bf-rang r" + (i < 3 ? i + 1 : 0)}>{i + 1}</i></span>
              <span className="bf-c-nom">
                <span className="bf-nom-ligne">
                  {p.nom}
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
        Départ à {START} · général = moyenne attaque/défense · K={K} · variation minimale de {PLANCHER} points.
        <br />
        Le poste tenu prend 3/4 de la variation, l'autre poste 1/4. Multiplicateur d'écart de buts :
        ×1 de 1 à 3 · ×2 de 4 à 5 · ×3 à 6 · ×4 à 7 · ×5 à partir de 8.
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
    return deltasMatch(ligue.index, m);
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
              const dAtt = d * (l.role === "attaque" ? PART_ROLE : 1 - PART_ROLE);
              const dDef = d * (l.role === "defense" ? PART_ROLE : 1 - PART_ROLE);
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

function Historique({ ligue, admin, onDeverrouiller, verrouiller, onSupprimer }) {
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

  return (
    <>
      <ul className="bf-histo">
        {ligue.matchs.map((m) => {
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
                <button className="bf-suppr" onClick={() => onSupprimer(m.id)} aria-label="Supprimer ce match">
                  Supprimer
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {admin ? (
        <p className="bf-note">
          Zone déverrouillée : chaque match peut être supprimé, les Elo se recalculent aussitôt.{" "}
          <button className="bf-lien" onClick={verrouiller}>Verrouiller</button>
        </p>
      ) : (
        <section className="bf-zone">
          <h3 className="bf-zone-titre">Zone protégée</h3>
          <Deverrouiller
            onDeverrouiller={onDeverrouiller}
            texte="Supprimer le score d'un match demande le code de la ligue."
          />
        </section>
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
  const reinitialiser = () => agir(() => api.reinitialiser(code));

  const ligue = useMemo(() => calculerLigue(data.joueurs, data.matchs), [data]);

  const onglets = [
    { id: "classement", label: "Classement" },
    { id: "match", label: "Nouveau match" },
    { id: "historique", label: "Historique" },
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
          <Classement ligue={ligue} mode={mode} setMode={setMode} />
        ) : onglet === "match" ? (
          <NouveauMatch ligue={ligue} joueurs={data.joueurs} onValider={ajouterMatch} />
        ) : onglet === "historique" ? (
          <Historique
            ligue={ligue}
            admin={admin}
            onDeverrouiller={deverrouiller}
            verrouiller={verrouiller}
            onSupprimer={supprimerMatch}
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
}
@media (prefers-reduced-motion:reduce){
  .bf-root *{transition:none !important}
}
`;
