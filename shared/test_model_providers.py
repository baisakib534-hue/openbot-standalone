"""Tests for the custom-provider overlay in `model_providers.py`.

The loader reads its environment once, at import, so every case runs in a child process — the
same shape `agent-langgraph-agui/tests/test_spec_validation.py` uses for the base file. Run
with: `python3 -m unittest shared.test_model_providers` from the repository root, or
`python3 -m unittest test_model_providers` from inside `shared/`.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SHARED_DIR = Path(__file__).resolve().parent

EXAMPLE_OVERLAY = {
    "providers": {
        "9router": {
            "label": "9router",
            "base_url": "https://ninerouter-vzw3.onrender.com/v1",
            "key_variable": "NINEROUTER_API_KEY",
            "default_model": "auto:default",
        }
    },
    "bots": {"agent-langgraph": {"provider": "9router", "model": "auto:default"}},
}

PROBE = """
import json
import model_providers as m

row = m.provider_row("9router")
print(json.dumps({
    "custom": list(m.CUSTOM_PROVIDER_IDS),
    "all": list(m.ALL_PROVIDER_IDS),
    "row": row,
    "bot": vars(m.bot_settings("agent-langgraph", {})),
    "default": m.default_model_for("9router"),
}))
"""


def run_probe(extra_env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("CUSTOM_PROVIDERS")}
    env.pop("BOT_SPEC_PATH", None)
    env.update(extra_env)
    return subprocess.run(
        [sys.executable, "-c", PROBE],
        cwd=SHARED_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )


class OverlayLoading(unittest.TestCase):
    def test_no_overlay_means_exactly_the_built_ins(self) -> None:
        run = run_probe({})
        self.assertEqual(run.returncode, 0, run.stderr)
        out = json.loads(run.stdout)
        self.assertEqual(out["custom"], [])
        self.assertEqual(out["all"], ["openai", "anthropic", "google"])
        self.assertIsNone(out["row"])

    def test_env_overlay_registers_the_provider(self) -> None:
        run = run_probe({"CUSTOM_PROVIDERS_JSON": json.dumps(EXAMPLE_OVERLAY)})
        self.assertEqual(run.returncode, 0, run.stderr)
        out = json.loads(run.stdout)
        self.assertEqual(out["custom"], ["9router"])
        self.assertEqual(out["row"]["base_url"], "https://ninerouter-vzw3.onrender.com/v1")
        self.assertEqual(out["row"]["key_variable"], "NINEROUTER_API_KEY")
        # The id leads with a digit, so the derived endpoint variable is prefixed.
        self.assertEqual(out["row"]["base_url_variable"], "PROVIDER_9ROUTER_BASE_URL")
        self.assertEqual(out["row"]["api"], "chat")
        self.assertEqual(out["bot"], {"provider": "9router", "model": "auto:default"})
        self.assertEqual(out["default"], "auto:default")

    def test_flat_env_overlay_registers_the_provider(self) -> None:
        # No "providers" wrapper: rows at the top level, the shape a hosting dashboard's
        # env var naturally holds. Mirrors parseCustomProvidersOverlay in the TS loader.
        flat = {
            "9router": EXAMPLE_OVERLAY["providers"]["9router"],
            "bots": EXAMPLE_OVERLAY["bots"],
        }
        run = run_probe({"CUSTOM_PROVIDERS_JSON": json.dumps(flat)})
        self.assertEqual(run.returncode, 0, run.stderr)
        out = json.loads(run.stdout)
        self.assertEqual(out["custom"], ["9router"])
        self.assertEqual(out["row"]["base_url"], "https://ninerouter-vzw3.onrender.com/v1")
        self.assertEqual(out["bot"], {"provider": "9router", "model": "auto:default"})

    def test_file_overlay_registers_the_provider(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            shutil.copy(SHARED_DIR / "model-providers.json", tmp_path / "model-providers.json")
            (tmp_path / "providers.local.json").write_text(
                json.dumps(EXAMPLE_OVERLAY), encoding="utf-8"
            )
            run = run_probe({"BOT_SPEC_PATH": str(tmp_path / "model-providers.json")})
            self.assertEqual(run.returncode, 0, run.stderr)
            out = json.loads(run.stdout)
            self.assertEqual(out["custom"], ["9router"])
            self.assertEqual(out["bot"]["provider"], "9router")


class BadOverlayRows(unittest.TestCase):
    def assert_overlay_refused(self, overlay: object, needle: str) -> None:
        run = run_probe({"CUSTOM_PROVIDERS_JSON": json.dumps(overlay)})
        self.assertNotEqual(run.returncode, 0, run.stdout)
        self.assertIn(needle, run.stderr)

    def test_missing_default_model_fails_naming_the_field(self) -> None:
        overlay = {
            "providers": {
                "broken": {
                    "label": "Broken",
                    "base_url": "https://router.example/v1",
                    "key_variable": "BROKEN_API_KEY",
                }
            }
        }
        self.assert_overlay_refused(overlay, "providers.broken.default_model")

    def test_redefining_a_built_in_fails(self) -> None:
        overlay = {
            "providers": {
                "openai": {
                    "label": "Fake",
                    "base_url": "https://router.example/v1",
                    "key_variable": "FAKE_API_KEY",
                    "default_model": "m",
                }
            }
        }
        self.assert_overlay_refused(overlay, "providers.openai redefines a built-in provider")

    def test_non_chat_api_fails(self) -> None:
        overlay = {
            "providers": {
                "broken": {
                    "label": "Broken",
                    "base_url": "https://router.example/v1",
                    "key_variable": "BROKEN_API_KEY",
                    "default_model": "m",
                    "api": "responses",
                }
            }
        }
        self.assert_overlay_refused(overlay, 'providers.broken.api must be "chat"')

    def test_invalid_json_fails_naming_the_source(self) -> None:
        run = run_probe({"CUSTOM_PROVIDERS_JSON": "{nope"})
        self.assertNotEqual(run.returncode, 0, run.stdout)
        self.assertIn("CUSTOM_PROVIDERS_JSON: is not valid JSON", run.stderr)


if __name__ == "__main__":
    unittest.main()
