"""Collect official benchmark scores. Model-written scores are never accepted.

Only fresh observations from this run participate. A failed source remains null
for every model; fewer than two successful sources or ten cross-source model
identities abort publication. News research is deliberately outside this module.
"""
from __future__ import annotations

import ast
import csv
import datetime as dt
from decimal import Decimal, ROUND_HALF_UP
from html.parser import HTMLParser
import io
import json
import math
import re
import unicodedata
import urllib.error
import urllib.parse
import urllib.request


AA_URL = "https://artificialanalysis.ai/leaderboards/models"
LB_URL = "https://livebench.ai/"
ARENA_URL = "https://arena.ai/leaderboard/chat/text"
SOURCE_IDS = ("artificial-analysis", "livebench", "arena")
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
MIN_SHARED_MODELS = 10


class SourceParseError(ValueError):
    """An upstream response no longer matches the supported public structure."""


class CollectionError(RuntimeError):
    def __init__(self, code, source_errors=None):
        super().__init__(code)
        self.source_errors = dict(source_errors or {})


def fetch_text(url):
    parsed = urllib.parse.urlsplit(url)
    allowed = {"artificialanalysis.ai", "livebench.ai", "arena.ai"}
    if parsed.scheme != "https" or parsed.hostname not in allowed or parsed.username or parsed.password or parsed.port:
        raise ValueError("unapproved_benchmark_url")
    request = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (compatible; LoliCode-Rankings/1.0)",
        "Accept": "text/html,application/json,text/csv,application/javascript",
    })
    with urllib.request.urlopen(request, timeout=35) as response:
        final = urllib.parse.urlsplit(response.geturl())
        if final.scheme != "https" or final.hostname not in allowed:
            raise ValueError("unexpected_benchmark_redirect")
        data = response.read(MAX_RESPONSE_BYTES + 1)
        if len(data) > MAX_RESPONSE_BYTES:
            raise ValueError("benchmark_response_too_large")
        return data.decode("utf-8-sig")


