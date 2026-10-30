# SPDX-License-Identifier: GPL-3.0-or-later
"""Licensed, pinned RawTherapee/Pat David Hald looks in encoded sRGB SDR.

Original photo samples never pass through a Hald image or an 8-bit conversion.
Only the published lookup assets are decoded during setup. Runtime uses the
same tiled float32 trilinear interpolator as Spektrafilm and all export paths.
"""
from functools import lru_cache
from io import BytesIO
import hashlib
import json
from pathlib import Path
import shutil
import urllib.request
import zipfile

import numpy as np

ROOT=Path(__file__).resolve().parent
ASSETS=ROOT/'engines/open-filters'
MANIFEST=ROOT/'open-filters-manifest.json'
ARCHIVE_URL='https://rawtherapee.com/shared/HaldCLUT.zip'
ARCHIVE_SHA256='0ffca81f30c72d7bbb85adab0ed98bbdeb0e1034cd6f5986f9f993bb66999dc2'
REVISION='RawTherapee Film Simulation Collection 2015-09-20'
SOURCE='https://patdavid.net/2015/03/film-emulation-in-rawtherapee/'
ATTRIBUTION='Hald looks by Pat David, Pavlov Dmitry and Michael Ezra; RawTherapee Film Simulation Collection 2015-09-20; CC BY-SA 4.0. Converted to 33³ float32 by Photo All.'


@lru_cache(maxsize=1)
def manifest():
    data=json.loads(MANIFEST.read_text(encoding='utf-8'))
    if data['archive_sha256']!=ARCHIVE_SHA256 or data['revision']!=REVISION:
        raise ValueError('开放滤镜来源清单无效')
    return data


def known(identity):
    return isinstance(identity,str) and identity in manifest()['items']


def asset_path(identity):
    if not known(identity):raise ValueError('未知开放滤镜')
    return ASSETS/(identity+'.npy')


def ready(identity):
    path=asset_path(identity)
    # Setup pins and verifies the digest; runtime checks it once per asset mtime.
    return path.is_file() and path.stat().st_size==33**3*3*4+128


def catalog():
    return {'items':{identity:{key:entry[key] for key in ('label','group','source','license')}|
                     {'ready':ready(identity)} for identity,entry in manifest()['items'].items()},
            'count':len(manifest()['items']), 'attribution':ATTRIBUTION,'source':SOURCE,
            'mode':'sRGB float32 3D LUT','revision':REVISION}


@lru_cache(maxsize=6)
def _load_table(identity,modified,size):
    path=asset_path(identity)
    entry=manifest()['items'][identity]
    if hashlib.sha256(path.read_bytes()).hexdigest()!=entry['sha256']:
        raise ValueError('开放滤镜校验失败，请重新运行 python film.py --setup-filters')
    table=np.load(path,allow_pickle=False)
    if table.dtype!=np.float32 or table.shape!=(33,33,33,3) or not np.isfinite(table).all():
        raise ValueError('开放滤镜 LUT 无效')
    table.flags.writeable=False
    return table


def load_table(identity):
    path=asset_path(identity)
    if not ready(identity):raise ValueError('开放滤镜未就绪，请运行 python film.py --setup-filters')
    stat=path.stat()
    return _load_table(identity,stat.st_mtime_ns,stat.st_size)


def hald_table(samples):
    """Row-major Hald: R fastest, G next, B slowest; preserve 8/16-bit values.

    A level-L image has side L³ and cube edge L². Storage returned here is
    [B,G,R,RGB], matching pixels.apply_lut. Input is encoded-sRGB, no ICC change.
    """
    samples=np.asarray(samples)
    if samples.ndim!=3 or samples.shape[0]!=samples.shape[1] or samples.shape[-1]!=3:
        raise ValueError('Hald LUT 必须是正方形 RGB 图')
    level=round(samples.shape[0]**(1/3))
    if level<2 or level**3!=samples.shape[0] or samples.dtype not in (np.uint8,np.uint16):
        raise ValueError('Hald LUT 级别或位深无效')
    edge=level**2
    return samples.reshape(edge,edge,edge,3).astype(np.float32)/np.float32(np.iinfo(samples.dtype).max)


