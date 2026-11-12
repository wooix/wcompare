"""Build a paper reader by combining validated paper data with the fixed site assets."""

import argparse
import base64
from collections import Counter
import hashlib
from html import escape
from html.parser import HTMLParser
import json
import mimetypes
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "assets/site"
VOID_TAGS = {"br", "hr", "img", "wbr"}
MATH_TAGS = set("math semantics annotation mi mn mo mtext mspace ms mrow mfrac msqrt mroot mstyle merror mpadded mphantom mfenced menclose msub msup msubsup munder mover munderover mmultiscripts mprescripts none mtable mlabeledtr mtr mtd maligngroup malignmark".split())
HTML_TAGS = set("p div span strong em b i sub sup br hr wbr ul ol li blockquote table thead tbody tfoot tr th td caption a cite code pre".split())
ATTRIBUTES = set("id class href colspan rowspan scope display mathvariant stretchy fence separator accent accentunder lspace rspace notation linethickness columnalign rowalign columnspacing rowspacing columnspan scriptlevel displaystyle width height depth voffset encoding".split())


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


class Fragment(HTMLParser):
    """Allow content markup and MathML while keeping layout and executable code out of paper data."""

    def __init__(self, markup, remove_ids=False):
        super().__init__(convert_charrefs=True)
        self.output = []
        self.text = []
        self.links = []
        self.ids = []
        self.stack = []
        self.math_depth = 0
        self.remove_ids = remove_ids
        self.feed(markup)
        self.close()
        require(not self.stack, "Unclosed content tags: " + ", ".join(self.stack))
        self.html = "".join(self.output)
        self.plain = "".join(self.text)

    def handle_starttag(self, tag, attrs):
        require(tag in HTML_TAGS | MATH_TAGS, f"Unsupported content tag <{tag}>")
        values = []
        for name, value in attrs:
            if name not in ATTRIBUTES or value is None:
                continue
            if name == "id":
                if self.remove_ids:
                    continue
                require(re.fullmatch(r"[A-Za-z0-9_.:-]+", value), "Invalid content anchor")
                self.ids.append(value)
            if name == "href":
                require(value.startswith(("https://", "http://", "#")), "Links must use HTTPS, HTTP, or a local anchor")
                self.links.append(value)
            if name == "class":
                value = " ".join(part for part in value.split() if part.startswith("ltx_"))
                if not value:
                    continue
            values.append((name, value))
        if tag == "a":
            values += [("class", "ltx_ref"), ("rel", "noopener noreferrer")]
        self.output.append("<" + tag + "".join(f' {key}="{escape(value, quote=True)}"' for key, value in values) + ">")
        if tag == "math":
            self.math_depth += 1
        if tag not in VOID_TAGS:
            self.stack.append(tag)

    def handle_endtag(self, tag):
        if tag in VOID_TAGS:
            return
        require(self.stack and self.stack[-1] == tag, f"Unbalanced content tag </{tag}>")
        self.stack.pop()
        self.output.append(f"</{tag}>")
        if tag == "math":
            self.math_depth -= 1

    def handle_data(self, text):
        self.output.append(escape(text))
        if not self.math_depth:
            self.text.append(text)


def math_fragments(markup):
    without_ids = re.sub(r' id="[^"]*"', "", markup)
    return Counter(re.findall(r"<math\b.*?</math>", without_ids, re.S))


