# SPDX-License-Identifier: GPL-3.0-or-later
"""Local visual indexing, CLIP content classification and non-destructive composition.

Feature extraction uses neutral source pixels. Composition uses saved recipe snapshots.
No component in this module sends photo pixels over the network.
"""
from __future__ import annotations

import json
import math
from pathlib import Path
import sys
import threading

import numpy as np
from PIL import Image

ROOT = Path(__file__).parent
MODEL = ROOT / 'engines' / 'clip-vit-base-patch32'
MODEL_REVISION = '6b7c523703ae26e39be4b03774966f8571c7f523'
RUNTIME = ROOT / 'engines' / 'recognition-runtime'
if RUNTIME.is_dir():
    sys.path.insert(0, str(RUNTIME))

COLORS = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink']
CONTENT = {
    'landscape': ('自然风光', 'a landscape photograph of mountains, forests or countryside'),
    'city': ('城市建筑', 'a photograph of a city skyline, buildings or architecture'),
    'portrait': ('人物肖像', 'a portrait photograph of a person or a group of people'),
    'animal': ('动物宠物', 'a photograph of an animal, pet, dog, cat or bird'),
    'plant': ('花卉植物', 'a close-up photograph of flowers, plants or leaves'),
    'food': ('美食饮品', 'a photograph of food, a meal, dessert or drinks'),
    'ocean': ('海洋湖泊', 'a photograph of an ocean, beach, lake or river'),
    'night': ('夜景星空', 'a photograph taken at night with stars, city lights or a dark sky'),
    'sunset': ('日出日落', 'a photograph of a sunset or sunrise with a glowing sky'),
    'interior': ('室内空间', 'a photograph of an indoor room, furniture or interior design'),
    'street': ('街头纪实', 'a street photography scene with pedestrians and urban life'),
    'vehicle': ('交通工具', 'a photograph of a car, motorcycle, bicycle, train or airplane'),
    'object': ('静物物品', 'a still life photograph of objects, products or artwork'),
    'document': ('文字文档', 'a photograph of a document, page of text or screenshot'),
}
_classifier = None
_model_lock = threading.Lock()


def visual_features(image):
    """Area-weighted HSV palette plus perceptual lightness; no filename heuristics."""
    sample = image.convert('RGB').copy()
    sample.thumbnail((128, 128))
    rgb = np.asarray(sample, dtype=np.float32) / 255
    hsv = np.asarray(sample.convert('HSV'), dtype=np.float32) / 255
    hue, saturation, value = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    # Avoid turning gray shadows and blown highlights into a spurious hue category.
    chromatic = (saturation > .18) & (value > .10)
    bins = np.zeros(8, dtype=np.float64)
    # Hue boundaries account for narrow yellow/cyan bands in photography.
    bucket = np.digitize((hue * 360 + 15) % 360, [30, 60, 90, 165, 200, 265, 300])
    for index in range(8):
        bins[index] = np.sum(chromatic & (bucket == index))
    linear = np.where(rgb <= .04045, rgb / 12.92, ((rgb + .055) / 1.055) ** 2.4)
    luminance = linear @ np.array([.2126, .7152, .0722], dtype=np.float32)
    lightness = np.where(luminance > .008856, 116 * np.cbrt(luminance) - 16, 903.3 * luminance)
    brightness = float(np.mean(lightness))
    colored = float(np.mean(chromatic))
    if colored < .18:
        color = 'black' if brightness < 25 else 'white' if brightness > 82 else 'gray'
    else:
        color = COLORS[int(np.argmax(bins))]
    warm = float(bins[[0, 1, 2, 7]].sum())
    cool = float(bins[[3, 4, 5, 6]].sum())
    tone = 'neutral' if colored < .18 or abs(warm - cool) / max(warm + cool, 1) < .2 else 'warm' if warm > cool else 'cool'
    palette_image = sample.quantize(colors=5, method=Image.Quantize.MEDIANCUT)
    palette = palette_image.getpalette()
    swatches = ['#' + ''.join(f'{v:02x}' for v in palette[i*3:i*3+3])
                for count, i in sorted(palette_image.getcolors(), reverse=True) if count / (sample.width * sample.height) > .02]
    return {'version': 2, 'color': color, 'tone': tone,
            'brightness': 'dark' if brightness < 35 else 'bright' if brightness >= 72 else 'balanced',
            'lightness': round(brightness, 1), 'saturation': round(float(np.mean(saturation)), 3),
            'contrast': round(float(np.std(lightness)) / 100, 3),
            'palette': swatches, 'content': None}


