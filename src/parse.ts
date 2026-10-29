import { z } from "zod";
import type { BomLine, BuildContext, Cert, ReviewInput, Spec } from "./types";

// Raw file contents as uploaded or loaded from the demo set.
export type RawReviewFiles = {
  spec: string; // JSON
  bom: string; // CSV
  certs: string; // CSV
  context: string; // JSON
};

export class IntakeError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Intake failed:\n- ${problems.join("\n- ")}`);
    this.name = "IntakeError";
  }
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const specSchema = z.object({
  specId: z.string().min(1),
  revision: z.string().min(1),
  rackName: z.string().min(1),
  powerBudgetW: z.number().positive(),
  parts: z
    .array(
      z.object({
        partNumber: z.string().min(1),
        description: z.string(),
        revision: z.string().min(1),
        qtyPerRack: z.number().int().positive(),
        wattsEach: z.number().nonnegative(),
        approvedManufacturers: z.array(z.string()).min(1),
        approvedSubstitutes: z
          .array(
            z.object({
              partNumber: z.string(),
              manufacturer: z.string(),
              revision: z.string()
            })
          )
          .default([])
      })
    )
    .min(1)
});

const contextSchema = z.object({
  buildId: z
    .string()
    .regex(/^[A-Za-z0-9-]+$/, "letters, digits and dashes only"),
  odm: z.string().min(1),
  specRevision: z.string().min(1),
  needBy: isoDate,
  asOf: isoDate
});

const BOM_HEADERS = [
  "line",
  "part_number",
  "description",
  "manufacturer",
  "quantity",
  "revision",
  "lead_time_days",
  "cert_ref"
] as const;

const CERT_HEADERS = [
  "cert_ref",
  "part_number",
  "drawing_revision",
  "issued"
] as const;

/** Minimal RFC 4180 CSV parser: quoted fields, escaped quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

function readTable(
  name: string,
  text: string,
  headers: readonly string[],
  problems: string[]
): Record<string, string>[] {
  const rows = parseCsv(text);
  if (rows.length === 0) {
    problems.push(`${name}: file is empty`);
    return [];
  }
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const missing = headers.filter((h) => !header.includes(h));
  if (missing.length > 0) {
    problems.push(`${name}: missing column(s) ${missing.join(", ")}`);
    return [];
  }
  return rows.slice(1).map((r) => {
    const rec: Record<string, string> = {};
    header.forEach((h, i) => (rec[h] = (r[i] ?? "").trim()));
    return rec;
  });
}

function parseJson<T>(
  name: string,
  text: string,
  schema: z.ZodType<T>,
  problems: string[]
): T | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    problems.push(`${name}: not valid JSON`);
    return null;
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    for (const issue of result.error.issues) {
      problems.push(
        `${name}: ${issue.path.join(".") || "(root)"} ${issue.message}`
      );
    }
    return null;
  }
  return result.data;
}

function parseBom(text: string, problems: string[]): BomLine[] {
  const seen = new Set<number>();
  return readTable("bom.csv", text, BOM_HEADERS, problems).flatMap((r, i) => {
    const where = `bom.csv row ${i + 2}`;
    const line = Number(r.line);
    const quantity = Number(r.quantity);
    if (!Number.isInteger(line) || line <= 0) {
      problems.push(`${where}: line "${r.line}" is not a positive integer`);
      return [];
    }
    if (seen.has(line)) {
      problems.push(`${where}: duplicate line number ${line}`);
      return [];
    }
    seen.add(line);
    if (!r.part_number) {
      problems.push(`${where}: part_number is empty`);
      return [];
    }
    if (!Number.isInteger(quantity) || quantity < 0) {
      problems.push(`${where}: quantity "${r.quantity}" is not a whole number`);
      return [];
    }
    // Lead time may be blank (flagged later as missing data) but not garbage.
    let leadTimeDays: number | null = null;
    if (r.lead_time_days !== "") {
      leadTimeDays = Number(r.lead_time_days);
      if (!Number.isFinite(leadTimeDays) || leadTimeDays < 0) {
        problems.push(
          `${where}: lead_time_days "${r.lead_time_days}" is not a number`
        );
        return [];
      }
    }
    return [
      {
        line,
        partNumber: r.part_number,
        description: r.description,
        manufacturer: r.manufacturer,
        quantity,
        revision: r.revision,
        leadTimeDays,
        certRef: r.cert_ref
      }
    ];
  });
}

function parseCerts(text: string, problems: string[]): Cert[] {
  return readTable("certs.csv", text, CERT_HEADERS, problems).map((r) => ({
    certRef: r.cert_ref,
    partNumber: r.part_number,
    drawingRevision: r.drawing_revision,
    issued: r.issued
  }));
}

/** Validates all four files and returns typed input, or throws IntakeError listing every problem. */
export function parseReviewInput(files: RawReviewFiles): ReviewInput {
  const problems: string[] = [];
  const spec = parseJson<Spec>("spec.json", files.spec, specSchema, problems);
  const context = parseJson<BuildContext>(
    "context.json",
    files.context,
    contextSchema,
    problems
  );
  const bom = parseBom(files.bom, problems);
  const certs = parseCerts(files.certs, problems);

  if (bom.length === 0 && !problems.some((p) => p.startsWith("bom.csv"))) {
    problems.push("bom.csv: no BOM lines");
  }
  if (spec && context && spec.revision !== context.specRevision) {
    problems.push(
      `context.json: specRevision ${context.specRevision} does not match spec.json revision ${spec.revision}`
    );
  }
  if (problems.length > 0 || !spec || !context) throw new IntakeError(problems);
  return { spec, bom: bom.sort((a, b) => a.line - b.line), certs, context };
}
