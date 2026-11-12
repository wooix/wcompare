---
name: paper-helper
description: Create Korean paper reading sites using the bundled fixed layout, fonts, ToC, terminology controls, highlights, source comparison, and automatic resume. Use when converting a research paper into this reading format or updating its paper content.
---

# paper-helper

Use the existing UI and behavior in `assets/site`. Fill the paper data contract in [references/paper.schema.json](references/paper.schema.json) and run the builder. The UI asset hashes in `template-lock.json` keep each generated paper on the same template version.

Read [references/features.md](references/features.md) for the fixed components and acceptance criteria. Read [references/content-rules.md](references/content-rules.md) when preparing the translation. The two files in `examples/` are functional demonstrations of the same UI with different chapter counts.

## Create a reading site

1. Inspect the supplied paper, its version, source structure, figures and usage terms. Record the source text units before translating. Preserve the source identifiers and locations.
2. Prepare `paper.json` according to the data contract. Supply the metadata, complete source inventory, translated blocks, chapter/section tree, introductions, closing takeaways, relevant appendices, glossary explanations and bibliography.
3. Use stable IDs when updating a paper. Main chapters use `S1`, `S2`, and so on. Appendices use `A1`, `A2`, and so on. Every reading block has a unique ID under its chapter. Keep existing block IDs for existing passages so highlights and reading positions continue to resolve.
4. Generate the site from the bundled assets.

```sh
python3 <skill-directory>/scripts/build_site.py \
  --input /absolute/path/paper.json \
  --output /absolute/path/project/dist \
  --node /absolute/path/node
```

The script checks source-unit coverage, original MathML, citation links, IDs and the fixed UI assets. It derives the ToC, terminology inventory, search data and reading positions from the paper data. It outputs the site and `read-offline.html`, including the fixed fonts.

5. Verify the delivered UI files after generation, including after any subsequent edits.

```sh
python3 <skill-directory>/scripts/verify_output.py --site /absolute/path/project/dist
```

Inspect the translated claims and terminology against the source. Check the generated `build-report.json` and exercise the important reader controls in a browser. Report coverage checks and semantic review separately.
6. Deliver the generated reading site and offline file. Use the available Sites workflow when hosting is part of the user's request. The project identity and audience come from that task.

## Fixed presentation

Use the same `index.html`, CSS, fonts and reader scripts for every paper generated with a template version. Paper data supplies content to the existing components. The fixed component order, dimensions, fonts, states and interactions are documented in [references/features.md](references/features.md).

When the user requests a design or interaction change, apply it to the shared assets, verify the affected components, and record a new template version with `scripts/update_lock.py --version <version>`. Future generated papers can then use that revision consistently.

## Content fields

The data contract covers the paper title and source information, chapter count and hierarchy, translated passages, equations, figures, tables, introductory guidance, short recaps, glossary meanings, references and relevant supplementary links. Source units in `sourceInventory` map one-to-one to translated blocks or headings.

Use `examples/queue-demo.json` as a complete input example. Use `examples/process-demo.json` to see a different chapter count with the same reader components. Example source content is explicitly marked as demonstration material.

## Reading behavior

Terminology settings apply to all occurrences in the reader. Removing a term switches its display to English only. Source text remains available. Highlights and reading state are associated with the paper ID and version. Their anchors stay independent of the visible Korean gloss.

On return, restore the last reading passage and scroll position. Honor explicit section and sentence links. Use the bundled behavior for font loading, image loading, resized screens, local storage and offline reading.

## Verification

After changing the shared template, run the two-document browser verification. Point `NODE_PATH` at the installed Playwright package and `PYTHON_BIN` at Python when those tools are bundled with the host.

```sh
node <skill-directory>/scripts/verify_browser.cjs
```

For normal paper generation, retain the fixed asset hashes, run the builder and inspect the actual paper output. A successful structural build records source coverage and UI integrity. Translation claims and terminology still require source comparison.
