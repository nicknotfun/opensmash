import importlib.util
from pathlib import Path
import tempfile
import unittest
from PIL import Image

SCRIPT = Path(__file__).resolve().parents[1] / 'web-prototype/server/normalize-image.py'
spec = importlib.util.spec_from_file_location('normalize_image', SCRIPT)
normalizer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(normalizer)

class NormalizeImageTests(unittest.TestCase):
    def test_palette_transparency_composites_on_white(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, output = Path(tmp)/'source.png', Path(tmp)/'output.png'
            im = Image.new('P', (3, 1))
            im.putpalette([71,112,76, 0,0,0, 255,0,0] + [0]*759)
            im.putdata([0,1,2])
            im.save(source, transparency=bytes([0,255,128]))
            normalizer.normalize(source, output)
            with Image.open(output) as result:
                self.assertEqual(result.mode, 'RGB')
                self.assertEqual(result.getpixel((0,0)), (255,255,255))
                self.assertEqual(result.getpixel((1,0)), (0,0,0))
                self.assertEqual(result.getpixel((2,0)), (255,127,127))

    def test_rgba_and_opaque_rgb(self):
        with tempfile.TemporaryDirectory() as tmp:
            for mode, color, expected in [('RGBA',(0,0,0,0),(255,255,255)), ('RGB',(71,112,76),(71,112,76))]:
                with self.subTest(mode=mode):
                    source, output = Path(tmp)/'source.png', Path(tmp)/'output.png'
                    Image.new(mode,(3,3),color).save(source)
                    normalizer.normalize(source,output)
                    with Image.open(output) as result:
                        self.assertEqual(result.getpixel((0,0)),expected)
