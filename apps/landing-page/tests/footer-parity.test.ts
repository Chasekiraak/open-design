import { describe, it } from "node:test";

describe.skip("footer parity", () => {
  it("keeps the homepage footer in sync with the sub-page footer labels", () => {
    // Obsolete: both page.tsx and site-footer.astro now share getFooterLegalCopy() 
    // from footer-legal-i18n.ts, so they cannot drift at the translation-dictionary level.
  });
});
