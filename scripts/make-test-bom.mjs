// Generates a 50-line synthetic BOM against demo/spec.json with 8 issues placed
// at random (seeded, so the same seed always gives the same file).
//
//   node scripts/make-test-bom.mjs [seed]
//
// Writes demo/test-bom-50/: spec.json, bom.csv, certs.csv, context.json (the four
// upload files) plus answer-key.json / ANSWER_KEY.md listing the planted issues.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const seed = Number(process.argv[2] ?? 20261029);
const OUT = "demo/test-bom-50";
const TARGET_LINES = 50;

// mulberry32: small deterministic PRNG.
let s = seed >>> 0;
const rand = () => {
  s = (s + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const spec = JSON.parse(readFileSync("demo/spec.json", "utf8"));
const baseCerts = readFileSync("demo/certs.csv", "utf8").trim().split("\n");
const context = {
  buildId: "BLD-2026-0507",
  odm: "Ironbridge Systems (synthetic ODM)",
  specRevision: spec.revision,
  needBy: "2026-12-18",
  asOf: "2026-10-29"
};
const WINDOW_DAYS = 50; // asOf -> needBy

const certRef = (pn) => "FAI-" + pn.replace(/^RK-/, "");
const prevRev = (r) => String.fromCharCode(r.charCodeAt(0) - 1);

// Parts split across several BOM lines (as ODMs often do): 36 parts + 13 extra lines + 1 off-spec line = 50.
const SPLITS = {
  "RK-DIMM-64G": 4,
  "RK-CBL-PWR-C19": 3,
  "RK-SSD-3T84": 2,
  "RK-CBL-OM4-3M": 2,
  "RK-CBL-CAT6-1M": 2,
  "RK-PSU-1600": 2,
  "RK-DAC-100G-2M": 2,
  "RK-BLANK-1U": 2,
  "RK-RAIL-2U": 2,
  "RK-CMA-2U": 2
};

// Unapproved swaps the LLM should recognise as substitutions.
const SUBSTITUTES = {
  "RK-XCVR-100G-SR4": [
    "VO-Q28-SR4-100",
    "QSFP28 100G SR4 module, 850nm MMF, MPO",
    "Vela Optics",
    "1.2"
  ],
  "RK-NIC-100G": [
    "MS-NIC-2X100-P5",
    "2x 100GbE network adapter, PCIe 5.0 x16",
    "Marlin Semiconductor",
    "R3"
  ],
  "RK-SSD-3T84": [
    "HX-U2-3840",
    "3.84TB U.2 NVMe drive, PCIe Gen4",
    "Halcyon Storage",
    "B2"
  ],
  "RK-SENSOR-ENV": [
    "TP-ENV-200",
    "Rack environment sensor, temperature + RH",
    "Tempra Devices",
    "A"
  ]
};

// Extra parts that are not substitutes for anything.
const EXTRAS = [
  ["RK-PDU-MON", "PDU environmental monitoring dongle", "Northwind Power"],
  ["RK-LIGHT-LED", "Magnetic LED rack light bar", "Granite Racks"],
  ["RK-KVM-1U", "1U rackmount KVM console drawer", "Summit Networks"]
];

function splitQty(total, n) {
  const parts = [];
  let left = total;
  for (let i = n; i > 1; i--) {
    const q = Math.max(1, Math.round((left / i) * (0.6 + rand() * 0.8)));
    parts.push(Math.min(q, left - (i - 1)));
    left -= parts[parts.length - 1];
  }
  parts.push(left);
  return parts;
}

// Clean rows, grouped by spec part.
const groups = spec.parts.map((p) => {
  const n = SPLITS[p.partNumber] ?? 1;
  return {
    part: p,
    rows: splitQty(p.qtyPerRack, n).map((qty) => ({
      pn: p.partNumber,
      desc: p.description,
      mfr: p.approvedManufacturers[0],
      qty,
      rev: p.revision,
      lead: int(5, WINDOW_DAYS - 10),
      cert: certRef(p.partNumber)
    }))
  };
});
const groupOf = (pn) => groups.find((g) => g.part.partNumber === pn);

// ── Plant 8 issues on 8 different parts ─────────────────────────────
const used = new Set();
const take = (candidates) => {
  const pn = pick(candidates.filter((c) => !used.has(c)));
  used.add(pn);
  return groupOf(pn);
};
const allPns = spec.parts.map((p) => p.partNumber);
const revB = allPns.filter((pn) => groupOf(pn).part.revision >= "B");
const certs = [...baseCerts];
const issues = [];
let extraRow = null;

for (const kind of shuffle([
  "substitution",
  "quantity",
  "revision-mismatch",
  "cert",
  "vendor",
  "lead-time",
  "missing-cert",
  "not-in-spec"
])) {
  if (kind === "substitution") {
    const g = take(Object.keys(SUBSTITUTES));
    const [pn, desc, mfr, rev] = SUBSTITUTES[g.part.partNumber];
    g.rows = g.rows.map((r) => ({
      ...r,
      pn,
      desc,
      mfr,
      rev,
      cert: `${pn}-COC`
    }));
    certs.push(`${pn}-COC,${pn},${rev},2026-09-01`);
    issues.push({
      kind,
      target: g.part.partNumber,
      partNumber: pn,
      rows: g.rows,
      detail: `${mfr} ${pn} replaces ${g.part.partNumber} (${g.part.approvedManufacturers[0]}), not on the approved list`
    });
  } else if (kind === "quantity") {
    const g = take(Object.keys(SPLITS));
    const short = int(1, Math.max(1, Math.floor(g.part.qtyPerRack / 8)));
    const row = pick(g.rows.filter((r) => r.qty > short));
    row.qty -= short;
    issues.push({
      kind,
      partNumber: g.part.partNumber,
      rows: g.rows.slice(0, 1),
      detail: `total ${g.part.qtyPerRack - short}, spec needs ${g.part.qtyPerRack} (short ${short}, split across ${g.rows.length} lines)`
    });
  } else if (kind === "revision-mismatch") {
    const g = take(revB);
    const row = pick(g.rows);
    row.rev = prevRev(g.part.revision);
    issues.push({
      kind,
      partNumber: g.part.partNumber,
      rows: [row],
      detail: `rev ${row.rev}, spec needs rev ${g.part.revision}`
    });
  } else if (kind === "cert") {
    const g = take(revB);
    const ref = `${certRef(g.part.partNumber)}-OLD`;
    g.rows.forEach((r) => (r.cert = ref));
    certs.push(
      `${ref},${g.part.partNumber},${prevRev(g.part.revision)},2026-02-${String(int(1, 27)).padStart(2, "0")}`
    );
    issues.push({
      kind,
      partNumber: g.part.partNumber,
      rows: g.rows,
      detail: `cert ${ref} is against drawing rev ${prevRev(g.part.revision)}, spec is rev ${g.part.revision}`
    });
  } else if (kind === "vendor") {
    const g = take(allPns);
    const row = pick(g.rows);
    row.mfr = pick([
      "Copperline Industries",
      "Brightwater Mfg",
      "Eastgate Components"
    ]);
    issues.push({
      kind,
      partNumber: g.part.partNumber,
      rows: [row],
      detail: `${row.mfr} is not an approved manufacturer (spec: ${g.part.approvedManufacturers.join(", ")})`
    });
  } else if (kind === "lead-time") {
    const g = take(allPns);
    const row = pick(g.rows);
    row.lead = WINDOW_DAYS + int(5, 40);
    issues.push({
      kind,
      partNumber: g.part.partNumber,
      rows: [row],
      detail: `${row.lead}-day lead time lands ${row.lead - WINDOW_DAYS} days after need-by ${context.needBy}`
    });
  } else if (kind === "missing-cert") {
    const g = take(allPns);
    const row = pick(g.rows);
    row.cert = `${certRef(g.part.partNumber)}-R2`;
    issues.push({
      kind,
      partNumber: g.part.partNumber,
      rows: [row],
      detail: `cert ${row.cert} is referenced but not in certs.csv`
    });
  } else {
    const [pn, desc, mfr] = pick(EXTRAS);
    extraRow = {
      pn,
      desc,
      mfr,
      qty: 1,
      rev: "A",
      lead: int(3, 20),
      cert: certRef(pn)
    };
    certs.push(`${certRef(pn)},${pn},A,2026-09-10`);
    issues.push({
      kind,
      partNumber: pn,
      rows: [extraRow],
      detail: `${pn} (${desc}) is not in the spec`
    });
  }
}

// Flatten, drop the off-spec part at a random position, then number the lines.
const rows = groups.flatMap((g) => g.rows);
if (extraRow) rows.splice(int(0, rows.length), 0, extraRow);
if (rows.length !== TARGET_LINES)
  throw new Error(`expected ${TARGET_LINES} lines, got ${rows.length}`);
rows.forEach((r, i) => (r.line = i + 1));

// ── Write files ───────────────────────────────────────────────────────
const csv = (table) =>
  table
    .map((r) =>
      r
        .map((f) => (/[",]/.test(f) ? `"${f.replace(/"/g, '""')}"` : f))
        .join(",")
    )
    .join("\n") + "\n";

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/spec.json`, JSON.stringify(spec, null, 2) + "\n");
writeFileSync(`${OUT}/context.json`, JSON.stringify(context, null, 2) + "\n");
writeFileSync(`${OUT}/certs.csv`, certs.join("\n") + "\n");
writeFileSync(
  `${OUT}/bom.csv`,
  csv([
    [
      "line",
      "part_number",
      "description",
      "manufacturer",
      "quantity",
      "revision",
      "lead_time_days",
      "cert_ref"
    ],
    ...rows.map((r) => [
      String(r.line),
      r.pn,
      r.desc,
      r.mfr,
      String(r.qty),
      r.rev,
      String(r.lead),
      r.cert
    ])
  ])
);

// What the review should report for each planted issue (with a working LLM).
const EXPECTED = {
  substitution: [
    "substitution",
    "needs-review (blocker if the model rates it high-risk)",
    "llm"
  ],
  quantity: ["quantity", "blocker", "rule"],
  "revision-mismatch": ["revision-mismatch", "blocker", "rule"],
  cert: ["cert", "blocker", "rule"],
  vendor: ["vendor", "blocker", "rule"],
  "lead-time": ["lead-time", "blocker", "rule"],
  "missing-cert": ["missing-data", "needs-review", "rule"],
  "not-in-spec": ["not-in-spec", "blocker", "llm"]
};
const key = issues
  .map((i) => {
    const [category, severity, source] = EXPECTED[i.kind];
    return {
      lines: i.rows.map((r) => r.line),
      partNumber: i.partNumber,
      ...(i.target ? { substituteFor: i.target } : {}),
      category,
      severity,
      source,
      detail: i.detail
    };
  })
  .sort((a, b) => a.lines[0] - b.lines[0]);
writeFileSync(
  `${OUT}/answer-key.json`,
  JSON.stringify(
    { seed, buildId: context.buildId, lines: rows.length, issues: key },
    null,
    2
  ) + "\n"
);
writeFileSync(
  `${OUT}/ANSWER_KEY.md`,
  [
    `# Answer key: ${context.buildId} (seed ${seed})`,
    "",
    `${rows.length} BOM lines against spec ${spec.specId} rev ${spec.revision}, need-by ${context.needBy}, reviewed as of ${context.asOf}.`,
    "Regenerate with `node scripts/make-test-bom.mjs " +
      seed +
      "` (another seed gives a different layout).",
    "",
    "| # | Line(s) | Part | Expected finding | Severity | Found by | What's wrong |",
    "|---:|---|---|---|---|---|---|",
    ...key.map(
      (k, i) =>
        `| ${i + 1} | ${k.lines.join(", ")} | ${k.partNumber} | ${k.category} | ${k.severity} | ${k.source} | ${k.detail} |`
    ),
    "",
    "Rack power is also reported as an info finding when it is above 90% of the budget.",
    "Without a model, the two LLM items go to the reviewer as needs-review, and the replaced spec part shows as missing (blocker).",
    ""
  ].join("\n")
);
console.log(
  `wrote ${OUT}/ (${rows.length} lines, ${issues.length} issues, seed ${seed})`
);
