# Medlock redesign QA

Final result: passed (local implementation). Production release: blocked.

The user requested a drastic simplification of the existing healthMCP website, with Apple-like restraint, intuitive controls, no demo UI or graphs, and all real capabilities and essential disclosures preserved. This is a redesign, not a pixel clone.

## Verified target

- Repository: `collinbentley1/healthmcp`; isolated checkout based on `495b233fc39454f920ab552c19d658b83b747a3f`.
- Canonical site: `https://medlock.ai`; Cloud Run service `medlock`, project `medlock-1025243085`, region `us-east4`.
- Live revision: `medlock-00015-6tf`, 100% traffic; image commit `43a6f1874a078233f14e763dcc848423e268d98b`.
- No changes to dot2dot, other repositories, server endpoints, MCP data, OAuth, IAM, secrets, storage, or deployment configuration.

## Visual evidence

Evidence directory: `/Users/collin/Documents/Codex/2026-10-03/task-2/evidence/`.

Source visual truth: `medlock-before-desktop.png` and `medlock-before-phone.png`, captured from production. Implementation: `after-1440-light.png`, `after-390-light.png`, `after-390-dark.png`, plus tablet/wide light/dark screenshots.

Full-view comparison: `before-after-comparison.png`. Both sides show the same 1440 × 1000 CSS-pixel initial viewport at device scale 1, normalized to 720 × 500 comparison panels. The longer production capture is cropped to its first viewport. The selected direction deliberately replaces the prior two-column marketing page with a single signup surface and two native disclosure controls. No exact clone fidelity is claimed.

Focused evidence: `waitlist-loading.png`, `waitlist-success-fixture.png`, `waitlist-rate-limit-fixture.png`, `confirmation-success-fixture.png`, `confirmation-error-fixture.png`, `confirmation-invalid.png`, and `scan-desktop.png`. These show readable status messages, controls, privacy links, and utility pages at usable sizes.

## Required design surfaces

- Typography: system font stack, restrained weights, large two-line heading, body 16px, labels/disclosures 14px at default font settings. Display text wraps without overlap; visible focus and text enlargement are supported.
- Spacing/layout: centered signup form, 48px minimum interactive control height, compact native details. Phone form and endpoint controls stack at 600px. Checked both sides of the breakpoint and very narrow zoom reflow.
- Color/tokens: cool light neutral, dark neutral, Medlock green accent. Light/dark palettes have distinct accessible foregrounds and visible focus rings; status colors accompany explicit text.
- Assets: original favicon/brand asset preserved. Removed the CSS diagram and testimonial; added no decorative artwork, demo readings, or graphs.
- Copy: short functional labels and concise email-use, reCAPTCHA, public sample-data, medical, and camera disclosures. No invented pod reservation or public private-record connection capability.

## Interaction and responsive verification

- `bun run verify:ci`: format, lint, TypeScript, **185 tests / 688 assertions / 0 failures**, production build.
- Browser: Chrome with a clean temporary profile; no user session inspected or changed. In-app browser control tools were unavailable in this delegated environment.
- 18 combinations: light/dark at widths 320, 390, 599, 600, 601, 768, 1024, 1440, 2560px. Closed and expanded disclosures; no document horizontal overflow.
- Six actual keyboard stops on the initial screen all have visible focus. Native required/email validation works; disclosure toggles and MCP copy work.
- Reduced motion disables smooth scrolling; no animated decorative elements exist.
- 200% text enlargement, 200% CSS zoom, and equivalent browser reflow at 720 and 195 CSS px pass. Actual native Chrome 200% Page zoom also passes: outer width 1440px, inner width 720 CSS px, DPR 2, document width 720px, with default CSS zoom 1. Recorded in `native-zoom.json` / `native-browser-zoom-200.png`.
- Actual local unavailable-waitlist path shows a recoverable error, without sending mail.
- Browser fixtures exercise waitlist loading/success, a verification-load failure followed by retry, 429 response, confirmation success/error, invalid-link state, and scan navigation. These success states are **fixtures**, not evidence of a production signup or email delivery. The existing repository suite exercises real local HTTP MCP and waitlist handler behavior.
- No uncaught browser errors. Four resource-error console messages correspond to expected 503, 429, and 400 error checks; no asset 404 remains.