class PaperBuilder:
    def __init__(self, paper_data, media_root):
        self.data = paper_data
        self.media_root = media_root
        self.used_sources = set()
        self.anchors = set()
        self.blocks = []
        self.originals = {}
        self.search = []
        self.links = []
        self.media = {}
        self.inventory = paper_data["sourceInventory"]
        self.toc = []
        self.chapter = ""
        self.section = ""

    def anchor(self, value):
        require(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:-]+", value), f"Invalid anchor {value!r}")
        require(value not in self.anchors, f"Duplicate anchor {value}")
        self.anchors.add(value)
        return value

    def record(self, identifier, fragment, kind="translation"):
        self.blocks.append({"id": identifier, "chapter": self.chapter, "section": self.section,
                            "order": len(self.blocks), "kind": kind, "text": fragment.plain})
        for anchor in fragment.ids:
            self.anchor(anchor)
        self.links.extend(fragment.links)

    def translated(self, item, markup):
        identifier = self.anchor(item["id"])
        require(identifier.startswith(self.chapter + "-"), f"Block {identifier} must belong to {self.chapter}")
        fragment = Fragment(markup)
        source_id = item.get("sourceId")
        kind = item.get("origin", "translation")
        require(kind in {"translation", "ai"}, "Block origin must be translation or ai")
        if kind == "translation":
            require(source_id in self.inventory, f"Missing source unit for {identifier}")
            require(source_id not in self.used_sources, f"Source unit used twice: {source_id}")
            original = self.inventory[source_id]
            raw = original.get("html", "<p>" + escape(original.get("text", "")) + "</p>")
            source = Fragment(raw, remove_ids=True)
            require(math_fragments(source.html) == math_fragments(fragment.html), f"MathML changed in {identifier}")
            require(Counter(source.links) == Counter(fragment.links), f"Citation links changed in {identifier}")
            self.originals[identifier] = {"html": source.html, "source": original["location"], "chapter": self.chapter}
            self.search.append({"id": identifier, "chapter": self.chapter, "text": fragment.plain, "original": source.plain})
            self.used_sources.add(source_id)
        else:
            require(not source_id, f"AI block {identifier} cannot claim a source unit")
        self.record(identifier, fragment, kind)
        attributes = f'id="{identifier}" data-read-id="{identifier}"'
        if kind == "translation":
            attributes += f' data-trid="{identifier}"'
        return attributes, fragment.html

    def render_block(self, item):
        block_type = item.get("type", "paragraph")
        require(block_type in {"paragraph", "html", "table", "figure", "callout"}, f"Unknown block type {block_type}")
        markup = item.get("html", escape(item.get("text", "")))
        attrs, content = self.translated(item, markup)
        if block_type == "paragraph":
            return f'<p class="ltx_p" {attrs}>{content}</p>'
        if block_type == "table":
            return f'<div class="table-scroll" tabindex="0" role="region" aria-label="표 · 가로로 스크롤할 수 있습니다" {attrs}>{content}</div>'
        if block_type == "figure":
            relative = Path(item["src"])
            require(not relative.is_absolute() and ".." not in relative.parts, "Media must be relative to the paper data")
            path = (self.media_root / relative).resolve()
            require(path.is_relative_to(self.media_root.resolve()) and path.is_file(), f"Missing media {relative}")
            target = "media/" + relative.name
            require(target not in self.media or self.media[target] == path, f"Duplicate media filename {relative.name}")
            self.media[target] = path
            return f'<figure><img src="{escape(target)}" alt="{escape(item["alt"], quote=True)}" loading="lazy"><figcaption {attrs}>{content}</figcaption></figure>'
        if block_type == "callout":
            return f'<aside class="source-callout"><p class="callout-title">{escape(item["title"])}</p><div class="callout-body" {attrs}>{content}</div></aside>'
        return f'<div {attrs}>{content}</div>'

    def render_section(self, section, depth=0):
        identifier = self.anchor(section["id"])
        require(identifier.startswith(self.chapter + "."), f"Section {identifier} must belong to {self.chapter}")
        require(depth <= 3, "Use at most four heading levels below a chapter")
        self.section = identifier
        title = section["title"]
        self.toc.append({"id": identifier, "title": title, "depth": depth})
        heading = f"<h{depth + 3}>{escape(title)}</h{depth + 3}>"
        if section.get("sourceId"):
            heading_item = {"id": identifier.replace(".", "-") + "-title", "sourceId": section["sourceId"], "text": title}
            attrs, title_html = self.translated(heading_item, escape(title))
            heading = f'<h{depth + 3} {attrs}>{title_html}</h{depth + 3}>'
        parts = [f'<section id="{identifier}">', heading]
        parts += [self.render_block(block) for block in section.get("blocks", [])]
        for child in section.get("sections", []):
            parts.append(self.render_section(child, depth + 1))
        self.section = identifier
        if section.get("recap"):
            recap_id = self.anchor("recap-" + identifier)
            text = section["recap"]
            self.record(recap_id, Fragment(escape(text)), "ai")
            parts.append(f'<aside class="section-recap"><div class="recap-label">잠깐 정리 · AI 보조 설명</div><p data-read-id="{recap_id}">{escape(text)}</p></aside>')
        parts.append("</section>")
        return "\n".join(parts)

    def chapter_html(self, chapter):
        self.chapter = self.section = self.anchor(chapter["id"])
        self.toc = []
        guide = chapter.get("guide")
        if guide:
            identifier = self.anchor("guide-" + self.chapter + "-intro")
            self.record(identifier, Fragment(escape(guide["intro"])), "ai")
        parts = [f'<section class="ltx_section" id="{self.chapter}"><h2>{escape(chapter["label"])}</h2>']
        if chapter.get("sourceId"):
            # Chapter titles are visible in the page header and available through source metadata.
            self.translated({"id": self.chapter + "-title", "sourceId": chapter["sourceId"]}, escape(chapter["label"]))
        parts += [self.render_block(block) for block in chapter.get("blocks", [])]
        parts += [self.render_section(section) for section in chapter.get("sections", [])]
        parts.append("</section>")
        self.section = self.chapter
        if guide:
            for index, text in enumerate(guide["takeaways"]):
                self.record(self.anchor(f"guide-{self.chapter}-takeaway-{index}"), Fragment(escape(text)), "ai")
            if guide.get("next"):
                self.record(self.anchor(f"guide-{self.chapter}-next"), Fragment(escape(guide["next"])), "ai")
        return "\n".join(parts), list(self.toc)