def recognition_status():
    import importlib.util
    ready = all((MODEL / p).is_file() for p in ['onnx/vision_model_quantized.onnx',
                'onnx/text_model_quantized.onnx', 'tokenizer.json'])
    runtime = bool(importlib.util.find_spec('onnxruntime') and importlib.util.find_spec('tokenizers'))
    return {'ready': ready and runtime, 'model': 'CLIP ViT-B/32 · ONNX INT8',
            'revision': MODEL_REVISION, 'labels': {k: v[0] for k, v in CONTENT.items()}}


class LocalClassifier:
    """ONNX CLIP with the tokenizer and normalization supplied by its model repo."""
    def __init__(self):
        if not recognition_status()['ready']:
            raise ValueError('本地识图模型未就绪，请按 README 安装识图引擎。')
        import onnxruntime as ort
        from tokenizers import Tokenizer
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        self.vision = ort.InferenceSession(str(MODEL / 'onnx/vision_model_quantized.onnx'),
                                          options, providers=['CPUExecutionProvider'])
        text = ort.InferenceSession(str(MODEL / 'onnx/text_model_quantized.onnx'),
                                    options, providers=['CPUExecutionProvider'])
        tokenizer = Tokenizer.from_file(str(MODEL / 'tokenizer.json'))
        tokenizer.enable_padding(pad_id=49407, pad_token='<|endoftext|>', length=77)
        tokenizer.enable_truncation(max_length=77)
        tokens = tokenizer.encode_batch([v[1] for v in CONTENT.values()])
        feeds = {'input_ids': np.array([t.ids for t in tokens], dtype=np.int64),
                 'attention_mask': np.array([t.attention_mask for t in tokens], dtype=np.int64)}
        self.text = text.run(None, {i.name: feeds[i.name] for i in text.get_inputs()})[0]
        self.text /= np.linalg.norm(self.text, axis=-1, keepdims=True)

    def classify(self, image):
        image = image.convert('RGB')
        factor = 224 / min(image.size)
        image = image.resize((round(image.width * factor), round(image.height * factor)), Image.Resampling.BICUBIC)
        left, top = (image.width - 224) // 2, (image.height - 224) // 2
        array = np.asarray(image.crop((left, top, left + 224, top + 224)), dtype=np.float32) / 255
        array = (array - np.array([.48145466, .4578275, .40821073], dtype=np.float32)) / np.array([.26862954, .26130258, .27577711], dtype=np.float32)
        embedding = self.vision.run(None, {'pixel_values': array.transpose(2, 0, 1)[None]})[0]
        embedding /= np.linalg.norm(embedding, axis=-1, keepdims=True)
        similarity = (embedding @ self.text.T)[0]
        logits = similarity * 100
        probability = np.exp(logits - logits.max())
        probability /= probability.sum()
        indices = np.argsort(probability)[::-1][:3]
        keys = list(CONTENT)
        best = int(indices[0])
        # Scores are relative to the offered candidate set, not calibrated certainty.
        uncertain = probability[best] < .35 or similarity[best] < .20
        return {'label': 'uncertain' if uncertain else keys[best],
                'score': round(float(probability[best]), 4),
                'candidates': [{'label': keys[int(i)], 'score': round(float(probability[i]), 4)} for i in indices],
                'model': 'CLIP ViT-B/32', 'revision': MODEL_REVISION}


def classify(image):
    global _classifier
    with _model_lock:
        if _classifier is None:
            _classifier = LocalClassifier()
        return _classifier.classify(image)


BLENDS = {'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten'}


def validate_composite(document, photos):
    import engine
    if not isinstance(document, dict):
        raise ValueError('合成项目格式无效')
    result = {k: document[k] for k in ['id', 'album_id'] if k in document}
    name = document.get('name', '未命名合成')
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 80:
        raise ValueError('合成名称需为 1–80 个字符')
    result['name'] = name.strip()
    width, height = document.get('width'), document.get('height')
    if type(width) is not int or type(height) is not int or not 16 <= width <= 6000 or not 16 <= height <= 6000 or width * height > 8_000_000:
        raise ValueError('画布需为 16–6000 像素，总像素不超过 800 万')
    result.update(width=width, height=height)
    layers = document.get('layers', [])
    if not isinstance(layers, list) or len(layers) > 24:
        raise ValueError('最多支持 24 个图层')
    available = {p['id'] for p in photos}
    result['layers'] = []
    for layer in layers:
        if not isinstance(layer, dict) or type(layer.get('photo_id')) is not int or layer['photo_id'] not in available:
            raise ValueError('图层照片不存在')
        if layer.get('blend', 'normal') not in BLENDS:
            raise ValueError('不支持的混合模式')
        clean = {'photo_id': layer['photo_id'], 'visible': bool(layer.get('visible', True)),
                 'blend': layer.get('blend', 'normal'), 'recipe': engine.validate_recipe(layer.get('recipe', {}))}
        for key, default, low, high in [('opacity', 1, 0, 1), ('scale', 1, .05, 5),
                                       ('x', 0, -12000, 12000), ('y', 0, -12000, 12000),
                                       ('rotation', 0, -180, 180)]:
            value = float(layer.get(key, default))
            if not math.isfinite(value) or not low <= value <= high:
                raise ValueError(f'图层参数 {key} 超出范围')
            clean[key] = value
        result['layers'].append(clean)
    return result


