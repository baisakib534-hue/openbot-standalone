"""The provider facts every Bot shares, read from `model-providers.json`.

The file beside this loader is the contract every language in the box reads: TypeScript reads it
through `shared/model-providers.ts`, this module reads it for the Python Bots, and any other
language reads it straight as JSON. A developer adding a Bot in Java adds one `bots` entry to the
file and never reads either loader.

ENVIRONMENT BEATS FILE, exactly as `docs/configuration.md` has always described: `BOT_PROVIDER`
and `BOT_MODEL` win, and the file supplies what they leave unset. API keys never appear in the
file — they arrive in the environment under the `key_variable` the provider row names.

A wrong or missing file stops the process at import with the path of the offending key, rather
than at the first model call: the mistakes this guards against are made in this repository, by a
hand editing the JSON, and the person who made it should meet it at startup.

The lookup here mirrors `botSettings` in `shared/model-providers.ts` line for line — same order,
same blank-is-unset reading, same refusal for a Bot with no row — because the two loaders answering
differently would put the languages of one box on different models, which is the drift this file
exists to end.

`PROVIDER_IDS` below is this module's copy of the list `shared/model-providers.ts` keeps for
itself, and each loader checks the file against its own list in both directions at import: a row
this module has never heard of, or a provider this module names that the file has no row for,
stops these Bots at startup rather than at their first model call. Adding a provider is one row in
the JSON file and one entry in each loader.

CUSTOM PROVIDERS ARE DATA TOO, exactly as in the TypeScript loader: a deployment may register
extra OpenAI-compatible providers through an overlay — `CUSTOM_PROVIDERS_JSON` (an inline JSON
object) and/or a `providers.local.json` file beside the spec file (its path may be named by
`CUSTOM_PROVIDERS_PATH`) — without editing this module or the spec file. Each overlay row names
its endpoint directly (`base_url`), the `key_variable` its key arrives in, a `default_model`,
and an `api` style (only `"chat"` for now). Overlay rows are validated with the same strictness
as the base file and may not reuse a built-in id; overlay `bots` entries may name overlay
providers. With no overlay configured the registry is exactly the three built-in rows.
"""

from __future__ import annotations

import json
import os
import re
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

_WHERE = "shared/model_providers.py"

# The providers this deployment knows the names of. The same list `shared/model-providers.ts`
# keeps for itself, written out here rather than read from the file: each loader checking the file
# against its own list is what makes a provider added to the JSON alone stop these Bots too, where
# before this list existed only the TypeScript Bots were stopped by it. Adding a provider is one
# entry here, one in that module, and one row to the JSON file.
PROVIDER_IDS: tuple[str, ...] = ("openai", "anthropic", "google")

_CUSTOM_PROVIDER_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]*$")
_ENV_VARIABLE_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
# Names an overlay id may not take: object-prototype members the TypeScript registry refuses.
_RESERVED_PROVIDER_IDS = frozenset(
    {"constructor", "prototype", "tostring", "valueof", "hasownproperty"}
)


def _spec_path() -> Path:
    """Where the file sits: beside this loader, unless the environment points elsewhere."""
    override = (os.environ.get("BOT_SPEC_PATH") or "").strip()
    if override:
        return Path(override)
    return Path(__file__).resolve().with_name("model-providers.json")


def _require_text(row: Any, field: str, where: str) -> str:
    value = row.get(field) if isinstance(row, dict) else None
    if not isinstance(value, str) or not value.strip():
        raise RuntimeError(f"shared/model-providers.json: {where} must be a non-empty string.")
    return value


def _overlay_fail(source: str, problem: str) -> RuntimeError:
    return RuntimeError(f"{source}: {problem}")


