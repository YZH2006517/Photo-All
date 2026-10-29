"""Source-size and comparison contracts at the editor/renderer boundary."""
from pathlib import Path
import sys,tempfile,unittest
import numpy as np
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'product'))
import engine,pixels

class EditorIntegrationTests(unittest.TestCase):
    def test_display_size_is_measured_after_crop_not_before_it(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'validation') as folder:
            path=Path(folder)/'source.tif';data=np.zeros((800,1600,3),np.float32);data[...,0]=np.linspace(0,1,1600);pixels.write(path,data,'tiff16')
            result=engine.render_pixels(path,{'crop_x':.25,'crop_y':.25,'crop_w':.5,'crop_h':.5},(400,400))
            self.assertEqual(result.shape,(200,400,3))
            # Both sides of the requested crop still cover the original range.
            self.assertAlmostEqual(float(result[100,0,0]),.25,delta=.003)
            self.assertAlmostEqual(float(result[100,-1,0]),.75,delta=.003)

if __name__=='__main__':unittest.main()