class _Document(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.scripts = []
        self.script_sources = []
        self._script = None
        self.tables = []
        self._table = None
        self._row = None
        self._cell = None
        self._link = None
        self._table_depth = 0
        self.text_parts = []
        self.dates = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "script":
            self._script = []
            if attrs.get("src"):
                self.script_sources.append(attrs["src"])
        if tag == "time" and attrs.get("datetime"):
            self.dates.append(attrs["datetime"])
        if tag == "table":
            self._table_depth += 1
            if self._table_depth == 1:
                self._table = []
        if self._table_depth == 1 and tag == "tr":
            self._row = {"cells": [], "attrs": attrs}
        if self._row is not None and tag in ("td", "th"):
            self._cell = {"parts": [], "links": [], "header": tag == "th"}
        if self._cell is not None and tag == "a":
            self._link = []

    def handle_endtag(self, tag):
        if tag == "script" and self._script is not None:
            self.scripts.append("".join(self._script))
            self._script = None
        if tag == "a" and self._link is not None:
            if self._cell is not None:
                self._cell["links"].append(" ".join(self._link).strip())
            self._link = None
        if tag in ("td", "th") and self._cell is not None:
            if self._row is not None:
                self._row["cells"].append(self._cell)
            self._cell = None
        if tag == "tr" and self._row is not None:
            if self._table is not None:
                self._table.append(self._row)
            self._row = None
        if tag == "table":
            if self._table_depth == 1 and self._table is not None:
                self.tables.append(self._table)
                self._table = None
            self._table_depth = max(0, self._table_depth - 1)

    def handle_data(self, data):
        if self._script is not None:
            self._script.append(data)
            return
        value = " ".join(data.split())
        if value:
            self.text_parts.append(value)
            if self._cell is not None:
                self._cell["parts"].append(value)
            if self._link is not None:
                self._link.append(value)


def _document(raw):
    if not isinstance(raw, str) or len(raw.encode("utf-8")) > MAX_RESPONSE_BYTES:
        raise SourceParseError("invalid_document_size_or_type")
    parser = _Document()
    parser.feed(raw)
    return parser


def _walk(value):
    yield value
    if isinstance(value, dict):
        for child in value.values():
            yield from _walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk(child)


def _flight_values(document):
    decoder = json.JSONDecoder()
    for script in document.scripts:
        if script.lstrip().startswith(("{", "[")):
            try:
                yield json.loads(script)
            except (ValueError, TypeError):
                pass
        for match in re.finditer(r"self\.__next_f\.push\(", script):
            try:
                envelope, _ = decoder.raw_decode(script[match.end():])
            except (ValueError, TypeError):
                continue
            if not isinstance(envelope, list) or len(envelope) < 2 or not isinstance(envelope[1], str):
                continue
            for record in envelope[1].splitlines():
                if ":" not in record:
                    continue
                raw = record.split(":", 1)[1]
                if not raw.startswith(("{", "[")):
                    continue
                try:
                    yield json.loads(raw)
                except ValueError:
                    continue


def _score(value, maximum=100, minimum=0):
    if isinstance(value, bool):
        raise SourceParseError("boolean_score")
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise SourceParseError("invalid_score") from error
    if not math.isfinite(number) or not minimum <= number <= maximum:
        raise SourceParseError("out_of_range_score")
    return number


def _label(value, field):
    if not isinstance(value, str) or not value.strip() or len(value) > 200 or any(ord(c) < 32 for c in value):
        raise SourceParseError("invalid_" + field)
    return value.strip()


def parse_artificial_analysis(raw):
    document = _document(raw)
    candidates = []
    for value in _flight_values(document):
        for item in _walk(value):
            if isinstance(item, dict) and isinstance(item.get("initialModels"), list):
                candidates.extend(item["initialModels"])
    if not candidates:
        raise SourceParseError("aa_initial_models_missing")
    result = []
    seen = set()
    for item in candidates:
        if not isinstance(item, dict) or item.get("deprecated") or item.get("intelligenceIndex") is None:
            continue
        slug = _label(item.get("slug"), "aa_slug")
        if slug in seen:
            continue
        seen.add(slug)
        if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{0,99}", slug):
            raise SourceParseError("invalid_aa_slug")
        name = _label(item.get("name"), "aa_name")
        result.append({"name": name, "provider": _label(item.get("modelCreatorName"), "aa_provider"),
                       "score": _score(item["intelligenceIndex"]), "configuration": name,
                       "url": "https://artificialanalysis.ai/models/" + slug,
                       "raw_id": slug, "openWeights": bool(item.get("isOpenWeights", False))})
    if not result:
        raise SourceParseError("aa_no_current_scores")
    return result


def _js_string(metadata, key, required=False):
    pattern = r"(?:\b" + re.escape(key) + r"|[\"']" + re.escape(key) + r"[\"'])\s*:\s*(\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*')"
    match = re.search(pattern, metadata)
    if not match:
        if required:
            raise SourceParseError("lb_metadata_" + key + "_missing")
        return ""
    try:
        return json.loads(match[1]) if match[1].startswith('"') else ast.literal_eval(match[1])
    except (ValueError, SyntaxError) as error:
        raise SourceParseError("lb_invalid_metadata_string") from error


def _livebench_metadata(script, model_id):
    escaped = re.escape(model_id)
    pattern = r'(?:"' + escaped + r'"|\b' + escaped + r')\s*:\s*\{([^{}]*)\}'
    match = re.search(pattern, script)
    if not match:
        raise SourceParseError("lb_model_metadata_missing")
    metadata = match[1]
    return {"name": _js_string(metadata, "displayName", True),
            "provider": _js_string(metadata, "organization", True),
            "effort": _js_string(metadata, "effort"),
            "openWeights": bool(re.search(r"\bopenweight\s*:\s*(?:!0|true)\b", metadata))}


def parse_livebench(script, csv_text, categories):
    if isinstance(categories, str):
        try:
            categories = json.loads(categories)
        except ValueError as error:
            raise SourceParseError("lb_invalid_categories_json") from error
    if not isinstance(categories, dict):
        raise SourceParseError("lb_categories_missing")
    weights = categories.get("_overall_weights", {})
    suites = {key: value for key, value in categories.items() if key != "_overall_weights"}
    if not suites or not isinstance(weights, dict):
        raise SourceParseError("lb_categories_invalid")
    reader = csv.DictReader(io.StringIO(csv_text))
    if not reader.fieldnames or "model" not in reader.fieldnames:
        raise SourceParseError("lb_csv_model_column_missing")
    for columns in suites.values():
        if not isinstance(columns, list) or not columns or any(not isinstance(column, str) or column not in reader.fieldnames for column in columns):
            raise SourceParseError("lb_category_columns_changed")
    for weight in weights.values():
        if _score(weight, maximum=100) <= 0:
            raise SourceParseError("lb_invalid_weight")
    result = []
    seen = set()
    for row in reader:
        model_id = _label(row.get("model"), "lb_model_id")
        if model_id in seen:
            raise SourceParseError("lb_duplicate_model_id")
        seen.add(model_id)
        metadata = _livebench_metadata(script, model_id)
        total = 0
        divisor = 0
        for suite, columns in suites.items():
            observed = [_score(row.get(column)) for column in columns if row.get(column) not in (None, "", "-", "N/A")]
            if not observed:
                continue
            weight = float(weights.get(suite, 1))
            total += sum(observed) / len(observed) * weight
            divisor += weight
        if divisor == 0:
            continue
        overall = float(Decimal(str(total / divisor)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))
        name = _label(metadata["name"], "lb_name")
        result.append({**metadata, "raw_id": model_id, "score": overall,
                       "configuration": name + (" (" + metadata["effort"] + ")" if metadata["effort"] else "")})
    if not result:
        raise SourceParseError("lb_no_scores")
    return result


def collect_livebench(get, today):
    document = _document(get(LB_URL))
    mains = [urllib.parse.urljoin(LB_URL, path) for path in document.script_sources if re.search(r"(?:^|/)main\.[a-zA-Z0-9]+\.js$", path)]
    if len(mains) != 1 or urllib.parse.urlsplit(mains[0]).hostname != "livebench.ai":
        raise SourceParseError("lb_main_script_changed")
    script = get(mains[0])
    releases = []
    for match in re.finditer(r'\[\s*"\d{8}"(?:\s*,\s*"\d{8}")*\s*\]', script):
        releases.extend(json.loads(match[0]))
    dates = []
    for value in set(releases):
        try:
            date = dt.datetime.strptime(value, "%Y%m%d").date()
        except ValueError:
            continue
        if date <= today:
            dates.append(date)
    if not dates:
        raise SourceParseError("lb_release_dates_missing")
    latest = max(dates)
    base = "https://livebench.ai/data/" + latest.strftime("%Y%m%d")
    rows = parse_livebench(script, get(base + "/table.csv"), get(base + "/categories.json"))
    for row in rows:
        row["url"] = base + "/table.csv"
    return rows, latest.isoformat(), base + "/table.csv"


_PROVIDERS = {
    "openai": ("OpenAI", "openai"), "anthropic": ("Anthropic", "anthropic"),
    "google": ("Google", "gemini"), "googledeepmind": ("Google", "gemini"),
    "meta": ("Meta", "meta"), "deepseek": ("DeepSeek", "deepseek"),
    "spacexai": ("xAI", "xai"), "xai": ("xAI", "xai"),
    "moonshot": ("Moonshot AI", "kimi"), "moonshotai": ("Moonshot AI", "kimi"),
    "zai": ("Z.AI", "zhipu"), "zhipuai": ("Z.AI", "zhipu"),
    "alibaba": ("Alibaba", "qwen"), "qwen": ("Alibaba", "qwen"),
    "xiaomi": ("Xiaomi", "xiaomimimo"), "minimax": ("MiniMax", "minimax"),
    "stepfun": ("StepFun", "stepfun"), "nvidia": ("NVIDIA", "nvidia"),
    "mistral": ("Mistral AI", "mistral"), "mistralai": ("Mistral AI", "mistral"),
    "thinkingmachines": ("Thinking Machines", ""), "thinkingmachineslab": ("Thinking Machines", ""),
}


def _compact(value):
    return re.sub(r"[^a-z0-9]", "", unicodedata.normalize("NFKD", value).lower())


def _provider(value):
    return _PROVIDERS.get(_compact(value), (value.strip(), ""))


_EFFORT = re.compile(r"^(?:(?:non[- ]?)?reasoning|thinking|(?:x[- ]?)?high|max|medium|low|default fallback|with fallback|fallback|\d+k(?: think(?:ing)?)?)(?:\s*[,;/+]\s*(?:(?:non[- ]?)?reasoning|thinking|(?:x[- ]?)?high|max|medium|low|default fallback|with fallback|fallback|\d+k(?: think(?:ing)?)?))*$", re.I)


def model_name(name):
    """Remove effort descriptions only; version/date/Preview qualifiers survive."""
    value = name.strip()
    while True:
        match = re.search(r"\s*\(([^()]*)\)\s*$", value)
        if not match or not _EFFORT.fullmatch(match[1].strip()):
            return value
        value = value[:match.start()].strip()


def _identity(name, provider):
    # Hyphens/spaces are presentation, but decimal points in versions are not:
    # "Model 1.0" must never collide with "Model 10".
    versioned = re.sub(r"(?<=\d)\.(?=\d)", "~", model_name(name).lower())
    key = re.sub(r"[^a-z0-9~]", "", unicodedata.normalize("NFKD", versioned))
    return _compact(_provider(provider)[0]), key


def _cell_text(cell):
    return " ".join(cell["parts"])


def _arena_model(cell):
    parts = cell["parts"]
    if not parts:
        raise SourceParseError("arena_empty_model")
    links = [value for value in cell["links"] if re.search(r"[A-Za-z]", value)]
    name = links[0] if links else parts[0]
    if not links:
        for part in parts[1:]:
            if re.fullmatch(r"\([^()]+\)", part):
                name += " " + part
            else:
                break
    provider = None
    for part in parts[1:]:
        clean = re.split(r"\s*[·•]\s*", part)[0].strip()
        if _compact(clean) in _PROVIDERS:
            provider = _provider(clean)[0]
            break
    if provider is None:
        # A new lab is data, not a parser failure. Require an explicit visible
        # provider/license grouping rather than guessing the lab from a model.
        for part in parts[1:]:
            if re.search(r"[·•]", part):
                clean = re.split(r"\s*[·•]\s*", part)[0].strip()
                if clean and clean not in (name, "Proprietary", "Open Source", "Open Weights"):
                    provider = clean
                    break
    if provider is None:
        for index, part in enumerate(parts):
            if re.fullmatch(r"(?:proprietary|open[ -](?:source|weights))", part, re.I):
                before = [value for value in parts[1:index] if value not in ("·", "•") and not re.fullmatch(r"\([^()]+\)", value)]
                if before and before[-1] != name:
                    provider = before[-1]
                    break
    if provider is None:
        raise SourceParseError("arena_provider_structure_changed")
    return _label(name, "arena_name"), _label(provider, "arena_provider")


def parse_arena(raw):
    document = _document(raw)
    page_text = " ".join(document.text_parts)
    if not re.search(r"\bText\b", page_text, re.I) or not re.search(r"\bOverall\b", page_text, re.I):
        raise SourceParseError("arena_not_text_overall")
    result = []
    for table in document.tables:
        header = None
        for index, row in enumerate(table):
            names = [_cell_text(cell).lower().strip() for cell in row["cells"]]
            if "model" in names and ("score" in names or "arena score" in names) and "rank" in names:
                header = (index, names.index("model"), names.index("score") if "score" in names else names.index("arena score"))
                break
        if header is None:
            continue
        start, model_column, score_column = header
        for row in table[start + 1:]:
            cells = row["cells"]
            if len(cells) <= max(model_column, score_column):
                continue
            row_text = " ".join(_cell_text(cell) for cell in cells)
            if re.search(r"\bpreliminary\b", row_text, re.I) or row["attrs"].get("data-preliminary") == "true":
                continue
            name, provider = _arena_model(cells[model_column])
            score_match = re.match(r"\s*([0-9]+(?:\.[0-9]+)?)", _cell_text(cells[score_column]).replace(",", ""))
            if not score_match:
                raise SourceParseError("arena_score_structure_changed")
            result.append({"name": name, "provider": provider, "score": _score(score_match[1], maximum=5000, minimum=100),
                           "configuration": name, "url": ARENA_URL,
                           "openWeights": bool(re.search(r"open[ -]weights?|open[ -]source", row_text, re.I))})
        if result:
            break
    if not result:
        raise SourceParseError("arena_text_table_missing_or_changed")
    updated = None
    match = re.search(r"(?:last\s+updated|updated)\s*[:·—-]?\s*(\d{4}-\d{2}-\d{2})", page_text, re.I)
    if match:
        try:
            updated = dt.date.fromisoformat(match[1]).isoformat()
        except ValueError:
            pass
    return result, updated


def _today(value):
    if value is None:
        return dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).date()
    if isinstance(value, dt.datetime):
        return value.date()
    if isinstance(value, dt.date):
        return value
    return dt.date.fromisoformat(value)