def _custom_provider_from_row(source: str, provider_id: str, row: Any) -> dict[str, str]:
    """One overlay row, checked with the same strictness the TypeScript loader applies."""
    if not _CUSTOM_PROVIDER_ID_PATTERN.match(provider_id) or provider_id in _RESERVED_PROVIDER_IDS:
        raise _overlay_fail(
            source,
            f"providers.{provider_id} is not a usable provider id "
            "(lowercase letters, digits and hyphens).",
        )
    if provider_id in PROVIDER_IDS:
        raise _overlay_fail(
            source,
            f"providers.{provider_id} redefines a built-in provider; pick a different id.",
        )
    if not isinstance(row, dict):
        raise _overlay_fail(source, f"providers.{provider_id} must be an object.")

    def text(field: str) -> str:
        value = row.get(field)
        if not isinstance(value, str) or not value.strip():
            raise _overlay_fail(
                source, f"providers.{provider_id}.{field} must be a non-empty string."
            )
        return value

    base_url = text("base_url")
    parsed_url = urllib.parse.urlparse(base_url)
    if parsed_url.scheme not in ("http", "https") or not parsed_url.netloc:
        raise _overlay_fail(
            source, f"providers.{provider_id}.base_url must be an http(s) URL."
        )
    key_variable = text("key_variable")
    if not _ENV_VARIABLE_PATTERN.match(key_variable):
        raise _overlay_fail(
            source,
            f"providers.{provider_id}.key_variable is not an environment variable name: "
            f"{key_variable}",
        )
    if row.get("base_url_variable") is None:
        derived = provider_id.upper().replace("-", "_") + "_BASE_URL"
        # An id that leads with a digit (`9router`) derives a name no shell would accept.
        base_url_variable = f"PROVIDER_{derived}" if derived[0].isdigit() else derived
    else:
        base_url_variable = text("base_url_variable")
    if not _ENV_VARIABLE_PATTERN.match(base_url_variable):
        raise _overlay_fail(
            source,
            f"providers.{provider_id}.base_url_variable is not an environment variable name: "
            f"{base_url_variable}",
        )
    api = row.get("api", "chat")
    if api != "chat":
        raise _overlay_fail(
            source,
            f'providers.{provider_id}.api must be "chat" (OpenAI-compatible chat completions); '
            "other styles are not supported for custom providers.",
        )
    return {
        "label": text("label"),
        "base_url": base_url,
        "key_variable": key_variable,
        "base_url_variable": base_url_variable,
        "default_model": text("default_model"),
        "api": api,
    }


def _parse_overlay(source: str, parsed: Any) -> tuple[dict[str, dict[str, str]], dict[str, Any]]:
    """One overlay source (text already JSON-parsed), validated row by row."""
    if not isinstance(parsed, dict):
        raise _overlay_fail(source, "must hold a JSON object.")
    providers: dict[str, dict[str, str]] = {}
    raw_providers = parsed.get("providers") or {}
    if not isinstance(raw_providers, dict):
        raise _overlay_fail(source, "providers must be an object.")
    for provider_id, row in raw_providers.items():
        providers[provider_id] = _custom_provider_from_row(source, provider_id, row)
    bots: dict[str, Any] = {}
    raw_bots = parsed.get("bots") or {}
    if not isinstance(raw_bots, dict):
        raise _overlay_fail(source, "bots must be an object.")
    for bot_id, entry in raw_bots.items():
        if not isinstance(entry, dict):
            raise _overlay_fail(source, f"bots.{bot_id} must be an object.")
        bots[bot_id] = entry
    return providers, bots


