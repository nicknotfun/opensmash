"""Optional emblem moderation must not prevent packaging a completed fighter."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pipeline import emblem_stencil, run_character as runner


class EmblemFallbackTests(unittest.TestCase):
    def test_moderation_fallback_packs_a_hollow_emblem(self):
        for stage in ('input', 'output', None):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as tmp:
                art = Path(tmp) / 'emblem_raw.png'
                error = RuntimeError(str(dict(code='moderation_blocked', moderation_stage=stage)))
                with patch.object(runner, 'sh', side_effect=error) as request:
                    runner.generate_emblem_image('A custom emblem', str(art))
                self.assertEqual(request.call_count, 1)
                mask, silhouette = emblem_stencil.stencil(str(art))
                self.assertFalse(emblem_stencil.score(mask, silhouette)['blobby'])
                self.assertFalse(runner.stage_needed(str(art), set(), 'emblem'))
                portrait = Path(tmp) / 'portrait.png'
                Image.new('RGB', (48, 43), 'gray').save(portrait)
                bundle = Path(tmp) / 'fighter.osbui'
                subprocess.run([
                    sys.executable, runner.pipeline_script('gen_ui_assets.py'), str(bundle),
                    '--art', str(portrait), '--name', 'TEST', '--emblem', str(art),
                ], check=True, capture_output=True, text=True)
                data = bundle.read_bytes()
                self.assertEqual(data[:4], b'OSBV')
                coverage = data[-48 * 48:]
                self.assertGreater(sum(v >= 128 for v in coverage), 100)
                self.assertLess(coverage[24 * 48 + 24], 128)

    def test_unrelated_provider_failure_still_surfaces(self):
        with tempfile.TemporaryDirectory() as tmp:
            art = Path(tmp) / 'emblem_raw.png'
            with patch.object(runner, 'sh', side_effect=RuntimeError('HTTP 503')):
                with self.assertRaisesRegex(RuntimeError, 'HTTP 503'):
                    runner.generate_emblem_image('A custom emblem', str(art))
            self.assertFalse(art.exists())

    def test_success_keeps_provider_art_and_cost(self):
        with tempfile.TemporaryDirectory() as tmp:
            art = Path(tmp) / 'emblem_raw.png'
            art.write_bytes(b'provider artwork')
            with patch.object(runner, 'sh', return_value='{"cost_usd": 0.04}'), \
                    patch.object(runner, 'bill') as bill:
                runner.generate_emblem_image('A custom emblem', str(art))
            self.assertEqual(art.read_bytes(), b'provider artwork')
            bill.assert_called_once_with('emblem', 0.04)


if __name__ == '__main__':
    unittest.main()
