// Synthetic demo files, bundled into the Worker so the demo needs no upload.
import spec from "../demo/spec.json?raw";
import bomIssues from "../demo/bom-issues.csv?raw";
import bomClean from "../demo/bom-clean.csv?raw";
import certs from "../demo/certs.csv?raw";
import contextIssues from "../demo/context-issues.json?raw";
import contextClean from "../demo/context-clean.json?raw";
import type { RawReviewFiles } from "./parse";

export type DemoName = "issues" | "clean";

export const DEMOS: Record<DemoName, RawReviewFiles> = {
  issues: { spec, bom: bomIssues, certs, context: contextIssues },
  clean: { spec, bom: bomClean, certs, context: contextClean }
};

export const DEMO_BUILD_IDS: Record<DemoName, string> = {
  issues: JSON.parse(contextIssues).buildId,
  clean: JSON.parse(contextClean).buildId
};