def _load_overlay() -> tuple[dict[str, dict[str, str]], dict[str, Any]]:
    """The custom-provider overlay: file first, `CUSTOM_PROVIDERS_JSON` over it.

    A file that exists but does not parse stops startup like a bad base row; a file that does
    not exist is simply no overlay, because the file is how a deployment opts in.
    """
    providers: dict[str, dict[str, str]] = {}
    bots: dict[str, Any] = {}

    named_path = (os.environ.get("CUSTOM_PROVIDERS_PATH") or "").strip()
    file_path = Path(named_path) if named_path else _spec_path().with_name("providers.local.json")
    if file_path.is_file():
        try:
            parsed = json.loads(file_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            raise _overlay_fail(str(file_path), f"is not valid JSON: {error}") from error
        file_providers, file_bots = _parse_overlay(str(file_path), parsed)
        providers.update(file_providers)
        bots.update(file_bots)

    inline = (os.environ.get("CUSTOM_PROVIDERS_JSON") or "").strip()
    if inline:
        try:
            parsed_inline = json.loads(inline)
        except json.JSONDecodeError as error:
            raise _overlay_fail("CUSTOM_PROVIDERS_JSON", f"is not valid JSON: {error}") from error
        env_providers, env_bots = _parse_overlay("CUSTOM_PROVIDERS_JSON", parsed_inline)
        providers.update(env_providers)
        bots.update(env_bots)

    return providers, bots


def _load() -> tuple[dict[str, Any], tuple[str, ...]]:
    path = _spec_path()
    if not path.is_file():
        raise FileNotFoundError(
            f"shared/model-providers.json not found at {path}. The file sits beside this loader "
            "in shared/, or is named by BOT_SPEC_PATH; a Bot without it has no defaults to run."
        )
    try:
        spec = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise RuntimeError(f"shared/model-providers.json at {path} is not JSON: {error}") from error
    if not isinstance(spec, dict):
        raise RuntimeError(f"shared/model-providers.json at {path} must hold an object.")

    providers = spec.get("providers")
    if not isinstance(providers, dict):
        raise RuntimeError("shared/model-providers.json: providers must be an object.")
    # The list's order rather than the file's, so the row an error names first is the row the list
    # named first — the same read the TypeScript loader makes.
    for provider_id in PROVIDER_IDS:
        row = providers.get(provider_id)
        if row is None:
            raise RuntimeError(
                f"shared/model-providers.json: providers is missing its {provider_id} row."
            )
        _require_text(row, "label", f"providers.{provider_id}.label")
        _require_text(row, "key_variable", f"providers.{provider_id}.key_variable")
        _require_text(row, "base_url_variable", f"providers.{provider_id}.base_url_variable")
        _require_text(row, "default_model", f"providers.{provider_id}.default_model")
    for provider_id in providers:
        if provider_id not in PROVIDER_IDS:
            raise RuntimeError(
                f"shared/model-providers.json: providers has a {provider_id} row this module "
                "has never heard of."
            )

    # The custom-provider overlay joins the registry here, after the base rows were checked
    # against PROVIDER_IDS alone: a custom provider belongs to the overlay sources, never
    # smuggled into the contract file. Its `bots` entries merge over the base file's.
    overlay_providers, overlay_bots = _load_overlay()
    providers.update(overlay_providers)
    all_provider_ids = tuple(providers.keys())

    bots = spec.get("bots")
    if not isinstance(bots, dict):
        raise RuntimeError("shared/model-providers.json: bots must be an object.")
    merged_bots = {**bots, **overlay_bots}
    for bot_id, entry in merged_bots.items():
        if not isinstance(entry, dict):
            raise RuntimeError(f"shared/model-providers.json: bots.{bot_id} must be an object.")
        provider = _require_text(entry, "provider", f"bots.{bot_id}.provider")
        if provider not in all_provider_ids:
            raise RuntimeError(
                f"shared/model-providers.json: bots.{bot_id}.provider is {json.dumps(provider)}, "
                f"not one of {', '.join(all_provider_ids)}."
            )
        _require_text(entry, "model", f"bots.{bot_id}.model")
    spec["bots"] = merged_bots

    return spec, tuple(overlay_providers.keys())


SPEC, CUSTOM_PROVIDER_IDS = _load()

# The custom provider ids this process loaded from the overlay (empty when none is configured)
# are in CUSTOM_PROVIDER_IDS (assigned by the unpacking above).
# Every provider id the registry answers for: the built-ins, then the custom overlay's.
ALL_PROVIDER_IDS: tuple[str, ...] = PROVIDER_IDS + CUSTOM_PROVIDER_IDS


def provider_row(provider_id: str) -> dict[str, Any] | None:
    """The merged registry row for one provider, or None for a name nobody has heard of."""
    row = SPEC["providers"].get(provider_id)
    return row if isinstance(row, dict) else None


@dataclass(frozen=True)
class BotSettings:
    """What one Bot was decided to run: its provider, and the model on it."""

    provider: str
    model: str


def default_model_for(provider: str) -> str:
    """A provider's default row, or OpenAI's for a name nobody has heard of."""
    row = SPEC["providers"].get(provider)
    if row is None:
        row = SPEC["providers"]["openai"]
    return row["default_model"]


def bot_settings(
    bot_id: str,
    env: Mapping[str, str] | None = None,
    pinned_provider: str | None = None,
) -> BotSettings:
    """This Bot's provider and model: environment over spec file over provider default.

    The lookup order is the whole contract, and it is the order `docs/configuration.md` already
    documents for `BOT_PROVIDER` and `BOT_MODEL` — the environment is how a deployment overrides
    what the repository decided, so it wins. What is new is the middle: the `bots` row this Bot
    had before, written down in one file every language reads instead of repeated in each Bot's
    source. A blank value is not a choice: compose hands `BOT_MODEL=` an empty string when nobody
    picked a model, and empty falls through to the file.

    A provider nobody has heard of is kept as typed, not rewritten to OpenAI, so the Bot's own
    refusal can put the name in its message. Its model falls back to the OpenAI default for the
    same reason the TypeScript loader does it: the refusal belongs to the Bot, one line below.

    A missing `bots` row throws rather than defaults. The file is in this repository; a Bot wired
    to it without a row is a mistake made while editing it, made at development time.
    """
    environ = os.environ if env is None else env

    entry = SPEC["bots"].get(bot_id)
    if entry is None:
        raise RuntimeError(
            f"shared/model-providers.json: bots has no {bot_id} entry. "
            "Add one before this Bot reads the spec file."
        )

    provider = (
        (pinned_provider or "").strip()
        or (environ.get("BOT_PROVIDER") or "").strip().lower()
        or entry["provider"]
    )

    # A model the environment names goes to whatever provider was resolved, because an endpoint
    # names its own catalogue. The file's model belongs to the file's provider, so a deployment
    # that moved this Bot to another provider gets that provider's default instead of a model
    # paired with the one it left.
    model = (environ.get("BOT_MODEL") or "").strip()
    if not model:
        model = (
            entry["model"] if provider == entry["provider"] else default_model_for(provider)
        )

    return BotSettings(provider=provider, model=model)
