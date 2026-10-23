import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractPreservedMeta, formatFrontmatter, parseFrontmatter } from "../../src/store/skill-utils.js";

describe("formatFrontmatter", () => {
  it("quotes string fields safely for YAML", () => {
    const raw = formatFrontmatter({
      name: "audit-agents-md",
      displayName: "Audit AGENTS.md",
      description: "Audit and restructure AGENTS.md files: remove cross-references between sections",
      version: 1,
      created: "2026-05-18",
      updated: "2026-05-18",
      body: "# Steps\n1. Do thing",
    });

    assert.ok(raw.includes('name: "audit-agents-md"'));
    assert.ok(raw.includes('description: "Audit and restructure AGENTS.md files: remove cross-references between sections"'));
    assert.ok(raw.includes('display_name: "Audit AGENTS.md"'));
  });

  it("carries unmanaged frontmatter fields through a rewrite", () => {
    const raw = formatFrontmatter(
      {
        name: "hidden-skill",
        displayName: "Hidden skill",
        description: "A skill the model must not pick automatically",
        version: 2,
        created: "2026-05-18",
        updated: "2026-05-19",
        body: "# Steps",
      },
      { "disable-model-invocation": "true", license: "MIT", "max-turns": "5" },
    );

    // Booleans and numbers stay unquoted so YAML does not hand them back as strings.
    assert.ok(raw.includes("disable-model-invocation: true"));
    assert.ok(raw.includes("max-turns: 5"));
    assert.ok(raw.includes('license: "MIT"'));

    const parsed = parseFrontmatter(raw);
    assert.equal(parsed.meta["disable-model-invocation"], "true");
    assert.equal(parsed.meta.version, "2");
  });

  it("drops managed keys from the extra set instead of duplicating them", () => {
    const raw = formatFrontmatter(
      {
        name: "n",
        description: "d",
        version: 1,
        created: "2026-05-18",
        updated: "2026-05-19",
        body: "b",
      },
      { name: "other", description: "other desc", "disable-model-invocation": "true" },
    );
    assert.equal(raw.match(/^name:/gm)?.length, 1);
    assert.equal(raw.match(/^description:/gm)?.length, 1);
    assert.deepEqual(extractPreservedMeta({ name: "n", version: "1", license: "MIT" }), { license: "MIT" });
  });
});
