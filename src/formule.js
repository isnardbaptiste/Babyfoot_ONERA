/* Évaluateur d'expressions mathématiques sûr, sans eval().
   Il ne connaît que les nombres, + - * / ^, les parenthèses, une courte liste
   de fonctions mathématiques et les variables qu'on lui fournit explicitement.
   Rien d'autre n'est accessible : ni le navigateur, ni le réseau, ni les données.

   compilerFormule(expr, variablesAutorisees) renvoie :
     { fn }      si l'expression est valide — fn(vars) calcule la valeur
     { erreur }  sinon, avec un message en français. */

const FONCTIONS = {
  abs: Math.abs, min: Math.min, max: Math.max, log: Math.log, log10: Math.log10,
  sqrt: Math.sqrt, exp: Math.exp, pow: Math.pow, sign: Math.sign, round: Math.round,
  floor: Math.floor, ceil: Math.ceil,
};
const CONSTANTES = { pi: Math.PI, e: Math.E };

// ── Analyse lexicale ──────────────────────────────────────────
function tokeniser(src) {
  const toks = [];
  let i = 0;
  const estLettre = (c) => /[a-zA-Z_]/.test(c);
  const estChiffre = (c) => /[0-9.]/.test(c);
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n") { i++; continue; }
    if (estChiffre(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const nb = src.slice(i, j);
      if ((nb.match(/\./g) || []).length > 1) throw new Error(`Nombre mal formé : « ${nb} »`);
      toks.push({ t: "nb", v: parseFloat(nb) });
      i = j; continue;
    }
    if (estLettre(c)) {
      let j = i;
      while (j < src.length && /[a-zA-Z0-9_]/.test(src[j])) j++;
      toks.push({ t: "id", v: src.slice(i, j) });
      i = j; continue;
    }
    if ("+-*/^(),".includes(c)) { toks.push({ t: c }); i++; continue; }
    throw new Error(`Caractère non autorisé : « ${c} »`);
  }
  return toks;
}

// ── Analyse syntaxique → arbre (descente récursive) ───────────
// Grammaire : expr = terme (('+'|'-') terme)* ; terme = fact (('*'|'/') fact)* ;
// fact = unaire ('^' fact)? ; unaire = ('-')? primaire ;
// primaire = nombre | id | id '(' args ')' | '(' expr ')'
function analyser(toks) {
  let pos = 0;
  const pic = () => toks[pos];
  const avance = () => toks[pos++];
  const attendre = (t) => {
    if (!pic() || pic().t !== t) throw new Error(`« ${t} » attendu`);
    return avance();
  };

  function expr() {
    let g = terme();
    while (pic() && (pic().t === "+" || pic().t === "-")) {
      const op = avance().t;
      g = { type: "bin", op, g, d: terme() };
    }
    return g;
  }
  function terme() {
    let g = fact();
    while (pic() && (pic().t === "*" || pic().t === "/")) {
      const op = avance().t;
      g = { type: "bin", op, g, d: fact() };
    }
    return g;
  }
  function fact() {
    const base = unaire();
    if (pic() && pic().t === "^") { avance(); return { type: "bin", op: "^", g: base, d: fact() }; }
    return base;
  }
  function unaire() {
    if (pic() && pic().t === "-") { avance(); return { type: "neg", e: unaire() }; }
    if (pic() && pic().t === "+") { avance(); return unaire(); }
    return primaire();
  }
  function primaire() {
    const tk = pic();
    if (!tk) throw new Error("Expression incomplète.");
    if (tk.t === "nb") { avance(); return { type: "nb", v: tk.v }; }
    if (tk.t === "(") { avance(); const e = expr(); attendre(")"); return e; }
    if (tk.t === "id") {
      avance();
      if (pic() && pic().t === "(") {
        avance();
        const args = [];
        if (pic() && pic().t !== ")") {
          args.push(expr());
          while (pic() && pic().t === ",") { avance(); args.push(expr()); }
        }
        attendre(")");
        return { type: "appel", nom: tk.v, args };
      }
      return { type: "var", nom: tk.v };
    }
    throw new Error("Expression invalide.");
  }

  const arbre = expr();
  if (pos < toks.length) throw new Error("Expression mal formée (texte en trop).");
  return arbre;
}

// ── Vérifie que noms de variables et fonctions sont autorisés ──
function verifierNoms(noeud, variables) {
  switch (noeud.type) {
    case "nb": return;
    case "neg": return verifierNoms(noeud.e, variables);
    case "bin": verifierNoms(noeud.g, variables); verifierNoms(noeud.d, variables); return;
    case "var":
      if (!(noeud.nom in CONSTANTES) && !variables.includes(noeud.nom))
        throw new Error(`Variable inconnue : « ${noeud.nom} »`);
      return;
    case "appel":
      if (!(noeud.nom in FONCTIONS)) throw new Error(`Fonction inconnue : « ${noeud.nom} »`);
      noeud.args.forEach((a) => verifierNoms(a, variables));
      return;
    default: throw new Error("Nœud inconnu.");
  }
}

// ── Évaluation de l'arbre ─────────────────────────────────────
function evaluer(noeud, vars) {
  switch (noeud.type) {
    case "nb": return noeud.v;
    case "neg": return -evaluer(noeud.e, vars);
    case "var":
      if (noeud.nom in CONSTANTES) return CONSTANTES[noeud.nom];
      return vars[noeud.nom];
    case "appel":
      return FONCTIONS[noeud.nom](...noeud.args.map((a) => evaluer(a, vars)));
    case "bin": {
      const g = evaluer(noeud.g, vars), d = evaluer(noeud.d, vars);
      switch (noeud.op) {
        case "+": return g + d;
        case "-": return g - d;
        case "*": return g * d;
        case "/": return g / d;
        case "^": return Math.pow(g, d);
      }
    }
  }
  throw new Error("Évaluation impossible.");
}

export function compilerFormule(expr, variablesAutorisees) {
  if (typeof expr !== "string" || !expr.trim()) return { erreur: "Formule vide." };
  let arbre;
  try {
    arbre = analyser(tokeniser(expr));
    verifierNoms(arbre, variablesAutorisees);
  } catch (e) {
    return { erreur: e.message };
  }
  return {
    fn: (vars) => {
      const r = evaluer(arbre, vars);
      if (typeof r !== "number" || !isFinite(r)) throw new Error("Résultat non fini.");
      return r;
    },
  };
}