def render_composite_pixels(document, photos, max_size=None):
    """Float32 straight-alpha RGBA, bottom-to-top W3C separable blends.

    Affine filtering uses premultiplied float channels so transparent pixels
    cannot introduce a matte or leak their hidden colour. Quantization belongs
    to the screen/export boundary, never between composition layers.
    """
    import engine
    document = validate_composite(document, photos)
    original_width, original_height = document['width'], document['height']
    ratio = min(1, max_size / max(original_width, original_height)) if max_size else 1
    width, height = max(1, round(original_width * ratio)), max(1, round(original_height * ratio))
    canvas = np.zeros((height, width, 4), np.float32)
    lookup = {p['id']: p for p in photos}
    for layer in document['layers']:
        if not layer['visible'] or layer['opacity'] == 0:
            continue
        photo = lookup[layer['photo_id']]
        image = engine.render_pixels(photo['path'], layer['recipe'], (max(width, height) * 2,) * 2 if max_size else None,
                                     preserve_alpha=True)
        image_height, image_width = image.shape[:2]
        scale = min(width / image_width, height / image_height) * layer['scale']
        angle = math.radians(layer['rotation'])
        c, s = math.cos(angle) / scale, math.sin(angle) / scale
        cx, cy = width / 2 + layer['x'] * ratio, height / 2 + layer['y'] * ratio
        matrix = (c, s, image_width / 2 - c * cx - s * cy,
                  -s, c, image_height / 2 + s * cx - c * cy)
        source = np.empty((height, width, 4), np.float32)
        image_alpha = image[..., 3] if image.shape[-1] == 4 else None
        for channel in range(4):
            plane = (image_alpha if image_alpha is not None else np.ones(image.shape[:2], np.float32)) if channel == 3 else image[..., channel]
            if channel < 3 and image_alpha is not None:
                plane = plane * image_alpha
            transformed = Image.fromarray(np.ascontiguousarray(plane)).transform(
                (width, height), Image.Transform.AFFINE, matrix, Image.Resampling.BICUBIC, fillcolor=0)
            source[..., channel] = np.asarray(transformed)
        # Work in bounded strips; multiple blends do not allocate full RGB
        # intermediates or quantize already-composited backdrop pixels.
        for top in range(0, height, 64):
            backdrop, front = canvas[top:top+64], source[top:top+64]
            b, f = backdrop[..., :3], front[..., :3]
            ba, fa = backdrop[..., 3:4], front[..., 3:4]
            np.divide(f, fa, out=f, where=fa > 0)
            f[np.repeat(fa <= 0, 3, axis=-1)] = 0
            np.clip(f, 0, 1, out=f)
            # Bicubic alpha can overshoot. Normalize colour with the original
            # filtered alpha before clipping coverage, preserving its hue.
            np.clip(fa, 0, 1, out=fa)
            fa *= np.float32(layer['opacity'])
            mode = layer['blend']
            if mode == 'normal': blend = f
            elif mode == 'multiply': blend = b*f
            elif mode == 'screen': blend = b+f-b*f
            elif mode == 'overlay': blend = np.where(b <= .5, 2*b*f, 1-2*(1-b)*(1-f))
            elif mode == 'darken': blend = np.minimum(b, f)
            else: blend = np.maximum(b, f)
            alpha = fa+ba*(1-fa)
            if mode == 'normal':
                color = f*fa+b*ba*(1-fa)
            else:
                color = f*fa*(1-ba)+blend*fa*ba+b*ba*(1-fa)
            np.divide(color, alpha, out=color, where=alpha > 0)
            color[np.repeat(alpha <= 0, 3, axis=-1)] = 0
            backdrop[..., :3] = np.clip(color, 0, 1)
            backdrop[..., 3:4] = alpha
    return canvas


def render_composite(document, photos, max_size=None):
    """8-bit screen image from the same float renderer used by full export."""
    import pixels
    return pixels.to_image(render_composite_pixels(document, photos, max_size))
