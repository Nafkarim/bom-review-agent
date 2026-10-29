import { Agent, callable, type Connection } from "agents";
import { DEMOS } from "./demo";
import {
  currentSpec,
  saveSpec,
  summarize,
  type SpecLibraryState,
  type SpecRevisionRecord
} from "./spec-library";
import type { Spec } from "./types";

/** Name of the single library instance shared by every review. */
export const SPEC_LIBRARY_NAME = "default";

/**
 * The rack spec library: every spec ("gold standard") and its full revision
 * history, in one Durable Object. Reviews read the current revision from here
 * and snapshot it, so editing a spec never changes a review already run.
 */
export class SpecLibrary extends Agent<Env, SpecLibraryState> {
  initialState: SpecLibraryState = { specs: {} };

  onStart() {
    // Seed with the demo rack spec so the demos work on a fresh deployment.
    if (Object.keys(this.state.specs).length === 0) {
      const res = saveSpec(
        this.state,
        JSON.parse(DEMOS.issues.spec),
        "Seeded from demo/spec.json"
      );
      if (res.ok) this.setState(res.state);
    }
  }

  // Clients read state, but every change goes through saveSpec's rules.
  validateStateChange(_next: SpecLibraryState, source: Connection | "server") {
    if (source !== "server")
      throw new Error("The spec library is read-only for clients");
  }

  @callable()
  listSpecs() {
    return summarize(this.state);
  }

  @callable()
  save(
    spec: unknown,
    note: string
  ):
    | { ok: true; record: SpecRevisionRecord }
    | { ok: false; problems: string[] } {
    const res = saveSpec(this.state, spec, note ?? "");
    if (!res.ok) return res;
    this.setState(res.state);
    return { ok: true, record: res.record };
  }

  /** RPC for ReviewAgent: the current revision of a spec, or null. */
  async getCurrent(specId: string): Promise<Spec | null> {
    return currentSpec(this.state, specId);
  }
}
