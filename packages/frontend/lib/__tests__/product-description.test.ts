import { describe, expect, it } from "vitest";
import { descriptionUrl, prepareProductDescription, type DescriptionNode } from "../../../ui/src/lib/product-description";

function text(nodes: DescriptionNode[]): string {
  return nodes.map(node => typeof node === "string" ? node : node.tag === "br" ? "\n" : text(node.children)).join("");
}

describe("authored product descriptions", () => {
  it("preserves plain paragraphs, comparison symbols and literal unknown angle brackets", () => {
    const value = "Cotton & linen <blend>\n\nWash below 30°C; 2 < 3. 🧵";
    const result = prepareProductDescription(value);
    expect(result.html).toBe(false);
    expect(text(result.full)).toBe(value);
    expect(text(result.preview)).toBe(value);
    expect(result.truncated).toBe(false);
  });

  it("counts decoded text and whole Unicode characters, retaining inline formatting", () => {
    const result = prepareProductDescription(`<p>${"&#x1f9f5;".repeat(339)}<strong>&amp;last</strong></p>`);
    expect(Array.from(text(result.preview))).toHaveLength(340);
    expect(text(result.preview).endsWith("🧵&")).toBe(true);
    expect(result.preview.at(-1)).toEqual({ tag: "strong", children: ["&"] });
    expect(result.truncated).toBe(true);
    expect(text(result.full).endsWith("&last")).toBe(true);
  });

  it("keeps short rich descriptions complete instead of counting HTML as visible text", () => {
    const result = prepareProductDescription("<p><strong>Soft</strong> &amp; <em>comfortable</em>.</p>".repeat(8));
    expect(result.truncated).toBe(false);
    expect(text(result.preview)).toContain("Soft & comfortable.");
  });

  it("normalizes the furniture-style preview while preserving full headings and lists", () => {
    const result = prepareProductDescription("<p><br></p><h4>Dimensions</h4><p>One&nbsp;size</p><p><br></p><ul><li><b>Width:</b> 120cm</li><li>Height: 90cm</li></ul><br><br><br>");
    expect(text(result.preview)).toBe("Dimensions\nOne size\nWidth: 120cmHeight: 90cm");
    expect(result.full).toContainEqual({ tag: "h4", children: ["Dimensions"] });
    expect(result.preview.some(node => typeof node !== "string" && node.tag === "ul")).toBe(true);
  });

  it("preserves complete automotive tables, ordered lists and author links in the sheet", () => {
    const result = prepareProductDescription('<table><tbody><tr><th>Part</th><th>Fit</th></tr><tr><td>Brake pad</td><td>Front</td></tr></tbody></table><ol start="3"><li>Check fit</li></ol><a href="https://example.com/care">Care guide</a>');
    expect(result.full[0]).toMatchObject({ tag: "table", children: [{ tag: "tbody" }] });
    expect(result.full[1]).toMatchObject({ tag: "ol", start: 3 });
    expect(result.full[2]).toMatchObject({ tag: "a", href: "https://example.com/care" });
    expect(text(result.full)).toBe("PartFitBrake padFrontCheck fitCare guide");
  });

  it("normalizes implicit table groups and removes structural whitespace like browser HTML", () => {
    const result = prepareProductDescription('<table>\n  <tr>\n    <td> Size </td>\n    <td> Width </td>\n  </tr>\n</table>');
    expect(result.full).toEqual([{ tag: "table", children: [{ tag: "tbody", children: [{ tag: "tr", children: [
      { tag: "td", children: [" Size "] }, { tag: "td", children: [" Width "] },
    ] }] }] }]);
  });

  it("never carries scripts, event attributes, foreign DOM or executable links into the renderer", () => {
    const result = prepareProductDescription('<p onclick="alert(1)">Safe <a href="java&#x73;cript:alert(1)">link</a></p><script>alert(1)</script><svg onload="alert(1)"><text>hidden</text></svg><iframe src="https://example.com"></iframe><img src="data:text/html,bad" alt="Diagram"><strong style="display:none">Visible</strong>');
    expect(text(result.full)).toBe("Safe linkDiagramVisible");
    expect(JSON.stringify(result.full)).not.toMatch(/alert|onclick|onload|style|iframe|script|data:/);
    expect(descriptionUrl(" java\nscript:alert(1)")).toBeUndefined();
    expect(descriptionUrl("https://example.com/image.png", true)).toBe("https://example.com/image.png");
    expect(descriptionUrl("mailto:help@example.com", true)).toBeUndefined();
  });

  it("handles malformed merchant HTML without losing the readable content", () => {
    const result = prepareProductDescription("<div><p>First <b>bold<p>Second &lt;literal&gt;</div>");
    expect(text(result.full)).toContain("First bold");
    expect(text(result.full)).toContain("Second <literal>");
  });
});