def validate_data(data):
    allowed = {"schemaVersion", "paper", "groups", "chapters", "abstract", "sourceInventory", "glossary", "references"}
    require(set(data) <= allowed, "Paper data contains unsupported top-level fields")
    require(data.get("schemaVersion") == 1, "Expected schemaVersion 1")
    for key in ["paper", "groups", "chapters", "sourceInventory", "glossary", "references"]:
        require(key in data, f"Missing {key}")
    paper = data["paper"]
    for key in ["id", "version", "title", "shortTitle", "subject", "authors", "date", "citation", "sourceUrl", "license", "cover"]:
        require(paper.get(key), f"Missing paper.{key}")
    require(re.fullmatch(r"[a-z0-9][a-z0-9-]*", paper["id"]), "Paper id must be a stable lowercase identifier")
    for key in ["title", "subtitle", "description", "question"]:
        require(paper["cover"].get(key), f"Missing paper.cover.{key}")
    for url in [paper["sourceUrl"], paper.get("pdfUrl", ""), paper["license"].get("url", "")]:
        # The desktop host resolves this source link to its already-open PDF.
        local_source = bool(re.fullmatch(r"paper://[a-f0-9]{64}/source\.pdf(?:#page=[1-9][0-9]*)?", url))
        require(not url or url.startswith(("https://", "http://")) or local_source, "Source and license URLs must use HTTPS, HTTP, or the desktop PDF source link")
    require(isinstance(paper["authors"], list) and all(isinstance(name, str) for name in paper["authors"]), "authors must be an array of names")
    require(data["groups"] and data["chapters"], "A paper needs chapter groups and chapters")
    chapters = data["chapters"]
    main = [chapter for chapter in chapters if chapter["kind"] == "main"]
    require(main, "At least one main chapter is required")
    for chapter in chapters:
        pattern = r"S[1-9]\d*" if chapter["kind"] == "main" else r"A[1-9]\d*"
        require(re.fullmatch(pattern, chapter["id"]), f"Chapter id does not match its kind: {chapter['id']}")
        require(chapter.get("label") and chapter.get("subtitle"), "Chapters need a label and subtitle")
        if chapter["kind"] == "main":
            guide = chapter.get("guide", {})
            require(guide.get("intro") and guide.get("takeaways"), f"Missing reading guide for {chapter['id']}")
    grouped = [identifier for group in data["groups"] for identifier in group["chapters"]]
    require(grouped == [chapter["id"] for chapter in main], "Groups must list every main chapter once, in reading order")


def verify_lock():
    lock = json.loads((ROOT / "template-lock.json").read_text())
    actual = {path.relative_to(ROOT).as_posix() for path in SITE.rglob("*") if path.is_file()}
    require(actual == set(lock["files"]), "Fixed template file list changed")
    for name, expected in lock["files"].items():
        require(digest(ROOT / name) == expected, f"Fixed template asset changed: {name}")
    return lock["version"]


def make_offline(output):
    files = {path.name: json.loads(path.read_text()) for path in output.glob("*.json") if not path.name.startswith(".")}
    files.update({"chapters/" + path.name: path.read_text() for path in (output / "chapters").glob("*.html")})
    css_names = ["fonts.css", "design-tokens.css", "styles.css", "reading-tools.css"]
    script_names = ["reading-core.js", "reading-tools.js", "reading-position.js", "app.js"]
    css = "\n".join((output / name).read_text() for name in css_names)
    scripts = "\n".join((output / name).read_text() for name in script_names)
    payload = json.dumps(files, ensure_ascii=False, separators=(",", ":"))
    for directory in ["fonts", "media"]:
        for path in sorted((output / directory).glob("*")):
            if path.suffix not in {".woff2", ".ttf", ".otf", ".png", ".jpg", ".jpeg", ".webp", ".svg"}:
                continue
            mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            uri = "data:" + mime + ";base64," + base64.b64encode(path.read_bytes()).decode()
            relative = directory + "/" + path.name
            payload = payload.replace(relative, uri)
            css = css.replace(relative, uri)
    index = (output / "index.html").read_text()
    for name in css_names:
        index = index.replace(f'<link rel="stylesheet" href="{name}">', "")
    for name in script_names:
        index = index.replace(f'<script src="{name}" defer></script>', "")
    payload = payload.replace("</", r"<\/").replace("\u2028", r"\u2028").replace("\u2029", r"\u2029")
    scripts = scripts.replace("</script", r"<\/script")
    index = index.replace("</head>", "<style>" + css + "</style></head>")
    index = index.replace("</body>", "<script>window.PAPER_OFFLINE=" + payload + ";</script><script>" + scripts + "</script></body>")
    (output / "read-offline.html").write_text(index)


