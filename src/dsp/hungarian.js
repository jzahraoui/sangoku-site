/**
 * hungarian.js — [MOTEUR] module.
 *
 * Assignation optimale (algorithme hongrois / Kuhn-Munkres), minimisant le cout
 * total. Remplace `scipy.optimize.linear_sum_assignment`. Complexite O(n²·m) ;
 * les matrices en jeu sont petites (≤ 13×13 : enregistrements × positions).
 *
 * Implementation des potentiels + chemins augmentants (variante e-maxx),
 * exigeant n ≤ m ; le cas n > m est traite par transposition.
 */

/**
 * @param {number[][]} cost - matrice de couts (lignes × colonnes), finie.
 * @returns {{rows:number[], cols:number[], assignment:number[]}}
 *   `assignment[r] = c` (colonne assignee a la ligne r), et les paires (rows,cols).
 */
export function linearSumAssignment(cost) {
  const nRows = cost.length;
  const nCols = cost[0]?.length ?? 0;
  if (nRows === 0 || nCols === 0) return { rows: [], cols: [], assignment: [] };

  const transposed = nRows > nCols;
  const a = transposed ? transpose(cost) : cost;
  const rowToCol = solveSquareOrWide(a); // a: n×m avec n ≤ m -> row r -> col

  const rows = [];
  const cols = [];
  const assignment = new Array(nRows).fill(-1);
  for (let r = 0; r < rowToCol.length; r++) {
    const c = rowToCol[r];
    if (c < 0) continue;
    const origRow = transposed ? c : r;
    const origCol = transposed ? r : c;
    rows.push(origRow);
    cols.push(origCol);
    assignment[origRow] = origCol;
  }
  // Ordonne les paires par ligne (comme scipy).
  const order = rows.map((_, i) => i).sort((i, j) => rows[i] - rows[j]);
  return {
    rows: order.map(i => rows[i]),
    cols: order.map(i => cols[i]),
    assignment,
  };
}

function transpose(m) {
  const out = Array.from({ length: m[0].length }, () => new Array(m.length));
  for (let i = 0; i < m.length; i++) {
    for (let j = 0; j < m[0].length; j++) out[j][i] = m[i][j];
  }
  return out;
}

/** Relaxe les colonnes non utilisees depuis la ligne p[j0] ; retourne la meilleure colonne j1. */
function relaxColumns(ctx, j0) {
  const { a, u, v, p, way, minv, used, m } = ctx;
  const i0 = p[j0];
  let delta = Infinity;
  let j1 = -1;
  for (let j = 1; j <= m; j++) {
    if (used[j]) continue;
    const cur = a[i0 - 1][j - 1] - u[i0] - v[j];
    if (cur < minv[j]) {
      minv[j] = cur;
      way[j] = j0;
    }
    if (minv[j] < delta) {
      delta = minv[j];
      j1 = j;
    }
  }
  return { delta, j1 };
}

/** Applique le potentiel `delta` (colonnes utilisees vs libres). */
function updatePotentials(ctx, delta) {
  const { u, v, p, minv, used, m } = ctx;
  for (let j = 0; j <= m; j++) {
    if (used[j]) {
      u[p[j]] += delta;
      v[j] -= delta;
    } else {
      minv[j] -= delta;
    }
  }
}

/** Cherche un chemin augmentant pour la ligne i, met a jour p/way. */
function augmentRow(ctx, i) {
  const { p, way, minv, used } = ctx;
  p[0] = i;
  minv.fill(Infinity);
  used.fill(false);
  let j0 = 0;
  do {
    used[j0] = true;
    const { delta, j1 } = relaxColumns(ctx, j0);
    updatePotentials(ctx, delta);
    j0 = j1;
  } while (p[j0] !== 0);
  // reconstruit le chemin
  do {
    const j1 = way[j0];
    p[j0] = p[j1];
    j0 = j1;
  } while (j0);
}

/** a: n×m avec n ≤ m. Retourne rowToCol (longueur n). */
function solveSquareOrWide(a) {
  const n = a.length;
  const m = a[0].length;
  const ctx = {
    a,
    m,
    u: new Float64Array(n + 1),
    v: new Float64Array(m + 1),
    p: new Int32Array(m + 1), // p[j] = ligne assignee a la colonne j (1-indexe)
    way: new Int32Array(m + 1),
    minv: new Float64Array(m + 1),
    used: new Array(m + 1),
  };
  for (let i = 1; i <= n; i++) augmentRow(ctx, i);

  const rowToCol = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) {
    if (ctx.p[j] > 0) rowToCol[ctx.p[j] - 1] = j - 1;
  }
  return rowToCol;
}
