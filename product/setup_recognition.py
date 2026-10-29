# SPDX-License-Identifier: GPL-3.0-or-later
"""One-time explicit model setup. No user photos are sent over the network."""
import hashlib
from pathlib import Path
import subprocess
import sys
import urllib.request

ROOT = Path(__file__).resolve().parent
REVISION = '6b7c523703ae26e39be4b03774966f8571c7f523'
ASSETS = {
    'onnx/vision_model_quantized.onnx': '583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299',
    'onnx/text_model_quantized.onnx': '73baab855d406190da9faa498cfedf65f15cf309f4cc7385b7b032e6d08e5c3a',
    'tokenizer.json': 'f7f3b7af117d467b58374797691a6438d3e6b9e9cef800dfd5dced7f697a90cd',
    'preprocessor_config.json': '6f638fb9401a6d6296feff533ee7efe657b787c49f954f82f5906b36ef2a1b1f',
    'README.md': 'ae287015b60eb7ca1d40e726c550af1988977c24f0005f123274d52490c20d8d',
}


def download(url, destination, expected):
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_file() and hashlib.sha256(destination.read_bytes()).hexdigest() == expected:
        return
    temporary = destination.with_name(destination.name + '.partial')
    try:
        with urllib.request.urlopen(url, timeout=90) as response, temporary.open('wb') as stream:
            while block := response.read(1024 * 1024):
                stream.write(block)
        if hashlib.sha256(temporary.read_bytes()).hexdigest() != expected:
            raise RuntimeError('SHA-256 verification failed: ' + destination.name)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    runtime = ROOT / 'engines' / 'recognition-runtime'
    subprocess.run([sys.executable, '-m', 'pip', 'install', '--target', str(runtime),
                    'onnxruntime==1.23.2', 'tokenizers==0.22.1'], check=True)
    model = ROOT / 'engines' / 'clip-vit-base-patch32'
    for name, checksum in ASSETS.items():
        print('Preparing', name, flush=True)
        download(f'https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/{REVISION}/{name}',
                 model / name, checksum)
    download('https://raw.githubusercontent.com/openai/CLIP/main/LICENSE', model / 'LICENSE',
             '987e63b32f6c89ff5160e429458a872ff048e6860b590a3912e938f9da8f14db')
    (model / 'revision.txt').write_text(REVISION, encoding='utf-8')
    print('Ready. Restart Photo All to enable offline content classification.')


if __name__ == '__main__':
    main()
