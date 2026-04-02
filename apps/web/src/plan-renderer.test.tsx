import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  isWebHref,
  MarkdownPlanDocument,
  normalizePlanDocument,
} from "./plan-renderer";

describe("plan renderer", () => {
  test("normalizes json plans into canonical markdown", () => {
    const normalized = normalizePlanDocument(JSON.stringify({
      explanation: "Ship the plan renderer.",
      steps: ["Add a plan pane", "Render markdown"],
    }));

    expect(normalized).toEqual({
      markdown: "Ship the plan renderer.\n\n## Plan\n1. Add a plan pane\n2. Render markdown",
      sourceKind: "json_plan",
    });
  });

  test("passes markdown through unchanged", () => {
    const normalized = normalizePlanDocument("## Plan\n- First\n- Second");

    expect(normalized).toEqual({
      markdown: "## Plan\n- First\n- Second",
      sourceKind: "markdown",
    });
  });

  test("falls back to plain text when content is not markdown", () => {
    const normalized = normalizePlanDocument("just explain the next step plainly");

    expect(normalized).toEqual({
      markdown: "just explain the next step plainly",
      sourceKind: "plain_text",
    });
  });

  test("uses fallback steps when blob content is missing", () => {
    const normalized = normalizePlanDocument(null, ["Audit the UI", "Render the plan"]);

    expect(normalized).toEqual({
      markdown: "## Plan\n1. Audit the UI\n2. Render the plan",
      sourceKind: "trace_fallback",
    });
  });

  test("renders only web links as anchors", () => {
    const html = renderToStaticMarkup(
      <MarkdownPlanDocument markdown="[Docs](https://example.com) and [Local](C:/work/file.md)" />
    );

    expect(isWebHref("https://example.com")).toBe(true);
    expect(isWebHref("C:/work/file.md")).toBe(false);
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain('href="C:/work/file.md"');
    expect(html).toContain(">Local<");
  });
});
