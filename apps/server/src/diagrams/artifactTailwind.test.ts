import { describe, expect, it } from "vitest";
import { createArtifactStyling } from "./artifactTailwind.ts";

describe("artifact Tailwind styling", () => {
  it("compiles themes, arbitrary utilities, variants, apply, and runtime classes", async () => {
    const style = createArtifactStyling();
    const html = `<style type="text/tailwindcss">@theme { --color-artifact: #123456; }.card { @apply rounded-lg; }</style><div class="bg-artifact w-[317px] hover:opacity-50 card"></div>`;
    const css = await style(html);
    expect(css).toContain("#123456");
    expect(css).toContain("width: 317px");
    expect(css).toContain("opacity: 50%");
    expect(css).toContain("border-radius: var(--radius-lg)");
    const updated = await style(html, ["text-red-500"]);
    expect(updated).toContain(".text-red-500");
    expect(updated).toContain("var(--color-red-500)");
    expect(updated).toContain("width: 317px");
  });

  it("leaves ordinary CSS imports to the document and compiles their utility classes", async () => {
    const style = createArtifactStyling();
    const css = await style(
      '<style>@import "theme.css"; body { color: red; }</style><div class="flex"></div>',
    );
    expect(css).toContain("display: flex");
  });

  it("keeps incremental utility candidates within their source document", async () => {
    const style = createArtifactStyling();
    await style('<div id="first"></div>', ["text-red-500"]);
    const css = await style('<div id="second"></div>', ["text-blue-500"]);
    expect(css).toContain(".text-blue-500");
    expect(css).not.toContain(".text-red-500");
  });

  it("accepts the pinned import and refuses arbitrary imports or server plugins", async () => {
    const style = createArtifactStyling();
    expect(
      await style(
        '<style type="text/tailwindcss">@import "tailwindcss";</style><div class="flex"></div>',
      ),
    ).toContain("display: flex");
    await expect(
      style('<style type="text/tailwindcss">@import "/tmp/private.css";</style>'),
    ).rejects.toThrow();
    await expect(
      style('<style type="text/tailwindcss">@plugin "node:fs";</style>'),
    ).rejects.toThrow();
  });
});