def decode_hald(data):
    import pixels  # Supplies the pinned PyPNG package location.
    import png
    width,height,rows,info=png.Reader(bytes=data).asDirect()
    if info['planes'] not in (1,3) or info['bitdepth'] not in (8,16):
        raise ValueError('Hald PNG 必须是 8/16-bit RGB')
    values=np.asarray(list(rows),dtype=np.uint16 if info['bitdepth']==16 else np.uint8)
    values=values.reshape(height,width,info['planes'])
    if info['planes']==1:values=np.repeat(values,3,axis=-1)
    return hald_table(values),info['bitdepth']


def convert_hald(data):
    import pixels
    native,bits=decode_hald(data)
    axis=np.linspace(0,1,33,dtype=np.float32)
    b,g,r=np.meshgrid(axis,axis,axis,indexing='ij')
    grid=np.stack([r,g,b],axis=-1)
    converted=pixels.apply_lut(grid.reshape(33,33*33,3),native).reshape(33,33,33,3)
    return np.ascontiguousarray(converted),native.shape[0],bits


def setup(archive=None):
    """Rebuild exactly the checked-in catalogue; refuse changed upstream bytes."""
    downloads=ROOT.parent/'validation/downloads/open-filters'
    downloads.mkdir(parents=True,exist_ok=True)
    archive=Path(archive) if archive else downloads/'RawTherapee-HaldCLUT.zip'
    if not archive.is_file():
        temporary=archive.with_suffix('.download')
        try:
            urllib.request.urlretrieve(ARCHIVE_URL,temporary)
            if hashlib.sha256(temporary.read_bytes()).hexdigest()!=ARCHIVE_SHA256:
                raise ValueError('上游滤镜来源包已变化，拒绝安装未经审核的内容')
            temporary.replace(archive)
        finally:temporary.unlink(missing_ok=True)
    if hashlib.sha256(archive.read_bytes()).hexdigest()!=ARCHIVE_SHA256:
        raise ValueError('开放滤镜来源包 SHA256 不匹配')
    ASSETS.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(archive) as bundle:
        readme=bundle.read('HaldCLUT/README.txt')
        (ASSETS/'UPSTREAM-README.txt').write_bytes(readme)
        for identity,entry in manifest()['items'].items():
            target=asset_path(identity)
            if target.is_file() and hashlib.sha256(target.read_bytes()).hexdigest()==entry['sha256']:
                continue
            data=bundle.read(entry['member'])
            if hashlib.sha256(data).hexdigest()!=entry['source_sha256']:
                raise ValueError('来源 Hald LUT SHA256 不匹配：'+identity)
            table,edge,bits=convert_hald(data)
            stream=BytesIO();np.save(stream,table,allow_pickle=False)
            if hashlib.sha256(stream.getvalue()).hexdigest()!=entry['sha256']:
                raise ValueError('转换 LUT SHA256 不匹配：'+identity)
            temporary=target.with_suffix('.tmp')
            temporary.write_bytes(stream.getvalue());temporary.replace(target)
            print('READY '+identity,flush=True)
    shutil.copyfile(MANIFEST,ASSETS/'manifest.json')
    for name in ['LICENSE-CC-BY-SA-4.0.txt']:
        source=ROOT/'filter-licenses'/name
        shutil.copyfile(source,ASSETS/name)
    (ASSETS/'CHANGES.txt').write_text(ATTRIBUTION+'\n'+manifest()['conversion']+'\n',encoding='utf-8')
    return catalog()


if __name__=='__main__':
    import sys
    if '--setup' in sys.argv:setup()
    else:print(json.dumps(catalog(),ensure_ascii=False,indent=2))