def build(input_path, output, node):
    data = json.loads(input_path.read_text())
    validate_data(data)
    version = verify_lock()
    if output.exists():
        require((output / ".paper-reader-build.json").exists(), "Output exists and is not a generated paper reader")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".paper-reader-", dir=output.parent))
    try:
        shutil.copytree(SITE, temporary, dirs_exist_ok=True)
        (temporary / "chapters").mkdir()
        (temporary / "media").mkdir()
        builder = PaperBuilder(data, input_path.parent)
        builder.chapter = builder.section = "abstract1"
        abstract = "\n".join(builder.render_block(block) for block in data.get("abstract", []))
        (temporary / "chapters/abstract1.html").write_text(abstract)
        chapters = []
        for chapter in data["chapters"]:
            content, toc = builder.chapter_html(chapter)
            (temporary / "chapters" / (chapter["id"] + ".html")).write_text(content)
            metadata = {key: chapter[key] for key in ["id", "kind", "label", "subtitle", "guide", "sourceId"] if key in chapter}
            chapters.append({**metadata, "toc": toc, "companions": chapter.get("companions", [])})
        missing = set(builder.inventory) - builder.used_sources
        require(not missing, "Untranslated source units: " + ", ".join(sorted(missing)))
        references = {}
        for reference in data["references"]:
            identifier = builder.anchor(reference["id"])
            require(identifier.startswith("bib."), "Reference ids must start with bib.")
            content = Fragment(reference.get("html", escape(reference.get("text", ""))))
            references[identifier] = f'<li id="{identifier}">{content.html}</li>'
        for href in builder.links:
            if href.startswith("#"):
                require(href[1:] in builder.anchors, f"Broken internal link {href}")
        for entry in data["glossary"]:
            require(entry["target"] in builder.anchors, f"Unknown glossary target {entry['target']}")
        for chapter in chapters:
            for target in chapter["companions"]:
                require(target in builder.anchors, f"Unknown companion target {target}")
        paper = data["paper"]
        resources = [{"id": "glossary", "label": "개념 풀이 노트", "description": "주요 개념의 의미와 연결"}]
        resources += [{"id": item["id"], "label": item["label"], "description": item["subtitle"]} for item in chapters if item["kind"] == "appendix"]
        book = {**paper, "version": paper["id"] + "@" + paper["version"], "source": paper["sourceUrl"],
                "pdf": paper.get("pdfUrl", ""), "editionLabel": paper["version"], "groups": data["groups"],
                "chapters": chapters, "glossary": data["glossary"], "resources": resources,
                "coverageDescription": f"원문 {len(builder.inventory)}개 단위를 번역문과 연결했습니다."}
        write_json(temporary / "book.json", book)
        write_json(temporary / "originals.json", builder.originals)
        write_json(temporary / "search.json", builder.search)
        write_json(temporary / "references.json", references)
        write_json(temporary / "reading-index.json", {item["id"]: {key: value for key, value in item.items() if key != "text"} for item in builder.blocks})
        code = "const fs=require('fs');const core=require(process.argv[1]);process.stdout.write(JSON.stringify(core.collectTerms(JSON.parse(fs.readFileSync(0,'utf8')))))"
        result = subprocess.run([node, "-e", code, str(SITE / "reading-core.js")], input=json.dumps(builder.blocks, ensure_ascii=False), text=True, capture_output=True, check=True)
        write_json(temporary / "terminology.json", json.loads(result.stdout))
        for target, source in builder.media.items():
            shutil.copyfile(source, temporary / target)
        proof = {"templateVersion": version, "paperId": paper["id"], "sourceUnits": len(builder.inventory),
                 "translatedUnits": len(builder.used_sources), "readingBlocks": len(builder.blocks),
                 "mainChapters": sum(item["kind"] == "main" for item in chapters), "missing": [],
                 "inputSha256": digest(input_path)}
        write_json(temporary / "build-report.json", proof)
        make_offline(temporary)
        write_json(temporary / ".paper-reader-build.json", {"paperId": paper["id"], "templateVersion": version})
        if output.exists():
            shutil.rmtree(output)
        temporary.replace(output)
        print(json.dumps({"output": str(output), **proof}, ensure_ascii=False))
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--node", default=shutil.which("node"))
    args = parser.parse_args()
    require(args.node, "Pass --node with the Node.js executable")
    build(args.input.resolve(), args.output.resolve(), args.node)