def collect_rankings(fetch_text=None, today=None, on_source_error=None):
    """Return a fresh compatible snapshot, with only >=2-source identities.

    The optional callback receives (source_id, exception). Partial collection is
    acceptable only with two successful official sources and ten shared models.
    A callback should log safe exception classes, not arbitrary response bodies.
    """
    get = fetch_text or globals()["fetch_text"]
    date = _today(today)
    rows = {}
    errors = {}
    sources = [
        {"id": SOURCE_IDS[0], "name": "Artificial Analysis", "metric": "Intelligence Index", "url": AA_URL, "updatedAt": None},
        {"id": SOURCE_IDS[1], "name": "LiveBench 2.0", "metric": "Overall", "url": LB_URL, "updatedAt": None},
        {"id": SOURCE_IDS[2], "name": "Arena", "metric": "Text Overall", "url": ARENA_URL, "updatedAt": None},
    ]
    for source in sources:
        key = source["id"]
        try:
            if key == SOURCE_IDS[0]:
                rows[key] = parse_artificial_analysis(get(AA_URL))
            elif key == SOURCE_IDS[1]:
                values, updated, data_url = collect_livebench(get, date)
                rows[key] = values
                source["updatedAt"] = updated
                source["dataUrl"] = data_url
            else:
                values, updated = parse_arena(get(ARENA_URL))
                rows[key] = values
                source["updatedAt"] = updated
        except Exception as error:
            errors[key] = error
            if on_source_error is not None:
                on_source_error(key, error)
    if len(rows) < 2:
        raise CollectionError("fewer_than_two_fresh_sources", errors)
    groups = {}
    for source_id, observations in rows.items():
        for observation in observations:
            identity = _identity(observation["name"], observation["provider"])
            if not all(identity):
                raise SourceParseError("unusable_model_identity")
            source_best = groups.setdefault(identity, {})
            previous = source_best.get(source_id)
            if previous is None or observation["score"] > previous["score"]:
                source_best[source_id] = observation
    models = []
    seen_ids = set()
    for identity, observations in sorted(groups.items()):
        if len(observations) < 2:
            continue
        primary = observations.get("livebench") or observations.get("artificial-analysis") or observations["arena"]
        provider, icon = _provider(primary["provider"])
        name = model_name(primary["name"])
        model_id = primary.get("raw_id") or re.sub(r"[^a-z0-9.-]+", "-", name.lower()).strip("-")
        if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,99}", model_id) or model_id in seen_ids:
            raise SourceParseError("invalid_or_duplicate_output_model_id")
        seen_ids.add(model_id)
        measurements = {source_id: ({field: observations[source_id][field] for field in ("score", "configuration", "url")} if source_id in observations else None) for source_id in SOURCE_IDS}
        models.append({"id": model_id, "name": name, "provider": provider, "icon": icon,
                       "openWeights": primary.get("openWeights", False), "measurements": measurements})
    if len(models) < MIN_SHARED_MODELS:
        raise CollectionError("fewer_than_ten_cross_source_models", errors)
    return {"retrievedAt": date.isoformat(), "sources": sources, "models": models}