## Comparison history

1. Narrow 200% reflow initially overflowed by 9px at 195 CSS px. Added header wrapping; subsequent captures and overflow assertions pass.
2. Browser confirmation success initially failed: the pre-existing HTML script URL was `/assets/waitlist-confirm.js`, while the actual build emits `/assets/waitlist-confirm-client.js`. Corrected the URL; confirmation success/error and invalid-link checks pass with the built application.
3. Final desktop/phone comparison and focused state captures show no remaining actionable P0/P1/P2 visual issues.

## Remaining release and reference blockers

Production Actions are globally disabled (`enabled: false`) and `Deploy production` is `disabled_manually`. The current README and pinned platform security rollout require protected proof/activation gates before enabling Actions; the production workflow is push-only. No workflow enablement, manual deployment, access change, PR merge, or workaround was attempted. Consequently the redesigned build has not been deployed, and a post-redesign production smoke test cannot yet be performed.

dot2dot returned its ChatGPT login gate in this clean browser. The official OpenAI dots article was read using the web tool, but both official marketing URLs returned 403 in the rendering browser; the embedded video could not be inspected. Those access failures are saved separately and are not presented as visual-reference evidence.

The local design QA passes. Deployment remains blocked until the existing protected release gate is completed through its approved workflow.

## Hero revision requested after screenshot review

Replaced the abstract headline with “Privately share your health info,” followed by small Claude and ChatGPT marks and visible names. “Coming soon” is visible above the heading and exposed as its accessible description, because personal-record sharing is planned rather than implemented on this public deployment. The MCP disclosure still states sample-only data and now identifies Claude custom connections and ChatGPT developer mode. No new connector, OAuth flow or health-data capability was implemented.

Compatibility evidence: the repository documents Claude custom-connector and Claude Code setup for this Streamable HTTP server. [Claude’s current remote-MCP guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) supports custom public MCP endpoints. [OpenAI’s developer-mode documentation](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt) supports custom remote MCP apps; its current FAQ does not require search/fetch tools. [OpenAI’s Responses API](https://developers.openai.com/api/docs/guides/tools-connectors-mcp) also supports Streamable HTTP. ChatGPT is therefore protocol-compatible through its custom setup, but no ChatGPT app was registered or live provider connection tested. Account/plan permissions apply.

No Muse connector or identifiable Muse client compatibility evidence was found in the repository. [Grok’s remote-MCP documentation](https://docs.x.ai/developers/tools/remote-mcp) proves developer-API compatibility, not a consumer Grok-app connector. Muse and Grok app icons are omitted to avoid implying those integrations.

The locally served SVG marks come from Simple Icons: [Claude](https://raw.githubusercontent.com/simple-icons/simple-icons/develop/icons/claude.svg), retrieved 2026-10-03, and [OpenAI](https://raw.githubusercontent.com/simple-icons/simple-icons/11.15.0/icons/openai.svg), release 11.15.0. Simple Icons assets use CC0; product marks remain their owners’ trademarks. Icons have empty alt text beside readable app names, add no keyboard stops, and adapt to the dark theme. Initial screenshot review caught missing SVGs in the build’s fixed asset copy list; the build now copies both and Chrome checks assert that both images actually load.

Fresh evidence is under `evidence/hero-revision/`. Format, lint, TypeScript and build pass. Repeated Chrome QA passes all 18 responsive/theme combinations, 12 flow/state checks, visible keyboard focus, 200% text and CSS zoom, narrow reflow, reduced motion, and native Chrome 200% zoom. No horizontal overflow or uncaught browser error remains. These results are local; production activation remains blocked by the unchanged protected release gate.
